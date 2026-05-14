/**
 * Wire contract for haus.matthewstevens.org widget chat.
 *
 * This shim is a drop-in replacement for the legacy ResonantOS Gemma chatbot
 * widget endpoint, as called today by `claude-peers-mcp/bridge.ts`. The
 * inbound request shape MUST stay backward-compatible across the cutover.
 *
 * Two inbound shapes are accepted by `parseChatRequest`:
 *
 *   A) Simple:
 *      { "botId": "zorin", "message": "<text>" }
 *
 *   B) Legacy (used today by claude-peers-mcp/bridge.ts):
 *      { "botId": "zorin001", "messages": [ { "role": "user", "content": "<text>" } ] }
 *
 * Internally both are normalised to the simple shape (`WidgetChatRequest`).
 */

/** Inbound widget chat request after normalisation. */
export interface WidgetChatRequest {
  /**
   * Profile id. The canonical Hermes profile is `zorin`. The legacy ResonantOS
   * Gemma widget called itself `zorin001`; the bridge accepts that as a wire
   * alias and translates it to `zorin` internally so existing callers keep
   * working without change. Must match `^[a-z][a-z0-9_-]{0,31}$`.
   */
  botId: string;
  /** End-user prompt. Plain text. Max 8000 chars. No control characters. */
  message: string;
  /** Optional conversation id for cross-turn continuity. `^[A-Za-z0-9._-]{1,64}$`. */
  conversationId?: string;
  /** Optional caller identifier for per-caller audit. `^[A-Za-z0-9._-]{1,64}$`. */
  caller?: string;
}

/** Outbound widget chat response. */
export interface WidgetChatResponse {
  /** Profile id that handled the turn. Echoes the request as sent on the wire. */
  botId: string;
  /** Assistant reply text. */
  reply: string;
  /** Conversation id assigned or echoed. */
  conversationId: string;
  /** Backing engine label for diagnostics. */
  engine: "hermes" | "stub";
  /** Backing model id, if known. */
  model?: string;
  /** Server-side wall-clock latency in ms. */
  latencyMs: number;
}

/** Error envelope. */
export interface WidgetChatError {
  error: string;
  detail?: string;
}

/** Health probe payload (authenticated view). */
export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  version: string;
  uptimeSec: number;
  profilesReady: string[];
  profilesMissing: string[];
}
