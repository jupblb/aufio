{
  description = "aufio: local FiiO KA17 equalizer control";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "aarch64-darwin";
      pkgs = import nixpkgs { inherit system; };
    in {
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
