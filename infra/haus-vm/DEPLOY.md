# Cutover runbook: `nix.matthewstevens.org`

This document drives the cutover from the legacy `openclaw-vm` microvm to the new `haus-vm` microvm on `nix.matthewstevens.org`. Hostfwd surface is preserved byte-for-byte, so caddy, the claude-peers zorin-port-relay, and any other on-host callers do not change.

The cutover is reversible: stop the new microvm, re-enable the openclaw-vm services, `nixos-rebuild switch --rollback`. All steps below are explicit so a different operator can run them.

## Phase 0: secrets

Generate and store the bearer token that the new widget-bridge requires in production.

```bash
# On the host that holds the password store (your Mac):
pass insert -m claude-peers/zorin-bridge-token <<EOF
9ae0a02f11258559be3f13b4bffeef3a369bdfd252cdd6752c1c9b391f0bb5a7
EOF

# On nix.matthewstevens.org, write the env file the systemd unit expects.
# /etc/haus-vm/bridge.env contains literally `BRIDGE_TOKEN=...`.
ssh nix '
  sudo install -d -m 0700 -o root -g root /etc/haus-vm
  sudo tee /etc/haus-vm/bridge.env > /dev/null <<EOF
BRIDGE_TOKEN=9ae0a02f11258559be3f13b4bffeef3a369bdfd252cdd6752c1c9b391f0bb5a7
EOF
  sudo chmod 0600 /etc/haus-vm/bridge.env
'
```

Future iteration: replace the manual env file with `sops-nix` (the host flake already imports `sops-nix.nixosModules.sops`).

Then export the same token on the bridge caller side so the `/greet` Zorin fallback sends a matching Authorization header:

```bash
# Wherever claude-peers-mcp bridge.ts runs (your dev Mac or a service host):
export HAUS_BRIDGE_TOKEN=$(pass claude-peers/zorin-bridge-token)
```

If you ship `bridge.ts` as a systemd unit, add `Environment=HAUS_BRIDGE_TOKEN=...` to its drop-in.

## Phase 1: clone the repo onto the nixOS host

The host flake references the haus-vm flake by path. Put a working copy somewhere stable.

```bash
ssh nix '
  if [ ! -d /home/matt/resonantos-vnext ]; then
    git clone git@github.com:Sanmarcsoft/resonantos-vnext.git /home/matt/resonantos-vnext
  else
    cd /home/matt/resonantos-vnext && git fetch origin develop && git checkout develop && git pull --ff-only
  fi
  ls /home/matt/resonantos-vnext/infra/haus-vm/flake.nix
'
```

Replace the URL if the repo lives elsewhere. Branch `develop` carries the haus-vm work today; merge to `main` when ready.

## Phase 2: patch `/home/matt/nixos-config/flake.nix`

Three deltas. Apply them by hand or use a small `patch` invocation; either way, keep a backup of the old `flake.nix` first.

```bash
ssh nix 'cp /home/matt/nixos-config/flake.nix /home/matt/nixos-config/flake.nix.bak.pre-haus-vm-$(date +%Y%m%d-%H%M%S)'
```

### Delta 1: add the input

In the `inputs` block (near the top, alongside `microvm.url = ...`):

```nix
    # haus-vm: Hermes-backed widget bridge replacing openclaw-vm.
    haus-vm.url = "path:/home/matt/resonantos-vnext/infra/haus-vm";
    haus-vm.inputs.nixpkgs.follows = "nixpkgs";
    haus-vm.inputs.microvm.follows = "microvm";
```

### Delta 2: pull it into the outputs argument

Existing:

```nix
  outputs = { self, nixpkgs, microvm, openclaw, judelawclaw, sops-nix, ... }@inputs: {
```

After:

```nix
  outputs = { self, nixpkgs, microvm, openclaw, judelawclaw, sops-nix, haus-vm, ... }@inputs: {
```

### Delta 3: load the module and disable the openclaw-vm units

In `nixosConfigurations.nixos-host.modules = [ ... ]`, add `haus-vm.nixosModules.default` to the list. Then, inside the same inline module that defines `systemd.services.openclaw-vm` and `systemd.services.openclaw-vm-virtiofsd`, force them off and disable their dependents:

```nix
        haus-vm.nixosModules.default
        # ... existing modules ...
        ({ lib, ... }: {
          # Decommission openclaw-vm and its satellites. haus-vm now owns the
          # 19101/3103/3203/18789/18790/2223 hostfwd surface.
          systemd.services.openclaw-vm.enable          = lib.mkForce false;
          systemd.services.openclaw-vm-virtiofsd.enable = lib.mkForce false;
          systemd.services.openclaw-haus-chat-monitor.enable          = lib.mkForce false;
          systemd.services.openclaw-haus-room-status-exporter.enable  = lib.mkForce false;
          systemd.services.openclaw-dns-guard.enable                  = lib.mkForce false;
        })
```

