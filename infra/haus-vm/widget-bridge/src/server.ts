/**
 * widget-bridge HTTP server.
 *
 * Exposes the legacy `POST /api/widget/chat` contract on `haus.matthewstevens.org`
 * and routes each turn to a Hermes Agent profile. This file is the only
 * HTTP-facing surface of the bridge; everything else flows through the
 * `HermesClient` abstraction.
 *
 * Env vars:
 *   PORT           (default 8080):            bind port
 *   HOST           (default 127.0.0.1):       bind host. Default is loopback
 *                                              because the production deployment
 *                                              sits behind a reverse proxy. Set
 *                                              to 0.0.0.0 only when there is no
 *                                              proxy.
 *   BRIDGE_TOKEN   (required in prod):        bearer token. Required when
 *                                              NODE_ENV=production. When set,
 *                                              both /api/widget/chat and the
 *                                              detailed /health view require
 *                                              `Authorization: Bearer <token>`.
 *   NODE_ENV       (default development):     gates the BRIDGE_TOKEN guard.
 *   ALLOWED_HOSTS  (default haus.matthewstevens.org,localhost,127.0.0.1):
 *                                              comma-separated list of Host
 *                                              header values accepted on /api.
 *   HERMES_MODE    (default "stub"):          "stub" | "cli" (cli not implemented yet).
 */

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  HealthResponse,
  WidgetChatError,
  WidgetChatRequest,
  WidgetChatResponse,
} from "./types";
import { StubHermesClient, resolveProfile, type HermesClient } from "./hermes-client";
import { LiveHermesClient } from "./live-hermes-client";

const VERSION = "0.1.0";
const STARTED_AT = Date.now();

const PORT = Number(process.env["PORT"] ?? 8080);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const BRIDGE_TOKEN = process.env["BRIDGE_TOKEN"] ?? "";
const HERMES_MODE = process.env["HERMES_MODE"] ?? "stub";
const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const ALLOWED_HOSTS = (process.env["ALLOWED_HOSTS"] ?? "haus.matthewstevens.org,localhost,127.0.0.1")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_LEN = 8000;
const CHAT_TIMEOUT_MS = 8000;

const BOT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * Refuse to boot in production if BRIDGE_TOKEN is empty. Open-mode is allowed
 * only in development and test, where authenticated client setup would be
 * annoying churn.
 */
export function assertBootSafety(env: { NODE_ENV: string; BRIDGE_TOKEN: string }): void {
  if (env.NODE_ENV === "production" && env.BRIDGE_TOKEN.length === 0) {
    throw new Error(
      "BRIDGE_TOKEN must be set when NODE_ENV=production. Refusing to bind in open mode.",
    );
  }
}

assertBootSafety({ NODE_ENV, BRIDGE_TOKEN });

function selectClient(): HermesClient {
  switch (HERMES_MODE) {
    case "stub":
      return new StubHermesClient();
    case "cli":
      // Stage 1 of Hermes Agency: an OpenAI-compatible /chat/completions
      // client with a Zorin persona system prompt. Stage 2 (full
      // hermes-agent gateway integration) plugs in here without changing
      // the server contract.
      return new LiveHermesClient();
    default:
      throw new Error(`Unknown HERMES_MODE: ${HERMES_MODE}`);
  }
}

const client = selectClient();

