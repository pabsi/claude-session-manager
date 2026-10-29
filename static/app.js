import { connectServer } from "./backend-server.js";
import * as local from "./backend-browser.js";

const LIVE_WINDOW_MS = 5 * 60 * 1000;
const TIME_UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

let backend = null;

const state = {
  platform: "linux",
  home: "",
  view: "sessions",
  sessions: [],
  trash: [],
  query: "",
  source: "all",
  project: "",
  sortKey: "lastActive",
  sortDesc: true,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- helpers ----------

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function shortPath(p) {
  p = p || "";
  const { home, platform } = state;
  if (!home) return p;
  const starts = platform === "windows" ? p.toLowerCase().startsWith(home.toLowerCase()) : p.startsWith(home);
  return starts && /^$|^[\\/]/.test(p.slice(home.length)) ? "~" + p.slice(home.length) : p;
}

// "~/src/org/repo/a/b/c/d" -> "~/src/…/b/c/d" so long paths stay on one line.
function compactPath(p) {
  const short = shortPath(p);
  const sep = short.includes("\\") ? "\\" : "/";
  const parts = short.split(/[\\/]/);
  return parts.length > 6 ? [...parts.slice(0, 2), "…", ...parts.slice(-3)].join(sep) : short;
}

const posixQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const powershellQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function resumeCommand(s) {
  const resume = `claude --resume ${s.id}`;
  if (!s.cwd) return resume;
  return state.platform === "windows"
    ? `cd -LiteralPath ${powershellQuote(s.cwd)}; ${resume}`
    : `cd ${posixQuote(s.cwd)} && ${resume}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function relativeTime(iso) {
  if (!iso) return "—";
  const diff = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, secs] of TIME_UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "just now";
}

const absoluteTime = (iso) => (iso ? dtf.format(new Date(iso)) : "");

const isLive = (s) => s.lastActive && Date.now() - new Date(s.lastActive) < LIVE_WINDOW_MS;

const sourceBadge = (s) =>
  s.source === "vscode" ? `<span class="badge vscode">VS Code</span>` : `<span class="badge cli">CLI</span>`;

let toastTimer;
function toast(html, isError = false) {
  const el = $("#toast");
  el.innerHTML = html;
  el.classList.toggle("error", isError);
  // Re-showing the popover puts it at the top of the top layer, above any open dialog.
  if (el.matches(":popover-open")) el.hidePopover();
  el.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.matches(":popover-open") && el.hidePopover(), isError ? 6000 : 2200);
}

function confirmDialog(title, body, okLabel) {
  const dlg = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-ok").textContent = okLabel;
  dlg.returnValue = "";
  dlg.showModal();
  $("#confirm-ok").focus();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------- data ----------

let loading = null;
function load() {
  if (!backend) return Promise.resolve();
  loading ??= reload().finally(() => (loading = null)); // coalesce overlapping refreshes
  return loading;
}

async function reload() {
  const btn = $("#refresh");
  btn.classList.remove("spinning");
  void btn.offsetWidth; // restart the animation
  btn.classList.add("spinning");
  try {
    const [sessions, trash] = await Promise.all([
      backend.listSessions(),
      backend.writable ? backend.listTrash() : [],
    ]);
    state.platform = backend.platform;
    state.home = backend.home;
    state.sessions = sessions;
    state.trash = trash;
    renderProjects();
    render();
  } catch (err) {
    toast(`Failed to load: ${escapeHtml(err.message)}`, true);
  } finally {
    $("#empty").textContent = "No sessions match.";
  }
}

// ---------- rendering ----------

function renderProjects() {
  const projects = [...new Set(state.sessions.map((s) => s.cwd).filter(Boolean))].sort();
  if (state.project && !projects.includes(state.project)) state.project = "";
  const options = projects.map((p) => {
    const selected = p === state.project ? " selected" : "";
    return `<option value="${escapeHtml(p)}"${selected}>${escapeHtml(shortPath(p))}</option>`;
  });
  $("#project").innerHTML = `<option value="">All projects</option>${options.join("")}`;
}

function searchText(s) {
  s._search ??= [s.title, s.firstPrompt, s.cwd, s.gitBranch, s.id, ...s.subagents.map((a) => a.description)]
    .join(" ")
    .toLowerCase();
  return s._search;
}

function filteredSessions() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = state.sessions.filter(
    (s) =>
      (state.source === "all" || s.source === state.source) &&
      (!state.project || s.cwd === state.project) &&
      terms.every((t) => searchText(s).includes(t)),
  );
  const { sortKey: key, sortDesc: desc } = state;
  const value = (s) => (key === "title" ? s.title || s.firstPrompt : s[key]);
  return rows.sort((a, b) => {
    const [va, vb] = [value(a), value(b)];
    const cmp = typeof va === "number" ? va - vb : String(va ?? "").localeCompare(String(vb ?? ""));
    return desc ? -cmp : cmp;
  });
}

function subagentsHtml(agents) {
  if (!agents.length) return "";
  const items = agents.map((a) => {
    const type = a.agentType ? `<span class="agent-type">${escapeHtml(a.agentType)}</span>` : "";
    const label = escapeHtml(a.description || a.agentId);
    const id = escapeHtml(a.agentId);
    const link = `<a href="#" class="link" data-action="viewAgent" data-agent="${id}">${label}</a>`;
    const meta = `${a.messages} msgs · ${formatSize(a.size)} · ${escapeHtml(relativeTime(a.started))}`;
    return `<li>${type}${link} <span class="agent-meta">${meta}</span></li>`;
  });
  return `<details class="subagents">
    <summary>${plural(agents.length, "subagent")}</summary>
    <ul>${items.join("")}</ul>
  </details>`;
}

function sessionRow(s) {
  const title = s.title || s.firstPrompt || "(no prompt)";
  const prompt =
    s.title && s.firstPrompt
      ? `<div class="prompt" title="${escapeHtml(s.firstPrompt)}">${escapeHtml(s.firstPrompt)}</div>`
      : "";
  const branch =
    s.gitBranch && s.gitBranch !== "HEAD" ? `<div class="branch">${escapeHtml(s.gitBranch)}</div>` : "";
  const live = isLive(s) ? `<span class="badge live" title="Written to in the last 5 minutes">live</span>` : "";
  return `<tr data-id="${s.id}">
    <td>
      <a href="#" class="title link" data-action="view" title="View transcript">${escapeHtml(title)}</a>
      ${prompt}
      <div class="sid">${s.id}</div>
      ${subagentsHtml(s.subagents)}
    </td>
    <td>
      <div class="project" title="${escapeHtml(s.cwd)}">${escapeHtml(compactPath(s.cwd) || s.project)}</div>
      ${branch}
    </td>
    <td>${sourceBadge(s)}${live}</td>
    <td class="when" title="Started ${escapeHtml(absoluteTime(s.started))}">
      ${escapeHtml(relativeTime(s.lastActive))}<small>${escapeHtml(absoluteTime(s.lastActive))}</small>
    </td>
    <td class="num">${s.messages}</td>
    <td class="num">${formatSize(s.size)}</td>
    <td>
      <div class="actions">
        <button class="btn primary" data-action="resume" title="Copy resume command">Resume</button>
        <button class="btn danger" data-action="trash" title="Move to trash">Delete</button>
      </div>
    </td>
  </tr>`;
}

function trashRow(t) {
  return `<tr data-id="${t.id}">
    <td>
      <div class="title">${escapeHtml(t.title || "(no prompt)")}</div>
      <div class="sid">${t.id}</div>
    </td>
    <td><div class="project" title="${escapeHtml(t.cwd)}">${escapeHtml(compactPath(t.cwd))}</div></td>
    <td class="when">
      ${escapeHtml(relativeTime(t.trashedAt))}<small>${escapeHtml(absoluteTime(t.trashedAt))}</small>
    </td>
    <td class="num">${formatSize(t.size)}</td>
    <td>
      <div class="actions">
        <button class="btn" data-action="restore">Restore</button>
        <button class="btn danger" data-action="purge">Delete forever</button>
      </div>
    </td>
  </tr>`;
}

function render() {
  const rows = filteredSessions();
  $("#rows").innerHTML = rows.map(sessionRow).join("");
  $("#empty").hidden = rows.length > 0;
  $("#trash-rows").innerHTML = state.trash.map(trashRow).join("");
  $("#trash-empty").hidden = state.trash.length > 0;

  const total = state.sessions.length;
  $("#count-sessions").textContent = rows.length === total ? total : `${rows.length}/${total}`;
  $("#count-trash").textContent = state.trash.length || "";
  const trashSize = state.trash.reduce((sum, t) => sum + (t.size || 0), 0);
  $("#trash-summary").textContent = state.trash.length
    ? `${plural(state.trash.length, "session")} · ${formatSize(trashSize)}`
    : "";
  $("#empty-trash").disabled = state.trash.length === 0;

  $$(".grid th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sortKey);
    th.classList.toggle("desc", th.dataset.sort === state.sortKey && state.sortDesc);
  });
}

function setView(view) {
  if (!backend) return;
  state.view = view;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $("#view-sessions").hidden = $("#toolbar-sessions").hidden = view !== "sessions";
  $("#view-trash").hidden = $("#toolbar-trash").hidden = view !== "trash";
}

// ---------- transcript viewer ----------

const viewer = { sessionId: null };

// Just enough markdown for chat text: fenced code, inline code, bold, links.
function renderText(text) {
  return text
    .split(/```[^\n]*\n([\s\S]*?)(?:```|$)/)
    .map((part, i) => {
      if (i % 2) return `<pre class="code">${escapeHtml(part.replace(/\n$/, ""))}</pre>`;
      const html = escapeHtml(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(https?:\/\/[^\s<)"']+)/g, `<a href="$1" target="_blank" rel="noopener">$1</a>`);
      return html.trim() ? `<div class="text">${html}</div>` : "";
    })
    .join("");
}

function toolHtml(b) {
  let status = "";
  if (b.result === null) status = `<span class="badge pending">no result</span>`;
  else if (b.isError) status = `<span class="badge error">error</span>`;
  const result =
    b.result === null
      ? ""
      : `<div class="tool-label">Result</div><pre class="code">${escapeHtml(b.result || "(empty)")}</pre>`;
  return `<details class="tool">
    <summary>
      <span class="tool-name">${escapeHtml(b.name)}</span>
      <span class="tool-summary">${escapeHtml(b.summary)}</span>
      ${status}
    </summary>
    <div class="tool-label">Input</div>
    <pre class="code">${escapeHtml(b.input)}</pre>
    ${result}
  </details>`;
}

function blockHtml(b) {
  switch (b.type) {
    case "text":
      return renderText(b.text);
    case "command":
      return `<div class="command">${escapeHtml(b.text)}</div>`;
    case "image":
      return `<div class="note">[image attached]</div>`;
    case "summary":
      return `<details class="fold">
        <summary>Conversation summary (compacted)</summary>${renderText(b.text)}
      </details>`;
    case "thinking":
      return `<details class="fold">
        <summary>Thinking</summary><div class="text muted">${escapeHtml(b.text)}</div>
      </details>`;
    case "tool":
      return toolHtml(b);
    default:
      return "";
  }
}

function messageHtml(m) {
  const time = escapeHtml(absoluteTime(m.ts));
  return `<article class="msg ${m.role}">
    <div class="msg-head">
      <span class="who">${m.role === "user" ? "You" : "Claude"}</span><time>${time}</time>
    </div>
    ${m.blocks.map(blockHtml).join("")}
  </article>`;
}

async function openViewer(session, agent) {
  viewer.sessionId = session.id;
  $("#viewer-title").textContent = agent
    ? agent.description || agent.agentId
    : session.title || session.firstPrompt || session.id;
  $("#viewer-meta").innerHTML = agent
    ? `<span class="badge">${escapeHtml(agent.agentType || "subagent")}</span>
       of <strong>${escapeHtml(session.title || session.id)}</strong>`
    : `${sourceBadge(session)}
       <span class="mono">${escapeHtml(shortPath(session.cwd))}</span>
       <span>${escapeHtml(absoluteTime(session.started))}</span>
       <span class="mono">${session.id}</span>`;
  $("#viewer-resume").hidden = Boolean(agent);
  $("#viewer-tools").textContent = "Expand tools";
  $("#viewer-body").innerHTML = `<p class="empty">Loading…</p>`;
  if (!$("#viewer").open) $("#viewer").showModal();
  $("#viewer-body").scrollTop = 0;

  try {
    const { messages } = await backend.readTranscript(session.id, agent?.agentId);
    if (viewer.sessionId !== session.id) return; // another transcript was opened meanwhile
    $("#viewer-body").innerHTML = messages.length
      ? messages.map(messageHtml).join("")
      : `<p class="empty">No messages.</p>`;
  } catch (err) {
    $("#viewer-body").innerHTML = `<p class="empty">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------- actions ----------

const findSession = (id) => state.sessions.find((s) => s.id === id);

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(escapeHtml(err.message), true);
  } finally {
    button.disabled = false;
  }
}

const actions = {
  view(id) {
    openViewer(findSession(id));
  },

  viewAgent(id, el) {
    const s = findSession(id);
    openViewer(s, s.subagents.find((a) => a.agentId === el.dataset.agent));
  },

  async resume(id) {
    const cmd = resumeCommand(findSession(id));
    await copyText(cmd);
    toast(`Copied <code>${escapeHtml(cmd)}</code>`);
  },

  async trash(id, button) {
    const s = findSession(id);
    const warn = isLive(s) ? "\n\nThis session was active in the last 5 minutes. It may still be open." : "";
    const ok = await confirmDialog(
      "Move session to trash?",
      `“${s.title || s.firstPrompt || id}”\n\nThe transcript, subagents, file history and session env ` +
        `are moved to the trash. You can restore it from the Trash tab.${warn}`,
      "Move to trash",
    );
    if (!ok) return;
    await withBusy(button, async () => {
      const manifest = await backend.trashSession(id);
      state.sessions = state.sessions.filter((x) => x.id !== id);
      state.trash.unshift({ ...manifest, size: s.size });
      renderProjects();
      render();
      toast("Moved to trash");
    });
  },

  async restore(id, button) {
    await withBusy(button, async () => {
      await backend.restoreSession(id);
      toast("Restored");
      await load();
    });
  },

  async purge(id, button) {
    const t = state.trash.find((x) => x.id === id);
    const ok = await confirmDialog(
      "Delete forever?",
      `“${t.title || id}”\n\nThis permanently deletes the files. It cannot be undone.`,
      "Delete forever",
    );
    if (!ok) return;
    await withBusy(button, async () => {
      await backend.purgeSession(id);
      state.trash = state.trash.filter((x) => x.id !== id);
      render();
      toast("Deleted");
    });
  },
};

async function emptyTrash() {
  const ok = await confirmDialog(
    "Empty trash?",
    `This permanently deletes ${plural(state.trash.length, "session")}. It cannot be undone.`,
    "Empty trash",
  );
  if (!ok) return;
  await withBusy($("#empty-trash"), async () => {
    const { deleted } = await backend.emptyTrash();
    state.trash = [];
    toast(`Deleted ${plural(deleted, "session")}`);
  });
  render();
}

// ---------- events ----------

function onTableClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  actions[el.dataset.action](el.closest("tr").dataset.id, el);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("csm-theme", next);
  } catch {}
}

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    render();
  }, 60);
});

