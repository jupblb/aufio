"""Restricted Apple Music MCP: account history only, using applemusic-mcp login.

See docs/apple-music.md. Never run the upstream general-purpose server here:
its tools include library writes, playback, volume, and browser control.
"""

from typing import Annotated

import requests
from applemusic_mcp.auth import get_user_token, resolve_developer_token
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

mcp = FastMCP("Apple Music History (read-only)")
READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True
)


def _headers() -> dict:
    try:
        # Check local login before trying to fetch Apple's public developer token.
        user_token = get_user_token()
        developer_token = resolve_developer_token()
    except Exception:
        # Credential/parser exceptions must not expose token contents to MCP.
        raise RuntimeError(
            "Apple Music authentication unavailable. Complete the local Safari login; "
            "do not paste credentials into chat."
        ) from None
    return {
        "Authorization": f"Bearer {developer_token}",
        "Music-User-Token": user_token,
        "Origin": "https://music.apple.com",
    }


def _get(endpoint: str, headers: dict, params: dict | None = None) -> dict:
    try:
        response = requests.get(
            f"https://api.music.apple.com/v1/me/{endpoint}",
            headers=headers,
            params=params,
            timeout=20,
            # Requests does not strip Music-User-Token on cross-host redirects.
            allow_redirects=False,
        )
    except requests.RequestException:
        raise RuntimeError("Apple Music request failed; no history result was returned.") from None
    if response.status_code != 200:
        # Do not reproduce upstream's silent empty/partial result on HTTP failure.
        # Never include response bodies or request headers in an error.
        raise RuntimeError(
            f"Apple Music returned HTTP {response.status_code}; "
            "this is an error, not empty listening history."
        )
    try:
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise ValueError
    except ValueError:
        raise RuntimeError("Apple Music returned an invalid history response.") from None
    return data


def _summarize(items: list) -> list[dict]:
    # Only the metadata needed to pick audition tracks, not the entire response.
    return [
        {
            "id": item.get("id"),
            "type": item.get("type"),
            "name": item.get("attributes", {}).get("name"),
            "artist": item.get("attributes", {}).get("artistName"),
            "album": item.get("attributes", {}).get("albumName"),
            "genres": item.get("attributes", {}).get("genreNames", []),
        }
        for item in items
    ]


@mcp.tool(annotations=READ_ONLY)
def recently_played_tracks(limit: Annotated[int, Field(ge=1, le=50)] = 25) -> dict:
    """Read up to 50 recent account-level tracks, including non-library streams.

    Preserves Apple's order. Not a complete event log; no play counts or dates.
    An API/authentication failure raises an error, including on a later page.
    """
    headers = _headers()
    items = []
    while len(items) < limit:
        data = _get(
            "recent/played/tracks",
            headers,
            {
                "types": "songs,library-songs",
                "limit": min(10, limit - len(items)),
                "offset": len(items),
            },
        )
        batch = data["data"]
        items.extend(batch[: limit - len(items)])
        if not batch or not data.get("next"):
            break
    return {
        "tracks": _summarize(items),
        "returned": len(items),
        "coverage": "Recent account-level tracks, not a complete log or play-count ranking.",
    }


@mcp.tool(annotations=READ_ONLY)
def heavy_rotation() -> dict:
    """Read Apple's first page of heavy-rotation resources, often albums/playlists.

    These are recommendations based on listening, not per-song play counts.
    """
    data = _get("history/heavy-rotation", _headers())
    return {
        "items": _summarize(data["data"]),
        "hasMore": bool(data.get("next")),
        "coverage": "First page of heavy rotation; no play counts or listening timestamps.",
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
