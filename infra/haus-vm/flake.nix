{
  description = "haus.matthewstevens.org: Hermes-backed widget bridge VM image and microvm module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";

    # MicroVM framework. The deployment target nix.matthewstevens.org
    # already runs microvm.nix for openclaw-vm, so we follow the same
    # pattern for haus-vm. The host's flake imports nixosModules.default
    # from this flake and gets a port-compatible drop-in replacement.
    microvm.url = "github:astro/microvm.nix";
    microvm.inputs.nixpkgs.follows = "nixpkgs";

    # The upstream Hermes Agent already ships a flake; we consume its package.
    # Used by the OCI image output and by the future cli-mode Hermes wiring
    # inside the microvm. Pinned to a sha once that wiring is exercised.
    hermes-agent = {
      url = "github:NousResearch/hermes-agent";
      flake = true;
    };
  };

  # Cross-compile target follows the Sanmarcsoft Cross-Compile Law:
  # dev hosts are aarch64-darwin (Apple Silicon) and aarch64-linux (Linux ARM),
  # production target is x86_64-linux. OCI image MUST be produced for x86_64-linux.
  # The microvm module is consumed by the host's nixosConfigurations, which
  # already commits to x86_64-linux.
  outputs =
    { self
    , nixpkgs
    , flake-utils
    , microvm
    , hermes-agent
    }:
    let
      # Build hosts we support invoking `nix build` FROM.
      buildHosts = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      # Target the image runs ON. Single target by SOP.
      targetSystem = "x86_64-linux";

      # widget-bridge source tree, filtered. This is the canonical source
      # consumed by both the OCI image and the microvm systemd unit. Stripped
      # of node_modules and dist so neither artefact pulls in unvetted files.
      widgetBridgeSrcGen = pkgs: pkgs.runCommand "widget-bridge-src" { } ''
        mkdir -p $out
        cp -r ${./widget-bridge}/. $out/
        rm -rf $out/node_modules $out/dist
      '';

      # Internal port the widget-bridge binds inside the VM. Match the
      # openclaw-vm guest port (19100) so caddy's existing
      # /api/* upstream at 127.0.0.1:19101 keeps reaching the chat
      # service across the cutover. No caddy change required.
      internalWidgetPort = 19100;

      # Host port → VM port mapping. This MATCHES the openclaw-vm hostfwd
      # surface byte for byte, so haus-vm is a true drop-in replacement.
      # Ports we do not implement yet (gateway 18789/18790, MCP 3103/3203)
      # are still forwarded into the VM and will 502 the same way they do
      # today, until services are bound inside the VM in a follow-up.
      hausHostforwards = [
        # SSH into the VM for ops, mirrors openclaw-vm:2223.
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 2223;  guest.address = ""; guest.port = 22;    }
        # Gateway, currently inactive. Reserved for future haus-vm services.
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 18789; guest.address = ""; guest.port = 18789; }
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 18790; guest.address = ""; guest.port = 18790; }
        # Widget chat. Caddy on the host already routes
        # /api/* → 127.0.0.1:19101, which lands here as VM port 19100.
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 19101; guest.address = ""; guest.port = internalWidgetPort; }
        # Zorin MCP. claude-peers' systemd zorin-port-relay terminates at
        # 10.0.0.112:3113 and forwards into here as VM port 3103. The MCP
        # service inside haus-vm is a follow-up; the hostfwd is reserved
        # now so claude-peers does not have to change at cutover.
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 3103;  guest.address = ""; guest.port = 3103;  }
        { proto = "tcp"; from = "host"; host.address = "127.0.0.1"; host.port = 3203;  guest.address = ""; guest.port = 3103;  }
      ];
    in
    # Per-build-host outputs: the OCI image (kept for sovereign-registry path)
    # and the devshell. The microvm module sits outside this loop because it
    # binds to a specific target system (x86_64-linux) and is consumed by a
    # host nixosConfigurations.
    (flake-utils.lib.eachSystem buildHosts (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsTarget = import nixpkgs {
          inherit system;
          crossSystem = { config = "x86_64-unknown-linux-gnu"; };
        };
        widgetBridgeSrc = widgetBridgeSrcGen pkgs;

        entrypoint = pkgs.writeShellScript "haus-vm-entrypoint" ''
          #!${pkgsTarget.bash}/bin/bash
          set -euo pipefail
          export PATH="${pkgsTarget.bun}/bin:${pkgsTarget.coreutils}/bin:$PATH"
          cd /app/widget-bridge
          exec bun src/server.ts
        '';

        ociImage = pkgsTarget.dockerTools.buildLayeredImage {
          name = "haus-vm";
          tag = "scaffold";
          contents = with pkgsTarget; [
            bash
            bun
            cacert
            coreutils
          ];
          extraCommands = ''
            mkdir -p app
            cp -r ${widgetBridgeSrc} app/widget-bridge
            chmod -R u+rwX,go+rX app
            mkdir -p etc
            echo "haus:x:1000:1000:haus-vm:/app:/sbin/nologin" > etc/passwd
            echo "haus:x:1000:" > etc/group
          '';
          config = {
            Entrypoint = [ "${entrypoint}" ];
            User = "1000:1000";
            Env = [
              "PORT=8080"
              "HOST=127.0.0.1"
              "NODE_ENV=production"
              "HERMES_MODE=stub"
            ];
            ExposedPorts = { "8080/tcp" = { }; };
            WorkingDir = "/app/widget-bridge";
            Labels = {
              "org.opencontainers.image.title" = "haus-vm";
              "org.opencontainers.image.source" = "https://github.com/Sanmarcsoft/resonantos-vnext";
              "org.opencontainers.image.description" = "Hermes-backed widget bridge for haus.matthewstevens.org";
              "org.opencontainers.image.licenses" = "Symbiotic-License-2.0";
            };
          };
        };
      in
      {
        packages = {
          oci-image = ociImage;
          default = ociImage;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_20
            skopeo
          ];
          shellHook = ''
            echo "haus-vm devshell. Bun $(bun --version)"
            echo "  build OCI:    nix build .#packages.${system}.oci-image"
            echo "  build microvm: nix build .#nixosConfigurations.haus-vm.config.microvm.declaredRunner"
          '';
        };
      }
    )) // {
      # --- microvm module -----------------------------------------------------
      #
      # The host (nix.matthewstevens.org) imports `nixosModules.default` from
      # this flake. That module declares one microvm, `haus-vm`, that takes
      # over the hostfwd surface previously owned by openclaw-vm. The host
      # config disables openclaw-vm and adds this module in the same rebuild.
      #
      # Pattern follows microvm.nix's declarative `microvm.vms.<name>` route,
      # which auto-wires the systemd service on the host side. We also expose
      # a complete `nixosConfigurations.haus-vm` so the guest can be built and
      # inspected standalone via `nix flake check` and friends.

      nixosModules.default = { config, lib, pkgs, ... }: {
        imports = [ microvm.nixosModules.host ];

        microvm.vms.haus-vm = {
          # Fully-declarative VM. microvm.nix does not accept both
          # `flake` and `config` here; we supply the guest config inline.
          config = (import ./microvm-config.nix) {
            inherit lib pkgs microvm internalWidgetPort hausHostforwards;
            widgetBridgeSrc = widgetBridgeSrcGen pkgs;
          };
        };
      };

      # The guest, available standalone for validation:
      #   nix build .#nixosConfigurations.haus-vm.config.system.build.toplevel
      #   nix run   .#nixosConfigurations.haus-vm.config.microvm.declaredRunner
      nixosConfigurations.haus-vm = nixpkgs.lib.nixosSystem {
        system = targetSystem;
        modules = [
          microvm.nixosModules.microvm
          ((import ./microvm-config.nix) {
            lib = nixpkgs.lib;
            pkgs = import nixpkgs { system = targetSystem; };
            inherit microvm internalWidgetPort hausHostforwards;
            widgetBridgeSrc = widgetBridgeSrcGen (import nixpkgs { system = targetSystem; });
          })
        ];
      };
    };
}
