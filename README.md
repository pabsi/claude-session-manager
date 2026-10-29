# Claude Sessions Manager

Web UI to browse, read, resume and delete Claude Code sessions (CLI and VS Code).
No dependencies: Python standard library and plain HTML/CSS/JS.

It runs two ways, with the same UI:

| | `serve.py` (local server) | Browser only (e.g. GitHub Pages) |
|---|---|---|
| Start | `python3 serve.py` | open the page, pick your `.claude` folder |
| Browsers | any current browser | Chrome, Edge: full · Firefox, Safari: read-only |
| Trust notice | no | shown on every load |

## Run locally

```bash
python3 serve.py            # http://127.0.0.1:8765/
python3 serve.py --open     # also opens the browser
python3 serve.py --port 9000
```

On Windows use `py serve.py` (or `python serve.py`). Requires Python 3.10+.

## Run in the browser only

`static/` is a self-contained static site: host it anywhere, or open it from any
static server (`cd static && python3 -m http.server`). On first use the page asks for
your Claude folder (`~/.claude`, or `C:\Users\<you>\.claude` on Windows; it's hidden,
so press `Cmd+Shift+.` on macOS or `Ctrl+H` on Linux in the picker). The browser
remembers the folder; later visits only ask you to confirm access again.

- **Chrome / Edge** use the File System Access API: everything works, including delete.
- **Firefox / Safari** don't support it, so the folder is loaded read-only through a
  folder upload picker: browse and read transcripts, no delete or trash.

Nothing leaves the browser: the page's Content Security Policy only allows connections
back to its own origin, and in this mode it makes none.

### GitHub Pages

Every push to `main` (including merged pull requests) runs CI and, if it passes,
publishes `static/` to GitHub Pages. One-time setup: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

## What it does

- Lists every session in `~/.claude/projects/*/*.jsonl`, with the AI title, first prompt,
  project, git branch, source (CLI / VS Code), last model and effort level, last activity,
  message count, tokens and size. Tokens are summed over every API response in the session
  and its subagents (input, cache write, cache read and output; hover for the breakdown).
  Subagent transcripts are shown nested under their parent session.
- Click a session title (or a subagent) to read its transcript in a side panel: your
  prompts, Claude's replies, and each tool call with its input and result (collapsed;
  long outputs are cut at 8,000 characters). Thinking is stored encrypted, so it isn't shown.
- **Resume** copies `cd '<cwd>' && claude --resume <id>` to the clipboard (a PowerShell
  equivalent on Windows).
- **Delete** moves the session to `~/.claude/.csm-trash/<id>/`: the transcript, its
  subagents/tool-results dir, `file-history/<id>`, `session-env/<id>` and any
  `todos/<id>*.json`. The Trash tab can restore or permanently delete each session,
  or **Empty trash** to delete them all. Both modes share this trash.
- `~/.claude/history.jsonl` (your prompt history for the up-arrow key) is left untouched.

## Not supported

- claude.ai chats and claude.ai/code cloud sessions: there is no official API to list
  or delete them, so the header just links to them.
- Remote deletion: CLI/VS Code transcripts only exist locally.

## Keyboard

`/` search · `Esc` clear search · `t` toggle theme · `r` refresh

## Config (serve.py)

| Env var             | Default                          |
|---------------------|----------------------------------|
| `CLAUDE_CONFIG_DIR` | `~/.claude`                      |
| `CSM_TRASH_DIR`     | `<CLAUDE_CONFIG_DIR>/.csm-trash` |

Trash entries from older versions (`~/.local/share/claude-sessions-manager/trash`) are
moved into the new location the first time `serve.py` starts.

## Security

`serve.py` binds to `127.0.0.1` only, rejects requests with an unexpected `Host` header
(DNS rebinding), and requires an `X-CSM: 1` header on every mutating call so other
websites can't trigger deletes from your browser.

## Development

```bash
python3 -m unittest discover -s tests   # smoke tests (stdlib only)
uvx ruff check . && uvx ruff format .   # lint and format Python
```

CI (`.github/workflows/ci.yml`) runs Ruff, a JavaScript syntax check, and the tests on
Linux, macOS and Windows with Python 3.10 and 3.13 for every pull request. Dependabot
keeps the pinned GitHub Actions up to date.

| File | Role |
|---|---|
| `serve.py`, `store.py` | local server and its file handling |
| `static/index.html`, `styles.css`, `theme.js`, `app.js` | the UI, shared by both modes |
| `static/backend-server.js` | data source: `serve.py`'s HTTP API |
| `static/backend-browser.js`, `parser-worker.js` | data source: the browser reads `.claude` itself |
| `tests/test_smoke.py` | end-to-end checks of `store.py` and `serve.py` |

`backend-browser.js` and `parser-worker.js` port `store.py` to the browser, so a change
to how sessions are read must be made in both.
