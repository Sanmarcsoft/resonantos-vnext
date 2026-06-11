/**
 * zorin-mcp — MCP (streamable-HTTP) front for the Zorin autonomous agent.
 *
 * Implements the follow-up reserved in flake.nix: binds VM port 3103 so the
 * claude-peers bridge (AGENTS["zorin"] → 10.0.0.112:3113 → zorin-port-relay →
 * host 127.0.0.1:3103 hostfwd → here) can register Zorin like the other
 * fleet personas. Speaks just enough MCP for bridge.ts's client:
 *
 *   POST /mcp  initialize                  → serverInfo + Mcp-Session-Id header
 *   POST /mcp  notifications/initialized   → 202
 *   POST /mcp  tools/list                  → [respond]
 *   POST /mcp  tools/call respond          → forwards to widget-bridge chat
 *   GET  /health                           → fleet-shaped health JSON
 *
 * The actual Zorin brain is the co-resident widget-bridge (Hermes, Zorin
 * profile) on 127.0.0.1:19100; `respond` proxies a chat turn into it using
 * BRIDGE_TOKEN from the shared /etc/haus-vm/bridge.env. Zero npm deps; Bun
 * built-ins only, matching widget-bridge's packaging contract.
 *
 * Auth: if ZORIN_MCP_TOKEN is set, /mcp requires `Authorization: Bearer`
 * (bridge sends ZORIN_ADAPTER_AUTH_TOKEN). Unset = open, matching the
 * fleet posture of the 3101-3107 agents.
 */

const PORT = Number(process.env.MCP_PORT ?? "3103");
const HOST = process.env.HOST ?? "0.0.0.0";
const WIDGET_URL = process.env.WIDGET_URL ?? "http://127.0.0.1:19100";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? "";
const MCP_TOKEN = process.env.ZORIN_MCP_TOKEN ?? "";
const WIDGET_TIMEOUT_MS = Number(process.env.WIDGET_TIMEOUT_MS ?? "80000");

const SERVER_INFO = { name: "zorin", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-03-26";

const RESPOND_TOOL = {
  name: "respond",
  description:
    "Send a message to Zorin (ResonantOS autonomous agent) and get his reply.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The message for Zorin" },
      from: { type: "string", description: "Voice id of the sender" },
    },
    required: ["message"],
  },
};

// Live sessions. Sessions are cheap (an id + created stamp); cap and expire
// so a reconnect-looping client cannot grow the map unbounded.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX = 64;
const sessions = new Map<string, number>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, created] of sessions) {
    if (now - created > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > SESSION_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rpcResult(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: "2.0", id, result }, 200, headers);
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function authOk(req: Request): boolean {
  if (MCP_TOKEN.length === 0) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${MCP_TOKEN}`;
}

/** One chat turn into the co-resident widget-bridge (the Zorin brain). */
async function askZorin(message: string, from: string): Promise<string> {
  const res = await fetch(`${WIDGET_URL}/api/widget/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BRIDGE_TOKEN ? { Authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      botId: "zorin",
      message,
      // Stable per-sender thread so cross-peer conversations keep context.
      sessionId: `peer-${from || "bridge"}`,
    }),
    signal: AbortSignal.timeout(WIDGET_TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof data.reply !== "string") {
    throw new Error(
      `widget-bridge ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data.reply;
}

async function handleMcp(req: Request): Promise<Response> {
  if (!authOk(req)) return json({ error: "unauthorized" }, 401);

  let rpc: Record<string, unknown>;
  try {
    rpc = (await req.json()) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const { id, method, params } = rpc as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };

  if (method === "initialize") {
    pruneSessions();
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, Date.now());
    return rpcResult(
      id,
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
      { "Mcp-Session-Id": sessionId },
    );
  }

  // Notifications carry no id and expect no body.
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  // Everything below requires a live session; a stale/missing one makes the
  // bridge re-initialize ("expected initialize" matches its retry trigger).
  const sessionId = req.headers.get("mcp-session-id") ?? "";
  if (!sessions.has(sessionId)) {
    return rpcError(id ?? null, -32000, "bad session — expected initialize");
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: [RESPOND_TOOL] });
  }

  if (method === "tools/call") {
    const name = (params?.name as string) ?? "";
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    if (name !== "respond") {
      return rpcError(id ?? null, -32602, `unknown tool: ${name}`);
    }
    const message = typeof args.message === "string" ? args.message : "";
    const from = typeof args.from === "string" ? args.from : "";
    if (!message) {
      return rpcError(id ?? null, -32602, "respond requires a message");
    }
    try {
      const reply = await askZorin(message, from);
      return rpcResult(id, { content: [{ type: "text", text: reply }] });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // Tool-level failure, MCP-shaped: isError lets the caller surface it
      // without treating the session as broken.
      return rpcResult(id, {
        content: [{ type: "text", text: `Zorin unavailable: ${detail}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  return rpcError(id ?? null, -32601, `method not found: ${method}`);
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      // Fleet-shaped health (mirrors the 31xx agents) so bridge logs read
      // uniformly and operators can identify the service at a glance.
      return json({
        status: "ok",
        name: "zorin",
        version: SERVER_INFO.version,
        transport: "streamable-http",
        tools: 1,
        sessions: sessions.size,
      });
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(req);
    }
    return json({ error: "not-found" }, 404);
  },
});

console.log(`zorin-mcp listening on ${HOST}:${PORT} → ${WIDGET_URL}`);
