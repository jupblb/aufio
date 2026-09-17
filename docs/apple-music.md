# Optional read-only Apple Music history

The workspace MCP server `apple-music-history` runs `bin/applemusic_readonly.py`. It exposes exactly two tools: `recently_played_tracks` (1–50 account-level tracks, including non-library streams) and `heavy_rotation` (the first page of resources). Neither supplies a complete play log, timestamps, or per-song play counts.

It reuses [applemusic-mcp] for login and token storage, **not** that package’s general-purpose server. No library edits, playback, volume, browser control, or KA17 operations are exposed. History HTTP failures raise errors, even on later pages, rather than returning misleading empty or partial results. Authenticated requests do not follow redirects.

## Local installation

Run in this repository. The trial uses an isolated virtual environment outside Git, upstream version 0.20.1 at the revision below, and MCP SDK 1.30.0:

``` sh
mkdir -p "$HOME/.local/share/aufio/applemusic-mcp"
nix develop --command python3 -m venv "$HOME/.local/share/aufio/applemusic-mcp/venv"
"$HOME/.local/share/aufio/applemusic-mcp/venv/bin/python" -m pip install \
  'applemusic-mcp @ git+https://github.com/epheterson/applemusic-mcp.git@ca94ca2630cfd721ecf3ff008637c84ae60b0ea0' \
  'mcp==1.30.0'
amp mcp add apple-music-history --workspace -- \
  "$HOME/.local/share/aufio/applemusic-mcp/venv/bin/python" -B \
  "$PWD/bin/applemusic_readonly.py"
```

`.amp/settings.json` contains machine-specific paths, not credentials. Global Nix-managed Amp settings remain untouched. Approve the workspace MCP server in Amp and reload MCP connections after adding it. Moving the checkout requires updating the registered script path.

## Safari login requires your permission

1.  Sign in yourself at <https://music.apple.com> in Safari and leave the tab open.

2.  In Safari Settings → Advanced, enable **Show features for web developers**.

3.  In Safari’s Develop menu (or Developer settings, depending on version), enable **Allow JavaScript from Apple Events**. This is a broad browser automation permission, not a permission restricted to one cookie.

4.  Run the following command, or ask Amp to run it:

    ``` sh
    "$HOME/.local/share/aufio/applemusic-mcp/venv/bin/applemusic-mcp" login --safari
    ```

5.  After a successful capture, disable **Allow JavaScript from Apple Events** again. The two history tools use HTTP, not Safari, after login.

The upstream login captures a session token and obtains Apple’s public web-player developer token. This depends on Apple’s web implementation and can break or expire. On macOS the package stores tokens under `~/.config/applemusic-mcp` in owner-only files (0600, directory 0700), not Keychain. Never paste tokens or credentials into chat or Git. The bridge limits the exposed operations; it does not reduce the permissions of the underlying Apple session token. Requested music metadata enters the Amp conversation. No listening-history file is saved by the bridge, and no background monitoring is configured.

## Verify or disconnect

``` sh
"$HOME/.local/share/aufio/applemusic-mcp/venv/bin/python" -B test/applemusic_readonly_test.py -v
```

The tests mock credentials and HTTP; they never touch Music.app or the DAC. After login, request recent tracks and compare them with actual recent listening. An empty successful result is distinct from an authentication/API error.

To disconnect, remove only `apple-music-history` from `.amp/settings.json` and reload MCP connections. To also remove locally cached Apple Music credentials:

``` sh
"$HOME/.local/share/aufio/applemusic-mcp/venv/bin/applemusic-mcp" logout
```

Logout clears the package’s token copies; it does not sign Safari out or establish that Apple has revoked the session server-side. Use Apple’s own account controls if you also need session revocation.

  [applemusic-mcp]: https://github.com/epheterson/applemusic-mcp
