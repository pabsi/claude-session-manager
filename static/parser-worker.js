// Parses Claude Code JSONL transcripts off the main thread. Port of the parsing in store.py.

const PROMPT_MAX = 300;
const TOOL_TEXT_MAX = 8000;
const NOISE_PREFIXES = ["<command-", "<local-command", "<system-reminder", "Caveat:", "[Request interrupted"];
const IDE_CONTEXT_RE = /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g;
const PASTE_TAG_RE = /<\/?pasted_content[^>]*>/g;
const COMMAND_RE = /<command-name>(.*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const TOOL_SUMMARY_KEYS = [
  "description",
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "prompt",
  "skill",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNoise = (text) => NOISE_PREFIXES.some((p) => text.startsWith(p));
const squash = (text) => text.split(/\s+/).filter(Boolean).join(" ");
const stripContext = (text) => text.replace(IDE_CONTEXT_RE, "").replace(PASTE_TAG_RE, "").trim();

// Python counts code points, JS strings count UTF-16 units (an emoji is 2). Cut by code
// points so both versions truncate at the same place. Returns null when nothing is cut.
function cut(text, limit) {
  if (text.length <= limit) return null;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) total++;
  }
  if (total <= limit) return null;
  let end = 0;
  for (let n = 0; n < limit; n++) end += text.codePointAt(end) > 0xffff ? 2 : 1;
  return { head: text.slice(0, end), rest: total - limit };
}

function truncate(text, limit) {
  const c = cut(text, limit);
  return c ? c.head + "…" : text;
}

function clip(text) {
  const c = cut(text, TOOL_TEXT_MAX);
  return c ? `${c.head}\n… [${c.rest.toLocaleString("en-US")} more characters]` : text;
}

function* records(text) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (isObject(rec)) yield rec;
    } catch {}
  }
}

function textsOf(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => isObject(b) && b.type === "text").map((b) => b.text || "");
}

function cleanPrompt(text) {
  text = stripContext(text);
  return !text || isNoise(text) ? "" : truncate(squash(text), PROMPT_MAX);
}

function parseMeta(text) {
  const info = {
    title: "",
    customTitle: "",
    firstPrompt: "",
    firstCommand: "",
    cwd: "",
    gitBranch: "",
    entrypoint: "",
    started: "",
    lastActive: "",
    userMessages: 0,
    assistantMessages: 0,
  };
  for (const rec of records(text)) {
    const kind = rec.type;
    if (kind === "ai-title") info.title = rec.aiTitle || info.title;
    else if (kind === "custom-title") info.customTitle = rec.customTitle || info.customTitle;
    else if (kind === "summary" && !info.title) info.title = rec.summary || "";
    if (kind !== "user" && kind !== "assistant") continue;
    if (rec.timestamp) {
      info.started ||= rec.timestamp;
      info.lastActive = rec.timestamp;
    }
    for (const key of ["cwd", "gitBranch", "entrypoint"]) {
      if (rec[key]) info[key] = rec[key];
    }
    if (kind === "assistant") {
      info.assistantMessages++;
      continue;
    }
    if (rec.isMeta) continue;
    const content = (rec.message || {}).content;
    // Tool results come back as user records; only count real prompts.
    const onlyToolResults =
      Array.isArray(content) && content.length && content.every((b) => isObject(b) && b.type === "tool_result");
    if (onlyToolResults) continue;
    info.userMessages++;
    if (info.firstPrompt) continue;
    for (const t of textsOf(content)) {
      info.firstPrompt = cleanPrompt(t);
      if (info.firstPrompt) break;
      const cmd = t.match(COMMAND_RE);
      if (cmd && !info.firstCommand) info.firstCommand = cmd[1];
    }
  }
  if (!info.firstPrompt && info.firstCommand) info.firstPrompt = `(only ran ${info.firstCommand})`;
  return info;
}

function toolSummary(input) {
  if (!isObject(input)) return "";
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(squash(value), 160);
  }
  return "";
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content.filter(isObject)) {
    if (b.type === "text") parts.push(b.text || "");
    else if (b.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function userBlocks(rec, content) {
  if (rec.isCompactSummary) return [{ type: "summary", text: textsOf(content).join("\n") }];
  const blocks = [];
  if (Array.isArray(content) && content.some((b) => isObject(b) && b.type === "image")) {
    blocks.push({ type: "image" });
  }
  for (const t of textsOf(content)) {
    const cmd = t.match(COMMAND_RE);
    if (cmd) {
      const args = t.match(COMMAND_ARGS_RE);
      blocks.push({ type: "command", text: `${cmd[1]} ${args ? args[1].trim() : ""}`.trim() });
      continue;
    }
    const text = stripContext(t);
    if (text && !isNoise(text)) blocks.push({ type: "text", text });
  }
  return blocks;
}

function assistantBlocks(content, tools) {
  const blocks = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!isObject(b)) continue;
    if (b.type === "text" && (b.text || "").trim()) {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && (b.thinking || "").trim()) {
      blocks.push({ type: "thinking", text: b.thinking });
    } else if (b.type === "tool_use") {
      const tool = {
        type: "tool",
        name: b.name || "tool",
        summary: toolSummary(b.input),
        input: clip(JSON.stringify(b.input ?? null, null, 2)),
        result: null,
        isError: false,
      };
      tools.set(b.id, tool);
      blocks.push(tool);
    }
  }
  return blocks;
}

function attachToolResults(content, tools) {
  for (const b of Array.isArray(content) ? content : []) {
    if (!isObject(b) || b.type !== "tool_result") continue;
    const tool = tools.get(b.tool_use_id);
    if (tool) {
      tool.result = clip(toolResultText(b.content));
      tool.isError = Boolean(b.is_error);
    }
  }
}

// The conversation as display-ready messages, with tool results attached to their calls.
function parseTranscript(text) {
  const messages = [];
  const tools = new Map();
  for (const rec of records(text)) {
    if ((rec.type !== "user" && rec.type !== "assistant") || rec.isMeta) continue;
    const content = (rec.message || {}).content;
    let blocks;
    if (rec.type === "user") {
      attachToolResults(content, tools);
      blocks = userBlocks(rec, content);
    } else {
      blocks = assistantBlocks(content, tools);
    }
    if (!blocks.length) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === rec.type) last.blocks.push(...blocks);
    else messages.push({ role: rec.type, ts: rec.timestamp || "", blocks });
  }
  return { messages };
}

// {id, kind: "meta", files} -> {id, result: info[]}
// {id, kind: "transcript", file} -> {id, result: {messages}}
self.onmessage = async ({ data }) => {
  try {
    const result =
      data.kind === "meta"
        ? await Promise.all(data.files.map(async (f) => parseMeta(await f.text())))
        : parseTranscript(await data.file.text());
    self.postMessage({ id: data.id, result });
  } catch (err) {
    self.postMessage({ id: data.id, error: `${err.name}: ${err.message}` });
  }
};
