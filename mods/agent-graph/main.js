// Agent graph: every live terminal as repo -> worktree (branch + PR) -> agent -> sub-agent.
// Live data re-renders; git facts (30 s) and `gh pr list` (60 s) are cached per cwd / repo.
// props().panel: lives in the emergence layout's right panel (block "graph") instead of a popup.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { agents, terminals, panes, spaces, focused, exec, run, theme, settings, props, closeOverlay, openOverlay, setShared, shared, home, layout } from "herdr";
import { buildTree, layout as graphLayout, parseRevParse, prsByBranch, mrsAsPRs, cleanTitle, RANK, mix, ringed, sidebarCursor } from "./lib.js";

const GIT_TTL = 30000, PR_TTL = 60000;
const MONO = "Geist Mono";
const ZMIN = 0.3, ZMAX = 2, ZFIT = 1, PAD = 48;
// A panel keeps graph text readable: narrower than this zoom it shows the tree as a list.
const PANEL_PAD = 24, PANEL_Z = 0.6;
const STATUS = ["blocked", "done", "working", "idle"];
const WORD = { blocked: "Blocked", done: "Done", working: "Working", idle: "Idle" };
const ICON = (f) => `mods/agent-graph/${f}.svg`;
const key = (m, p) => `${m ?? ""}|${p}`;
const alpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
const clamp = (z) => Math.min(ZMAX, Math.max(ZMIN, z));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const panelShows = (block) => { const p = find(layout(), "panel"); return !!p && !p.hidden && find(p, "panel-body")?.active === block; };

async function facts(on, cwd) {
  try {
    const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { cwd, on });
    const f = r.code === 0 ? parseRevParse(r.stdout) : null;
    if (f?.branch) {
      const ab = await exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on });
      if (ab.code === 0) [f.ahead, f.behind] = ab.stdout.trim().split(/\s+/).map(Number);
    }
    return f;
  } catch {
    return null;
  }
}

// The repo's PRs by branch: GitHub's through gh, GitLab's merge requests through glab (by the origin remote).
async function pulls(on, cwd) {
  try {
    const url = (await exec("git", ["remote", "get-url", "origin"], { cwd, on })).stdout ?? "";
    if (!/github/i.test(url)) { // GitLab, else (GitHub Enterprise, an ssh alias) gh below
      const r = await exec("glab", ["mr", "list", "--all", "-P", "100", "-F", "json"], { cwd, on }).catch(() => null); // no glab here: gh
      if (r?.code === 0) return prsByBranch(mrsAsPRs(JSON.parse(r.stdout)));
    }
    const r = await exec("gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,isDraft,headRefName,title,url,reviewDecision"], { cwd, on });
    return r.code === 0 ? prsByBranch(JSON.parse(r.stdout)) : null;
  } catch {
    return null;
  }
}

const GRAIN = 256, GRAIN_OPACITY = 0.1; // grain.png's tile (logical px at zoom 1) and how strong: felt more than seen
// A working agent's dot breathes so it reads as running at a glance: Herdr's native loop (AGENTS.md: animate
// natively, never with a timer), which runs without this script and stops while the graph isn't drawn.
const BREATH = { from: 0.4, to: 1, period: 1600 };

