// The sidebar's Ports: every listening TCP server and the agent that owns it, below the inbox. A row opens the port
// card (mods/port-card): details, Open, Go to agent, Stop. lib.js decides everything; this file polls and draws.
// Its foot is the sidebar's last row, "Working N" (moved here from the inbox so it stays last), opening the graph.
// Polls every 5 s (lsof, ps, and git rev-parse once per agent folder) while the sidebar is open, and re-renders when
// the rows change. The one motion: Working's spinner turns (natively) while an agent works. The inbox sizes this block
// (rows right under its cards, the slack below them, Working last); this mod publishes what it needs as shared "ports.want".

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, home, agents, terminals, panes, spaces, layout, run, theme, shared, setShared, nextCommand, focused, openOverlay } from "herdr";
import { parseLsof, parseCwds, parsePs, ownerContext, servers, sortServers, ago, basename, byLine, ownerLines, stopFact, folderLabel, blockHeight, subAgents, cardHeight, isLocal, rootOf, CARD, ROW_H, HEADER_H, EMPTY_H, FOOT_H } from "./lib.js";

const POLL_MS = 5000;
const FOCUS_CHECK_MS = 250;
const OPEN_AFTER_MS = 150; // after the System popup has closed
const FORGOTTEN_S = 3600; // an orphan older than this reads as forgotten (amber age)
const RAIL_W = 160; // the sidebar folds to a rail below this width (as Inbox reads it)
const EXEC = { timeout: 4000 };
const ICON = (name) => `mods/ports/${name}.svg`;
// A row leads with what the server is (lib's kindOf); who started it sits on the right, by its branch.
const KIND = { web: ["app-window", "Web server"], db: ["database", "Database"], debug: ["bug", "Debugger"],
  docker: ["container", "Docker"], other: ["plug", "Server"] };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const width = () => find(layout(), "sidebar")?.size?.px ?? Infinity;
const folded = () => width() < RAIL_W || !!find(layout(), "sidebar")?.hidden;

// Back to the pane the keyboard came from (as inbox's back).
function back() {
  const f = focused();
  if (f) run("pane.focus", f.pane ? { pane: f.pane } : { terminal: f.terminal });
}

// Harness marks off a title; the same as inbox's clean (from agent-graph/lib.js cleanTitle).
const clean = (s) =>
  (s ?? "").replace(/^(?:[^\p{L}\p{N}\p{Ps}~/]+|\p{L}{1,2}\s*>\s*|\p{L}{1,2}\s+(?=[\p{S}\p{Co}⁂]))+/u, "")
    .replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/gu, "").replace(/\s+/g, " ").trim();

// What the agent is on: a tab someone named, else its own title (as inbox's task).
function task(a, tab) {
  const p = a?.program;
  if (tab?.named && tab.name !== p?.name) return tab.name;
  const t = clean(a?.title);
  return t && t !== p?.name && t.toLowerCase() !== p?.key && !/^[~/]/.test(t) && !t.includes("@") ? t : p?.name ?? tab?.name ?? "";
}

const NOBODY = { program: null, task: "", status: null, address: null, sub: false, probable: false, agent: false, tab: null, folder: null, branch: null };

