import { test, expect } from "bun:test";
import { parseWorktrees, parseTrack, addWorktrees, nearest, actionTarget, reopened, cursorOf } from "./lib.js";

const PORCELAIN = ["worktree /r", "HEAD a", "branch refs/heads/main", "",
  "worktree /w/feat", "HEAD b", "branch refs/heads/feat/x", "",
  "worktree /w/det", "HEAD c", "detached", "",
  "worktree /w/gone", "HEAD d", "branch refs/heads/old", "prunable gitdir file points to non-existent location", ""].join("\n");

test("parseWorktrees: main, linked, detached, bare, prunable", () => {
  expect(parseWorktrees(PORCELAIN)).toEqual([
    { path: "/r", branch: "main", bare: false, prunable: false },
    { path: "/w/feat", branch: "feat/x", bare: false, prunable: false },
    { path: "/w/det", branch: null, bare: false, prunable: false },
    { path: "/w/gone", branch: "old", bare: false, prunable: true }]);
  expect(parseWorktrees("worktree /b.git\nbare\n")[0].bare).toBe(true);
  expect(parseWorktrees("")).toEqual([]);
});

test("parseTrack: ahead, behind, both, gone, none", () => {
  expect(parseTrack("a [ahead 2]\nb [behind 3]\nc [ahead 1, behind 4]\nd [gone]\ne \n")).toEqual({
    a: { ahead: 2, behind: 0 }, b: { ahead: 0, behind: 3 }, c: { ahead: 1, behind: 4 }, d: { ahead: 0, behind: 0 }, e: { ahead: 0, behind: 0 } });
});

// Main space T at /r on main (repo R), open linked space F at /w/feat on feat/x, other space D (no repo).
const R = JSON.stringify([null, "/r/.git"]);
const space = (id, g, tree = null) => ({ w: { id }, i: 0, g, tree });
const fixture = (fTop = "/w/feat") => [
  space("T", { repo: R, branch: "main", linked: false, top: "/r" }),
  space("F", { repo: R, branch: "feat/x", linked: true, top: fTop }, "└─"),
  space("D", null),
];
const TREES = { [R]: { list: parseWorktrees(PORCELAIN), track: parseTrack("main \nfeat/x [ahead 1]\nold [gone]\n") } };

test("addWorktrees: open worktree once, greyed after nested, main not repeated, prunable and bare skipped", () => {
  const out = addWorktrees(fixture(), TREES, new Set());
  expect(out.map((r) => r.key)).toEqual(["s:T", "s:F", 'p:[null,"/w/det"]', "s:D"]);
  const [T, F, det, D] = out;
  expect([T.kind, T.kids, T.parent]).toEqual(["space", 2, null]);
  expect([F.kind, F.parent]).toEqual(["space", "s:T"]);
  expect(det).toEqual({ kind: "wt", key: 'p:[null,"/w/det"]', parent: "s:T", on: null, path: "/w/det", label: "det", ahead: 0, behind: 0 });
  expect([D.kids, D.parent]).toEqual([0, null]);
});

test("addWorktrees: path differs but branch matches an open space -> not greyed", () => {
  const out = addWorktrees(fixture("/private/w/feat"), TREES, new Set());
  expect(out.filter((r) => r.kind === "wt").map((r) => r.path)).toEqual(["/w/det"]);
});

test("addWorktrees: greyed rows carry their branch's ahead/behind", () => {
  const trees = { [R]: { list: parseWorktrees("worktree /r\nbranch refs/heads/main\n\nworktree /w/fix\nbranch refs/heads/fix/y\n"), track: parseTrack("fix/y [ahead 2, behind 1]\n") } };
  const wt = addWorktrees(fixture(), trees, new Set()).find((r) => r.kind === "wt");
  expect([wt.label, wt.ahead, wt.behind]).toEqual(["fix/y", 2, 1]);
});

test("addWorktrees: folded space keeps kids count, drops child rows", () => {
  const out = addWorktrees(fixture(), TREES, new Set(["T"]));
  expect(out.map((r) => r.key)).toEqual(["s:T", "s:D"]);
  expect(out[0].kids).toBe(2);
});

test("addWorktrees: linked space without its main stays top-level, no greyed rows", () => {
  const out = addWorktrees([space("F", { repo: R, branch: "feat/x", linked: true, top: "/w/feat" })], TREES, new Set());
  expect(out.map((r) => [r.key, r.kids, r.parent])).toEqual([["s:F", 0, null]]);
});

