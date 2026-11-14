import { test, expect } from "bun:test";
import { wilson, levels, clean, heat, summarize, startOfDay, DAY, kindOf, rhythmOf, outputOf, span, keepOf, tabAfter } from "./lib.js";

const NOW = new Date(2026, 10, 12, 15).getTime(); // Thu 12 Nov 2026, 15:00 local
const s = (h, daysAgo, extra = {}) => ({
  h, id: `${h}${daysAgo}${Math.random()}`, start: NOW - daysAgo * DAY, end: NOW - daysAgo * DAY + 600000, repo: "/r/app", sub: false,
  models: { [`${h}-m`]: 1000 }, effort: "high", tok: 1000, tin: 100, tout: 100, tcr: 700, tcw: 100, cost: null,
  req: 5, tools: 10, toolErr: 0, aborts: 0, apiErr: 0, compactions: 0, commits: 1, ...extra,
});

test("wilson: bounds hold and small n stays wide", () => {
  expect(wilson(0, 0)).toBeNull();
  const w = wilson(3, 3);
  expect(w.p).toBe(1);
  expect(w.hi).toBe(1);
  expect(w.lo).toBeLessThan(0.5); // 3 of 3 isn't proof of 100%
  expect(wilson(300, 300).lo).toBeGreaterThan(0.98);
});

test("levels: zero is empty, quartiles of the rest", () => {
  const lvl = levels([0, 1, 2, 3, 4, 100]);
  expect(lvl(0)).toBe(0);
  expect(lvl(1)).toBe(1);
  expect(lvl(100)).toBe(4);
});

test("clean: abort, API error, compaction or 10%+ tool errors spoil a run", () => {
  expect(clean(s("omp", 0))).toBe(true);
  expect(clean(s("omp", 0, { aborts: 1 }))).toBe(false);
  expect(clean(s("omp", 0, { compactions: 1 }))).toBe(false);
  expect(clean(s("omp", 0, { toolErr: 1 }))).toBe(false);
  expect(clean(s("omp", 0, { tools: 0, toolErr: 0 }))).toBe(true);
});

test("heat: ends today, starts on a Monday, sub-agents don't count as sessions", () => {
  const cells = heat([s("omp", 0), s("omp", 0, { sub: true })], { weeks: 2, metric: "sessions", now: NOW });
  expect(cells.at(-1).t).toBe(startOfDay(NOW));
  expect(cells[0].wd).toBe(0);
  expect(cells.at(-1).sessions).toBe(1);
  expect(cells.at(-1).tokens).toBe(2000);
});

test("summarize: tiles, streak through yesterday, filters by harness", () => {
  const all = [s("omp", 1), s("omp", 2), s("claude", 1), s("claude", 40)];
  const r = summarize(all, { from: startOfDay(NOW) - 6 * DAY, to: NOW, harnesses: new Set(["omp"]) });
  expect(r.tiles.sessions).toBe(2);
  expect(r.tiles.streak).toBe(2); // yesterday and the day before; today has none yet
  expect(r.tiles.cacheHit).toBeCloseTo(0.875);
  expect(r.tiles.costKnown).toBe(false);
  expect(r.step).toBe(DAY);
});

