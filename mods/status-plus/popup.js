// The System popup: CPU, Memory and Disk tabs, each saying which agent and which process is using it. Opened by the
// bar (bar.js) on the tab clicked; polls only while open. By-agent rows go to the agent; a process that listens on a
// port has a chip that opens that port's card in Ports (shared "ports.open"). Disk measures each worktree once,
// one at a time, and keeps the sizes five minutes (shared "system.du").
// Every close gives the keyboard back to where it was (shared emergence.over), unless a row took it elsewhere.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, props, closeOverlay, theme, terminals, panes, agents, run, shared, setShared } from "herdr";
import { parseVmStat, memUsed, parseSysctl, parseSwap, parseDf, parseProcs, cpuSample, localTerminals, chainOwner, byAgent,
  topProcs, level, fmtBytes, worktreePaths, parseDu, portsByPid, splitAgents, chipPort } from "./lib.js";

const FIRST_MS = 1000; // the second sample comes quickly, so CPU shows within a second
const FAST_MS = 5000;
const DU_KEEP_MS = 5 * 60 * 1000;
const DU_TIMEOUT_MS = 30000;
const TOP_N = 8;
const ROW_H = 32;
const COL = { owner: 150, value: 84, size: 120 }; // fixed columns, so names, owners and values line up down the list
// Emergence's dialog standard (RECIPE "Dialogs"): 24px padding, 16px gaps, a 22px title row with the Esc chip, 32px
// buttons of which only the one Enter presses is filled; widths 440 / 560 / 680. Type is Herdr's (no font set).
const PAD = 24, GAP = 16;
const EXEC = { timeout: 4000 };
const TABS = [["cpu", "CPU"], ["mem", "Memory"], ["disk", "Disk"]];

async function out(cmd, args, opts = EXEC) {
  const r = await exec(cmd, args, opts).catch(() => null);
  return r?.code === 0 ? r.stdout : null;
}

