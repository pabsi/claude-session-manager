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

import prices  # noqa: E402
import serve  # noqa: E402
import store  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"
PROJECT = CLAUDE / "projects" / "-home-me-repo"
REJECTED = "The user doesn't want to proceed with this tool use."
USAGE = {
    "input_tokens": 3,
    "cache_creation_input_tokens": 100,
    "cache_read_input_tokens": 1000,
    "output_tokens": 20,
}


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
                "effort": "medium",
                "timestamp": "2026-01-01T10:00:02Z",
                "message": {"id": "m0", "model": "claude-sonnet-5-5", "content": []},
            },
            *(
                {"type": "system", "subtype": "compact_boundary", "compactMetadata": {"trigger": trigger}}
                for trigger in ("manual", "manual", "auto")
            ),
            *(
                {
                    **base,
                    "type": "assistant",
                    "effort": "high",
                    "timestamp": "2026-01-01T10:00:05Z",
                    "message": {"id": "m1", "model": "claude-opus-5-5", "usage": USAGE, "content": [block]},
                }
                # One record per content block, each repeating the response's usage.
                for block in (
                    {"type": "text", "text": "Looking."},
                    *(
                        {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {"command": "ls"}}
                        for i in range(1, 5)
                    ),
                )
            ),
            *(
                {
                    **base,
                    "type": "user",
                    "timestamp": "2026-01-01T10:00:06Z",
                    "message": {"content": [{"type": "tool_result", **result}]},
                }
                for result in (
                    {"tool_use_id": "t1", "content": "a.txt"},
                    {"tool_use_id": "t1", "content": "a.txt"},  # written twice, counted once
                    {"tool_use_id": "t2", "is_error": True, "content": REJECTED},
                    {"tool_use_id": "t3", "is_error": True, "content": "Exit code 1"},
                )  # t4 has no result: interrupted
            ),
            {"type": "ai-title", "aiTitle": "Bug fix", "sessionId": SID},
        ],
    )
    write_jsonl(
        PROJECT / SID / "subagents" / "agent-abc.jsonl",
        [
            {"type": "user", "timestamp": "2026-01-01T10:01:00Z", "message": {"content": "Explore"}},
            {
                "type": "assistant",
                "timestamp": "2026-01-01T10:01:05Z",
                "message": {"id": "msg_a", "model": "claude-haiku-5-5", "usage": USAGE, "content": []},
            },
        ],
    )
    (PROJECT / SID / "subagents" / "agent-abc.meta.json").write_text('{"agentType": "Explore"}')
    (CLAUDE / "file-history" / SID).mkdir(parents=True, exist_ok=True)


RATES = {"input": 1e-6, "cacheWrite5m": 2e-6, "cacheWrite1h": 4e-6, "cacheRead": 1e-7, "output": 5e-6}
PRICE = {**RATES, "webSearch": 0.01, "multipliers": {"fast": 2, "us": 1.1}, "tiers": []}


