// The right-hand panel: environment, context usage, connectors, cost by model,
// outputs, changes, tasks and session facts, laid out like the desktop app's panel.
import { esc, money, tokens, window_, int, duration, dateTime, base, shortPath, permLabel } from "./format.js";
import { icon } from "./icons.js";

const COLORS = {
  messages: "var(--c-messages)", system_tools: "var(--c-system-tools)", system_prompt: "var(--c-system-prompt)",
  mcp_tools: "var(--c-mcp-tools)", skills: "var(--c-skills)", memory: "var(--c-memory)", mcp_instructions: "var(--c-mcp-instr)",
  agents: "var(--c-agents)", autocompact: "var(--c-autocompact)", free: "var(--c-free)",
};

function expander(label, count, items, fmt = (x) => esc(x)) {
  if (!items || !items.length) return "";
  return `<div class="drow exp" data-exp>${icon("chevRight", "sm chev")}<span class="grow">${esc(label)}</span><span class="r">${count}</span></div>
    <div class="exp-list">${items.map((x) => `<div title="${esc(typeof x === "string" ? x : x.path || "")}">${fmt(x)}</div>`).join("")}</div>`;
}

function contextSection(c) {
  if (!c) {
    return `<div class="dsec" id="d-context"><div class="dsec-h">Context</div><div class="drow muted">No usage recorded for this session.</div></div>`;
  }
  const pct = Math.min(100, Math.round((c.total / c.window) * 100));
  const bar = c.categories
    .filter((x) => x.key !== "free" && x.tokens > 0)
    .map((x) => `<span style="width:${Math.max(0.4, (x.tokens / c.window) * 100)}%;background:${COLORS[x.key]}" title="${esc(x.name)}: ${tokens(x.tokens)}"></span>`)
    .join("");
  const rows = c.categories
    .filter((x) => x.tokens > 0 || x.key === "messages")
    .map((x) => `<div class="drow"><span class="sw" style="background:${COLORS[x.key]};${x.key === "free" ? "box-shadow: inset 0 0 0 1px var(--line-strong)" : ""}"></span><span class="grow ${["skills", "memory", "mcp_instructions", "agents"].includes(x.key) ? "u" : ""}">${esc(x.name)}</span><span class="r">${tokens(x.tokens)}</span><span class="pct">${((x.tokens / c.window) * 100).toFixed(1)}%</span></div>`)
    .join("");
  const d = c.deferred || {};
  const deferred = `
    <div class="drow" style="margin-top:6px"><span class="sw" style="background:var(--line-strong)"></span><span class="grow muted" title="${d.system != null ? d.system + " tools, loaded on demand" : ""}">System tools (deferred)</span><span class="r"></span><span class="pct">—</span></div>
    <div class="drow"><span class="sw" style="background:var(--line-strong)"></span><span class="grow muted" title="${d.mcp != null ? d.mcp + " tools, loaded on demand" : ""}">MCP tools (deferred)</span><span class="r"></span><span class="pct">—</span></div>`;
  const L = c.lists || {};
  const mcpByServer = {};
  for (const n of L.mcp_tools || []) {
    const m = /^mcp__(.+?)__(.+)$/.exec(n);
    if (m) (mcpByServer[m[1]] = mcpByServer[m[1]] || []).push(m[2]);
  }
  const lists =
    expander("MCP tools", (L.mcp_tools || []).length, L.mcp_tools || [], (x) => esc(x.replace(/^mcp__/, "").replace("__", " · "))) +
    expander("Memory files", (L.memory_files || []).length, L.memory_files || [], (f) => `${esc(base(f.path))} <span style="color:var(--text-4)">· ${tokens(f.tokens)}</span>`) +
    expander("Custom agents", (L.agents || []).length, L.agents || []) +
    expander("Skills", (L.skills || []).length, L.skills || []);
  return `<div class="dsec" id="d-context"><div class="dsec-h">Context</div>
    <div class="ctx-top"><span>${pct}% used</span><span class="r">${tokens(c.total)} / ${window_(c.window)}</span></div>
    <div class="ctxbar">${bar}</div>
    <div class="legend">${rows}${deferred}</div>
    <div style="margin-top:8px">${lists}</div>
  </div>`;
}

