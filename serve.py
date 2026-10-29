#!/usr/bin/env python3
"""Local web UI for browsing, resuming and trashing Claude Code sessions.

Usage: python3 serve.py [--port 8765] [--open]
"""

import argparse
import contextlib
import json
import re
import sys
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import store

STATIC_DIR = Path(__file__).resolve().parent / "static"
HOST = "127.0.0.1"
# Not from mimetypes: on Windows it reads the registry, which may map .js to text/plain,
# and browsers refuse to run such scripts under "nosniff".
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}
PLATFORM = {"win32": "windows", "darwin": "mac"}.get(sys.platform, "linux")

ROUTES = [
    ("GET", re.compile(r"^/api/info$"), lambda m: {"platform": PLATFORM, "home": str(Path.home())}),
    ("GET", re.compile(r"^/api/sessions$"), lambda m: store.list_sessions()),
    ("GET", re.compile(r"^/api/sessions/([^/]+)/transcript$"), lambda m: store.read_transcript(m[1])),
    (
        "GET",
        re.compile(r"^/api/sessions/([^/]+)/subagents/([^/]+)/transcript$"),
        lambda m: store.read_transcript(m[1], m[2]),
    ),
    ("GET", re.compile(r"^/api/trash$"), lambda m: store.list_trash()),
    ("DELETE", re.compile(r"^/api/trash$"), lambda m: store.empty_trash()),
    ("POST", re.compile(r"^/api/sessions/([^/]+)/trash$"), lambda m: store.trash_session(m[1])),
    ("POST", re.compile(r"^/api/trash/([^/]+)/restore$"), lambda m: store.restore_session(m[1])),
    ("DELETE", re.compile(r"^/api/trash/([^/]+)$"), lambda m: store.purge_session(m[1])),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "claude-sessions-manager"

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/") or self.command != "GET":
            super().log_message(fmt, *args)

    def _allowed_host(self):
        # Only answer to the names we are bound on, which blocks DNS rebinding.
        port = self.server.server_address[1]
        return self.headers.get("Host") in (f"{HOST}:{port}", f"localhost:{port}")

    def _send(self, status, body=b"", content_type="application/json", cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload, separators=(",", ":")).encode())

    def _dispatch(self):
        if not self._allowed_host():
            return self._json(HTTPStatus.FORBIDDEN, {"error": "bad host"})
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            return self._api(path)
        if self.command not in ("GET", "HEAD"):
            return self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})
        return self._static(path)

    def _api(self, path):
        if self.command != "GET" and self.headers.get("X-CSM") != "1":
            # A custom header forces a CORS preflight, which is never approved,
            # so other sites can't trigger destructive calls.
            return self._json(HTTPStatus.FORBIDDEN, {"error": "missing X-CSM header"})
        for method, pattern, action in ROUTES:
            match = pattern.match(path)
            if match and method == self.command:
                return self._run(action, match)
        return self._json(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})

    def _run(self, action, match):
        try:
            result = action(match)
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except FileNotFoundError as exc:
            return self._json(HTTPStatus.NOT_FOUND, {"error": f"not found: {exc}"})
        except FileExistsError as exc:
            return self._json(HTTPStatus.CONFLICT, {"error": f"already exists: {exc}"})
        except PermissionError as exc:
            message = f"file in use or not permitted (is the session still open?): {exc}"
            return self._json(HTTPStatus.CONFLICT, {"error": message})
        except OSError as exc:
            return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"{type(exc).__name__}: {exc}"})
        return self._json(HTTPStatus.OK, result if result is not None else {"ok": True})

    def _static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if not target.is_relative_to(STATIC_DIR) or not target.is_file():
            return self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(HTTPStatus.OK, target.read_bytes(), ctype, cache="no-cache")

    do_GET = do_HEAD = do_POST = do_DELETE = _dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open the UI in a browser")
    args = parser.parse_args()

    if moved := store.migrate_legacy_trash():
        print(f"Moved {moved} trashed session(s) to {store.TRASH_DIR}")
    store.list_sessions()  # warm the cache
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    url = f"http://{HOST}:{args.port}/"
    print(f"Claude Sessions Manager on {url}  (Ctrl+C to stop)")
    if args.open:
        webbrowser.open(url)
    with server, contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