class CostTest(unittest.TestCase):
    def setUp(self):
        make_session()
        store.PRICE_LIST = {"models": {"claude-opus-5-5": PRICE, "claude-sonnet-5-5": PRICE}}
        store._cache.clear()

    def tearDown(self):
        store.PRICE_LIST = None
        store._cache.clear()
        store.CONFIG_FILE.unlink(missing_ok=True)

    def test_session_cost(self):
        [s] = store.list_sessions()
        # The opus reply (3 input, 100 cache write, 1000 cache read, 20 output); the subagent's
        # haiku reply has no price.
        self.assertAlmostEqual(s["cost"]["usd"], 3e-6 + 2e-4 + 1e-4 + 1e-4)
        self.assertEqual(s["cost"]["unpriced"], 1)
        self.assertIsNone(s["recordedCost"])

    def test_recorded_cost(self):
        projects = {"/home/me/repo": {"lastSessionId": SID, "lastCost": 1.5}, "/other": {"lastCost": 2}}
        store.CONFIG_FILE.write_text(json.dumps({"projects": projects}), encoding="utf-8")
        [s] = store.list_sessions()
        self.assertEqual(s["recordedCost"], 1.5)

    def test_reply_cost(self):
        usage = {
            "input_tokens": 10,
            "cache_creation_input_tokens": 300,
            "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200},
            "cache_read_input_tokens": 1000,
            "output_tokens": 20,
            "server_tool_use": {"web_search_requests": 2},
        }
        tokens = 10e-6 + 100 * 2e-6 + 200 * 4e-6 + 1000 * 1e-7 + 20 * 5e-6
        self.assertAlmostEqual(store._reply_cost("claude-opus-5-5-20260101", usage), tokens + 0.02)
        fast_us = {**usage, "speed": "fast", "inference_geo": "us"}
        self.assertAlmostEqual(store._reply_cost("claude-opus-5-5", fast_us), tokens * 2.2 + 0.02)
        self.assertIsNone(store._reply_cost("claude-unknown", usage))
        # Above the tier's prompt length every token of the request takes the tier's rates.
        tiered = {**PRICE, "tiers": [{"above": 1000, "input": 1e-3}]}
        store.PRICE_LIST["models"]["claude-opus-5-5"] = tiered
        self.assertAlmostEqual(store._reply_cost("claude-opus-5-5", usage), tokens + 10e-3 - 10e-6 + 0.02)
        self.assertAlmostEqual(
            store._reply_cost("claude-opus-5-5", {**usage, "cache_read_input_tokens": 0}),
            tokens - 1e-4 + 0.02,
        )

    def test_extract_prices(self):
        litellm = {
            "claude-opus-5-5": {
                "litellm_provider": "anthropic",
                "input_cost_per_token": 1e-6,
                "cache_creation_input_token_cost": 2e-6,
                "cache_creation_input_token_cost_above_1hr": 4e-6,
                "cache_read_input_token_cost": 1e-7,
                "output_cost_per_token": 5e-6,
                "input_cost_per_token_above_200k_tokens": 2e-6,
                "input_cost_per_token_above_200k_tokens_batches": 1e-6,
                "search_context_cost_per_query": {"search_context_size_medium": 0.01},
                "provider_specific_entry": {"fast": 2, "us": "x"},
            },
            "claude-no-cache-price": {"litellm_provider": "anthropic", "input_cost_per_token": 1e-6},
            "claude-on-bedrock": {"litellm_provider": "bedrock", "input_cost_per_token": 1e-6},
            "gpt-x": {"litellm_provider": "openai"},
        }
        models = prices.extract(litellm)
        self.assertEqual(list(models), ["claude-opus-5-5"])
        self.assertEqual(
            models["claude-opus-5-5"],
            {
                **RATES,
                "webSearch": 0.01,
                "multipliers": {"fast": 2},
                "tiers": [{"above": 200000, "input": 2e-6}],
            },
        )


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
        self.assertEqual((s["messages"], s["source"], s["gitBranch"]), (7, "cli", "main"))
        self.assertEqual((s["model"], s["effort"]), ("claude-opus-5-5", "high"))
        # The main response counts once despite two records, plus the subagent's response.
        self.assertEqual(s["usage"], {"input": 6, "cacheWrite": 200, "cacheRead": 2000, "output": 40})
        outcomes = {"succeeded": 1, "errored": 1, "interrupted": 1, "rejected": 1}
        self.assertEqual(s["tools"], {"total": 4, **outcomes})
        self.assertEqual(s["compactions"], {"manual": 2, "auto": 1})
        self.assertEqual(
            [(m["model"], m["effort"], m["responses"]) for m in s["models"]],
            [("claude-sonnet-5-5", "medium", 1), ("claude-opus-5-5", "high", 1)],
        )
        self.assertEqual([a["agentType"] for a in s["subagents"]], ["Explore"])

    def test_transcript_attaches_tool_results(self):
        messages = store.read_transcript(SID)["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant"])
        tool = messages[1]["blocks"][1]
        self.assertEqual((tool["name"], tool["summary"], tool["result"]), ("Bash", "ls", "a.txt"))
        self.assertEqual(len(store.read_transcript(SID, "abc")["messages"]), 1)  # empty reply dropped

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
        for path in (
            "/../store.py",
            "/..%2Fstore.py",
            "//etc/passwd",
            "/%2e%2e/serve.py",
            "/C:/Windows/win.ini",
        ):
            res, _ = self.request("GET", path)
            self.assertEqual(res.status, 404, f"no files outside static/: {path}")
        res, _ = self.request("GET", "/markdown.js")
        self.assertEqual(res.status, 200, "files in static/ are served")


if __name__ == "__main__":
    unittest.main()
