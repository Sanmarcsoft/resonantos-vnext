# ADR-016: Replace `haus.matthewstevens.org` Gemma chatbot VM with a Hermes Agent VM

- Status: Proposed
- Date: 2026-05-14
- Deciders: M, ResonantOS Engineering
- Related: ADR-005 (Provider Fabric Routing), ADR-006 (Add-on Runtime SDK), ADR-015 (Delegation Fabric / Add-on Catalog / Native Tools)
- Driver: `public/addons/hermes.json`, `docs/architecture/addon-skills/hermes/AUGMENTOR_SKILL.md`
- Reference: ResonantOS Toolkit field guide, https://augmentedmind.substack.com/p/resonantos-toolkit-a-field-guide

## Context

`haus.matthewstevens.org` is currently a VHost on the `nix` host (`10.0.0.112`) serving a legacy ResonantOS Gemma chatbot widget at `POST /api/widget/chat` with a hardcoded `botId=zorin001`. That endpoint is the documented fallback path inside `claude-peers-mcp/bridge.ts`: when the primary Zorin MCP server at `http://127.0.0.1:3116/mcp` is unreachable, the bridge sends `/greet` to the Gemma widget instead. `bridge.ts` rewrites the `Host` header to `haus.matthewstevens.org` and posts `{ botId: "zorin001", message }` to `http://10.0.0.112:80/api/widget/chat`.

This arrangement has three problems:

1. **Single-tenant by accident.** The widget only knows `zorin001`. Every other persona (M, 007, Q, Moneypenny) has no chatbot fallback at all and silently degrades to text.
2. **Legacy runtime drift.** The Gemma chatbot was a quick demo. It has no relationship to the ResonantOS vNext add-on contract that the rest of the platform now uses (`public/addons/hermes.json`).
3. **Non-sovereign substrate.** The VM lives on a single physical machine inside the LAN. The Sanmarcsoft Sovereign Architecture SOP (effective 2026-03-13) requires production workloads to be Nix-built, x86_64-linux-targeted, and pushed to Scaleway Container Registry in `fr-par`.

The ResonantOS Toolkit field guide names "Hermes" as a development-track add-on for communication and coordination. The Hermes Agent project at github.com/NousResearch/hermes-agent is the obvious upstream: MIT-licensed, multi-provider, gateway-capable, designed to "run on a $5 VPS" with Telegram/Matrix/Slack/Signal front ends, and already shipping its own Nix flake.

## Decision

Replace the legacy Gemma chatbot VM at `haus.matthewstevens.org` with a new VM, `haus-vm`, that:

1. **Preserves the `POST /api/widget/chat` wire contract byte-for-byte** so `claude-peers-mcp/bridge.ts` keeps working through the cutover. A thin "widget-bridge" HTTP shim sits in front of Hermes and accepts the legacy `{ botId, message }` payload.
2. **Maps each `botId` to a Hermes profile.** `zorin001`, `m`, `007`, `q`, and `moneypenny` are first-class profiles with independent personalities, models, and memory namespaces. Adding a new persona becomes a profile-create operation, not a code change.
3. **Honours the existing Hermes add-on contract** in `public/addons/hermes.json`. The widget-bridge implements the `agentRuntime.invocationTool = "hermes.chat"` semantics from the manifest: a single shell-out per turn, assistant-reply-only output filtering, no streaming (yet), approval-gated outbound sends.
4. **Builds via Nix `pkgs.dockerTools.buildLayeredImage`** for `x86_64-linux`. No Dockerfile. The image is reproducible from `flake.nix` pinned to `nixos-25.05` and cross-compiles cleanly from Apple Silicon dev hosts via OrbStack.
5. **Deploys to Scaleway Container Registry `rg.fr-par.scw.cloud/sanmarcsoft/haus-vm:<tag>`** via `skopeo copy`, with Pulumi TypeScript IaC and state in Scaleway Object Storage (`s3://sanmarcsoft-pulumi-state`).
6. **Stays on Cloudflare DNS.** Per the SOP exemption, `haus.matthewstevens.org` continues to resolve through Cloudflare; only the A/AAAA target moves from `10.0.0.112` to the Scaleway serverless container.

The first release (`0.1.0`, this commit) ships a **stub** Hermes client that returns deterministic echo replies. This is enough to:

- regression-test the wire contract end-to-end before Hermes is provisioned
- stand up the VM on staging (NAS) and run parity tests against `bridge.ts`
- exercise the Nix build, the Scaleway push, and the Cloudflare DNS plumbing

