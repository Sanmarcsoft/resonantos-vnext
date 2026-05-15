# ADR-032: Replace `LiveHermesClient` with the real `hermes-agent` runtime in `haus-vm`

- Status: Proposed
- Date: 2026-05-14
- Deciders: M, Zorin controller (PAI)
- Related: ADR-016 (haus-vm replaces Gemma), ADR-031 (agent-addon SDK lessons from Hermes)
- Driver: `infra/haus-vm/widget-bridge/src/live-hermes-client.ts` is named "Hermes" but is, today, a stateless OpenAI-compatible proxy to oMLX. The real `hermes-agent` runtime brings persistent state, tool-use, mhh-ei classify as a tool, and RL trajectory capture; the widget-bridge becomes the front door to that runtime instead of the runtime itself.

## Context

`haus.matthewstevens.org/chat` is backed by `widget-bridge`, a Bun HTTP shim inside the `haus-vm` microvm. The shim currently routes every turn through `LiveHermesClient.chat()`, which posts an OpenAI-compatible `chat/completions` payload to oMLX (`http://10.0.0.96:8881/v1`, Gemma 3 4B QAT 4-bit MLX). Conversation history is held in a per-process LRU keyed by `conversationId`; system prompt is the canonical Zorin prompt; MHH-EI is computed in the same process by `mhh-ei.ts` and injected as a per-turn system note.

This is the right thing for ship-now Zorin: real model, real coaching voice, real EI calibration. But three structural ceilings are now visible:

1. **No tool use.** The shim cannot dispatch to `mhh_ei.classify`, `wolfram.query`, `calendar.check`, `portfolio.query`, or any other addressable capability. Every Zorin turn is one shot through the LLM, which means every framework lookup, every dashboard reference, every per-call grounding has to be hallucinated rather than fetched. The MHH-EI hint is the only structured signal the model sees.
2. **No persistence beyond process lifetime.** Conversation cache is in-memory only. A `systemctl restart haus-widget-bridge` wipes it. `LiveHermesClient._clearConversationCache` exists because we are honest about this.
3. **No trajectory capture for RL.** Hermes Agent is designed around trajectory logging for future fine-tuning. `LiveHermesClient` stores nothing. The richest training data we will ever have (every coaching turn Mister Stevens has with Zorin) is being thrown on the floor.

The Sanmarcsoft fork of Hermes Agent lives at `/config/workspace/projects/sanmarcsoft/hermes-agent`, synced to `a952ca3ff` from upstream `NousResearch/hermes-agent`. Upstream is a full interactive agent runtime: TUI front end, messaging-gateway plugins (Telegram, Matrix, Slack, Signal), persistent state via SQLite, tool use via the OpenAI tool-call interface, and a Nix flake.

## Decision

Replace `LiveHermesClient` with a process-spawn or local-HTTP client that fronts a real `hermes-agent` runtime running as a `systemd` unit inside the `haus-vm` guest. The widget-bridge becomes the public HTTP entry; Hermes becomes the agent layer; oMLX stays the model layer.

Concretely:

1. **Pin `hermes-agent` as a flake input** of `infra/haus-vm/flake.nix`, sha-pinned to a Sanmarcsoft fork rev. No upstream URL drift.
2. **Add a `haus-hermes` systemd unit** inside the guest. It runs `hermes serve` (HTTP mode) on `127.0.0.1:7100`, reads its config from `/etc/haus-vm/hermes.toml`, and is restart-on-failure. Profile selection: `--profile zorin`. Backend: OpenAI-compatible to oMLX at `http://10.0.0.96:8881/v1` (the existing env contract for `LiveHermesClient` becomes Hermes's backend config).
3. **Replace `LiveHermesClient` with `HttpHermesClient`** that posts to `http://127.0.0.1:7100/v1/chat` (or whatever the canonical Hermes HTTP shape is) and returns the same `HermesChatResult`. The wire contract on `/api/widget/chat` does NOT change. `server.ts` does not change. The swap is invisible to the browser.
4. **Move MHH-EI to a Hermes tool.** Register `mhh_ei.classify(text)` as a tool inside the Hermes profile. The widget-bridge stops doing the pre-hook/post-hook dance; Hermes's tool-call loop owns it. `mhh-ei.ts` migrates into the Hermes addon directory as the tool implementation. The deterministic classifier itself does not change; only its caller does. This unblocks the next step (calling MHH-EI mid-turn rather than only on inbound and draft) and gets us closer to the way Sean Webb's framework is described: an in-loop signal that shapes the agent's reasoning, not a system-message annotation.
5. **Add SQLite persistence** in the guest (`/var/lib/haus-hermes/zorin.db`) via Hermes's built-in state layer. Conversation history survives restarts; future RL training has data to learn from.
6. **Add Telegram and Matrix gateway plugins** behind a feature gate. The widget HTTP path stays primary; Matrix and Telegram become alternate front doors to the same Zorin runtime, with PAI Operator routing already in place via Moneypenny's matrix-bridge.
7. **Replace `engine: "hermes"` from a label into a fact.** Today the bridge says `engine: "hermes"` whenever `HERMES_MODE=cli`, even though the backing client is OpenAI-compatible proxy. After the swap the label is honest.

## Consequences

### Positive

- One backend with tool use, persistent state, and trajectory capture replaces three separate gaps in the current shim.
- MHH-EI moves from a prompt annotation to an in-loop tool. Severity calibration becomes a thing the model can re-query during a single turn, not just a hint at the start.
- Conversation continuity across guest reboots. Mister Stevens picks up where he left off after any `nixos-rebuild switch`.
- Telegram and Matrix gateways open without rebuilding the persona elsewhere; one Zorin everywhere.
- The wire contract stays byte-stable. Callers (`claude-peers-mcp/bridge.ts`, the chat HTML, any future MCP wrapper) do not change.

### Negative

- Real runtime is multi-day work. Hermes config, systemd unit, tool definitions, SQLite schema, gateway secrets — none of this fits a single session. The current `LiveHermesClient` keeps the door open during the build.
- One more daemon inside the guest. Resource accounting against oMLX latency budgets needs to be re-measured (today: 3 s warm, 10 s cold). Hermes adds an inner hop; expect +50-150 ms per turn.
- Tool calls inside Hermes will issue HTTP to oMLX twice per turn (once for the planning step, once for the final answer) once tool use is enabled. Token cost roughly doubles in those turns. Acceptable; the EI calibration is worth it.
- `mhh-ei.ts` lives in two places during the transition (widget-bridge AND Hermes addon). The widget-bridge copy stays as the fallback for `HERMES_MODE=cli` legacy mode, then is deleted once the Hermes runtime ships.

### Migration steps

This ADR does NOT ship the runtime. It is the design statement. The implementation steps, sequenced for safety:

1. **Stand up `hermes serve` locally on the dev host.** `cd ~/.../hermes-agent && nix develop && hermes serve --profile zorin --backend openai-compatible --backend-url http://10.0.0.96:8881/v1 --backend-model mlx-community/gemma-3-4b-it-qat-4bit`. Smoke-test against the existing Zorin system prompt.
2. **Register the `mhh_ei.classify` tool.** Port `mhh-ei.ts` deterministic logic into a Hermes tool (TypeScript or Python depending on Hermes's tool SDK). Run the same 9 tests against the tool wrapper.
3. **Add SQLite persistence.** Use Hermes's built-in state store.
4. **Author `infra/haus-vm/hermes/profile.toml`** in this repo, with the Zorin system prompt, the registered tool list, the backend config, and the gateway list (HTTP only at first).
5. **Add `haus-hermes` systemd unit** to `microvm-config.nix`. Mount `/etc/haus-vm/hermes.toml` and `/var/lib/haus-hermes/` into the guest via virtiofs.
6. **Implement `HttpHermesClient`** in `widget-bridge`, gate behind `HERMES_MODE=hermes-http`. Keep `HERMES_MODE=cli` available as a fallback during cutover.
7. **Cut over the staging haus-vm.** Flip `HERMES_MODE=hermes-http` on the nix host, redeploy, smoke-test through `/chat`.
8. **Cut over production** after one week of staging soak. Delete the `LiveHermesClient` mhh-ei hooks; the classifier becomes a Hermes tool only.

## Alternatives considered

- **Stay on `LiveHermesClient`, add tool use directly.** Possible: extend the bridge to mediate tool calls itself, treating the bridge as the agent. Rejected because Hermes already does this work, with persistence and gateway plumbing; reimplementing it inside the bridge duplicates upstream effort and locks us into Bun-only tooling.
- **Move to a managed agent runtime (LangGraph, LlamaIndex, Inkeep).** Rejected: US-hosted, not sovereign, and the SDK is heavier than Hermes for the Zorin scope.
- **Build a Sanmarcsoft-native agent runtime from scratch.** Rejected: Hermes already exists, the Sanmarcsoft fork is in place, and the gateway/persistence/trajectory work is the bulk of the cost. The persona is the bit that matters; the runtime is commodity.

## Open questions

- Should Hermes own the `/api/widget/chat` shape, or stays the widget-bridge as the HTTP front door? **Recommendation:** keep the bridge as front door, run Hermes on loopback. Bridge owns auth, host guard, body caps, security headers, and observability. Hermes owns agent logic. Clean separation.
- Where should the EI classifier live long-term: in Hermes's addon directory or in a shared `@sanmarcsoft/mhh-ei` package? **Recommendation:** standalone npm package once the Hermes integration is done, so claude-peers, the narrator agent, and future PAI agents can all consume the same deterministic classifier without forking.
- Do we keep the in-process retry loop the bridge does today (re-ask once on EI mismatch)? **Recommendation:** retire it. Hermes's tool-call loop will let the model query `mhh_ei.classify` and self-correct mid-turn, which is strictly better than the post-hoc re-ask.

## Definition of done

- A user message posted to `https://haus.matthewstevens.org/api/widget/chat` returns a reply whose generation involved at least one `mhh_ei.classify` tool call in the trajectory.
- The `engine` field in the response reads `"hermes"` and is structurally accurate (not a synonym for `LiveHermesClient`).
- `systemctl restart haus-hermes && curl ... | jq .conversationId` returns the same conversation id across the restart for a previously-active session.
- `LiveHermesClient` is deleted, or guarded by `HERMES_MODE=legacy` with a deprecation warning at boot.
