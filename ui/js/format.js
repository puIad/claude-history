// Formatting helpers shared by every view.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function money(v, digits) {
  const n = Number(v || 0);
  if (digits == null) digits = n >= 100 ? 0 : 2;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function tokens(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function window_(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  return Math.round(n / 1e3) + "k";
}

export function int(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function duration(ms) {
  ms = Number(ms || 0);
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function ago(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  const min = 60e3, hr = 3600e3, day = 86400e3;
  if (d < min) return "just now";
  if (d < hr) return `${Math.floor(d / min)} min ago`;
  if (d < day) return `${Math.floor(d / hr)} hours ago`.replace(/^1 hours/, "1 hour");
  if (d < 30 * day) return `${Math.floor(d / day)} days ago`.replace(/^1 days/, "1 day");
  if (d < 365 * day) return `${Math.floor(d / (30 * day))} months ago`.replace(/^1 months/, "1 month");
  return `${Math.floor(d / (365 * day))} years ago`.replace(/^1 years/, "1 year");
}

export function shortAgo(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 3600e3) return Math.max(1, Math.floor(d / 60e3)) + "m";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
  if (d < 365 * 86400e3) return Math.floor(d / (7 * 86400e3)) + "w";
  return Math.floor(d / (365 * 86400e3)) + "y";
}

export function dateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function day(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function clockTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

export function shortPath(p, max = 42) {
  if (!p) return "";
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  const last = parts.pop();
  const head = parts.slice(0, 3).join("\\");
  const out = `${head}…${last}`;
  return out.length > max + 8 ? "…" + p.slice(-max) : out;
}

export function base(p) {
  return String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;
}

export function effortLabel(e) {
  if (!e) return "";
  return { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }[e] || e;
}

export function permLabel(m) {
  return { auto: "Auto", default: "Ask", acceptEdits: "Accept edits", plan: "Plan", bypassPermissions: "Bypass" }[m] || m || "";
}