Wiring the real Hermes runtime is a follow-up after staging parity is green.

## Alternatives considered

### A1. Keep the Gemma widget, just rehost it

Reproduces every problem above and locks us into a dead-end runtime. Rejected.

### A2. Build a custom agent from scratch

We would re-implement most of what Hermes already offers: provider switching, gateway, memory, skills, scheduler, Telegram/Matrix bridges. Hermes is MIT-licensed and the Nix flake exists. Not invented here, not worth re-inventing.

### A3. Use a managed agent platform (OpenAI Assistants, Anthropic agents, etc.)

Violates the Sovereign Registry Law and the IaC Law. We do not put production agent workloads on US-hosted managed platforms.

### A4. Run Hermes directly without the widget-bridge

The widget-bridge exists for one reason: drop-in compatibility with the legacy `POST /api/widget/chat` contract that `claude-peers-mcp/bridge.ts` already calls. Without the bridge, we would have to change every caller during the cutover, breaking the property that the legacy widget and the new VM are wire-compatible.

The widget-bridge is also where capability-gating, audit logging, and the approval-before-outbound-send guarantee from `hermes.json` live. Keeping that policy outside the upstream Hermes process means we can change policy without forking upstream.

## Consequences

### Positive

- One VM serves all personas. Adding a persona is a profile-create operation.
- The Hermes add-on contract in `public/addons/hermes.json` finally has a host runtime that matches it end-to-end.
- The wire contract holds through the cutover, so `claude-peers-mcp/bridge.ts` keeps working unchanged.
- Production workload moves into the sovereign substrate (Scaleway fr-par, Nix-built, Pulumi-managed) and stops depending on a single LAN host.

### Negative

- Two cooperating processes per VM (widget-bridge + Hermes) instead of one. The widget-bridge is intentionally tiny to keep this overhead bounded.
- Profile state for Hermes lives in container memory in 0.1.0. Persistence across cold-starts is a follow-up (Scaleway Object Storage bucket for Hermes state).
- The cutover requires a parity test against `bridge.ts` before DNS moves. That gate is non-negotiable per the Testing -> Production Pipeline rule.

### Risks and mitigations

- **Risk:** `bridge.ts` Zorin fallback breaks during cutover. **Mitigation:** Stage on NAS first with an env-var override pointing `bridge.ts` at the staging URL; verify parity for 24h before DNS moves.
- **Risk:** Hermes upstream changes break the `hermes chat` JSON contract. **Mitigation:** The widget-bridge isolates the shell-out behind a `HermesClient` interface; we can pin the Hermes version in `flake.nix` and migrate deliberately.
- **Risk:** Scaleway region outage. **Mitigation:** The Cloudflare DNS layer can fail back to the NAS staging endpoint by changing one record; the staging VM stays warm during the first month after cutover.

## Implementation status

- [x] `infra/haus-vm/widget-bridge/` Bun TypeScript service with `POST /api/widget/chat` and `GET /health`
- [x] `infra/haus-vm/flake.nix` Nix flake building an `x86_64-linux` OCI image from any supported build host
- [x] `infra/haus-vm/pulumi/` Pulumi TypeScript skeleton wired to the Scaleway Object Storage backend
- [x] Smoke tests for the wire contract (`widget-bridge/src/server.test.ts`)
- [ ] Replace the StubHermesClient with a real Hermes runtime client (shell-out, then gateway)
- [ ] Cross-compile OCI image build verified on Apple Silicon and pushed to a `:scaffold` tag in Scaleway CR
- [ ] Stage on NAS (a1.matthewstevens.org)
- [ ] Parity tests against `claude-peers-mcp/bridge.ts`
- [ ] Promote staging image to `:production`, deploy to Scaleway, cut DNS, decommission legacy Gemma VM

## References

- ResonantOS Toolkit field guide: https://augmentedmind.substack.com/p/resonantos-toolkit-a-field-guide
- Hermes Agent (Nous Research): https://github.com/NousResearch/hermes-agent
- Hermes add-on manifest: `public/addons/hermes.json`
- Hermes Augmentor Skill: `docs/architecture/addon-skills/hermes/AUGMENTOR_SKILL.md`
- Sanmarcsoft Sovereign Architecture SOP (workspace `CLAUDE.md`)
- Legacy fallback caller: `claude-peers-mcp/bridge.ts`
