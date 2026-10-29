// Data source backed by serve.py's HTTP API.

async function api(method, path) {
  const res = await fetch(path, { method, headers: method === "GET" ? {} : { "X-CSM": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// A backend when the page is served by serve.py (which only binds locally), otherwise null.
export async function connectServer() {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) return null;
  let info;
  try {
    const res = await fetch("/api/info");
    if (!res.ok) return null;
    info = await res.json();
  } catch {
    return null;
  }
  if (!info?.platform) return null;
  const transcriptPath = (id, agentId) =>
    agentId === undefined
      ? `/api/sessions/${id}/transcript`
      : `/api/sessions/${id}/subagents/${encodeURIComponent(agentId)}/transcript`;
  return {
    mode: "server",
    writable: true,
    platform: info.platform,
    home: info.home,
    listSessions: () => api("GET", "/api/sessions"),
    readTranscript: (id, agentId) => api("GET", transcriptPath(id, agentId)),
    listTrash: () => api("GET", "/api/trash"),
    trashSession: (id) => api("POST", `/api/sessions/${id}/trash`),
    restoreSession: (id) => api("POST", `/api/trash/${id}/restore`),
    purgeSession: (id) => api("DELETE", `/api/trash/${id}`),
    emptyTrash: () => api("DELETE", "/api/trash"),
  };
}
