/**
 * widget-bridge HTTP server.
 *
 * Exposes the legacy `POST /api/widget/chat` contract on `haus.matthewstevens.org`
 * and routes each turn to a Hermes Agent profile. This file is the only
 * HTTP-facing surface of the bridge; everything else flows through the
 * `HermesClient` abstraction.
 *
 * Env vars:
 *   PORT          (default 8080):   bind port
 *   HOST          (default 0.0.0.0): bind host
 *   BRIDGE_TOKEN  (optional):        if set, requests must carry
 *                                    `Authorization: Bearer <token>`
 *   HERMES_MODE   (default "stub"):  "stub" | "cli" (cli not implemented yet)
 */

import type {
  HealthResponse,
  WidgetChatError,
  WidgetChatRequest,
  WidgetChatResponse,
} from "./types";
import { StubHermesClient, resolveProfile, type HermesClient } from "./hermes-client";

const VERSION = "0.1.0";
const STARTED_AT = Date.now();

const PORT = Number(process.env["PORT"] ?? 8080);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const BRIDGE_TOKEN = process.env["BRIDGE_TOKEN"] ?? "";
const HERMES_MODE = process.env["HERMES_MODE"] ?? "stub";

function selectClient(): HermesClient {
  switch (HERMES_MODE) {
    case "stub":
      return new StubHermesClient();
    case "cli":
      throw new Error("HERMES_MODE=cli not implemented in 0.1.0 scaffold");
    default:
      throw new Error(`Unknown HERMES_MODE: ${HERMES_MODE}`);
  }
}

const client = selectClient();

function json<T>(body: T, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function authOk(req: Request): boolean {
  if (!BRIDGE_TOKEN) return true; // open mode for local dev
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${BRIDGE_TOKEN}`;
}

async function handleChat(req: Request): Promise<Response> {
  if (!authOk(req)) {
    return json<WidgetChatError>({ error: "unauthorized" }, 401);
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

  // Translate wire id (legacy bridge.ts sends "zorin001") to the canonical
  // profile id before dispatching. Echo the caller's id back in the response
  // so the wire contract stays byte-identical to the legacy widget.
  const wireBotId = parsed.value.botId;
  const resolvedBotId = resolveProfile(wireBotId);

  const t0 = performance.now();
  const result = await client.chat({ ...parsed.value, botId: resolvedBotId });
  const latencyMs = Math.round(performance.now() - t0);

  if (!result.ok) {
    const status = result.code === "profile-not-found" ? 404 : 502;
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
}

async function handleHealth(): Promise<Response> {
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

function parseChatRequest(
  raw: unknown,
): { ok: true; value: WidgetChatRequest } | { ok: false; detail: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, detail: "body must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const botId = r["botId"];
  const message = r["message"];
  if (typeof botId !== "string" || botId.length === 0) {
    return { ok: false, detail: "botId must be a non-empty string" };
  }
  if (typeof message !== "string" || message.length === 0) {
    return { ok: false, detail: "message must be a non-empty string" };
  }
  const conversationId = typeof r["conversationId"] === "string" ? r["conversationId"] : undefined;
  const caller = typeof r["caller"] === "string" ? r["caller"] : undefined;
  const out: WidgetChatRequest = { botId, message };
  if (conversationId !== undefined) out.conversationId = conversationId;
  if (caller !== undefined) out.caller = caller;
  return { ok: true, value: out };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return handleHealth();
    }
    if (req.method === "POST" && url.pathname === "/api/widget/chat") {
      return handleChat(req);
    }
    return json<WidgetChatError>({ error: "not-found" }, 404);
  },
});

console.log(`haus-widget-bridge ${VERSION} listening on ${server.hostname}:${server.port}`);
console.log(`  HERMES_MODE=${HERMES_MODE}  auth=${BRIDGE_TOKEN ? "bearer" : "open"}`);

export { server };
