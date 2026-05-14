{
  description = "haus.matthewstevens.org: Hermes-backed widget bridge VM image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
    # The upstream Hermes Agent already ships a flake; we consume its package.
    hermes-agent = {
      url = "github:NousResearch/hermes-agent";
      # We deliberately do NOT follow nixpkgs here: Hermes pins its own runtime.
      flake = true;
    };
  };

  # Cross-compile target follows the Sanmarcsoft Cross-Compile Law:
  # dev hosts are aarch64-darwin (Apple Silicon) and aarch64-linux (Linux ARM),
  # production target is x86_64-linux. OCI image MUST be produced for x86_64-linux.
  outputs =
    { self
    , nixpkgs
    , flake-utils
    , hermes-agent
    }:
    let
      # Build hosts we support invoking `nix build` FROM.
      buildHosts = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      # Target the image runs ON. Single target by SOP.
      targetSystem = "x86_64-linux";
    in
    flake-utils.lib.eachSystem buildHosts (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsTarget = import nixpkgs {
          inherit system;
          crossSystem = { config = "x86_64-unknown-linux-gnu"; };
        };

        # widget-bridge is a Bun TypeScript service. We install Bun into the image
        # and copy the source tree; the entrypoint runs `bun src/server.ts`.
        # Filter out node_modules and dist so the OCI image never ships
        # unvetted artefacts; Bun resolves at boot from the committed lockfile.
        widgetBridgeSrc = pkgs.runCommand "widget-bridge-src" { } ''
          mkdir -p $out
          cp -r ${./widget-bridge}/. $out/
          rm -rf $out/node_modules $out/dist
        '';

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
            # hermes-agent.packages.${targetSystem}.default
            # ^ Wire this in once we confirm the upstream attribute name.
            # For 0.1.0 scaffold the stub client does not need Hermes installed.
          ];
          extraCommands = ''
            mkdir -p app
            cp -r ${widgetBridgeSrc} app/widget-bridge
            chmod -R u+rwX,go+rX app
            # Minimal /etc/passwd and /etc/group so the numeric User
            # below resolves to a name when downstream tools consult them.
            mkdir -p etc
            echo "haus:x:1000:1000:haus-vm:/app:/sbin/nologin" > etc/passwd
            echo "haus:x:1000:" > etc/group
          '';
          config = {
            Entrypoint = [ "${entrypoint}" ];
            # Non-root execution. The container does not need root for any
            # operation: the bridge binds an unprivileged port and reads
            # only from /app/widget-bridge.
            User = "1000:1000";
            Env = [
              "PORT=8080"
              # Default to loopback inside the container: production sits
              # behind a reverse proxy (Caddy/Traefik or Scaleway LB), which
              # is the only path that should reach the bridge. Override to
              # 0.0.0.0 only when no proxy fronts the container.
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
        # `nix build .#packages.<buildHost>.oci-image` always produces an
        # x86_64-linux image, regardless of the host you build from.
        packages = {
          oci-image = ociImage;
          default = ociImage;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_20
            skopeo
            # Pulumi is installed separately via the workstation toolchain;
            # not pinned here to avoid pulling the closure into every dev shell.
          ];
          shellHook = ''
            echo "haus-vm devshell. Bun $(bun --version)"
            echo "  build OCI:   nix build .#packages.${system}.oci-image"
            echo "  push (SOP):  skopeo copy docker-archive:./result \\"
            echo "                   docker://rg.fr-par.scw.cloud/sanmarcsoft/haus-vm:testing"
          '';
        };
      }
    );
}
