{
  description = "Colony dev shell (Bun, OpenTofu, Kubernetes, GitLab CLI)";

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
            # Bun runs colonyd and its tests; the agent runtime SDK ships Bun-native
            # TypeScript. Node stays for tooling that still shells out to it.
            bun
            nodejs_24
            sqlite

            kubectl
            kubernetes-helm
            k9s
            opentofu

            glab

            sops
            openbao

            go-task

            jq

            nodePackages.prettier
            actionlint

            buildah
            podman
            git
          ];

          shellHook = ''
            echo "Colony dev shell: bun $(bun --version), node $(node --version)"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
