# Optional read-only Apple Music history

The workspace MCP server `apple-music-history` runs `bin/applemusic_readonly.py`. It exposes exactly two tools: `recently_played_tracks` (1–50 account-level tracks, including non-library streams) and `heavy_rotation` (the first page of resources). Neither supplies a complete play log, timestamps, or per-song play counts.

It reuses [applemusic-mcp] for login and token storage, **not** that package’s general-purpose server. No library edits, playback, volume, browser control, or KA17 operations are exposed. History HTTP failures raise errors, even on later pages, rather than returning misleading empty or partial results. Authenticated requests do not follow redirects.

## Run with Nix

On Apple Silicon macOS, the flake provides two separate packages and apps:

| Output | Purpose |
| --- | --- |
| `applemusic-mcp` | Upstream CLI, including Safari login and logout. Its `serve` command exposes broader controls; do not register it as the history server. |
| `apple-music-history` | Our restricted two-tool stdio MCP server. This is the output to register with Amp. |

Upstream version 0.20.1 is pinned to [this revision](https://github.com/epheterson/applemusic-mcp/commit/ca94ca2630cfd721ecf3ff008637c84ae60b0ea0). Python and its dependencies come from the locked nixpkgs input; no pip installation or virtual environment is needed.

Run from this repository:

``` sh
nix run .#applemusic-mcp -- --help
nix build .#applemusic-mcp .#apple-music-history --no-link
```

To register the packaged history server with Amp:

``` sh
amp mcp add apple-music-history --workspace -- \
  nix run --no-write-lock-file "$PWD#apple-music-history" --
```

If `apple-music-history` is already registered with the old virtual-environment command, replace that entry rather than adding a second server. Existing credentials in `~/.config/applemusic-mcp` work with either installation; packaging does not require logging in again. The flake does not change your current MCP registration or delete the old virtual environment.

`.amp/settings.json` contains the checkout path, not credentials. Keep global Nix-managed Amp settings untouched. Approve the workspace MCP server in Amp and reload MCP connections after changing it. Moving the checkout requires updating the registered flake path. The history app speaks MCP over stdin/stdout; it is not an interactive command-line history viewer.

## Safari login requires your permission

1.  Sign in yourself at <https://music.apple.com> in Safari and leave the tab open.

2.  In Safari Settings → Advanced, enable **Show features for web developers**.

3.  In Safari’s Develop menu (or Developer settings, depending on version), enable **Allow JavaScript from Apple Events**. This is a broad browser automation permission, not a permission restricted to one cookie.

4.  Run the following command, or ask Amp to run it:

    ``` sh
    nix run .#applemusic-mcp -- login --safari
    ```

5.  After a successful capture, disable **Allow JavaScript from Apple Events** again. The two history tools use HTTP, not Safari, after login.

The upstream login captures a session token and obtains Apple’s public web-player developer token. This depends on Apple’s web implementation and can break or expire. On macOS the package stores tokens under `~/.config/applemusic-mcp` in owner-only files (0600, directory 0700), not Keychain. Never paste tokens or credentials into chat or Git. The bridge limits the exposed operations; it does not reduce the permissions of the underlying Apple session token. Requested music metadata enters the Amp conversation. No listening-history file is saved by the bridge, and no background monitoring is configured.

## Verify or disconnect

``` sh
nix flake check
```

The Apple Music derivations check upstream imports/help, run all seven bridge tests with mocked credentials and HTTP, and initialize the installed stdio server to verify its two read-only tools. These checks never touch Music.app, Safari, real credentials, or the DAC. Upstream's pytest suite is deliberately not run because its cleanup fixture can modify Music.app playlists. After login, request recent tracks and compare them with actual recent listening. An empty successful result is distinct from an authentication/API error.

To disconnect, remove only `apple-music-history` from `.amp/settings.json` and reload MCP connections. To also remove locally cached Apple Music credentials:

``` sh
nix run .#applemusic-mcp -- logout
```

Logout clears the package’s token copies; it does not sign Safari out or establish that Apple has revoked the session server-side. Use Apple’s own account controls if you also need session revocation.

  [applemusic-mcp]: https://github.com/epheterson/applemusic-mcp
