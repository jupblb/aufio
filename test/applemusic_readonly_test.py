"""Offline tests: no credentials, browser, Music.app, or network access."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import applemusic_readonly as server


def response(status=200, data=None):
    return Mock(status_code=status, json=Mock(return_value=data))


def song(number):
    return {
        "id": str(number),
        "type": "songs",
        "attributes": {
            "name": f"Song {number}",
            "artistName": "Artist",
            "albumName": "Album",
            "genreNames": ["Pop"],
            "unneededPrivateField": "must not be returned",
        },
    }


class ReadOnlyTests(unittest.TestCase):
    def setUp(self):
        for name, value in [
            ("get_user_token", "test-user-token"),
            ("resolve_developer_token", "test-developer-token"),
        ]:
            mock = patch.object(server, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(server.requests, "get")
        self.get = mock.start()
        self.addCleanup(mock.stop)

    def test_only_two_read_only_tools_and_no_resources_or_prompts(self):
        tools = asyncio.run(server.mcp.list_tools())
        self.assertEqual({t.name for t in tools}, {"recently_played_tracks", "heavy_rotation"})
        for tool in tools:
            self.assertTrue(tool.annotations.readOnlyHint)
            self.assertFalse(tool.annotations.destructiveHint)
        recent = next(t for t in tools if t.name == "recently_played_tracks")
        self.assertEqual(recent.inputSchema["properties"]["limit"]["minimum"], 1)
        self.assertEqual(recent.inputSchema["properties"]["limit"]["maximum"], 50)
        self.assertEqual(asyncio.run(server.mcp.list_resources()), [])
        self.assertEqual(asyncio.run(server.mcp.list_prompts()), [])

    def test_pagination_order_limit_and_metadata_allowlist(self):
        self.get.side_effect = [
            response(data={"data": [song(i) for i in range(10)], "next": "?offset=10"}),
            response(data={"data": [song(10), song(11), song(12)]}),
        ]
        result = server.recently_played_tracks(12)
        self.assertEqual(result["returned"], 12)
        self.assertEqual([t["id"] for t in result["tracks"]], [str(i) for i in range(12)])
        self.assertEqual(result["tracks"][11], {
            "id": "11", "type": "songs", "name": "Song 11", "artist": "Artist",
            "album": "Album", "genres": ["Pop"],
        })
        self.assertEqual(self.get.call_count, 2)
        for call, offset, limit in zip(self.get.call_args_list, [0, 10], [10, 2]):
            self.assertEqual(call.args, ("https://api.music.apple.com/v1/me/recent/played/tracks",))
            self.assertEqual(call.kwargs["params"], {
                "types": "songs,library-songs", "offset": offset, "limit": limit,
            })
            self.assertFalse(call.kwargs["allow_redirects"])
            self.assertEqual(call.kwargs["headers"]["Music-User-Token"], "test-user-token")

    def test_http_failure_is_not_empty_or_partial_history(self):
        for status in [302, 401, 403, 429, 500]:
            for after_page in [False, True]:
                with self.subTest(status=status, after_page=after_page):
                    pages = [response(data={"data": [song(1)], "next": "?offset=1"})] if after_page else []
                    self.get.side_effect = pages + [response(status)]
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {status}"):
                        server.recently_played_tracks()

    def test_genuine_empty_and_last_page_are_successes(self):
        for items in [[], [song(7)]]:
            self.get.reset_mock()
            self.get.return_value = response(data={"data": items})
            result = server.recently_played_tracks()
            self.assertEqual(result["returned"], len(items))
            self.assertEqual(self.get.call_count, 1)

    def test_errors_do_not_expose_credentials(self):
        with patch.object(server, "get_user_token", side_effect=ValueError("SECRET")):
            with self.assertRaises(RuntimeError) as caught:
                server.recently_played_tracks()
            self.assertNotIn("SECRET", str(caught.exception))
            self.get.assert_not_called()
        self.get.side_effect = server.requests.ConnectionError("SECRET")
        with self.assertRaises(RuntimeError) as caught:
            server.heavy_rotation()
        self.assertNotIn("SECRET", str(caught.exception))

    def test_malformed_response_is_not_empty_history(self):
        for payload in [None, [], {"errors": []}, {"data": "wrong"}]:
            with self.subTest(payload=payload):
                self.get.return_value = response(data=payload)
                with self.assertRaisesRegex(RuntimeError, "invalid history response"):
                    server.recently_played_tracks()

    def test_heavy_rotation_preserves_type_without_inventing_play_counts(self):
        album = song(99)
        album["type"] = "albums"
        album["attributes"]["trackCount"] = 14
        self.get.return_value = response(data={"data": [album], "next": "?offset=1"})
        result = server.heavy_rotation()
        self.assertEqual(result["items"][0]["type"], "albums")
        self.assertTrue(result["hasMore"])
        self.assertNotIn("trackCount", result["items"][0])
        self.assertNotIn("plays", result["items"][0])
        self.assertEqual(self.get.call_args.args, ("https://api.music.apple.com/v1/me/history/heavy-rotation",))


if __name__ == "__main__":
    unittest.main()
