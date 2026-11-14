// Jump (⌘E): every session (a tab, in any space) and every worktree of your open repos not open yet, in one list.
// Sessions come in the order you last showed them (tabs-plus records it in shared "jump.recent"): the one you're on,
// then the one before it, picked, so ⌘E ↵ goes back and again comes forth; never-shown ones follow, then worktrees.
// Each session shows what its agent is on (the terminal title it sets) and how long it has been in its state.
// Type to filter: every word, anywhere in tab, space, branch, folder, agent or what it's on; a leading "/" is
// ignored. A space's name also finds its repo's other checkouts (sessions and worktrees), as the sidebar nests them. A branch name nothing has offers a new worktree for it, in the repo you're in.
// ↑/↓ to pick, ↵ to go (a worktree opens as a space), Esc to leave.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, spaces, panes, focused, exec, run, theme, props, shared, setShared, openOverlay, closeOverlay, home } from "herdr";

const tilde = (p) => (p && home() && (p === home() || p.startsWith(`${home()}/`)) ? `~${p.slice(home().length)}` : p ?? "");

const inside = (p, dir) => Boolean(p) && (p === dir || p.startsWith(dir + "/"));
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const STATE = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };

// The checkouts of every repo a terminal is in, each repo once, newest commit first:
// { path, branch, machine, repo, key (machine + git common dir: one per repo), at (last commit, ms) }.
async function worktrees() {
  const seen = new Set(), out = [];
  const dirs = new Map(panes().filter((p) => p.terminal && p.cwd).map((p) => {
    const machine = spaces().find((s) => s.tabs.some((t) => t.id === p.tab))?.machine ?? null;
    return [`${machine ?? ""}\n${p.cwd}`, { cwd: p.cwd, machine }];
  }));
  for (const { cwd, machine } of dirs.values()) {
    const git = (...args) => exec("git", args, { cwd, on: machine ?? undefined }).catch(() => ({ code: 1 }));
    const common = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const key = `${machine ?? ""}\n${common.stdout?.trim()}`;
    if (common.code !== 0 || seen.has(key)) continue;
    seen.add(key);
    const [list, refs] = await Promise.all([git("worktree", "list", "--porcelain"), git("for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads")]);
    if (list.code !== 0) continue;
    const when = new Map((refs.stdout ?? "").trim().split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) * 1000 || 0]));
    let repo = null;
    for (const block of list.stdout.trim().split(/\n\n+/)) {
      const lines = block.split("\n"), path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
      repo ??= path.split("/").pop();
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
      out.push({ path, machine, repo, key, branch, at: when.get(branch) ?? 0 });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export default class Jump extends View {
  init(_props, cx) {
    setShared("emergence.over", { at: Date.now(), open: true }); // the keyboard goes back where it was when this closes
    this.input = InputState.new({ placeholder: "Jump to a session or worktree…" });
    this.input.on("change", (_e, cx) => { this.at = null; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    this.at = null; // the pick; null: the first row that isn't where you are
    this.wts = [];
    this.list = ScrollHandle.new();
    cx.spawn(async (cx) => { await cx.sleep(16); this.wts = await worktrees(); cx.notify(); }); // host calls before the first frame never resolve
  }

  dismiss() { closeOverlay(props().overlay); }

  // Every close (Esc is Herdr's own). `went`: a row was picked, so the keyboard follows it instead.
  async close() { setShared("emergence.over", { at: Date.now(), open: false, went: this.went }); }

  rows() {
    const q = this.input.value().replace(/^\s*\//, "").trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const fits = (...hay) => { const h = hay.filter(Boolean).join(" ").toLowerCase(); return words.every((w) => h.includes(w)); };
    const all = panes(), ags = agents(), recent = shared("jump.recent") ?? [], here = focused()?.tab;
    const rank = (id) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    const tabs = spaces().flatMap((s) => s.tabs.map((tb) => {
      const p = all.find((x) => x.tab === tb.id && x.terminal && x.cwd), mine = ags.filter((a) => a.tab === tb.id);
      const lead = mine.find((a) => a.status === tb.status) ?? mine[0]; // the agent the tab's state is from
      return { kind: "tab", s, tb, cwd: p?.cwd, branch: p?.branch, program: (lead ?? p)?.program, on: lead?.title, here: tb.id === here,
        who: [...new Set(mine.map((a) => a.program?.name ?? "agent"))].join(" · ") };
    })).sort((a, b) => rank(a.tb.id) - rank(b.tb.id)); // stable: never-shown tabs keep space order
    // The repo a session is in (its innermost checkout), and the names of the spaces with a session in each repo.
    const repoOf = (r) => this.wts.filter((w) => w.machine === (r.s.machine ?? null) && inside(r.cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0]?.key;
    const names = new Map();
    for (const r of tabs) { const k = repoOf(r); if (k) names.set(k, [...(names.get(k) ?? []), r.s.name]); }
    const kin = (k) => names.get(k) ?? [];
    // A checkout is open when a session's terminal is in it (and not in a checkout inside it).
    const open = (w) => tabs.some((r) => (r.s.machine ?? null) === w.machine && inside(r.cwd, w.path) && !this.wts.some((o) => o.path.length > w.path.length && inside(r.cwd, o.path)));
    const rows = [
      ...tabs.filter((r) => fits(r.tb.name, r.s.name, r.branch, r.cwd, r.who, r.on, ...kin(repoOf(r)))),
      ...this.wts.filter((w) => !open(w) && fits(w.branch, w.path, w.repo, w.machine, ...kin(w.key))).map((w) => ({ kind: "wt", ...w })),
    ];
    const at = tabs.find((r) => r.here), repo = at && this.wts.find((w) => (at.s.machine ?? null) === w.machine && inside(at.cwd, w.path))?.repo;
    if (/^[\w./-]+$/.test(q) && repo && !this.wts.some((w) => w.repo === repo && w.machine === (at.s.machine ?? null) && w.branch === q)) rows.push({ kind: "new", branch: q, space: at.s, cwd: at.cwd, repo });
    return rows;
  }

  go(r) {
    if (!r) return;
    this.went = true;
    this.dismiss();
    if (r.kind === "tab") run("tab.select", { id: r.tb.id });
    else if (r.kind === "wt") run("space.new", { folder: r.path, machine: r.machine ?? "" });
    else openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: r.space.id, folder: r.cwd, action: "new", branch: r.branch } });
  }

  render() {
    const t = theme(), rows = this.rows();
    if (this.at === null) { this.at = Math.max(0, rows.findIndex((r) => !r.here)); this.list.scroll_to_item(this.at); }
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const firstWt = rows.findIndex((r) => r.kind === "wt");
    const two = (on, icon, top, bottom, right) => h_flex().h(48).mx(6).px(10).gap(10).items_center().rounded(7).cursor_pointer()
      .when(on, (x) => x.bg(t.selected)).when(!on, (x) => x.hover((h) => h.bg(t.hover)))
      .child(div().size(16).flex_none().flex().items_center().justify_center().when(Boolean(icon), (x) => x.child(icon)))
      .child(v_flex().flex_1().min_w(0).gap(2).child(top).child(bottom))
      .when(Boolean(right), (x) => x.child(right));
    // The second line: 12 dim, one style for every row; a path (with ~) is cut from the start, where its name is.
    const sub = (text, path) => div().min_w(0).whitespace_nowrap().overflow_hidden().text_size(12).text_color(t.dim)
      .map((x) => (path ? x.text_ellipsis_start() : x.text_ellipsis())).child(text);
    const row = (r, i) => {
      const on = i === this.at;
      if (r.kind === "new") return two(on, div().text_size(15).text_color(t.accent).child("+"),
        h_flex().gap(6).text_size(13).text_color(t.foreground).child("New worktree").child(div().text_color(t.accent).child(r.branch)),
        sub(`from ${r.repo}, opened as a space`));
      if (r.kind === "wt") return two(on, svg("mods/agent-graph/branch.svg").size(15).text_color(t.muted),
        h_flex().gap(8).items_center().child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.branch ?? "(detached)")).child(div().flex_none().text_size(12).text_color(t.muted).child(r.repo)),
        sub(`${r.machine ? `${r.machine}:` : ""}${tilde(r.path)}`, true),
        v_flex().flex_none().items_end().gap(2).text_size(11).text_color(t.dim).when(on, (x) => x.child("↵ open as space")).when(r.at > 0, (x) => x.child(`committed ${ago(r.at)}`)));
      const p = r.program, st = r.tb.status, since = st === "working" ? r.tb.working_since : r.tb.changed_at;
      return two(on, p?.icon ? (p.tint ? svg(p.icon).size(15).text_color(t.muted) : image(p.icon).size(15)) : null,
        h_flex().gap(8).items_center()
          .child(div().flex_none().max_w(300).truncate().text_size(13).text_color(t.foreground).when(r.here, (x) => x.font_semibold()).child(r.tb.name))
          .child(div().flex_none().text_size(12).text_color(t.muted).child(r.s.name))
          .when(Boolean(r.branch) && r.branch !== r.tb.name, (x) => x.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(r.branch))),
        sub(r.on || tilde(r.cwd) || "", !r.on),
        v_flex().flex_none().items_end().gap(2).text_size(11)
          .when(Boolean(st), (x) => x.child(h_flex().gap(5).items_center().text_color(st === "blocked" ? t.blocked : st === "done" ? t.done : t.muted)
            .when(st === "working", (y) => y.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)))
            .when(st === "blocked" || st === "done", (y) => y.child(div().size(6).rounded(3).bg(t[st])))
            .child(since ? `${STATE[st]} ${ago(since)}` : STATE[st])))
          .child(div().text_color(t.dim).child(r.here ? "you're here" : r.who)));
    };
    const move = (by, cx) => { if (rows.length) { this.at = (this.at + by + rows.length) % rows.length; this.list.scroll_to_item(this.at); } cx.stop_propagation(); cx.notify(); };
    return v_flex().id("jump").size_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") move(1, cx);
        else if (e.key === "up") move(-1, cx);
      })
      .child(h_flex().h(52).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).id("jump-input").flex_1().h_full().text_size(15).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("↑↓ pick · ↵ go"))
        .child(div().id("jump-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(() => this.dismiss()).child("Esc")))
      .child(v_flex().id("jump-list").flex_1().min_h(0).py(6).overflow_y_scrollbar().track_scroll(this.list)
        .children(rows.map((r, i) => {
          const el = div().id(`jump-${i}`).on_click(() => this.go(r)).child(row(r, i));
          return i === firstWt ? v_flex().child(div().px(16).pt(10).pb(4).text_size(11.5).font_medium().text_color(t.dim).child("Worktrees, not open")).child(el) : el;
        }))
        .when(!rows.length, (x) => x.child(div().p(16).text_center().text_size(13).text_color(t.muted).child("Nothing matches."))));
  }
}
