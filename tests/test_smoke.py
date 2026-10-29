"""End-to-end checks of store.py and serve.py against a throwaway Claude folder."""

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
CLAUDE = Path(TMP.name) / ".claude"
os.environ["CLAUDE_CONFIG_DIR"] = str(CLAUDE)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import serve  # noqa: E402
import store  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"
PROJECT = CLAUDE / "projects" / "-home-me-repo"


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")


def make_session():
    base = {"sessionId": SID, "cwd": "/home/me/repo", "gitBranch": "main", "entrypoint": "cli"}
    write_jsonl(
        PROJECT / f"{SID}.jsonl",
        [
            {
                **base,
                "type": "user",
                "timestamp": "2026-01-01T10:00:00Z",
                "message": {"content": "Fix the 🐛"},
            },
            {
                **base,
                "type": "assistant",
                "timestamp": "2026-01-01T10:00:05Z",
                "message": {
                    "content": [
                        {"type": "text", "text": "Looking."},
                        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
                    ]
                },
            },
            {
                **base,
                "type": "user",
                "timestamp": "2026-01-01T10:00:06Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.txt"}]},
            },
            {"type": "ai-title", "aiTitle": "Bug fix", "sessionId": SID},
        ],
    )
    write_jsonl(
        PROJECT / SID / "subagents" / "agent-abc.jsonl",
        [{"type": "user", "timestamp": "2026-01-01T10:01:00Z", "message": {"content": "Explore"}}],
    )
    (PROJECT / SID / "subagents" / "agent-abc.meta.json").write_text('{"agentType": "Explore"}')
    (CLAUDE / "file-history" / SID).mkdir(parents=True, exist_ok=True)


class StoreTest(unittest.TestCase):
    def setUp(self):
        make_session()

    def tearDown(self):
        for entry in store.list_trash():
            store.purge_session(entry["id"])

    def test_list_sessions(self):
        [s] = store.list_sessions()
        self.assertEqual(s["title"], "Bug fix")
        self.assertEqual(s["firstPrompt"], "Fix the 🐛")
        self.assertEqual((s["messages"], s["source"], s["gitBranch"]), (2, "cli", "main"))
        self.assertEqual([a["agentType"] for a in s["subagents"]], ["Explore"])

    def test_transcript_attaches_tool_results(self):
        messages = store.read_transcript(SID)["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant"])
        tool = messages[1]["blocks"][1]
        self.assertEqual((tool["name"], tool["summary"], tool["result"]), ("Bash", "ls", "a.txt"))
        self.assertEqual(len(store.read_transcript(SID, "abc")["messages"]), 1)

    def test_trash_restore_purge(self):
        manifest = store.trash_session(SID)
        self.assertEqual(store.list_sessions(), [])
        self.assertIn(f"file-history/{SID}", [i["from"] for i in manifest["items"]])
        store.restore_session(SID)
        self.assertEqual(len(store.list_sessions()), 1)
        self.assertTrue((CLAUDE / "file-history" / SID).is_dir())
        store.trash_session(SID)
        self.assertEqual(store.empty_trash(), {"deleted": 1})
        self.assertEqual(store.list_trash(), [])

    def test_rejects_bad_ids(self):
        for bad in ("../x", "x" * 36):
            with self.assertRaises(ValueError):
                store.read_transcript(bad)
        with self.assertRaises(ValueError):
            store.read_transcript(SID, "../../etc")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_session()
        cls.server = serve.ThreadingHTTPServer((serve.HOST, 0), serve.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection(serve.HOST, self.port)
        conn.request(method, path, headers=headers or {})
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    def test_serves_ui_with_csp(self):
        res, body = self.request("GET", "/")
        self.assertEqual(res.status, 200)
        self.assertIn(b"Content-Security-Policy", body)
        res, _ = self.request("GET", "/app.js")
        self.assertEqual(res.getheader("Content-Type"), "text/javascript; charset=utf-8")

    def test_api(self):
        res, body = self.request("GET", "/api/sessions")
        self.assertEqual(res.status, 200)
        self.assertEqual(json.loads(body)[0]["id"], SID)
        res, body = self.request("GET", "/api/info")
        self.assertIn(json.loads(body)["platform"], ("linux", "mac", "windows"))

    def test_guards(self):
        res, _ = self.request("POST", f"/api/sessions/{SID}/trash")
        self.assertEqual(res.status, 403, "mutations need the X-CSM header")
        res, _ = self.request("GET", "/api/sessions", {"Host": "evil.example"})
        self.assertEqual(res.status, 403, "unknown Host header")
        res, _ = self.request("GET", "/../store.py")
        self.assertEqual(res.status, 404, "no files outside static/")


if __name__ == "__main__":
    unittest.main()
