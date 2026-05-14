/**
 * Hermes Agent client.
 *
 * This module is the boundary between the widget-bridge HTTP shim and the
 * Nous Research Hermes Agent runtime. The shim is intentionally narrow so it
 * can be swapped (process-spawn, local-HTTP, gateway-RPC) without changing the
 * HTTP-facing contract in `server.ts`.
 *
 * Initial implementation: a STUB that always returns a deterministic reply,
 * so the bridge can be wired end-to-end and the wire contract regression-tested
 * before the Hermes runtime is provisioned on the VM.
 */

import type { WidgetChatRequest, WidgetChatResponse } from "./types";

export interface HermesClient {
  /**
   * Run a single chat turn against a Hermes profile.
   * Implementations MUST NOT throw for "profile missing" — they MUST return
   * a structured error so the HTTP layer can map it to a 404 cleanly.
   */
  chat(req: WidgetChatRequest): Promise<HermesChatResult>;

  /** List ready profile ids (e.g. ["zorin001", "m", "007"]). */
  listProfiles(): Promise<{ ready: string[]; missing: string[] }>;
}

export type HermesChatResult =
  | { ok: true; reply: string; conversationId: string; model?: string }
  | { ok: false; code: "profile-not-found" | "runtime-error" | "timeout"; detail: string };

/**
 * Stub client. Returns the prompt back with a profile-shaped envelope so the
 * bridge.ts caller sees a structurally-valid response. Replace with a real
 * client (likely shelling out to `hermes chat --profile <botId> --json`) once
 * the Hermes runtime is on the VM.
 */
export class StubHermesClient implements HermesClient {
  private readonly knownProfiles: Set<string>;

  constructor(knownProfiles: readonly string[] = ["zorin001", "m", "007", "q", "moneypenny"]) {
    this.knownProfiles = new Set(knownProfiles);
  }

  async chat(req: WidgetChatRequest): Promise<HermesChatResult> {
    if (!this.knownProfiles.has(req.botId)) {
      return {
        ok: false,
        code: "profile-not-found",
        detail: `No Hermes profile configured for botId "${req.botId}"`,
      };
    }

    const reply = `[stub:${req.botId}] You said: ${req.message}`;
    const conversationId = req.conversationId ?? crypto.randomUUID();
    return { ok: true, reply, conversationId, model: "stub-no-model" };
  }

  async listProfiles(): Promise<{ ready: string[]; missing: string[] }> {
    return { ready: Array.from(this.knownProfiles), missing: [] };
  }
}
