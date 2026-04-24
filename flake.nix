{
  description = "Colony dev shell (Node, Temporal, Postgres, Kubernetes, GitLab CLI)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "colony";

          packages = with pkgs; [
            # Node / JS — active LTS
            nodejs_24

            # Temporal
            temporal-cli

            # Datastores / SQL
            postgresql_16

            # Kubernetes client tooling for Aether interaction
            # (no local cluster — Kubernetes validation happens on Aether, see ADR-004)
            kubectl
            kubernetes-helm
            k9s

            # GitLab
            glab

            # Formatting / lint parity with npm scripts
            nodePackages.prettier
            actionlint

            # Container tooling (matches CI / Aether runner assumptions)
            buildah
            podman
            # Compose v2 (standalone binary; `docker compose` / `docker-compose` both work)
            docker-compose

            git
          ];

          shellHook = ''
            echo "Colony dev shell: node $(node --version), npm $(npm --version)"
            if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
              echo ""
              echo "WARN: neither docker nor podman is on PATH. The dev stack expects one of them"
              echo "      to run docker-compose.yml (Temporal + Postgres). See docs/dev-loop.md."
            fi
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
