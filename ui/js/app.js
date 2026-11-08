// Claude History: the app controller. Wires the sidebar, the conversation, the
// details panel, search, usage, the archive sync and the window chrome together.
import { call, on, inApp, appWindow } from "./api.js";
import { icon } from "./icons.js";
import { esc, money, duration, ago, dateTime, effortLabel, permLabel, tokens, window_, base, int } from "./format.js";
import { Sidebar } from "./sidebar.js";
import { toTurns, turnHtml, newCtx, renderStepDetail } from "./transcript.js";
import { detailsHtml } from "./details.js";
import { renderUsage } from "./usage.js";

const $ = (id) => document.getElementById(id);
const gsap = window.gsap;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const anim = (fn) => { if (gsap && !reduceMotion) fn(gsap); };

// Fill {{icon}} placeholders in the static shell.
document.body.innerHTML = document.body.innerHTML.replace(/\{\{(\w+)\}\}/g, (_, n) => icon(n));

const state = {
  overview: null,
  sessions: [],
  byKey: new Map(),
  current: null,      // session key, "usage", or null
  data: null,         // loaded session payload
  ctx: null,          // render context of the open session
  history: [],
  hpos: -1,
  usage: null,
  loadToken: 0,
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(LS.get("ch.theme", "system"));

// ------------------------------------------------------------ helpers
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Could not copy");
  }
}

function modelName(id) {
  const m = String(id || "").toLowerCase().replace(/\[.*\]/, "").replace(/^claude-/, "");
  const parts = m.split("-");
  const fam = parts.shift() || "";
  const nums = [];
  for (const p of parts) { if (/^\d{1,2}$/.test(p)) nums.push(p); else break; }
  return (fam.charAt(0).toUpperCase() + fam.slice(1)) + (nums.length ? " " + nums.join(".") : "");
}

async function openLink(href, cwd) {
  if (!href) return;
  if (/^https?:\/\//i.test(href)) {
    if (inApp) call("open_url", { url: href }).catch((e) => toast(String(e)));
    else window.open(href, "_blank");
    return;
  }
  if (href.startsWith("#")) return;
  // a file reference like src/foo.ts:42 relative to the session folder
  let p = href.replace(/:\d+(:\d+)?$/, "").replace(/\//g, "\\");
  if (!/^[a-zA-Z]:\\/.test(p) && cwd) p = cwd.replace(/\\$/, "") + "\\" + p.replace(/^\.\\/, "");
  reveal(p);
}

function reveal(path) {
  if (!inApp) return toast(path);
  call("reveal_path", { path }).catch((e) => toast(String(e)));
}

// ------------------------------------------------------------ layout toggles
const app = $("app");
function setSidebar(show) {
  app.classList.toggle("no-sidebar", !show);
  $("btn-sidebar-show").style.display = show ? "none" : "";
  LS.set("ch.sidebar", show);
}
function setDetails(show) {
  app.classList.toggle("no-details", !show);
  $("float-ctl").style.display = show ? "none" : "flex";
  LS.set("ch.details", show);
}
setSidebar(LS.get("ch.sidebar", true));
setDetails(LS.get("ch.details", true));
$("btn-sidebar").onclick = () => setSidebar(false);
$("btn-sidebar-show").onclick = () => setSidebar(true);
$("btn-details").onclick = () => setDetails(false);
$("f-details").onclick = () => setDetails(true);

// window chrome
if (appWindow) {
  const syncMax = async () => {
    const max = await appWindow.isMaximized();
    for (const id of ["win-max", "f-max"]) $(id).innerHTML = icon(max ? "restore" : "maximize");
  };
  for (const [a, b] of [["win-min", "f-min"], ["win-max", "f-max"], ["win-close", "f-close"]]) {
    const fn = a === "win-min" ? () => appWindow.minimize() : a === "win-max" ? () => appWindow.toggleMaximize() : () => appWindow.close();
    $(a).onclick = fn;
    $(b).onclick = fn;
  }
  appWindow.onResized(syncMax);
  syncMax();
} else {
  document.querySelectorAll(".winctl").forEach((w) => (w.style.visibility = "hidden"));
}

// ------------------------------------------------------------ sidebar
const sidebar = new Sidebar($("side-list"), {
  onOpen: (key) => {
    if (key === "__search") return openPalette();
    open(key);
  },
  onMenu: (key, anchor) => rowMenu(key, anchor),
});

function setSessions(list) {
  state.sessions = list || [];
  state.byKey = new Map(state.sessions.map((s) => [s.key, s]));
  sidebar.setSessions(state.sessions);
  sidebar.setActive(state.current);
}

// ------------------------------------------------------------ menus
function showMenu(items, anchor) {
  const m = $("menu");
  m.innerHTML = items.map((it) => (it === "-" ? "<hr>" : `<button data-i="${items.indexOf(it)}">${icon(it.icon || "chevRight", "sm")}<span>${esc(it.label)}</span></button>`)).join("");
  const r = anchor.getBoundingClientRect();
  m.classList.add("show");
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
  if (y + mh > innerHeight - 8) y = r.top - mh - 6;
  m.style.left = x + "px";
  m.style.top = y + "px";
  anim((g) => g.fromTo(m, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: 0.14, ease: "power2.out" }));
  m.onclick = (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    hideMenu();
    items[Number(b.dataset.i)].run();
  };
}
function hideMenu() { $("menu").classList.remove("show"); }
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menu")) hideMenu(); });

