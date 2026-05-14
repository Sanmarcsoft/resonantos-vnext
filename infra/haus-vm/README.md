# haus.matthewstevens.org — Hermes-Agent VM

Replacement infrastructure for the legacy ResonantOS Gemma chatbot VM at `haus.matthewstevens.org`. The legacy VM serves `POST /api/widget/chat` with hardcoded `botId=zorin001` on the `nix` host (10.0.0.112). This directory replaces that VM with a Hermes-Agent-powered service that preserves the same wire contract and grows it into a multi-personality, capability-gated communication agent aligned with the ResonantOS vNext Hermes add-on (`public/addons/hermes.json`).

## Architecture

```
+-------------------------------+
|  Cloudflare DNS               |
|  haus.matthewstevens.org      |
+---------------+---------------+
                |
        +-------v--------+
        |  Reverse proxy |  (Caddy or Traefik on the host)
        |  TLS terminate |
        +-------+--------+
                |
   +------------v------------+
   |  widget-bridge          |  Bun TypeScript HTTP shim
   |  POST /api/widget/chat  |  Drop-in replacement for the
   |  GET  /health           |  Gemma widget endpoint.
   |                         |  Translates {botId, message} into
   |                         |  Hermes profile invocations.
   +------------+------------+
                |
       +--------v---------+
       |  Hermes Agent    |  Nous Research Hermes (MIT)
       |  Profiles:       |  github.com/NousResearch/hermes-agent
       |  - zorin001      |
       |  - m             |  Each botId maps to a Hermes profile
       |  - 007           |  with its own personality, model, and
       |  - q             |  memory namespace.
       |  - moneypenny    |
       +------------------+
```

## Drop-in contract

The legacy caller (`claude-peers-mcp/bridge.ts`) hits:

```http
POST http://10.0.0.112:80/api/widget/chat
Host: haus.matthewstevens.org
Content-Type: application/json

{
  "botId": "zorin001",
  "message": "<user prompt>"
}
```

The widget-bridge MUST preserve this request shape and continue to accept the `Host: haus.matthewstevens.org` header. The response shape is documented in `widget-bridge/src/types.ts`.

## Why Hermes

The ResonantOS Toolkit field guide (https://augmentedmind.substack.com/p/resonantos-toolkit-a-field-guide) describes ResonantOS as the meta-system and lists Hermes as a development add-on for communication and coordination. Nous Research's Hermes Agent is an MIT-licensed, multi-provider, gateway-capable, self-improving agent designed exactly for "talk to it from Telegram while it works on a cloud VM" deployment. It already ships a Nix flake.

The match against the existing `public/addons/hermes.json` contract is one-to-one:
- `agent-addon` runtime type maps to the Hermes CLI as a long-running process per profile
- `providerRequirements.preferredRuntimeKinds = ["remote-user-owned", "local", "cloud"]` is exactly Hermes' deployment model
- `agentRuntime.invocationTool = "hermes.chat"` is the existing Hermes shell-out path
- `health.strategy = "agent-heartbeat"` matches Hermes' built-in `hermes doctor`

## Build (Sanmarcsoft SOP compliant)

Per the Sanmarcsoft Sovereign Architecture SOP this directory MUST:

- Use `nix build .#packages.x86_64-linux.oci-image` (no Dockerfile for production)
- Target `x86_64-linux` from any host (Apple Silicon dev cross-compiles via OrbStack)
- Push to Scaleway Container Registry `rg.fr-par.scw.cloud/sanmarcsoft/haus-vm:<tag>` via `skopeo copy`
- State managed by Pulumi TypeScript with Scaleway Object Storage backend

```bash
# Build OCI image on Apple Silicon dev for x86_64-linux deploy
nix build .#packages.x86_64-linux.oci-image

# Push to Scaleway (sovereign registry) — example only, deploy is gated
skopeo copy \
  docker-archive:./result \
  docker://rg.fr-par.scw.cloud/sanmarcsoft/haus-vm:testing
```

## Status

- [x] ADR-016 scaffolded
- [x] widget-bridge HTTP shim scaffolded (Bun TypeScript)
- [x] Nix flake scaffolded (x86_64-linux OCI image)
- [x] Pulumi skeleton scaffolded
- [ ] Wire widget-bridge to a running Hermes profile (next iteration)
- [ ] Cross-compile OCI image build verified on Apple Silicon
- [ ] Stage on NAS (a1.matthewstevens.org) before production cutover
- [ ] Cut DNS over from legacy VM
- [ ] Decommission legacy Gemma chatbot

## Cutover plan

The legacy `haus.matthewstevens.org` is referenced from `claude-peers-mcp/bridge.ts` as a fallback for Zorin/Q. The cutover plan:

1. Stand up `haus-vm` on staging (NAS, a1.matthewstevens.org) on a non-clashing port
2. Run `bridge.ts` against the staging URL with a temporary override env var; confirm parity
3. Promote staging image to `:production` per the Testing -> Production Pipeline rule
4. Deploy to Scaleway; wait for health-check green
5. Cut DNS in Cloudflare from `10.0.0.112` to the Scaleway endpoint
6. Watch `bridge.ts` Zorin/Q fallback path for 24h
7. Decommission the legacy Gemma chatbot

## Related

- `docs/architecture/ADR-016-haus-vm-hermes-replacement.md`
- `public/addons/hermes.json` — the ResonantOS Hermes add-on contract this VM implements
- `docs/architecture/addon-skills/hermes/AUGMENTOR_SKILL.md` — the Augmentor-side skill that talks to this VM
- `../../examples/living-archive-mcp.mjs` — sibling local-service reference
