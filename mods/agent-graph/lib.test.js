import { test, expect } from "bun:test";
import { buildTree, layout, prChip, prsByBranch, mrsAsPRs, parseRevParse, cleanTitle, SIZE, mix, ringed, sidebarCursor, openOnActive, filterCounts } from "./lib.js";

const GIT = {
  "/r/app": { top: "/r/app", common: "/r/app/.git", branch: "main" },
  "/r/app/src": { top: "/r/app", common: "/r/app/.git", branch: "main" },
  "/r/app/.wt/feat": { top: "/r/app/.wt/feat", common: "/r/app/.git", branch: "feat/x" },
  "/r/lib": { top: "/r/lib", common: "/r/lib/.git", branch: "dev" },
};
const git = (_m, cwd) => GIT[cwd] ?? null;
const PRS = prsByBranch([
  { number: 3, state: "OPEN", isDraft: false, headRefName: "feat/x", reviewDecision: "APPROVED" },
  { number: 1, state: "CLOSED", isDraft: false, headRefName: "feat/x" },
]);
const prs = (_m, common) => (common === "/r/app/.git" ? PRS : undefined);
const item = (id, cwd, status, parent = null) => ({ id, cwd, status, parent, machine: null, name: id });

test("worktrees sharing a common dir group under one repo; non-git under Not in git", () => {
  const tree = buildTree([item("t1", "/r/app", "idle"), item("t2", "/r/app/.wt/feat", "working"), item("t3", "/r/app/src", "idle"), item("t4", "/tmp", "idle")], git, prs);
  expect(tree.map((r) => r.name)).toEqual(["app", "Not in git"]);
  const app = tree[0];
  expect(app.worktrees.map((w) => w.branch)).toEqual(["feat/x", "main"]);
  expect(app.worktrees[1].agents.map((a) => a.id)).toEqual(["t1", "t3"]);
  expect(app.worktrees[0].pr).toEqual({ state: "open", review: "approved", number: 3, title: "", label: "#3 open · approved" });
  expect(app.worktrees[1].pr.state).toBe("none");
  expect(tree[1].worktrees[0]).toMatchObject({ kind: "folder", name: "tmp", pr: null });
});

test("sub-agents nest under their parent regardless of cwd; orphans become roots", () => {
  const tree = buildTree([item("t1", "/r/lib", "idle"), item("t2", "/tmp", "blocked", "t1"), item("t3", "/r/lib", "idle", "t2"), item("t4", "/r/lib", "done", "gone")], git, prs);
  expect(tree).toHaveLength(1);
  const [t1, t4] = tree[0].worktrees[0].agents;
  expect([t1.id, t4.id]).toEqual(["t1", "t4"]); // t1 carries its sub-agent's blocked
  expect(t1.children[0].id).toBe("t2");
  expect(t1.children[0].children[0].id).toBe("t3");
});

test("attention-first ordering: blocked > done > working > idle, propagated up", () => {
  const tree = buildTree([item("a", "/r/app", "idle"), item("b", "/r/app", "working"), item("c", "/r/app", "done"), item("d", "/r/lib", "blocked")], git, prs);
  expect(tree.map((r) => r.name)).toEqual(["lib", "app"]);
  expect(tree[1].worktrees[0].agents.map((a) => a.id)).toEqual(["c", "b", "a"]);
  expect(tree[1].rank).toBe(1);
});

test("active only drops idle leaves but keeps idle parents of active children", () => {
  const tree = buildTree([item("p", "/r/app", "idle"), item("k", "/r/app", "working", "p"), item("z", "/r/lib", "idle")], git, prs, { activeOnly: true });
  expect(tree.map((r) => r.name)).toEqual(["app"]);
  expect(tree[0].worktrees[0].agents[0].children.map((c) => c.id)).toEqual(["k"]);
});

test("layout: layered columns, parents centred on children, edges right-mid to left-mid", () => {
  const tree = buildTree([item("t1", "/r/app", "idle"), item("t2", "/r/app", "working"), item("s", "/r/app", "blocked", "t2")], git, prs);
  const L = layout(tree);
  const at = (id) => L.nodes.find((n) => n.id === id);
  const repo = at("r:|/r/app/.git"), wt = at("w:|/r/app"), t1 = at("a:t1"), t2 = at("a:t2"), s = at("a:s");
  expect([repo.x, wt.x, t2.x, s.x]).toEqual([0, SIZE.repo.w + 72, SIZE.repo.w + SIZE.worktree.w + 144, SIZE.repo.w + SIZE.worktree.w + SIZE.agent.w + 216]);
  expect(t2.y).toBe(s.y); // single child: same row
  expect(t2.y).toBeLessThan(t1.y); // blocked subtree first
  expect(wt.y + wt.h / 2).toBe((t2.y + t1.y) / 2 + SIZE.agent.h / 2);
  const e = L.edges.find((e) => e.to === "a:s");
  expect(e).toMatchObject({ from: "a:t2", status: "blocked", a: { x: t2.x + t2.w, y: t2.y + 32 }, b: { x: s.x, y: s.y + 32 } });
  expect(L.edges.find((e) => e.to === "a:t1").status).toBe("idle");
  expect(L.height).toBe(76 + 64);
});

