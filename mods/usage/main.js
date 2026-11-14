// Usage: how you work across coding-agent harnesses (omp, Claude Code, Codex, OpenCode, pi), read from their
// own session logs on this machine. scan.py boils the logs down (cached); everything here is drawn natively.
// props().panel: the emergence layout's side panel (block "usage"); otherwise a popup (mod.open:usage).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, theme, settings, props, run, layout, shared, setShared, closeOverlay } from "herdr";
import { summarize, outputOf, heat, levels, startOfDay, addDays, DAY, KINDS, LENGTHS, span, keepOf, tabAfter } from "./lib.js";

const RANGES = [[7, "7d"], [30, "30d"], [90, "90d"], [365, "1y"], ["custom", "Custom"]];
// In the order worth looking at: the picture, which harness serves you best, what got delivered, then the detail.
const TABS = [["overview", "Overview"], ["compare", "Compare"], ["output", "Output"], ["harnesses", "Harnesses"], ["rhythm", "Rhythm"]];
// Herdr's program icons (omp's ships with the inbox) and one hue per harness from the Okabe–Ito palette:
// colour-blind safe, far apart, readable in light and dark themes. omp and Claude get the most distant pair.
const HARNESS = {
  omp: { name: "omp", icon: "mods/inbox/omp.svg", tint: false, color: "#56b4e9" }, // sky blue
  claude: { name: "Claude Code", icon: "icons/claude.svg", tint: false, color: "#e69f00" }, // orange
  codex: { name: "Codex", icon: "icons/codex.svg", tint: false, color: "#009e73" }, // bluish green
  opencode: { name: "OpenCode", icon: "icons/opencode.svg", tint: true, color: "#cc79a7" }, // reddish purple
  pi: { name: "pi", icon: "icons/pi.svg", tint: true, color: "#f0e442" }, // yellow
};
const ORDER = Object.keys(HARNESS);
const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
// Effort: one clearly different hue per level, still reading cool (less) to hot (more): blue, green, yellow,
// orange, red. Neighbours never share a hue, so every level is told apart at a glance.
const EFFORT_INK = { off: "#9ca3af", minimal: "#93c5fd", low: "#3b82f6", medium: "#10b981", high: "#eab308", xhigh: "#f97316", max: "#dc2626", default: "#4b5563" };
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const alpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
const short = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n ?? 0)));
const pct = (x) => (x == null ? "–" : x > 0.99 && x < 1 ? ">99%" : `${Math.round(x * 100)}%`);
const date = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTH[d.getMonth()]}`; };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const iso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// "2026-11-03" -> local midnight, or null while it isn't a real date yet.
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()); if (!m) return null; const d = new Date(+m[1], m[2] - 1, +m[3]); return d.getDate() === +m[3] ? d.getTime() : null; };
const LEVEL = [0, 0.3, 0.5, 0.75, 1];
// Token kinds (ColorBrewer Set2: apart from the harness hues): what an agent's spend is made of.
const MIX = [["tin", "Fresh input", "#8da0cb"], ["tcw", "Cache write", "#fc8d62"], ["tcr", "Cache read", "#66c2a5"], ["tout", "Output", "#e78ac3"]];
const mins = (m) => (m < 1 ? "<1m" : m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`);
const hh = (h) => `${String(h % 24).padStart(2, "0")}:00`;

let data = null; // shared by every copy, so reopening is instant (↻ rescans)
let output = null; // git and gh facts for the Output tab, read after the sessions (they name the repos)
let scanned = 0, outputAt = 0; // when the last scan (started or) finished, and the last Output read: copies share them
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean));

export default class Usage extends View {
  init(_props, cx) {
    this.panel = props()?.panel === true;
    this.backAt = shared("emergence.back");
    this.handle = cx.focus_handle(); // a press anywhere takes the keyboard: ← / → walk the view tabs, as every panel's arrows do
    if (this.panel) cx.timer.every(250, (cx) => { if (this.handle.is_focused() !== this.held) cx.notify(); }); // no blur event (comeBack)
    // Every minute while it shows: a rescan reads only the logs that changed (about 1.5 s); Output's git and gh every 15.
    cx.timer.every(60000, (cx) => { if (this.shown() && Date.now() - scanned > 50000) this.scan(cx, true); });
    const r = localStorage.getItem("range");
    this.range = r === "custom" ? "custom" : Number(r ?? 30);
    this.tab = localStorage.getItem("tab") ?? "overview";
    this.off = new Set(JSON.parse(localStorage.getItem("off") ?? "[]")); // harnesses switched off
    this.metric = "sessions";
    this.same = false;
    this.kind = null;
    this.sel = null; // { kind: "days" | "slots", keys, from }: the part of the period picked on a chart (see press)
    this.selV = 0;
    this.width = 760;
    // Custom period: two dates, both included (typed, or clicked on the calendar).
    const saved = JSON.parse(localStorage.getItem("custom") ?? "null");
    this.custom = saved ?? { from: addDays(Date.now(), -13), to: startOfDay(Date.now()) };
    this.fromInput = InputState.new({ value: iso(this.custom.from), placeholder: "YYYY-MM-DD" });
    this.toInput = InputState.new({ value: iso(this.custom.to), placeholder: "YYYY-MM-DD" });
    this.typing = 0; // date fields with the caret: ← / → are theirs then (lib tabAfter)
    for (const input of [this.fromInput, this.toInput]) { input.on("focus", () => this.typing++); input.on("blur", () => (this.typing = Math.max(0, this.typing - 1))); }
    for (const [input, end] of [[this.fromInput, "from"], [this.toInput, "to"]]) input.on("change", (_e, cx) => {
      const t = parse(input.value());
      // Kept as typed (ends put in order where they're read), so editing one box never moves the other end.
      if (t != null) { this.custom = { ...this.custom, [end]: t }; this.picking = false; this.setSel(null); localStorage.setItem("custom", JSON.stringify(this.custom)); cx.notify(); }
    });
    if (!data) this.scan(cx);
  }

  // A calendar click sets the ends too (see heatmap), in order.
  setCustom({ from, to }) {
    this.custom = from <= to ? { from, to } : { from: to, to: from };
    localStorage.setItem("custom", JSON.stringify(this.custom));
  }

  // Picking part of the period: every number outside the chart picked on follows it; that chart stays whole and
  // lights what's picked. A press picks (pressing exactly the selection again clears it), dragging or
  // shift-click spans from the last press, cmd-click adds (or takes away what's already in).
  setSel(sel) { this.sel = sel; this.selV++; this.drag = null; }
  press(kind, at, e, cx) {
    cx.stop_propagation(); // a popup window drags by any press nobody stops
    const s = this.sel?.kind === kind ? this.sel : null, keys = span(kind, at, at), all = s && keys.every((k) => s.keys.has(k));
    const { shift, platform } = e.modifiers;
    if (all && platform) { const k = new Set(s.keys); keys.forEach((x) => k.delete(x)); return this.setSel(k.size ? { ...s, keys: k } : null); }
    if (all && !shift && s.keys.size === keys.length) return this.setSel(null);
    this.drag = { kind, from: shift && s ? s.from : at, base: platform && s ? s.keys : new Set() };
    this.dragTo(kind, at);
  }
  dragTo(kind, at) {
    const d = this.drag;
    if (d?.kind !== kind) return;
    this.sel = { kind, from: d.from, keys: new Set([...d.base, ...span(kind, d.from, at)]) };
    this.selV++;
  }
  // Whether a bar covering the days `at` is lit: always, unless days are picked and none of its are.
  lit(at) {
    return this.sel?.kind !== "days" || span("days", at, at).some((k) => this.sel.keys.has(k));
  }
  // A pickable element: press picks `at`, hovering while held drags to it; onHover(on) keeps its readout.
  pick(el, kind, at, onHover = () => {}) {
    return el.cursor_pointer().on_hover((on, cx) => { onHover(on); if (on) this.dragTo(kind, at); cx.notify(); })
      .on_mouse_down("left", (e, cx) => { this.press(kind, at, e, cx); cx.notify(); });
  }
  selLabel() {
    const { kind, keys } = this.sel, k = [...keys].sort((a, b) => a - b), run = (xs) => xs.every((x, i) => !i || x === xs[i - 1] + 1);
    if (kind === "days") {
      if (k.length === 1) return `${WD[(new Date(k[0]).getDay() + 6) % 7]} ${date(k[0])}`;
      return Math.round((k.at(-1) - k[0]) / DAY) === k.length - 1 ? `${date(k[0])} – ${date(k.at(-1))}` : `${k.length} days`;
    }
    const ds = [...new Set(k.map((x) => Math.floor(x / 24)))], hs = [...new Set(k.map((x) => x % 24))].sort((a, b) => a - b);
    if (ds.length * hs.length !== k.length) return `${k.length} hours of the week`;
    const day = ds.length === 7 ? "Every day" : ds.length === 1 ? WD[ds[0]] : run(ds) ? `${WD[ds[0]]}–${WD[ds.at(-1)]}` : ds.map((d) => WD[d]).join(", ");
    return `${day} ${run(hs) ? `${hh(hs[0])}–${hh(hs.at(-1) + 1)}` : `${hs.length} hours`}`;
  }