function costSection(s, cost) {
  const rows = (cost.by_model || [])
    .sort((a, b) => b.cost - a.cost)
    .map((m) => `<div class="mrow"><div class="top"><span>${esc(m.model)}</span><span class="r">${money(m.cost)}</span></div>
      <div class="toks"><span>Input <b>${tokens(m.input)}</b></span><span>Output <b>${tokens(m.output)}</b></span><span>Cache read <b>${tokens(m.cache_read)}</b></span><span>Cache write <b>${tokens(m.cache_write)}</b></span><span>Replies <b>${int(m.messages)}</b></span></div></div>`)
    .join("");
  const note = cost.subscription ? "claude.ai exports carry no token counts" : cost.estimated ? "Estimated at API list prices" : "As tracked by Claude Code";
  const times = [
    cost.wall_ms ? `<div class="drow"><span class="grow muted">Session time</span><span class="r">${duration(cost.wall_ms)}</span></div>` : "",
    cost.api_ms ? `<div class="drow"><span class="grow muted">Time waiting on the API</span><span class="r">${duration(cost.api_ms)}</span></div>` : "",
    cost.tool_ms ? `<div class="drow"><span class="grow muted">Time running tools</span><span class="r">${duration(cost.tool_ms)}</span></div>` : "",
  ].join("");
  return `<div class="dsec" id="d-cost"><div class="dsec-h">Cost and models</div>
    <div class="cost-big">${money(cost.total)}</div><div class="cost-sub">${note}${!cost.estimated && Math.abs(cost.estimate_total - cost.total) > 0.01 ? ` · ${money(cost.estimate_total)} at list prices` : ""}</div>
    ${rows || `<div class="drow muted">No model usage recorded.</div>`}${times}</div>`;
}

function outputsSection(o) {
  const items = [];
  for (const a of o.artifacts || []) items.push(`<div class="drow link" data-href="${esc(a.url)}" title="${esc(a.url)}">${icon("layers", "sm")}<span class="grow">${esc(a.title || "Artifact")}</span><span class="r">Artifact</span></div>`);
  for (const p of o.prs || []) items.push(`<div class="drow link" data-href="${esc(p.url)}" title="${esc(p.url)}">${icon("pr", "sm")}<span class="grow">${esc((p.repo || "").split("/").pop())} #${esc(p.number)}</span><span class="r">${esc((p.state || "PR").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))}</span></div>`);
  const files = (o.files || []).slice().sort((a, b) => b.count - a.count);
  for (const f of files.slice(0, 40)) items.push(`<div class="drow link" data-reveal="${esc(f.path)}" title="${esc(f.path)}">${icon(f.kind === "created" ? "filePlus" : "fileText", "sm")}<span class="grow">${esc(base(f.path))}</span><span class="r">${f.kind === "created" ? "Created" : "Edited"}</span></div>`);
  if (files.length > 40) items.push(`<div class="drow muted">and ${files.length - 40} more files</div>`);
  return `<div class="dsec" id="d-outputs"><div class="dsec-h">Outputs</div>${items.join("") || `<div class="drow muted">Nothing published or written.</div>`}</div>`;
}

function taskSection(plan) {
  if (!Array.isArray(plan) || !plan.length) return "";
  const done = plan.filter((t) => t.status === "completed").length;
  const lis = plan.map((t) => {
    const st = t.status;
    const cls = st === "completed" ? "done" : st === "in_progress" ? "doing" : "";
    return `<li class="${cls}"><span class="tick">${st === "completed" ? icon("check", "xs") : ""}</span><span class="tx">${esc(t.content || "")}</span></li>`;
  }).join("");
  return `<div class="dsec"><div class="dsec-h">Tasks<span class="r">${done}/${plan.length}</span></div><ul class="tasklist" style="padding:0">${lis}</ul></div>`;
}

