// Usage view: spend and tokens across the whole archive, by day, model and environment.
import { esc, money, tokens, int } from "./format.js";
import { icon } from "./icons.js";
import { planHtml } from "./plan.js";

const MODEL_COLORS = ["#d97757", "#7fb2f0", "#79c46a", "#e9b949", "#a99cf5", "#e58fb5", "#6fd0c4", "#b8b6ad"];

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function chart(days, range, modelOrder, W = 1000) {
  const end = new Date();
  const byDay = new Map(days.map((d) => [d.day, d]));
  let n = range === "all" ? 0 : Number(range);
  if (!n) {
    const first = days.length ? new Date(days[0].day + "T00:00:00Z") : end;
    n = Math.max(7, Math.ceil((end - first) / 86400e3) + 1);
  }
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400e3);
    const k = dayKey(d);
    series.push({ day: k, data: byDay.get(k) });
  }
  const max = Math.max(0.01, ...series.map((s) => s.data?.cost || 0));
  const H = 200, padB = 22, padT = 8;
  const bw = W / series.length;
  const gap = Math.min(4, bw * 0.25);
  const color = (m) => MODEL_COLORS[Math.max(0, modelOrder.indexOf(m)) % MODEL_COLORS.length];
  let bars = "";
  series.forEach((s, i) => {
    let y = H - padB;
    const x = i * bw + gap / 2;
    const by = s.data?.by_model || {};
    const parts = Object.entries(by).sort((a, b) => modelOrder.indexOf(a[0]) - modelOrder.indexOf(b[0]));
    for (const [m, v] of parts) {
      const h = ((v.cost || 0) / max) * (H - padB - padT);
      if (h <= 0) continue;
      y -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, (bw - gap) / 2).toFixed(1)}" fill="${color(m)}" opacity=".9"/>`;
    }
    bars += `<rect x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="transparent" data-i="${i}"/>`;
  });
  const ticks = [];
  const step = Math.max(1, Math.round(series.length / 6));
  for (let i = 0; i < series.length; i += step) {
    const d = new Date(series[i].day + "T00:00:00Z");
    ticks.push(`<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}" fill="var(--text-4)" font-size="11" text-anchor="middle">${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</text>`);
  }
  const grid = [0.5, 1].map((f) => {
    const y = H - padB - f * (H - padB - padT);
    return `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.06)"/><text x="${W}" y="${y - 4}" fill="var(--text-4)" font-size="11" text-anchor="end">${money(max * f, max * f >= 100 ? 0 : 2)}</text>`;
  }).join("");
  return { svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}${ticks.join("")}</svg>`, series };
}

export function renderUsage(el, u, range = "90") {
  const days = u.days || [];
  const models = (u.models || []).slice().sort((a, b) => b.cost - a.cost);
  const modelOrder = models.map((m) => m.model);
  const total = models.reduce((a, m) => a + m.cost, 0);
  const totalTokens = models.reduce((a, m) => a + m.input + m.output + m.cache_read + m.cache_write, 0);
  const activeDays = days.filter((d) => d.messages > 0).length;
  const last30 = days.filter((d) => new Date(d.day) > new Date(Date.now() - 30 * 86400e3)).reduce((a, d) => a + d.cost, 0);
  const width = Math.max(320, Math.min(852, (el.clientWidth || 1000) - 88 - 38));
  const { svg, series } = chart(days, range, modelOrder, width);
  const maxModel = Math.max(0.01, ...models.map((m) => m.cost));
  const groups = (u.groups || []).slice().sort((a, b) => b.cost - a.cost).slice(0, 14);
  const maxGroup = Math.max(0.01, ...groups.map((g) => g.cost));

  el.innerHTML = `<div class="usage">
    <h1>Usage</h1>
    <div class="lede">Your plan's limits as the desktop app last recorded them, and everything in your local archive priced at API list rates.</div>
    <div id="plan-slot">${planHtml(u.plan, renderUsage.acct || 0, renderUsage.days || 7, width - 0)}</div>
    <h2 class="usage-h2">Spend at API prices</h2>
    <div class="tiles">
      <div class="tile"><div class="k">Total</div><div class="v">${money(total, 0)}</div><div class="s">${int(u.sessions)} sessions</div></div>
      <div class="tile"><div class="k">Last 30 days</div><div class="v">${money(last30, 0)}</div><div class="s">${money(last30 / 30)} a day on average</div></div>
      <div class="tile"><div class="k">Tokens</div><div class="v">${tokens(totalTokens)}</div><div class="s">${tokens(models.reduce((a, m) => a + m.output, 0))} written by Claude</div></div>
      <div class="tile"><div class="k">Active days</div><div class="v">${int(activeDays)}</div><div class="s">${days.length ? "since " + new Date(days[0].day).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : ""}</div></div>
    </div>
    <div class="panel"><h3>${icon("chart", "sm")} Daily spend<span class="r">${["30", "90", "365", "all"].map((r) => `<button class="chip ${r === range ? "on" : ""}" data-range="${r}">${r === "all" ? "All" : r + "d"}</button>`).join("")}</span></h3>
      <div class="chart">${svg}<div class="tip"></div></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--text-3)">${modelOrder.map((m, i) => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:9px;height:9px;border-radius:2px;background:${MODEL_COLORS[i % MODEL_COLORS.length]}"></span>${esc(m)}</span>`).join("")}</div>
    </div>
    <div class="panel"><h3>${icon("bot", "sm")} Models</h3>
      <table class="utable"><thead><tr><th>Model</th><th></th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Replies</th><th>Cost</th></tr></thead><tbody>
      ${models.map((m, i) => `<tr><td>${esc(m.model)}</td><td style="width:16%"><div class="hbar" style="width:${(m.cost / maxModel) * 100}%;background:${MODEL_COLORS[i % MODEL_COLORS.length]}"></div></td><td>${tokens(m.input)}</td><td>${tokens(m.output)}</td><td>${tokens(m.cache_read)}</td><td>${tokens(m.cache_write)}</td><td>${int(m.messages)}</td><td>${money(m.cost)}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="panel"><h3>${icon("folder", "sm")} Environments</h3>
      <table class="utable"><thead><tr><th>Environment</th><th></th><th>Sessions</th><th>Cost</th></tr></thead><tbody>
      ${groups.map((g) => `<tr><td>${esc(g.group)}</td><td style="width:40%"><div class="hbar" style="width:${(g.cost / maxGroup) * 100}%"></div></td><td>${int(g.sessions)}</td><td>${money(g.cost)}</td></tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;

  const chartEl = el.querySelector(".chart");
  const tip = chartEl.querySelector(".tip");
  chartEl.addEventListener("mousemove", (e) => {
    const r = e.target.closest("rect[data-i]");
    if (!r) { tip.style.opacity = 0; return; }
    const s = series[Number(r.dataset.i)];
    const d = s.data;
    const when = new Date(s.day + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const lines = d ? Object.entries(d.by_model).map(([m, v]) => `<div style="display:flex;justify-content:space-between;gap:14px;color:var(--text-2)"><span>${esc(m)}</span><span>${money(v.cost)}</span></div>`).join("") : "";
    tip.innerHTML = `<div style="margin-bottom:4px"><b style="font-weight:500">${when}</b> · ${money(d?.cost || 0)}</div>${lines || '<span style="color:var(--text-3)">No activity</span>'}`;
    const box = chartEl.getBoundingClientRect();
    let x = e.clientX - box.left + 14;
    if (x > box.width - 200) x -= 230;
    tip.style.left = x + "px";
    tip.style.top = Math.max(0, e.clientY - box.top - 30) + "px";
    tip.style.opacity = 1;
  });
  chartEl.addEventListener("mouseleave", () => (tip.style.opacity = 0));
  el.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => renderUsage(el, u, b.dataset.range)));
  const slot = el.querySelector("#plan-slot");
  const redrawPlan = () => (slot.innerHTML = planHtml(u.plan, renderUsage.acct || 0, renderUsage.days || 7, width));
  slot.addEventListener("click", (e) => {
    const a = e.target.closest("[data-plan-acct]");
    if (a) { renderUsage.acct = Number(a.dataset.planAcct); redrawPlan(); }
    const d = e.target.closest("[data-plan-days]");
    if (d) { renderUsage.days = Number(d.dataset.planDays); redrawPlan(); }
  });
}
