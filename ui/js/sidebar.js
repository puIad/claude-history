// The session sidebar: grouped by environment like the desktop app, newest first,
// side sessions nested under the session that started them.
import { esc, shortAgo, dateTime, money } from "./format.js";
import { icon } from "./icons.js";

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const PAGE = 8;

export class Sidebar {
  constructor(el, { onOpen, onMenu }) {
    this.el = el;
    this.onOpen = onOpen;
    this.onMenu = onMenu;
    this.sessions = [];
    this.active = null;
    this.filter = LS.get("ch.filter", "all");
    this.collapsed = new Set(LS.get("ch.collapsed", []));
    this.expanded = new Set(); // groups showing everything
    this.showArchived = new Set(LS.get("ch.showArchived", []));
    this.showTerminal = new Set(LS.get("ch.showTerminal", []));
    el.addEventListener("click", (e) => this.click(e));
  }

  setSessions(list) {
    this.sessions = list || [];
    this.render();
  }

  setActive(key) {
    this.active = key;
    this.el.querySelectorAll(".srow.active").forEach((r) => r.classList.remove("active"));
    const row = key && this.el.querySelector(`.srow[data-key="${CSS.escape(key)}"]`);
    if (row) {
      row.classList.add("active");
      const r = row.getBoundingClientRect();
      const p = this.el.getBoundingClientRect();
      if (r.top < p.top || r.bottom > p.bottom) row.scrollIntoView({ block: "center" });
    } else if (key) {
      // reveal it: expand its group and show archived if needed
      const s = this.sessions.find((x) => x.key === key);
      if (s) {
        this.collapsed.delete(s.group);
        this.expanded.add(s.group);
        if (s.archived) this.showArchived.add(s.group);
        if (s.source === "cli") this.showTerminal.add(s.group);
        this.render();
        const r2 = this.el.querySelector(`.srow[data-key="${CSS.escape(key)}"]`);
        if (r2) { r2.classList.add("active"); r2.scrollIntoView({ block: "center" }); }
      }
    }
  }

  visible(s) {
    if (this.filter === "active") return !s.archived;
    if (this.filter === "archived") return s.archived;
    return true;
  }

  rowHtml(s, side = false) {
    const badge = s.source === "cli" ? `<span class="badge-ico" title="Terminal session">${icon("terminal", "xs")}</span>`
      : s.source === "cowork-cloud" ? `<span class="badge-ico" title="Cowork session that ran in the cloud">${icon("cloud", "xs")}</span>`
      : s.scheduled ? `<span class="badge-ico" title="Routine">${icon("clock", "xs")}</span>` : "";
    const cls = ["srow", side ? "side" : "", s.archived ? "archived" : "", s.key === this.active ? "active" : ""].join(" ");
    const tip = `${s.title}\n${dateTime(s.updated_ms)}${s.cost_usd ? " · " + money(s.cost_usd) : ""}${s.model_name ? " · " + s.model_name : ""}`;
    return `<div class="${cls}" data-key="${esc(s.key)}" title="${esc(tip)}">${badge}<span class="t">${esc(s.title)}</span><button class="more" data-more="${esc(s.key)}">${icon("more", "sm")}</button></div>`;
  }

