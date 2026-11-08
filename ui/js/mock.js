// Browser-only stand-in for the Rust backend, used to test the UI outside the app.
// Data comes from `claude-history --dump <dir>`; pass ?data=<url of that dir>.
const root = new URLSearchParams(location.search).get("data") || "../archive/.dev/";
const get = async (p) => {
  const r = await fetch(root + p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};
let boot = null;

export async function invoke(cmd, args) {
  switch (cmd) {
    case "bootstrap":
      boot = boot || (await get("bootstrap.json"));
      return boot;
    case "get_session":
      return get(`sessions/${args.key}.json`);
    case "get_subagent":
      return get(`subagents/${args.agentId}.json`);
    case "usage":
      return get("usage.json");
    case "search": {
      boot = boot || (await get("bootstrap.json"));
      const q = (args.query || "").toLowerCase();
      return boot.sessions.filter((s) => (s.title + " " + s.first_prompt).toLowerCase().includes(q)).slice(0, 50).map((s) => ({ key: s.key, snippet: s.first_prompt.slice(0, 140) }));
    }
    case "start_sync":
      return false;
    default:
      return null;
  }
}
