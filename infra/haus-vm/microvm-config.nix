{ lib, pkgs, microvm, internalWidgetPort, internalMcpPort, hausHostforwards, widgetBridgeSrc, zorinMcpSrc, ... }:
let
  # Internal path the widget-bridge runs from inside the VM. Sourced from
  # /nix/store, so the guest filesystem holds no mutable copy.
  widgetBridgeRoot = "${widgetBridgeSrc}";

  # Bring the widget-bridge launcher up under a non-root user. Bun resolves
  # the TS sources at boot; no node_modules in the closure, since the
  # production runtime only uses Bun's built-in types.
  widgetBridgeLauncher = pkgs.writeShellScript "widget-bridge-launch" ''
    set -euo pipefail
    exec ${pkgs.bun}/bin/bun ${widgetBridgeRoot}/src/server.ts
  '';

  # zorin-mcp: the MCP front the claude-peers bridge talks to (guest :3103,
  # reached via nix's zorin-port-relay at 10.0.0.112:3113). RECONSTRUCTED
  # 2026-06-11 from the gen-103 guest closure after a repo↔snapshot drift
  # erased it from a rebuild and silenced Zorin (claude-peers-mcp#93).
  # This file is the ONLY source of truth now — do not let the deployed
  # snapshot drift again.
  zorinMcpLauncher = pkgs.writeShellScript "zorin-mcp-launch" ''
    set -euo pipefail
    exec ${pkgs.bun}/bin/bun ${zorinMcpSrc}/src/server.ts
  '';
