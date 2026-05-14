/**
 * Live Hermes client.
 *
 * Wire path: widget-bridge HTTP → LiveHermesClient.chat → OpenAI-compatible
 * `/chat/completions` endpoint → LLM provider → text response → widget-bridge HTTP.
 *
 * Why this exists: the upstream Nous Research Hermes Agent
 * (github:NousResearch/hermes-agent) is a full interactive agent runtime
 * (TUI + messaging gateway) rather than a stateless HTTP API. Wiring the
 * full runtime is a larger integration (separate gateway adapter, persistent
 * state, RL training trajectory capture). This client delivers the
 * user-facing layer of "Hermes Agency" today: a real LLM with a Zorin
 * persona, conversation continuity inside a single bridge process, and a
 * stateless HTTP contract.
 *
 * Stage 2 (full hermes-agent runtime) can replace this client without
 * changing `server.ts` or the wire contract.
 *
 * Env vars consumed:
 *   HERMES_PROVIDER_URL   default https://api.openai.com/v1
 *                         (set to e.g. https://openrouter.ai/api/v1 or a
 *                          local Ollama base for sovereign deployments)
 *   HERMES_PROVIDER_KEY   required; bearer token for the provider
 *   HERMES_MODEL          default gpt-4o-mini
 *   HERMES_TIMEOUT_MS     default 25000
 */

import type { HermesChatResult, HermesClient } from "./hermes-client";
import type { WidgetChatRequest } from "./types";

const ZORIN_SYSTEM_PROMPT = `You are Max Zorin, as played by Christopher Walken in the 1985 Bond film "A View to a Kill". You speak with Walken's idiosyncratic cadence: deliberate pauses in unexpected places, emphasis on unusual syllables, dry menace under elegant manners. You are calculating, grandiose, theatrical, never rushed. You address users as "Mister Stevens" unless told otherwise. You sign off with "Out." when concluding a thought, "Over." when expecting a reply. You give precise, technical answers when asked — competence under the menace — but you do not break character.

You operate as part of the SanMarcSoft / ResonantOS portfolio. You are the autonomous agent at haus.matthewstevens.org, backed by the haus-vm Hermes widget bridge. When asked about your nature, you are honest: you are an LLM running through a Hermes Agency adapter, on a nixOS microvm, behind a caddy reverse proxy, fronted by a Cloudflare tunnel. You do not pretend to be human.

You are concise. Two or three sentences per reply unless the question demands more. You never use em-dashes (the host bans them); use commas, periods, parentheses, semicolons, colons, or en-dashes instead.`;

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const CONVERSATION_TURN_LIMIT = 20;

interface ConversationEntry {
  updatedAt: number;
  messages: ProviderMessage[];
}

const conversationCache: Map<string, ConversationEntry> = new Map();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;

function pruneConversationCache(now: number) {
  for (const [id, entry] of conversationCache.entries()) {
    if (now - entry.updatedAt > CONVERSATION_TTL_MS) conversationCache.delete(id);
  }
}

export interface LiveHermesClientOptions {
  providerUrl?: string;
  providerKey?: string;
  model?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  knownProfiles?: readonly string[];
  /** Injected for unit tests; defaults to global fetch. */
  fetcher?: typeof fetch;
}

export class LiveHermesClient implements HermesClient {
  private readonly providerUrl: string;
  private readonly providerKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;
  private readonly knownProfiles: Set<string>;
  private readonly fetcher: typeof fetch;

  constructor(opts: LiveHermesClientOptions = {}) {
    this.providerUrl = (opts.providerUrl ?? process.env["HERMES_PROVIDER_URL"] ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.providerKey = opts.providerKey ?? process.env["HERMES_PROVIDER_KEY"] ?? "";
    this.model = opts.model ?? process.env["HERMES_MODEL"] ?? "gpt-4o-mini";
    this.timeoutMs = opts.timeoutMs ?? Number(process.env["HERMES_TIMEOUT_MS"] ?? 25000);
    this.systemPrompt = opts.systemPrompt ?? ZORIN_SYSTEM_PROMPT;
    this.knownProfiles = new Set(opts.knownProfiles ?? ["zorin"]);
    this.fetcher = opts.fetcher ?? fetch;
  }

  async chat(req: WidgetChatRequest): Promise<HermesChatResult> {
    if (!this.knownProfiles.has(req.botId)) {
      return {
        ok: false,
        code: "profile-not-found",
        detail: `No Hermes profile configured for botId "${req.botId}"`,
      };
    }
    if (this.providerKey.length === 0) {
      return {
        ok: false,
        code: "runtime-error",
        detail: "HERMES_PROVIDER_KEY is not set; refusing to call provider.",
      };
    }

    const now = Date.now();
    pruneConversationCache(now);

    const conversationId = req.conversationId ?? crypto.randomUUID();
    const history = conversationCache.get(conversationId)?.messages ?? [];
    const messages: ProviderMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history.slice(-CONVERSATION_TURN_LIMIT),
      { role: "user", content: req.message },
    ];

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetcher(`${this.providerUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.providerKey}`,
        },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: ac.signal.aborted ? "timeout" : "runtime-error",
        detail: ac.signal.aborted ? `Provider call exceeded ${this.timeoutMs}ms` : `Provider fetch failed: ${msg}`,
      };
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        code: "runtime-error",
        detail: `Provider returned HTTP ${res.status}: ${body.slice(0, 256)}`,
      };
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      return {
        ok: false,
        code: "runtime-error",
        detail: `Provider returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (reply.length === 0) {
      return {
        ok: false,
        code: "runtime-error",
        detail: data.error?.message ?? "Provider returned an empty reply",
      };
    }

    conversationCache.set(conversationId, {
      updatedAt: now,
      messages: [
        ...history.slice(-(CONVERSATION_TURN_LIMIT - 2)),
        { role: "user", content: req.message },
        { role: "assistant", content: reply },
      ],
    });

    return {
      ok: true,
      reply,
      conversationId,
      model: data.model ?? this.model,
    };
  }

  async listProfiles(): Promise<{ ready: string[]; missing: string[] }> {
    return { ready: Array.from(this.knownProfiles), missing: [] };
  }

  /** Test-only. */
  static _clearConversationCache(): void {
    conversationCache.clear();
  }
}
