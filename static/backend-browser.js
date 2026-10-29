// Data source that reads ~/.claude in the browser, without serve.py. Port of store.py.
// Read-write through the File System Access API (Chromium), otherwise read-only from an
// <input webkitdirectory> file list (Firefox, Safari).

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOME_RE = /^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/;
const TRASH = ".csm-trash";
const CACHE_KEY = "meta-cache-v2"; // bump when parseMeta's output changes

export const canWrite = typeof window.showDirectoryPicker === "function";

// ---------- IndexedDB (folder handle + parse cache) ----------

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("claude-sessions-manager", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const store = (await db()).transaction("kv", mode).objectStore("kv");
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const idbGet = (key) => idb("readonly", (s) => s.get(key)).catch(() => undefined);
const idbSet = (key, value) => idb("readwrite", (s) => s.put(value, key)).catch(() => {});

// ---------- parser worker ----------

let worker;
let nextJob = 0;
const jobs = new Map();

function parse(message) {
  if (!worker) {
    worker = new Worker(new URL("parser-worker.js", import.meta.url));
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
  }
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

// ---------- file system adapters ----------

const split = (path) => path.split("/").filter(Boolean);
const isMissing = (err) => err && (err.name === "NotFoundError" || err.name === "TypeMismatchError");

class HandleFS {
  writable = true;

  constructor(root) {
    this.root = root;
    this.name = root.name;
  }

  async dir(path, create = false) {
    let d = this.root;
    for (const part of split(path)) d = await d.getDirectoryHandle(part, { create });
    return d;
  }

  async parentOf(path, create = false) {
    const parts = split(path);
    const name = parts.pop();
    return [await this.dir(parts.join("/"), create), name];
  }

  async list(path) {
    try {
      const out = [];
      for await (const [name, h] of (await this.dir(path)).entries()) out.push({ name, kind: h.kind });
      return out;
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async file(path) {
    const [parent, name] = await this.parentOf(path);
    return (await parent.getFileHandle(name)).getFile();
  }

  async kind(path) {
    const [parent, name] = await this.parentOf(path).catch(() => [null]);
    if (!parent) return null;
    for (const kind of ["file", "directory"]) {
      try {
        await (kind === "file" ? parent.getFileHandle(name) : parent.getDirectoryHandle(name));
        return kind;
      } catch {}
    }
    return null;
  }

  async writeText(path, text) {
    const [parent, name] = await this.parentOf(path, true);
    const w = await (await parent.getFileHandle(name, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }

  async remove(path) {
    const [parent, name] = await this.parentOf(path);
    await parent.removeEntry(name, { recursive: true });
  }

  async copy(src, dst) {
    if ((await this.kind(src)) === "directory") {
      await this.dir(dst, true);
      for (const e of await this.list(src)) await this.copy(`${src}/${e.name}`, `${dst}/${e.name}`);
      return;
    }
    const [parent, name] = await this.parentOf(dst, true);
    const w = await (await parent.getFileHandle(name, { create: true })).createWritable();
    await (await this.file(src)).stream().pipeTo(w); // closes w
  }

  // There is no portable rename across folders, so copy then delete. If the delete fails
  // (Windows keeps files of an open session locked) drop the copy so nothing is duplicated.
  async move(src, dst) {
    await this.copy(src, dst);
    try {
      await this.remove(src);
    } catch (err) {
      await this.remove(dst).catch(() => {});
      throw err;
    }
  }
}

class FileListFS {
  writable = false;

  constructor(files) {
    this.files = new Map();
    this.children = new Map();
    for (const f of files) {
      const [root, ...rest] = f.webkitRelativePath.split("/");
      this.name ??= root;
      this.files.set(rest.join("/"), f);
      for (let i = rest.length; i > 0; i--) {
        const parent = rest.slice(0, i - 1).join("/");
        const kids = this.children.get(parent) ?? new Map();
        kids.set(rest[i - 1], i === rest.length ? "file" : "directory");
        this.children.set(parent, kids);
      }
    }
  }

  async list(path) {
    return [...(this.children.get(split(path).join("/")) ?? [])].map(([name, kind]) => ({ name, kind }));
  }

  async file(path) {
    const f = this.files.get(split(path).join("/"));
    if (!f) throw new DOMException(path, "NotFoundError");
    return f;
  }

  async kind(path) {
    path = split(path).join("/");
    return this.files.has(path) ? "file" : this.children.has(path) ? "directory" : null;
  }
}

// ---------- helpers ----------

async function treeSize(fs, path) {
  let total = 0;
  for (const e of await fs.list(path)) {
    const child = `${path}/${e.name}`;
    total += e.kind === "directory" ? await treeSize(fs, child) : (await fs.file(child)).size;
  }
  return total;
}

function sumUsage(usages) {
  const total = { ...usages[0] };
  for (const usage of usages.slice(1)) {
    for (const key of Object.keys(total)) total[key] += usage[key];
  }
  return total;
}

function detectPlatform() {
  const p = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  return p.includes("win") ? "windows" : p.includes("mac") ? "mac" : "linux";
}

// The browser can't tell us the home folder; the most common prefix of session cwds is it.
function guessHome(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const m = (s.cwd || "").match(HOME_RE);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// Older manifests written by serve.py stored absolute paths.
function relativeToRoot(from, rootName) {
  const p = from.replace(/\\/g, "/");
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) return p;
  const i = p.lastIndexOf(`/${rootName}/`);
  if (i < 0) throw new Error(`can't map ${from} into the selected folder`);
  return p.slice(i + rootName.length + 2);
}

function checkId(id, re = SESSION_ID_RE) {
  if (!re.test(id)) throw new Error("invalid id");
}

// ---------- backend ----------

function createBackend(fs) {
  const transcripts = new Map(); // session id -> transcript path
  let cache = null; // path -> {lastModified, size, info}

  async function metaFor(paths, files) {
    cache ??= (await idbGet(CACHE_KEY)) ?? {};
    const infos = new Array(files.length);
    const todo = [];
    files.forEach((f, i) => {
      const hit = cache[paths[i]];
      if (hit && hit.lastModified === f.lastModified && hit.size === f.size) infos[i] = hit.info;
      else todo.push(i);
    });
    if (todo.length) {
      const parsed = await parse({ kind: "meta", files: todo.map((i) => files[i]) });
      todo.forEach((i, j) => {
        infos[i] = parsed[j];
        cache[paths[i]] = { lastModified: files[i].lastModified, size: files[i].size, info: parsed[j] };
      });
    }
    return infos;
  }

  async function subagents(sessionDir) {
    const dir = `${sessionDir}/subagents`;
    const entries = (await fs.list(dir)).filter((e) => e.kind === "file" && /^agent-.+\.jsonl$/.test(e.name));
    const paths = entries.map((e) => `${dir}/${e.name}`);
    const files = await Promise.all(paths.map((p) => fs.file(p)));
    const infos = await metaFor(paths, files);
    const agents = await Promise.all(
      entries.map(async (e, i) => {
        let meta = {};
        try {
          meta = JSON.parse(await (await fs.file(paths[i].replace(/\.jsonl$/, ".meta.json"))).text());
        } catch {}
        const info = infos[i];
        return {
          agentId: e.name.slice("agent-".length, -".jsonl".length),
          agentType: meta.agentType || "",
          description: meta.description || info.firstPrompt,
          started: info.started,
          lastActive: info.lastActive,
          messages: info.userMessages + info.assistantMessages,
          usage: info.usage,
          size: files[i].size,
        };
      }),
    );
    return agents.sort((a, b) => a.started.localeCompare(b.started));
  }

  async function findTranscript(id) {
    if (transcripts.has(id) && (await fs.kind(transcripts.get(id))) === "file") return transcripts.get(id);
    for (const p of await fs.list("projects")) {
      const path = `projects/${p.name}/${id}.jsonl`;
      if (p.kind === "directory" && (await fs.kind(path)) === "file") return path;
    }
    throw new Error(`session not found: ${id}`);
  }

  // Every path Claude Code keeps for one session that exists.
  async function artifacts(id, transcript) {
    const todos = (await fs.list("todos"))
      .filter((e) => e.name.startsWith(id) && e.name.endsWith(".json"))
      .map((e) => `todos/${e.name}`);
    const candidates = [
      transcript,
      transcript.replace(/\.jsonl$/, ""),
      `file-history/${id}`,
      `session-env/${id}`,
      `debug/${id}.txt`,
      ...todos,
    ];
    const kinds = await Promise.all(candidates.map((p) => fs.kind(p)));
    return candidates.filter((_, i) => kinds[i]);
  }

  async function readManifest(id) {
    return JSON.parse(await (await fs.file(`${TRASH}/${id}/manifest.json`)).text());
  }

  const backend = {
    mode: "browser",
    writable: fs.writable,
    folderName: fs.name,
    platform: detectPlatform(),
    home: "",

    async validate() {
      if ((await fs.kind("projects")) !== "directory") {
        const hint = fs.name === "projects" ? " You picked the projects folder; pick its parent, .claude." : "";
        throw new Error(`“${fs.name}” has no projects folder, so it isn't a Claude folder.${hint}`);
      }
    },

    async listSessions() {
      const found = [];
      const projects = (await fs.list("projects")).filter((e) => e.kind === "directory");
      await Promise.all(
        projects.map(async (p) => {
          for (const e of await fs.list(`projects/${p.name}`)) {
            const id = e.name.slice(0, -".jsonl".length);
            if (e.kind === "file" && e.name.endsWith(".jsonl") && SESSION_ID_RE.test(id)) {
              found.push({ id, project: p.name, path: `projects/${p.name}/${e.name}` });
            }
          }
        }),
      );
      const files = await Promise.all(found.map((f) => fs.file(f.path)));
      const infos = await metaFor(found.map((f) => f.path), files);

      transcripts.clear();
      const sessions = await Promise.all(
        found.map(async (f, i) => {
          transcripts.set(f.id, f.path);
          const info = infos[i];
          if (!(info.userMessages || info.assistantMessages)) return null;
          const sessionDir = f.path.replace(/\.jsonl$/, "");
          const [dirSize, agents] = await Promise.all([treeSize(fs, sessionDir), subagents(sessionDir)]);
          return {
            id: f.id,
            title: info.customTitle || info.title,
            firstPrompt: info.firstPrompt,
            cwd: info.cwd,
            project: f.project,
            gitBranch: info.gitBranch,
            source: info.entrypoint === "claude-vscode" ? "vscode" : "cli",
            started: info.started,
            lastActive: info.lastActive,
            messages: info.userMessages + info.assistantMessages,
            model: info.model,
            effort: info.effort,
            usage: sumUsage([info.usage, ...agents.map((a) => a.usage)]),
            size: files[i].size + dirSize,
            subagents: agents,
          };
        }),
      );

      // Drop cache entries for deleted transcripts, then persist for the next visit.
      const live = new Set(found.map((f) => f.path));
      for (const key of Object.keys(cache)) {
        if (!live.has(key) && !key.includes("/subagents/")) delete cache[key];
      }
      idbSet(CACHE_KEY, cache);

      const result = sessions.filter(Boolean).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
      backend.home = guessHome(result);
      return result;
    },

    async readTranscript(id, agentId) {
      checkId(id);
      if (agentId !== undefined) checkId(agentId, AGENT_ID_RE);
      let path = await findTranscript(id);
      if (agentId !== undefined) path = `${path.replace(/\.jsonl$/, "")}/subagents/agent-${agentId}.jsonl`;
      return parse({ kind: "transcript", file: await fs.file(path) });
    },

    async listTrash() {
      const entries = await Promise.all(
        (await fs.list(TRASH))
          .filter((e) => e.kind === "directory")
          .map(async (e) => {
            try {
              const manifest = await readManifest(e.name);
              manifest.size = await treeSize(fs, `${TRASH}/${e.name}`);
              return manifest;
            } catch {
              return null; // not a trash entry
            }
          }),
      );
      return entries.filter(Boolean).sort((a, b) => (b.trashedAt || "").localeCompare(a.trashedAt || ""));
    },

    async trashSession(id) {
      checkId(id);
      const transcript = await findTranscript(id);
      const info = await parse({ kind: "meta", files: [await fs.file(transcript)] }).then((r) => r[0]);
      const dest = `${TRASH}/${id}`;
      if (await fs.kind(dest)) await fs.remove(dest);
      await fs.dir(dest, true);
      const items = [];
      try {
        for (const [i, src] of (await artifacts(id, transcript)).entries()) {
          const to = `${i}-${split(src).pop()}`;
          await fs.move(src, `${dest}/${to}`);
          items.push({ from: src, to });
        }
      } catch (err) {
        for (const item of items.reverse()) await fs.move(`${dest}/${item.to}`, item.from);
        await fs.remove(dest).catch(() => {});
        throw new Error(`${err.message} (is the session still open?)`);
      }
      const manifest = {
        id,
        title: info.customTitle || info.title || info.firstPrompt,
        cwd: info.cwd,
        lastActive: info.lastActive,
        trashedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        items,
      };
      await fs.writeText(`${dest}/manifest.json`, JSON.stringify(manifest, null, 2));
      transcripts.delete(id);
      return manifest;
    },

    async restoreSession(id) {
      checkId(id);
      const manifest = await readManifest(id);
      const originals = manifest.items.map((item) => relativeToRoot(item.from, fs.name));
      for (const p of originals) {
        if (split(p).includes("..")) throw new Error(`refusing to restore outside the folder: ${p}`);
        if (await fs.kind(p)) throw new Error(`already exists: ${p}`);
      }
      for (const [i, item] of manifest.items.entries()) {
        await fs.move(`${TRASH}/${id}/${item.to}`, originals[i]);
      }
      await fs.remove(`${TRASH}/${id}`);
    },

    async purgeSession(id) {
      checkId(id);
      await readManifest(id); // only delete real trash entries
      await fs.remove(`${TRASH}/${id}`);
    },

    async emptyTrash() {
      const entries = await backend.listTrash();
      for (const e of entries) await fs.remove(`${TRASH}/${e.id}`);
      return { deleted: entries.length };
    },
  };
  return backend;
}

// ---------- entry points ----------

// The folder picked on a previous visit and whether access is still granted.
export async function savedFolder() {
  if (!canWrite) return null;
  const handle = await idbGet("folder");
  if (!handle) return null;
  try {
    return { handle, permission: await handle.queryPermission({ mode: "readwrite" }) };
  } catch {
    return null;
  }
}

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: "claude-folder", mode: "readwrite" });
  return openHandle(handle);
}

export async function reconnect(handle) {
  if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
    throw new Error("Access to the folder was not granted.");
  }
  return openHandle(handle);
}

async function openHandle(handle) {
  const backend = createBackend(new HandleFS(handle));
  await backend.validate();
  await idbSet("folder", handle);
  return backend;
}

export async function openFileList(files) {
  const backend = createBackend(new FileListFS(files));
  await backend.validate();
  return backend;
}