export default class AgentGraph extends View {
  init(_props, cx) {
    this.panel = props()?.panel === true;
    this.backAt = shared("emergence.back");
    this.git = new Map(); // machine|cwd -> { at, v: facts | null }
    this.prs = new Map(); // machine|common -> { at, v: Map | null }
    this.busy = false;
    this.loaded = false;
    this.activeOnly = localStorage.getItem("activeOnly") === "1";
    this.view = null; // { x, y, z } once the person pans or zooms; null = fitted
    this.offsets = new Map(JSON.parse(localStorage.getItem("offsets") || "[]")); // node id -> { x, y } the person dragged it by
    this.sel = null;
    this.h = cx.focus_handle();
    if (this.panel) cx.timer.every(250, (cx) => { if (this.h.is_focused() !== this.held) cx.notify(); }); // no blur event (comeBack)
    if (!this.panel) {
      this.h.focus();
      cx.timer.after(300, () => this.h.focus());
    }
    // The first render refreshes (and again whenever a hidden panel comes back).
    cx.timer.every(GIT_TTL, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  // A panel copy stays alive while hidden; it skips git / gh work until shown.
  shown() {
    return !this.panel || panelShows("graph");
  }

  // Every live terminal, flattened from agents / panes / spaces.
  items() {
    const ag = new Map(agents().map((a) => [a.address, a]));
    const pane = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, { label: `${s.name} / ${t.name}`, space: s.id }])));
    return terminals().filter((x) => x.state === "live").map((x) => {
      const a = ag.get(x.address), machine = x.address.includes("/") ? x.address.split("/")[0] : null;
      const lbl = x.labels?.["herdr.tab"];
      // A sub-agent without a pane reports to its parent: its done is the parent's news.
      let s = a?.status ?? (x.status === "error" ? "blocked" : x.status === "done" ? "idle" : x.status);
      const cwd = pane.get(x.address)?.cwd ?? x.foreground?.cwd ?? x.cwd ?? null;
      const agent = !!(a || x.report || x.program?.agent);
      const program = a?.program ?? x.program;
      const tab = tabs.get(a?.tab ?? (lbl && machine ? `${machine}/${lbl}` : lbl));
      return {
        id: x.address, parent: x.parent ?? null, machine, cwd, agent, program,
        status: s in RANK ? s : "idle",
        name: cleanTitle(a?.title || x.title || x.name) || (agent ? program?.name : cwd?.split("/").filter(Boolean).pop()) || x.address,
        kind: agent ? null : x.foreground?.name ?? program?.name ?? "terminal",
        tab: tab?.label ?? null, space: tab?.space ?? null,
      };
    });
  }

  refresh(cx, force = false) {
    // busy = start time; a refresh hung past a minute no longer blocks the next one.
    if (this.busy && Date.now() - this.busy < 60000) return;
    const me = this.busy = Date.now();
    const items = this.items();
    cx.spawn(async (cx) => {
      try {
        await cx.sleep(16); // host calls made before a copy's first frame never resolve
        const now = Date.now(), stale = (c, ttl) => force || !c || now - c.at >= ttl;
        const cwds = new Map(items.filter((i) => i.cwd).map((i) => [key(i.machine, i.cwd), i]));
        await Promise.all([...cwds].filter(([k]) => stale(this.git.get(k), GIT_TTL))
          .map(async ([k, i]) => this.git.set(k, { at: now, v: await facts(i.machine, i.cwd) })));
        this.loaded = true;
        cx.notify();
        const repos = new Map();
        for (const [k, i] of cwds) {
          const v = this.git.get(k)?.v;
          if (v) repos.set(key(i.machine, v.common), { on: i.machine, top: v.top });
        }
        await Promise.all([...repos].filter(([k]) => stale(this.prs.get(k), PR_TTL))
          .map(async ([k, r]) => this.prs.set(k, { at: now, v: await pulls(r.on, r.top) })));
      } finally {
        if (this.busy === me) this.busy = 0;
        cx.notify();
      }
    });
  }

  dismiss() {
    if (!this.panel) closeOverlay(props().overlay);
  }

  focusAgent(n) {
    run("agent.focus", { terminal: n.id });
    this.dismiss();
  }

  // Cross-mod deep link: pr-review picks this up (if < 30 s old) and selects the PR.
  // With a PRs panel in the layout (emergence) that panel takes it; otherwise the pr-review window.
  openPr(w) {
    setShared("pr-review.open", { repo: w.top, machine: w.machine, number: w.pr.number, at: Date.now() });
    if (!find(layout(), "prs")) run("mod.open", { name: "pr-review" }); // it re-opens itself centred, replacing any open one
    else if (!panelShows("prs")) run("tabs-plus.prs");
    this.dismiss();
  }

  // Every checkout of a repo in Herdr's own Open worktree dialog: filter, then Enter goes to it (a space).
  worktrees(r) {
    openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { folder: r.worktrees[0].top, machine: r.machine, action: "open" } });
    this.dismiss();
  }

  fitView(L) {
    const W = this.size.width, H = this.size.height, p = this.panel ? PANEL_PAD : PAD;
    const wz = (W - 2 * p) / Math.max(1, L.width), hz = (H - 2 * p) / Math.max(1, L.height);
    // A panel is tall and narrow: rather than shrink text to fit the height, run off the bottom (scroll pans).
    const z = clamp(Math.min(ZFIT, wz, this.panel ? Math.max(hz, PANEL_Z) : hz));
    return { z, x: (W - L.width * z) / 2 - L.x0 * z, y: Math.max(p, (H - L.height * z) / 2) - L.y0 * z };
  }

  // Cards the person dragged keep their offset (graph px) on top of the automatic layout; edges follow.
  moved(L) {
    const nodes = L.nodes.map((n) => { const o = this.offsets.get(n.id); return o ? { ...n, x: n.x + o.x, y: n.y + o.y } : n; });
    const by = new Map(nodes.map((n) => [n.id, n]));
    const edges = L.edges.map((e) => { const a = by.get(e.from), b = by.get(e.to); return { ...e, a: { x: a.x + a.w, y: a.y + a.h / 2 }, b: { x: b.x, y: b.y + b.h / 2 } }; });
    const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
    return { nodes, edges, x0, y0, width: Math.max(...nodes.map((n) => n.x + n.w)) - x0, height: Math.max(...nodes.map((n) => n.y + n.h)) - y0 };
  }

  // A drag ends on release or when the pointer leaves the canvas; arranged cards are remembered,
  // and a view that was fitted before the drag fits again (the drag only pinned it while moving).
  endDrag() {
    if (this.drag?.node && this.drag.moved) localStorage.setItem("offsets", JSON.stringify([...this.offsets]));
    if (this.drag?.fitted) this.view = null;
    this.drag = null;
  }

  zoomAt(f, px, py) {
    const v = this.view ?? this.fitted, z = clamp(v.z * f), k = z / v.z;
    this.view = { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  }

  // A dialog of ours (Jump, the keys) took the keyboard from this panel: it comes back when that closes (as
  // spaces-plus comeBack).
  comeBack(cx, held) {
    const ov = shared("emergence.over");
    if (!ov || ov.at === this.ovAt) return;
    this.ovAt = ov.at;
    if (ov.open) this.resume ||= held;
    else if (this.resume) cx.timer.after(80, (cx) => {
      if (shared("emergence.over")?.open) return;
      this.resume = false;
      if (!ov.went) { this.h.focus(); cx.notify(); }
    });
  }

  // The large popup (mod.open) closing gives the keyboard back to the side panel showing (emergence.back).
  async close() { if (!this.panel && props()?.overlay) setShared("emergence.back", Date.now()); }

  render(cx) {
    const t = theme();
    this.Z = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
    if (this.raw) this.size = { width: this.raw.width / this.Z, height: this.raw.height / this.Z };
    const shown = this.shown();
    if (shown && !this.wasShown) this.refresh(cx);
    // The inbox's Working row opens the graph on what's working (active only) or, with nothing working, everything.
    const want = shared("graph.want");
    if (want && want.at !== this.wantAt) { this.wantAt = want.at; this.activeOnly = want.activeOnly; localStorage.setItem("activeOnly", want.activeOnly ? "1" : "0"); }
    const o = this.panel && shown && shared("emergence.opened"); // opened (⌘⇧A, the tab bar; tabs-plus says so): the keys are its own at once
    if (o?.id === "graph" && o.at !== this.openedAt && Date.now() - o.at < 3000) { this.openedAt = o.at; cx.timer.after(50, () => this.h.focus()); }
    const back = this.panel && shown && shared("emergence.back"); // a panel's window or popup closed: the keyboard comes back
    if (back && back !== this.backAt) { this.backAt = back; if (Date.now() - back < 3000) cx.timer.after(80, () => this.h.focus()); }
    if (this.panel) { this.comeBack(cx, this.held); this.held = this.h.is_focused(); }
    this.wasShown = shown;
    const items = this.items();
    if (shown && !this.busy && items.some((i) => i.cwd && !this.git.has(key(i.machine, i.cwd)))) this.refresh(cx);
    const tree = buildTree(items, (m, c) => this.git.get(key(m, c))?.v ?? null, (m, c) => this.prs.get(key(m, c))?.v ?? undefined, { activeOnly: this.activeOnly });
    const L = graphLayout(tree), M = this.moved(L); // M: with the person's dragged offsets
    const list = this.panel && this.loaded && !!this.size && (this.size.width - 2 * PANEL_PAD) / Math.max(1, L.width) < PANEL_Z;
    const walk = (a) => [{ data: a }, ...a.children.flatMap(walk)];
    const picks = list ? tree.flatMap((r) => r.worktrees.flatMap((w) => w.agents.flatMap(walk)))
      : M.nodes.filter((n) => n.kind === "agent").sort((a, b) => a.y - b.y || a.x - b.x);
    const foc = focused()?.terminal ?? null;
    const ring = ringed(tree, sidebarCursor(shared("inbox.cursor"), shared("spaces.cursor")), foc); // where you are: see lib
    if (!picks.some((n) => n.data.id === this.sel)) this.sel = (picks.find((n) => n.data.id === foc) ?? picks[0])?.data.id ?? null;

    // A popup is as tall as its content (mod.json height is the cap): size to the window. A panel fills its block.
    const root = this.panel
      ? v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
        .on_mouse_down("left", () => this.h.focus())
      : v_flex().w_full().h(window.viewport_size().height * 0.88 / this.Z).bg(t.surface);
    return root.id("ag-root").text_size(13).text_color(t.foreground)
      .track_focus(this.h)
      .on_key_down((e, cx) => {
        const k = e.key, i = picks.findIndex((n) => n.data.id === this.sel), m = e.modifiers;
        if (m.platform || m.control || m.alt) return; // ⌘R, ⌘= … belong to the app
        if (k === "escape") return this.panel ? run("tabs-plus.back") : this.dismiss(); // the panel: back to the terminal
        if (k === "f") this.view = null;
        else if ((k === "-" || k === "=" || k === "+") && this.fitted && this.size) this.zoomAt(k === "-" ? 0.8 : 1.25, this.size.width / 2, this.size.height / 2);
        else if (k === "r") { this.offsets.clear(); localStorage.removeItem("offsets"); this.view = null; }
        else if ((k === "down" || k === "up") && picks.length) this.sel = picks[(i + (k === "down" ? 1 : picks.length - 1)) % picks.length].data.id;
        else if (k === "enter" && i >= 0) return this.focusAgent(picks[i].data);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.header(t, items))
      .child(list ? this.list(t, tree, ring) : this.canvas(t, items, tree, M, ring));
  }

  // The body reports its size (logical px times zoom); fitting and the header's width breakpoints read it.
  measure(el) {
    return el.on_size_change((s, cx) => {
      const r = this.raw;
      if (r && Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5) return;
      this.raw = { width: s.width, height: s.height };
      cx.notify();
    });
  }

  header(t, items) {
    const W = this.panel ? this.size?.width ?? Infinity : Infinity, narrow = W < 420;
    let counts = STATUS.map((s) => [s, items.filter((i) => i.agent && i.status === s).length]).filter(([, n]) => n);
    if (W < 360) counts = counts.filter(([s]) => s !== "idle");
    const button = (id, tip, onClick) => h_flex().id(id).h(24).px(8).gap(6).items_center().rounded(6).flex_none()
      .border(1).border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).border_color(t.input).text_color(t.foreground))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); });
    const icon = (el) => el.w(24).px(0).justify_center().border_color(alpha(t.border, 0)) // icon buttons have no box, as in every panel
      .hover((s) => s.bg(t.hover).text_color(t.foreground));
    const on = this.activeOnly, label = W >= 520;
    const hint = !this.panel ? "↑↓ select · ↵ focus · F fit · R reset · Esc close" : W >= 1000 ? "↑↓ select · ↵ focus · F fit · R reset" : null;
    return h_flex().flex_none().items_center().border_b(1).border_color(t.border)
      .map((el) => this.panel ? el.h(42).px(14).gap(8) : el.h(40).px(16).gap(12))
      .child(div().flex_none().text_size(this.panel ? 13 : 15).font_semibold().child("Agents"))
      .child(h_flex().min_w(0).overflow_hidden().gap(narrow ? 4 : 6).items_center().children(counts.map(([s, n]) => {
        const loud = s === "blocked";
        const c = h_flex().h(20).px(narrow ? 6 : 8).gap(narrow ? 4 : 6).flex_none().items_center().rounded(6)
          .bg(loud ? alpha(t.blocked, 0.14) : t.raised).text_size(11).text_color(loud ? t.blocked : t.muted).child(this.dot(t, s, 6));
        return narrow ? c.id(`ag-count-${s}`).tooltip(`${n} ${s}`).child(String(n)) : c.child(`${n} ${s}`);
      })))
      .child(div().flex_1())
      .when(!!hint, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .child(button("ag-active", "Hide idle agents and terminals", () => {
        this.activeOnly = !on;
        localStorage.setItem("activeOnly", on ? "0" : "1");
        this.view = null;
      }).when(on, (el) => el.text_color(t.foreground)).when(!label, icon)
        .child(div().size(12).flex_none().flex().items_center().justify_center().rounded(3).border(1)
          .border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent))
          .when(on, (el) => el.child(svg(ICON("check")).size(10).text_color(t.accent_foreground))))
        .when(label, (el) => el.child("Active only")))
      .child(icon(button("ag-refresh", "Refresh git and PRs", (cx) => this.refresh(cx, true)))
        .child(svg(ICON("refresh")).size(13).when(this.busy, (el) => el.spin(900))))
      .when(this.panel, (el) => el.child(icon(button("ag-expand", "Open in window", () => run("mod.open", { name: "agent-graph" })))
        .child(svg(ICON("expand")).size(13))));
  }

  // Panel too narrow for a readable graph: the same tree as an indented list.
  list(t, tree, ring) {
    const rows = [];
    const row = (id, depth) => h_flex().id(id).h(28).flex_none().pl(8 + depth * 16).pr(8).gap(8).items_center().rounded(7);
    const agent = (a, depth) => {
      const loud = a.status === "blocked", tone = loud ? t.blocked : a.status === "working" ? t.working : null, sel = this.sel === a.id, p = a.program;
      const ic = p?.icon ? (p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).w(14).h(14).flex_none()) : null;
      rows.push(row(`l:${a.id}`, depth).border_1().border_color(ring.has(`a:${a.id}`) ? t.accent : alpha(t.border, 0)).cursor_pointer()
        .when(!!tone, (el) => el.bg(alpha(tone, 0.08))).when(sel && !tone, (el) => el.bg(t.selected))
        .hover((s) => s.bg(tone ? alpha(tone, 0.14) : t.hover))
        .when(!!a.tab, (el) => el.tooltip(a.tab))
        .on_click(() => this.focusAgent(a))
        .child(this.dot(t, a.status, 8))
        .when(!!ic, (el) => el.child(ic))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.name))
        .child(div().flex_none().text_size(11).text_color(loud ? t.blocked : t.dim).when(loud, (el) => el.font_semibold())
          .child(a.agent ? WORD[a.status] : a.kind)));
      for (const c of a.children) agent(c, depth + 1);
    };
    for (const r of tree) {
      const none = r.kind === "none";
      rows.push(row(`l:${r.id}`, 0).when(rows.length > 0, (el) => el.mt(8))
        .when(!none, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Every worktree of ${r.name}`).on_click(() => this.worktrees(r)))
        .child(svg(ICON(none ? "folder" : "repo")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(none ? t.muted : t.foreground).child(r.name))
        .when(!!r.machine, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim).child(r.machine))));
      for (const w of r.worktrees) {
        const git = w.kind === "worktree";
        const ab = git && (w.ahead || w.behind) ? [w.ahead && `↑${w.ahead}`, w.behind && `↓${w.behind}`].filter(Boolean).join(" ") : "";
        rows.push(row(`l:${w.id}`, 1).border_1().border_color(ring.has(`w:${w.id}`) ? t.accent : alpha(t.border, 0))
          .child(svg(ICON(git ? "branch" : "folder")).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO).text_color(t.foreground).child(git ? w.branch ?? "detached" : w.name))
          .when(!!ab, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim).child(ab)))
          .when(!!w.pr, (el) => el.child(this.chip(t, w, 1))));
        for (const a of w.agents) agent(a, 2);
      }
    }
    return this.measure(div().id("ag-list-body").flex_1().min_h(0).relative())
      .child(v_flex().id("ag-list").absolute().inset_0().overflow_y_scroll().p(6).children(rows))
      .child(Scrollbar.vertical("ag-list").absolute().inset_0());
  }

  dot(t, s, size = 8) {
    return div().size(size).flex_none().rounded(size).bg(t[s] ?? t.idle)
      .when(s === "working", (el) => el.loop("opacity", BREATH)); // breathes; everything else is still
  }

  canvas(t, items, tree, L, ring) {
    const Z = this.Z;
    let el = this.measure(div().id("ag-canvas").flex_1().min_h(0).relative().overflow_hidden().bg(t.background))
      .map((el) => (this.drag?.moved ? el.cursor_grabbing() : el.cursor_grab()))
      .on_scroll_wheel((e, cx) => {
        if (!this.fitted) return;
        const v = this.view ?? this.fitted;
        const r = e.local_position ?? (e.bounds ? { x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y } : null);
        const p = r ? { x: r.x / Z, y: r.y / Z } : { x: this.size.width / 2, y: this.size.height / 2 };
        // A mouse wheel (it reports lines) zooms, like a map; a trackpad's two-finger scroll pans; ⌘/ctrl-scroll zooms either way.
        if (e.delta_lines || e.modifiers.control || e.modifiers.platform) this.zoomAt(Math.exp((e.delta_lines ? e.delta_lines.y * 40 : e.delta.y) * 0.003), p.x, p.y);
        else this.view = { ...v, x: v.x + e.delta.x / Z, y: v.y + e.delta.y / Z };
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        if (this.fitted) this.drag = { x: e.position.x, y: e.position.y, v: { ...(this.view ?? this.fitted) }, moved: false };
      })
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const dx = (e.position.x - d.x) / Z, dy = (e.position.y - d.y) / Z;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        if (d.node) {
          const v = (this.view ??= this.fitted); // pin the view: refitting mid-drag would slide everything
          this.offsets.set(d.node, { x: d.o.x + dx / v.z, y: d.o.y + dy / v.z });
        } else this.view = { ...d.v, x: d.v.x + dx, y: d.v.y + dy };
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        this.endDrag();
        cx.notify();
      })
      .on_hover((h) => { if (!h) this.endDrag(); });
    if (!this.size) return el;
    // Film grain behind everything, for depth: grain.png (512px: light and dark specks, so any theme) tiled at one image
    // px per screen px on a 2x display, still while the graph pans and zooms.
    const g = GRAIN / Z;
    for (let y = 0; y < this.size.height; y += g) for (let x = 0; x < this.size.width; x += g)
      el = el.child(image("mods/agent-graph/grain.png").absolute().left(x).top(y).w(g).h(g).opacity(GRAIN_OPACITY));

    const quiet = (line, hint, action) => el.child(v_flex().absolute().left(0).top(0).size_full().px(16).items_center().justify_center().gap(8)
      .child(div().text_size(13).text_color(t.muted).child(line))
      .when(!!hint, (el) => el.child(div().max_w(420).text_size(12).text_color(t.dim).text_center().child(hint)))
      .when(!!action, (el) => el.child(h_flex().id("ag-empty-action").mt(4).h(24).px(10).items_center().rounded(6).border(1).border_color(t.input)
        .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { action[1](); cx.notify(); }).child(action[0]))));
    if (!items.some((i) => i.agent)) return quiet("No agents running.", "Start an agent (Claude Code, Codex, pi…) in any terminal and it appears here. Sub-agents started with hc run hang off their parent.");
    if (!this.loaded) return quiet("Reading repositories…");
    if (!tree.length) return quiet("Nothing active right now.", null, ["Show idle", () => { this.activeOnly = false; localStorage.setItem("activeOnly", "0"); }]);

    this.fitted = this.fitView(L);
    const v = this.view ?? this.fitted, z = v.z, W = this.size.width, H = this.size.height;
    const X = (x) => x * z + v.x, Y = (y) => y * z + v.y;
    const layer = (path, color) => div().absolute().left(0).top(0).w(W).h(H).child(window.paint_path(path, color));
    const els = [];

    // Dot grid that moves with the drawing.
    let s = 24 * z;
    while (s < 14) s *= 2;
    while (s > 40) s /= 2;
    const ox = ((v.x % s) + s) % s, oy = ((v.y % s) + s) % s, d = 1.5;
    let grid = PathBuilder.stroke(d).dash_array([d, s - d]);
    for (let y = oy; y < H; y += s) grid = grid.move_to(ox - d / 2, y).line_to(W + s, y);
    els.push(layer(grid.build(), alpha(t.foreground, 0.07)));

    // One stroke path per status colour; smooth horizontal S-curves.
    const ink = { blocked: t.blocked, done: alpha(t.done, 0.75), working: alpha(t.working, 0.75), idle: t.border };
    const paths = new Map();
    for (const e of L.edges) {
      const ax = X(e.a.x), ay = Y(e.a.y), bx = X(e.b.x), by = Y(e.b.y), mx = (bx - ax) / 2;
      const b = paths.get(e.status) ?? PathBuilder.stroke(e.status === "idle" ? 1.25 : 1.5);
      paths.set(e.status, b.move_to(ax, ay).cubic_bezier_to(bx, by, ax + mx, ay, bx - mx, by));
    }
    for (const st of [...STATUS].reverse()) if (paths.has(st)) els.push(layer(paths.get(st).build(), ink[st]));

    for (const n of L.nodes) els.push(this.node(t, n, X(n.x), Y(n.y), z, ring.has(n.id)));
    // Zoom controls (⌘/ctrl-scroll and - / = zoom too): − · the zoom (click: fit) · +.
    const zb = (id, tip, label, onClick) => h_flex().id(id).h(24).px(8).items_center().justify_center().text_size(12).text_color(t.muted)
      .cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(); cx.notify(); }).child(label);
    els.push(h_flex().absolute().right(12).bottom(12).rounded(7).border(1).border_color(t.border).bg(t.surface).overflow_hidden().shadow_sm()
      .child(zb("ag-zoom-out", "Zoom out (-)", "−", () => this.zoomAt(0.8, W / 2, H / 2)))
      .child(zb("ag-zoom-fit", "Fit (F)", `${Math.round(z * 100)}%`, () => { this.view = null; }).min_w(52).border_l(1).border_r(1).border_color(t.border))
      .child(zb("ag-zoom-in", "Zoom in (=)", "+", () => this.zoomAt(1.25, W / 2, H / 2))));
    return el.children(els);
  }

  // A card at the canvas position, every length scaled by the view's zoom. Dragging a card moves just that card.
  // `tone`: the colour an agent that needs looking at is drawn in (blocked, working), else none.
  card(t, n, x, y, z, tone) {
    return v_flex().id(n.id).absolute().left(x).top(y).w(n.w * z).h(n.h * z).px(12 * z).justify_center().gap(4 * z)
      .rounded(10 * z).border(1).border_color(tone ? alpha(tone, 0.8) : t.border).bg(tone ? mix(t.background, tone, 0.08) : t.surface) // opaque: no grain through a card
      .when(this.drag?.node === n.id && this.drag.moved, (el) => el.cursor_grabbing().shadow_lg())
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.h.focus(); // the press stops here, so the root's focus never runs
        this.drag = { node: n.id, x: e.position.x, y: e.position.y, o: this.offsets.get(n.id) ?? { x: 0, y: 0 }, moved: false, fitted: this.view == null };
      });
  }

  // Where you are (lib's ringed): an accent border and a soft halo.
  ring(t, el, n, z, on) {
    return !on ? el : el.border_color(t.accent).child(div().absolute().left(-4 * z).top(-4 * z).w(n.w * z + 8 * z).h(n.h * z + 8 * z)
      .rounded(13 * z).border(2).border_color(alpha(t.accent, 0.3)));
  }

  node(t, n, x, y, z, isFoc) {
    const d = n.data;
    if (n.kind === "repo") {
      const none = d.kind === "none";
      const meta = d.machine ?? `${d.worktrees.length} ${none ? (d.worktrees.length > 1 ? "folders" : "folder") : d.worktrees.length > 1 ? "worktrees" : "worktree"}`;
      return this.card(t, n, x, y, z)
        .when(!none, (el) => el.cursor_pointer().tooltip(`Every worktree of ${d.name}`).on_click(() => { if (!this.drag?.moved) this.worktrees(d); }))
        .child(h_flex().gap(8 * z).items_center()
          .child(svg(ICON(none ? "folder" : "repo")).size(14 * z).flex_none().text_color(t.muted))
          .child(div().min_w(0).truncate().text_size(15 * z).font_semibold().text_color(none ? t.muted : t.foreground).child(d.name)))
        .child(h_flex().gap(6 * z).items_center().text_size(11 * z).text_color(t.dim)
          .when(!!d.machine, (el) => el.child(svg(ICON("server")).size(11 * z).flex_none()))
          .child(div().min_w(0).truncate().when(!!d.machine, (el) => el.font_family(MONO)).child(meta)));
    }
    if (n.kind === "worktree") {
      const git = d.kind === "worktree";
      const ab = git && (d.ahead || d.behind) ? `${d.ahead ? `↑${d.ahead}` : ""}${d.ahead && d.behind ? " " : ""}${d.behind ? `↓${d.behind}` : ""}` : "";
      const path = git ? d.path : (d.path ?? "").replace(home(), "~");
      return this.ring(t, this.card(t, n, x, y, z), n, z, isFoc)
        .child(h_flex().gap(8 * z).items_center()
          .child(svg(ICON(git ? "branch" : "folder")).size(14 * z).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(13 * z).font_family(MONO).text_color(t.foreground).child(git ? d.branch ?? "detached" : d.name))
          .when(!!ab, (el) => el.child(div().flex_none().text_size(11 * z).font_family(MONO).text_color(t.dim).child(ab))))
        .child(h_flex().gap(8 * z).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11 * z).font_family(MONO).text_color(t.dim).child(path))
          .when(!!d.pr, (el) => el.child(this.chip(t, d, z))));
    }
    const loud = d.status === "blocked", tone = loud ? t.blocked : d.status === "working" ? t.working : null; // working stands out too
    const sel = this.sel === d.id;
    const p = d.program;
    const icon = p?.icon ? (p.tint ? svg(p.icon).size(16 * z).flex_none().text_color(t.foreground) : image(p.icon).w(16 * z).h(16 * z).flex_none()) : null;
    return this.card(t, n, x, y, z, tone)
      .when(sel && !tone, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(tone ? mix(t.background, tone, 0.14) : sel ? t.selected : t.raised).border_color(isFoc ? t.accent : tone ?? t.input).shadow_sm())
      .on_click(() => { if (!this.drag?.moved) this.focusAgent(d); }) // a pan that started on the card isn't a click
      .map((el) => this.ring(t, el, n, z, isFoc))
      .child(h_flex().gap(8 * z).items_center()
        .when(!!icon, (el) => el.child(icon))
        .child(div().flex_1().min_w(0).truncate().text_size(13 * z).font_semibold().text_color(t.foreground).child(d.name)))
      .child(h_flex().gap(6 * z).items_center()
        .child(this.dot(t, d.status, 8 * z))
        .child(div().flex_none().text_size(12 * z).text_color(loud ? t.blocked : t.muted).when(loud, (el) => el.font_semibold())
          .child(d.agent ? WORD[d.status] : d.kind))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11 * z).text_color(t.dim).child(d.tab ?? (d.parent ? "sub-agent" : ""))));
  }

  // Beautiful UI "tool chip": icon + state, tinted by what it means.
  chip(t, w, z) {
    const c = w.pr;
    const color = c.state === "open" ? (c.review === "changes" ? t.blocked : t.done) : c.state === "none" || c.state === "closed" ? t.dim : t.muted;
    const live = c.state !== "none";
    return h_flex().id(`pr-${w.id}`).flex_none().h(20 * z).px(8 * z).gap(4 * z).items_center().rounded(6 * z)
      .border(1).border_color(alpha(color, live ? 0.3 : 0.25)).when(live, (el) => el.bg(alpha(color, 0.1)))
      .text_size(11 * z).text_color(color)
      .when(live, (el) => el.cursor_pointer().tooltip(c.title || c.label)
        .hover((s) => s.bg(alpha(color, 0.2)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.openPr(w); }))
      .when(live, (el) => el.child(svg(ICON(c.state === "merged" ? "merge" : "pr")).size(11 * z).flex_none()))
      .child(c.label);
  }
}
