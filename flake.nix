{
  description = "Colony dev shell (Node, Temporal, Postgres, Kubernetes, GitLab CLI)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
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
            # Node / JS
            nodejs_22

            # Temporal
            temporal-cli

            # Datastores / SQL
            postgresql_16

            # Kubernetes local + remote
            kubectl
            kind
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

            git
          ];

          shellHook = ''
            echo "Colony dev shell: node $(node --version), npm $(npm --version)"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
