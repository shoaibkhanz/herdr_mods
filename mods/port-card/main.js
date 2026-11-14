// The port card: one listening server in detail, opened by Ports as a popup with props { server, who, ask }
// (mods/ports/main.js computes both; this mod decides nothing about ownership). Open, copy, Go to agent, Stop.
// Stop asks here, Cancel selected (Enter alone cancels, as confirm-safe), re-checks that the pid still holds the port
// (it may have exited, and its pid been reused), then sends SIGTERM. Live CPU / memory from `ps` every 5 s.
// Every close gives the keyboard back to where it was (shared emergence.over), unless Open or Go to took it elsewhere.

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, props, closeOverlay, theme, setShared, notify } from "herdr";
import { agePrecise, portList, formatMem, shortArgs, canStop, statOutcome, heldOutcome } from "./lib.js";

const REFRESH_MS = 5000;
const STOP_CHECK_MS = 1000, STOP_WAIT_MS = 10000; // after SIGTERM: check each second, give up after ten
const CLOSE_AFTER_STOP_MS = 1200;
const COPIED_MS = 1500;
// Emergence's dialog standard (RECIPE "Dialogs"): 24px padding, 16px gaps, a 22px title row with the Esc chip, 32px
// buttons of which only the one Enter presses is filled; widths 440 / 560 / 680. Type is Herdr's (no font set).
const LABEL_W = 72;
// The same measures as mods/ports/lib.js CARD, which sizes this dialog from them (keep the two in step).
const M = { pad: 24, gap: 16, header: 22, owner: 40, box: 52, line: 20, fieldGap: 10, buttons: 32 };
const EXEC = { timeout: 4000 };
const ICON = (name) => `mods/port-card/${name}.svg`;
const KIND = { web: "app-window", db: "database", debug: "bug", docker: "container", other: "plug" }; // as the Ports row
const STATUS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };
const STATE_INK = { working: "working", blocked: "blocked", done: "done", idle: "muted" }; // theme colour names
const FORGOTTEN_S = 3600; // an orphan's age turns amber past an hour, as its Ports row

const alpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");

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
    const s = props().server, w = props().who, live = this.state === "live";
    if (this.asking && canStop(w)) return [
      { id: "cancel", label: "Cancel", act: (cx) => { this.asking = false; this.sel = null; cx.notify(); } },
      { id: "stop", label: "Stop", danger: true, act: (cx) => this.stop(cx) },
    ];
    const go = w.kind === "sure" || w.kind === "probable"
      ? [{ id: "go", label: w.agent ? "Go to agent" : "Go to terminal", act: () => this.goTo() }] : [];
    const stop = canStop(w) && live ? [{ id: "ask", label: "Stop", danger: true, act: (cx) => { this.asking = true; this.sel = null; cx.notify(); } }] : [];
    const open = s.web && live ? [{ id: "open", label: "Open", act: (cx) => this.open(cx) }] : [];
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
    const s = p.server, w = p.who, owned = w.kind === "sure" || w.kind === "probable";
    const field = (label, value) => h_flex().h(M.line).gap(12).items_center()
      .child(div().w(LABEL_W).flex_none().text_size(11.5).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).child(value));
    const address = s.web ? s.url : s.url.replace(/^http:\/\//, "");
    const others = s.ports.filter((x) => x !== s.port);

    // Who: line 1 the program (500) and where it lives, its state on the right; line 2 what it's doing, or why it's
    // only probably this agent's, or where an orphan runs. Both decided by Ports (lib ownerLines), never cut to a
    // second line: "…" and a tooltip.
    const name = w.program?.name, rest = owned && name && w.line1.startsWith(name) ? w.line1.slice(name.length) : null;
    const owner = v_flex().h(M.owner).flex_none()
      .child(h_flex().id("pc-who").h(22).gap(8).items_center().tooltip(w.line1)
        .child(this.mark(t, w, 16))
        .child(h_flex().flex_1().min_w(0).text_color(t.foreground)
          .map((el) => rest === null ? el.child(div().truncate().child(w.line1))
            : el.child(div().flex_none().font_medium().child(name)).child(div().min_w(0).truncate().child(rest))))
        .when(owned && !!STATUS[w.status], (el) => el.child(div().flex_none().text_size(12).text_color(t[STATE_INK[w.status]]).child(STATUS[w.status]))))
      .child(div().id("pc-why").h(18).pl(24).flex().items_center().text_size(12).text_color(t.muted)
        .when(Boolean(w.line2), (el) => el.tooltip(w.line2)).child(div().min_w(0).truncate().child(w.line2 ?? "")));

    // What: the address you'd open or copy, who can reach it, and the command behind it.
    const box = v_flex().id("pc-box").h(M.box).flex_none().px(12).py(8).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().h(20).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(address))
        .child(s.network
          ? h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.working).child(svg(ICON("globe")).size(12)).child("Your network")
          : div().flex_none().text_size(11).text_color(t.dim).child("This Mac only"))
        .child(h_flex().id("pc-copy").flex_none().gap(4).items_center().cursor_pointer().text_size(11).text_color(t.muted)
          .hover((x) => x.text_color(t.foreground)).tooltip("Copy")
          .on_click((_e, cx) => this.copy(cx, address))
          .child(this.copied ? div().child("Copied") : svg(ICON("copy")).size(13))))
      .child(div().id("pc-cmd").h(16).flex().items_center().text_size(12).text_color(t.dim)
        .when(Boolean(this.args), (el) => el.tooltip(this.args))
        .child(div().min_w(0).truncate().child(shortArgs(this.args, s.command) || s.command)));

    const st = this.stat, live = this.state === "live";
    const forgotten = w.kind === "orphan" && (st?.age ?? s.age) > FORGOTTEN_S;
    const running = !live ? div().text_color(this.state === "still" ? t.working : t.muted)
        .child(this.state === "stopping" ? "Stopping…" : this.state === "stopped" ? "Stopped" : "Still running")
      : !st ? div().text_color(t.muted).child("…")
      : h_flex().gap(4).text_color(t.foreground)
        .child(div().when(forgotten, (el) => el.text_color(t.working)).child(agePrecise(st.age)))
        .child(`· ${st.cpu}% CPU · ${formatMem(st.rss)}`);

    // Buttons (RECIPE "Dialogs"): only the one Enter presses is filled (solid; a destructive one in blocked), with ↵.
    const list = this.buttons(), sel = this.selected(list);
    const button = (b) => {
      const on = sel === b.id;
      return h_flex().id(`pc-${b.id}`).h(M.buttons).px(14).gap(6).items_center().rounded(8).cursor_pointer().border_1().text_size(12).font_medium()
        .map((el) => on && b.danger ? el.bg(alpha(t.blocked, 0.18)).border_color(alpha(t.blocked, 0.5)).text_color(t.blocked)
          : on ? el.bg(t.solid).border_color(t.solid).text_color(t.solid_foreground)
          : el.bg(t.raised).border_color(t.input).text_color(b.danger ? t.blocked : t.foreground))
        .hover((x) => x.opacity(0.88)).on_click((_e, cx) => b.act(cx))
        .child(b.label).when(on, (el) => el.child(div().text_size(11).opacity(0.7).child("↵")));
    };

    return v_flex().id("port-card").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(M.pad).gap(M.gap).rounded(10).bg(t.popover).text_size(13)
      .child(h_flex().h(M.header).flex_none().items_center().gap(10)
        .child(svg(ICON(KIND[s.kind] ?? "plug")).size(16).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child(`:${s.port}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.command))
        .child(div().id("pc-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => this.dismiss()).child("Esc")))
      .child(owner)
      .child(box)
      .child(v_flex().flex_1().min_h(0).gap(M.fieldGap)
        .when(!!s.cwd && s.cwd !== w.folder, (el) => el.child(field("Folder", div().id("pc-folder").whitespace_nowrap().overflow_hidden()
          .text_ellipsis_start().text_color(t.foreground).tooltip(s.cwd).child(w.folderText || s.cwd))))
        .child(field("Running", div().id("pc-running").tooltip(`pid ${s.pid}`).child(running)))
        .when(others.length > 0, (el) => el.child(field("Also on", div().text_color(t.foreground).child(others.map((x) => `:${x}`).join("  "))))))
      // The Stop question states the deciding fact (Ports' stopFact, never a verdict) in the button row, so asking never
      // changes the dialog's height.
      .child(h_flex().h(M.buttons).flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).max_h(M.buttons).overflow_hidden().text_size(12).line_height("16px").text_color(t.muted)
          .when(this.asking, (el) => el.child(`Stop ${s.command} (pid ${s.pid})? ${w.fact ? `${w.fact} ` : ""}Closes ${portList(s.ports)}.`)))
        .children(list.map(button)));
  }
}