function rowMenu(key, anchor) {
  const s = state.byKey.get(key);
  if (!s) return;
  showMenu([
    { label: "Open", icon: "chevRight", run: () => open(key) },
    { label: "Copy title", icon: "copy", run: () => copy(s.title, "Title copied") },
    { label: "Copy session ID", icon: "copy", run: () => copy(s.key, "Session ID copied") },
    ...(s.cwd ? [{ label: "Show working folder", icon: "folder", run: () => reveal(s.cwd) }] : []),
  ], anchor);
}

$("btn-menu").onclick = (e) => showMenu([
  { label: "Search sessions", icon: "search", run: openPalette },
  { label: "Usage", icon: "chart", run: () => open("usage") },
  { label: "Archive new history now", icon: "refresh", run: startSync },
  "-",
  { label: "Archive settings", icon: "settings", run: openSettings },
  { label: "Keyboard shortcuts", icon: "help", run: openShortcuts },
], e.currentTarget);

$("title-btn").onclick = (e) => {
  const d = state.data;
  if (!d || state.current === "usage") return;
  const s = d.session;
  showMenu([
    { label: "Copy conversation as Markdown", icon: "copy", run: () => copy(toMarkdown(d), "Conversation copied") },
    { label: "Copy session ID", icon: "copy", run: () => copy(s.key, "Session ID copied") },
    ...(s.cwd ? [{ label: "Show working folder", icon: "folder", run: () => reveal(s.cwd) }] : []),
    { label: "Show in sidebar", icon: "panelLeft", run: () => { setSidebar(true); sidebar.setActive(s.key); } },
  ], e.currentTarget);
};