  render() {
    const sessions = this.sessions;
    const byKey = new Map(sessions.map((s) => [s.key, s]));
    // children (side sessions) attach to their parent when the parent is listed
    const children = new Map();
    for (const s of sessions) {
      if (s.side && s.parent_key && byKey.has(s.parent_key)) {
        if (!children.has(s.parent_key)) children.set(s.parent_key, []);
        children.get(s.parent_key).push(s);
      }
    }
    const isChild = (s) => s.side && s.parent_key && byKey.has(s.parent_key);

    const groups = new Map();
    for (const s of sessions) {
      if (isChild(s)) continue;
      if (!groups.has(s.group)) groups.set(s.group, { name: s.group, cwd: s.group_cwd, list: [], latest: 0 });
      const g = groups.get(s.group);
      g.list.push(s);
      g.latest = Math.max(g.latest, s.updated_ms);
    }
    const ordered = [...groups.values()].sort((a, b) => b.latest - a.latest);

    let html = `
      <button class="nav-row" data-nav="search">${icon("search")}<span>Search</span><span class="kbd">Ctrl K</span></button>
      <button class="nav-row ${this.active === "usage" ? "active" : ""}" data-nav="usage">${icon("chart")}<span>Usage</span></button>
      <div class="filter-chips">
        ${["all", "active", "archived"].map((f) => `<button class="chip ${this.filter === f ? "on" : ""}" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
      </div>`;

    const pinned = sessions.filter((s) => s.starred && this.visible(s));
    if (pinned.length) {
      html += `<div class="group" data-g="__pinned"><button class="group-h" data-toggle="__pinned">Pinned ${icon("chevDown", "xs chev")}</button><div class="group-body">${pinned.map((s) => this.rowHtml(s)).join("")}</div></div>`;
    }

    for (const g of ordered) {
      // Terminal and SDK runs never appear in the desktop app's sidebar, so they
      // are folded behind their own row in each group.
      const term = g.list.filter((s) => s.source === "cli");
      const desk = g.list.filter((s) => s.source !== "cli");
      const active = desk.filter((s) => !s.archived);
      const archived = desk.filter((s) => s.archived);
      const showTerm = this.showTerminal.has(g.name);
      let shown;
      if (this.filter === "active") shown = active;
      else if (this.filter === "archived") shown = archived;
      else shown = this.showArchived.has(g.name) ? desk : active;
      if (this.filter !== "all" && !shown.length) continue;
      const collapsed = this.collapsed.has(g.name);
      const total = g.list.length + g.list.reduce((n, s) => n + (children.get(s.key)?.length || 0), 0);
      let body = "";
      const termRow = term.length && this.filter !== "archived"
        ? `<button class="more-row" data-terminal="${esc(g.name)}">${icon("terminal", "xs")} ${showTerm ? "Hide terminal sessions" : `${term.length} terminal session${term.length > 1 ? "s" : ""}`}</button>`
        : "";
      if (this.filter === "all" && !active.length && !this.showArchived.has(g.name)) {
        body += `<div class="empty-row">No active sessions</div>`;
        if (showTerm) term.forEach((s) => (body += this.rowHtml(s)));
        body += termRow;
        if (archived.length) body += `<button class="more-row" data-archived="${esc(g.name)}">${icon("archive", "xs")} ${archived.length} archived</button>`;
      } else {
        let list = shown;
        if (showTerm && this.filter !== "archived") list = [...list, ...term].sort((a, b) => b.updated_ms - a.updated_ms);
        const termRowHere = termRow;
        const limit = this.expanded.has(g.name) ? Infinity : PAGE;
        list.slice(0, limit).forEach((s) => {
          body += this.rowHtml(s);
          for (const c of children.get(s.key) || []) if (this.visible(c)) body += this.rowHtml(c, true);
        });
        if (list.length > limit) body += `<button class="more-row" data-expand-g="${esc(g.name)}">${icon("chevDown", "xs")} Show ${list.length - limit} more</button>`;
        body += termRowHere;
        if (this.filter === "all" && archived.length) {
          body += this.showArchived.has(g.name)
            ? `<button class="more-row" data-archived="${esc(g.name)}">${icon("archive", "xs")} Hide archived</button>`
            : `<button class="more-row" data-archived="${esc(g.name)}">${icon("archive", "xs")} ${archived.length} archived</button>`;
        }
      }
      html += `<div class="group ${collapsed ? "collapsed" : ""}" data-g="${esc(g.name)}"><button class="group-h" data-toggle="${esc(g.name)}" title="${esc(g.cwd || "")}">${esc(g.name)} ${icon("chevDown", "xs chev")}<span class="count">${total}</span></button><div class="group-body">${body}</div></div>`;
    }
    if (!sessions.length) html += `<div class="empty-row" style="padding:20px 10px">No sessions archived yet.</div>`;
    const top = this.el.scrollTop;
    this.el.innerHTML = html;
    this.el.scrollTop = top;
  }

  click(e) {
    const t = e.target.closest("button, .srow");
    if (!t) return;
    if (t.dataset.more) {
      e.stopPropagation();
      this.onMenu(t.dataset.more, t);
      return;
    }
    if (t.dataset.nav) return this.onOpen(t.dataset.nav === "usage" ? "usage" : "__search");
    if (t.dataset.filter) {
      this.filter = t.dataset.filter;
      LS.set("ch.filter", this.filter);
      return this.render();
    }
    if (t.dataset.toggle) {
      const g = t.dataset.toggle;
      this.collapsed.has(g) ? this.collapsed.delete(g) : this.collapsed.add(g);
      LS.set("ch.collapsed", [...this.collapsed]);
      t.closest(".group").classList.toggle("collapsed");
      return;
    }
    if (t.dataset.expandG) {
      this.expanded.add(t.dataset.expandG);
      return this.render();
    }
    if (t.dataset.terminal) {
      const g = t.dataset.terminal;
      this.showTerminal.has(g) ? this.showTerminal.delete(g) : this.showTerminal.add(g);
      LS.set("ch.showTerminal", [...this.showTerminal]);
      return this.render();
    }
    if (t.dataset.archived) {
      const g = t.dataset.archived;
      this.showArchived.has(g) ? this.showArchived.delete(g) : this.showArchived.add(g);
      LS.set("ch.showArchived", [...this.showArchived]);
      return this.render();
    }
    if (t.classList.contains("srow")) this.onOpen(t.dataset.key);
  }

  /** Keys in on-screen order, for keyboard navigation. */
  order() {
    return [...this.el.querySelectorAll(".srow")].map((r) => r.dataset.key);
  }
}
