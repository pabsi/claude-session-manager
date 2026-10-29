"""Read Claude Code sessions from ~/.claude and move them to and from a trash folder.

static/backend-browser.js and static/parser-worker.js port this module to the browser;
keep them in step.
"""

import contextlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
PROJECTS_DIR = CLAUDE_DIR / "projects"
# Inside the Claude folder so the browser version, which only sees that folder, shares it.
TRASH_DIR = Path(os.environ.get("CSM_TRASH_DIR", CLAUDE_DIR / ".csm-trash"))
LEGACY_TRASH_DIR = Path.home() / ".local/share/claude-sessions-manager/trash"

SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROMPT_MAX = 300
TOOL_TEXT_MAX = 8000
# User records that are harness noise rather than something the user typed.
NOISE_PREFIXES = ("<command-", "<local-command", "<system-reminder", "Caveat:", "[Request interrupted")
IDE_CONTEXT_RE = re.compile(r"<ide_[a-z_]+>.*?</ide_[a-z_]+>", re.S)
PASTE_TAG_RE = re.compile(r"</?pasted_content[^>]*>")
COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>")
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
# Tool input fields that best describe a call in one line, in order of preference.
TOOL_SUMMARY_KEYS = (
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
    "skill",
)

_cache = {}  # path -> (mtime_ns, size, info)
_lock = threading.Lock()


# ---------- parsing ----------


def _records(path):
    with open(path, "rb") as fh:
        for raw in fh:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec


def _texts_of(content):
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return []


def _strip_context(text):
    return PASTE_TAG_RE.sub("", IDE_CONTEXT_RE.sub("", text)).strip()


def _truncate(text, limit, suffix="…"):
    return text if len(text) <= limit else text[:limit] + suffix


def _clean_prompt(text):
    text = _strip_context(text)
    if not text or text.startswith(NOISE_PREFIXES):
        return ""
    return _truncate(" ".join(text.split()), PROMPT_MAX)


def _parse_meta(path):
    info = {
        "title": "",
        "customTitle": "",
        "firstPrompt": "",
        "firstCommand": "",
        "cwd": "",
        "gitBranch": "",
        "entrypoint": "",
        "started": "",
        "lastActive": "",
        "userMessages": 0,
        "assistantMessages": 0,
    }
    for rec in _records(path):
        kind = rec.get("type")
        if kind == "ai-title":
            info["title"] = rec.get("aiTitle") or info["title"]
        elif kind == "custom-title":
            info["customTitle"] = rec.get("customTitle") or info["customTitle"]
        elif kind == "summary" and not info["title"]:
            info["title"] = rec.get("summary", "")
        if kind not in ("user", "assistant"):
            continue
        if ts := rec.get("timestamp"):
            info["started"] = info["started"] or ts
            info["lastActive"] = ts
        for key in ("cwd", "gitBranch", "entrypoint"):
            if rec.get(key):
                info[key] = rec[key]
        if kind == "assistant":
            info["assistantMessages"] += 1
            continue
        if rec.get("isMeta"):
            continue
        content = (rec.get("message") or {}).get("content")
        # Tool results come back as user records; only count real prompts.
        if (
            isinstance(content, list)
            and content
            and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
        ):
            continue
        info["userMessages"] += 1
        if info["firstPrompt"]:
            continue
        for text in _texts_of(content):
            info["firstPrompt"] = _clean_prompt(text)
            if info["firstPrompt"]:
                break
            if (cmd := COMMAND_RE.search(text)) and not info["firstCommand"]:
                info["firstCommand"] = cmd[1]
    if not info["firstPrompt"] and info["firstCommand"]:
        info["firstPrompt"] = f"(only ran {info['firstCommand']})"
    return info


def _clip(text):
    if len(text) <= TOOL_TEXT_MAX:
        return text
    return f"{text[:TOOL_TEXT_MAX]}\n… [{len(text) - TOOL_TEXT_MAX:,} more characters]"


def _tool_summary(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for key in TOOL_SUMMARY_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return _truncate(" ".join(value.split()), 160)
    return ""


def _tool_result_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif isinstance(block, dict) and block.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def _user_blocks(rec, content):
    if rec.get("isCompactSummary"):
        return [{"type": "summary", "text": "\n".join(_texts_of(content))}]
    blocks = []
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "image" for b in content):
        blocks.append({"type": "image"})
    for text in _texts_of(content):
        if cmd := COMMAND_RE.search(text):
            args = COMMAND_ARGS_RE.search(text)
            blocks.append({"type": "command", "text": f"{cmd[1]} {args[1].strip() if args else ''}".strip()})
            continue
        text = _strip_context(text)
        if text and not text.startswith(NOISE_PREFIXES):
            blocks.append({"type": "text", "text": text})
    return blocks