The three satellite services (`openclaw-haus-chat-monitor`, `openclaw-haus-room-status-exporter`, `openclaw-dns-guard`) ran against openclaw-vm internals; nothing in haus-vm replaces them, and they have no upstream consumer once openclaw-vm is gone. Disable now and review whether to delete the units entirely in a follow-up commit.

Independent units that survive: `openclaw-gateway`, `openclaw-ssh-debug`, `openclaw-secrets-sync`. Inspect them before touching; this runbook does not disable them.

## Phase 3: validate the host flake

```bash
ssh nix '
  export PATH=/run/current-system/sw/bin:$PATH
  cd /home/matt/nixos-config
  nix --extra-experimental-features "nix-command flakes" flake check --no-build 2>&1 | tail -20
'
```

Expected: no errors. Warnings about omitted systems are fine. If a NixOS module error appears, fix the patch from Phase 2; do not proceed.

## Phase 4: cutover

Single command, atomic rebuild:

```bash
ssh nix 'sudo nixos-rebuild switch --flake /home/matt/nixos-config#nixos-host'
```

The activation script will:

1. Stop `openclaw-vm.service` and `openclaw-vm-virtiofsd.service`.
2. Stop the three satellite openclaw services.
3. Start `microvm@haus-vm.service` (provided automatically by `microvm.nixosModules.host`).
4. Inside haus-vm: `widget-bridge.service` boots, reads `/etc/haus-vm/bridge.env`, binds `0.0.0.0:19100`.

## Phase 5: smoke + watch

```bash
# /livez should answer immediately, no auth.
curl -sk -m 5 http://10.0.0.112/livez | jq .
# Expect: {"status":"ok"}

# /api/widget/chat should answer with the bearer.
curl -sk -m 10 -H "Host: haus.matthewstevens.org" \
  -H "Authorization: Bearer $(pass claude-peers/zorin-bridge-token)" \
  -H 'Content-Type: application/json' \
  -d '{"botId":"zorin001","messages":[{"role":"user","content":"ping"}]}' \
  http://10.0.0.112/api/widget/chat | jq .
# Expect: 200 with reply containing "ping" (stub mode prefixes [stub:zorin]).

# Authenticated /health gives the full operator view.
curl -sk -H "Authorization: Bearer $(pass claude-peers/zorin-bridge-token)" \
  http://10.0.0.112/health | jq .
# Expect: profilesReady includes "zorin".

# Inside the VM, journal for the bridge:
ssh -p 2223 -i ~/.ssh/code-server-newmini matt@127.0.0.1 \
  'sudo journalctl -u widget-bridge.service -n 50 --no-pager'
```

Trigger Zorin `/greet` clicks from claude-peers' PTT UI and watch the bridge response source flip from `agent` (when the primary MCP path is up) to `chatbot` (when the new widget-bridge path is exercised).

## Rollback

Two routes:

```bash
# Cleanest: roll back to the previous NixOS generation.
ssh nix 'sudo nixos-rebuild switch --rollback'

# Or: hand-edit the flake patch from Phase 2 back out, then rebuild.
ssh nix '
  cp /home/matt/nixos-config/flake.nix.bak.pre-haus-vm-* /home/matt/nixos-config/flake.nix
  sudo nixos-rebuild switch --flake /home/matt/nixos-config#nixos-host
'
```

Either route brings openclaw-vm back online and stops haus-vm.

## Follow-ups (deferred, separate commits)

- Replace `/etc/haus-vm/bridge.env` with a sops-nix-encrypted file in `nixos-config`.
- Wire `HERMES_MODE=cli` in haus-vm guest config; pin `hermes-agent` flake input to a rev sha.
- Move the Zorin MCP service from claude-peers' bridged-agent target (port 3113 → host 3103) into haus-vm so the MCP path is live, not still 502.
- Decide whether to delete the three disabled `openclaw-*` satellite unit definitions from `nixos-config/flake.nix` entirely.
- Decide whether `openclaw-gateway`, `openclaw-ssh-debug`, `openclaw-secrets-sync` should also be excised.
- CI: bun install + bun test + tsc in `infra/haus-vm/widget-bridge/` is already wired in `.github/workflows/haus-vm.yml`. Add a `nix flake check` step once a Nix-enabled runner is available.
