// The status bar: Herdr 0.1.15's workspace-status (MIT), plus this Mac's CPU, memory, disk and (on battery) battery on
// the right, each opening the System popup (popup.js, this mod opened as a popup) on its tab. lib.js parses and
// decides; this file polls and draws. Nothing animates; it re-renders only when a shown number or colour changes.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window as herdrWindow, keys, exec, home, settings, openOverlay } from "herdr";
import { parseVmStat, memUsed, parseSysctl, parseDf, parseBattery, parseProcs, cpuSample, segments } from "./lib.js";

const FAST_MS = 5000; // ps, vm_stat, sysctl
const SLOW_MS = 60000; // df, pmset
const CPU_SAMPLES = 2; // the bar's CPU is the mean of the last two samples (10 s)
const EXEC = { timeout: 4000 };
const ICON = { cpu: "cpu", mem: "memory-stick", disk: "hard-drive", battery: "battery-medium" };
const TIP = { cpu: "CPU, last 10 s. Click for who's using it", mem: "Memory used of total; its colour follows memory pressure",
  disk: "Free space on your home volume", battery: "Battery" };
const POPUP = { width: 560, height: 640, share: 0.8 }; // a centred dialog, as the port card; at most 80% of the window high

// A command's stdout, or null when it's missing, failed or timed out (that number then isn't shown).
async function run_(cmd, args) {
  const r = await exec(cmd, args, EXEC).catch(() => null);
  return r?.code === 0 ? r.stdout : null;
}

export class Bar {
  constructor(cx) {
    this.cpus = []; // the last CPU_SAMPLES totals
    this.width = Infinity;
    this.fast(cx);
    this.slow(cx);
    cx.timer.every(FAST_MS, (cx) => this.fast(cx));
    cx.timer.every(SLOW_MS, (cx) => this.slow(cx));
  }

  async fast(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const [ps, vm, sys] = await Promise.all([
        run_("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="]),
        run_("vm_stat", []),
        run_("sysctl", ["-n", "hw.memsize", "hw.ncpu", "kern.memorystatus_vm_pressure_level"]),
      ]);
      const s = sys && parseSysctl(sys), v = vm && parseVmStat(vm);
      this.mem = s && v ? { used: memUsed(v), total: s.total, pressure: s.pressure } : null;
      if (ps && s) {
        const next = { at: Date.now(), procs: parseProcs(ps) };
        const c = cpuSample(this.sample, next, s.cores);
        this.sample = next;
        if (c) this.cpus = [...this.cpus, c.total].slice(-CPU_SAMPLES);
      }
      this.changed(cx);
    } finally {
      this.busy = false;
    }
  }

  async slow(cx) {
    const [df, batt] = await Promise.all([run_("df", ["-k", home()]), run_("pmset", ["-g", "batt"])]);
    this.disk = df && parseDf(df);
    this.battery = batt && parseBattery(batt);
    this.changed(cx);
  }

  segs() {
    const cpu = this.cpus.length ? this.cpus.reduce((a, b) => a + b, 0) / this.cpus.length : null;
    return segments({ cpu, mem: this.mem, disk: this.disk, battery: this.battery }, this.width);
  }

  // Re-render only when what the bar shows changes.
  changed(cx) {
    const sig = JSON.stringify(this.segs());
    if (sig !== this.sig) { this.sig = sig; cx.notify(); }
  }

  // The palette key as actually bound, not a hardcoded one; without a binding the hint stays useful ("commands")
  // instead of lying. (Herdr's own.)
  hint() {
    const mac = herdrWindow()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  open(tab) {
    const h = Math.min(POPUP.height, Math.round(window.viewport_size().height / (settings().zoom ?? 1) * POPUP.share));
    openOverlay({ mod: "status-plus", kind: "dialog", width: POPUP.width, height: h, props: { popup: true, tab } });
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const ink = { ok: t.muted, warn: t.working, crit: t.blocked };
    const segs = this.segs();
    const seg = (s) => h_flex().id(`sys-${s.id}`).h(22).px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .text_color(ink[s.level]).hover((x) => x.bg(t.hover)).tooltip(TIP[s.id]).on_click(() => this.open(s.id === "battery" ? "cpu" : s.id))
      .child(svg(`mods/status-plus/${s.id === "battery" && s.level !== "ok" ? "battery-low" : ICON[s.id]}.svg`).size(13))
      .child(div().child(s.text));
    return h_flex().id("status-plus").size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .on_size_change((size, cx) => {
        const w = Math.round(size.width / (settings().zoom ?? 1));
        if (w !== this.width) { this.width = w; this.changed(cx); }
      })
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(space?.machine), (el) => el.child(div().text_color(t.dim).child("This Mac")))
      .child(h_flex().gap(4).items_center().children(segs.map(seg)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
