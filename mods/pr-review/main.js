// PR review: a floating window (openWindow: centred, screen-sized, resizable), or a side-panel
// block (props { panel: true }), that follows the focused pane's repo. Left rail: this branch vs the default branch, then the
// repo's PRs (search, Open · Closed · All). Main: the changed files as a folder tree and one file's
// unified diff at a time, drawn only where it is on screen, with GitHub review threads inline under
// their lines. Click / shift-click / drag selects lines on one side; ⌘Enter posts a review comment on
// them, optionally tagged Nit · Minor · Major · Question · Statement.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, ScrollHandle } from "gpui-base";
import { exec, focused, panes, spaces, theme, settings, props, shared, setShared, openOverlay, closeOverlay, run, layout } from "herdr";
import * as github from "./github.js";
import * as gitlab from "./gitlab.js";
import { forgeOrder } from "./gitlab-map.js";
import { parseDiff, selectRange, commentPayload, anchorThreads, ago, firstVisible, fileTree, TAGS, tagBody, splitTag, shown, findAll, findTalk, mentions, gapBefore, hiddenRows, pairRows, tabArrows } from "./lib.js";

const MONO = "Geist Mono";
const icon = (name) => svg(`mods/pr-review/${name}.svg`);
const tint = (c, a) => c.slice(0, 7) + a;
const H = { file: 40, row: 20, hunk: 28, note: 36, thread: 132, resolved: 44 };
const GUTTER = 104; // two line-number columns + sign: cards and notes line up with the code
// ponytail: a code character's width, guessed from Geist Mono's 0.6em advance at 12px; wide (CJK) glyphs run past it.
const CH = 7.2;
const field = (_e, cx) => cx.stop_propagation(); // a text box's own press: it takes the keyboard, not the view
const holds = (it, ri) => (it.k === "row" && it.ri === ri) || (it.k === "pair" && (it.l === ri || it.r === ri)); // a laid-out line showing row ri
const STATES = [["open", "Open"], ["closed", "Closed"], ["all", "All"]];
const BLOCK = "prs"; // this mod's block id in the layout's panel-body stack
const NARROW = 760; // panel width below which it drills down: list → PR → diff

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The floating window: 94% × 90% of the screen until resized by hand (⤢ from the panel always opens it that big),
// never bigger than the screen; opened unkeyed at the centre (a keyed window reopens wherever it was last dropped).
// One that `mod.open` put up (mod.json, Herdr-centred, so it would jump while resized) hands over to this at once.
function winSize() {
  const v = window.viewport_size(), z = settings().zoom ?? 1, [w, h] = shared("pr-review.wsize") ?? [Infinity, Infinity];
  return [Math.max(640, Math.min(w, Math.round((v.width * 0.94) / z))), Math.max(420, Math.min(h, Math.round((v.height * 0.9) / z)))];
}
function openWindow() {
  const v = window.viewport_size(), z = settings().zoom ?? 1, [w, h] = winSize();
  const prev = shared("pr-review.window");
  if (prev) closeOverlay(prev);
  setShared("pr-review.window", openOverlay({ kind: "window", mod: "pr-review", frame: "none", props: { placed: true }, at: { x: Math.round((v.width - w * z) / 2), y: Math.round((v.height - h * z) / 2) } }));
}

