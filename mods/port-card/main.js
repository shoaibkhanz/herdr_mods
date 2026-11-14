// The port card: one listening server in detail, opened by Ports as a popup with props { server, who, ask }
// (mods/ports/main.js computes both; this mod decides nothing about ownership). Open, copy, Go to agent, Stop.
// Stop asks here, Cancel selected (Enter alone cancels, as confirm-safe), re-checks that the pid still holds the port
// (it may have exited, and its pid been reused), then sends SIGTERM. Live CPU / memory from `ps` every 5 s.
// Every close gives the keyboard back to where it was (shared emergence.over), unless Open or Go to took it elsewhere.

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, props, closeOverlay, theme, home, setShared, notify } from "herdr";
import { formatMem, shortArgs, canStop, statOutcome, heldOutcome } from "./lib.js";

const REFRESH_MS = 5000;
const STOP_CHECK_MS = 1000, STOP_WAIT_MS = 10000; // after SIGTERM: check each second, give up after ten
const CLOSE_AFTER_STOP_MS = 1200;
const COPIED_MS = 1500;
// Emergence's dialog standard (RECIPE "Dialogs"): 24px padding, 16px gaps, a 15px title row with a clickable Esc chip,
// 34px buttons; widths 440 / 560 / 680.
const LABEL_W = 72;
// The same measures as mods/ports/lib.js CARD, which sizes this dialog from them (keep the two in step).
const M = { pad: 24, gap: 16, header: 22, url: 34, line: 20, task: 20, fieldGap: 10, buttons: 34 };
const EXEC = { timeout: 4000 };
const MONO = "Geist Mono";
const ICON = (name) => `mods/port-card/${name}.svg`;
const KIND = { web: "app-window", db: "database", debug: "bug", docker: "container", other: "plug" }; // as the Ports row
const STATUS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };

const alpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
const ago = (sec) => { const m = Math.floor(sec / 60); return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`; };
// Geist Mono swallows the space before "--" and gpui can't turn ligatures off: a zero-width non-joiner between the
// hyphens keeps the text as typed (display only; the tooltip and copy keep the real text).
const noLigatures = (text) => text.replace(/-(?=-)/g, "-\u200C");
const tilde = (p) => (p && home() && p.startsWith(home()) ? `~${p.slice(home().length)}` : p ?? "");

export default class PortCard extends View {
  init(_props, cx) {
    setShared("emergence.over", { at: Date.now(), open: true });
    this.handle = cx.focus_handle();
    this.handle.focus();
    const s = props()?.server;
    this.asking = !!props()?.ask && canStop(props()?.who);
    this.sel = null; // the selected button's id; null: the default
    this.stat = null; // { age, rss, cpu } from the last ps
    this.state = "live"; // live | stopping | stopped | still
    if (!s) return; // herdr-app check: no props
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    exec("ps", ["-p", String(s.pid), "-o", "args="], EXEC).then((r) => { this.args = r.stdout.trim(); cx.notify(); }).catch(() => {});
  }

  async refresh(cx) {
    if (this.state !== "live") return;
    const s = props().server;
    const stat = statOutcome(await exec("ps", ["-p", String(s.pid), "-o", "etime=,rss=,%cpu="], EXEC).catch(() => null));
    if (stat === "error") return; // a timeout or failed exec: keep what's shown, try again next time
    if (stat === "gone") { this.state = "stopped"; cx.notify(); return; }
    this.stat = stat;
    cx.notify();
  }

  dismiss(went = false) {
    this.went = went;
    closeOverlay(props().overlay);
  }

  // Herdr closes a popup on Esc and on a click outside, past key(): this still runs. ("close" is the lifecycle name.)
  async close() { setShared("emergence.over", { at: Date.now(), open: false, went: !!this.went }); }

  open(cx) {
    cx.open_url(props().server.url);
    this.dismiss(true);
  }

  goTo() {
    const w = props().who;
    if (w.sub) run("terminal.peek", { terminal: w.address });
    else if (w.agent) { run("agent.focus", { terminal: w.address }); run("pane.focus", { terminal: w.address }); }
    else { if (w.tab) run("tab.select", { id: w.tab }); run("pane.focus", { terminal: w.address }); }
    this.dismiss(true);
  }

  // Whether this pid still holds this port (it may have exited, and its pid gone to something else): true, false, or
  // null when lsof itself failed.
  async held() {
    const { pid, port } = props().server;
    const r = await exec("lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"], EXEC).catch(() => null);
    return heldOutcome(r, pid, port);
  }

  async stop(cx) {
    const { pid, port } = props().server;
    this.asking = false;
    if (!canStop(props().who)) return; // never Docker, however Stop was reached
    const held = await this.held();
    if (held === null) {
      notify({ title: `Couldn't check :${port}`, body: "Nothing was stopped. Try again.", level: "warning" });
      cx.notify();
      return;
    }
    if (!held) {
      notify({ title: `:${port} already stopped`, level: "info" });
      this.state = "stopped";
      cx.notify();
      return;
    }
    const k = await exec("kill", [String(pid)], EXEC).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (k.code !== 0) {
      notify({ title: `Couldn't stop :${port}`, body: (k.stderr ?? "").trim(), level: "error" });
      cx.notify();
      return;
    }
    this.state = "stopping";
    cx.notify();
    for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_CHECK_MS) {
      await new Promise((ok) => cx.timer.after(STOP_CHECK_MS, ok));
      if ((await this.held()) === false) { // null (lsof failed) keeps waiting
        this.state = "stopped";
        cx.notify();
        cx.timer.after(CLOSE_AFTER_STOP_MS, () => { if (this.state === "stopped") this.dismiss(); });
        return;
      }
    }
    this.state = "still";
    notify({ title: `:${port} is still running`, body: "Something may have restarted it (a watcher, or the agent).", level: "warning" });
    cx.notify();
  }

  // The buttons for the moment: the question while asking, else Go to · Stop · Open (each where it applies).
  buttons() {
    const s = props().server, w = props().who, t = theme(), live = this.state === "live";
    if (this.asking && canStop(w)) return [
      { id: "cancel", label: "Cancel", act: (cx) => { this.asking = false; this.sel = null; cx.notify(); } },
      { id: "stop", label: "Stop", ink: t.blocked, act: (cx) => this.stop(cx) },
    ];
    const go = w.kind === "sure" || w.kind === "probable"
      ? [{ id: "go", label: w.agent ? (w.probable ? "Go to agent?" : "Go to agent") : "Go to terminal", act: () => this.goTo() }] : [];
    const stop = canStop(w) && live ? [{ id: "ask", label: "Stop", ink: t.blocked, act: (cx) => { this.asking = true; this.sel = null; cx.notify(); } }] : [];
    const open = s.web && live ? [{ id: "open", label: "Open", hint: "↵", ink: t.accent, act: (cx) => this.open(cx) }] : [];
    return [...go, ...stop, ...open];
  }

  selected(list) {
    const fallback = this.asking ? "cancel" : list.find((b) => b.id === "open")?.id ?? list[0]?.id;
    return list.some((b) => b.id === this.sel) ? this.sel : fallback;
  }

  key(e, cx) {
    const list = this.buttons(), i = list.findIndex((b) => b.id === this.selected(list));
    if (e.key === "escape") this.dismiss();
    else if (e.key === "enter") list[i]?.act(cx);
    else if (["left", "right", "tab"].includes(e.key) && list.length) {
      const step = e.key === "left" ? -1 : 1;
      this.sel = list[(i + step + list.length) % list.length].id;
      cx.notify();
    } else return;
    cx.stop_propagation();
  }

  copy(cx, text) {
    cx.write_to_clipboard(text);
    this.copied = true;
    cx.notify();
    cx.timer.after(COPIED_MS, (cx) => { this.copied = false; cx.notify(); });
  }

  // The owner's program mark, at half strength when only probable (as the Ports row draws it).
  mark(t, w, size) {
    const p = w.program;
    if (!p?.icon) return div().size(size).flex_none().rounded(size / 2).border(1).border_color(t.dim);
    const m = p.tint && p.tile
      ? h_flex().size(size).rounded(4).bg(p.tile).items_center().justify_center().child(svg(p.icon).size(Math.round(size * 0.66)).text_color(p.color ?? t.foreground))
      : p.tint ? svg(p.icon).size(size).text_color(t.foreground) : image(p.icon).w(size).h(size).rounded(4);
    return div().size(size).flex_none().when(w.probable, (el) => el.opacity(0.5)).child(m);
  }

  render() {
    const t = theme(), p = props();
    if (!p?.server) return div().id("port-card").size_full().bg(t.popover); // herdr-app check
    const s = p.server, w = p.who;
    const field = (label, value) => h_flex().min_h(M.line).gap(12).items_start()
      .child(div().w(LABEL_W).h(M.line).flex_none().flex().items_center().text_size(11.5).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).child(value));
    const mono = (text, tip) => div().id(`v-${text}`).truncate().font_family(MONO).text_size(12).text_color(t.foreground)
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(text);
    const address = s.web ? s.url : s.url.replace(/^http:\/\//, "");

    const agentLine = w.kind === "docker" ? div().text_color(t.foreground).child("Docker")
      : w.kind === "orphan" ? div().truncate().text_color(t.foreground).child(w.detail ?? w.label) // who started it (Ports' byLine)
      : v_flex()
        .child(h_flex().h(M.line).gap(6).items_center().text_color(t.foreground)
          .child(this.mark(t, w, 14))
          .child(div().truncate().child([w.program?.name ?? "Terminal", w.probable ? "probably" : w.agent ? STATUS[w.status] ?? w.status : null].filter(Boolean).join(" · "))))
        .when(Boolean(w.task), (el) => el.child(div().h(M.task).flex().items_center().text_size(12).text_color(t.muted)
          .child(div().truncate().child(w.task))));

    const st = this.stat;
    const running = this.state === "stopping" ? "Stopping…" : this.state === "stopped" ? "Stopped" : this.state === "still" ? "Still running"
      : st ? `${ago(st.age)} · ${st.cpu}% CPU · ${formatMem(st.rss)}` : "…";
    const others = s.ports.filter((x) => x !== s.port);

    const list = this.buttons(), sel = this.selected(list);
    const button = (b) => h_flex().id(`pc-${b.id}`).h(M.buttons).px(14).gap(6).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(sel === b.id ? t.accent : b.ink ? alpha(b.ink, 0.4) : t.input)
      .bg(b.ink ? alpha(b.ink, sel === b.id ? 0.2 : 0.1) : sel === b.id ? t.selected : t.raised)
      .text_color(b.ink ?? t.foreground).font_medium().hover((x) => x.opacity(0.88))
      .on_click((_e, cx) => b.act(cx))
      .child(b.label).when(Boolean(b.hint), (el) => el.child(div().text_size(11).opacity(0.7).child(b.hint)));

    return v_flex().id("port-card").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(M.pad).gap(M.gap).rounded(10).bg(t.popover).text_size(13)
      .child(h_flex().h(M.header).flex_none().items_center().gap(10)
        .child(svg(ICON(KIND[s.kind] ?? "plug")).size(16).flex_none().text_color(t.muted))
        .child(div().flex_none().font_family(MONO).text_size(15).font_semibold().text_color(t.foreground).child(`:${s.port}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.command))
        .child(div().id("pc-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => this.dismiss()).child("Esc")))
      .child(h_flex().id("pc-url").flex_none().px(12).h(M.url).gap(8).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12.5).text_color(t.foreground).child(address))
        .child(h_flex().id("pc-copy").flex_none().gap(4).items_center().cursor_pointer().text_size(11).text_color(t.muted)
          .hover((x) => x.text_color(t.foreground)).tooltip("Copy")
          .on_click((_e, cx) => this.copy(cx, address))
          .child(this.copied ? div().child("Copied") : svg(ICON("copy")).size(13))))
      .child(v_flex().flex_1().min_h(0).gap(M.fieldGap)
        .child(field("Agent", agentLine))
        .when(!!w.branch, (el) => el.child(field("Branch", mono(w.branch))))
        .child(field("Command", div().id("pc-cmd").whitespace_nowrap().overflow_hidden().text_ellipsis().font_family(MONO).text_size(12).text_color(t.foreground)
          .when(Boolean(this.args), (el) => el.tooltip(this.args)).child(noLigatures(shortArgs(this.args, s.command) || s.command))))
        .when(!!s.cwd && s.cwd !== w.folder, (el) => el.child(field("Folder", div().id("pc-folder").whitespace_nowrap().overflow_hidden().text_ellipsis_middle()
          .font_family(MONO).text_size(12).text_color(t.foreground).tooltip(s.cwd).child(tilde(s.cwd)))))
        .child(field("Running", div().id("pc-running").font_family(MONO).text_size(12)
          .text_color(this.state === "live" ? t.foreground : this.state === "still" ? t.working : t.muted)
          .tooltip(`pid ${s.pid}`).child(running)))
        .child(field("Reach", s.network
          ? h_flex().gap(6).items_center().text_color(t.foreground).child(svg(ICON("globe")).size(12).text_color(t.muted)).child("Your network")
          : div().text_color(t.foreground).child("This Mac only")))
        .when(others.length > 0, (el) => el.child(field("Also", mono(others.map((x) => `:${x}`).join("  "))))))
      // The Stop question shares the button row, so asking never changes the dialog's height.
      .child(h_flex().h(M.buttons).flex_none().gap(8).items_center().text_size(12.5)
        .child(div().flex_1().min_w(0).text_size(12).line_height("16px").text_color(t.muted)
          .when(this.asking, (el) => el.child(`Stop ${s.command} (pid ${s.pid})? Closes ${s.ports.map((x) => `:${x}`).join(", ")}.`)))
        .children(list.map(button)));
  }
}
