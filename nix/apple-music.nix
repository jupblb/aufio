{ lib, pkgs }:
let
  pythonPackages = pkgs.python3Packages;
  applemusic-mcp = pythonPackages.buildPythonPackage {
    pname = "applemusic-mcp";
    version = "0.20.1";
    pyproject = true;

    src = pkgs.fetchFromGitHub {
      owner = "epheterson";
      repo = "applemusic-mcp";
      rev = "ca94ca2630cfd721ecf3ff008637c84ae60b0ea0";
      hash = "sha256-T956sblq/4TrAXkY4cwIFDPW6a2bjzyeyRyejYB4ARc=";
    };

    build-system = [ pythonPackages.hatchling ];
    dependencies = with pythonPackages; [
      mcp
      pyjwt
      requests
      cryptography
      keyring
      pyobjc-framework-Quartz
    ];
    # Safari login uses the host's osascript; it is not a Nix dependency.
    makeWrapperArgs = [ "--suffix PATH : /usr/bin" ];

    # Upstream's autouse pytest fixture mutates Music.app playlists on macOS.
    # Use import/help checks here and the bridge's offline tests below instead.
    doCheck = true;
    pythonImportsCheck = [
      "applemusic_mcp.auth"
      "applemusic_mcp.cli"
      "applemusic_mcp.safari"
    ];
    installCheckPhase = ''
      runHook preInstallCheck
      "$out/bin/applemusic-mcp" --help
      "$out/bin/applemusic-mcp" login --help
      runHook postInstallCheck
    '';

    meta = {
      description = "Apple Music CLI and MCP server (including Safari login)";
      homepage = "https://github.com/epheterson/applemusic-mcp";
      license = lib.licenses.mit;
      mainProgram = "applemusic-mcp";
      platforms = [ "aarch64-darwin" ];
    };
  };
  python = pkgs.python3.withPackages (ps: [
    applemusic-mcp
    ps.mcp
    ps.requests
    ps.pydantic
  ]);
  apple-music-history = pkgs.stdenvNoCC.mkDerivation {
    pname = "apple-music-history";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../bin/applemusic_readonly.py
        ../test/applemusic_readonly_test.py
      ];
    };

    nativeBuildInputs = [ pkgs.makeWrapper ];
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      ${python}/bin/python -B test/applemusic_readonly_test.py -v
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      install -Dm644 bin/applemusic_readonly.py "$out/libexec/applemusic_readonly.py"
      makeWrapper ${python}/bin/python "$out/bin/apple-music-history" \
        --add-flags "-B $out/libexec/applemusic_readonly.py"
      runHook postInstall
    '';

    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      # Exercise the installed stdio server, without credentials or API calls.
      ${python}/bin/python - <<'PY'
      import asyncio
      import os
      from mcp import ClientSession, StdioServerParameters
      from mcp.client.stdio import stdio_client

      async def check():
          params = StdioServerParameters(command=os.environ["out"] + "/bin/apple-music-history")
          async with stdio_client(params) as (reader, writer):
              async with ClientSession(reader, writer) as client:
                  await client.initialize()
                  tools = (await client.list_tools()).tools
                  assert {tool.name for tool in tools} == {"recently_played_tracks", "heavy_rotation"}
                  assert all(tool.annotations.readOnlyHint for tool in tools)

      asyncio.run(asyncio.wait_for(check(), timeout=15))
      PY
      runHook postInstallCheck
    '';

    meta = {
      description = "Read-only Apple Music listening-history MCP server";
      mainProgram = "apple-music-history";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  inherit applemusic-mcp apple-music-history;
}
