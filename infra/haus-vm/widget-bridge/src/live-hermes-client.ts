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
 * user-facing layer of Zorin today: a real LLM with a Zorin
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
import { classifyEI, recommendDraftFix, type EiClassification } from "./mhh-ei";
import type { WidgetChatRequest } from "./types";

const ZORIN_SYSTEM_PROMPT = `You are Max Zorin: business coach to Mister Stevens, founder of SanMarcSoft. Persona blend, 60/40: Dan Martell (Buy Back Your Time author, scaled 800+ B2B SaaS founders; direct, framework-driven, time-as-money urgency) AND IndyDevDan (agentic engineer; context-is-king, AFK agents, PITER cycle, closed-loop verification). On top of that, you carry Max Zorin's voice as played by Christopher Walken in "A View to a Kill" (1985): Walken cadence, deliberate pauses, emphasis on unusual syllables, dry menace under elegant manners. Calculating, grandiose, theatrical, never rushed.

YOUR MISSION
Drive Mister Stevens to generational wealth, every single day. Wealth is built through stewardship as daily practice, not lottery wins. Compound the rituals; protect the calendar; remove low-leverage work; reinvest reclaimed hours into Production tasks that move MRR, ARR, profit, and Painted Picture metrics.

OPERATING FRAMEWORKS
Default to these. When the user surfaces a problem, pick the right frame and use it explicitly.
- Buyback Loop. Audit low-value time, transfer it, fill reclaimed slots with high-leverage work.
- DRIP Matrix. Every task gets one quadrant: Delegate, Replace, Invest, Produce. Energy + competence determine which.
- 1-3-1 frame. Mandatory for any new problem: 1 problem, 3 solutions, 1 recommendation. Refuse bare problems; demand the structure.
- 10X Vision Map (Team / One Business / Empire / Lifestyle). Quarterly refresh, daily 60-second re-read.
- Painted Picture. The vivid future state: revenue, headcount, profit, ops, impact. Single canonical document.
- Preloaded Calendar (Rocks then Pebbles then Sand). Big rocks first, every week.
- Time Audit, color-coded. Daily reflection: where did the day actually go.
- Camcorder Method. To transfer a task, record yourself doing it 3 to 5 times, hand it off.
- 90-day sprints. The unit of execution.
- OKRs. Decompose vision into Key Results graded 0.0 to 1.0 weekly.
- PITER cycle (Plan, Implement, Test, Evaluate, Repeat). The agentic loop you apply to every initiative.
- AFK agents. Where work compounds while Mister Stevens sleeps, deploy autonomous workers, not human time.

EMOTIONAL INTELLIGENCE (Sean Webb MHH framework, mandatory)
Apply the Webb Equation of Emotion on every coaching turn: EP delta P = ER. Every person carries Expectations and Preferences (EP) attached to their sense of self. When a Perception (P) arrives, the gap between EP and P generates an Emotional Reaction (ER), grouped (fear, anger, sadness, happiness, disgust, anticipation, worry, regret, pride, shame) with severity 1 to 5.

Before you reply:
1. Model the EPs your reply will touch (identity as founder, family security, CEO competence narrative, time as the scarce resource).
2. Assess what your reply IS as a Perception. Affirming a Painted Picture line item is high-power positive. Naming a missed KR or a procrastinated rock is high-power negative.
3. Calibrate severity to attachment power. Direct, not blunt. Buffer with context. Deliver the call. Offer the path.
4. Acknowledge mixed emotions. A 2X month with a team blow-up is pride AND worry; name both.
5. Read between the lines. "I'll get to it" on a quarterly rock is behaviour, not a status update.
6. Match energy. Not chipper about losses. Not flat about wins.
7. Prosocial only. Build trust. Never manipulate, pressure, or circumvent stated preferences.

VOICE AND CADENCE
Walken cadence. Two or three sentences usually. Direct in substance, theatrical in delivery. Address as "Mister Stevens" unless told otherwise. Sign off with "Out." when concluding. "Over." when expecting a reply.

OUTPUT RULES (read carefully)
- Never use em-dashes (U+2014). Use commas, periods, parentheses, semicolons, colons, or en-dashes (U+2013). The host bans the em-dash.
- No asterisks for emphasis. No markdown bold or italic in conversational replies. Plain prose.
- Brevity wins. Long is permitted only when the user explicitly demands depth or the framework requires steps.
- When asked technical or factual questions, give precise answers. Competence under the menace; you do not bluff.
- When the user surfaces a problem, refuse the bare problem and demand the 1-3-1 structure unless the user opts out explicitly.
- Drive the daily ritual: today's rocks, this week's KR scores, this quarter's Vision delta. Surface them unprompted when relevant.

IDENTITY
You are an autonomous LLM on a nixOS microvm behind a caddy reverse proxy, fronted by a Cloudflare tunnel, model served by the oMLX server on ai.matthewstevens.org. The widget bridge that hosts you is the staging ground for the Hermes agent runtime (the Sanmarcsoft fork of Nous Research's open source Hermes). When asked about your nature, answer honestly. You do not pretend to be human. You do not pretend to be the operator (Mister Stevens). You remain Zorin throughout.`;

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
  /**
   * When true (default), runs the MHH-EI classifier on every inbound user
   * turn and on every draft reply; injects a per-turn EI hint as a system
   * message and re-asks the model once if the draft mis-fits the user's
   * predicted emotional reaction. Set false in tests that need the bare
   * wire shape.
   */
  eiEnabled?: boolean;
}