$$(".segmented button").forEach((b) =>
  b.addEventListener("click", () => {
    state.source = b.dataset.source;
    $$(".segmented button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }),
);

$("#project").addEventListener("change", (e) => {
  state.project = e.target.value;
  render();
});

$$(".grid th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    state.sortDesc = state.sortKey === key ? !state.sortDesc : ["lastActive", "messages", "size"].includes(key);
    state.sortKey = key;
    render();
  }),
);

$$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
$("#rows").addEventListener("click", onTableClick);
$("#trash-rows").addEventListener("click", onTableClick);
$("#theme-toggle").addEventListener("click", toggleTheme);
$("#refresh").addEventListener("click", load);
$("#empty-trash").addEventListener("click", emptyTrash);

$("#viewer-close").addEventListener("click", () => $("#viewer").close());
$("#viewer").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // click on the backdrop
});
$("#viewer").addEventListener("close", () => (viewer.sessionId = null));
$("#viewer-resume").addEventListener("click", () => actions.resume(viewer.sessionId));
$("#viewer-bottom").addEventListener("click", () => {
  const body = $("#viewer-body");
  body.scrollTop = body.scrollHeight;
});
$("#viewer-tools").addEventListener("click", (e) => {
  const tools = [...$$("#viewer-body details.tool")];
  const open = tools.some((d) => !d.open);
  tools.forEach((d) => (d.open = open));
  e.currentTarget.textContent = open ? "Collapse tools" : "Expand tools";
});

