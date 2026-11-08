// "Plan usage limits", drawn from the samples the desktop app records every ~15 minutes
// (plan-usage-history.json): current 5-hour session %, weekly %, extra-usage spend %.
// Labels and layout follow the desktop app's own limits view.
import { esc } from "./format.js";

const fmtDay = (ms, long = false) =>
  new Date(ms).toLocaleString("en-GB", { weekday: long ? "long" : "short", hour: "2-digit", minute: "2-digit" });

/** Estimate when a rolling limit resets from the moment its usage last dropped. */
function lastDrop(samples, idx, minDrop) {
  for (let i = samples.length - 1; i > 0; i--) {
    const a = samples[i - 1][idx], b = samples[i][idx];
    if (a == null || b == null) continue;
    if (b < a - minDrop || (b === 0 && a > 0)) return { before: samples[i - 1][0], after: samples[i][0], i };
  }
  return null;
}

function sessionReset(samples) {
  const d = lastDrop(samples, 1, 3);
  if (!d) return null;
  // the window opens with the first message after the drop
  const first = samples.slice(d.i).find((s) => (s[1] || 0) > 0);
  if (!first) return null;
  return first[0] + 5 * 3600e3;
}

function weeklyReset(samples) {
  const d = lastDrop(samples, 2, 8);
  if (!d) return null;
  let t = (d.before + d.after) / 2;
  t = Math.round(t / 3600e3) * 3600e3;
  const now = Date.now();
  while (t <= samples[samples.length - 1][0]) t += 7 * 86400e3;
  return t > now - 7 * 86400e3 ? t : null;
}

function variant(p) {
  if (p >= 90) return "danger";
  if (p >= 75) return "warning";
  return "";
}

function row(label, caption, pct, title = "") {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="plan-row" title="${esc(title)}">
    <div class="pl"><div class="pl-label">${label}</div><div class="pl-cap">${caption}</div></div>
    <div class="pbar ${variant(p)}"><span style="width:${p}%"></span></div>
    <div class="pv">${p}% used</div>
  </div>`;
}

function chart(samples, days, W) {
  const H = 150, padB = 20, padT = 8;
  const end = samples[samples.length - 1][0];
  const start = end - days * 86400e3;
  const pts = samples.filter((s) => s[0] >= start);
  if (pts.length < 2) return "";
  const x = (t) => ((t - start) / (end - start)) * W;
  const y = (v) => padT + (1 - Math.min(100, v) / 100) * (H - padT - padB);
  // Step line: a value holds until the next sample. A gap longer than the limit's own
  // window means it reset unseen, so the line breaks there instead.
  const line = (idx, color, dash = "", maxGap = 5 * 3600e3) => {
    let d = "";
    let prev = null;
    for (const s of pts) {
      if (s[idx] == null) { prev = null; continue; }
      const X = x(s[0]).toFixed(1), Y = y(s[idx]).toFixed(1);
      if (!prev || s[0] - prev[0] > maxGap) d += `M${X},${Y} `;
      else d += `H${X} V${Y} `;
      prev = s;
    }
    return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" ${dash}/>` : "";
  };
  const grid = [0, 50, 100].map((v) => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--seam)"/><text x="${W}" y="${y(v) - 3}" fill="var(--text-4)" font-size="10.5" text-anchor="end">${v}%</text>`).join("");
  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const t = start + ((end - start) * i) / 5;
    ticks.push(`<text x="${x(t)}" y="${H - 4}" fill="var(--text-4)" font-size="10.5" text-anchor="${i === 0 ? "start" : i === 5 ? "end" : "middle"}">${new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${line(2, "var(--clay)", "", 7 * 86400e3)}${line(1, "var(--plan-blue)")}${line(3, "var(--text-4)", 'stroke-dasharray="3 3"', 7 * 86400e3)}${ticks.join("")}</svg>`;
}

export function planHtml(plan, sel = 0, days = 7, width = 760) {
  if (!Array.isArray(plan) || !plan.length) return "";
  const acct = plan[Math.min(sel, plan.length - 1)];
  const s = acct.samples;
  const last = s[s.length - 1];
  const [t, fh, sd] = last;
  const xuLast = [...s].reverse().find((x) => x[3] != null);
  const sReset = sessionReset(s);
  const wReset = weeklyReset(s);
  const stale = Date.now() - t > 6 * 3600e3;
  const capSession = sReset ? (sReset < Date.now() ? "Has reset since this was recorded" : `Resets about ${fmtDay(sReset)}`) : "Starts with your first message";
  const capWeek = wReset ? (wReset < Date.now() ? "Has reset since this was recorded" : `Resets about ${fmtDay(wReset, true)}`) : "";
  const tabs = plan.length > 1
    ? `<div class="filter-chips" style="padding:0 0 12px">${plan.map((a, i) => `<button class="chip ${i === sel ? "on" : ""}" data-plan-acct="${i}">${esc(a.profile === "Claude" ? "Claude" : a.profile)} <span style="color:var(--text-4)">· ${esc(a.org.slice(0, 8))}</span></button>`).join("")}</div>`
    : "";
  const extra = xuLast && Date.now() - xuLast[0] < 45 * 86400e3
    ? `<div class="plan-group">Extra usage</div>${row("Monthly spend limit", `Recorded ${new Date(xuLast[0]).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`, xuLast[3])}`
    : "";
  return `<div class="panel plan" id="plan-panel">
    <h3>Plan usage limits<span class="r" style="color:var(--text-3);font-weight:400;font-size:13px">Last updated ${esc(new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span></h3>
    ${tabs}
    ${row("Current session", capSession, fh || 0, "Rolling 5-hour window. Reset times are estimated from the recorded samples.")}
    <div class="plan-group">Weekly limits</div>
    ${row("All models", capWeek, sd || 0, "Rolling 7-day window. Reset times are estimated from the recorded samples.")}
    ${extra}
    ${stale ? `<div class="pl-cap" style="margin-top:12px">These are the last values the desktop app recorded on this computer.</div>` : ""}
    <div class="plan-hist">
      <div class="plan-hist-h"><span><i style="background:var(--plan-blue)"></i>Current session</span><span><i style="background:var(--clay)"></i>Weekly</span><span><i class="dash"></i>Extra usage</span>
        <span class="r">${[7, 14, 30].map((d) => `<button class="chip ${d === days ? "on" : ""}" data-plan-days="${d}">${d}d</button>`).join("")}</span></div>
      ${chart(s, days, Math.max(300, width - 44))}
    </div>
  </div>`;
}
