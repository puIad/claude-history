// Renders a session's items the way the desktop app's Code tab shows them:
// prose, user bubbles, collapsed "Ran a command, read 2 files ›" activity
// groups that open into steps, and cards for plans, questions and artifacts.
import { esc, ago, dateTime, base, plural, money, duration } from "./format.js";
import { icon, toolIcon } from "./icons.js";
import { md, codeBlockHtml, highlight } from "./markdown.js";

// ------------------------------------------------------------ classification
const CARD_TOOLS = new Set(["AskUserQuestion", "TodoWrite", "ExitPlanMode", "Artifact"]);
const isPlan = (n) => /update_plan$/.test(n);
const isWrap = (n) => /wrap_up$/.test(n);
const isChapter = (n) => /mark_chapter$/.test(n);
const isStartSession = (n) => /ccd_session__start_session$/.test(n) || /hand_off_to_session$/.test(n);
const isCard = (b) => {
  const n = b.name || "";
  if (n === "Artifact") return (b.input?.action || "publish") === "publish" && !b.input?.asset;
  return CARD_TOOLS.has(n) || isWrap(n) || isChapter(n) || isStartSession(n);
};
const isSilent = (n) => isPlan(n) || /read_widget_context$/.test(n);

function mcpParts(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

function serverLabel(server) {
  const s = server.toLowerCase();
  if (s.includes("browser") || s.includes("playwright") || s.includes("chrome")) return "the browser";
  if (s.includes("computer-use")) return "the computer";
  if (s.startsWith("ccd_")) return "Claude";
  if (s.includes("context7")) return "Context7";
  if (s.includes("telegram")) return "Telegram";
  if (/^[0-9a-f-]{20,}$/.test(s)) return "a connector";
  return server.replace(/[_-]+/g, " ");
}

const CCD = {
  ccd_session: "managed sessions", ccd_session_mgmt: "managed sessions", ccd_pr: "checked the pull request",
  ccd_sidebar: "organised the sidebar", ccd_view: "opened a pane", ccd_window: "arranged windows",
  ccd_settings: "checked app settings", ccd_host: "used the app", ccd_directory: "changed folders",
  ccd_connectors: "checked connectors", ccd_turn: "updated the task list",
};

function category(b) {
  const n = b.name || "";
  if (/^(Bash|PowerShell)$/.test(n)) return "cmd";
  if (/^(BashOutput|KillShell|KillBash|TaskOutput|TaskStop|Monitor)$/.test(n)) return "bg";
  if (n === "Read" || n === "NotebookRead") return "read";
  if (n === "Write") return "write";
  if (/Edit$/.test(n)) return "edit";
  if (n === "Grep" || n === "Glob") return "search";
  if (n === "WebSearch" || n === "web_search") return "websearch";
  if (n === "WebFetch" || n === "web_fetch") return "webfetch";
  if (n === "Agent" || n === "Task") return "agent";
  if (n === "Skill") return "skill";
  if (n === "ToolSearch") return "toolsearch";
  if (n === "SubagentHandback" || n === "StructuredOutput") return "handback";
  if (n.startsWith("mcp__")) return "mcp:" + mcpParts(n).server;
  return "other";
}

function phrase(cat, list) {
  const n = list.length;
  const uniq = (k) => new Set(list.map((b) => b.input?.[k] || b.id)).size;
  switch (cat) {
    case "cmd": return n === 1 ? "ran a command" : `ran ${n} commands`;
    case "bg": return n === 1 ? "checked a background task" : `checked ${n} background tasks`;
    case "read": { const u = uniq("file_path"); return u === 1 ? "read a file" : `read ${u} files`; }
    case "write": { const u = uniq("file_path"); return u === 1 ? "created a file" : `created ${u} files`; }
    case "edit": { const u = uniq("file_path"); return u === 1 ? "edited a file" : `edited ${u} files`; }
    case "search": return n === 1 ? "searched code" : `searched code ${n} times`;
    case "websearch": return n === 1 ? "searched the web" : `searched the web ${n} times`;
    case "webfetch": return n === 1 ? "fetched a page" : `fetched ${n} pages`;
    case "agent": return n === 1 ? "ran an agent" : `ran ${n} agents`;
    case "skill": return n === 1 ? `ran skill /${list[0].input?.skill || list[0].input?.command || "skill"}` : `ran ${n} skills`;
    case "toolsearch": return "loaded tools";
    case "handback": return "handed back the result";
    case "other": return n === 1 ? `used ${list[0].name}` : `used ${n} tools`;
    default:
      if (cat.startsWith("mcp:")) {
        const srv = cat.slice(4);
        if (CCD[srv]) return srv === "ccd_session" || srv === "ccd_session_mgmt" ? (n === 1 ? "managed a session" : `managed sessions ${n} times`) : CCD[srv];
        return `used ${serverLabel(srv)}`;
      }
      return `used ${n} tools`;
  }
}

function groupLabel(blocks) {
  const note = blocks.find((b) => b.type === "thinking" && b.text && b.text.trim());
  if (note) return note.text.trim().split("\n")[0].replace(/[.:]\s*$/, "");
  const order = [];
  const by = new Map();
  for (const b of blocks) {
    if (b.type !== "tool") continue;
    const c = category(b);
    if (!by.has(c)) { by.set(c, []); order.push(c); }
    by.get(c).push(b);
  }
  if (!order.length) return "Thought for a moment";
  const s = order.map((c) => phrase(c, by.get(c))).join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------ step headers
function stepHead(b) {
  const n = b.name || "";
  const inp = b.input || {};
  const code = (s) => `<code>${esc(String(s).split("\n")[0].slice(0, 160))}</code>`;
  if (n === "Bash" || n === "PowerShell") return [inp.description || (n === "Bash" ? "Ran a command" : "Ran PowerShell"), code(inp.command || "")];
  if (n === "Read") return ["Read", esc(base(inp.file_path)) + (inp.offset ? ` <span>· from line ${inp.offset}</span>` : "")];
  if (n === "Write") return ["Created", esc(base(inp.file_path))];
  if (n === "Edit" || n === "MultiEdit") return ["Edited", esc(base(inp.file_path))];
  if (n === "NotebookEdit") return ["Edited notebook", esc(base(inp.notebook_path || inp.file_path))];
  if (n === "Grep") return ["Searched", code(inp.pattern || "") + (inp.path ? ` in ${esc(base(inp.path))}` : "")];
  if (n === "Glob") return ["Found files", code(inp.pattern || "")];
  if (n === "WebSearch" || n === "web_search") return ["Searched the web", esc(inp.query || "")];
  if (n === "WebFetch" || n === "web_fetch") return ["Fetched", esc(inp.url || "")];
  if (n === "Agent" || n === "Task") return [inp.description || "Ran an agent", esc(inp.subagent_type || "agent")];
  if (n === "Skill") return ["Ran skill", esc("/" + (inp.skill || inp.command || ""))];
  if (n === "ToolSearch") return ["Loaded tools", esc(inp.query || "")];
  if (n === "SubagentHandback" || n === "StructuredOutput") return ["Handed back the result", ""];
  if (n === "Artifact") return ["Artifact", esc(inp.action || "publish") + (inp.file_path ? " · " + esc(base(inp.file_path)) : "")];
  const m = mcpParts(n);
  if (m) {
    const desc = inp.action_summary || inp.description || inp.url || inp.query || inp.action || inp.text || "";
    return [`${serverLabel(m.server).replace(/^the /, "").replace(/^\w/, (c) => c.toUpperCase())} · ${m.tool.replace(/_/g, " ")}`, esc(String(desc).slice(0, 140))];
  }
  return [n, esc(inp.description || "")];
}

function langOf(path) {
  const ext = (String(path || "").split(".").pop() || "").toLowerCase();
  return { rs: "rust", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", py: "python", json: "json", md: "markdown", html: "xml", css: "css", toml: "ini", yml: "yaml", yaml: "yaml", ps1: "powershell", sh: "bash", sql: "sql", go: "go", java: "java", cs: "csharp", tex: "latex" }[ext] || "";
}

function ioBox(label, body, opts = {}) {
  const cls = opts.err ? "io err" : "io";
  return `<div class="${cls}"><div class="io-h">${esc(label)}<button class="ibtn" data-copy-text title="Copy">${icon("copy", "xs")}</button></div>${body}</div>`;
}

function preBox(label, text, lang, opts = {}) {
  if (text == null || text === "") return "";
  const html = lang ? highlight(text, lang) : esc(text);
  const trunc = opts.truncated ? `<div class="trunc">Output trimmed to ${Math.round(text.length / 1000)}k of ${Math.round((opts.full || 0) / 1000)}k characters</div>` : "";
  return ioBox(label, `<pre data-raw>${html}</pre>${trunc}`, opts);
}

function diffHtml(patch) {
  let out = "";
  for (const h of patch || []) {
    out += `<div class="hunk">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>`;
    for (const l of h.lines || []) {
      const c = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
      out += `<span class="ln ${c}">${esc(l)}</span>`;
    }
  }
  return `<div class="io"><div class="diff">${out}</div></div>`;
}

function simpleDiff(oldS, newS) {
  const a = String(oldS || "").split("\n").map((l) => `<span class="ln del">-${esc(l)}</span>`).join("");
  const b = String(newS || "").split("\n").map((l) => `<span class="ln add">+${esc(l)}</span>`).join("");
  return `<div class="io"><div class="diff">${a}${b}</div></div>`;
}

function imagesHtml(list) {
  if (!list || !list.length) return "";
  return `<div class="imgs">${list.map((s) => `<img src="${esc(s)}" data-zoom loading="lazy" alt="">`).join("")}</div>`;
}

export function stepDetail(b, ctx) {
  const n = b.name || "";
  const inp = b.input || {};
  const r = b.result || {};
  const err = !!r.error;
  let html = "";
  if (n === "Bash" || n === "PowerShell") {
    html += preBox(n === "Bash" ? "bash" : "powershell", inp.command || "", n === "Bash" ? "bash" : "powershell");
  } else if (n === "Edit" || n === "MultiEdit") {
    if (r.patch && r.patch.length) html += diffHtml(r.patch);
    else if (n === "Edit") html += simpleDiff(inp.old_string, inp.new_string);
    else html += preBox("edits", JSON.stringify(inp.edits || [], null, 2), "json");
  } else if (n === "Write") {
    html += preBox(base(inp.file_path), inp.content || "", langOf(inp.file_path));
  } else if (n === "Agent" || n === "Task") {
    html += ioBox("prompt", `<div class="prose" style="padding:6px 12px 10px;font-size:14px">${md(inp.prompt || "")}</div>`);
    const agentId = r.agentId || (ctx.subagents || []).find((s) => s.tool_use_id === b.id)?.agent_id;
    if (agentId) html += `<button class="pill" data-subagent="${esc(agentId)}" style="margin:4px 0 8px">${icon("bot", "sm")} Open agent transcript</button>`;
  } else if (n === "Read" || n === "Grep" || n === "Glob" || n === "WebFetch" || n === "WebSearch" || n === "Skill" || n === "ToolSearch") {
    // the result says it all; show the call compactly
    const show = { ...inp };
    html += preBox("input", JSON.stringify(show, null, 2), "json");
  } else {
    html += preBox("input", JSON.stringify(inp, null, 2), "json");
  }
  if (b.result) {
    const text = r.text || "";
    const lang = n === "Read" ? langOf(inp.file_path) : "";
    const body = n === "Read" ? text.replace(/^\s*\d+\t/gm, "") : text;
    if (n !== "Edit" || err) html += preBox(err ? "error" : "output", body, lang, { err, truncated: r.truncated, full: r.full_len });
    if (r.images && r.images.length) html += `<div class="io">${imagesHtml(r.images)}</div>`;
    if (n === "Agent" && (r.totalDurationMs || r.totalTokens)) {
      html += `<div class="sysrow">${icon("clock", "xs")} ${duration(r.totalDurationMs)} · ${Number(r.totalTokens || 0).toLocaleString()} tokens · ${r.totalToolUseCount || 0} tool uses</div>`;
    }
  } else {
    html += `<div class="sysrow">${icon("alert", "xs")} No result recorded (interrupted or still running when the session ended)</div>`;
  }
  return html;
}

function stepHtml(b) {
  const [name, desc] = stepHead(b);
  const r = b.result;
  const state = !r ? `<span class="state">no result</span>` : r.error ? `<span class="state bad">error</span>` : "";
  return `<div class="step" data-tool="${esc(b.id)}"><button class="step-h"><span class="sico">${icon(toolIcon(b.name), "xs")}</span><span class="tname">${esc(name)}</span><span class="tdesc">${desc}</span>${state}</button><div class="step-d"></div></div>`;
}

function groupHtml(blocks, gid) {
  const tools = blocks.filter((b) => b.type === "tool");
  const label = groupLabel(blocks);
  const imgs = tools.flatMap((b) => (b.result?.images || [])).slice(-3);
  const errs = tools.filter((b) => b.result?.error).length;
  const thumbs = imgs.length ? `<span class="thumbs">${imgs.map((s) => `<img src="${esc(s)}" alt="">`).join("")}</span>` : "";
  const err = errs ? `<span class="err">${plural(errs, "error")}</span>` : "";
  const notes = blocks.filter((b) => b.type === "thinking" && b.text && b.text.trim()).slice(1);
  const body = tools.map(stepHtml).join("") + notes.map((t) => `<div class="sysrow">${icon("brain", "xs")} ${esc(t.text.trim())}</div>`).join("");
  if (!tools.length && !notes.length) return "";
  return `<div class="steps" data-group="${gid}"><button class="steps-h"><span class="lbl">${esc(label)}</span>${icon("chevRight", "sm chev")}${err}${thumbs}</button><div class="steps-body">${body}</div></div>`;
}

// ------------------------------------------------------------ cards
function taskCard(items, title = "Tasks") {
  if (!Array.isArray(items) || !items.length) return "";
  const lis = items.map((t) => {
    const st = t.status || "pending";
    const cls = st === "completed" ? "done" : st === "in_progress" ? "doing" : "";
    const tick = st === "completed" ? icon("check", "xs") : "";
    return `<li class="${cls}"><span class="tick">${tick}</span><span class="tx">${esc(t.content || t.activeForm || "")}</span></li>`;
  }).join("");
  const done = items.filter((t) => t.status === "completed").length;
  return `<div class="card"><div class="card-h">${icon("list", "sm")} ${esc(title)}<span style="margin-left:auto">${done}/${items.length}</span></div><ul class="tasklist">${lis}</ul></div>`;
}

function questionCard(b) {
  const qs = b.input?.questions || [];
  const answers = b.result?.answers || {};
  const resultText = b.result?.text || "";
  const body = qs.map((q) => {
    let picked = answers[q.question];
    if (!picked) {
      const m = resultText.match(new RegExp(`"${q.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"="([^"]*)"`));
      if (m) picked = m[1];
    }
    const opts = (q.options || []).map((o) => {
      const on = picked && (picked === o.label || String(picked).split(", ").includes(o.label));
      return `<div class="opt ${on ? "picked" : ""}">${on ? icon("check", "sm") : icon("chevRight", "sm")}<div><div>${esc(o.label)}</div>${o.description ? `<div class="od">${esc(o.description)}</div>` : ""}</div></div>`;
    }).join("");
    const known = (q.options || []).some((o) => picked && (picked === o.label || String(picked).split(", ").includes(o.label)));
    const other = picked && !known ? `<div class="answer">${esc(picked)}</div>` : "";
    return `<div class="q"><div class="qh">${esc(q.header || "Question")}</div><div class="qt">${esc(q.question)}</div>${opts}${other}</div>`;
  }).join("");
  const status = b.result ? (b.result.error ? "Not answered" : "Answered") : "Waiting for an answer";
  return `<div class="card qcard"><div class="card-h">${icon("help", "sm")} ${status}</div>${body}</div>`;
}

function artifactCard(b) {
  const inp = b.input || {};
  const r = b.result || {};
  const url = (r.text || "").match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/)?.[0] || "";
  const title = inp.title || (r.text || "").match(/"title"\s*:\s*"([^"]+)"/)?.[1] || base(inp.file_path || "") || "Artifact";
  const state = r.error ? "Failed" : inp.url ? "Updated" : "Published";
  return `<button class="artifact-chip" ${url ? `data-href="${esc(url)}"` : ""}>${icon("layers", "sm")}<span>${esc(title)}</span><span class="t2">${state}</span>${icon("chevRight", "sm")}</button>`;
}

function wrapCard(b) {
  const inp = b.input || {};
  const btns = (inp.actions || []).map((a, i) => `<span class="pill ${i === 0 ? "primary" : ""}">${esc(a.label || a.action || "")}</span>`).join("");
  return `<div class="wrapbox"><div class="recap">${esc(inp.recap || "")}</div>${inp.ask ? `<div class="ask">${esc(inp.ask)}</div>` : ""}${btns ? `<div class="btns">${btns}</div>` : ""}</div>`;
}

function sessionCard(b) {
  const inp = b.input || {};
  const t = inp.title || "New session";
  const kind = /hand_off/.test(b.name) ? "Handed off to a new session" : inp.initiation === "offer" ? "Offered a new session" : "Started a session";
  return `<div class="card"><div class="card-row"><span class="card-ico">${icon("side", "sm")}</span><div class="grow"><div class="t1">${esc(t)}</div><div class="t2">${kind}</div></div></div></div>`;
}

function planModeCard(b) {
  return `<div class="card"><div class="card-h">${icon("list", "sm")} Plan</div><div class="prose" style="padding:4px 16px 12px;font-size:14.5px">${md(b.input?.plan || "")}</div></div>`;
}

function cardHtml(b) {
  const n = b.name || "";
  if (n === "AskUserQuestion") return questionCard(b);
  if (n === "TodoWrite") return taskCard(b.input?.todos, "To-dos");
  if (n === "ExitPlanMode") return planModeCard(b);
  if (n === "Artifact") return artifactCard(b);
  if (isWrap(n)) return wrapCard(b);
  if (isChapter(n)) return `<div class="divider"><span class="dt">${esc(b.input?.title || "Chapter")}${b.input?.summary ? `<small>${esc(b.input.summary)}</small>` : ""}</span></div>`;
  if (isStartSession(n)) return sessionCard(b);
  return "";
}

// ------------------------------------------------------------ turns
/** Split items into turns: each starts at a user prompt. */
export function toTurns(items) {
  const turns = [];
  let cur = null;
  for (const it of items) {
    if (it.kind === "user") {
      cur = { user: it, flow: [] };
      turns.push(cur);
      continue;
    }
    if (!cur) {
      cur = { user: null, flow: [] };
      turns.push(cur);
    }
    cur.flow.push(it);
  }
  return turns;
}

function applyPlan(plan, inp) {
  if (Array.isArray(inp.items)) return inp.items.map((x) => ({ ...x }));
  if (!plan) return plan;
  const p = plan.map((x) => ({ ...x }));
  if (inp.advance) {
    const i = p.findIndex((x) => x.status === "in_progress");
    if (i >= 0) {
      p[i].status = "completed";
      const j = p.findIndex((x, k) => k > i && x.status === "pending");
      if (j >= 0) p[j].status = "in_progress";
    }
  }
  for (const d of inp.done || []) if (p[d - 1]) p[d - 1].status = "completed";
  if (inp.start && p[inp.start - 1]) p[inp.start - 1].status = "in_progress";
  return p;
}

function userHtml(u) {
  const text = u.text || "";
  const isCmd = /^[/!]\S/.test(text);
  const long = text.length > 1400;
  const imgs = u.images && u.images.length ? `<div class="imgs">${u.images.map((s) => `<img src="${esc(s)}" data-zoom alt="">`).join("")}</div>` : "";
  let body = esc(text);
  if (isCmd) body = body.replace(/^([/!]\S+)/, `<span style="color:var(--clay)">$1</span>`);
  const queued = u.origin === "queued" ? `<div class="queued-tag">Sent while Claude was working</div>` : "";
  const bubble = text ? `<div class="bubble ${long ? "clamped" : ""}">${body}</div>${long ? `<button class="expand" data-expand>Show more</button>` : ""}` : "";
  const acts = `<div class="uactions"><button class="ibtn" data-copy-user title="Copy">${icon("copy", "sm")}</button></div>`;
  return `<div class="msg-user" data-ts="${u.ts || 0}" title="${esc(dateTime(u.ts))}">${queued}${imgs}${bubble}${text ? acts : ""}</div>`;
}

function systemHtml(it) {
  switch (it.subtype) {
    case "task": return `<div class="sysrow">${icon("bell", "xs")} ${esc(it.text)}</div>`;
    case "interrupted": return `<div class="sysrow">${icon("x", "xs")} Interrupted by you</div>`;
    case "api_error": return `<div class="sysrow err">${icon("alert", "xs")} ${esc(it.text)}</div>`;
    case "command_output": return `<div class="cmdout"><div class="sysrow" style="margin:0 0 4px">${icon("terminal", "xs")} Command output</div><div class="sysrow" style="margin:0"><pre>${esc(it.text.slice(0, 6000))}</pre></div></div>`;
    case "goal": return `<div class="sysrow">${icon("check", "xs")} ${esc(it.text)}${it.detail ? ` · ${esc(it.detail)}` : ""}</div>`;
    case "summary": return `<div class="sysrow">${icon("book", "xs")} ${esc(it.text)}</div>`;
    case "info": return `<div class="sysrow">${icon("alert", "xs")} ${esc(it.text)}</div>`;
    default: return it.text ? `<div class="sysrow">${esc(it.text)}</div>` : "";
  }
}

/**
 * Render one turn to HTML. ctx carries cross-turn state (plan, group ids, tool index).
 */
export function turnHtml(turn, ctx, isLast) {
  let html = turn.user ? userHtml(turn.user) : "";
  let pending = []; // blocks waiting to be grouped
  let lastTs = turn.user?.ts || 0;
  let model = "";
  let texts = [];
  let planTouched = false;
  let wrapHtml = "";
  let cost = 0;

  const flush = () => {
    if (!pending.length) return;
    const gid = ctx.nextGroup++;
    ctx.groups[gid] = pending;
    html += groupHtml(pending, gid);
    pending = [];
  };

  for (const it of turn.flow) {
    if (it.ts) lastTs = Math.max(lastTs, it.ts);
    if (it.kind === "assistant") {
      model = it.model || model;
      for (const b of it.blocks || []) {
        if (b.type === "text") {
          flush();
          texts.push(b.text);
          html += `<div class="prose">${md(b.text)}</div>`;
        } else if (b.type === "thinking") {
          if (b.text && b.text.trim()) pending.push(b);
        } else if (b.type === "tool") {
          ctx.tools[b.id] = b;
          const n = b.name || "";
          if (isPlan(n)) {
            ctx.plan = applyPlan(ctx.plan, b.input || {});
            planTouched = true;
            continue;
          }
          if (isSilent(n)) continue;
          if (isWrap(n)) {
            flush();
            if (ctx.plan) ctx.plan = ctx.plan.map((x) => ({ ...x, status: "completed" }));
            wrapHtml = cardHtml(b);
            continue;
          }
          if (isCard(b)) {
            flush();
            html += cardHtml(b);
            continue;
          }
          pending.push(b);
        }
      }
    } else if (it.kind === "system") {
      flush();
      html += systemHtml(it);
    } else if (it.kind === "divider") {
      flush();
      html += `<div class="divider"><span class="dt">${esc(it.text)}${it.detail ? `<small>${esc(it.detail)}</small>` : ""}</span></div>`;
    } else if (it.kind === "compact") {
      flush();
      html += `<details class="compact"><summary>${icon("archive", "sm")} Summary of the earlier conversation</summary><div class="prose">${md(it.text)}</div></details>`;
    }
  }
  flush();
  if (planTouched && ctx.plan) html += taskCard(ctx.plan);
  html += wrapHtml;
  if (texts.length || turn.flow.some((x) => x.kind === "assistant")) {
    const tid = ctx.nextTurn++;
    ctx.turnTexts[tid] = texts.join("\n\n");
    const mname = model ? ctx.modelName(model) : "";
    html += `<div class="turn-foot"><button class="ibtn" data-copy-turn="${tid}" title="Copy">${icon("copy", "sm")}</button><span class="when" title="${esc(dateTime(lastTs))}">${esc(ago(lastTs))}</span>${mname ? `<span class="dot">·</span><span>${esc(mname)}</span>` : ""}</div>`;
  }
  return `<div class="turn">${html}</div>`;
}

export function newCtx(details, modelName) {
  return {
    nextGroup: 0,
    nextTurn: 0,
    groups: {},
    tools: {},
    turnTexts: {},
    plan: null,
    subagents: details?.subagents || [],
    modelName,
  };
}

export { stepDetail as renderStepDetail, codeBlockHtml };