const basename = (p) => (p ?? "").split("/").filter(Boolean).pop() ?? "";
const tilde = (p) => (p && home() && p.startsWith(home()) ? `~${p.slice(home().length)}` : p ?? "");
const pct = (v) => (v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`);

export class Popup {
  constructor(cx) {
    setShared("emergence.over", { at: Date.now(), open: true });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.tab = props()?.tab ?? "cpu";
    this.cur = 0; // the keyboard's row among the actionable ones
    this.ports = new Map();
    this.sizes = shared("system.du")?.at > Date.now() - DU_KEEP_MS ? shared("system.du").sizes : null;
    this.poll(cx);
    cx.timer.after(FIRST_MS, (cx) => this.poll(cx));
    cx.timer.every(FAST_MS, (cx) => this.poll(cx));
    out("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).then((t) => { this.ports = portsByPid(t); cx.notify(); });
    out("df", ["-k", home()]).then((t) => { this.disk = t && parseDf(t); cx.notify(); });
    if (this.tab === "disk") this.measure(cx);
  }

  async poll(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const [ps, vm, sys, swap] = await Promise.all([
        out("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="]), out("vm_stat", []),
        out("sysctl", ["-n", "hw.memsize", "hw.ncpu", "kern.memorystatus_vm_pressure_level"]), out("sysctl", ["-n", "vm.swapusage"]),
      ]);
      this.sys = sys && parseSysctl(sys);
      const v = vm && parseVmStat(vm);
      this.mem = this.sys && v ? { used: memUsed(v), total: this.sys.total, pressure: this.sys.pressure, swap: swap && parseSwap(swap) } : null;
      if (ps && this.sys) {
        const next = { at: Date.now(), procs: parseProcs(ps) };
        this.cpu = cpuSample(this.sample, next, this.sys.cores) ?? this.cpu;
        this.sample = next;
      }
      cx.notify();
    } finally {
      this.busy = false;
    }
  }

  // Every worktree of the repos this computer's terminals are in, measured one at a time (du is slow on big trees).
  async measure(cx) {
    if (this.sizes || this.measuring) return;
    this.measuring = true;
    this.sizes = {};
    const dirs = [...new Set(terminals().filter((t) => t.state === "live" && t.machine == null && !String(t.address).includes("/"))
      .map((t) => t.foreground?.cwd ?? t.cwd).filter(Boolean))];
    const lists = await Promise.all(dirs.map((d) => out("git", ["-C", d, "worktree", "list", "--porcelain"])));
    const paths = [...new Set(lists.flatMap((l) => worktreePaths(l)))];
    this.paths = paths;
    cx.notify();
    for (const p of paths) {
      const kb = parseDu(await out("du", ["-sk", p], { timeout: DU_TIMEOUT_MS }));
      this.sizes = { ...this.sizes, [p]: kb ?? "big" };
      cx.notify();
    }
    setShared("system.du", { at: Date.now(), sizes: this.sizes });
    this.measuring = false;
  }

  dismiss(went = false) {
    this.went = went;
    closeOverlay(props().overlay);
  }

  async dismissed() { setShared("emergence.over", { at: Date.now(), open: false, went: !!this.went }); }

  goTo(address) {
    run("agent.focus", { terminal: address });
    run("pane.focus", { terminal: address });
    this.dismiss(true);
  }

  openPort(pid, port) {
    setShared("ports.open", { key: `${pid}:${port}`, port, at: Date.now() });
    this.dismiss(true);
  }

  switchTab(k, cx) {
    this.tab = k;
    this.cur = 0;
    if (k === "disk") this.measure(cx);
    cx.notify();
  }

  key(e, cx) {
    const acts = this.acts ?? [];
    const i = TABS.findIndex(([k]) => k === this.tab);
    if (e.key === "escape") this.dismiss();
    else if (e.key === "left" || e.key === "right") this.switchTab(TABS[(i + (e.key === "left" ? -1 : 1) + TABS.length) % TABS.length][0], cx);
    else if (e.key === "up" || e.key === "down") { this.cur = Math.max(0, Math.min(acts.length - 1, this.cur + (e.key === "up" ? -1 : 1))); cx.notify(); }
    else if (e.key === "enter") acts[this.cur]?.();
    else return;
    cx.stop_propagation();
  }

  // The program's mark, as Ports and the inbox draw it.
  mark(t, p) {
    if (!p?.icon) return div().size(14).flex_none().rounded(7).border(1).border_color(t.dim);
    if (p.tint && p.tile) return h_flex().size(14).flex_none().rounded(4).bg(p.tile).items_center().justify_center()
      .child(svg(p.icon).size(9).text_color(p.color ?? t.foreground));
    return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).w(14).h(14).flex_none().rounded(4);
  }

  render() {
    const t = theme(), tab = this.tab;
    const ink = { ok: t.accent, warn: t.working, crit: t.blocked };
    const terms = new Map(terminals().map((x) => [x.address, x]));
    const paneOf = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const agentOf = new Map(agents().map((a) => [a.address, a]));
    const where = (address) => paneOf.get(address)?.branch || basename(paneOf.get(address)?.cwd ?? terms.get(address)?.foreground?.cwd) || address;
    const byPid = localTerminals(terminals());
    const rowKeys = new Set(shared("ports.rows") ?? []); // chips only for ports Ports has a row for (it opens the card)
    const procs = this.sample?.procs ?? new Map(), cpuBy = this.cpu?.byPid ?? new Map();
    const acts = [];
    const act = (fn) => { acts.push(fn); return acts.length - 1; };
    const ringed = (i) => i === this.cur;

    const tabs = h_flex().h(28).p(2).gap(2).flex_none().rounded(8).bg(t.raised)
      .children(TABS.map(([k, label]) => h_flex().id(`sys-tab-${k}`).flex_1().h_full().items_center().justify_center().rounded(6).text_size(12)
        .cursor_pointer().when(tab === k, (el) => el.bg(t.background).text_color(t.foreground).font_medium())
        .when(tab !== k, (el) => el.text_color(t.muted).hover((x) => x.text_color(t.foreground)))
        .on_click((_e, cx) => this.switchTab(k, cx)).child(label)));

    const headline = (big, caption, fill, lvl) => v_flex().gap(10).flex_none()
      .child(h_flex().items_baseline().gap(8)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(big))
        .child(div().flex_1()).child(div().text_size(12).text_color(t.muted).child(caption)))
      .child(div().h(6).w_full().rounded(3).bg(t.raised)
        .child(div().h_full().rounded(3).bg(ink[lvl] ?? t.accent).w(`${Math.max(0, Math.min(100, (fill ?? 0) * 100))}%`)));

    // A section's header names its columns, at the same widths and alignment as its rows' ("left" for text, else right).
    const section = (label, cols = []) => h_flex().flex_none().pt(10).pb(4).px(10).gap(10).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_1().child(label))
      .children(cols.map(([text, w, align]) => div().w(w).flex_none().when(align !== "left", (el) => el.text_right()).child(text)));
    const row = (id, i, children, onClick) => h_flex().id(id).h(ROW_H).px(10).gap(10).flex_none().items_center().rounded(8).text_size(12.5)
      .when(!!onClick, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => onClick()))
      .when(i != null && ringed(i), (el) => el.bg(t.selected))
      .children(children);
    const cell = (text, w, color = t.foreground) => div().w(w).flex_none().text_right().truncate().text_size(12).text_color(color).child(text);
    const quiet = (text) => div().px(10).h(ROW_H).flex().flex_none().items_center().text_size(12).text_color(t.dim).child(text);

    let head, list;
    if (tab === "disk") {
      const d = this.disk, sizes = this.sizes ?? {};
      const items = (this.paths ?? Object.keys(sizes)).map((p) => [p, sizes[p]]).sort((a, b) => (typeof b[1] === "number" ? b[1] : -1) - (typeof a[1] === "number" ? a[1] : -1));
      head = d ? headline(`${fmtBytes(d.free * 1024)} free`, `of ${fmtBytes(d.size * 1024)}`, 1 - d.free / d.size, level("disk", d.free / d.size)) : headline("…", "", 0, "ok");
      list = [section("Worktrees", [["Size", COL.size]]),
        ...(items.length ? items.map(([p, kb]) => row(`du-${p}`, null, [
          div().flex_1().min_w(0).whitespace_nowrap().overflow_hidden().text_ellipsis_start().text_size(12).text_color(t.foreground).child(tilde(p)),
          cell(kb == null ? "…" : kb === "big" ? "too big" : fmtBytes(kb * 1024), COL.size, kb == null || kb === "big" ? t.dim : t.foreground),
        ])) : [quiet(this.measuring ? "Finding worktrees…" : "No worktrees in your open terminals")])];
    } else {
      const key = tab === "cpu" ? "cpu" : "rss", measure = tab === "cpu" ? "CPU" : "Memory";
      const { shown, rest } = (({ rows, rest }) => splitAgents(rows, rest, key))(byAgent(procs, cpuBy, byPid));
      const fmt = (v) => (key === "cpu" ? pct(v) : fmtBytes(v * 1024));
      head = tab === "cpu"
        ? (this.cpu ? headline(pct(this.cpu.total), `of ${this.sys?.cores ?? "?"} cores`, this.cpu.total / 100, level("cpu", this.cpu.total)) : headline("…", "measuring", 0, "ok"))
        : (this.mem ? headline(`${fmtBytes(this.mem.used)} of ${fmtBytes(this.mem.total)}`,
          `pressure ${this.mem.pressure}${this.mem.swap != null ? ` · swap ${fmtBytes(this.mem.swap)}` : ""}`, this.mem.used / this.mem.total, level("mem", this.mem.pressure))
          : headline("…", "", 0, "ok"));
      const agentRows = shown.map((r) => {
        const i = act(() => this.goTo(r.address));
        return row(`ag-${r.address}`, i, [
          this.mark(t, agentOf.get(r.address)?.program ?? terms.get(r.address)?.program),
          div().flex_1().min_w(0).truncate().text_color(t.foreground).child(where(r.address)),
          cell(fmt(r[key]), COL.value),
        ], () => this.goTo(r.address));
      });
      const procRows = topProcs(procs, cpuBy, key, TOP_N).map((p) => {
        const owner = chainOwner(p.pid, procs, byPid), port = chipPort(p.pid, this.ports.get(p.pid), rowKeys);
        const i = port ? act(() => this.openPort(p.pid, port)) : null;
        return row(`pr-${p.pid}`, i, [
          h_flex().flex_1().min_w(0).gap(8).items_center()
            .child(div().min_w(0).truncate().text_color(t.foreground).child(basename(p.comm)))
            .when(!!port, (el) => el.child(h_flex().id(`pr-port-${p.pid}`).flex_none().h(18).px(5).items_center().rounded(4).border(1).border_color(t.border)
              .text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
              .tooltip("Open its port card").on_click((_e, cx) => { cx.stop_propagation(); this.openPort(p.pid, port); }).child(`:${port}`))),
          div().w(COL.owner).flex_none().truncate().text_size(12).text_color(t.dim).child(owner ? where(owner) : "—"),
          cell(key === "cpu" ? pct(cpuBy.get(p.pid) ?? 0) : fmtBytes(p.rss * 1024), COL.value),
        ], port ? () => this.openPort(p.pid, port) : null);
      });
      list = [
        section("By agent", [[measure, COL.value]]),
        ...(agentRows.length ? agentRows : [quiet("No agent is using much")]),
        row("ag-rest", null, [div().size(14).flex_none(), div().flex_1().text_color(t.dim).child("Everything else"), cell(fmt(rest[key]), COL.value, t.dim)]),
        section("Top processes", [["Started by", COL.owner, "left"], [measure, COL.value]]),
        ...procRows,
      ];
    }
    this.acts = acts;
    this.cur = Math.min(this.cur, Math.max(0, acts.length - 1));

    // A centred dialog of fixed size (as the port card): header, headline, then the lists scroll inside.
    return v_flex().id("system-card").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(PAD).gap(GAP).rounded(10).bg(t.popover).text_size(13)
      .child(h_flex().flex_none().gap(12).items_center().child(div().flex_1().child(tabs))
        .child(div().id("sys-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => this.dismiss()).child("Esc")))
      .child(head)
      .child(v_flex().id(`sys-list-${tab}`).flex_1().min_h(0).mx(-10).overflow_y_scrollbar().children(list));
  }
}
