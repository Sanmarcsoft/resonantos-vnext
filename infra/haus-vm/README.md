# haus.matthewstevens.org: Hermes-Agent VM

Replacement infrastructure for the legacy ResonantOS Gemma chatbot VM at `haus.matthewstevens.org`. The legacy service ran on the nixOS host `nix.matthewstevens.org` (10.0.0.112) and served `POST /api/widget/chat` with a hardcoded wire id `botId=zorin001`.

This directory replaces that service with a Hermes-Agent-powered shim that preserves the same wire contract and routes every turn to a single canonical Hermes profile named **`zorin`**. The wire id `zorin001` is accepted as a legacy alias and translated to `zorin` internally so `claude-peers-mcp/bridge.ts` keeps working unchanged. The new service is aligned with the ResonantOS vNext Hermes add-on (`public/addons/hermes.json`).

**Scope:** Hermes profile is `zorin` only. Other personas (M, 007, Q, Moneypenny) already have their own agent backends (see `claude-peers-mcp` broker `agent_routes`) and are not provisioned here.

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
       |  Profile:        |  github.com/NousResearch/hermes-agent
       |  - zorin         |
       |                  |  Wire alias `zorin001` -> profile `zorin`.
       |                  |  Single-profile by design. Other personas
       |                  |  route through their own agent backends.
       +------------------+
```

## Drop-in contract

The legacy caller (`claude-peers-mcp/bridge.ts:1270-1290`) actually sends a `messages` array, not a single `message` string:

```http
POST http://10.0.0.112:80/api/widget/chat
Host: haus.matthewstevens.org
Content-Type: application/json

{
  "botId": "zorin001",
  "messages": [
    { "role": "user", "content": "<user prompt>" }
  ]
}
```

The widget-bridge accepts both wire shapes (`{message}` and `{messages:[{role,content}]}`) and normalises internally. `zorin001` is translated to the canonical Hermes profile `zorin`. Callers MAY also send `botId: "zorin"` directly. The response shape is documented in `widget-bridge/src/types.ts`.

## Security posture

The bridge ships with the following gates enabled:

| Gate | Default | How to override |
|------|---------|-----------------|
| Auth | `BRIDGE_TOKEN` bearer required when `NODE_ENV=production`; refuses to boot otherwise. Constant-time compare. | Set `BRIDGE_TOKEN`. |
| Host allowlist | `haus.matthewstevens.org,localhost,127.0.0.1` | `ALLOWED_HOSTS` env var (comma-separated). |
| Body cap | 32 KiB per request. Oversized = 413. | `MAX_BODY_BYTES` (compile-time constant). |
| Message cap | 8000 chars. | `MAX_MESSAGE_LEN` (compile-time constant). |
| Input regex | `botId` matches `^[a-z][a-z0-9_-]{0,31}$`; `conversationId` and `caller` match `^[A-Za-z0-9._-]{1,64}$`. Control chars rejected in `message`. | Constants in `server.ts`. |
| Request timeout | 8 s per chat handler (AbortController). Server `idleTimeout` 10 s. | `CHAT_TIMEOUT_MS` (compile-time constant). |
| Response headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. | n/a. |
| Bind interface | `127.0.0.1` inside the container. Reverse proxy fronts it. | `HOST=0.0.0.0` if no proxy. |
| Container user | UID/GID 1000 (non-root). | `User` field in `flake.nix`. |
| `/health` | `{status:"ok"}` only without bearer. Full payload behind `Authorization: Bearer <BRIDGE_TOKEN>`. | n/a. |
| `/livez` | Always 200 ok. Use for load-balancer probes. | n/a. |

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

# Push to Scaleway (sovereign registry). Example only, deploy is gated.
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
- `public/addons/hermes.json`: the ResonantOS Hermes add-on contract this VM implements
- `docs/architecture/addon-skills/hermes/AUGMENTOR_SKILL.md`: the Augmentor-side skill that talks to this VM
- `../../examples/living-archive-mcp.mjs`: sibling local-service reference