def _assistant_blocks(content, tools):
    blocks = []
    for block in content if isinstance(content, list) else []:
        kind = block.get("type") if isinstance(block, dict) else None
        if kind == "text" and block.get("text", "").strip():
            blocks.append({"type": "text", "text": block["text"]})
        elif kind == "thinking" and block.get("thinking", "").strip():
            blocks.append({"type": "thinking", "text": block["thinking"]})
        elif kind == "tool_use":
            tool_input = block.get("input")
            tool = {
                "type": "tool",
                "name": block.get("name", "tool"),
                "summary": _tool_summary(tool_input),
                "input": _clip(json.dumps(tool_input, indent=2, ensure_ascii=False)),
                "result": None,
                "isError": False,
            }
            tools[block.get("id")] = tool
            blocks.append(tool)
    return blocks


def _attach_tool_results(content, tools):
    for block in content if isinstance(content, list) else []:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            tool = tools.get(block.get("tool_use_id"))
            if tool is not None:
                tool["result"] = _clip(_tool_result_text(block.get("content")))
                tool["isError"] = bool(block.get("is_error"))


# ---------- sessions ----------


def _cached_meta(path, stat):
    key = str(path)
    hit = _cache.get(key)
    if hit and hit[0] == stat.st_mtime_ns and hit[1] == stat.st_size:
        return hit[2]
    info = _parse_meta(path)
    _cache[key] = (stat.st_mtime_ns, stat.st_size, info)
    return info


def _dir_size(path):
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _subagents(session_dir):
    agents = []
    for path in sorted((session_dir / "subagents").glob("agent-*.jsonl")):
        stat = path.stat()
        info = _cached_meta(path, stat)
        meta = {}
        with contextlib.suppress(OSError, ValueError):
            meta = json.loads(path.with_suffix(".meta.json").read_text(encoding="utf-8"))
        agents.append(
            {
                "agentId": path.stem.removeprefix("agent-"),
                "agentType": meta.get("agentType", ""),
                "description": meta.get("description") or info["firstPrompt"],
                "started": info["started"],
                "lastActive": info["lastActive"],
                "messages": info["userMessages"] + info["assistantMessages"],
                "size": stat.st_size,
            }
        )
    return sorted(agents, key=lambda a: a["started"])


def list_sessions():
    sessions = []
    with _lock:
        seen = set()
        for path in PROJECTS_DIR.glob("*/*.jsonl"):
            if not SESSION_ID_RE.match(path.stem):
                continue
            stat = path.stat()
            info = _cached_meta(path, stat)
            seen.add(str(path))
            if not (info["userMessages"] or info["assistantMessages"]):
                continue
            session_dir = path.with_suffix("")
            sessions.append(
                {
                    "id": path.stem,
                    "title": info["customTitle"] or info["title"],
                    "firstPrompt": info["firstPrompt"],
                    "cwd": info["cwd"],
                    "project": path.parent.name,
                    "gitBranch": info["gitBranch"],
                    "source": "vscode" if info["entrypoint"] == "claude-vscode" else "cli",
                    "started": info["started"],
                    "lastActive": info["lastActive"],
                    "messages": info["userMessages"] + info["assistantMessages"],
                    "size": stat.st_size + _dir_size(session_dir),
                    "subagents": _subagents(session_dir),
                }
            )
        for key in [k for k in _cache if k not in seen and Path(k).parent.name != "subagents"]:
            del _cache[key]
    return sorted(sessions, key=lambda s: s["lastActive"], reverse=True)


def _find_transcript(sid):
    return next(PROJECTS_DIR.glob(f"*/{sid}.jsonl"), None)


def read_transcript(sid, agent_id=None):
    """The conversation as display-ready messages, with tool results attached to their calls."""
    if not SESSION_ID_RE.match(sid) or (agent_id is not None and not AGENT_ID_RE.match(agent_id)):
        raise ValueError("invalid id")
    path = _find_transcript(sid)
    if path and agent_id:
        path = path.with_suffix("") / "subagents" / f"agent-{agent_id}.jsonl"
    if not path or not path.is_file():
        raise FileNotFoundError(sid)

    messages, tools = [], {}
    for rec in _records(path):
        if rec.get("type") not in ("user", "assistant") or rec.get("isMeta"):
            continue
        content = (rec.get("message") or {}).get("content")
        if rec["type"] == "user":
            _attach_tool_results(content, tools)
            blocks = _user_blocks(rec, content)
        else:
            blocks = _assistant_blocks(content, tools)
        if not blocks:
            continue
        if messages and messages[-1]["role"] == rec["type"]:
            messages[-1]["blocks"] += blocks
        else:
            messages.append({"role": rec["type"], "ts": rec.get("timestamp", ""), "blocks": blocks})
    return {"messages": messages}