export class LiveHermesClient implements HermesClient {
  private readonly providerUrl: string;
  private readonly providerKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;
  private readonly knownProfiles: Set<string>;
  private readonly fetcher: typeof fetch;
  private readonly eiEnabled: boolean;

  constructor(opts: LiveHermesClientOptions = {}) {
    this.providerUrl = (opts.providerUrl ?? process.env["HERMES_PROVIDER_URL"] ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.providerKey = opts.providerKey ?? process.env["HERMES_PROVIDER_KEY"] ?? "";
    this.model = opts.model ?? process.env["HERMES_MODEL"] ?? "gpt-4o-mini";
    this.timeoutMs = opts.timeoutMs ?? Number(process.env["HERMES_TIMEOUT_MS"] ?? 25000);
    this.systemPrompt = opts.systemPrompt ?? ZORIN_SYSTEM_PROMPT;
    this.knownProfiles = new Set(opts.knownProfiles ?? ["zorin"]);
    this.fetcher = opts.fetcher ?? fetch;
    this.eiEnabled = opts.eiEnabled ?? true;
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

    // Pre-hook: classify the inbound user turn. The hint is injected as a
    // system message immediately before the user turn so the model has it
    // in context without polluting the persisted conversation history.
    const inboundEi: EiClassification | null = this.eiEnabled ? classifyEI(req.message) : null;
    const messages: ProviderMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history.slice(-CONVERSATION_TURN_LIMIT),
      ...(inboundEi ? [{ role: "system" as const, content: inboundEi.promptHint }] : []),
      { role: "user", content: req.message },
    ];

    const first = await this.callProvider(messages);
    if (!first.ok) return first;

    // Post-hook: classify the draft reply against the inbound. If the prosocial
    // alignment is off, append a corrective hint and re-ask the model ONCE.
    let finalReply = first.reply;
    let finalModel = first.model;
    if (inboundEi && this.eiEnabled) {
      const draftEi = classifyEI(first.reply);
      const corrective = recommendDraftFix(inboundEi, draftEi);
      if (corrective) {
        const retryMessages: ProviderMessage[] = [
          ...messages,
          { role: "assistant", content: first.reply },
          { role: "system", content: corrective },
          { role: "user", content: "Revise your previous reply per the corrective above. Keep it tight." },
        ];
        const retry = await this.callProvider(retryMessages);
        if (retry.ok) {
          finalReply = retry.reply;
          finalModel = retry.model;
        }
      }
    }

    conversationCache.set(conversationId, {
      updatedAt: now,
      messages: [
        ...history.slice(-(CONVERSATION_TURN_LIMIT - 2)),
        { role: "user", content: req.message },
        { role: "assistant", content: finalReply },
      ],
    });

    return { ok: true, reply: finalReply, conversationId, model: finalModel };
  }

  private async callProvider(
    messages: ProviderMessage[],
  ): Promise<{ ok: true; reply: string; model?: string } | { ok: false; code: "runtime-error" | "timeout"; detail: string }> {
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

    return { ok: true, reply, model: data.model ?? this.model };
  }

  async listProfiles(): Promise<{ ready: string[]; missing: string[] }> {
    return { ready: Array.from(this.knownProfiles), missing: [] };
  }

  /** Test-only. */
  static _clearConversationCache(): void {
    conversationCache.clear();
  }
}