test("addWorktrees: a second space at the main checkout gets no rows of its own", () => {
  const rows = [...fixture(), space("T2", { repo: R, branch: "main", linked: false, top: "/r" })];
  const out = addWorktrees(rows, TREES, new Set());
  expect(out.map((r) => r.key)).toEqual(["s:T", "s:F", 'p:[null,"/w/det"]', "s:D", "s:T2"]);
  expect(out.at(-1).kids).toBe(0);
});

test("addWorktrees: remote repo rows carry on, no tree yet -> nested spaces only", () => {
  const RB = JSON.stringify(["box", "/r/.git"]);
  const rows = [space("T", { repo: RB, branch: "main", linked: false, top: "/r" }), space("F", { repo: RB, branch: "feat/x", linked: true, top: "/w/feat" }, "└─")];
  expect(addWorktrees(rows, { [RB]: TREES[R] }, new Set()).find((r) => r.kind === "wt").key).toBe('p:["box","/w/det"]');
  expect(addWorktrees(rows, {}, new Set()).map((r) => [r.key, r.kids])).toEqual([["s:T", 1], ["s:F", 0]]);
});

test("nearest: kept, removed -> previous, all gone -> first, empty -> null", () => {
  expect(nearest(["a", "b", "c"], ["a", "b", "c"], "b")).toBe("b");
  expect(nearest(["a", "c"], ["a", "b", "c"], "b")).toBe("a");
  expect(nearest(["c"], ["a", "b", "c"], "a")).toBe("c");
  expect(nearest([], ["a"], "a")).toBe(null);
  expect(nearest(["x"], [], null)).toBe("x");
});

test("addWorktrees: bare repo (no main checkout) -> its first space shows the worktrees with no space", () => {
  const B = JSON.stringify([null, "/b.git"]);
  const rows = [space("F1", { repo: B, branch: "feat/a", linked: true, top: "/w/a" }), space("F2", { repo: B, branch: "feat/c", linked: true, top: "/w/c" })];
  const trees = { [B]: { list: parseWorktrees("worktree /b.git\nbare\n\nworktree /w/a\nbranch refs/heads/feat/a\n\nworktree /w/b\nbranch refs/heads/feat/b\n\nworktree /w/c\nbranch refs/heads/feat/c\n"), track: {} } };
  const out = addWorktrees(rows, trees, new Set());
  expect(out.map((r) => [r.key, r.kids, r.parent])).toEqual([["s:F1", 1, null], ['p:[null,"/w/b"]', undefined, "s:F1"], ["s:F2", 0, null]]);
});

test("addWorktrees: an archived worktree isn't listed", () => {
  const out = addWorktrees(fixture(), TREES, new Set(), { [JSON.stringify([null, "/w/det"])]: null });
  expect(out.map((r) => r.key)).toEqual(["s:T", "s:F", "s:D"]);
  expect(out[0].kids).toBe(1);
});

test("actionTarget: greyed worktree and open linked space; not the main checkout or a plain folder", () => {
  const [T, F, det, D] = addWorktrees(fixture(), TREES, new Set());
  expect(actionTarget(det)).toEqual({ on: null, path: "/w/det", label: "det", space: null });
  expect(actionTarget(F)).toEqual({ on: null, path: "/w/feat", label: "feat/x", space: "F" });
  expect(actionTarget(T)).toBe(null);
  expect(actionTarget(D)).toBe(null);
});

test("reopened: archived keys whose worktree is open again in a new space", () => {
  const k = JSON.stringify([null, "/w/feat"]);
  expect(reopened({ [k]: "F" }, fixture())).toEqual([]); // the space being closed by the archive itself
  expect(reopened({ [k]: "old" }, fixture())).toEqual([k]);
  expect(reopened({ [k]: null }, fixture())).toEqual([k]);
});

test("cursorOf: a space row is its space, an unopened worktree its machine and path, nothing else a cursor", () => {
  expect(cursorOf({ kind: "space", key: "s:s1", w: { id: "s1" } })).toEqual({ kind: "space", id: "s1" });
  expect(cursorOf({ kind: "wt", on: null, path: "/w/feat" })).toEqual({ kind: "worktree", on: null, path: "/w/feat" });
  expect(cursorOf(undefined)).toBe(null);
});
