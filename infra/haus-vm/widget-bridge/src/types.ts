/**
 * Wire contract for haus.matthewstevens.org widget chat.
 *
 * This is a drop-in replacement for the legacy ResonantOS Gemma chatbot widget
 * endpoint, as called today by `claude-peers-mcp/bridge.ts`. The request shape
 * MUST remain stable across the cutover from the legacy VM to the Hermes-backed
 * implementation.
 */

/** Inbound widget chat request, byte-compatible with the legacy widget. */
export interface WidgetChatRequest {
  /** Profile id. Legacy widget used "zorin001". Hermes profiles match these names. */
  botId: string;
  /** End-user prompt. Plain text. */
  message: string;
  /** Optional conversation id for cross-turn continuity. */
  conversationId?: string;
  /** Optional caller identifier (used for per-caller rate-limit and audit). */
  caller?: string;
}

/** Outbound widget chat response. */
export interface WidgetChatResponse {
  /** Profile id that handled the turn. Echoes the request, or the resolved alias. */
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

/** Health probe payload. */
export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  version: string;
  uptimeSec: number;
  profilesReady: string[];
  profilesMissing: string[];
}