  // [from, to) in ms, with a label: the last N days up to now, or the custom dates including both.
  period(now) {
    if (this.range === "custom") {
      const lo = Math.min(this.custom.from, this.custom.to), hi = Math.max(this.custom.from, this.custom.to);
      return { from: lo, to: addDays(hi, 1), label: `${date(lo)} – ${date(hi)}`, days: Math.round((hi - lo) / DAY) + 1 };
    }
    return { from: addDays(now, 1 - this.range), to: now, label: `the last ${RANGES.find(([d]) => d === this.range)[1]}`, days: this.range };
  }

  // ↻ reads everything; the minute timer (quick) reruns git and gh for Output only every 15 min, since gh's calls
  // share your GitHub budget with your agents'.
  scan(cx, quick) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    scanned = Date.now(); // a second copy's timer won't start another meanwhile
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/usage/scan.py`], { timeout: 600000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `scan.py exited ${r.code}`);
        data = JSON.parse(r.stdout);
        if (!quick || Date.now() - outputAt > 15 * 60000) {
          // Then your commits, PRs and worktrees in the repos the sessions name, for the last year.
          const repos = [...new Set(data.sessions.map((s) => s.repo).filter(Boolean))];
          const o = await exec("python3", [`${appHome()}/mods/usage/output.py`, String(addDays(Date.now(), -365)), ...repos], { timeout: 180000 });
          if (o.code === 0) { output = JSON.parse(o.stdout); outputAt = Date.now(); }
        }
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      scanned = Date.now();
      cx.notify();
    });
  }

  // The panel copy shows when the side panel is open on Usage; the popup copy whenever it exists.
  shown() {
    if (!this.panel) return true;
    const root = layout(), p = find(root, "panel");
    return Boolean(p) && !p.hidden && find(root, "panel-body")?.active === "usage";
  }

  // What the work delivered: commits, lines, PRs, worktrees, and what agent spend each of them cost.
  outputView(t, r0, r, p, o0, o) {
    if (!o) return [div().p(12).text_center().text_size(13).text_color(t.muted).child(this.busy ? "Reading git and gh in your repos…" : "No git or gh data yet: rescan (↻).")];
    const base = (path) => path.split("/").filter(Boolean).pop();
    const tiles = this.tileRow(t, [
      ["Commits", String(o.commits), o.activeDays ? `${(o.commits / o.activeDays).toFixed(1)} per day you committed` : "none"],
      ["Lines changed", `+${short(o.add)} −${short(o.del)}`, `net ${o.add - o.del >= 0 ? "+" : "−"}${short(Math.abs(o.add - o.del))} · lockfiles left out`],
      ["Pull requests", `${o.opened} opened`, o.merged ? `${o.merged} merged · median ${mins(o.mergeHours * 60)} to merge` : "none merged"],
      ["Worktrees", String(o.worktrees), `across ${o.treeRepos} repos, now`],
    ]);
    // Lines added above the axis, removed below, one bar per day (week, past a month); hover for the day's numbers,
    // press or drag to pick days. With days picked the bars stay whole (the picked ones lit).
    const days = this.sel?.kind === "days", ob = days ? o0 : o, step = (days ? r0 : r).step;
    const max = Math.max(1, ...ob.buckets.map((b) => Math.max(b.add, b.del))), UP = 64, DOWN = 36, x = ob.buckets.find((b) => b.t === this.hoverOut);
    const chart = h_flex().h(UP + DOWN + 1).gap(2).items_center().overflow_hidden().children(ob.buckets.map((b) => {
      const at = [b.t, step === DAY ? b.t : Math.min(addDays(b.t, 6), this.last)];
      return this.pick(v_flex().id(`out-${b.t}`).flex_1().min_w(0).h(UP + DOWN + 1).when(!this.lit(at), (el) => el.opacity(0.3))
        .when(this.hoverOut === b.t, (el) => el.bg(t.hover)).rounded(2), "days", at, (on) => { if (on) this.hoverOut = b.t; else if (this.hoverOut === b.t) this.hoverOut = null; })
        .child(v_flex().h(UP).justify_end().child(div().w_full().h(b.add ? Math.max(2, (b.add / max) * UP) : 0).rounded_t(2).bg(alpha(t.done, 0.85))))
        .child(div().h(1).w_full().bg(t.border))
        .child(v_flex().h(DOWN).child(div().w_full().h(b.del ? Math.max(2, (b.del / max) * DOWN) : 0).rounded_b(2).bg(alpha(t.blocked, 0.75))));
    }));
    const lines = this.card(t, "Commits and lines", div().text_size(11).text_color(t.dim).child("added above the line, removed below"), v_flex().gap(8).child(chart)
      .child(h_flex().h(18).gap(10).items_center().text_size(12)
        .child(div().font_semibold().child(x ? `${step === DAY ? WD[(new Date(x.t).getDay() + 6) % 7] : "Week of"} ${date(x.t)}` : this.sel ? this.selLabel() : p.label))
        .child(div().text_color(t.muted).child(x ? `${x.commits} commits · +${short(x.add)} −${short(x.del)}${x.merged ? ` · ${x.merged} PR${x.merged === 1 ? "" : "s"} merged` : ""}`
          : this.sel ? `${o.commits} commits · +${short(o.add)} −${short(o.del)}` : "hover a bar for its day · press or drag to pick days"))));
    const w = this.innerW(), top = Math.max(1, ...o.repos.map((x) => x.commits));
    const where = this.card(t, "Where you committed", null, v_flex().gap(4).children(o.repos.map((x) => h_flex().h(20).gap(8).items_center().text_size(12)
      .child(div().w(110).flex_none().truncate().child(base(x.repo)))
      .child(div().w(Math.max(40, w - 110 - 90 - 16)).h(8).rounded(3).bg(t.raised).child(div().h(8).rounded(3).w(Math.max(2, (x.commits / top) * Math.max(40, w - 216))).bg(t.accent)))
      .child(div().w(90).text_size(11).text_color(t.dim).child(`${x.commits} · +${short(x.add)}`)))));
    // Agent spend against what it delivered (recorded cost only; Codex records none).
    const spend = r.tiles.cost, per = (n, d = 2) => (r.tiles.costKnown && n ? `$${(spend / n).toFixed(d)}` : "–");
    const cost = this.card(t, "What delivery cost", div().text_size(11).text_color(t.dim).child("agent spend over output"), v_flex().gap(4).children([
      ["Per commit", per(o.commits)], ["Per merged PR", per(o.merged, 0)], ["Per 1K lines changed", per((o.add + o.del) / 1000)],
      ["Tokens per commit", o.commits ? short(r.tiles.tokens / o.commits) : "–"], ["Commits per agent run", r.tiles.sessions ? (o.commits / r.tiles.sessions).toFixed(1) : "–"],
    ].map(([label, value]) => h_flex().h(22).items_center().justify_between().text_size(12).child(div().text_color(t.muted).child(label)).child(div().font_semibold().child(value)))));
    const prs = o.recent.length ? this.card(t, "Recent pull requests", null, v_flex().gap(2).children(o.recent.map((x) => h_flex().h(24).gap(8).items_center().text_size(12)
      .child(div().w(44).flex_none().text_color(t.muted).child(`#${x.n}`)).child(div().flex_1().min_w(0).truncate().child(base(x.repo)))
      .child(h_flex().h(18).px(6).flex_none().items_center().rounded(5).text_size(11)
        .bg(alpha(x.state === "merged" ? t.done : x.state === "open" ? t.accent : t.dim, 0.16)).text_color(x.state === "merged" ? t.done : x.state === "open" ? t.accent : t.dim).child(x.state))
      .child(div().w(130).flex_none().whitespace_nowrap().text_size(11).text_color(t.dim).child(x.merged ? `merged in ${mins((x.merged - x.created) / 60000)}` : date(x.created)))))) : null;
    return [tiles, lines, this.pair(where, cost), ...(prs ? [prs] : [])];
  }

  icon(t, h, size) {
    const x = HARNESS[h];
    return x.tint ? svg(x.icon).size(size).flex_none().text_color(t.foreground) : image(x.icon).w(size).h(size).flex_none().rounded(4);
  }

  segmented(t, id, options, on, pick) {
    return h_flex().h(24).p(2).gap(2).flex_none().items_center().rounded(7).bg(t.raised).children(options.map(([v, label]) =>
      div().id(`${id}-${v}`).h(20).px(8).flex().items_center().rounded(5).text_size(12).cursor_pointer()
        .text_color(v === on ? t.foreground : t.muted).when(v === on, (el) => el.bg(t.background))
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { pick(v); cx.notify(); }).child(label)));
  }

  card(t, title, right, body) {
    return v_flex().flex_none().p(14).gap(12).rounded(10).border(1).border_color(t.border).bg(t.surface)
      .child(h_flex().h(24).gap(8).items_center().child(div().flex_1().text_size(13).font_semibold().child(title)).when(Boolean(right), (el) => el.child(right)))
      .child(body);
  }

  header(t, present, counts, p) {
    const button = (id, tip, glyph, onClick) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6)
      .text_color(t.muted).tooltip(tip).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(glyph);
    // Pointer handlers on Input are dropped (gpui-kit: only div/h_flex/...): the wrapper stops the press, so the
    // panel's own press-to-focus doesn't take the box's focus.
    const field = (state) => h_flex().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w(104).h(24).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background)
        .text_size(12).text_color(t.foreground));
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(42).px(14).gap(8).items_center()
        .child(div().flex_none().text_size(13).font_semibold().child("Usage"))
        .child(this.segmented(t, "range", RANGES, this.range, (v) => { this.range = v; this.picking = false; this.setSel(null); localStorage.setItem("range", String(v)); }))
        .child(div().flex_1())
        .when(Boolean(data), (el) => el.child(div().flex_none().max_w(260).truncate().text_size(11).text_color(this.error ? t.blocked : t.dim)
          .child(this.busy ? "scanning…" : this.error ? `rescan failed: ${this.error}` : `scanned ${ago(data.scanned_at)}`)))
        .child(button("usage-refresh", "Rescan the session logs", svg("mods/agent-graph/refresh.svg").size(13), (_e, cx) => { this.scan(cx); cx.notify(); }))
        .when(this.panel, (el) => el.child(button("usage-expand", "Open large", svg("mods/agent-graph/expand.svg").size(13), () => run("mod.open", { name: "usage" }))))
        .when(!this.panel && Boolean(props()?.overlay), (el) => el.child(div().id("usage-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim)
          .cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props().overlay)).child("Esc"))))
      .when(this.range === "custom", (el) => el.child(h_flex().px(14).pb(10).gap(8).items_center().text_size(12).text_color(t.muted)
        .child("From").child(field(this.fromInput)).child("to").child(field(this.toInput))
        .child(div().text_size(11).text_color(t.dim).child(`${p.days} day${p.days === 1 ? "" : "s"}, both dates included · or click two days on the calendar`))))
      .when(present.length > 0, (el) => el.child(h_flex().px(14).pb(10).gap(6).items_center().children(present.map((h) => {
        const on = !this.off.has(h);
        return h_flex().id(`harness-${h}`).h(24).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
          .border(1).border_color(on ? alpha(HARNESS[h].color, 0.5) : t.border).when(on, (el) => el.bg(alpha(HARNESS[h].color, 0.1)))
          .text_size(12).text_color(on ? t.foreground : t.dim).tooltip(on ? `Hide ${HARNESS[h].name}` : `Show ${HARNESS[h].name}`)
          .on_click((_e, cx) => { on ? this.off.add(h) : this.off.delete(h); localStorage.setItem("off", JSON.stringify([...this.off])); cx.notify(); })
          .child(div().when(!on, (el) => el.opacity(0.4)).child(this.icon(t, h, 14))).child(HARNESS[h].name)
          .child(div().text_size(11).text_color(t.dim).child(String(counts[h] ?? 0)));
      }))))
      // The views, one at a time, so none needs scrolling; then what's picked, if anything (click to clear).
      .child(h_flex().h(36).px(14).gap(18).items_end().children(TABS.map(([id, label]) => {
        const on = this.tab === id;
        return div().id(`tab-${id}`).h(36).flex().flex_none().items_center().text_size(13).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium().border_b(2).border_color(t.accent))
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; localStorage.setItem("tab", id); cx.notify(); }).child(label);
      })).when(Boolean(this.sel), (el) => el.child(div().flex_1()).child(h_flex().id("usage-sel").h(24).mb(6).px(8).gap(6).min_w(0).items_center().rounded(6)
        .border(1).border_color(alpha(t.accent, 0.5)).bg(alpha(t.accent, 0.1)).text_size(12).cursor_pointer().tooltip("Show the whole period")
        .hover((s) => s.bg(alpha(t.accent, 0.18))).on_click((_e, cx) => { this.setSel(null); cx.notify(); })
        .child(div().min_w(0).truncate().child(this.selLabel())).child(div().flex_none().text_color(t.muted).child("✕")))));
  }

  // Four headline tiles: [label, value, sub] each; one row where there's room, two otherwise.
  tileRow(t, specs) {
    const tile = ([label, value, sub]) => v_flex().flex_1().min_w(0).p(12).gap(4).rounded(10).border(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(11).text_color(t.dim).child(label)).child(div().text_size(15).font_semibold().child(value)).child(div().truncate().text_size(11).text_color(t.dim).child(sub));
    const cols = this.width >= 640 ? 4 : 2;
    return v_flex().flex_none().gap(8).children(Array.from({ length: specs.length / cols }, (_, i) => h_flex().gap(8).children(specs.slice(i * cols, i * cols + cols).map(tile))));
  }

  tiles(t, r) {
    const x = r.tiles, change = x.prev ? Math.round(((x.sessions - x.prev) / x.prev) * 100) : null, n = this.sel?.kind === "days" ? this.sel.keys.size : 0;
    return this.tileRow(t, [
      ["Sessions", String(x.sessions), n ? `on ${n} picked day${n === 1 ? "" : "s"}` : change == null ? "none in the period before" : `${change >= 0 ? "+" : ""}${change}% on the period before`],
      ["Active days", `${x.activeDays} of ${x.days}`, x.streak ? `${x.streak}-day streak` : "no streak"],
      ["Tokens", short(x.tokens), x.cacheHit == null ? "incl. sub-agents" : `${pct(x.cacheHit)} from cache`],
      ["Cost", x.costKnown ? `$${x.cost.toFixed(2)}` : "–", "at API prices, as recorded"],
    ]);
  }

  heatmap(t, cells, weeks) {
    const cols = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));
    const ink = t.done;
    const grid = h_flex().gap(3).items_start().overflow_hidden()
      .child(v_flex().w(28).flex_none().gap(3).pt(17).children(WD.map((w, i) => div().h(11).text_size(9).text_color(t.dim).child(i % 2 ? "" : w))))
      .children(cols.map((col, ci) => {
        const first = new Date(col[0].t), prev = ci ? new Date(cols[ci - 1][0].t) : null;
        return v_flex().w(11).flex_none().gap(3)
          .child(div().w(11).h(14).text_size(9).text_color(t.dim).whitespace_nowrap().child(prev && prev.getMonth() !== first.getMonth() ? MONTH[first.getMonth()] : ""))
          .children(col.map((d) => {
            const inside = this.range === "custom" && d.t >= Math.min(this.custom.from, this.custom.to) && d.t <= Math.max(this.custom.from, this.custom.to);
            const cell = div().id(`heat-${d.t}`).size(11).rounded(3).cursor_pointer().bg(d.level ? alpha(ink, LEVEL[d.level]) : t.raised)
              .when(inside, (el) => el.border(1).border_color(alpha(t.accent, 0.8)))
              .when(!this.lit([d.t, d.t]), (el) => el.opacity(0.3))
              .on_hover((on, cx) => { if (on) { this.hoverDay = d.t; this.dragTo("days", [d.t, d.t]); } else if (this.hoverDay === d.t) this.hoverDay = null; cx.notify(); });
            // Custom period: the first click starts it, the second ends it (either order). Otherwise days are picked.
            return this.range !== "custom" ? cell.on_mouse_down("left", (e, cx) => { this.press("days", [d.t, d.t], e, cx); cx.notify(); })
              : cell.on_click((_e, cx) => {
                this.setCustom(this.picking ? { from: this.custom.from, to: d.t } : { from: d.t, to: d.t });
                this.picking = !this.picking;
                this.setSel(null);
                this.fromInput.set_value(iso(this.custom.from));
                this.toInput.set_value(iso(this.custom.to));
                cx.notify();
              });
          }));
      }));
    // The day under the pointer, else the picked days added up, else today: the numbers, by harness.
    const picked = this.sel?.kind === "days" ? cells.filter((c) => this.sel.keys.has(c.t)) : [];
    const d = cells.find((c) => c.t === this.hoverDay) ?? (picked.length ? picked.reduce((a, c) => ({ sessions: a.sessions + c.sessions, tokens: a.tokens + c.tokens, cost: a.cost + c.cost,
      by: Object.fromEntries(ORDER.map((h) => [h, (a.by[h] ?? 0) + (c.by[h] ?? 0)])) }), { sessions: 0, tokens: 0, cost: 0, by: {} }) : cells.at(-1));
    const readout = h_flex().h(20).gap(10).items_center().text_size(12)
      .child(div().font_semibold().child(d.t == null ? this.selLabel() : `${WD[d.wd]} ${date(d.t)}`))
      .child(div().text_color(t.muted).child(`${d.sessions} session${d.sessions === 1 ? "" : "s"} · ${short(d.tokens)} tokens${d.cost ? ` · $${d.cost.toFixed(2)}` : ""}`))
      .children(ORDER.filter((h) => d.by[h]).map((h) => h_flex().gap(4).items_center().text_size(11).text_color(t.dim)
        .child(div().size(8).rounded(2).bg(HARNESS[h].color)).child(`${HARNESS[h].name} ${d.by[h]}`)))
      .child(div().flex_1())
      .child(h_flex().gap(3).items_center().text_size(11).text_color(t.dim).child(div().mr(4).child("Less"))
        .children(LEVEL.map((a, i) => div().size(11).rounded(3).bg(i ? alpha(ink, a) : t.raised))).child(div().ml(4).child("More")));
    const metrics = [["sessions", "Sessions"], ["tokens", "Tokens"], ...(cells.some((d) => d.cost) ? [["cost", "Cost"]] : [])];
    return this.card(t, `Activity, last ${weeks} weeks`, this.segmented(t, "metric", metrics, this.metric, (v) => { this.metric = v; }),
      v_flex().gap(10).child(grid).child(readout));
  }

  over(t, r0, r, present) {
    const days = this.sel?.kind === "days", src = days ? r0 : r;
    const max = Math.max(1, ...src.buckets.map((b) => Object.values(b.by).reduce((a, n) => a + n, 0)));
    const H = 120, unit = src.step === DAY ? "Day" : "Week of";
    const bars = h_flex().h(H).gap(2).items_end().children(src.buckets.map((b) => {
      const at = [b.t, src.step === DAY ? b.t : Math.min(addDays(b.t, 6), this.last)];
      return this.pick(v_flex().id(`bar-${b.t}`).flex_1().min_w(2).h(H).justify_end().rounded(3).overflow_hidden()
        .when(this.hoverBar === b.t, (el) => el.bg(t.hover)).when(!this.lit(at), (el) => el.opacity(0.3)), "days", at,
        (on) => { if (on) this.hoverBar = b.t; else if (this.hoverBar === b.t) this.hoverBar = null; })
        .children([...present].reverse().filter((h) => b.by[h]).map((h) => div().w_full().h(Math.max(1, (b.by[h] / max) * H)).bg(HARNESS[h].color)));
    }));
    const axis = h_flex().justify_between().text_size(11).text_color(t.dim)
      .child(date(src.buckets[0]?.t ?? Date.now())).child(`max ${short(max)}`).child(date(src.buckets.at(-1)?.t ?? Date.now()));
    // The legend shows the hovered bar's split, else what's picked, else the period's.
    const hb = src.buckets.find((b) => b.t === this.hoverBar);
    const totals = hb ? hb.by : Object.fromEntries(present.map((h) => [h, r.buckets.reduce((a, b) => a + (b.by[h] ?? 0), 0)]));
    const legend = h_flex().h(20).gap(12).items_center().child(div().text_size(12).font_semibold().child(hb ? `${unit} ${date(hb.t)}` : this.sel ? this.selLabel() : "All"))
      .children(present.filter((h) => totals[h]).map((h) => h_flex().gap(6).items_center().text_size(12)
        .child(div().size(8).rounded(2).bg(HARNESS[h].color)).child(HARNESS[h].name).child(div().text_size(11).text_color(t.dim).child(short(totals[h])))));
    return this.card(t, "Tokens by harness", div().text_size(11).text_color(t.dim).child("hover a bar for its split · press or drag to pick"), v_flex().gap(8).child(bars).child(axis).child(legend));
  }

  models(t, r) {
    const track = Math.max(60, this.width - 32 - 28 - 190 - 96 - 16), top = r.models[0]?.share || 1;
    return this.card(t, "Models", div().text_size(11).text_color(t.dim).child("by tokens"), v_flex().gap(6).children(r.models.map((m) => h_flex().id(`model-${m.model}`).h(22).gap(8).items_center()
      .tooltip(Object.entries(m.by).map(([h, n]) => `${HARNESS[h]?.name ?? h} ${short(n)}`).join(" · "))
      .child(h_flex().w(190).gap(6).items_center().child(this.icon(t, m.h, 14)).child(div().min_w(0).truncate().text_size(12).child(m.model)))
      .child(div().w(track).h(6).rounded(3).bg(t.raised).child(div().h(6).rounded(3).w(Math.max(2, (m.share / top) * track)).bg(HARNESS[m.h].color)))
      .child(div().w(96).text_size(11).text_color(t.dim).child(`${short(m.tokens)} · ${pct(m.share)}`)))));
  }

  effort(t, r, present) {
    const track = Math.max(60, this.width - 32 - 28 - 140 - 56 - 16);
    const used = EFFORT.filter((l) => present.some((h) => r.effort[h]?.[l]));
    const rows = present.filter((h) => r.effort[h]).map((h) => {
      const e = r.effort[h], n = Object.values(e).reduce((a, x) => a + x, 0);
      return h_flex().h(24).gap(8).items_center()
        .child(h_flex().w(140).gap(6).items_center().child(this.icon(t, h, 14)).child(div().truncate().text_size(12).child(HARNESS[h].name)))
        .child(h_flex().w(track).h(14).gap(1).rounded(4).overflow_hidden().bg(t.raised).children(EFFORT.filter((l) => e[l]).map((l) =>
          div().id(`effort-${h}-${l}`).h(14).w(Math.max(2, (e[l] / n) * track - 1)).bg(EFFORT_INK[l])
            .on_hover((on, cx) => { if (on) this.hoverEffort = { h, l }; else if (this.hoverEffort?.h === h && this.hoverEffort?.l === l) this.hoverEffort = null; cx.notify(); }))))
        .child(div().w(56).text_size(11).text_color(t.dim).child(`${n} runs`));
    });
    const x = this.hoverEffort;
    const legend = h_flex().gap(12).items_center().children(used.map((l) => h_flex().gap(5).items_center().text_size(11).text_color(t.muted)
      .child(div().size(10).rounded(2).bg(EFFORT_INK[l])).child(l === "default" ? "not recorded" : l)));
    return this.card(t, "Effort", div().text_size(11).text_color(t.dim).child("share of runs per effort level"), v_flex().gap(8)
      .children(rows).child(legend)
      .child(div().h(16).text_size(12).text_color(t.muted).child((() => {
        const e = x && r.effort[x.h], k = e?.[x.l], n = e ? Object.values(e).reduce((a, v) => a + v, 0) : 0;
        return k ? `${HARNESS[x.h].name} · ${x.l === "default" ? "effort not recorded" : x.l}: ${k} of ${n} runs (${pct(k / n)})` : "";
      })())));
  }

  // Hours stacked down, weekdays across, in the calendar's own 11 px squares; under it, the day split in four.
  // Press or drag cells, an hour (its label: every day) or a weekday (its letter: every hour) to pick them.
  punch(t, r0, r) {
    const slots = this.sel?.kind === "slots", grid = (slots ? r0 : r).punch, lvl = levels(grid.flat()), x = this.hoverPunch;
    const hrs = r.punch.reduce((a, row) => a.map((n, i) => n + row[i]), Array(24).fill(0)), all = hrs.reduce((a, n) => a + n, 0) || 1;
    const parts = [["Night", 0], ["Morning", 6], ["Afternoon", 12], ["Evening", 18]].map(([label, h0]) => [label, hrs.slice(h0, h0 + 6).reduce((a, n) => a + n, 0) / all]);
    const pick = (el, at, onHover) => this.pick(el, "slots", at, onHover);
    return this.card(t, "When you start work", null, v_flex().flex_1().gap(3)
      .child(h_flex().gap(3).pl(37).children(WD.map((w, d) => pick(div().id(`punch-d-${d}`).w(11).flex_none().text_size(9).text_color(t.dim).hover((s) => s.text_color(t.foreground)).child(w[0]), [[d, d], [0, 23]]))))
      .children(Array.from({ length: 24 }, (_, h) => h_flex().gap(3).items_center()
        .child(pick(div().id(`punch-h-${h}`).w(34).flex_none().text_size(9).text_color(t.dim).hover((s) => s.text_color(t.foreground)).child(h % 3 ? "" : hh(h)), [[0, 6], [h, h]]))
        .children(grid.map((row, d) => pick(div().id(`punch-${d}-${h}`).size(11).flex_none().rounded(3).bg(row[h] ? alpha(t.done, LEVEL[lvl(row[h])]) : t.raised)
          .when(slots && !this.sel.keys.has(d * 24 + h), (el) => el.opacity(0.3))
          .when(x?.d === d && x?.h === h, (el) => el.border(1).border_color(t.foreground)), [[d, d], [h, h]],
          (on) => { if (on) this.hoverPunch = { d, h, n: row[h] }; else if (this.hoverPunch?.d === d && this.hoverPunch?.h === h) this.hoverPunch = null; })))))
      .child(div().h(20).pt(4).truncate().text_size(11).text_color(t.muted)
        .child(x ? `${WD[x.d]} ${hh(x.h)}: ${x.n} session${x.n === 1 ? "" : "s"}` : slots ? `${r.tiles.sessions} session${r.tiles.sessions === 1 ? "" : "s"} picked` : "drag to pick hours"))
      .child(div().flex_1())
      .child(div().h(1).my(6).bg(t.border))
      .children(parts.map(([label, share]) => h_flex().h(18).gap(6).items_center().text_size(11)
        .child(div().w(62).flex_none().text_color(t.muted).child(label))
        .child(div().w(52).h(6).rounded(3).bg(t.raised).child(div().h(6).rounded(3).w(Math.max(2, share * 52)).bg(alpha(t.done, 0.85))))
        .child(div().text_color(t.dim).child(pct(share))))));
  }

  // The busiest moment of each day (each week, past 120 days, so bars never overflow): how many agents ran at once.
  parallel(t, r0, r) {
    const daily = (this.sel?.kind === "days" ? r0 : r).rhythm.daily, step = daily.length > 120 ? 7 : 1;
    const bins = [];
    for (let i = 0; i < daily.length; i += step) bins.push({ t: daily[i].t, n: Math.max(...daily.slice(i, i + step).map((d) => d.n)) });
    const max = Math.max(1, ...bins.map((d) => d.n)), x = bins.find((d) => d.t === this.hoverPeak);
    return this.card(t, "Agents at once", div().text_size(11).text_color(t.dim).child(`peak ${r.rhythm.peakParallel} · typical ${r.rhythm.typicalParallel} on active days`), v_flex().gap(6)
      .child(h_flex().h(56).gap(1).items_end().overflow_hidden().children(bins.map((d) => {
        const at = [d.t, step === 7 ? Math.min(addDays(d.t, 6), this.last) : d.t];
        return this.pick(div().id(`peak-${d.t}`).flex_1().min_w(0).h(56).flex().items_end().when(!this.lit(at), (el) => el.opacity(0.3)), "days", at,
          (on) => { if (on) this.hoverPeak = d.t; else if (this.hoverPeak === d.t) this.hoverPeak = null; })
          .child(div().w_full().rounded(2).h(d.n ? Math.max(3, (d.n / max) * 56) : 2).bg(d.n ? alpha(t.accent, this.hoverPeak === d.t ? 1 : 0.75) : t.raised));
      })))
      .child(h_flex().justify_between().text_size(11).text_color(t.dim)
        .child(date(bins[0]?.t ?? Date.now()))
        .child(div().text_color(t.muted).child(x ? `${step === 7 ? "Week of" : WD[(new Date(x.t).getDay() + 6) % 7]} ${date(x.t)}: ${x.n} at once` : "press or drag to pick days"))
        .child(date(bins.at(-1)?.t ?? Date.now()))));
  }

  // Two cards side by side where there's room, stacked where there isn't; `w` is one card's inner width.
  pair(a, b) {
    return this.width >= 700 ? h_flex().gap(12).items_start().child(div().flex_1().min_w(0).child(a)).child(div().flex_1().min_w(0).child(b)) : v_flex().gap(12).child(a).child(b);
  }
  innerW() {
    return (this.width >= 700 ? (this.width - 32 - 12) / 2 : this.width - 32) - 30;
  }

  // A 100% bar of the token kinds, with a gap between parts.
  stack(t, m, w, h = 14) {
    const tot = MIX.reduce((a, [k]) => a + (m[k] ?? 0), 0) || 1;
    return h_flex().w(w).h(h).gap(1).rounded(4).overflow_hidden().bg(t.raised)
      .children(MIX.filter(([k]) => m[k]).map(([k, , ink]) => div().h(h).w(Math.max(2, (m[k] / tot) * w - 1)).bg(ink)));
  }

  tokensCard(t, r) {
    const m = r.mix, tot = MIX.reduce((a, [k]) => a + m[k], 0), read = m.tin + m.tcw + m.tcr;
    return this.card(t, "Where the tokens go", null, v_flex().gap(10)
      .child(this.stack(t, m, this.innerW(), 16))
      .children(MIX.map(([k, label, ink]) => h_flex().h(20).gap(8).items_center().text_size(12)
        .child(div().size(10).rounded(2).bg(ink)).child(div().flex_1().child(label))
        .child(div().w(56).flex_none().text_right().text_color(t.muted).child(short(m[k])))
        .child(div().w(40).flex_none().text_right().text_size(11).text_color(t.dim).child(tot ? pct(m[k] / tot) : "–"))))
      .child(div().text_size(12).text_color(t.muted).child(m.tout ? `For every token written, agents read ${Math.round(read / m.tout)} of context; ${pct(r.tiles.cacheHit)} of it came from cache.` : "No token split recorded.")));
  }

  workCard(t, r) {
    const w = this.innerW(), maxK = Math.max(1, ...Object.values(r.kinds)), hs = ORDER.filter((h) => r.split[h]?.runs || r.split[h]?.tok);
    const totTok = hs.reduce((a, h) => a + r.split[h].tok, 0) || 1;
    return this.card(t, "What the work was", div().text_size(11).text_color(t.dim).child("from each run's mix of tools"), v_flex().gap(6)
      .children(KINDS.filter(([k]) => r.kinds[k]).map(([k, label]) => h_flex().h(20).gap(8).items_center().text_size(12)
        .child(div().w(84).flex_none().child(label))
        .child(div().w(Math.max(40, w - 84 - 40 - 16)).h(8).rounded(3).bg(t.raised).child(div().h(8).rounded(3).w(Math.max(2, (r.kinds[k] / maxK) * Math.max(40, w - 140))).bg(t.accent)))
        .child(div().w(40).flex_none().text_right().text_size(11).text_color(t.dim).child(String(r.kinds[k])))))
      .child(div().h(1).my(4).bg(t.border))
      .children(hs.map((h) => h_flex().h(22).gap(8).items_center().text_size(12)
        .child(div().size(8).rounded(4).bg(HARNESS[h].color)).child(this.icon(t, h, 14)).child(div().flex_1().truncate().child(HARNESS[h].name))
        .child(div().w(72).flex_none().text_right().text_color(t.muted).child(`${r.split[h].runs} runs`))
        .child(div().w(44).flex_none().text_right().text_size(11).text_color(t.dim).child(pct(r.split[h].tok / totTok)))
        .child(div().w(64).flex_none().text_right().text_size(11).text_color(t.dim).child(r.split[h].cost ? `$${Math.round(r.split[h].cost)}` : "no cost")))));
  }

  rhythmTiles(t, r) {
    const x = r.rhythm, hrs = r.punch.reduce((a, row) => a.map((n, i) => n + row[i]), Array(24).fill(0)), busy = Math.max(...hrs) ? hrs.indexOf(Math.max(...hrs)) : null;
    return this.tileRow(t, [
      ["Typical run", x.medianMin == null ? "–" : mins(x.medianMin), `longest ${mins(x.longestMin)}`],
      ["Runs per active day", x.perDay.toFixed(1), `${pct(x.weekend)} on weekends`],
      ["Agents at once", `${x.typicalParallel} typical`, `peak ${x.peakParallel} on one day`],
      ["Busiest hour", busy == null ? "–" : `${String(busy).padStart(2, "0")}:00`, "most runs start then"],
    ]);
  }

  // Horizontal bars stacked down the card: a label, the bar, the count.
  bars(t, title, sub, items, w) {
    const max = Math.max(1, ...items.map(([, n]) => n)), track = Math.max(40, w - 56 - 32 - 16);
    return this.card(t, title, div().text_size(11).text_color(t.dim).child(sub), v_flex().gap(4).children(items.map(([label, n]) => h_flex().h(20).gap(8).items_center()
      .child(div().w(56).flex_none().text_size(11).text_color(t.muted).child(label))
      .child(div().w(track).h(10).rounded(3).bg(t.raised).child(div().h(10).rounded(3).w(Math.max(2, (n / max) * track)).bg(alpha(t.done, 0.85))))
      .child(div().w(32).flex_none().text_right().text_size(11).text_color(t.dim).child(String(n))))));
  }

  // What the spend is made of, per harness x main model: the token mix and what a token, an output token and a
  // run that led to a commit cost. Agent loops re-read their context every step, so read per written dominates.
  anatomy(t, r) {
    const rows = r.score, wide = this.width >= 640, bar = Math.max(80, this.width - 32 - 28 - 210 - (wide ? 4 * 72 : 2 * 72) - 40);
    const head = (label, w) => div().w(w).flex_none().text_size(11).text_color(t.dim).child(label);
    const usd = (v, d = 2) => (v == null ? "–" : `$${v < 10 ? v.toFixed(d) : Math.round(v)}`);
    return this.card(t, "Cost anatomy", null, v_flex().gap(4)
      .child(h_flex().h(20).gap(8).items_center().child(div().w(210).flex_none().text_size(11).text_color(t.dim).child("Harness · main model"))
        .child(head("Token mix", bar)).child(head("$ / 1M tok", 72)).child(head("$ / 1K out", 72)).when(wide, (el) => el.child(head("Read : write", 72)).child(head("$ / commit", 72))))
      .children(rows.map((x) => h_flex().id(`anat-${x.h}-${x.model}`).h(28).gap(8).items_center()
        .child(h_flex().w(210).flex_none().min_w(0).gap(6).items_center().child(div().size(8).rounded(4).flex_none().bg(HARNESS[x.h].color)).child(this.icon(t, x.h, 14))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(x.model)))
        .child(this.stack(t, x.mix, bar, 12))
        .child(div().w(72).flex_none().text_size(12).child(usd(x.per1M)))
        .child(div().w(72).flex_none().text_size(12).child(usd(x.per1kOut, 3)))
        .when(wide, (el) => el.child(div().w(72).flex_none().text_size(12).child(x.readPerOut == null ? "–" : `${Math.round(x.readPerOut)} : 1`)).child(div().w(72).flex_none().text_size(12).child(usd(x.perCommit))))))
      .child(h_flex().pt(6).gap(12).items_center().children(MIX.map(([, label, ink]) => h_flex().gap(5).items_center().text_size(11).text_color(t.muted).child(div().size(10).rounded(2).bg(ink)).child(label))))
      .child(div().text_size(11).text_color(t.dim).child("$ / 1M tok: recorded spend over all tokens (the blended price you actually paid, cache discounts included). $ / 1K out: spend per thousand output tokens, the text and code delivered. Read : write: context tokens read (fresh, cache write, cache read) per token written. $ / commit: spend over the runs that led to a commit. Codex records no cost, so its $ columns stay empty.")));
  }
  // The interval as a bar: the 95% range shaded, the observed rate as a tick.
  ci(t, w, color) {
    const W = 64;
    if (!w) return div().w(W + 44).text_size(11).text_color(t.dim).child("–");
    return h_flex().w(W + 44).gap(6).items_center()
      .child(div().relative().w(W).h(8).rounded(2).bg(t.raised)
        .child(div().absolute().top(0).h(8).rounded(2).left(w.lo * W).w(Math.max(2, (w.hi - w.lo) * W)).bg(alpha(color, 0.35)))
        .child(div().absolute().top(0).h(8).w(2).left(Math.min(W - 2, w.p * W)).bg(color)))
      .child(div().text_size(12).child(pct(w.p)));
  }

  // Model comparison, after Artificial Analysis' success-vs-cost charts: success rate up, cost of one clean run
  // across (log), one dot per harness x main model sized by runs, its 95% interval as a line.
  compare(t, r) {
    const chip = (id, label, n) => {
      const on = this.kind === id;
      return h_flex().id(`kind-${id ?? "all"}`).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().border(1)
        .border_color(on ? t.accent : t.border).when(on, (el) => el.bg(alpha(t.accent, 0.1))).text_size(12).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.kind = id; cx.notify(); })
        .child(label).child(div().text_size(11).text_color(t.dim).child(String(n)));
    };
    const same = h_flex().id("score-same").h(24).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer().border(1)
      .border_color(this.same ? t.accent : t.border).text_size(12).text_color(this.same ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.same = !this.same; cx.notify(); })
      .child(div().size(10).rounded(3).border(1).border_color(this.same ? t.accent : t.input).when(this.same, (el) => el.bg(t.accent))).child("Same repos only");
    const total = Object.values(r.kinds).reduce((a, n) => a + n, 0);
    const kinds = h_flex().gap(6).items_center().child(chip(null, "All work", total))
      .children(KINDS.filter(([k]) => r.kinds[k]).map(([k, label]) => chip(k, label, r.kinds[k]))).child(div().flex_1()).child(same);

    const rows = r.score, byCost = rows.some((x) => x.cps != null);
    const xOf = (x) => (byCost ? x.cps : x.tps), money = (v) => (byCost ? `$${v < 10 ? v.toFixed(2) : Math.round(v)}` : short(v));
    const plotted = rows.filter((x) => xOf(x) > 0); // log scale: a zero would put every dot at NaN
    const W = Math.max(240, this.width - 32 - 28), H = 210, L = 40, B = 22, PW = W - L - 12, PH = H - B - 10;
    let chart = null;
    if (plotted.length) {
      const vs = plotted.map(xOf), lo = Math.min(...vs) / 1.6, hi = Math.max(...vs) * 1.6;
      const ymin = Math.max(0, Math.floor(Math.min(...plotted.map((x) => x.clean.lo)) * 10) / 10);
      const X = (v) => L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * PW, Y = (p) => 10 + (1 - (p - ymin) / (1 - ymin || 1)) * PH;
      const maxN = Math.max(...plotted.map((x) => x.n));
      const ticks = [ymin, (ymin + 1) / 2, 1];
      chart = div().relative().w(W).h(H)
        .children(ticks.map((p) => div().absolute().left(L).top(Y(p)).w(PW).h(1).bg(t.border)))
        .children(ticks.map((p) => div().absolute().left(0).top(Y(p) - 7).w(L - 8).text_size(10).text_color(t.dim).child(pct(p))))
        .children([lo * 1.6, Math.sqrt(lo * hi), hi / 1.6].map((v, i) => div().absolute().top(H - B + 6).left(i === 0 ? L : i === 1 ? L + PW / 2 - 20 : L + PW - 48).text_size(10).text_color(t.dim).child(money(v))))
        .children(plotted.map((x) => {
          const key = `${x.h}|${x.model}`, s = 10 + 14 * Math.sqrt(x.n / maxN), cx_ = X(xOf(x)), on = this.hoverRow === key;
          return div().absolute().left(0).top(0).size_full()
            .child(div().absolute().left(cx_ - 1).top(Y(x.clean.hi)).w(2).h(Math.max(2, Y(x.clean.lo) - Y(x.clean.hi))).bg(alpha(HARNESS[x.h].color, 0.45)))
            .child(div().id(`dot-${key}`).absolute().left(cx_ - s / 2).top(Y(x.clean.p) - s / 2).size(s).rounded(s).bg(HARNESS[x.h].color)
              .border(2).border_color(on ? t.foreground : t.surface).cursor_pointer()
              .on_hover((h, cx) => { if (h) this.hoverRow = key; else if (this.hoverRow === key) this.hoverRow = null; cx.notify(); }));
        }));
    }
    const focus = rows.find((x) => `${x.h}|${x.model}` === this.hoverRow) ?? r.best ?? rows[0];
    const readout = !focus ? null : h_flex().h(20).gap(8).items_center().text_size(12)
      .child(this.icon(t, focus.h, 14)).child(div().font_semibold().child(`${HARNESS[focus.h].name} · ${focus.model}`))
      .child(div().truncate().text_color(t.muted).child(`${pct(focus.clean.p)} clean (${pct(focus.clean.lo)}–${pct(focus.clean.hi)}) · ${xOf(focus) != null ? `${money(xOf(focus))} per clean run` : "no cost recorded"} · ${focus.loops} tool loops per run · ${focus.n} runs`));

    const wide = this.width >= 640;
    const head = (label, w) => div().w(w).flex_none().text_size(11).text_color(t.dim).child(label);
    const table = v_flex().gap(2)
      .child(h_flex().h(20).gap(8).items_center().child(div().flex_1().text_size(11).text_color(t.dim).child("Harness · main model"))
        .child(head("Runs", 36)).child(head("Success", 108)).child(head(byCost ? "Cost / clean run" : "Tokens / clean run", 96)).child(head("Tool loops", 64))
        .when(wide, (el) => el.child(head("Led to a commit", 108))))
      .children(rows.map((x) => h_flex().id(`score-${x.h}-${x.model}`).h(28).gap(8).items_center().rounded(6)
        .when(this.hoverRow === `${x.h}|${x.model}`, (el) => el.bg(t.hover)).when(r.best === x, (el) => el.bg(alpha(t.done, 0.08)))
        .on_hover((h, cx) => { const key = `${x.h}|${x.model}`; if (h) this.hoverRow = key; else if (this.hoverRow === key) this.hoverRow = null; cx.notify(); })
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().child(div().size(8).rounded(4).flex_none().bg(HARNESS[x.h].color)).child(this.icon(t, x.h, 14))
          .child(div().flex_none().text_size(12).child(HARNESS[x.h].name)).child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(x.model))
          .when(r.best === x, (el) => el.child(h_flex().h(18).px(6).flex_none().items_center().rounded(5).bg(alpha(t.done, 0.16)).text_size(11).text_color(t.done).child("best for you"))))
        .child(div().w(36).flex_none().text_size(12).child(String(x.n)))
        .child(this.ci(t, x.clean, t.done))
        .child(div().w(96).flex_none().text_size(12).child(xOf(x) != null ? money(xOf(x)) : "–"))
        .child(div().w(64).flex_none().text_size(12).child(String(x.loops)))
        .when(wide, (el) => el.child(this.ci(t, x.commit, t.accent)))));
    const verdict = !rows.length ? "Not enough runs here yet: a harness × model needs 3 or more." : r.best ? null
      : "No clear winner yet: the intervals overlap, so the gaps could be chance.";
    const notes = "Success: share of clean runs (no abort, API error or context compaction; under 10% failed tool calls), with its 95% interval. Cost / clean run: all recorded spend, failed runs included, over the clean runs (API prices; Codex records none, so tokens stand in). Tool loops: median tool calls per run. Kind of work comes from each run's mix of tools. Main model: most tokens in the run.";
    return v_flex().gap(12)
      .child(kinds)
      .child(this.card(t, "Success against cost", div().text_size(11).text_color(t.dim).child(`↖ better and cheaper · across: ${byCost ? "cost of one clean run" : "tokens per clean run"}, log scale`), v_flex().gap(8)
        .child(chart ?? div().text_center().text_size(12).text_color(t.dim).child("Nothing to plot: no harness × model has 3 runs here."))
        .when(Boolean(readout), (el) => el.child(readout))))
      .child(this.card(t, "Model comparison", null, v_flex().gap(10).child(table)
        .when(Boolean(verdict), (el) => el.child(div().text_size(12).text_color(t.muted).child(verdict)))
        .child(div().text_size(11).text_color(t.dim).child(notes))))
      .when(rows.length > 0, (el) => el.child(this.anatomy(t, r)));
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
      if (!ov.went) { this.handle.focus(); cx.notify(); }
    });
  }

  // The large popup (mod.open) closing gives the keyboard back to the side panel showing (emergence.back).
  async close() { if (!this.panel && props()?.overlay) setShared("emergence.back", Date.now()); }

  render(cx) {
    const t = theme(), vis = this.shown();
    if (vis && !this.wasShown) this.scan(cx, true); // shown again: don't wait up to a minute for the timer (busy guards a running scan)
    const opened = this.panel && vis && shared("emergence.opened"); // opened (⌘⇧U, the tab bar; tabs-plus says so): the keys are its own at once
    if (opened?.id === "usage" && opened.at !== this.openedAt && Date.now() - opened.at < 3000) { this.openedAt = opened.at; cx.timer.after(50, () => this.handle.focus()); }
    const back = this.panel && vis && shared("emergence.back"); // a panel's window or popup closed: the keyboard comes back
    if (back && back !== this.backAt) { this.backAt = back; if (Date.now() - back < 3000) cx.timer.after(80, () => this.handle.focus()); }
    if (this.panel) { this.comeBack(cx, this.held); this.held = this.handle.is_focused(); }
    this.wasShown = vis;
    const root = (this.panel
      ? v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      : v_flex().w_full().h((window.viewport_size().height * 0.88) / settings().zoom).bg(t.background))
      .id("usage-root").text_size(13).text_color(t.foreground).track_focus(this.handle)
      .on_size_change((s, cx) => { const w = s.width / settings().zoom; if (Math.abs(w - this.width) > 1) { this.width = w; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.keystroke === "escape" && this.panel) return run("tabs-plus.back"); // back to the terminal
        if (e.keystroke !== "left" && e.keystroke !== "right") return;
        const next = tabAfter(TABS, this.tab, e.keystroke, this.typing > 0);
        if (!next) return; // a date field's caret
        this.tab = next;
        localStorage.setItem("tab", this.tab);
        cx.stop_propagation();
        cx.notify();
      })
      // A drag ends where the button comes up, or when the pointer leaves the panel.
      .on_mouse_down("left", () => this.handle.focus()).on_mouse_up("left", () => { this.drag = null; }).on_hover((on) => { if (!on) this.drag = null; });
    const sessions = data?.sessions ?? [];
    const present = ORDER.filter((h) => sessions.some((s) => s.h === h));
    const now = Date.now(), p = this.period(now);
    this.last = startOfDay(p.to - 1); // a weekly bar picks no day past the period
    // What's picked narrows everything: days replace the period, hours of the week filter inside it.
    const sel = this.sel, keep = sel ? keepOf(sel) : () => true;
    const win = sel?.kind === "days" ? { from: Math.min(...sel.keys), to: addDays(Math.max(...sel.keys), 1), days: sel.keys.size } : { from: p.from, to: p.to, days: null };
    const counts = {};
    for (const s of sessions) if (!s.sub && s.start >= win.from && s.start < win.to && keep(s.start)) counts[s.h] = (counts[s.h] ?? 0) + 1;
    root.child(this.header(t, present, counts, p));
    if (!data) {
      return root.child(v_flex().flex_1().items_center().justify_center().gap(8).p(24).text_center()
        .child(div().text_size(13).text_color(t.muted).child(this.busy ? "Reading your harnesses' session logs…" : "Couldn't read the session logs."))
        .child(div().max_w(420).text_size(12).text_color(t.dim).child(this.busy ? "omp, Claude Code, Codex, OpenCode and pi, on this machine. The first scan takes a while; later ones only read what changed." : this.error ?? "")));
    }
    const on = new Set(present.filter((h) => !this.off.has(h)));
    // Weekday labels 31 + 14 per week must fit inside the body and card padding.
    const weeks = Math.max(8, Math.min(53, Math.floor((this.width - 32 - 28 - 31 - 12) / 14)));
    const key = `${data.scanned_at}|${p.from}|${p.to === now ? startOfDay(now) : p.to}|${[...on]}|${this.same}|${this.kind}|${weeks}|${this.metric}|${this.selV}`;
    // The sums run after this frame: Herdr interrupts a render after ~100 ms, and a heavy year of sessions takes
    // longer than that (async work has no limit). Until they land, the last ones show. r0 and o0 are the whole
    // period, for the chart something was picked on; r and o are what's picked (the same, with nothing picked).
    if (this.memoKey !== key || this.memoOut !== output) {
      this.memoKey = key;
      const out = (this.memoOut = output);
      cx.spawn(async (cx) => {
        await cx.sleep(0);
        if (this.memoKey !== key || this.memoOut !== out) return; // superseded
        const base = { harnesses: on, sameRepos: this.same, kind: this.kind };
        const r0 = summarize(sessions, { ...base, from: p.from, to: p.to }), r = sel ? summarize(sessions, { ...base, ...win, keep }) : r0;
        const o0 = out && outputOf(out, { from: p.from, to: p.to, step: r0.step }), o = sel ? out && outputOf(out, { from: win.from, to: win.to, step: r.step, keep }) : o0;
        const slots = sel?.kind === "slots";
        this.memo = { r0, r, o0, o, cells: heat(sessions.filter((s) => on.has(s.h) && (!slots || keep(s.start))), { weeks, metric: this.metric }) };
        cx.notify();
      });
    }
    if (!this.memo) return root.child(v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child("Adding up…"));
    const { r0, r, o0, o, cells } = this.memo, shown = present.filter((h) => on.has(h));
    const empty = div().p(12).text_center().text_size(13).text_color(t.muted).child(`No sessions in ${p.label} for the harnesses shown.`);
    const view = this.tab === "harnesses" ? (r0.tiles.sessions ? [this.over(t, r0, r, shown), this.models(t, r), this.effort(t, r, shown)] : [empty])
      : this.tab === "compare" ? [this.compare(t, r)]
      : this.tab === "output" ? this.outputView(t, r0, r, p, o0, o)
      : this.tab === "rhythm" ? (r0.tiles.sessions ? (() => {
        // A two-column dashboard: the tall hour grid (stretched to the column's height, the day split filling its
        // foot) beside the agents-at-once strip and the two bar cards stacked.
        const side = this.width >= 560, w = side ? this.width - 32 - 190 - 12 - 28 : this.width - 32 - 28;
        const lengths = this.bars(t, "How long runs last", "top-level sessions", LENGTHS.map(([, label], i) => [label, r.rhythm.lengths[i]]), w);
        const days = this.bars(t, "Days of the week", "sessions started", WD.map((d, i) => [d, r.rhythm.weekdays[i]]), w);
        return [this.rhythmTiles(t, r), side
          ? h_flex().gap(12).items_stretch().child(v_flex().w(190).flex_none().child(this.punch(t, r0, r).flex_1()))
            .child(v_flex().flex_1().min_w(0).gap(12).child(this.parallel(t, r0, r)).child(lengths).child(days))
          : v_flex().gap(12).child(this.punch(t, r0, r)).child(this.parallel(t, r0, r)).child(lengths).child(days)];
      })() : [empty])
      : [this.tiles(t, r), this.heatmap(t, cells, weeks), ...(r.tiles.sessions ? [this.pair(this.tokensCard(t, r), this.workCard(t, r))]
        : this.sel ? [div().p(12).text_center().text_size(13).text_color(t.muted).child(`No sessions in ${this.selLabel()}. Clear it (✕, top right) to see ${p.label}.`)] : [])];
    return root.child(v_flex().id("usage-body").flex_1().min_h(0).p(16).gap(12).overflow_y_scrollbar().children(view));
  }
}