function json<T>(body: T, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * Constant-time bearer-token compare. When `expected` is empty, the server is
 * in open mode (only legal outside production, gated by `assertBootSafety`).
 */
export function bearerTokenOk(authHeader: string, expected: string): boolean {
  if (expected.length === 0) return true;
  if (!authHeader.startsWith("Bearer ")) return false;
  const presented = authHeader.slice("Bearer ".length);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authOk(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  return bearerTokenOk(header, BRIDGE_TOKEN);
}

/**
 * Stricter auth: ALWAYS requires a real bearer match, even in open mode.
 * Used for the detailed /health view so dev/test mode never leaks profile
 * inventory to unauthenticated callers.
 */
function operatorAuthOk(req: Request): boolean {
  if (BRIDGE_TOKEN.length === 0) return false;
  return authOk(req);
}

function hostOk(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const bareHost = (host.split(":")[0] ?? host).toLowerCase();
  return ALLOWED_HOSTS.some((h) => h.toLowerCase() === bareHost);
}

/**
 * Parse incoming chat body. Accepts two wire shapes so the legacy
 * `claude-peers-mcp/bridge.ts` caller (which sends `messages: [{role,content}]`)
 * and a simpler `{message: string}` payload both work.
 */
export function parseChatRequest(
  raw: unknown,
): { ok: true; value: WidgetChatRequest } | { ok: false; detail: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, detail: "body must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  const botId = r["botId"];
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) {
    return { ok: false, detail: "botId must match [a-z][a-z0-9_-]{0,31}" };
  }

  let message: string | undefined;
  if (typeof r["message"] === "string") {
    message = r["message"];
  } else if (Array.isArray(r["messages"])) {
    const msgs = r["messages"] as unknown[];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && typeof m === "object") {
        const mObj = m as Record<string, unknown>;
        if (mObj["role"] === "user" && typeof mObj["content"] === "string") {
          message = mObj["content"];
          break;
        }
      }
    }
  }
  if (typeof message !== "string" || message.length === 0) {
    return { ok: false, detail: "message (or messages[].content) must be a non-empty string" };
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return { ok: false, detail: `message exceeds ${MAX_MESSAGE_LEN}-char cap` };
  }
  if (CONTROL_CHAR_RE.test(message)) {
    return { ok: false, detail: "message contains disallowed control characters" };
  }

  const conversationId = r["conversationId"];
  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" || !ID_RE.test(conversationId))
  ) {
    return { ok: false, detail: "conversationId must match [A-Za-z0-9._-]{1,64}" };
  }

  const caller = r["caller"];
  if (caller !== undefined && (typeof caller !== "string" || !ID_RE.test(caller))) {
    return { ok: false, detail: "caller must match [A-Za-z0-9._-]{1,64}" };
  }

  const out: WidgetChatRequest = { botId, message };
  if (typeof conversationId === "string") out.conversationId = conversationId;
  if (typeof caller === "string") out.caller = caller;
  return { ok: true, value: out };
}

async function handleChat(req: Request): Promise<Response> {
  if (!hostOk(req)) {
    return json<WidgetChatError>({ error: "forbidden-host" }, 403);
  }
  if (!authOk(req)) {
    return json<WidgetChatError>({ error: "unauthorized" }, 401);
  }

  const contentLengthRaw = req.headers.get("content-length");
  if (contentLengthRaw !== null) {
    const contentLength = Number(contentLengthRaw);
    if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
      return json<WidgetChatError>(
        { error: "payload-too-large", detail: `max ${MAX_BODY_BYTES} bytes` },
        413,
      );
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json<WidgetChatError>({ error: "invalid-json" }, 400);
  }

  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    return json<WidgetChatError>({ error: "bad-request", detail: parsed.detail }, 400);
  }

  const wireBotId = parsed.value.botId;
  const resolvedBotId = resolveProfile(wireBotId);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const result = await client.chat({ ...parsed.value, botId: resolvedBotId });
    const latencyMs = Math.round(performance.now() - t0);
    if (!result.ok) {
      const status = result.code === "profile-not-found" ? 404 : result.code === "timeout" ? 504 : 502;
      return json<WidgetChatError>({ error: result.code, detail: result.detail }, status);
    }
    const response: WidgetChatResponse = {
      botId: wireBotId,
      reply: result.reply,
      conversationId: result.conversationId,
      engine: HERMES_MODE === "stub" ? "stub" : "hermes",
      latencyMs,
      ...(result.model !== undefined ? { model: result.model } : {}),
    };
    return json(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * /health is dual-mode:
 *   unauthenticated: returns `{status:"ok"}` only (no version, no profile list)
 *   authenticated:   returns the full HealthResponse for operators
 *
 * /livez is the unconditional load-balancer probe path (always 200 ok).
 */
async function handleHealth(req: Request): Promise<Response> {
  if (!operatorAuthOk(req)) {
    return json({ status: "ok" });
  }
  const profiles = await client.listProfiles();
  const body: HealthResponse = {
    status: profiles.ready.length > 0 ? "ok" : "degraded",
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    profilesReady: profiles.ready,
    profilesMissing: profiles.missing,
  };
  return json(body);
}

function handleLivez(): Response {
  return json({ status: "ok" });
}

/**
 * Start a server instance. Exported so tests can boot a fresh instance on a
 * random port without the module-load side-effect of binding to PORT.
 */
export function startServer(opts: { port?: number; hostname?: string } = {}) {
  return Bun.serve({
    port: opts.port ?? PORT,
    hostname: opts.hostname ?? HOST,
    idleTimeout: 10,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/livez") return handleLivez();
      if (req.method === "GET" && url.pathname === "/health") return handleHealth(req);
      if (req.method === "POST" && url.pathname === "/api/widget/chat") return handleChat(req);
      return json<WidgetChatError>({ error: "not-found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = startServer();
  console.log(`haus-widget-bridge ${VERSION} listening on ${server.hostname}:${server.port}`);
  console.log(
    `  HERMES_MODE=${HERMES_MODE}  NODE_ENV=${NODE_ENV}  auth=${BRIDGE_TOKEN ? "bearer" : "open"}`,
  );
}
