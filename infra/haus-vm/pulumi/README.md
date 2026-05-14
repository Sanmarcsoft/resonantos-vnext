# haus-vm Pulumi

Pulumi TypeScript program that provisions the production haus.matthewstevens.org Hermes-backed VM on Scaleway.

## Stacks

- `dev` — local docker-compose only, no Scaleway resources
- `staging` — NAS-resident testing stack on a1.matthewstevens.org, no Scaleway resources
- `prod` — Scaleway fr-par production stack

## State backend (per Sanmarcsoft IaC Law)

State lives in Scaleway Object Storage at `s3://sanmarcsoft-pulumi-state` in `fr-par`. NOT Pulumi Cloud (US-hosted).

## Deploy gate

Per the Testing -> Production Pipeline rule, the prod stack MUST NOT be `pulumi up`'d until the staging stack on the NAS has passed parity tests against the legacy `claude-peers-mcp/bridge.ts` caller. See `../README.md#cutover-plan`.

## Quickstart

```bash
npm install
pulumi login s3://sanmarcsoft-pulumi-state?endpoint=s3.fr-par.scw.cloud&region=fr-par
pulumi stack select prod
pulumi config set --secret haus:bridge-token "$(openssl rand -hex 32)"
pulumi preview
```

## Status

This program is a scaffold. The resource blocks are documented as comments in `src/index.ts` and will be enabled after the first OCI image is pushed to Scaleway Container Registry.
