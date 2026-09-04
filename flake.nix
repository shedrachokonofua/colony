{
  description = "Colony dev shell (Bun, OpenTofu, Kubernetes, GitLab CLI)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    # Bun rides unstable: the 25.11 bun (1.3.3) predates Bun.JSONL and has
    # divergent fake-timer APIs; local machines run 1.3.14+, and every
    # "green locally, red in CI" incident on 2026-08-31/09-01 was this gap.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Single source of the pinned bun/node strings, shared with the
        # Dockerfiles: bump the version in colony-versions.json and every
        # consumer (this shell, both images) follows.
        versions = builtins.fromJSON (builtins.readFile ./colony-versions.json);
        # bun: full version (oven/bun image tags are tag-compatible with it);
        # node: image tags exist per major only, so strip the leading v and
        # take the digits before the first dot (e.g. v24.20.0 -> 24).
        bunVersion = versions.bun;
        nodeMajor = builtins.elemAt (builtins.match "v?([0-9]+).*" versions.node) 0;
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        bun = (import nixpkgs-unstable { inherit system; }).bun;
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

        # bun (nixpkgs-unstable) and nodejs_24 (stable) track
        # colony-versions.json: the JSON pins the strings, the package sets
        # provide the runtimes. nodejs_24 is the build for that node major.
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
            # bun = nixpkgs-unstable (the stable pin is too old); nodejs_24
            # tracks the major pinned in colony-versions.json.
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
            echo "Colony dev shell: bun ${bunVersion} (nixpkgs-unstable), node ${nodeMajor} (colony-versions.json pins ${versions.node})"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