async function git(id, args) {
  const r = await exec("git", args, { cwd: id.repo, on: id.machine });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

const TALK = { id: "talk", where: "issues" }; // the conversation, standing in for a thread in the comment writes (busy, drafts, errors)

export default class PrReview extends View {
  init(_props, cx) {
    this.panel = props()?.panel === true;
    this.backAt = shared("emergence.back");
    if (!this.panel && !props()?.placed) {
      this.handoff = true;
      return void cx.spawn(async () => { openWindow(); closeOverlay(props().overlay); });
    }
    this.repos = new Map(); // "machine|toplevel" → per-repo state, kept while the window is open
    this.cur = null; // the shown repo's state, or { none: message }
    this.heights = new Map(); // measured thread heights
    this.expanded = new Set(); // resolved threads opened by hand
    this.filesOpen = true; // the file tree beside the diff, where there is room for both
    this.railOpen = true; // the PR list beside the open PR; hide it to give the diff the room
    [this.W, this.H] = winSize(); // the window's size, dragged by its edges
    this.treeScroll = ScrollHandle.new(); // keeps the arrow-key file in view
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search pull requests" });
    this.search.on("focus", () => (this.inSearch = true));
    this.search.on("blur", () => (this.inSearch = false));
    this.search.on("change", (_e, cx) => {
      const s = this.cur;
      if (!s?.id || this.search.value() === s.search) return;
      s.search = this.search.value();
      const seq = (this.searchSeq = (this.searchSeq ?? 0) + 1);
      cx.timer.after(350, (cx) => seq === this.searchSeq && this.loadPRs(s, cx));
    });
    this.findQ = InputState.new({ placeholder: "Find in code and comments" }); // ⌘F over the diff
    this.baseQ = InputState.new({ placeholder: "Filter branches" }); // the compare's picker, either side
    this.baseQ.on("focus", () => (this.typing = true));
    this.baseQ.on("blur", () => (this.typing = false));
    this.baseQ.on("submit", (_e, cx) => { const s = this.cur, l = s ? this.bases(s) : []; if (l.length) this.pickBase(s, l[0], cx); cx.notify(); });
    this.findEvery = true; // All files; This file narrows it
    this.findQ.on("focus", () => (this.typing = this.inFind = true));
    this.findQ.on("blur", () => (this.typing = this.inFind = false));
    this.findQ.on("change", (_e, cx) => { this.jump(0); cx.notify(); });
    this.findQ.on("submit", (e, cx) => { this.jump(e.shift ? -1 : 1); cx.notify(); });
    this.composer = this.textarea("Leave a comment", (cx) => this.post(cx));
    this.talkBox = this.textarea("Comment on the pull request", (cx) => this.postTalk(cx));
    this.talkScroll = ScrollHandle.new();
    // A hidden panel skips polling and catches up when shown again.
    this.ticks = 0;
    if (this.panel) setShared("pr-review.wide", false); // full size doesn't outlive the copy (widen's wideFrom)
    // The panel leaves polling to the window while one is open on top (one set of GitHub calls, not two).
    cx.timer.every(5000, (cx) => (this.shown() && !this.yields() ? this.poll(this.cur, cx) : (this.stale = true)));
    if (this.panel) return void cx.timer.every(250, (cx) => { if (this.handle.is_focused() !== this.held) cx.notify(); }); // no blur event (comeBack)
    this.handle.focus();
    cx.timer.after(150, () => this.handle.focus());
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

  // The window forgets its id when it goes, so a later open never closes some other overlay that reuses it.
  // Closed for good (not replaced by another window): the keyboard goes back to the side panel showing (emergence.back).
  async close() {
    if (!this.panel && props()?.overlay && shared("pr-review.window") === props().overlay) { setShared("pr-review.window", null); setShared("emergence.back", Date.now()); }
  }

  yields() { return this.panel && Boolean(shared("pr-review.window")); } // the window polls instead

  shown() {
    if (!this.panel) return true;
    const root = layout(), panel = find(root, "panel");
    return Boolean(panel) && !panel.hidden && find(root, "panel-body")?.active === BLOCK; // a shown panel has no `hidden` key
  }

  // Every 5 s while shown: the PR's comments and conversation, then its diff once the head has moved past the one
  // shown (this branch: the working tree, so an agent's edits land as it makes them), unless you're in a commit, a
  // selection or a draft there; it catches up after. The PR list every 30 s.
  poll(s, cx) {
    if (!s?.info) return;
    if (this.ticks++ % 6 === 0) this.loadPRs(s, cx, true);
    const entry = s.entry, d = s.diffs.get(entry);
    if (!d || d.loading || d.polling) return;
    d.polling = true;
    cx.spawn(async (cx) => {
      try {
        if (entry !== "local") await this.fetchThreads(s, entry);
        if ((entry === "local" || (d.at && d.headOid !== d.at)) && !d.commit && !s.sel && !this.draft) {
          const pair = entry === "local" && this.compareTitle(s), got = {}; // a side picked meanwhile reloads on its own: drop this one
          const text = await this.diffText(s, entry, got);
          if (pair === (entry === "local" && this.compareTitle(s))) {
            if (got.commits) d.commits = got.commits;
            if (text === d.text) d.at = d.headOid; // a new head with the same changes (base merged in, message amended)
            if (entry !== "local") d.commits = await s.api.prCommits(s.id, entry).catch(() => d.commits);
            if (text !== d.text && !d.loading && !d.commit && !s.sel) this.applyDiff(d, text); // a selection made meanwhile keeps its lines
          }
        }
      } catch { /* the next poll tries again */ }
      d.polling = false;
      cx.notify();
    });
  }

  // A Textarea that submits on ⌘Enter and keeps the rail's keys away while focused.
  textarea(placeholder, submit, value) {
    const st = TextareaState.new({ placeholder, value, rows: 3 });
    st.on("focus", () => (this.typing = true));
    st.on("blur", () => (this.typing = false));
    st.on("submit", (e, cx) => e.secondary && !e.shift && submit(cx));
    return st;
  }

  dismiss() { closeOverlay(props().overlay); }

  // Panel → the window, carrying the open PR over. (Not `expand`: that's the hidden lines' below.)
  popOut() {
    const s = this.cur;
    this.handledAt = Date.now();
    // "This branch" too: a stale request (another PR, within 30 s) would reopen that PR instead.
    setShared("pr-review.open", typeof s?.entry === "number" ? { repo: s.id.repo, machine: s.id.machine, number: s.entry, at: this.handledAt } : null);
    setShared("pr-review.wsize", null); // a hand-made size stays with the window it was made in: ⤢ opens big
    openWindow();
  }

  // Panel: full size for reviewing beside an agent. The sidebar folds away as ⌘B does (tabs-plus.rail),
  // the terminal keeps the sidebar's width on the left, the PR takes the rest. Again: all back.
  widen() {
    setShared("pr-review.wide", !this.wideFrom); // tabs-plus doesn't remember the PRs width while it's full size
    const s = find(layout(), "sidebar"), sb = s?.hidden ? 0 : s?.size?.px ?? 0, fold = sb >= 160;
    if (this.wideFrom) {
      run("layout.resize", { id: "panel", px: this.wideFrom[0] });
      if (this.wideFrom[1] && s && !s.hidden && !fold) run("tabs-plus.rail");
      return void (this.wideFrom = null);
    }
    this.wideFrom = [find(layout(), "panel")?.size?.px ?? 860, fold];
    if (fold) run("tabs-plus.rail");
    // 14: the folded strip; 25: its divider, the work row's padding and gap.
    const side = fold ? 14 : sb, term = fold ? sb : shared("sidebar.width") ?? 268;
    run("layout.resize", { id: "panel", px: Math.round(window.viewport_size().width / this.zoom) - side - 25 - term });
  }

  // Narrow: back from the diff to its PR, then out of the PR (as Esc in the wide view), find closed either way.
  back(s) { if (s.level === "diff") s.level = "pr"; else { s.level = "list"; s.entry = null; } if (this.finding) this.closeFind(); }

  // ---- target: the focused pane's repo, or a deep link ----

  focusInfo() {
    const f = focused();
    const cwd = f && (f.cwd ?? (f.pane && panes().find((p) => p.pane === f.pane)?.cwd));
    return cwd ? { dir: cwd, machine: spaces().find((s) => s.id === f.space)?.machine ?? null } : null;
  }

  syncTarget(cx) {
    const f = this.focusInfo();
    const fk = f && `${f.machine}|${f.dir}`;
    const req = shared("pr-review.open");
    if (req?.at && req.at !== this.handledAt && Date.now() - req.at < 30000) {
      this.handledAt = req.at;
      this.pin = { dir: req.repo, machine: req.machine ?? null, number: req.number, at: req.at, focus: fk };
      if (this.panel) cx.spawn(async () => setShared("pr-review.open", null)); // a window opening right after still gets it (30 s)
    }
    if (this.pin && f && fk !== this.pin.focus) this.pin = null;
    const want = this.pin ?? f;
    if (!want) return;
    const key = `${want.machine}|${want.dir}|${want.at ?? ""}`;
    if (key === this.wantKey) return;
    this.wantKey = key;
    cx.spawn(async (cx) => {
      await cx.sleep(16); // host calls started before a copy's first frame never resolve
      const top = (await git({ repo: want.dir, machine: want.machine }, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
      if (this.wantKey !== key) return;
      if (!top) { this.leave(); this.cur = { none: "This folder isn't a git repository." }; cx.notify(); return; }
      const rk = `${want.machine}|${top}`;
      let s = this.repos.get(rk), fresh = !s;
      if (fresh) this.repos.set(rk, (s = { id: { repo: top, machine: want.machine }, name: top.split("/").pop(), state: "open", search: "", diffs: new Map(), scroll: {}, entry: null, cursor: 0 }));
      // Before anything loads: a half-written comment stays with its repo's PR.
      if (this.cur !== s) { this.leave(); this.enter(s); this.cur = s; }
      if (fresh) this.loadRepo(s, cx, want.number);
      else if (want.number) this.open(s, want.number, cx);
      if (want.number) s.level = "pr";
      if (this.repoll) { this.repoll = false; this.poll(s, cx); }
      this.search.set_value(s.search);
      cx.notify();
    });
  }

  // ---- reads ----

  loadRepo(s, cx, number) {
    s.loading = true;
    cx.spawn(async (cx) => {
      s.branch = (await git(s.id, ["branch", "--show-current"]).catch(() => "")).trim() || "detached HEAD";
      try {
        // The repo's forge: GitHub (gh) or GitLab (glab), the likelier first by its origin remote, else the other;
        // the rest of the panel calls s.api.
        const order = forgeOrder((await git(s.id, ["remote", "get-url", "origin"]).catch(() => "")).trim()), apis = { github, gitlab };
        let why; // the likelier forge's error: the other's only says this isn't its kind of remote
        for (const name of order) {
          try { s.info = await apis[name].repoInfo(s.id); s.api = apis[name]; break; } catch (e) { why ??= e; }
        }
        if (!s.info) throw why;
        s.info.defaultBranch ??= (await git(s.id, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "main")).trim().replace(/^origin\//, "");
      } catch (e) {
        s.error = /remote|not a github|no known/i.test(e.message) ? "No GitHub or GitLab remote for this repository." : e.message;
      }
      s.loading = false;
      if (s.info) { this.loadPRs(s, cx); if (number) this.open(s, number, cx); }
      cx.notify();
    });
  }

  loadPRs(s, cx, quiet) {
    if (!quiet) s.prsLoading = true;
    const ask = `${s.state}|${s.search}`;
    cx.spawn(async (cx) => {
      try {
        const prs = await s.api.listPRs(s.id, s.state, s.search.trim());
        if (ask !== `${s.state}|${s.search}`) return;
        const rank = (p) => (p.state === "OPEN" ? 0 : 1);
        s.prs = prs.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
        s.prsError = null;
      } catch (e) { s.prsError = e.message; }
      s.prsLoading = false;
      cx.notify();
    });
  }

  open(s, entry, cx, reload) {
    if (s.entry !== entry) { s.entry = entry; this.dropWork(s); }
    const d = s.diffs.get(entry) ?? {};
    d.pr = s.prs?.find((p) => p.number === entry) ?? d.pr; // kept so the header survives filtering the PR out of the list
    if (s.diffs.has(entry) && !reload) return;
    d.loading = true;
    if (d.full) Object.assign(d, d.full); // never a commit's diff as the whole PR's while the new one loads
    Object.assign(d, { commit: null, full: null, byCommit: null, at: null }); // a refresh shows all changes again
    s.diffs.set(entry, d);
    cx.spawn(async (cx) => {
      try { this.applyDiff(d, await this.diffText(s, entry, d)); } catch (e) { d.error = e.message; }
      d.loading = false;
      cx.notify();
    });
    if (entry === "local") return;
    this.loadThreads(s, entry, cx);
    if (!d.pr) cx.spawn(async (cx) => { d.pr = await s.api.viewPR(s.id, entry).catch(() => null); cx.notify(); });
    cx.spawn(async (cx) => { d.commits = await s.api.prCommits(s.id, entry).catch(() => d.commits); cx.notify(); });
  }

  // The two sides "This branch" compares, picked per repo: the base (else the default branch) and the head (else
  // null: the checked-out branch with its uncommitted work).
  baseOf(s) { return shared("pr-review.bases")?.[s.id.repo] ?? s.info.defaultBranch; }
  headOf(s) { return shared("pr-review.heads")?.[s.id.repo] ?? null; }
  compareTitle(s) { return `${this.headOf(s) ?? "This branch"} vs ${this.baseOf(s)}`; }

  // The entry's diff; for the compare, since the merge-base of its two sides (uncommitted work included when the head
  // is this branch), with its commits. The default branch is taken from origin when it can be (a stale local main
  // would add others' work); a picked one, as is.
  async diffText(s, entry, d) {
    if (entry !== "local") return s.api.prDiff(s.id, entry);
    const base = this.baseOf(s), head = this.headOf(s), to = head ?? "HEAD", picked = base !== s.info.defaultBranch;
    const mb = (await (picked ? git(s.id, ["merge-base", base, to]) : git(s.id, ["merge-base", `origin/${base}`, to]).catch(() => git(s.id, ["merge-base", base, to])))).trim();
    d.commits = (await git(s.id, ["log", "--reverse", "--format=%H%x09%an%x09%cI%x09%s", `${mb}..${to}`])).split("\n").filter(Boolean)
      .map((l) => { const [oid, author, at, ...h] = l.split("\t"); return { oid, author, at, headline: h.join("\t") }; });
    return git(s.id, ["diff", "--no-color", "--no-ext-diff", mb, ...(head ? [head] : [])]);
  }

  // The picker for one side of the compare ("base" or "head"): local and remote branches, most recent first, filtered as you type.
  openBase(s, cx, side) {
    this.basePick = side;
    this.baseQ.set_value("");
    this.baseQ.focus();
    cx.spawn(async (cx) => {
      const out = await git(s.id, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(() => "");
      s.branches = out.split("\n").filter((b) => b && !b.endsWith("/HEAD") && b !== "origin"); // origin: origin/HEAD, shortened
      cx.notify();
    });
  }

  pickBase(s, b, cx) {
    const key = this.basePick === "head" ? "pr-review.heads" : "pr-review.bases";
    setShared(key, { ...shared(key), [s.id.repo]: b });
    this.closeBase();
    s.cursor = 0; s.level = "pr"; // picking a side shows that compare at once
    this.open(s, "local", cx, true);
  }

  closeBase() { this.basePick = false; this.unfocus(); }

  // The branches matching the picker's filter, the other side left out. The head side starts with this branch (null).
  bases(s) {
    const q = this.baseQ.value().trim().toLowerCase(), head = this.basePick === "head", here = s.branch ?? "";
    const other = head ? this.baseOf(s) : this.headOf(s) ?? here;
    const list = (s.branches ?? []).filter((b) => b !== other && !(head && b === here) && b.toLowerCase().includes(q));
    return head && here.toLowerCase().includes(q) ? [null, ...list] : list;
  }

  basePicker(t, s) {
    const cur = this.basePick === "head" ? this.headOf(s) : this.baseOf(s), list = this.bases(s).slice(0, 60);
    return v_flex().flex_none().border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().h(44).px(12).gap(8).items_center()
        .child(h_flex().flex_1().min_w(0).h(30).px(10).gap(8).items_center().rounded(8).bg(t.background).border_1().border_color(t.accent).on_mouse_down("left", field)
          .child(icon("git-branch").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.baseQ).id("base-input").flex_1().h_full().text_size(13)))
        .child(this.iconBtn("base-close", "x", "Close  Esc", () => this.closeBase())))
      .child(v_flex().id("base-list").max_h(240).overflow_y_scrollbar().pb(6)
        .children(list.map((b) => h_flex().id(`base-${b ?? "here"}`).h(28).px(16).gap(8).items_center().cursor_pointer().text_size(12)
          .text_color(b === cur ? t.accent : t.foreground).hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { this.pickBase(s, b, cx); cx.notify(); })
          .child(div().min_w(0).truncate().child(b ?? `${s.branch} (with uncommitted)`))))
        .when(!list.length, (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.muted).child(s.branches ? "No branch matches." : "Loading branches…"))));
  }

  // One side of the compare as the rail's first row shows it ("head" or "base"): its branch with a ▾, which opens the
  // picker under the row. The sidebar is the one place to pick either side.
  sideChip(t, s, side) {
    const on = this.basePick === side, head = side === "head";
    return h_flex().id(`${side}-chip`).min_w(0).h(20).px(4).gap(4).items_center().rounded(5).cursor_pointer()
      .when(on, (el) => el.bg(t.raised)).hover((x) => x.bg(t.raised))
      .tooltip(head ? "Pick the branch whose changes to show" : "Pick the branch to compare with")
      .on_mouse_down("left", field)
      .on_click((_e, cx) => { cx.stop_propagation(); if (on) this.closeBase(); else this.openBase(s, cx, side); cx.notify(); })
      .child(div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(head ? this.headOf(s) ?? s.branch ?? "this branch" : this.baseOf(s)))
      .child(icon("chevron-down").size(11).flex_none().text_color(on ? t.foreground : t.dim));
  }

  // A diff in place: it stays on the same file, wherever that now sits. `at` (the head it's from) comes with the next comments.
  applyDiff(d, text) {
    const keep = d.files?.[d.fi]?.path, hx = new Map(d.files?.map((f) => [f.path, f.hx])); // the file shown and the sideways scrolls stay
    d.text = text;
    d.files = parseDiff(text);
    for (const f of d.files) f.hx = hx.get(f.path);
    d.order = fileTree(d.files).filter((r) => !r.dir).map((r) => r.fi); // the tree's (and the arrows') file order
    const at = d.files.findIndex((f) => f.path === keep);
    Object.assign(d, { fi: at >= 0 ? at : d.order[0] ?? 0, error: null, at: null });
  }

  // Narrow the entry to one commit's own changes (oid), or back to all of them (null). Comments stay on all changes:
  // their lines are the whole PR's. A file shown stays shown when the commit touches it.
  pickCommit(s, d, oid, cx) {
    if (d.loading) return; // the whole diff first: it's what "All changes" goes back to
    d.pane = null;
    s.sel = null;
    if (oid === d.commit) return;
    const keep = d.files?.[d.fi]?.path, show = (v) => { const at = v.files.findIndex((f) => f.path === keep); Object.assign(d, v, { fi: at >= 0 ? at : v.order[0] ?? 0 }); s.scroll[s.entry] = 0; };
    d.full ??= { files: d.files, order: d.order };
    d.commit = oid;
    if (!oid) { show(d.full); d.full = null; return; }
    const had = d.byCommit?.get(oid);
    if (had) return show(had);
    d.commitLoading = true;
    cx.spawn(async (cx) => {
      try {
        const files = parseDiff(s.entry === "local" ? await git(s.id, ["show", "--format=", "--no-color", "--no-ext-diff", "--diff-merges=first-parent", oid]) : await s.api.commitDiff(s.id, s.info.nwo, oid));
        const v = { files, order: fileTree(files).filter((r) => !r.dir).map((r) => r.fi) };
        (d.byCommit ??= new Map()).set(oid, v);
        if (d.commit === oid) show(v);
        d.commitError = null;
      } catch (e) { d.commitError = e.message; }
      d.commitLoading = false;
      cx.notify();
    });
  }

  async fetchThreads(s, n) {
    const d = s.diffs.get(n), seq = (d.tseq = (d.tseq ?? 0) + 1);
    try {
      const r = await s.api.threads(s.id, s.info.nwo, n);
      if (seq !== d.tseq) return; // a later fetch (after a reply or resolve) got there first
      Object.assign(d, { headOid: r.headOid, threads: r.threads, talk: r.talk, threadsError: null });
      d.at ??= r.headOid; // the head the diff shown was taken at (near enough), for its hidden lines
    } catch (e) { d.threadsError = e.message; }
  }

  loadThreads(s, n, cx) { cx.spawn(async (cx) => { await this.fetchThreads(s, n); cx.notify(); }); }

  refresh(cx) {
    const s = this.cur;
    if (!s?.id) return;
    if (!s.info) { s.error = null; this.loadRepo(s, cx); return; }
    this.loadPRs(s, cx);
    if (s.entry != null) this.open(s, s.entry, cx, true);
  }

  // ---- writes: never retried, errors stay inline ----

  // Another repo shows: what's half-written here (the comment and conversation boxes, tags, a reply or edit) waits
  // on this repo, its line selection too (s.sel), and comes back with it. No handle.focus(): the keyboard went
  // wherever you clicked.
  leave() {
    const s = this.cur;
    if (!s?.id) return;
    s.parked = { composer: this.composer.value(), talk: this.talkBox.value(), tag: this.tag, talkTag: this.talkTag, draft: this.draft };
    this.draft = null;
    this.typing = this.basePick = false;
    this.tag = this.talkTag = this.talkError = this.composeError = this.confirm = null;
    this.composer.set_value("");
    this.talkBox.set_value("");
  }

  enter(s) {
    const p = s.parked;
    if (!p) return;
    s.parked = null;
    this.composer.set_value(p.composer);
    this.talkBox.set_value(p.talk);
    Object.assign(this, { tag: p.tag, talkTag: p.talkTag, draft: p.draft });
  }

  // Everything half-written or pending about the shown PR, dropped when another PR shows.
  dropWork(s = this.cur) {
    this.unfocus();
    if (s) s.sel = null;
    this.tag = this.talkTag = this.talkError = this.composeError = this.confirm = null;
    this.basePick = false;
    this.dropDraft();
    this.composer.set_value("");
    this.talkBox.set_value("");
    if (this.actError?.thread === TALK.id) this.actError = null;
  }

  // A focused text box that goes away takes the keyboard with it: hand it back to the view.
  unfocus() { if (this.typing) { this.typing = false; this.handle.focus(); } }

  post(cx) {
    const s = this.cur, d = s?.diffs.get(s.entry), f = s?.sel && d?.files[s.sel.fi];
    const text = this.composer.value().trim();
    if (!f || !text || this.posting || !d.headOid) return;
    const where = commentPayload(f.path, selectRange(f.rows, s.sel.anchor, s.sel.focus), f.rows, f.oldPath);
    this.posting = true;
    this.composeError = null;
    cx.spawn(async (cx) => {
      try {
        await s.api.createComment(s.id, s.info.nwo, s.entry, { body: tagBody(this.tag, text), commit_id: d.at ?? d.headOid, ...where }); // the lines are the shown diff's
        this.composer.set_value("");
        this.tag = null;
        s.sel = null;
        this.unfocus();
        await this.fetchThreads(s, s.entry);
      } catch (e) { this.composeError = e.message; }
      this.posting = false;
      cx.notify();
    });
    cx.notify();
  }

  // One thread write: busy while it runs, then its error or the fresh threads.
  act(th, fn, cx, after) {
    const s = this.cur;
    if (this.busy) return;
    this.busy = th.id;
    this.actError = null;
    cx.spawn(async (cx) => {
      try { await fn(s.info.nwo); after?.(); await this.fetchThreads(s, s.entry); }
      catch (e) { this.actError = { thread: th.id, msg: e.message }; }
      this.busy = null;
      cx.notify();
    });
    cx.notify();
  }

  startDraft(kind, th, c) {
    this.dropDraft();
    const { tag, text } = kind === "edit" ? splitTag(c.body) : { tag: null, text: "" };
    const state = this.textarea(kind === "reply" ? "Reply" : "Edit comment", (cx) => this.saveDraft(cx), text);
    this.draft = { kind, thread: th.id, comment: c?.databaseId, state, tag };
    state.focus();
  }

  dropDraft() { this.draft?.state.release(); if (this.draft) this.unfocus(); this.draft = null; this.typing = false; }

  saveDraft(cx) {
    const dr = this.draft, s = this.cur;
    const text = dr?.state.value().trim();
    const body = text && tagBody(dr.tag, text);
    const th = body && (dr.thread === TALK.id ? TALK : s.diffs.get(s.entry).threads.find((x) => x.id === dr.thread));
    if (!th) return;
    this.act(th, (nwo) => (dr.kind === "reply" ? s.api.reply(s.id, nwo, s.entry, th.comments[0].databaseId, body, th.id) : s.api.editComment(s.id, nwo, dr.comment, body, th.where, s.entry)), cx,
      () => this.draft === dr && this.dropDraft());
  }

  // ---- input ----

  key(e, cx) {
    const s = this.cur?.info ? this.cur : null;
    const k = e.key;
    if (k === "f" && e.modifiers.platform && s && this.findable(s)) this.openFind(s);
    else if (k === "escape") {
      if (this.basePick) this.closeBase();
      else if (this.finding && (this.inFind || !this.typing)) this.closeFind();
      else if (this.draft) this.dropDraft();
      else if (this.confirm) this.confirm = null;
      else if (s?.sel) { s.sel = null; this.tag = null; this.unfocus(); }
      else if (s?.diffs.get(s.entry)?.pane) { s.diffs.get(s.entry).pane = null; this.unfocus(); }
      else if (this.narrow && s?.entry != null && (s.level ?? "list") !== "list") this.back(s);
      // Wide: back from a stacked diff to its tree, then out of the entry (the arrows walk the PR list again).
      else if (!this.narrow && s?.entry != null) { const d = s.diffs.get(s.entry); if (!this.side() && d?.view === "diff") d.view = "files"; else s.entry = null; }
      else if (!this.panel) return this.dismiss();
      else return run("tabs-plus.back"); // nothing left to step out of: back to the terminal
    } else if (this.typing) return;
    // The PR list's search, and ← / → over its Open / Closed / All only while ↑ / ↓ walk the list too (lib tabArrows).
    else if (k === "/" && !this.inSearch && s && this.listShows(s)) this.search.focus();
    else if (s && (e.keystroke === "left" || e.keystroke === "right") && tabArrows({ listShows: this.listShows(s), filesOpen: !!this.openFiles(s), inSearch: this.inSearch })) {
      const i = STATES.findIndex(([x]) => x === s.state);
      s.state = STATES[(i + (k === "right" ? 1 : STATES.length - 1)) % STATES.length][0];
      this.loadPRs(s, cx);
    }
    // [ / ]: the previous / next commit, from all changes (before the first) to the last.
    else if (s && (k === "[" || k === "]") && !e.modifiers.platform && !this.inSearch && s.diffs.get(s.entry)?.commits?.length) {
      const d = s.diffs.get(s.entry), cs = d.commits, j = cs.findIndex((c) => c.oid === d.commit) + (k === "]" ? 1 : -1);
      if (j < -1 || j >= cs.length) return;
      this.pickCommit(s, d, j < 0 ? null : cs[j].oid, cx);
    }
    else if (s && (k === "up" || k === "down") && !s.diffs.get(s.entry)?.pane) { // a pane over the files keeps them still
      const d = this.openFiles(s);
      if (d) this.stepFile(s, d, k === "down" ? 1 : -1);
      else {
        const n = 1 + (s.prs?.length ?? 0);
        s.cursor = (s.cursor + (k === "down" ? 1 : n - 1)) % n;
      }
    } else if (s && k === "enter" && !s.diffs.get(s.entry)?.pane) {
      const d = this.openFiles(s);
      if (d && (this.narrow ? s.level === "pr" : !this.side() && d.view !== "diff")) this.pickFile(s, d, d.fi);
      else if (d) return; // the file is already showing
      else {
        const entry = s.cursor === 0 ? "local" : s.prs?.[s.cursor - 1]?.number;
        if (entry != null) { this.open(s, entry, cx); s.level = "pr"; }
      }
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  listShows(s) { return this.narrow ? s.entry == null : this.railOpen || s.entry == null; }

  // ---- files ----

  // The open entry's diff state once it has files; up / down then walk its files, not the PR list.
  openFiles(s) {
    const d = s.entry != null && !(this.narrow && (s.level ?? "list") === "list") ? s.diffs.get(s.entry) : null;
    return d?.files?.length ? d : null;
  }

  // Room for the file tree beside a readable diff (rail 280 + tree 260 + diff ≥ 500).
  side() { return !this.narrow && (this.width ?? Infinity) - (this.railOpen ? 280 : 0) >= 760; }

  // Shows file fi's diff: where the tree stands alone (stacked, drill-down), that swaps it for the diff.
  pickFile(s, d, fi) {
    d.fi = fi;
    d.view = s.level = "diff";
    s.scroll[s.entry] = 0;
  }

  // The previous / next file in tree order: shown at once, or just highlighted while the tree stands alone.
  stepFile(s, d, by) {
    const o = d.order ?? [], i = Math.max(0, Math.min(o.indexOf(d.fi) + by, o.length - 1));
    if (o[i] === d.fi) return;
    d.fi = o[i];
    s.scroll[s.entry] = 0;
    this.treeScroll.scroll_to_item(fileTree(d.files).findIndex((r) => r.fi === d.fi));
  }

  // ---- find (⌘F): in the shown file, or across every file of the entry ----

  // The entry find works in: its conversation when that shows (files or not), else its files.
  findable(s) { const d = s.diffs.get(s.entry); return d?.pane === "talk" ? d : this.openFiles(s); }

  openFind(s) {
    const d = this.findable(s);
    if (d.pane === "commits") d.pane = null; // the bar sits over the diff
    if (d.pane !== "talk" && (this.narrow ? s.level !== "diff" : !this.side() && d.view !== "diff")) this.pickFile(s, d, d.fi);
    this.finding = true;
    this.findQ.focus();
    this.findQ.set_selected_range({ start: 0, end: this.findQ.value().length }); // as in a browser: type to replace
  }

  closeFind() { this.finding = false; this.findHit = null; this.typing = this.inFind = false; this.handle.focus(); }

  // The matches in scope (tree order; in the conversation, its comments), kept until the diff or the query changes.
  hits(d) {
    const q = this.finding ? this.findQ.value() : "";
    const talk = d?.pane === "talk" && d.talk, th = talk || (d?.commit ? null : d?.threads); // a commit's lines aren't the PR's: its comments stay on all changes
    if (!q || !(talk || d?.files)) return [];
    if (this.findMemo?.files !== d.files || this.findMemo.threads !== th || this.findMemo.q !== q) {
      const o = this.findHit, all = talk ? findTalk(talk, q) : findAll(d.files, q, d.order, th ?? []);
      this.findMemo = { files: d.files, threads: th, q, all };
      this.findHit = o && (all.find((h) => h.fi === o.fi && h.ri === o.ri && h.start === o.start && h.th === o.th && h.ci === o.ci && h.id === o.id) ?? null); // fresh threads keep your place
    }
    return talk || this.findEvery ? this.findMemo.all : this.findMemo.all.filter((h) => h.fi === d.fi);
  }

  // The next (1) or previous (-1) match, or (0) the first from the shown file on (also when the current one is
  // stale: another file, PR or refresh); its file opens, its line a third down.
  jump(by) {
    const s = this.cur, d = s?.info ? this.findable(s) : null, hs = d ? this.hits(d) : [], n = hs.length;
    if (!n) return void (this.findHit = null);
    const i = hs.indexOf(this.findHit);
    if (d.pane === "talk") { this.findHit = hs[i < 0 ? (by < 0 ? n - 1 : 0) : (i + by + n) % n]; return this.talkScroll.scroll_to_item(this.findHit.ti); }
    const rank = new Map(d.order.map((fi, k) => [fi, k])), p = rank.get(d.fi);
    const j = Math.max(0, hs.findIndex((x) => rank.get(x.fi) >= p));
    const h = (this.findHit = hs[by && i >= 0 && hs[i].fi === d.fi ? (i + by + n) % n : by < 0 ? (j - 1 + n) % n : j]);
    if (h.fi !== d.fi) { this.pickFile(s, d, h.fi); this.treeScroll.scroll_to_item(fileTree(d.files).findIndex((r) => r.fi === h.fi)); }
    if (h.th) this.expanded.add(h.th); // a resolved thread opens to show it
    const L = this.layout(s, d), at = L.items.findIndex((x) => (h.th ? x.k === "thread" && x.th.id === h.th : holds(x, h.ri)));
    s.scroll[s.entry] = L.tops[at] - (this.diffH ?? 600) / 3;
    // A match past the code column's edge scrolls sideways into view, a third in (render clamps).
    const f = d.files[h.fi], w = this.codeW ?? 680, hx = f.hx ?? 0;
    if (!h.th && (h.start * CH < hx || h.end * CH > hx + w)) f.hx = h.start * CH - w / 3;
    this.reveal = false;
  }

  findBar(t, d) {
    const hs = this.hits(d), q = this.findQ.value(), i = hs.indexOf(this.findHit), at = i >= 0 ? i + 1 : "–";
    const scope = (all, label) => h_flex().id(`find-${all ? "all" : "file"}`).h_full().px(8).items_center().rounded(5).text_size(12).cursor_pointer()
      .when(this.findEvery === all, (el) => el.bg(t.background).text_color(t.foreground).font_medium())
      .when(this.findEvery !== all, (el) => el.text_color(t.muted).hover((x) => x.text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (this.findEvery !== all) { this.findEvery = all; this.jump(0); } cx.notify(); })
      .child(label);
    return h_flex().h(44).flex_none().px(12).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).h(30).px(10).gap(8).items_center().rounded(8).bg(t.background).border_1().border_color(this.inFind ? t.accent : t.input).on_mouse_down("left", field)
        .child(icon("search").size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.findQ).id("find-input").flex_1().h_full().text_size(13))
        .when(Boolean(q), (el) => el.child(div().flex_none().text_size(11).text_color(hs.length ? t.dim : t.blocked).child(hs.length ? `${at} of ${hs.length}` : "No results"))))
      .when(d.pane !== "talk", (el) => el.child(h_flex().h(28).p(2).gap(2).flex_none().rounded(7).bg(t.raised)
        .child(scope(true, this.narrow ? "All" : "All files")).child(scope(false, this.narrow ? "File" : "This file"))))
      .child(this.iconBtn("find-prev", "chevron-up", "Previous match  ⇧↵", () => this.jump(-1)))
      .child(this.iconBtn("find-next", "chevron-down", "Next match  ↵", () => this.jump(1)))
      .child(this.iconBtn("find-close", "x", "Close  Esc", () => this.closeFind()));
  }

  // A line with its matches marked; the current one solid.
  marked(t, text, ms) {
    return h_flex().children([...ms.flatMap((m, i) => {
      const on = m === this.findHit;
      return [div().child(text.slice(ms[i - 1]?.end ?? 0, m.start)), div().rounded(2).bg(on ? t.accent : tint(t.accent, "4d")).when(on, (el) => el.text_color(t.accent_foreground)).child(text.slice(m.start, m.end))];
    }), div().child(text.slice(ms.at(-1).end))]);
  }

  mouseUp(cx) {
    this.bar = null;
    if (this.rs) { this.rs = null; setShared("pr-review.wsize", [this.W, this.H]); cx.notify(); }
    if (!this.dragging) return;
    this.dragging = false;
    this.reveal = true; // the comment box docks under the diff: keep the selection's last line above it
    if (this.cur?.sel && this.cur.entry !== "local" && !this.cur.diffs.get(this.cur.entry)?.commit) this.composer.focus();
    cx.notify();
  }

  barMove(e, cx) {
    const s = this.cur, b = this.bar;
    if (!b || s?.entry !== b.entry) return;
    if (b.f) b.f.hx = b.from + ((e.position.x - b.x) / this.zoom) * b.k; // the sideways bar; render clamps both
    else s.scroll[s.entry] = b.scroll + ((e.position.y - b.y) / this.zoom) * b.k;
    cx.notify();
  }

  // The window's right and bottom edges: a press records where it started; moves (see render's halo) grow or
  // shrink it. ax / ay: 1 when that edge moves. Herdr can't place a window, so the left and top edges stay put.
  grip(id, ax, ay, place) {
    return place(div().id(id).absolute())[ax && ay ? "cursor_nwse_resize" : ax ? "cursor_ew_resize" : "cursor_ns_resize"]()
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.handle.focus(); this.rs = { x: e.position.x, y: e.position.y, w: this.W, h: this.H, ax, ay }; cx.notify(); });
  }

  resizeMove(e, cx) {
    const r = this.rs;
    if (!r) return;
    if (r.ax) this.W = Math.max(640, Math.round(r.w + (r.ax * (e.position.x - r.x)) / this.zoom));
    if (r.ay) this.H = Math.max(420, Math.round(r.h + (r.ay * (e.position.y - r.y)) / this.zoom));
    cx.notify();
  }

  // ---- render ----

  render(cx) {
    if (this.handoff) return div();
    if (this.shown()) {
      // Shown again after a while: re-resolve the target and poll it once.
      if (this.stale && !this.yields()) { this.stale = false; this.wantKey = null; this.repoll = true; }
      this.syncTarget(cx);
      // Opened (⌘⇧R, the tab bar; tabs-plus says so): the keys are its own at once, after this frame puts it in the tree.
      const o = shared("emergence.opened");
      if (o?.id === BLOCK && o.at !== this.openedAt && Date.now() - o.at < 3000) { this.openedAt = o.at; cx.timer.after(50, () => this.handle.focus()); }
      const back = this.panel && shared("emergence.back"); // a panel's window or popup closed: the keyboard comes back
      if (back && back !== this.backAt) { this.backAt = back; if (Date.now() - back < 3000) cx.timer.after(80, () => this.handle.focus()); }
      if (this.panel) { this.comeBack(cx, this.held); this.held = this.handle.is_focused(); }
    } else this.stale = true;
    const t = theme();
    const s = this.cur;
    const ready = Boolean(s?.info);
    this.zoom = settings().zoom ?? 1;
    if (!this.panel) this.width = this.W;
    this.narrow = this.panel && (this.width ?? NARROW) < NARROW;
    const view = this.narrow && ready ? (s.entry == null ? "list" : s.level ?? "list") : null;
    // The body first: it reads the scroll the diff clamps.
    const body = !ready ? this.empty(t, s)
      : view === "list" ? this.rail(t, s, true)
      : view === "pr" ? this.detail(t, s)
      : view === "diff" ? this.main(t, s, true)
      : [this.railOpen || s.entry == null ? this.rail(t, s) : null, this.main(t, s)].filter(Boolean);
    const ui = v_flex().id("pr-review").track_focus(this.handle).min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .rounded(10).overflow_hidden().border_1().border_color(t.border)
      .when(this.panel, (el) => el.size_full()
        .on_size_change((size, cx) => { const w = size.width / this.zoom; if (Math.abs(w - (this.width ?? 0)) > 0.5) { this.width = w; cx.notify(); } }))
      .when(!this.panel, (el) => el.relative().w(this.W).h(this.H).shadow_lg())
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_up("left", (_e, cx) => this.mouseUp(cx))
      .on_mouse_move((e, cx) => this.barMove(e, cx))
      .child(this.header(t, s, view))
      // The window drags by any press nobody stops: only the header bar drags it. A press here gives the view the
      // keyboard (a layout panel doesn't get it by being clicked); text boxes stop their own presses first.
      .child(h_flex().flex_1().min_h(0).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); }).children([body].flat()))
      // ponytail: Herdr drags both ways, so a slanted left or top drag also nudges the window along the other axis.
      .when(!this.panel, (el) => el
        .child(this.grip("grip-r", 1, 0, (g) => g.top(14).bottom(14).right(0).w(4)))
        .child(this.grip("grip-b", 0, 1, (g) => g.left(14).right(14).bottom(0).h(4)))
        .child(this.grip("grip-rb", 1, 1, (g) => g.right(0).bottom(0).size(14))));
    if (this.panel) return ui;
    // Herdr windows are as big as their content and don't resize themselves. While an edge is held, a
    // transparent halo (frame "none") grows the window to the screen's edges so the pointer stays on it.
    // ponytail: a release outside Herdr is missed; the next press anywhere ends the resize instead.
    return div().when(Boolean(this.rs), (el) => el.pr(4000).pb(4000).cursor_nwse_resize()
      .on_mouse_move((e, cx) => this.resizeMove(e, cx))
      .on_mouse_up("left", (_e, cx) => this.mouseUp(cx))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.mouseUp(cx); }))
      .child(ui);
  }

  iconBtn(id, name, tip, onClick, spin) {
    const t = theme();
    return h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(spin ? icon("spinner").size(14).spin(900) : icon(name).size(15));
  }

  header(t, s, view) {
    const btn = (...a) => this.iconBtn(...a);
    const busy = Boolean(s?.loading || s?.prsLoading || s?.diffs?.get(s.entry)?.loading);
    const where = (el) => el
      .when(Boolean(s?.branch), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(s.branch)))
      .when(Boolean(s?.id?.machine), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`on ${s.id.machine}`)));
    const refresh = btn("pr-refresh", "refresh", "Refresh", (cx) => this.refresh(cx), busy);
    if (this.panel) {
      const back = view === "pr" || view === "diff";
      return h_flex().h(42).flex_none().pl(back ? 8 : 14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .when(back, (el) => el.child(btn("pr-back", "chevron-left", "Back", () => this.back(s)))
          .child(div().min_w(0).truncate().font_semibold().child(view === "diff" ? s.diffs.get(s.entry)?.files?.[s.diffs.get(s.entry).fi]?.path.split("/").pop() ?? "Changes" : this.entryInfo(s).title)))
        .when(!back, (el) => where(el.child(div().flex_none().font_semibold().child(s?.id ? s.name : "Pull requests"))))
        .child(div().flex_1())
        .child(refresh)
        .child(btn("pr-widen", this.wideFrom ? "chevrons-right" : "chevrons-left", this.wideFrom ? "Back to the panel" : "Full size, beside the agent", () => this.widen()))
        .child(btn("pr-expand", "maximize-2", "Open in window", () => this.popOut()));
    }
    return where(h_flex().h(40).flex_none().pl(16).pr(6).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .child(icon("git-compare").size(15).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(15).font_semibold().child(s?.id ? s.name : "Pull requests")))
      .child(div().flex_1())
      .child(refresh)
      .child(btn("pr-close", "x", "Close · Esc", () => this.dismiss()));
  }

  quiet(t, text, action) {
    return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().gap(12)
      .child(div().px(16).text_center().text_size(13).text_color(t.muted).child(text))
      .when(Boolean(action), (el) => el.child(action));
  }

  empty(t, s) {
    if (!s) return this.quiet(t, "Focus a terminal in a git repository to see its pull requests.");
    if (s.none || s.loading) return this.quiet(t, s.none ?? "Loading repository…");
    return this.quiet(t, s.error, this.button(t, "pr-retry", "Try again", (cx) => this.refresh(cx)));
  }

  button(t, id, label, onClick, primary, disabled) {
    return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).text_size(12)
      .when(primary, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_medium())
      .when(!primary, (el) => el.border_1().border_color(t.input).hover((x) => x.bg(t.hover)))
      .when(disabled, (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .child(label);
  }

  link(t, id, label, onClick, color) {
    return div().id(id).text_size(12).text_color(color ?? t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  }

  chip(t, label, color) {
    return h_flex().h(20).px(8).flex_none().items_center().rounded(6).text_size(11).bg(tint(color, "1f")).text_color(color).child(label);
  }

  stateChip(t, p) {
    if (p.isDraft && p.state === "OPEN") return this.chip(t, "Draft", t.idle);
    return this.chip(t, { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed" }[p.state] ?? p.state, { OPEN: t.working, MERGED: t.done }[p.state] ?? t.idle);
  }

  counts(t, add, del) {
    if (add == null) return div(); // GitLab's MR list has no line counts
    return h_flex().gap(6).flex_none().text_size(11)
      .child(div().text_color(t.done).child(`+${add}`))
      .child(div().text_color(t.blocked).child(`−${del}`));
  }

  // ---- left rail ----

  // full: the whole panel (drill-down list) instead of the 280px rail.
  rail(t, s, full) {
    const prs = s.prs ?? [];
    const row = (i, active, entry, content) => h_flex().id(`rail-${i}`).h(52).flex_none().mx(8).px(12).gap(10).items_center().rounded(8).cursor_pointer()
      .when(active, (el) => el.bg(t.selected)).when(!active && s.cursor === i, (el) => el.bg(t.hover))
      .hover((x) => x.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => { s.cursor = i; s.level = "pr"; this.open(s, entry, cx); cx.notify(); })
      .child(content);
    const empty = s.prsError ?? (s.prs == null ? "Loading pull requests…" : prs.length ? null
      : s.search.trim() ? `No pull requests match “${s.search.trim()}”.` : `No ${s.state === "all" ? "" : s.state + " "}pull requests.`);
    // Two kinds of comparison, each under its own header: the branches you pick, and the PRs, each bringing its own
    // pair (its branch → the one it merges into). Search and Open · Closed · All filter the PRs only.
    const section = (label) => div().px(20).pt(12).pb(6).flex_none().text_size(11.5).font_medium().text_color(t.dim).child(label);
    return v_flex().h_full()
      .when(full, (el) => el.flex_1().min_w(0))
      .when(!full, (el) => el.w(280).flex_none().bg(t.surface).border_r(1).border_color(t.border))
      .child(section("Compare two branches"))
      // Click the row to show the compare, a side's ▾ to pick that branch (the picker opens right under).
      .child(row(0, s.entry === "local", "local", h_flex().flex_1().min_w(0).gap(10).items_center()
        .child(icon("git-branch").size(14).flex_none().text_color(t.muted))
        // One line, as a PR row's "head → base": the head shortens first, "vs base ▾" stays whole. Under it, what it covers.
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(2).items_center()
            .child(this.sideChip(t, s, "head"))
            .child(div().flex_none().px(2).text_size(11).text_color(t.dim).child("vs"))
            .child(div().flex_none().child(this.sideChip(t, s, "base"))))
          .child(div().px(4).truncate().text_size(11).text_color(t.dim)
            .child(this.headOf(s) ? "Committed changes only" : "Includes uncommitted changes")))))
      .when(Boolean(this.basePick), (el) => el.child(div().mx(8).mt(4).flex_none().rounded(8).overflow_hidden().border_1().border_color(t.border).child(this.basePicker(t, s))))
      .child(div().h(1).flex_none().mx(20).mt(12).bg(t.border))
      .child(section("Pull requests"))
      .child(v_flex().px(12).pb(8).gap(8).flex_none()
        .child(h_flex().h(32).px(10).gap(8).items_center().rounded(8).bg(t.background).border_1().border_color(this.inSearch ? t.accent : t.input).on_mouse_down("left", field)
          .child(icon("search").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).id("pr-search").flex_1().h_full().text_size(13)))
        .child(h_flex().h(28).p(2).gap(2).rounded(8).bg(t.raised)
          .children(STATES.map(([k, label]) => h_flex().id(`st-${k}`).flex_1().h_full().items_center().justify_center().rounded(6).text_size(12).cursor_pointer()
            .when(s.state === k, (el) => el.bg(t.background).text_color(t.foreground).font_medium())
            .when(s.state !== k, (el) => el.text_color(t.muted).hover((x) => x.text_color(t.foreground)))
            .on_click((_e, cx) => { if (s.state !== k) { s.state = k; this.loadPRs(s, cx); } cx.notify(); })
            .child(label)))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        // Each PR says what it compares: its branch → the one it merges into (set by the PR, not by the picks above).
        // Line 2 keeps "→ base" whole: the PR's own branch shortens first. Counts are in the PR's header once open.
        .children(prs.map((p, i) => row(i + 1, s.entry === p.number, p.number, v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().child(p.title))
            .child(this.stateChip(t, p)))
          .child(h_flex().id(`pr-pair-${p.number}`).gap(4).items_center().text_size(11).text_color(t.dim)
            .tooltip(`${p.headRefName ?? "?"} → ${p.baseRefName ?? "?"}${p.author?.login ? ` · by ${p.author.login}` : ""}`)
            .child(div().flex_none().child(`#${p.number} ·`))
            .child(div().min_w(0).truncate().child(p.headRefName ?? "?"))
            .child(div().flex_none().child(`→ ${p.baseRefName ?? "?"}`))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11).child(ago(p.updatedAt)))))))
        .when(Boolean(empty), (el) => el.child(div().px(20).py(8).text_center().text_size(13).text_color(t.muted).child(empty))));
  }

  // ---- main: entry header, files, diff ----

  // The selected entry's diff state, PR, files, title and branch line.
  entryInfo(s) {
    const d = s.diffs.get(s.entry);
    const local = s.entry === "local";
    const pr = local ? null : s.prs?.find((p) => p.number === s.entry) ?? d.pr;
    const base = local ? this.baseOf(s) : pr?.baseRefName ?? s.info.defaultBranch, head = local && this.headOf(s);
    return {
      d, local, pr, files: d.files ?? [],
      title: pr?.title ?? (local ? this.compareTitle(s) : "Pull request"),
      sub: pr ? `${pr.headRefName} → ${base}` : head ? `${head} · since merge-base with ${base}` : local ? `${s.branch} · since merge-base with ${base} · includes uncommitted` : "",
      quiet: d.loading && !d.files ? "Loading diff…" : d.error ?? (d.files?.length ? null : "No changes."),
    };
  }

  threadsBanner(t, d) {
    return div().px(16).py(8).text_size(12).text_color(t.blocked).border_b(1).border_color(t.border).child(`Comments unavailable: ${d.threadsError}`);
  }

  // bare: the drill-down's diff level, without the entry header and file tree.
  // With room the tree sits beside the diff; without, it stands alone until a file is picked.
  main(t, s, bare) {
    // Centred on the whole panel, not just the room beside the 280px list (+1 border) that's always shown here.
    if (s.entry == null) return this.quiet(t, "Select a pull request, or this branch, to see its changes.").pr(281);
    const { d, local, pr, files, title, sub, quiet } = this.entryInfo(s);
    const side = !bare && this.side();
    const treeOn = side ? this.filesOpen : !bare && d.view !== "diff";
    const head = bare ? null : h_flex().h(56).flex_none().pl(8).pr(16).gap(12).items_center().border_b(1).border_color(t.border)
      .child(this.iconBtn("rail-toggle", this.railOpen ? "panel-left-close" : "panel-left-open", this.railOpen ? "Hide pull requests" : "Show pull requests", () => (this.railOpen = !this.railOpen)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(8).items_center()
          .when(!local, (el) => el.child(div().flex_none().text_size(13).text_color(t.dim).child(`#${s.entry}`)))
          .child(div().min_w(0).truncate().text_size(15).font_semibold().child(title))
          .when(Boolean(pr), (el) => el.child(this.stateChip(t, pr))))
        .child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(sub))
          .when(Boolean(pr), (el) => el.child(div().flex_none().child(`${pr.author?.login ?? ""} · ${ago(pr.updatedAt)}`)))))
      .when(files.length > 0, (el) => el
        .child(this.counts(t, files.reduce((a, f) => a + f.additions, 0), files.reduce((a, f) => a + f.deletions, 0)))
        .child(h_flex().id("files-toggle").h(28).px(8).gap(4).items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(treeOn ? "Hide the file tree" : "Show the file tree")
          .on_click((_e, cx) => { if (side) this.filesOpen = !treeOn; else d.view = treeOn ? "diff" : "files"; cx.notify(); })
          .child(icon(treeOn ? "chevron-down" : "chevron-right").size(14))
          .child(`${files.length} file${files.length === 1 ? "" : "s"}`)))
      .when(Boolean(d.talk), (el) => el.child(this.paneToggle(t, d, "talk")))
      .when(d.commits?.length > 0, (el) => el.child(this.paneToggle(t, d, "commits")));
    const top = v_flex().flex_1().min_w(0).h_full().when(!bare, (el) => el.child(head))
      .when(Boolean(d.commit), (el) => el.child(this.commitBar(t, s, d)));
    if (d.pane) return top.child(this.paneView(t, s, d));
    if (quiet) return top.child(this.quiet(t, quiet));
    if (treeOn && !side) return top.when(Boolean(d.threadsError), (el) => el.child(this.threadsBanner(t, d))).child(this.treeColumn(t, s, d, true));
    const L = this.layout(s, d);
    return top.when(Boolean(d.threadsError), (el) => el.child(this.threadsBanner(t, d)))
      .child(h_flex().flex_1().min_h(0)
        .when(side && treeOn, (el) => el.child(this.treeColumn(t, s, d, false)))
        .child(v_flex().flex_1().min_w(0).h_full().child(this.fileHead(t, s, d)).when(Boolean(this.finding), (el) => el.child(this.findBar(t, d))).child(this.diff(t, s, d, L))
          .when(Boolean(L.range) && !this.dragging && !d.commit, (el) => el.child(this.composerCard(t, s, d, L.range)))));
  }

  // The header's Conversation and Commits buttons: each swaps the changes for its list, and back.
  paneToggle(t, d, pane) {
    const talk = pane === "talk", n = talk ? d.talk.length - 1 : d.commits.length, on = d.pane === pane;
    return h_flex().id(`${pane}-toggle`).h(28).px(8).gap(5).items_center().rounded(6).cursor_pointer().text_size(12)
      .when(on, (x) => x.bg(t.selected)).text_color(on || (!talk && d.commit) ? t.foreground : t.muted)
      .hover((x) => x.bg(t.hover).text_color(t.foreground))
      .tooltip(on ? "Back to the changes" : talk ? "The conversation: the description, comments on the PR and reviews" : "Commit history: review one commit at a time")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { d.pane = on ? null : pane; if (talk && !on) this.talkScroll.scroll_to_item(d.talk.length - 1); cx.notify(); })
      .child(icon(talk ? "message" : "git-commit").size(14)).child(`${n} ${talk ? "comment" : "commit"}${n === 1 ? "" : "s"}`);
  }

  paneView(t, s, d) { return d.pane === "talk" ? this.talkView(t, s, d) : this.commitList(t, s, d); }

  // The conversation, oldest first (the description, comments on the PR, reviews with a verdict or a note), then a
  // box to comment on the PR. It refreshes with the comments, every 5 s.
  talkView(t, s, d) {
    const VERDICT = { APPROVED: ["Approved", t.done], CHANGES_REQUESTED: ["Changes requested", t.blocked], DISMISSED: ["Dismissed", t.idle], COMMENTED: ["Reviewed", t.idle] };
    const hits = new Set(this.hits(d).map((h) => h.ti)), dr = this.draft?.thread === TALK.id ? this.draft : null;
    const card = (c, ti) => {
      const editing = dr?.kind === "edit" && dr.comment === c.databaseId, { tag, text } = splitTag(c.body);
      return v_flex().flex_none().gap(6).px(16).py(12).border_b(1).border_color(t.border)
        .when(hits.has(ti), (el) => el.bg(tint(t.accent, this.findHit?.ti === ti ? "33" : "14")))
        .child(this.commentActs(t, h_flex().gap(8).items_center()
          .child(div().text_size(13).font_semibold().text_color(t.accent).child(c.author ?? "ghost"))
          .when(c.kind === "body", (el) => el.child(div().text_size(12).text_color(t.muted).child("opened this")))
          .when(c.kind === "review", (el) => el.child(this.chip(t, ...(VERDICT[c.state] ?? [c.state, t.idle]))))
          .when(Boolean(tag) && !editing, (el) => { const [, label, , ink] = TAGS.find(([k]) => k === tag); return el.child(this.chip(t, label, t[ink])); })
          .child(div().text_size(11).text_color(t.dim).child(ago(c.at)))
          .child(div().flex_1()), s, TALK, c, editing))
        .child(editing ? this.editBox(t, dr)
          : text.trim() ? TextView.markdown(`talk-${c.id}`, mentions(text)).selectable(true).scrollable(false).w_full().text_size(13).text_color(t.foreground)
          : div().text_size(12).text_color(t.dim).child(c.kind === "body" ? "No description." : "No note."));
    };
    const err = this.talkError ?? (this.actError?.thread === TALK.id ? this.actError.msg : null);
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.finding), (el) => el.child(this.findBar(t, d)))
      .child(v_flex().id("talk").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.talkScroll).children(d.talk.map(card)))
      .child(v_flex().flex_none().p(12).gap(8).border_t(1).border_color(t.border)
        .child(this.tagRow(t, "talk", this.talkTag, (k) => (this.talkTag = k)))
        .child(div().rounded(6).bg(t.background).border_1().border_color(t.input).px(8).py(6).on_mouse_down("left", field).child(Textarea.new(this.talkBox).id("talk-box").h(56).w_full().text_size(13)))
        .when(Boolean(err), (el) => el.child(div().text_size(12).text_color(t.blocked).child(err)))
        .child(h_flex().justify_end().child(this.button(t, "talk-post", this.talkPosting ? "Posting…" : "Comment  ⌘↵", (cx) => this.postTalk(cx), true, this.talkPosting))));
  }

  postTalk(cx) {
    const s = this.cur, n = s?.entry, text = this.talkBox.value().trim();
    if (!text || this.talkPosting || typeof n !== "number") return;
    this.talkPosting = true;
    this.talkError = null;
    cx.spawn(async (cx) => {
      try {
        await s.api.postComment(s.id, s.info.nwo, n, tagBody(this.talkTag, text));
        this.talkBox.set_value("");
        this.talkTag = null;
        await this.fetchThreads(s, n);
        this.talkScroll.scroll_to_item(s.diffs.get(n).talk.length - 1);
      } catch (e) { this.talkError = e.message; }
      this.talkPosting = false;
      cx.notify();
    });
    cx.notify();
  }

  // The commits, oldest first, under "All changes"; one opens its own diff.
  commitList(t, s, d) {
    const cs = d.commits, w = String(cs.length).length;
    const row = (id, on, n, sha, title, meta, oid) => h_flex().id(id).h(40).flex_none().px(16).gap(12).items_center().cursor_pointer().border_b(1).border_color(t.border)
      .when(on, (x) => x.bg(t.selected)).when(!on, (x) => x.hover((h) => h.bg(t.hover)))
      .on_click((_e, cx) => { this.pickCommit(s, d, oid, cx); cx.notify(); })
      .child(div().w(8 + w * 8).flex_none().text_size(11).text_color(t.dim).child(n))
      .child(div().w(64).flex_none().text_size(11).text_color(on ? t.accent : t.dim).child(sha))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).when(on, (x) => x.font_medium()).child(title))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(meta));
    return v_flex().id("commits").flex_1().min_h(0).overflow_y_scrollbar()
      .child(row("commit-all", !d.commit, "", "", "All changes", `${cs.length} commit${cs.length === 1 ? "" : "s"}, with comments`, null))
      .children(cs.map((c, i) => row(`commit-${c.oid}`, d.commit === c.oid, String(i + 1), c.oid.slice(0, 7), c.headline, `${c.author} · ${ago(c.at)}`, c.oid)));
  }

  // Over a commit's diff: which one, the previous and next, and the way back to all changes.
  commitBar(t, s, d) {
    const cs = d.commits, i = cs.findIndex((c) => c.oid === d.commit), step = (by) => (cx) => this.pickCommit(s, d, cs[i + by].oid, cx);
    return h_flex().h(36).flex_none().pl(16).pr(8).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border).text_size(12)
      .child(icon("git-commit").size(14).flex_none().text_color(t.accent))
      .child(div().flex_none().text_color(t.muted).child(`Commit ${i + 1} of ${cs.length}`))
      .child(div().flex_none().text_size(11).text_color(t.accent).child(d.commit.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().text_color(d.commitError ? t.blocked : t.foreground)
        .child(d.commitError ? `Couldn't load it: ${d.commitError}` : d.commitLoading ? "Loading…" : cs[i]?.headline ?? ""))
      .when(i > 0, (el) => el.child(this.iconBtn("commit-prev", "chevron-left", "Previous commit  [", step(-1))))
      .when(i >= 0 && i < cs.length - 1, (el) => el.child(this.iconBtn("commit-next", "chevron-right", "Next commit  ]", step(1))))
      .child(h_flex().id("commit-all").h(26).px(8).items_center().rounded(6).cursor_pointer().text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .tooltip("The whole PR, with its comments").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.pickCommit(s, d, null, cx); cx.notify(); }).child("All changes"));
  }

  // Drill-down level 2: the entry's title and meta, then its file tree; a file opens its diff there.
  detail(t, s) {
    const { d, local, pr, files, title, sub, quiet } = this.entryInfo(s);
    return v_flex().flex_1().min_w(0).h_full()
      .child(v_flex().flex_none().px(16).py(12).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().child(title))
        .child(h_flex().flex_wrap().gap(8).items_center()
          .when(Boolean(pr), (el) => el.child(this.stateChip(t, pr)))
          .when(!local, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(`#${s.entry}`)))
          .when(Boolean(pr), (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child(`${pr.author?.login ?? ""} · ${ago(pr.updatedAt)}`)))
          .when(files.length > 0, (el) => el.child(this.counts(t, files.reduce((a, f) => a + f.additions, 0), files.reduce((a, f) => a + f.deletions, 0))))
          .when(Boolean(d.talk), (el) => el.child(this.paneToggle(t, d, "talk")))
          .when(d.commits?.length > 0, (el) => el.child(this.paneToggle(t, d, "commits"))))
        .child(div().text_size(11).text_color(t.dim).child(sub)))
      .when(Boolean(d.commit), (el) => el.child(this.commitBar(t, s, d)))
      .when(Boolean(d.threadsError), (el) => el.child(this.threadsBanner(t, d)))
      .when(Boolean(d.pane), (el) => el.child(this.paneView(t, s, d)))
      .when(!d.pane && Boolean(quiet), (el) => el.child(this.quiet(t, quiet)))
      .when(!d.pane && !quiet, (el) => el.child(div().px(16).pt(10).text_size(11).text_color(t.dim).child(`${files.length} file${files.length === 1 ? "" : "s"} changed`))
        .child(this.treeColumn(t, s, d, true)));
  }

  // The changed files as a folder tree with comment and +/- counts. full: the whole area, else a 260px column.
  treeColumn(t, s, d, full) {
    // Finding in all files: each file's match count, the rest dimmed.
    const hs = this.findEvery ? this.hits(d) : [], fc = hs.length ? hs.reduce((m, h) => m.set(h.fi, (m.get(h.fi) ?? 0) + 1), new Map()) : null;
    return v_flex().id("files").h_full().py(8).overflow_y_scrollbar().track_scroll(this.treeScroll)
      .when(full, (el) => el.flex_1().min_w(0).min_h(0)).when(!full, (el) => el.w(260).flex_none().border_r(1).border_color(t.border))
      .children(fileTree(d.files).map((r, i) => {
        const row = h_flex().id(`tree-${i}`).flex_none().mx(8).pl(8 + r.depth * 14).pr(8).gap(8).items_center().rounded(6);
        if (r.dir) return row.h(26).text_size(12).text_color(t.muted).child(icon("folder").size(13).flex_none().text_color(t.dim)).child(div().min_w(0).truncate().child(r.name));
        const f = d.files[r.fi], n = d.commit ? 0 : (d.threads ?? []).filter((x) => x.path === f.path).length, on = r.fi === d.fi;
        return row.h(30).cursor_pointer().tooltip(f.path)
          .when(on, (el) => el.bg(t.selected)).hover((x) => x.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => { this.pickFile(s, d, r.fi); cx.notify(); })
          .child(icon("file").size(13).flex_none().text_color({ added: t.done, deleted: t.blocked }[f.status] ?? t.dim))
          .child(div().flex_1().min_w(0).truncate().when(f.status === "deleted", (el) => el.text_color(t.muted)).child(r.name))
          .when(n > 0, (el) => el.child(h_flex().gap(4).items_center().flex_none().text_size(11).text_color(t.muted).child(icon("message").size(12)).child(String(n))))
          .when(f.additions + f.deletions > 0, (el) => el.child(this.counts(t, f.additions, f.deletions)))
          .when(Boolean(fc), (el) => (fc.has(r.fi) ? el.child(div().flex_none().px(5).rounded(4).bg(tint(t.accent, "26")).text_size(11).text_color(t.accent).child(String(fc.get(r.fi)))) : el.opacity(0.4)));
      }));
  }

  // The shown file's diff items with their heights: rows, notes, thread cards; and the selected range.
  layout(s, d) {
    const items = [], tops = [], fi = d.fi, f = d.files[fi];
    let y = 0;
    const push = (it) => { items.push(it); tops.push(y); y += it.h; };
    const card = (th) => {
      const open = !th.isResolved || this.expanded.has(th.id);
      const measure = `th-${th.id}-${open}`;
      push({ k: "thread", key: `th-${th.id}`, th, measure, h: this.heights.get(measure) ?? (open ? H.thread : H.resolved) });
    };
    const { at, loose } = anchorThreads(f.rows, d.commit ? [] : (d.threads ?? []).filter((x) => x.path === f.path));
    const note = f.binary ? "Binary file not shown." : f.rows.length ? null
      : { deleted: "Empty file deleted.", renamed: "Renamed without changes.", added: "Empty file added." }[f.status] ?? "No text changes.";
    if (note) push({ k: "note", key: `note-${fi}`, text: note, h: H.note });
    loose.forEach(card);
    const range = s.sel?.fi === fi ? selectRange(f.rows, s.sel.anchor, s.sel.focus) : null;
    const on = (ri) => ri != null && Boolean(range) && ri >= range.from && ri <= range.to;
    if (this.splitOn()) for (const p of pairRows(f.rows)) {
      // Side by side: a pair per line (context on both sides), hunk headers across; cards under the pair.
      if (p.hunk != null) push({ k: "row", key: `r-${fi}-${p.hunk}`, fi, ri: p.hunk, row: f.rows[p.hunk], h: H.hunk });
      else push({ k: "pair", key: `p-${fi}-${p.l}-${p.r}`, fi, l: p.l, r: p.r, onL: on(p.l), onR: on(p.r), h: H.row });
      new Set([p.hunk ?? p.l, p.r]).forEach((ri) => ri != null && (at.get(ri) ?? []).forEach(card));
    }
    else f.rows.forEach((row, ri) => {
      push({ k: "row", key: `r-${fi}-${ri}`, fi, ri, row, on: on(ri), h: row.kind === "hunk" ? H.hunk : H.row });
      (at.get(ri) ?? []).forEach(card);
    });
    if (this.tailLeft(f)) push({ k: "tail", key: `tail-${fi}`, h: H.hunk });
    return { items, tops, heights: items.map((x) => x.h), total: y + 24, range };
  }

  // ---- the unchanged lines a diff leaves out ----

  // The new side has them: added files are whole already, deleted ones have none.
  canExpand(f) { return !f.binary && f.rows.length > 0 && f.status !== "added" && f.status !== "deleted"; }
  gapAt(f, at) { const g = gapBefore(f.rows, at); return g.to == null ? (f.lines ? f.lines.length - g.from + 1 : Infinity) : g.to - g.from + 1; }
  tailLeft(f) { return this.canExpand(f) && this.gapAt(f, f.rows.length) > 0; }

  // Splices them in as context rows above hunks (ats: their row indices) and/or after the last (f.rows.length), from
  // the new side's file: the PR's head, the commit shown, or this branch's working tree. Fetched once per file.
  expand(s, d, f, ats, cx) {
    if (f.expanding) return; // one at a time: a second splice at the same index would land on the first's rows
    f.expanding = true;
    cx.spawn(async (cx) => {
      try {
        if (!f.lines) {
          let text;
          if (s.entry !== "local") text = await s.api.fileAt(s.id, s.info.nwo, f.path, d.commit ?? d.at ?? d.headOid ?? d.pr?.headRefName);
          else if (d.commit || this.headOf(s)) text = await git(s.id, ["show", `${d.commit ?? this.headOf(s)}:${f.path}`]);
          else { const r = await exec("cat", [f.path], { cwd: s.id.repo, on: s.id.machine }); if (r.code !== 0) throw new Error(r.stderr.trim() || "can't read it"); text = r.stdout; }
          f.lines = text.replace(/\n$/, "").split("\n");
        }
        for (const at of [...ats].sort((a, b) => b - a)) f.rows.splice(at, 0, ...hiddenRows(f.rows, f.lines, at));
        f.expandError = null;
        s.sel = null; this.findMemo = this.findHit = null; // row indices moved
      } catch (e) { f.expandError = e.message; }
      f.expanding = false;
      cx.notify();
    });
  }

  expandAll(s, d, f, cx) {
    this.expand(s, d, f, [...f.rows.map((r, i) => (r.kind === "hunk" && this.gapAt(f, i) > 0 ? i : -1)).filter((i) => i >= 0), ...(this.tailLeft(f) ? [f.rows.length] : [])], cx);
  }

  // A hunk header, or the file's end, that opens the lines hidden there.
  gapRow(t, s, d, f, it, at, label) {
    const n = this.gapAt(f, at), open = this.canExpand(f) && n > 0 && !f.expanding;
    return h_flex().id(it.key).h(it.h).pl(GUTTER).pr(16).gap(8).items_center().bg(t.surface).text_size(11).text_color(t.dim)
      .when(open, (el) => el.cursor_pointer().hover((x) => x.text_color(t.foreground)).tooltip(n === Infinity ? "Show the rest of the file" : `Show ${n} unchanged line${n === 1 ? "" : "s"}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.expand(s, d, f, [at], cx); cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).child(label)) // the hunk header is the diff's own text
      .when(open, (el) => el.child(h_flex().flex_none().gap(4).items_center().child(icon("unfold-vertical").size(12))
        .child(n === Infinity ? "Rest of the file" : `${n} line${n === 1 ? "" : "s"}`)));
  }

  diff(t, s, d, L) {
    const view = this.diffH ?? 600;
    const max = Math.max(0, L.total - view);
    // Once a selection is made (until the next scroll), its last line stays above the docked comment box.
    const end = this.reveal && L.range ? L.items.findIndex((it) => holds(it, L.range.to)) : -1;
    if (end >= 0) s.scroll[s.entry] = Math.max(s.scroll[s.entry] ?? 0, L.tops[end] + L.heights[end] + 8 - view);
    const scroll = (s.scroll[s.entry] = Math.max(0, Math.min(s.scroll[s.entry] ?? 0, max)));
    // Find: this file's matches by row, for row() to mark.
    const hs = this.hits(d);
    this.marks = new Map();
    for (const h of hs) if (h.fi === d.fi) { const k = h.th ? `${h.th}/${h.ci}` : h.ri; (this.marks.get(k) ?? this.marks.set(k, []).get(k)).push(h); }
    const vis = [];
    for (let i = firstVisible(L.tops, L.heights, scroll); i < L.items.length && L.tops[i] < scroll + view; i++) vis.push(i);
    const thumbH = Math.max(32, (view * view) / Math.max(L.total, 1));
    // Sideways: lines longer than the code column scroll by trackpad, shift-wheel or the bottom bar.
    // The code column: the diff less the line numbers and sign (per side when side by side; 1: the divider).
    const f = d.files[d.fi], dw = this.diffW ?? 800, codeW = (this.codeW = this.splitOn() ? (dw - 1) / 2 - 76 : dw - GUTTER - 16);
    if (f.colsAt !== f.rows.length) { f.colsAt = f.rows.length; f.cols = f.rows.reduce((m, r) => Math.max(m, shown(r.text ?? "").length), 0); }
    const maxX = Math.max(0, Math.ceil(f.cols * CH) + 8 - codeW);
    const hx = (this.hx = f.hx = Math.max(0, Math.min(f.hx ?? 0, maxX)));
    const thumbW = Math.max(32, (codeW * codeW) / (codeW + maxX)), track = codeW + 8 - thumbW;
    return div().id("diff").relative().flex_1().min_w(0).min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const w = size.width / this.zoom, h = size.height / this.zoom;
        if (Math.abs(h - (this.diffH ?? 0)) > 0.5 || Math.abs(w - (this.diffW ?? 0)) > 0.5) { this.diffH = h; this.diffW = w; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => {
        const side = e.modifiers.shift && !e.delta.x; // a plain mouse wheel scrolls sideways with shift
        const dx = side ? e.delta.y : e.delta.x, dy = side ? 0 : e.delta.y;
        if (dy) { this.reveal = false; s.scroll[s.entry] = Math.max(0, Math.min((s.scroll[s.entry] ?? 0) - dy, max)); }
        f.hx = Math.max(0, Math.min((f.hx ?? 0) - dx, maxX)); // f.hx, not the render's: wheel events can outrun frames
        cx.notify();
      })
      .children(vis.map((i) => this.item(t, s, d, L.items[i]).absolute().left(0).right(0).top(L.tops[i] - scroll)))
      .when(max > 0, (el) => el.child(div().id("diff-bar").absolute().right(2).w(6).top((scroll / max) * (view - thumbH)).h(thumbH).rounded(3)
        .bg(tint(t.foreground, this.bar && !this.bar.f ? "55" : "26")).hover((x) => x.bg(tint(t.foreground, "40")))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.bar = { y: e.position.y, scroll, k: max / (view - thumbH), entry: s.entry }; cx.notify(); })))
      .when(maxX > 0, (el) => el.child(div().id("diff-hbar").absolute().bottom(2).h(6).left(GUTTER + (hx / maxX) * track).w(thumbW).rounded(3)
        .bg(tint(t.foreground, this.bar?.f ? "55" : "26")).hover((x) => x.bg(tint(t.foreground, "40")))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.bar = { x: e.position.x, from: hx, k: maxX / track, entry: s.entry, f }; cx.notify(); })));
  }

  // Cards size to their content: measured once drawn, laid out by that from then on.
  measured(it, el) {
    return div().id(it.key).pl(this.narrow ? 12 : GUTTER).pr(this.narrow ? 12 : 24).py(6).child(el)
      .on_size_change((size, cx) => {
        const h = size.height / this.zoom;
        if (Math.abs(h - (this.heights.get(it.measure) ?? 0)) > 0.5) { this.heights.set(it.measure, h); cx.notify(); }
      });
  }

  item(t, s, d, it) {
    if (it.k === "row" && it.row.kind === "hunk") return this.gapRow(t, s, d, d.files[it.fi], it, it.ri, it.row.text);
    if (it.k === "tail") return this.gapRow(t, s, d, d.files[d.fi], it, d.files[d.fi].rows.length, "");
    if (it.k === "row") return this.row(t, s, it);
    if (it.k === "pair") return this.pair(t, s, d, it);
    if (it.k === "note") return h_flex().h(it.h).pl(this.narrow ? 16 : GUTTER).pr(16).items_center().text_size(12).text_color(t.muted).child(div().min_w(0).truncate().child(it.text));
    return this.measured(it, this.thread(t, s, it.th));
  }

  // The shown file's header above its diff, with previous / next file.
  fileHead(t, s, d) {
    const f = d.files[d.fi], label = { added: "Added", deleted: "Deleted", renamed: "Renamed" }[f.status];
    const nav = (by, name, tip) => h_flex().id(`file-${by}`).size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.stepFile(s, d, by); cx.notify(); })
      .child(icon(name).size(14));
    return h_flex().h(H.file).flex_none().pl(16).pr(12).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .child(div().min_w(0).truncate().text_size(12).font_medium().child(f.path))
      .when(f.status === "renamed", (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`from ${f.oldPath}`)))
      .child(div().flex_1())
      .when(Boolean(f.expandError), (el) => el.child(div().flex_none().max_w(260).truncate().text_size(11).text_color(t.blocked).child(`Couldn't show more: ${f.expandError}`)))
      .when(Boolean(label), (el) => el.child(this.chip(t, label, { deleted: t.blocked, added: t.done }[f.status] ?? t.idle)))
      .when(f.additions + f.deletions > 0, (el) => el.child(this.counts(t, f.additions, f.deletions)))
      .when(this.canExpand(f) && (this.tailLeft(f) || f.rows.some((r, i) => r.kind === "hunk" && this.gapAt(f, i) > 0)), (el) => el.child(this.iconBtn("expand-all", "unfold-vertical", "Show the whole file", (cx) => this.expandAll(s, d, f, cx))))
      .child(this.iconBtn("find-open", "search", "Find  ⌘F", () => this.openFind(s)))
      .when(!this.narrow, (el) => el.child(this.iconBtn("split", this.splitOn() ? "rows-2" : "columns-2", this.splitOn() ? "Unified diff" : "Side by side",
        () => setShared("pr-review.split", !this.splitOn()))))
      .when(d.files.length > 1, (el) => el.child(nav(-1, "chevron-up", "Previous file  ↑")).child(nav(1, "chevron-down", "Next file  ↓")));
  }

  // Review label chips: one or none, toggled; posted as a badge ahead of the comment.
  tagRow(t, key, cur, set) {
    return h_flex().gap(6).flex_wrap().items_center().children(TAGS.map(([k, label, , ink]) => {
      const on = cur === k, c = t[ink];
      return h_flex().id(`${key}-tag-${k}`).h(22).px(8).flex_none().items_center().rounded(6).border_1().text_size(11).cursor_pointer()
        .border_color(on ? c : t.border).bg(on ? tint(c, "26") : t.background).text_color(on ? c : t.muted)
        .hover((x) => x.border_color(c).text_color(c)).on_mouse_down("left", field) // the comment box keeps the keyboard
        .on_click((_e, cx) => { set(on ? null : k); cx.notify(); })
        .child(label);
    }));
  }

  // Side by side needs room: a narrow panel stays unified.
  splitOn() { return !this.narrow && Boolean(shared("pr-review.split")); }

  row(t, s, it) { return this.line(t, s, it.key, it.fi, it.ri, it.row, it.on, [it.row.old, it.row.new]).h(it.h); }

  // Side by side: the old line on the left, the new on the right, blank where a side has none.
  pair(t, s, d, it) {
    const rows = d.files[it.fi].rows;
    const half = (ri, on, left) => ri == null ? div().flex_1().min_w(0).h_full().bg(t.surface)
      : this.line(t, s, `${it.key}-${left ? "l" : "r"}`, it.fi, ri, rows[ri], on, [left ? rows[ri].old : rows[ri].new]).flex_1().min_w(0).h_full();
    return h_flex().id(it.key).h(it.h).child(half(it.l, it.onL, true)).child(div().w(1).h_full().flex_none().bg(t.border)).child(half(it.r, it.onR, false));
  }

  // One diff line: coloured by kind, selected by click, shift-click or drag. nums: the line numbers it shows.
  line(t, s, key, fi, ri, r, on, nums) {
    const add = r.kind === "add", del = r.kind === "del";
    const num = (n) => div().w(44).flex_none().pr(8).text_right().text_size(11).text_color(on ? t.accent : t.dim).child(n == null ? "" : String(n));
    return h_flex().id(key).items_center().font_family(MONO).text_size(12).cursor_pointer()
      .when(add, (el) => el.bg(tint(t.done, "1a"))).when(del, (el) => el.bg(tint(t.blocked, "1a")))
      .when(on, (el) => el.bg(t.selected))
      .hover((x) => x.bg(on ? t.selected : t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.handle.focus(); // the keyboard to the view; a comment box takes it on release (mouseUp)
        if (e.modifiers.shift && s.sel?.fi === fi) s.sel.focus = ri;
        else s.sel = { fi, anchor: ri, focus: ri };
        this.dragging = true;
        cx.notify();
      })
      .on_mouse_move((_e, cx) => {
        if (!this.dragging || s.sel?.fi !== fi || s.sel.focus === ri) return;
        s.sel.focus = ri;
        cx.notify();
      })
      .child(div().w(2).h_full().flex_none().when(on, (el) => el.bg(t.accent)))
      .children(nums.map(num))
      .child(div().w(14).flex_none().text_color(add ? t.done : del ? t.blocked : t.dim).child(add ? "+" : del ? "−" : ""))
      .child(div().flex_1().min_w(0).pr(16).whitespace_nowrap().overflow_hidden().when(Boolean(r.extra), (el) => el.text_color(t.muted))
        .child(div().relative().left(-(this.hx ?? 0)).child(this.marks?.has(ri) ? this.marked(t, shown(r.text), this.marks.get(ri)) : shown(r.text))));
  }

  // Selected lines get the comment box docked under the diff, not inline: selecting stays free until you write.
  composerCard(t, s, d, r) {
    const where = `${r.side === "LEFT" ? "old " : ""}line${r.start === r.end ? ` ${r.end}` : `s ${r.start}–${r.end}`}`;
    if (s.entry === "local") return div().flex_none().px(16).py(10).border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(`Selected ${where}. This branch is read-only here: comments need a pull request.`);
    return v_flex().flex_none().px(16).py(12).gap(8).bg(t.surface).border_t(1).border_color(t.accent)
      .child(h_flex().gap(8).items_center()
        .child(icon("message").size(13).text_color(t.accent))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`Comment on ${where}`))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child("⌘↵ post · Esc cancel")))
      .child(this.tagRow(t, "compose", this.tag, (k) => (this.tag = k)))
      .child(div().rounded(6).bg(t.background).border_1().border_color(t.input).px(8).py(6).on_mouse_down("left", field).child(Textarea.new(this.composer).id("composer").h(64).w_full().text_size(13)))
      .when(Boolean(this.composeError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.composeError)))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(this.button(t, "compose-cancel", "Cancel", () => { s.sel = null; this.tag = null; this.composeError = null; this.unfocus(); }))
        .child(this.button(t, "compose-post", this.posting ? "Posting…" : "Comment", (cx) => this.post(cx), true, this.posting || !d.headOid)));
  }

  thread(t, s, th) {
    const busy = this.busy === th.id;
    const err = this.actError?.thread === th.id ? this.actError.msg : null;
    const first = th.comments[0];
    const toggle = h_flex().id(`thr-${th.id}`).cursor_pointer().on_click((_e, cx) => {
      this.expanded.has(th.id) ? this.expanded.delete(th.id) : this.expanded.add(th.id);
      cx.notify();
    });
    const card = v_flex().rounded(10).bg(t.surface).border_1().border_color(t.border).overflow_hidden();
    if (th.isResolved && !this.expanded.has(th.id)) return card.child(toggle.h(30).px(12).gap(8).items_center().hover((x) => x.bg(t.hover))
      .child(icon("chevron-right").size(13).flex_none().text_color(t.dim))
      .child(this.chip(t, "Resolved", t.done))
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.accent).child(first?.author?.login ?? ""))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(splitTag(first?.body).text.split("\n")[0]))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${th.comments.length} comment${th.comments.length === 1 ? "" : "s"}`)));
    const lines = th.line == null ? "Outdated" : th.startLine && th.startLine !== th.line ? `Lines ${th.startLine}–${th.line}` : `Line ${th.line}`;
    const dr = this.draft?.thread === th.id ? this.draft : null;
    return card
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(th.isResolved, (el) => el.child(toggle.child(icon("chevron-down").size(13).text_color(t.dim))))
        .child(div().text_size(11).text_color(t.dim).child(`${th.diffSide === "LEFT" ? "old · " : ""}${lines}`))
        .when(th.isOutdated, (el) => el.child(this.chip(t, "Outdated", t.idle)))
        .when(th.isResolved, (el) => el.child(this.chip(t, "Resolved", t.done)))
        .child(div().flex_1())
        .when(busy, (el) => el.child(icon("spinner").size(13).text_color(t.dim).spin(900)))
        .when(!busy, (el) => el.child(this.link(t, `res-${th.id}`, th.isResolved ? "Unresolve" : "Resolve",
          (cx) => this.act(th, (nwo) => (th.isResolved ? s.api.unresolveThread : s.api.resolveThread)(s.id, th.id, nwo, s.entry), cx)))))
      .children(th.comments.map((c, ci) => this.comment(t, s, th, c, ci, dr)))
      .when(Boolean(err), (el) => el.child(div().px(12).pb(10).text_size(12).text_color(t.blocked).child(err)))
      .child(dr?.kind === "reply"
        ? v_flex().p(12).gap(8).border_t(1).border_color(t.border)
          .child(this.tagRow(t, `reply-${th.id}`, dr.tag, (k) => (dr.tag = k)))
          .child(div().rounded(6).bg(t.background).border_1().border_color(t.input).px(8).py(6).on_mouse_down("left", field).child(Textarea.new(dr.state).id(`reply-${th.id}`).h(48).w_full().text_size(13)))
          .child(h_flex().gap(8).justify_end()
            .child(this.button(t, `reply-cancel-${th.id}`, "Cancel", () => this.dropDraft()))
            .child(this.button(t, `reply-send-${th.id}`, busy ? "Sending…" : "Reply", (cx) => this.saveDraft(cx), true, busy)))
        : h_flex().h(36).px(12).items_center().border_t(1).border_color(t.border)
          .child(this.link(t, `reply-${th.id}`, "Reply…", () => this.startDraft("reply", th))));
  }

  comment(t, s, th, c, ci, dr) {
    const editing = dr?.kind === "edit" && dr.comment === c.databaseId;
    const { tag, text } = splitTag(c.body), hit = this.marks?.get(`${th.id}/${ci}`)?.[0];
    return v_flex().px(12).py(10).gap(4).when(ci > 0, (el) => el.border_t(1).border_color(t.border))
      .when(Boolean(hit), (el) => el.bg(tint(t.accent, hit === this.findHit ? "33" : "14")))
      .child(this.commentActs(t, h_flex().gap(8).items_center()
        .child(div().text_size(13).font_semibold().text_color(t.accent).child(c.author?.login ?? "ghost"))
        .when(Boolean(tag) && !editing, (el) => { const [, label, , ink] = TAGS.find(([k]) => k === tag); return el.child(this.chip(t, label, t[ink])); })
        .child(div().text_size(11).text_color(t.dim).child(ago(c.createdAt)))
        .child(div().flex_1()), s, th, c, editing))
      .child(editing ? this.editBox(t, dr) : TextView.markdown(`md-${c.id}`, mentions(text)).selectable(true).scrollable(false).w_full().text_size(13).text_color(t.foreground));
  }

  // A comment's Edit and Delete (Delete asks first), at the end of its header row; th is its thread, or TALK.
  commentActs(t, row, s, th, c, editing) {
    const id = c.databaseId, confirming = id != null && this.confirm === id, idle = !confirming && !editing && this.busy !== th.id;
    return row
      .when(confirming, (el) => el
        .child(div().text_size(12).text_color(t.muted).child("Delete this comment?"))
        .child(this.link(t, `del-yes-${id}`, "Delete", (cx) => { this.confirm = null; this.act(th, (nwo) => s.api.deleteComment(s.id, nwo, id, th.where, s.entry), cx); }, t.blocked))
        .child(this.link(t, `del-no-${id}`, "Keep", () => (this.confirm = null))))
      .when(idle && c.viewerCanUpdate, (el) => el.child(this.link(t, `edit-${id}`, "Edit", () => this.startDraft("edit", th, c))))
      .when(idle && c.viewerCanDelete, (el) => el.child(this.link(t, `del-${id}`, "Delete", () => (this.confirm = id))));
  }

  editBox(t, dr) {
    const id = dr.comment;
    return v_flex().gap(8).pt(4)
      .child(this.tagRow(t, `edit-${id}`, dr.tag, (k) => (dr.tag = k)))
      .child(div().rounded(6).bg(t.background).border_1().border_color(t.input).px(8).py(6).on_mouse_down("left", field).child(Textarea.new(dr.state).id(`edit-box-${id}`).h(64).w_full().text_size(13)))
      .child(h_flex().gap(8).justify_end()
        .child(this.button(t, `edit-cancel-${id}`, "Cancel", () => this.dropDraft()))
        .child(this.button(t, `edit-save-${id}`, "Save", (cx) => this.saveDraft(cx), true, this.busy === dr.thread)));
  }
}
