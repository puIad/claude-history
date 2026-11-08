// Bridge to the Rust backend. Outside Tauri (plain browser, for UI testing)
// it falls back to JSON files written by `claude-history --dump`.
const T = window.__TAURI__;
export const inApp = !!(T && T.core);

let mock = null;
async function mockMod() {
  if (!mock) mock = await import("./mock.js");
  return mock;
}

export async function call(cmd, args = {}) {
  if (inApp) return T.core.invoke(cmd, args);
  return (await mockMod()).invoke(cmd, args);
}

export function on(evt, cb) {
  if (inApp) return T.event.listen(evt, (e) => cb(e.payload));
  return Promise.resolve(() => {});
}

export const appWindow = inApp ? T.window.getCurrentWindow() : null;