export default class Ports extends View {
  init(_props, cx) {
    this.rows = [];
    this.roots = new Map(); // agent folder -> git top-level (null: not a repo), asked once per folder
    this.fh = cx.focus_handle();
    this.list = ScrollHandle.new();
    this.cur = null; // the cursor's row key
    this.openAt = shared("ports.open")?.at; // a request from before this load isn't for us
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.timer.after(0, (cx) => this.poll(cx));
    cx.timer.every(FOCUS_CHECK_MS, (cx) => { if (this.fh.is_focused() !== this.ringed) cx.notify(); }); // no blur event
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus" && this.rows.length) { this.cur ??= this.rows[0].key; this.fh.focus(); }
        else if (c === "back") back();
        else if (c === "toggle") run(this.fh.is_focused() ? "tabs-plus.fold" : "spaces-plus.focus"); // ⌘B: the last in Spaces → Inbox → Ports
        cx.notify();
      }
    });
  }

  async poll(cx) {
    if (this.busy || folded()) return;
    this.busy = true;
    try {
      const [ls, ps] = await Promise.all([
        exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], EXEC),
        exec("ps", ["-axo", "pid=,ppid=,etime=,comm="], EXEC),
      ]);
      if (ls.code === 127) throw new Error("lsof not found"); // lsof exits 1 when nothing listens: that's no rows
      const listeners = parseLsof(ls.stdout);
      const pids = [...new Set(listeners.map((l) => l.pid))];
      const cw = pids.length ? await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], EXEC) : { stdout: "" };
      const terms = terminals();
      await this.resolveRoots(terms);
      const ctx = ownerContext({ terminals: terms, roots: this.roots, home: home() });
      const rows = sortServers(servers({ listeners, procs: parsePs(ps.stdout), cwds: parseCwds(cw.stdout), ctx, home: home() }));
      const sig = JSON.stringify([rows.map((r) => [r.key, r.owner, r.by, r.web, r.network, r.ports, r.owner.kind === "orphan" && ago(r.age)])]);
      this.rows = rows;
      this.publishKeys(rows);
      if (sig !== this.sig || this.error) { this.sig = sig; this.error = null; cx.notify(); }
    } catch (e) {
      const error = String(e?.message ?? e).includes("not found") ? "lsof not found" : "Couldn't read ports";
      if (error !== this.error) { this.error = error; cx.notify(); }
    } finally {
      this.busy = false;
    }
  }

  // Each local terminal's folder -> its git top-level, once per folder (worktree matching for servers with no parent).
  async resolveRoots(terms) {
    const dirs = [...new Set(terms.filter(isLocal)
      .map((t) => t.foreground?.cwd ?? t.cwd).filter((d) => d && !this.roots.has(d)))];
    await Promise.all(dirs.map(async (d) => {
      const root = rootOf(await exec("git", ["-C", d, "rev-parse", "--show-toplevel"], EXEC).catch(() => null));
      if (root !== undefined) this.roots.set(d, root); // a failure isn't "not a repo": asked again next poll
    }));
  }

  // The rows' keys ("pid:port"), for the System popup to chip only ports this list can open. Written only on change.
  publishKeys(rows) {
    const keys = rows.map((r) => r.key);
    if (JSON.stringify(keys) === this.keysSent) return;
    this.keysSent = JSON.stringify(keys);
    setShared("ports.rows", keys);
  }

  // What the block needs (lib's blockHeight, from the row count alone), for the inbox to size it: the inbox shares the
  // column out and gives Ports the slack under its cards. Published only when it changes (shared writes to disk).
  want(px) {
    if (px === this.wantPx) return;
    this.wantPx = px;
    setShared("ports.want", px);
  }

  // How a row names its owner, from Herdr's live model (re-read every render: branches and states move).
  who(s, model) {
    const o = s.owner, folderText = folderLabel(s.cwd, home());
    // The card's words are decided in lib (ownerLines, stopFact); the card only draws them.
    const words = (w) => { const named = { ...w, program: w.program?.name, by: s.by, home: home(), folderText };
      return { ...w, folderText, ...ownerLines(named), fact: stopFact(named) }; };
    if (o.kind === "docker") return words({ ...NOBODY, label: "docker", kind: o.kind });
    if (o.kind === "orphan") return words({ ...NOBODY, label: byLine(s.by), kind: o.kind }); // who started it, never "no agent"
    const term = model.terms.get(o.address), pane = model.panes.get(o.address), agent = model.agents.get(o.address);
    const folder = pane?.cwd ?? term?.foreground?.cwd ?? term?.cwd;
    const space = agent?.space_name ?? model.spaces.find((sp) => sp.tabs.some((tb) => tb.id === pane?.tab))?.name ?? null;
    const w = {
      label: pane?.branch || basename(folder) || o.address,
      program: agent?.program ?? term?.program ?? null,
      task: [agent ? task(agent, model.tabs.get(agent.tab)) : clean(term?.title)].map((x) => (x === pane?.branch ? clean(agent?.title ?? term?.title) : x))
        .find((x) => x && x !== pane?.branch) ?? "", // a tab named after its branch says nothing the Branch line doesn't
      status: agent?.status ?? term?.status ?? null,
      address: o.address, sub: !!term?.parent, probable: o.kind === "probable", kind: o.kind,
      agent: !!(term?.program?.agent || term?.report), tab: pane?.tab ?? agent?.tab ?? null, folder: folder ?? null, branch: pane?.branch ?? null,
      space, why: o.why ?? null,
    };
    return words(w);
  }

  model() {
    return {
      terms: new Map(terminals().map((t) => [t.address, t])),
      panes: new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p])),
      agents: new Map(agents().map((a) => [a.address, a])),
      tabs: new Map(spaces().flatMap((sp) => sp.tabs).map((tb) => [tb.id, tb])),
      spaces: spaces(),
    };
  }

  // The port card, centred (a dialog, as confirm-safe), as tall as the lines it will show.
  card(s, who, ask = false) {
    openOverlay({ mod: "port-card", kind: "dialog", width: CARD.width, height: cardHeight(s, who), props: { server: s, who, ask } });
  }

  key(k, cx) {
    if (k === "ctrl-k") return run("inbox.focus");
    if (k === "ctrl-l" || k === "escape") return back();
    const rows = this.rows, i = rows.findIndex((r) => r.key === this.cur);
    if (k === "up" || k === "down") {
      const j = Math.max(0, Math.min(rows.length - 1, i + (k === "up" ? -1 : 1)));
      this.cur = rows[j]?.key ?? null;
      if (this.cur) this.list.scroll_to_item(j);
    } else if ((k === "enter" || k === "left") && i >= 0) {
      this.card(rows[i], this.who(rows[i], this.model()), k === "left" && rows[i].owner.kind !== "docker"); // never Stop Docker
    }
    cx.notify();
  }

  // The System popup's port chip (shared "ports.open" { key, at }): that row's card, once the popup has closed. The
  // popup chips only keys this list published (ports.rows).
  openAsked(cx, rows) {
    const want = shared("ports.open");
    if (!want || want.at === this.openAt) return;
    this.openAt = want.at;
    const r = rows.find((x) => x.key === want.key);
    if (r) cx.timer.after(OPEN_AFTER_MS, () => this.card(r, this.who(r, this.model())));
  }

  // A dialog of ours took the keyboard from here: it comes back when that closes (as inbox's comeBack).
  comeBack(cx, held, focus) {
    const ov = shared("emergence.over");
    if (!ov || ov.at === this.ovAt) return;
    this.ovAt = ov.at;
    if (ov.open) this.resume ||= held;
    else if (this.resume) cx.timer.after(80, (cx) => {
      if (shared("emergence.over")?.open) return;
      this.resume = false;
      if (!ov.went) { focus(); cx.notify(); }
    });
  }

  // The owner's program mark (programs.json), at half strength when the owner is only probable; a hollow ring when
  // there's no agent (orphan, docker).
  mark(t, w, size) {
    const p = w.program;
    if (!p?.icon) return div().size(size).flex_none().rounded(size / 2).border(1).border_color(t.dim);
    const m = p.tint && p.tile
      ? h_flex().size(size).rounded(5).bg(p.tile).items_center().justify_center().child(svg(p.icon).size(Math.round(size * 0.66)).text_color(p.color ?? t.foreground))
      : p.tint ? svg(p.icon).size(size).text_color(t.foreground) : image(p.icon).w(size).h(size).rounded(5);
    return div().size(size).flex_none().when(w.probable, (el) => el.opacity(0.5)).child(m);
  }

  row(t, s, i, model) {
    const w = this.who(s, model), over = this.hovered === s.key, orphan = s.owner.kind === "orphan";
    const open = h_flex().id(`port-open-${s.key}`).h(18).px(6).gap(4).flex_none().items_center().rounded(5)
      .border(1).border_color(t.border).text_size(11).text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(s.url).on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(s.url); })
      .child(svg(ICON("external-link")).size(11)).child("Open");
    const owned = s.owner.kind === "sure" || s.owner.kind === "probable";
    const owner = h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().text_size(11.5).text_color(t.dim)
      .when(s.network, (el) => el.child(div().id(`port-net-${s.key}`).flex_none().tooltip("Your network can reach it")
        .child(svg(ICON("globe")).size(12).text_color(t.dim))))
      .when(owned, (el) => el.child(this.mark(t, w, 12)))
      .child(orphan
        ? h_flex().min_w(0).gap(4).child(div().min_w(0).truncate().child(w.label)).child("·")
          .child(div().flex_none().when(s.age > FORGOTTEN_S, (el) => el.text_color(t.working)).child(ago(s.age)))
        : div().min_w(0).truncate().child(w.label));
    const [icon, what] = KIND[s.kind] ?? KIND.other;
    return h_flex().id(`port-${s.key}`).h(ROW_H).px(10).gap(8).flex_none().items_center().rounded(8).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .when(this.ringed && this.cur === s.key, (el) => el.border_1().border_color(t.accent))
      .on_hover((on, cx) => { if (on) this.hovered = s.key; else if (this.hovered === s.key) this.hovered = null; cx.notify(); })
      .on_click(() => { this.cur = s.key; this.card(s, w); })
      .child(div().id(`port-kind-${s.key}`).flex_none().tooltip(what).child(svg(ICON(icon)).size(14).text_color(t.muted)))
      .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(`:${s.port}`))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(s.command))
      .child(over && s.web ? h_flex().flex_1().justify_end().child(open) : owner);
  }

  // "Working N", always there (N may be 0): opens the Agents panel on what's working, else on everything (as the
  // inbox's row did). Sub-agents count: agents() misses them.
  working(t) {
    const tabbed = agents(), all = [...tabbed, ...subAgents(terminals(), new Set(tabbed.map((a) => a.address)))];
    const n = all.filter((a) => a.status === "working").length;
    // The graph decides Active or All itself each time it opens (agent-graph lib openOnActive).
    const open = () => { if (find(layout(), "panel")?.hidden || find(layout(), "panel-body")?.active !== "graph") run("tabs-plus.graph"); };
    return h_flex().id("ports-working").h(FOOT_H).px(16).gap(8).flex_none().items_center().text_size(12).text_color(t.muted)
      .border_t(1).border_color(t.border).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(open)
      .tooltip(n ? "Open the agent graph on what's working" : "Open the agent graph")
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(n ? t.working : t.dim).when(n > 0, (el) => el.spin(900))) // native: AGENTS.md
      .child("Working").child(div().text_size(11).text_color(t.dim).child(String(n))).child(div().flex_1())
      .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).text_color(t.dim));
  }

  render(cx) {
    const t = theme(), collapsed = folded(), rows = this.rows;
    this.want(blockHeight(rows.length, collapsed));
    // The cursor stays on its row; when that row goes, it takes the row now in its place.
    let i = rows.findIndex((r) => r.key === this.cur);
    if (i < 0) i = Math.min(this.curI ?? 0, rows.length - 1);
    this.cur = rows[i]?.key ?? null;
    this.curI = Math.max(i, 0);
    if (!rows.some((r) => r.key === this.hovered)) this.hovered = null;
    this.comeBack(cx, this.ringed, () => this.fh.focus());
    this.ringed = this.fh.is_focused();
    this.openAsked(cx, rows);
    const root = v_flex().id("ports").size_full().min_h(0).bg(t.chrome).text_size(13)
      .track_focus(this.fh).on_key_down((e, cx) => this.key(e.keystroke, cx));
    if (collapsed) return root;
    const label = (extra) => h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
      .child(div().font_medium().child("Ports")).child(extra);
    if (this.error || !rows.length) {
      return root.border_t(1).border_color(t.border)
        .child(h_flex().h(EMPTY_H).flex_none().pl(16).pr(12).items_center().child(label(this.error ?? "none")))
        .child(div().flex_1()).child(this.working(t));
    }
    const model = this.model();
    return root.border_t(1).border_color(t.border)
      .child(h_flex().h(HEADER_H).pt(10).pl(16).pr(12).flex_none().items_center().child(label(String(rows.length))))
      .child(v_flex().id("ports-list").flex_1().min_h(0).px(6).overflow_y_scrollbar().track_scroll(this.list)
        .children(rows.map((s, n) => this.row(t, s, n, model))))
      .child(this.working(t));
  }
}
