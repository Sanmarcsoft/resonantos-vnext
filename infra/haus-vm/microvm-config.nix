{ lib, pkgs, microvm, internalWidgetPort, hausHostforwards, widgetBridgeSrc, ... }:
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

    # No virtiofs shares: the widget-bridge is fully self-contained in
    # /nix/store. The image is reproducible from flake.lock alone.
    shares = [ ];
  };

  # Allow the widget-bridge to receive traffic inside the VM. Hostfwd
  # delivers loopback-localized traffic to this port.
  networking.firewall.allowedTCPPorts = [ internalWidgetPort ];

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
        "HERMES_MODE=stub"
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
  # The ops principal inside the VM, key-only.
  users.users.haus.openssh.authorizedKeys.keys = [ ];

  # Inert system: no x11, no docs, no man pages.
  documentation.enable = false;
}
