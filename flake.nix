{
  description = "aufio: local FiiO KA17 equalizer control";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "aarch64-darwin";
      pkgs = import nixpkgs { inherit system; };
      package = builtins.fromJSON (builtins.readFile ./package.json);
      appleMusic = import ./nix/apple-music.nix {
        inherit pkgs;
        inherit (pkgs) lib;
      };
      aufio = pkgs.buildNpmPackage {
        pname = package.name;
        version = package.version;
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./package-lock.json
            ./bin/aufio.mjs
            ./src
            ./test
            ./tsconfig.json
            ./THIRD_PARTY_NOTICES.md
          ];
        };

        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-Rcgf95YtAh/TR5JOt14eRCse/WWFM75fAAbNC9/RMd8=";
        # Use node-hid's bundled macOS binary, without node-gyp or downloads.
        npmFlags = [ "--ignore-scripts" ];
        dontNpmBuild = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          npm run check
          npm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --ignore-scripts --no-save
          # Only ship the native binary for the supported platform.
          find node_modules/node-hid/prebuilds -mindepth 1 -maxdepth 1 \
            ! -name HID-darwin-arm64 -exec rm -r {} +
          mkdir -p "$out/lib/aufio" "$out/bin"
          # Node refuses to strip TypeScript under a node_modules directory.
          cp -r package.json src node_modules THIRD_PARTY_NOTICES.md "$out/lib/aufio/"
          mkdir -p "$out/lib/aufio/bin"
          cp bin/aufio.mjs "$out/lib/aufio/bin/"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/aufio" \
            --add-flags "$out/lib/aufio/bin/aufio.mjs"
          runHook postInstall
        '';

        doInstallCheck = true;
        installCheckPhase = ''
          runHook preInstallCheck
          "$out/bin/aufio" --help
          # node-hid loads lazily; check the native addon without USB access.
          node -e "require('$out/lib/aufio/node_modules/node-hid/prebuilds/HID-darwin-arm64/node-napi-v4.node')"
          runHook postInstallCheck
        '';

        meta = {
          description = package.description;
          mainProgram = "aufio";
          platforms = [ system ];
        };
      };
      packages = {
        inherit aufio;
        inherit (appleMusic) applemusic-mcp apple-music-history;
        default = aufio;
      };
    in
    {
      packages.${system} = packages;
      apps.${system} = pkgs.lib.mapAttrs (_: pkg: {
        type = "app";
        program = pkgs.lib.getExe pkg;
        meta.description = pkg.meta.description;
      }) packages;
      checks.${system} = {
        default = aufio;
        inherit (appleMusic) applemusic-mcp apple-music-history;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          typescript
          prettier
          git
          curl
          # node-hid normally uses its bundled macOS binary. Keep the native
          # build toolchain available as well for node-gyp's fallback.
          python3
          pkg-config
          clang
          gnumake
        ];
        shellHook = ''
          export PATH="$PWD/node_modules/.bin:$PATH"
        '';
      };
    };
}