in
{
  # microvm.nix wires this NixOS config as a guest. The host module declares
  # `microvm.vms.haus-vm` and passes this config in.
  imports = [ microvm.nixosModules.microvm ];

  networking.hostName = "haus-vm";
  system.stateVersion = "25.05";

  # Modest profile. The widget-bridge is a single Bun process that proxies
  # a chat turn into Hermes (stub today). 512 MiB is generous for that
  # workload; bump only when the Hermes CLI lands and may want a bigger heap.
  microvm = {
    hypervisor = "qemu";
    mem = 512;
    vcpu = 1;

    interfaces = [{
      type = "user";
      id = "vmnet0";
      # Distinct from openclaw-vm (02:00:00:00:00:01) so both can run if
      # the operator wants overlap during validation.
      mac = "02:00:00:00:00:02";
    }];

    # Hostforwards passed in from the host module; the table lives in
    # flake.nix as the single source of truth for the wire surface.
    forwardPorts = hausHostforwards;

    # One virtiofs share: the host-managed bridge env file at
    # /etc/haus-vm/bridge.env. Holding BRIDGE_TOKEN out of the nix
    # store and out of the guest image means the secret can rotate
    # without a rebuild; the host file is root-owned 0600 and the
    # guest's systemd (PID 1) reads it before dropping to the haus
    # user. Migration to sops-nix in-guest is a follow-up.
    shares = [{
      proto = "virtiofs";
      tag = "haus-secrets";
      source = "/etc/haus-vm";
      mountPoint = "/etc/haus-vm";
    }];
  };

  # Mount the shared bridge env directory at boot. fileSystems entries
  # are required so the guest knows what to mount the virtiofs tag at.
  fileSystems."/etc/haus-vm" = {
    device = "haus-secrets";
    fsType = "virtiofs";
    options = [ "ro" ];
  };

  # Allow the widget-bridge to receive traffic inside the VM. Hostfwd
  # delivers loopback-localized traffic to this port.
  networking.firewall.allowedTCPPorts = [ internalWidgetPort internalMcpPort ];

  # Non-root execution principal for the bridge process.
  users.users.haus = {
    isSystemUser = true;
    group = "haus";
    home = "/var/lib/haus";
    createHome = true;
  };
  users.groups.haus = { };

  # widget-bridge as a hardened systemd service. Reads BRIDGE_TOKEN from
  # an env file; if the file is missing or empty, the service exits at
  # startup because NODE_ENV=production trips assertBootSafety().
  systemd.services.widget-bridge = {
    description = "Hermes-backed widget bridge for haus.matthewstevens.org";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      User = "haus";
      Group = "haus";
      Restart = "on-failure";
      RestartSec = "2s";
      # `-` prefix: optional. The service still attempts to start without
      # it, then exits cleanly via assertBootSafety so logs surface the
      # missing-token cause rather than failing silently.
      EnvironmentFile = "-/etc/haus-vm/bridge.env";
      Environment = [
        "PORT=${toString internalWidgetPort}"
        "HOST=0.0.0.0"
        "NODE_ENV=production"
        # Stage 1 (pre-Hermes): real LLM via OpenAI-compatible
        # /chat/completions, Zorin system prompt baked in the client.
        # Required provider env (HERMES_PROVIDER_URL, HERMES_PROVIDER_KEY,
        # HERMES_MODEL) is read from /etc/haus-vm/bridge.env via the
        # EnvironmentFile above. If HERMES_PROVIDER_KEY is empty the
        # client returns a structured runtime-error per turn; it does
        # NOT block startup, so the service stays up while the operator
        # provisions the key.
        "HERMES_MODE=cli"
        "ALLOWED_HOSTS=haus.matthewstevens.org,localhost,127.0.0.1,10.0.0.112"
      ];
      ExecStart = "${widgetBridgeLauncher}";
      ProtectSystem = "strict";
      ProtectHome = "tmpfs";
      PrivateTmp = true;
      NoNewPrivileges = true;
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      RestrictSUIDSGID = true;
      MemoryDenyWriteExecute = true;
      LockPersonality = true;
      SystemCallArchitectures = "native";
    };
  };

  # zorin-mcp service — reconstructed verbatim from the gen-103 guest unit
  # (see launcher note above). Same hardening profile as widget-bridge.
  systemd.services.zorin-mcp = {
    description = "Zorin MCP front for claude-peers bridge";
    wantedBy = [ "multi-user.target" ];
    wants = [ "widget-bridge.service" ];
    after = [ "network.target" "widget-bridge.service" ];
    serviceConfig = {
      User = "haus";
      Group = "haus";
      Restart = "on-failure";
      RestartSec = "2s";
      EnvironmentFile = "-/etc/haus-vm/bridge.env";
      Environment = [
        "MCP_PORT=${toString internalMcpPort}"
        "HOST=0.0.0.0"
        "NODE_ENV=production"
        "WIDGET_URL=http://127.0.0.1:${toString internalWidgetPort}"
      ];
      ExecStart = "${zorinMcpLauncher}";
      ProtectSystem = "strict";
      ProtectHome = "tmpfs";
      PrivateTmp = true;
      NoNewPrivileges = true;
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      RestrictSUIDSGID = true;
      MemoryDenyWriteExecute = true;
      LockPersonality = true;
      SystemCallArchitectures = "native";
    };
  };

  # Bun on the guest PATH for ops convenience (curl-style debugging via
  # ssh into the VM at host:2223).
  environment.systemPackages = [ pkgs.bun pkgs.curl ];

  # Open SSH inside the VM so operators can shell in for debugging.
  # Matches the openclaw-vm hostfwd pattern (host:2223 → guest:22).
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };
  # The ops principal inside the VM, key-only. Provisioned 2026-06-11
  # (claude-peers-mcp#93): the previously-empty key list meant nobody could
  # shell in to diagnose the Zorin provider timeouts — every probe bounced
  # off the hull while the widget 504'd.
  users.users.ops = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEmZURnPm1n6rW26/YRgm36xapFb9Xrtk/5JZQqXFlI code-server@newmini"
    ];
  };
  users.users.haus.openssh.authorizedKeys.keys = [ ];

  # Inert system: no x11, no docs, no man pages.
  documentation.enable = false;
}
