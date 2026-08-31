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
        # Chromium dies with a Skia fontconfig FATAL ("SkFontMgr_FontConfigInterface:
        # Not implemented") the moment a page loads a webfont in an environment
        # with no fonts.conf - which is exactly what CI containers are. A minimal
        # fontconfig pointing at real font files keeps the browser alive; the
        # Playwright e2e suite depends on it.
        fontsConf = pkgs.makeFontsConf {
          fontDirectories = [ pkgs.dejavu_fonts pkgs.liberation_ttf ];
        };
        # validate/unit CI jobs: everything else in the default shell
        # (chromium, ffmpeg, GTK, podman) is closure weight those jobs
        # download and never run.
        ciPackages = with pkgs; [
          bun
          nodejs_24
          git
        ];
      in
      {
        devShells.ci = pkgs.mkShell {
          name = "colony-ci";
          packages = ciPackages;
        };

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

            chromium
            fontconfig

            buildah
            podman
            git
          ];

          FONTCONFIG_FILE = fontsConf;

          shellHook = ''
            echo "Colony dev shell: bun $(bun --version), node $(node --version)"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