function toMarkdown(d) {
  const out = [`# ${d.session.title}`, ""];
  for (const it of d.items) {
    if (it.kind === "user" && it.text) out.push(`## You`, "", it.text, "");
    if (it.kind === "assistant") {
      const t = (it.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
      if (t) out.push(`## Claude`, "", t, "");
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------ navigation
function pushHistory(key) {
  if (state.history[state.hpos] === key) return;
  state.history = state.history.slice(0, state.hpos + 1);
  state.history.push(key);
  state.hpos = state.history.length - 1;
}
function navButtons() {
  $("btn-back").disabled = state.hpos <= 0;
  $("btn-fwd").disabled = state.hpos >= state.history.length - 1;
}
$("btn-back").onclick = () => { if (state.hpos > 0) { state.hpos--; open(state.history[state.hpos], false); } };
$("btn-fwd").onclick = () => { if (state.hpos < state.history.length - 1) { state.hpos++; open(state.history[state.hpos], false); } };

async function open(key, push = true) {
  if (!key) return;
  if (push) pushHistory(key);
  navButtons();
  state.current = key;
  sidebar.active = key;
  sidebar.setActive(key);
  LS.set("ch.last", key);
  if (key === "usage") return showUsage();
  return showSession(key);
}

// ------------------------------------------------------------ session view
const thread = $("thread");

function setTitle(text, menu = true) {
  $("title-text").textContent = text || "";
  $("title-btn").style.display = text ? "" : "none";
  $("title-btn").querySelector("svg").style.display = menu ? "" : "none";
  document.title = text ? `${text} · Claude History` : "Claude History";
}

function emptyState() {
  setTitle("");
  $("dock").style.display = "none";
  const n = state.sessions.length;
  const cost = state.sessions.reduce((a, s) => a + (s.cost_usd || 0), 0);
  const groups = new Set(state.sessions.map((s) => s.group)).size;
  thread.innerHTML = `<div class="empty-state"><div><div class="mark"></div><h2>Your Claude history</h2><p>Every session on this computer, kept even if Claude deletes it or your plan ends.</p>
    <div class="stats"><div><b>${int(n)}</b><span>sessions</span></div><div><b>${int(groups)}</b><span>environments</span></div><div><b>${money(cost, 0)}</b><span>at API prices</span></div></div></div></div>`;
  $("details-body").innerHTML = archiveCard();
}

function archiveCard() {
  const o = state.overview || {};
  const ls = o.last_sync;
  return `<div class="dsec"><div class="dsec-h">Archive</div>
    <div class="drow link" data-reveal="${esc(o.archive || "")}">${icon("archive", "sm")}<span class="grow">${esc(base(o.archive || ""))} <span class="muted">· ${esc(o.archive || "")}</span></span></div>
    <div class="drow">${icon("clock", "sm")}<span class="grow">Last archived</span><span class="r">${ls ? esc(ago(ls.finished_ms)) : "never"}</span></div>
    ${(o.profiles || []).map((p) => `<div class="drow" title="${esc(p.path)}">${icon("laptop", "sm")}<span class="grow">${esc(p.name)}</span><span class="r">desktop profile</span></div>`).join("")}
    ${o.claude_home ? `<div class="drow" title="${esc(o.claude_home)}">${icon("terminal", "sm")}<span class="grow">Claude Code transcripts</span><span class="r">~\\.claude</span></div>` : ""}
  </div>`;
}

/** Plan state before each turn, so turns can render in any order. */
function planSnapshots(turns) {
  const snaps = [];
  let plan = null;
  const apply = (inp) => {
    if (Array.isArray(inp.items)) return inp.items.map((x) => ({ ...x }));
    if (!plan) return plan;
    const p = plan.map((x) => ({ ...x }));
    if (inp.advance) {
      const i = p.findIndex((x) => x.status === "in_progress");
      if (i >= 0) { p[i].status = "completed"; const j = p.findIndex((x, k) => k > i && x.status === "pending"); if (j >= 0) p[j].status = "in_progress"; }
    }
    for (const d of inp.done || []) if (p[d - 1]) p[d - 1].status = "completed";
    if (inp.start && p[inp.start - 1]) p[inp.start - 1].status = "in_progress";
    return p;
  };
  for (const t of turns) {
    snaps.push(plan);
    for (const it of t.flow) {
      if (it.kind !== "assistant") continue;
      for (const b of it.blocks || []) {
        if (b.type !== "tool") continue;
        if (/update_plan$/.test(b.name)) plan = apply(b.input || {});
        if (/wrap_up$/.test(b.name) && plan) plan = plan.map((x) => ({ ...x, status: "completed" }));
      }
    }
  }
  return snaps;
}

async function showSession(key) {
  const token = ++state.loadToken;
  closeFind();
  const s = state.byKey.get(key);
  setTitle(s?.title || "Loading…");
  $("dock").style.display = "";
  thread.innerHTML = `<div class="thread-inner"></div>`;
  let data;
  try {
    data = await call("get_session", { key });
  } catch (e) {
    if (token !== state.loadToken) return;
    thread.innerHTML = `<div class="empty-state"><div><h2>Couldn't open this session</h2><p>${esc(String(e))}</p></div></div>`;
    return;
  }
  if (token !== state.loadToken) return;
  state.data = data;
  const sess = data.session;
  setTitle(sess.title);

  const turns = toTurns(data.items);
  const snaps = planSnapshots(turns);
  const ctx = newCtx(data.details, modelName);
  state.ctx = ctx;
  const inner = document.createElement("div");
  inner.className = "thread-inner";
  const render = (i) => {
    ctx.plan = snaps[i];
    return turnHtml(turns[i], ctx, i === turns.length - 1);
  };
  // Render the newest turns first so the view opens instantly at the bottom, then
  // prepend older turns in small batches while keeping the reading position.
  const FIRST = 24;
  let start = Math.max(0, turns.length - FIRST);
  let html = "";
  for (let i = start; i < turns.length; i++) html += render(i);
  if (!turns.length) html = `<div class="empty-state" style="height:60vh"><div><h2 style="font-size:22px">No messages</h2><p>This session's transcript is empty or was removed before it was archived.</p></div></div>`;
  inner.innerHTML = html;
  thread.innerHTML = "";
  thread.appendChild(inner);
  thread.scrollTop = thread.scrollHeight;
  anim((g) => g.fromTo(inner, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.28, ease: "power2.out" }));

  const prependBatch = () => {
    if (token !== state.loadToken || start <= 0) return;
    const from = Math.max(0, start - 30);
    let h = "";
    for (let i = from; i < start; i++) h += render(i);
    start = from;
    const before = thread.scrollHeight;
    const top = thread.scrollTop;
    inner.insertAdjacentHTML("afterbegin", h);
    thread.scrollTop = top + (thread.scrollHeight - before);
    requestAnimationFrame(prependBatch);
  };
  requestAnimationFrame(prependBatch);

  renderDock(data);
  $("details-body").innerHTML = detailsHtml(data);
  $("details-body").scrollTop = 0;
}

function renderDock(data) {
  const s = data.session;
  const d = data.details;
  const t = d.time || {};
  const span = t.last && t.first ? t.last - t.first : 0;
  $("status-strip").innerHTML = `
    <span><span class="dotlive" style="background:${s.archived ? "var(--text-4)" : "var(--green)"}"></span>${s.archived ? "archived" : "active"}</span>
    <span>${money(s.cost_usd)}</span>
    <span>${duration(d.cost?.wall_ms || span)}</span>
    ${s.prompts ? `<span>${s.prompts === 1 ? "1 prompt" : int(s.prompts) + " prompts"}</span>` : ""}
    <div class="right">
      <button data-jump="d-context">Context</button>
      <button data-jump="d-cost">Cost</button>
      <button data-jump="d-outputs">Outputs</button>
      <button data-jump="d-env">Details</button>
    </div>`;
  const ctx = d.context;
  const pct = ctx ? Math.min(1, ctx.total / ctx.window) : 0;
  const R = 6.5, C = 2 * Math.PI * R;
  const ring = `<svg class="ring" viewBox="0 0 16 16" title="Context"><circle cx="8" cy="8" r="${R}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2"/><circle cx="8" cy="8" r="${R}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="${(C * pct).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 8 8)" stroke-linecap="round"/></svg>`;
  $("composer-ph").innerHTML = `Read only <b>· archived ${esc(dateTime(s.updated_ms))}</b>`;
  $("composer-meta").innerHTML = `
    ${s.model_name ? `<span>${esc(s.model_name)} <span class="dim">${esc(effortLabel(s.effort))}</span></span>` : ""}
    ${s.permission_mode ? `<span>${esc(permLabel(s.permission_mode))}</span>` : ""}
    <span title="${ctx ? `${tokens(ctx.total)} of ${window_(ctx.window)} context` : "No context data"}">${ring}</span>`;
}

$("status-strip").addEventListener("click", (e) => {
  const b = e.target.closest("[data-jump]");
  if (!b) return;
  setDetails(true);
  const el = document.getElementById(b.dataset.jump);
  if (el) {
    const body = $("details-body");
    body.scrollTo({ top: el.offsetTop - 10, behavior: reduceMotion ? "auto" : "smooth" });
    anim((g) => g.fromTo(el, { backgroundColor: "rgba(217,119,87,.10)" }, { backgroundColor: "rgba(217,119,87,0)", duration: 1.2 }));
  }
});

// jump-to-latest button
const toBottom = $("to-bottom");
thread.addEventListener("scroll", () => {
  const far = thread.scrollHeight - thread.scrollTop - thread.clientHeight > 600;
  toBottom.classList.toggle("show", far && state.current !== "usage");
});
toBottom.onclick = () => thread.scrollTo({ top: thread.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });

// transcript interactions (the main thread and agent transcripts share them)
function transcriptClick(e, ctx, cliId, cwd) {
  const t = e.target;
  const stepsH = t.closest(".steps-h");
  if (stepsH) {
    const box = stepsH.parentElement;
    box.classList.toggle("open");
    if (box.classList.contains("open")) anim((g) => g.fromTo(box.querySelector(".steps-body"), { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }));
    return;
  }
  const stepH = t.closest(".step-h");
  if (stepH) {
    const step = stepH.parentElement;
    const d = step.querySelector(".step-d");
    if (!d.dataset.filled) {
      const b = ctx?.tools[step.dataset.tool];
      d.innerHTML = b ? renderStepDetail(b, ctx) : "";
      d.dataset.filled = "1";
    }
    step.classList.toggle("open");
    return;
  }
  const cp = t.closest("[data-copy]");
  if (cp) return copy(cp.closest(".codeblock").querySelector("pre").innerText, "Code copied");
  const cpt = t.closest("[data-copy-text]");
  if (cpt) return copy(cpt.closest(".io").querySelector("pre")?.innerText || "", "Copied");
  const turnCopy = t.closest("[data-copy-turn]");
  if (turnCopy) return copy(ctx?.turnTexts[turnCopy.dataset.copyTurn] || "", "Response copied");
  const ucopy = t.closest("[data-copy-user]");
  if (ucopy) return copy(ucopy.closest(".msg-user").querySelector(".bubble")?.innerText || "", "Message copied");
  const exp = t.closest("[data-expand]");
  if (exp) {
    const b = exp.previousElementSibling;
    b.classList.toggle("clamped");
    exp.textContent = b.classList.contains("clamped") ? "Show more" : "Show less";
    return;
  }
  const co = t.closest(".cmdout");
  if (co && !window.getSelection().toString()) { co.classList.toggle("open"); return; }
  const z = t.closest("img[data-zoom], .thumbs img");
  if (z) return zoom(z.src);
  const sub = t.closest("[data-subagent]");
  if (sub) return openSubagent(cliId, sub.dataset.subagent);
  const link = t.closest("[data-href]");
  if (link) return openLink(link.dataset.href, cwd);
}
thread.addEventListener("click", (e) => transcriptClick(e, state.ctx, state.data?.session?.cli_id, state.data?.session?.cwd));

// details panel interactions
$("details-body").addEventListener("click", (e) => {
  const t = e.target;
  const ex = t.closest("[data-exp]");
  if (ex) return ex.classList.toggle("open");
  const link = t.closest("[data-href]");
  if (link) return openLink(link.dataset.href);
  const rv = t.closest("[data-reveal]");
  if (rv) return reveal(rv.dataset.reveal);
  const sub = t.closest("[data-subagent]");
  if (sub) return openSubagent(sub.dataset.cli, sub.dataset.subagent);
  const cv = t.closest("[data-copy-val]");
  if (cv) return copy(cv.dataset.copyVal, "Copied");
  const sy = t.closest("[data-sync]");
  if (sy) return startSync();
});

// ------------------------------------------------------------ overlays
function zoom(src) {
  $("lightbox-img").src = src;
  $("lightbox").classList.add("show");
  anim((g) => g.fromTo("#lightbox-img", { scale: 0.96, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.18 }));
}
$("lightbox").onclick = () => $("lightbox").classList.remove("show");

function openSheet(titleHtml, bodyHtml) {
  $("sheet-h").innerHTML = `${titleHtml}<button class="ibtn" id="sheet-x">${icon("x")}</button>`;
  $("sheet-b").innerHTML = bodyHtml;
  $("sheet").classList.add("show");
  $("scrim").classList.add("show");
  $("sheet-x").onclick = closeOverlays;
  anim((g) => g.fromTo("#sheet", { opacity: 0, y: 10, scale: 0.99 }, { opacity: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out" }));
}

async function openSubagent(cliId, agentId) {
  if (!cliId || !agentId) return;
  openSheet(`${icon("bot", "sm")} Agent <span class="sub">loading…</span>`, "");
  try {
    const d = await call("get_subagent", { cliId, agentId });
    const turns = toTurns(d.items);
    const ctx = newCtx({}, modelName);
    const meta = d.meta || {};
    $("sheet-h").firstChild && ($("sheet-h").innerHTML = `${icon("bot", "sm")} ${esc(meta.description || "Agent")} <span class="sub">${esc(meta.agentType || "")}</span><button class="ibtn" id="sheet-x">${icon("x")}</button>`);
    $("sheet-x").onclick = closeOverlays;
    $("sheet-b").innerHTML = `<div class="thread-inner" style="padding:10px 0 20px">${turns.map((t, i) => turnHtml(t, ctx, i === turns.length - 1)).join("")}</div>`;
    $("sheet-b").onclick = (e) => transcriptClick(e, ctx, cliId, state.data?.session?.cwd);
  } catch (e) {
    $("sheet-b").innerHTML = `<div class="empty-row">${esc(String(e))}</div>`;
  }
}

function closeOverlays() {
  for (const id of ["palette", "sheet", "lightbox", "scrim"]) $(id).classList.remove("show");
  hideMenu();
}
$("scrim").onclick = closeOverlays;

// ------------------------------------------------------------ search palette
let palSel = 0;
let palItems = [];
let palTimer = null;
function openPalette() {
  $("palette").classList.add("show");
  $("scrim").classList.add("show");
  const inp = $("palette-input");
  inp.value = "";
  paletteResults("");
  setTimeout(() => inp.focus(), 10);
  anim((g) => g.fromTo("#palette", { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }));
}
$("btn-search").onclick = openPalette;

function hl(text, q) {
  const s = esc(text);
  if (!q) return s;
  const i = s.toLowerCase().indexOf(esc(q).toLowerCase());
  if (i < 0) return s;
  return s.slice(0, i) + "<mark>" + s.slice(i, i + esc(q).length) + "</mark>" + s.slice(i + esc(q).length);
}

function drawPalette(q) {
  const res = $("palette-res");
  res.innerHTML = palItems.map((it, i) => {
    const s = state.byKey.get(it.key);
    if (!s) return "";
    return `<div class="presult ${i === palSel ? "sel" : ""}" data-k="${esc(s.key)}"><div class="l1"><span>${hl(s.title, q)}</span><span class="g">${esc(s.group)} · ${esc(ago(s.updated_ms))}</span></div>${it.snippet ? `<div class="l2">${hl(it.snippet, q)}</div>` : ""}</div>`;
  }).join("") || `<div class="empty-row" style="padding:14px">No sessions match.</div>`;
  $("palette-count").textContent = q ? `${palItems.length} found` : "Recent";
  res.querySelector(".presult.sel")?.scrollIntoView({ block: "nearest" });
}

function paletteResults(q) {
  q = q.trim();
  if (!q) {
    palItems = state.sessions.slice(0, 30).map((s) => ({ key: s.key, snippet: "" }));
    palSel = 0;
    return drawPalette("");
  }
  const ql = q.toLowerCase();
  palItems = state.sessions.filter((s) => s.title.toLowerCase().includes(ql)).slice(0, 40).map((s) => ({ key: s.key, snippet: "" }));
  palSel = 0;
  drawPalette(q);
  clearTimeout(palTimer);
  palTimer = setTimeout(async () => {
    const hits = await call("search", { query: q }).catch(() => []);
    if ($("palette-input").value.trim() !== q) return;
    const seen = new Set(palItems.map((x) => x.key));
    for (const h of hits) {
      const existing = palItems.find((x) => x.key === h.key);
      if (existing) existing.snippet = existing.snippet || h.snippet;
      else if (!seen.has(h.key)) palItems.push(h);
    }
    drawPalette(q);
  }, 160);
}
$("palette-input").addEventListener("input", (e) => paletteResults(e.target.value));
$("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(e.target.value.trim()); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel = Math.max(0, palSel - 1); drawPalette(e.target.value.trim()); e.preventDefault(); }
  else if (e.key === "Enter") { const it = palItems[palSel]; if (it) { closeOverlays(); open(it.key); } }
  else if (e.key === "Escape") closeOverlays();
});
$("palette-res").addEventListener("click", (e) => {
  const r = e.target.closest(".presult");
  if (r) { closeOverlays(); open(r.dataset.k); }
});

// ------------------------------------------------------------ usage
async function showUsage() {
  state.loadToken++;
  closeFind();
  setTitle("Usage", false);
  $("dock").style.display = "none";
  thread.innerHTML = `<div class="usage"><h1>Usage</h1><div class="lede">Adding up your archive…</div></div>`;
  try {
    state.usage = await call("usage");
    renderUsage(thread, state.usage);
    anim((g) => g.fromTo("#thread .tile, #thread .panel", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.04, ease: "power2.out" }));
  } catch (e) {
    thread.innerHTML = `<div class="empty-state"><div><h2>Usage unavailable</h2><p>${esc(String(e))}</p></div></div>`;
  }
  $("details-body").innerHTML = archiveCard();
}
$("btn-usage").onclick = () => open("usage");

// ------------------------------------------------------------ archive sync
let syncing = false;
function syncStripIdle() {
  const ls = state.overview?.last_sync;
  const when = ls ? ago(ls.finished_ms) : "never";
  const errs = ls?.errors?.length ? ` · ${ls.errors.length} errors` : "";
  $("sync-strip").innerHTML = `<div class="row">${icon("archive", "xs")}<span>Archived ${esc(when)}${esc(errs)}</span><button data-sync title="Copy new history into the archive">Sync now</button></div>`;
  $("sync-strip").querySelector("[data-sync]").onclick = startSync;
}
function syncStripProgress(label, done, total) {
  const pct = total ? Math.min(100, (done / total) * 100) : 4;
  $("sync-strip").innerHTML = `<div class="row">${icon("refresh", "xs")}<span>${esc(label)}${total ? ` ${int(done)} / ${int(total)}` : ""}</span></div><div class="track"><div class="fill" style="width:${pct}%"></div></div>`;
}

async function startSync() {
  if (!inApp) return toast("Archiving runs in the app");
  if (syncing) return;
  const started = await call("start_sync").catch(() => false);
  if (started) {
    syncing = true;
    syncStripProgress("Looking for new history…", 0, 0);
    $("btn-sync").classList.add("on");
  }
}

on("sync-progress", (p) => syncStripProgress(p.phase === "scanning" ? "Looking for new history…" : "Archiving files", p.done, p.total));
on("index-progress", (p) => syncStripProgress("Indexing sessions", p.done, p.total));
on("index-updated", (ov) => {
  syncing = false;
  $("btn-sync").classList.remove("on");
  state.overview = ov;
  setSessions(ov.sessions);
  syncStripIdle();
  const copied = ov.last_sync?.copied || 0;
  if (copied) toast(`Archived ${int(copied)} new or changed files`);
  if (!state.current) emptyState();
});
$("btn-sync").onclick = startSync;

// ------------------------------------------------------------ settings + shortcuts
function openSettings() {
  const o = state.overview || {};
  const ls = o.last_sync || {};
  openSheet(`${icon("settings", "sm")} Archive`, `
    <div style="max-width:620px;padding-top:14px">
      <p class="prose" style="font-size:14.5px">Claude History keeps its own copy of your Claude Code transcripts and the desktop app's session list, so they stay readable after Claude cleans up old sessions, after an uninstall, or once a subscription ends. Files are only ever added or updated here, never deleted.</p>
      ${archiveCard()}
      <div class="dsec"><div class="dsec-h">Last run</div><dl class="kv">
        <dt>Finished</dt><dd>${esc(ls.finished_ms ? dateTime(ls.finished_ms) : "never")}</dd>
        <dt>Files checked</dt><dd>${int(ls.scanned)}</dd>
        <dt>New or changed</dt><dd>${int(ls.copied)} (${((ls.bytes_copied || 0) / 1e6).toFixed(1)} MB)</dd>
        <dt>Kept after shrinking at the source</dt><dd>${int(ls.preserved)}</dd>
        <dt>Took</dt><dd>${duration(ls.duration_ms)}</dd>
      </dl>${(ls.errors || []).length ? `<div class="cost-sub" style="margin-top:10px">${ls.errors.map(esc).join("<br>")}</div>` : ""}</div>
      <div class="dsec"><div class="dsec-h">Appearance</div><div class="filter-chips" style="padding:2px 0 6px">
        ${["system", "light", "dark"].map((t) => `<button class="chip ${LS.get("ch.theme", "system") === t ? "on" : ""}" data-theme-set="${t}">${t === "system" ? "Match Windows" : t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
      </div></div>
      <div class="dsec"><div class="dsec-h">Archive without opening the app</div>
        <p class="prose" style="font-size:14px">Run <code>claude-history.exe --sync</code> from a scheduled task to keep the archive current in the background.</p></div>
      <button class="pill primary" data-sync style="margin-top:8px">${icon("refresh", "sm")} Archive new history now</button>
    </div>`);
  $("sheet-b").onclick = (e) => {
    const th = e.target.closest("[data-theme-set]");
    if (th) {
      LS.set("ch.theme", th.dataset.themeSet);
      applyTheme(th.dataset.themeSet);
      $("sheet-b").querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b === th));
      return;
    }
    if (e.target.closest("[data-sync]")) { closeOverlays(); startSync(); }
    const rv = e.target.closest("[data-reveal]");
    if (rv) reveal(rv.dataset.reveal);
  };
}
$("btn-settings").onclick = openSettings;

function openShortcuts() {
  const rows = [["Ctrl K", "Search sessions"], ["Ctrl F", "Find in this conversation"], ["Ctrl B", "Show or hide the sidebar"], ["Ctrl .", "Show or hide details"], ["Alt ↑ / Alt ↓", "Previous / next session"], ["Alt ← / Alt →", "Back / forward"], ["Ctrl U", "Usage"], ["End", "Jump to the latest message"], ["Esc", "Close"]];
  openSheet(`${icon("help", "sm")} Keyboard shortcuts`, `<dl class="kv" style="max-width:420px;padding-top:16px;font-size:14px">${rows.map(([k, v]) => `<dt>${esc(v)}</dt><dd>${esc(k)}</dd>`).join("")}</dl>`);
}

// ------------------------------------------------------------ find in conversation
const find = { ranges: [], i: -1 };
function openFind() {
  if (!state.data || state.current === "usage") return;
  $("findbar").classList.add("show");
  const inp = $("find-input");
  inp.focus();
  inp.select();
  if (inp.value) runFind(inp.value);
}
function closeFind() {
  $("findbar").classList.remove("show");
  if (window.CSS && CSS.highlights) { CSS.highlights.delete("find"); CSS.highlights.delete("find-cur"); }
  find.ranges = [];
  find.i = -1;
}
function runFind(q) {
  find.ranges = [];
  find.i = -1;
  if (!window.CSS || !CSS.highlights) return;
  CSS.highlights.delete("find");
  CSS.highlights.delete("find-cur");
  q = q.trim().toLowerCase();
  if (q.length < 2) { $("find-count").textContent = ""; return; }
  const root = thread.querySelector(".thread-inner");
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(".steps:not(.open) .steps-body, .katex-mathml, .turn-foot") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.data.toLowerCase();
    let at = text.indexOf(q);
    while (at >= 0 && find.ranges.length < 2000) {
      const r = new Range();
      r.setStart(node, at);
      r.setEnd(node, at + q.length);
      find.ranges.push(r);
      at = text.indexOf(q, at + q.length);
    }
  }
  CSS.highlights.set("find", new Highlight(...find.ranges));
  // start from the match nearest the bottom of the view, like reading upward
  if (find.ranges.length) step(find.ranges.length - 1, true);
  else $("find-count").textContent = "No results";
}
function step(to, absolute = false) {
  const n = find.ranges.length;
  if (!n) return;
  find.i = absolute ? to : (find.i + to + n) % n;
  const r = find.ranges[find.i];
  CSS.highlights.set("find-cur", new Highlight(r));
  $("find-count").textContent = `${find.i + 1} of ${n}`;
  const box = r.getBoundingClientRect();
  const tb = thread.getBoundingClientRect();
  if (box.top < tb.top + 60 || box.bottom > tb.bottom - 180) thread.scrollTop += box.top - tb.top - tb.height / 3;
}
let findTimer = null;
$("find-input").addEventListener("input", (e) => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(e.target.value), 140); });
$("find-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  if (e.key === "Escape") { e.stopPropagation(); closeFind(); }
});
$("find-prev").onclick = () => step(-1);
$("find-next").onclick = () => step(1);
$("find-x").onclick = closeFind;

// ------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  const inField = e.target.matches("input, textarea");
  if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
  if (e.key === "Escape") { closeOverlays(); closeFind(); return; }
  if (inField) return;
  if (e.ctrlKey && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebar(app.classList.contains("no-sidebar")); }
  else if (e.ctrlKey && e.key === ".") { e.preventDefault(); setDetails(app.classList.contains("no-details")); }
  else if (e.ctrlKey && e.key.toLowerCase() === "u") { e.preventDefault(); open("usage"); }
  else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const order = sidebar.order();
    const i = order.indexOf(state.current);
    const j = e.key === "ArrowUp" ? Math.max(0, i - 1) : Math.min(order.length - 1, i + 1);
    if (order[j]) open(order[j]);
  } else if (e.altKey && e.key === "ArrowLeft") $("btn-back").click();
  else if (e.altKey && e.key === "ArrowRight") $("btn-fwd").click();
  else if (e.key === "End" && !e.ctrlKey) thread.scrollTo({ top: thread.scrollHeight });
});
// mouse back/forward buttons
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) $("btn-back").click();
  if (e.button === 4) $("btn-fwd").click();
});

// ------------------------------------------------------------ boot
(async function boot() {
  navButtons();
  try {
    state.overview = await call("bootstrap");
  } catch (e) {
    thread.innerHTML = `<div class="empty-state"><div><h2>Couldn't read the archive</h2><p>${esc(String(e))}</p></div></div>`;
    return;
  }
  const ov = state.overview;
  const home = (ov.claude_home || "").split(/[\\/]/).filter(Boolean);
  const user = home.length >= 2 ? home[home.length - 2] : "you";
  $("who-name").textContent = user;
  $("avatar").textContent = (user[0] || "C").toUpperCase();
  setSessions(ov.sessions);
  syncStripIdle();
  const want = new URLSearchParams(location.search).get("open") || ov.open;
  const last = want || LS.get("ch.last", null);
  if (last && (last === "usage" || state.byKey.has(last))) open(last);
  else emptyState();
  anim((g) => g.fromTo("#side-list .group, #side-list .nav-row", { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25, stagger: 0.012, ease: "power2.out" }));
  // Archive anything new since the last run, every launch.
  startSync();
})();