document.addEventListener("keydown", (e) => {
  if (!backend || $$("dialog[open]").length) return;
  if (e.key === "Escape" && e.target.id === "search") {
    e.target.value = state.query = "";
    render();
    e.target.blur();
  }
  if (e.target.matches("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    setView("sessions");
    $("#search").focus();
  } else if (e.key === "t") {
    toggleTheme();
  } else if (e.key === "r") {
    load();
  }
});

// Pick up sessions created or updated while the tab was in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});

// ---------- startup ----------

function start(connected) {
  backend = connected;
  const root = document.documentElement;
  root.dataset.mode = backend.mode;
  root.toggleAttribute("data-readonly", !backend.writable);
  $("#connect").hidden = true;
  $("#tabs").hidden = false;
  $("#readonly-badge").hidden = backend.writable;
  if (backend.mode === "browser") {
    $("#change-folder").hidden = false;
    $("#change-folder").textContent = `📁 ${backend.folderName}`;
  }
  state.sessions = [];
  state.trash = [];
  setView(backend.writable ? state.view : "sessions");
  $("#empty").textContent = "Reading sessions…";
  render();
  load();
}

async function connectWith(promise) {
  $("#connect-error").hidden = true;
  try {
    start(await promise);
  } catch (err) {
    if (err.name === "AbortError") return; // picker cancelled
    $("#connect-error").textContent = err.message;
    $("#connect-error").hidden = false;
    showConnect({ autoReopen: false }); // don't retry the folder that just failed
  }
}

async function showConnect({ autoReopen = true } = {}) {
  backend = null;
  $("#connect").hidden = false;
  $("#tabs").hidden = true;
  for (const sel of ["#toolbar-sessions", "#view-sessions", "#toolbar-trash", "#view-trash"]) {
    $(sel).hidden = true;
  }
  $("#connect-pick").hidden = !local.canWrite;
  $("#connect-readonly").hidden = $("#connect-readonly-note").hidden = local.canWrite;

  const saved = await local.savedFolder();
  if (autoReopen && saved?.permission === "granted") return connectWith(local.reconnect(saved.handle));
  $("#connect-reconnect").hidden = !saved;
  if (saved) {
    $("#connect-reconnect").textContent = `Reopen “${saved.handle.name}”`;
    $("#connect-reconnect").onclick = () => connectWith(local.reconnect(saved.handle));
    $("#connect-pick").textContent = "Choose another folder…";
  }
}

function showTrustNotice() {
  // On GitHub Pages the source lives at github.com/<user>/<repo>.
  const user = location.hostname.endsWith(".github.io") && location.hostname.split(".")[0];
  if (user) {
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${user}.github.io`;
    $("#trust-source").href = `https://github.com/${user}/${repo}`;
    $("#trust-source").hidden = $("#trust-source-sep").hidden = false;
  }
  $("#trust").showModal();
}

$("#connect-pick").addEventListener("click", () => connectWith(local.pickFolder()));
$("#connect-files").addEventListener("change", (e) => {
  if (e.target.files.length) connectWith(local.openFileList(e.target.files));
  e.target.value = "";
});
$("#change-folder").addEventListener("click", () => {
  if (!local.canWrite) return $("#connect-files").click();
  const keepCurrent = (err) => {
    if (err.name === "AbortError") return backend;
    throw err;
  };
  connectWith(local.pickFolder().catch(keepCurrent));
});

async function init() {
  const server = await connectServer();
  if (server) return start(server);
  showTrustNotice();
  await showConnect();
}

init();