# ---------- trash ----------


def _session_artifacts(sid, transcript):
    """Every path Claude Code keeps for one session that exists."""
    candidates = [
        transcript,
        transcript.with_suffix(""),
        CLAUDE_DIR / "file-history" / sid,
        CLAUDE_DIR / "session-env" / sid,
        CLAUDE_DIR / "debug" / f"{sid}.txt",
        *sorted((CLAUDE_DIR / "todos").glob(f"{sid}*.json")),
    ]
    return [p for p in candidates if p.exists()]


def _write_manifest(path, manifest):
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def trash_session(sid):
    if not SESSION_ID_RE.match(sid):
        raise ValueError("invalid session id")
    transcript = _find_transcript(sid)
    if not transcript:
        raise FileNotFoundError(sid)
    info = _parse_meta(transcript)
    dest = TRASH_DIR / sid
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    items = []
    try:
        for i, src in enumerate(_session_artifacts(sid, transcript)):
            target = dest / f"{i}-{src.name}"
            shutil.move(src, target)
            items.append({"from": src.relative_to(CLAUDE_DIR).as_posix(), "to": target.name})
    except OSError:
        # Windows refuses to move files an open session holds; undo the partial move.
        for item in reversed(items):
            shutil.move(dest / item["to"], CLAUDE_DIR / item["from"])
        shutil.rmtree(dest, ignore_errors=True)
        raise
    manifest = {
        "id": sid,
        "title": info["customTitle"] or info["title"] or info["firstPrompt"],
        "cwd": info["cwd"],
        "lastActive": info["lastActive"],
        "trashedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "items": items,
    }
    _write_manifest(dest / "manifest.json", manifest)
    return manifest


def list_trash():
    entries = []
    for manifest_path in TRASH_DIR.glob("*/manifest.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        manifest["size"] = _dir_size(manifest_path.parent)
        entries.append(manifest)
    return sorted(entries, key=lambda m: m.get("trashedAt", ""), reverse=True)


def _trash_entry(sid):
    if not SESSION_ID_RE.match(sid):
        raise ValueError("invalid session id")
    dest = TRASH_DIR / sid
    if not (dest / "manifest.json").is_file():
        raise FileNotFoundError(sid)
    return dest


def _original_path(item):
    # "from" is relative to CLAUDE_DIR; older manifests stored absolute paths.
    original = (CLAUDE_DIR / item["from"]).resolve()
    if not original.is_relative_to(CLAUDE_DIR.resolve()):
        raise ValueError(f"refusing to restore outside {CLAUDE_DIR}: {original}")
    return original


def restore_session(sid):
    dest = _trash_entry(sid)
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    originals = [_original_path(item) for item in manifest["items"]]
    for original in originals:
        if original.exists():
            raise FileExistsError(str(original))
    for item, original in zip(manifest["items"], originals, strict=True):
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(dest / item["to"], original)
    shutil.rmtree(dest)


def purge_session(sid):
    shutil.rmtree(_trash_entry(sid))


def empty_trash():
    entries = [m.parent for m in TRASH_DIR.glob("*/manifest.json")]
    for entry in entries:
        shutil.rmtree(entry)
    return {"deleted": len(entries)}


def migrate_legacy_trash():
    """Move entries from the pre-1.1 trash location into TRASH_DIR, with relative paths."""
    overridden = "CSM_TRASH_DIR" in os.environ or "CLAUDE_CONFIG_DIR" in os.environ
    if overridden or not LEGACY_TRASH_DIR.is_dir():
        return 0
    moved = 0
    for manifest_path in LEGACY_TRASH_DIR.glob("*/manifest.json"):
        target = TRASH_DIR / manifest_path.parent.name
        if target.exists():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest["items"]:
            original = Path(item["from"])
            if original.is_absolute() and original.is_relative_to(CLAUDE_DIR):
                item["from"] = original.relative_to(CLAUDE_DIR).as_posix()
        _write_manifest(manifest_path, manifest)
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(manifest_path.parent, target)
        moved += 1
    with contextlib.suppress(OSError):  # left in place if it holds anything we don't recognise
        LEGACY_TRASH_DIR.rmdir()
    return moved