export function detailsHtml(data) {
  const s = data.session;
  const d = data.details;
  const env = d.env || {};
  const folderName = base(env.group_cwd || env.cwd) || env.group;
  const envSec = `<div class="dsec" id="d-env"><div class="dsec-h">Environment</div>
    <div class="drow">${icon(env.source === "cowork-cloud" || env.source === "claudeai" ? "cloud" : "laptop", "sm")}<span class="grow">${esc(env.group || "Local")}</span>${env.source === "claudeai" ? `<span class="r">Imported</span>` : env.source === "cowork-cloud" ? `<span class="r">Cloud</span>` : env.source === "cli" ? `<span class="r">Terminal</span>` : env.profile ? `<span class="r">${esc(env.profile === "Claude" ? "Desktop" : env.profile)}</span>` : ""}</div>
    ${env.cwd ? `<div class="drow link" data-reveal="${esc(env.cwd)}" title="${esc(env.cwd)}">${icon("folder", "sm")}<span class="grow">${esc(folderName)} <span class="muted">· ${esc(shortPath(env.cwd, 34))}</span></span></div>` : ""}
    ${env.project ? `<div class="drow">${icon("folder", "sm")}<span class="grow">Project · ${esc(env.project)}</span></div>` : ""}
    ${env.branch ? `<div class="drow">${icon("branch", "sm")}<span class="grow">${esc(env.branch)}</span>${env.worktree ? `<span class="r">worktree</span>` : ""}</div>` : ""}
    <div class="drow">${icon("monitor", "sm")}<span class="grow">Remote Control</span><span class="toggle ${env.remote_control ? "on" : ""}" title="${env.remote_control ? "Was on for this session" : "Was off"}"></span></div>
  </div>`;

  const conns = d.connectors || [];
  const connSec = conns.length
    ? `<div class="dsec"><div class="drow exp" data-exp style="min-height:26px"><span class="dsec-h" style="margin:0">Connectors</span>${icon("chevRight", "sm chev")}<span class="grow"></span><span class="r">${conns.length} connected</span></div>
       <div class="exp-list" style="padding-left:0">${conns.map((c) => `<div>${esc(c.name)} <span style="color:var(--text-4)">· ${c.tools} tools</span></div>`).join("")}</div></div>`
    : "";

  const ch = d.changes || {};
  const chSec = ch.added || ch.removed
    ? `<div class="dsec"><div class="dsec-h">Changes</div><div class="chg"><span class="a">+${int(ch.added)}</span><span class="d">−${int(ch.removed)}</span></div></div>`
    : "";

  const subs = d.subagents || [];
  const subSec = subs.length
    ? `<div class="dsec"><div class="dsec-h">Agents<span class="r">${subs.length}</span></div>${subs.slice(0, 30).map((a) => `<div class="drow link" data-subagent="${esc(a.agent_id)}" data-cli="${esc(s.cli_id)}">${icon("bot", "sm")}<span class="grow">${esc(a.description || a.type || a.agent_id)}</span><span class="r">${money(a.cost)}</span></div>`).join("")}</div>`
    : "";

  const t = d.time || {};
  const facts = `<div class="dsec"><div class="dsec-h">Session</div><dl class="kv">
    <dt>Started</dt><dd>${esc(dateTime(s.created_ms || t.first))}</dd>
    <dt>Last activity</dt><dd>${esc(dateTime(s.updated_ms || t.last))}</dd>
    <dt>Prompts</dt><dd>${int(s.prompts)}</dd>
    <dt>Tool calls</dt><dd>${int(s.tool_calls)}</dd>
    ${s.model_name ? `<dt>Model</dt><dd>${esc(s.model_name)}${s.effort ? " · " + esc(s.effort) : ""}</dd>` : ""}
    ${s.permission_mode ? `<dt>Permissions</dt><dd>${esc(permLabel(s.permission_mode))}</dd>` : ""}
    ${(env.versions || []).length ? `<dt>Claude Code</dt><dd>${esc(env.versions.slice(-1)[0])}</dd>` : ""}
    <dt>State</dt><dd>${s.archived ? "Archived" : "Active"}</dd>
    <dt>Session ID</dt><dd class="mono" data-copy-val="${esc(s.key)}" title="Click to copy">${esc(s.key)}</dd>
    ${s.cli_id && s.cli_id !== s.key ? `<dt>Transcript</dt><dd class="mono" data-copy-val="${esc(s.cli_id)}" title="Click to copy">${esc(s.cli_id)}</dd>` : ""}
  </dl>${(d.missing || []).length ? `<div class="cost-sub" style="margin-top:10px">${d.missing.length} earlier transcript${d.missing.length > 1 ? "s were" : " was"} already deleted by Claude before the first archive run.</div>` : ""}</div>`;

  return envSec + contextSection(d.context) + connSec + outputsSection(d.outputs || {}) + chSec + costSection(s, d.cost) + taskSection(d.plan) + subSec + facts;
}