test("scorecard: 3+ sessions per harness x model; a winner only when intervals separate", () => {
  const good = Array.from({ length: 40 }, (_, i) => s("omp", i % 5));
  const bad = Array.from({ length: 40 }, (_, i) => s("claude", i % 5, { aborts: 1, commits: 0 }));
  const r = summarize([...good, ...bad, s("pi", 1), s("pi", 2)], { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp", "claude", "pi"]) });
  expect(r.score.map((x) => x.h)).toEqual(["omp", "claude"]); // pi has only 2
  expect(r.best?.h).toBe("omp");
  expect(r.score[1].commit.p).toBe(0);
  const close = summarize([s("omp", 1), s("omp", 2), s("omp", 3), s("claude", 1), s("claude", 2), s("claude", 3, { aborts: 1 })],
    { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp", "claude"]) });
  expect(close.best).toBeNull();
});

test("same repos: only repos two harnesses worked in", () => {
  const all = [...[1, 2, 3].map((d) => s("omp", d, { repo: "/r/a" })), ...[1, 2, 3].map((d) => s("claude", d, { repo: "/r/b" })), ...[1, 2, 3].map((d) => s("claude", d, { repo: "/r/a" }))];
  const r = summarize(all, { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp", "claude"]), sameRepos: true });
  expect(r.score.find((x) => x.h === "claude").n).toBe(3);
});

test("kindOf: the tool mix names the work", () => {
  const tc = (o) => ({ tc: { edit: 0, read: 0, bash: 0, web: 0, agent: 0, other: 0, ...o } });
  expect(kindOf({})).toBe("chat");
  expect(kindOf(tc({ agent: 3, read: 50 }))).toBe("orchestrate");
  expect(kindOf(tc({ edit: 4, read: 16 }))).toBe("build");
  expect(kindOf(tc({ web: 6, read: 4 }))).toBe("research");
  expect(kindOf(tc({ bash: 9, read: 3 }))).toBe("debug");
  expect(kindOf(tc({ bash: 2, read: 9 }))).toBe("investigate");
});

test("cost per success counts failed runs' spend; kind filters the comparison", () => {
  const runs = [s("omp", 1, { cost: 2 }), s("omp", 2, { cost: 2 }), s("omp", 3, { cost: 2, aborts: 1 })];
  const r = summarize(runs, { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp"]) });
  expect(r.score[0].cps).toBe(3); // $6 over 2 clean runs
  expect(r.score[0].loops).toBe(10);
  expect(r.kinds.chat).toBe(3);
  expect(summarize(runs, { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp"]), kind: "build" }).score).toEqual([]);
});

test("cost anatomy: price per token and per output token, context read per token written", () => {
  const runs = [1, 2, 3].map((d) => s("omp", d, { cost: 1, tok: 1000, tin: 100, tcw: 100, tcr: 700, tout: 100 }));
  const x = summarize(runs, { from: NOW - 30 * DAY, to: NOW, harnesses: new Set(["omp"]) }).score[0];
  expect(x.per1M).toBeCloseTo(1000); // $3 over 3000 tokens
  expect(x.per1kOut).toBeCloseTo(10); // $3 over 300 output tokens
  expect(x.readPerOut).toBe(9);
  expect(x.perCommit).toBe(1);
});

test("rhythm: lengths binned, parallel runs counted, long resumed runs capped", () => {
  const at = (h, mins) => ({ start: NOW + h * 3600000, end: NOW + h * 3600000 + mins * 60000 });
  const r = rhythmOf([at(0, 3), at(0.01, 90), at(0.02, 60 * 48), at(30, 10)]);
  expect(r.lengths).toEqual([1, 1, 0, 0, 1, 0, 1]);
  expect(r.peakParallel).toBe(3);
  expect(r.longestMin).toBe(480); // a resumed run counts as 8h at most
});

test("output: commits and lines in the period, PRs merged by merge date, median time to merge", () => {
  const out = {
    commits: [{ t: NOW - DAY, repo: "/r/a", add: 10, del: 2 }, { t: NOW - 2 * DAY, repo: "/r/a", add: 5, del: 0 }, { t: NOW - 40 * DAY, repo: "/r/b", add: 99, del: 9 }],
    prs: [{ repo: "/r/a", n: 1, created: NOW - 3 * DAY, merged: NOW - 3 * DAY + 2 * 3600000, add: 1, del: 1, state: "merged" }, { repo: "/r/a", n: 2, created: NOW - DAY, merged: null, add: 1, del: 0, state: "open" }],
    worktrees: [{ repo: "/r/a", n: 3 }],
  };
  const o = outputOf(out, { from: NOW - 7 * DAY, to: NOW, step: DAY });
  expect([o.commits, o.add, o.del, o.activeDays]).toEqual([2, 15, 2, 2]);
  expect([o.opened, o.merged, o.mergeHours, o.worktrees]).toEqual([2, 1, 2, 3]);
  expect(o.repos[0]).toEqual({ repo: "/r/a", commits: 2, add: 15, del: 2 });
});

test("selection: spans days and hour blocks, and narrows the sums to what's picked", () => {
  const today = startOfDay(NOW);
  expect(span("days", [today - 2 * DAY, today - 2 * DAY], [today, today]).length).toBe(3);
  // 09:00-12:00 every day, dragged down the hour labels: 7 weekdays x 3 hours.
  const nine = span("slots", [[0, 6], [9, 9]], [[0, 6], [11, 11]]);
  expect(nine.length).toBe(21);
  const at = (daysAgo, hour) => s("omp", 0, { start: today - daysAgo * DAY + hour * 3600000 });
  const all = [at(0, 10), at(0, 15), at(1, 9), at(3, 11)];
  const slots = keepOf({ kind: "slots", keys: new Set(nine) });
  expect(summarize(all, { from: today - 6 * DAY, to: today + DAY, harnesses: new Set(["omp"]), keep: slots }).tiles.sessions).toBe(3);
  const days = new Set([today, today - DAY]);
  const r = summarize(all, { from: today - DAY, to: today + DAY, harnesses: new Set(["omp"]), keep: keepOf({ kind: "days", keys: days }), days: 2 });
  expect([r.tiles.sessions, r.tiles.days, r.tiles.activeDays]).toEqual([3, 2, 2]);
  const out = { commits: [{ t: today + 10 * 3600000, repo: "/r/a", add: 1, del: 0 }, { t: today + 15 * 3600000, repo: "/r/a", add: 1, del: 0 }] };
  expect(outputOf(out, { from: today, to: today + DAY, step: DAY, keep: slots }).commits).toBe(1);
});

test("tabAfter: ← / → walk the tabs (wrapping), but not while a date field has the caret", () => {
  const tabs = [["overview"], ["compare"], ["rhythm"]];
  expect(tabAfter(tabs, "overview", "right", false)).toBe("compare");
  expect(tabAfter(tabs, "overview", "left", false)).toBe("rhythm");
  expect(tabAfter(tabs, "rhythm", "right", false)).toBe("overview");
  expect(tabAfter(tabs, "compare", "left", true)).toBe(null); // typing a custom range: the caret's, not the tabs'
});