test("parsers", () => {
  expect(parseRevParse("/r/app\n/r/app/.git\nHEAD\n")).toEqual({ top: "/r/app", common: "/r/app/.git", branch: null });
  expect(parseRevParse("")).toBeNull();
  expect(prChip({ number: 9, state: "OPEN", isDraft: true }).label).toBe("#9 draft");
  expect(prChip({ number: 9, state: "MERGED", reviewDecision: "APPROVED" }).label).toBe("#9 merged");
  expect(cleanTitle("π \u{F1049} HERDR:  Build  graph")).toBe("HERDR: Build graph");
  expect(cleanTitle("π > ⁂DOCS: Find")).toBe("DOCS: Find");
  expect(cleanTitle("✳ Claude Code")).toBe("Claude Code");
  expect(cleanTitle("AI is great")).toBe("AI is great");
  expect(cleanTitle("PR #42 fixes")).toBe("PR #42 fixes");
});

test("mrsAsPRs: GitLab MRs as the PRs prsByBranch and prChip read", () => {
  const m = prsByBranch(mrsAsPRs([
    { iid: 8, state: "opened", draft: false, source_branch: "feature/e2e", title: "Run page", web_url: "https://gitlab.com/x/y/-/merge_requests/8" },
    { iid: 3, state: "merged", draft: false, source_branch: "feature/e2e", title: "older", web_url: "u3" },
    { iid: 5, state: "opened", draft: true, source_branch: "wip", title: "W", web_url: "u5" },
  ]));
  expect(m.get("feature/e2e")).toMatchObject({ number: 8, state: "OPEN", isDraft: false, title: "Run page", url: "https://gitlab.com/x/y/-/merge_requests/8", reviewDecision: null });
  expect(prChip(m.get("feature/e2e")).label).toBe("#8 open");
  expect(prChip(m.get("wip")).state).toBe("draft");
});

test("mix blends two theme colours into an opaque one", () => {
  expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(mix("#0e0e0e", "#ff0000", 0)).toBe("#0e0e0e");
  expect(mix("#102030ff", "#ffffff", 1)).toBe("#ffffff");
});

// The ring follows the level the sidebar's cursor is on, else the focused terminal.
const RING_ITEMS = [
  { id: "t1", cwd: "/r/app", status: "working", agent: true, name: "a", space: "s1" },
  { id: "t2", cwd: "/r/app/.wt/feat", status: "idle", agent: true, name: "b", space: "s2" },
  { id: "t3", parent: "t2", cwd: "/r/app/.wt/feat", status: "idle", agent: true, name: "c", space: "s2" },
];
const ringTree = () => buildTree(RING_ITEMS, git, () => undefined);

test("ringed: no sidebar cursor rings the focused terminal's agent", () => {
  expect([...ringed(ringTree(), null, "t1")]).toEqual(["a:t1"]);
  expect([...ringed(ringTree(), null, null)]).toEqual([]);
});

test("ringed: an Inbox card rings its agent, not the focused one", () => {
  expect([...ringed(ringTree(), { kind: "agent", id: "t3" }, "t1")]).toEqual(["a:t3"]);
});

test("ringed: a space rings the worktree its agents work in, not an agent", () => {
  expect([...ringed(ringTree(), { kind: "space", id: "s2" }, "t1")]).toEqual(["w:|/r/app/.wt/feat"]);
});

test("ringed: an unopened worktree row rings that worktree's card", () => {
  expect([...ringed(ringTree(), { kind: "worktree", on: null, path: "/r/app" }, "t1")]).toEqual(["w:|/r/app"]);
});

test("sidebarCursor: whichever list holds the keyboard; the newer one while the keyboard moves between them", () => {
  const a = { kind: "agent", id: "t1", at: 5 }, s = { kind: "space", id: "s1", at: 9 };
  expect(sidebarCursor(null, null)).toBe(null);
  expect(sidebarCursor(a, null)).toBe(a);
  expect(sidebarCursor(null, s)).toBe(s);
  expect(sidebarCursor(a, s)).toBe(s);
});

// The Agents panel opens on Active when anything works or needs you, else All; the switch counts what each shows.
const FILTER_ITEMS = [
  { id: "a", agent: true, status: "working" }, { id: "b", agent: true, status: "idle" },
  { id: "c", agent: true, status: "done" }, { id: "t", agent: false, status: "idle" },
];

test("openOnActive: working or needs you opens on Active; finished, idle or no agents opens on All", () => {
  expect(openOnActive(FILTER_ITEMS)).toBe(true);
  expect(openOnActive([{ agent: true, status: "blocked" }])).toBe(true);
  expect(openOnActive([{ agent: true, status: "done" }, { agent: true, status: "idle" }])).toBe(false);
  expect(openOnActive([{ agent: false, status: "working" }])).toBe(false); // a plain terminal isn't an agent
  expect(openOnActive([])).toBe(false);
});

test("filterCounts: Active counts the agents Active shows (all but idle), All every agent", () => {
  expect(filterCounts(FILTER_ITEMS)).toEqual({ active: 2, all: 3 });
  expect(filterCounts([])).toEqual({ active: 0, all: 0 });
});
