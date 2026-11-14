// Usage numbers from scan.py's sessions (its contract is at the top of scan.py). Pure, so `bun test` covers them.
// Counts and rates use top-level sessions; tokens and cost include sub-agents (they're the harness's spend).

export const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Local midnight n days away; a clock change in between can't shift it by an hour.
export const addDays = (ms, n) => startOfDay(startOfDay(ms) + n * DAY + DAY / 2);
const weekday = (ms) => (new Date(ms).getDay() + 6) % 7; // Monday 0
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const sum = (xs, f) => xs.reduce((n, x) => n + (f(x) ?? 0), 0);

// 95% Wilson interval for k of n: honest at small n, where k/n alone overclaims.
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

// 0 (none) to 4: quartiles of the non-zero values, as GitHub's contribution graph does.
export function levels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => nz[Math.floor(f * (nz.length - 1))] ?? 0);
  return (v) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
}

export const topModel = (s) => Object.entries(s.models ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

// A run that went smoothly: no abort, no API error, no compaction, under 10% failed tool calls.
export const clean = (s) => !s.aborts && !s.apiErr && !s.compactions && (!s.tools || s.toolErr / s.tools < 0.1);

// The kind of work, read off the run's mix of tool calls (no prompt is read).
export const KINDS = [["build", "Build"], ["investigate", "Investigate"], ["debug", "Run & debug"], ["research", "Research"], ["orchestrate", "Orchestrate"], ["chat", "Chat"]];
export function kindOf(s) {
  const c = s.tc, n = c ? c.edit + c.read + c.bash + c.web + c.agent + c.other : 0;
  if (!n) return "chat";
  if (c.agent >= 3 || c.agent / n >= 0.15) return "orchestrate";
  if (c.edit / n >= 0.1) return "build"; // shells read too (cat, rg), so a tenth of calls being edits is a build
  if (c.web / n >= 0.3) return "research";
  return c.bash > c.read ? "debug" : "investigate";
}

// The GitHub-style year: one cell per day for the last `weeks` weeks (ending this week), by metric.
export function heat(sessions, { weeks, metric, now = Date.now() }) {
  const per = new Map();
  for (const s of sessions) {
    const k = dayKey(s.start), v = per.get(k) ?? { sessions: 0, tokens: 0, cost: 0, by: {} };
    if (!s.sub) { v.sessions++; v.by[s.h] = (v.by[s.h] ?? 0) + 1; }
    v.tokens += s.tok ?? 0; v.cost += s.cost ?? 0;
    per.set(k, v);
  }
  const today = startOfDay(now), first = addDays(today, -(weekday(today) + 7 * (weeks - 1)));
  const days = [];
  for (let t = first; t <= today; t = startOfDay(t + DAY + 3600000)) days.push({ t, ...(per.get(dayKey(t)) ?? { sessions: 0, tokens: 0, cost: 0, by: {} }) });
  const lvl = levels(days.map((d) => d[metric]));
  return days.map((d) => ({ ...d, wd: weekday(d.t), level: lvl(d[metric]) }));
}

// Everything else the panel draws, for sessions started in [from, to) by the chosen harnesses (and, with a
// selection, only those `keep(start)` accepts; `days` is then how many days it covers).
export function summarize(all, { from, to, harnesses, sameRepos = false, kind = null, keep = () => true, days: n = null }) {
  const pick = (a, b) => all.filter((s) => s.start >= a && s.start < b && harnesses.has(s.h) && keep(s.start));
  const ss = pick(from, to), top = ss.filter((s) => !s.sub);
  const days = n ?? Math.max(1, Math.round((startOfDay(to - 1) - startOfDay(from)) / DAY) + 1);

  // Tiles. Active days and the streak count top-level sessions; the streak may end yesterday.
  const active = new Set(top.map((s) => dayKey(s.start)));
  let streak = 0, t = startOfDay(to - 1);
  if (!active.has(dayKey(t))) t = startOfDay(t - DAY / 2);
  while (active.has(dayKey(t))) { streak++; t = startOfDay(t - DAY / 2); }
  const tin = sum(ss, (s) => s.tin), tcr = sum(ss, (s) => s.tcr);
  const tiles = {
    sessions: top.length, prev: pick(from - (to - from), from).filter((s) => !s.sub).length,
    activeDays: active.size, days, streak,
    tokens: sum(ss, (s) => s.tok), cacheHit: tin + tcr ? tcr / (tin + tcr) : null,
    cost: sum(ss, (s) => s.cost), costKnown: ss.some((s) => s.cost != null),
  };
  // Where tokens go (sub-agents included), and each harness' share of runs, tokens and recorded spend.
  const mix = mixOf(ss);
  const split = {};
  for (const s of ss) {
    const x = (split[s.h] ??= { runs: 0, tok: 0, cost: 0 });
    if (!s.sub) x.runs++;
    x.tok += s.tok ?? 0; x.cost += s.cost ?? 0;
  }

  // Tokens over time by harness: days up to a month, weeks beyond.
  const step = days <= 31 ? DAY : 7 * DAY;
  const buckets = [];
  for (let t = startOfDay(from); t < to; t = startOfDay(t + step + 3600000)) buckets.push({ t, by: {} });
  for (const s of ss) {
    let b = null;
    for (const x of buckets) if (x.t <= s.start) b = x; else break;
    if (b) b.by[s.h] = (b.by[s.h] ?? 0) + (s.tok ?? 0);
  }

  // Models by tokens (each owned by the harness that spent most on it), and effort by harness.
  const models = new Map();
  for (const s of ss) for (const [m, n] of Object.entries(s.models ?? {})) {
    const e = models.get(m) ?? { model: m, tokens: 0, by: {} };
    e.tokens += n; e.by[s.h] = (e.by[s.h] ?? 0) + n;
    models.set(m, e);
  }
  const total = sum([...models.values()], (m) => m.tokens) || 1;
  const modelRows = [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8)
    .map((m) => ({ ...m, share: m.tokens / total, h: Object.entries(m.by).sort((a, b) => b[1] - a[1])[0][0] }));
  const effort = {};
  for (const s of top) { const e = (effort[s.h] ??= {}); e[s.effort ?? "default"] = (e[s.effort ?? "default"] ?? 0) + 1; }

  // When work starts: weekday x hour.
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of top) punch[weekday(s.start)][new Date(s.start).getHours()]++;
  const rhythm = rhythmOf(top, from, to);

  // Comparison per harness x main model (3+ runs), optionally for one kind of work. Same repos: only repos
  // two or more harnesses worked in, so a harness isn't judged on easier work than another.
  const kinds = {};
  for (const s of top) kinds[kindOf(s)] = (kinds[kindOf(s)] ?? 0) + 1;
  let pool = kind ? top.filter((s) => kindOf(s) === kind) : top;
  if (sameRepos) {
    const hs = new Map();
    for (const s of pool) if (s.repo) (hs.get(s.repo) ?? hs.set(s.repo, new Set()).get(s.repo)).add(s.h);
    pool = pool.filter((s) => s.repo && hs.get(s.repo).size > 1);
  }
  const groups = new Map();
  for (const s of pool) { const k = `${s.h}\u0000${topModel(s)}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(s); }
  const score = [...groups].filter(([, g]) => g.length >= 3).map(([k, g]) => {
    const [h, model] = k.split("\u0000"), known = g.filter((s) => s.commits != null), ok = g.filter(clean).length;
    const costed = g.filter((s) => s.cost != null), costedOk = costed.filter(clean).length, priced = costed.length >= 3;
    const spend = sum(costed, (s) => s.cost), m = mixOf(g), tools = sum(g, (s) => s.tools);
    return {
      h, model, n: g.length,
      clean: wilson(ok, g.length),
      commit: wilson(known.filter((s) => s.commits > 0).length, known.length),
      // What one clean run costs you: all spend over the clean runs (failed runs are paid for too).
      cps: priced && costedOk ? spend / costedOk : null,
      tps: ok ? sum(g, (s) => s.tok) / ok : null,
      loops: median(g.map((s) => s.tools ?? 0)),
      medTok: median(g.map((s) => s.tok ?? 0)),
      // Cost anatomy: the token mix behind the spend, what a token and an output token cost, and how
      // much context is read per token written (agent loops re-read their context every step).
      mix: m,
      per1M: priced ? spend / Math.max(1, sum(costed, (s) => s.tok)) * 1e6 : null,
      per1kOut: priced ? spend / Math.max(1, sum(costed, (s) => s.tout)) * 1e3 : null,
      readPerOut: m.tout ? (m.tin + m.tcw + m.tcr) / m.tout : null,
      perCommit: priced && costed.some((s) => s.commits > 0) ? spend / costed.filter((s) => s.commits > 0).length : null,
      cacheHit: m.tin + m.tcr ? m.tcr / (m.tin + m.tcr) : null,
      toolErr: tools ? sum(g, (s) => s.toolErr) / tools : null,
    };
  }).sort((a, b) => b.clean.lo - a.clean.lo);
  // A winner only when its whole interval clears the runner-up's.
  const best = score.length > 1 && score[0].clean.lo > score[1].clean.hi ? score[0] : null;

  return { tiles, mix, split, step, buckets, models: modelRows, effort, punch, rhythm, kinds, score, best };
}

// What the work delivered in [from, to): your commits and lines, PRs, worktrees, per day or week, per repo.
export function outputOf(out, { from, to, step, keep = () => true }) {
  const commits = (out?.commits ?? []).filter((c) => c.t >= from && c.t < to && keep(c.t));
  const prs = (out?.prs ?? []).filter((p) => p.created >= from && p.created < to && keep(p.created));
  const merged = (out?.prs ?? []).filter((p) => p.merged && p.merged >= from && p.merged < to && keep(p.merged));
  const buckets = [];
  for (let t = startOfDay(from); t < to; t = startOfDay(t + step + 3600000)) buckets.push({ t, commits: 0, add: 0, del: 0, merged: 0 });
  const into = (ms) => { let b = null; for (const x of buckets) if (x.t <= ms) b = x; else break; return b; };
  for (const c of commits) { const b = into(c.t); if (b) { b.commits++; b.add += c.add; b.del += c.del; } }
  for (const p of merged) { const b = into(p.merged); if (b) b.merged++; }
  const repos = new Map();
  for (const c of commits) { const r = repos.get(c.repo) ?? repos.set(c.repo, { repo: c.repo, commits: 0, add: 0, del: 0 }).get(c.repo); r.commits++; r.add += c.add; r.del += c.del; }
  const trees = out?.worktrees ?? [];
  return {
    commits: commits.length, add: sum(commits, (c) => c.add), del: sum(commits, (c) => c.del),
    activeDays: new Set(commits.map((c) => dayKey(c.t))).size,
    opened: prs.length, merged: merged.length, mergeHours: median(merged.map((p) => (p.merged - p.created) / 3600000)),
    worktrees: sum(trees, (w) => w.n), treeRepos: trees.length, buckets,
    repos: [...repos.values()].sort((a, b) => b.commits - a.commits).slice(0, 8),
    recent: [...(out?.prs ?? [])].filter((p) => p.created < to).sort((a, b) => b.created - a.created).slice(0, 5),
  };
}

// Tokens by kind: fresh input, cache writes, cache reads, output (nulls, where a harness doesn't split, count 0).
export const mixOf = (ss) => ({ tin: sum(ss, (s) => s.tin), tcw: sum(ss, (s) => s.tcw), tcr: sum(ss, (s) => s.tcr), tout: sum(ss, (s) => s.tout) });

// Session lengths, the weekly shape, and how many agents ran at once.
// ponytail: a run counts as at most 8h, because a resumed session's start-to-end spans the days in between.
export const LENGTHS = [[5, "<5m"], [15, "5–15m"], [30, "15–30m"], [60, "30m–1h"], [120, "1–2h"], [240, "2–4h"], [Infinity, "4h+"]];
export function rhythmOf(top, from = null, to = null) {
  const mins = top.map((s) => Math.min(480, Math.max(0, (s.end - s.start) / 60000))); // resumed runs span days: 8h at most
  const lengths = LENGTHS.map(([max], i) => mins.filter((m) => m < max && (i === 0 || m >= LENGTHS[i - 1][0])).length);
  const events = top.flatMap((s) => [[s.start, 1], [Math.min(s.end, s.start + 8 * 3600000), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const peak = new Map();
  let cur = 0;
  for (const [t, d] of events) { cur += d; if (d > 0) peak.set(dayKey(t), Math.max(peak.get(dayKey(t)) ?? 0, cur)); }
  const peaks = [...peak.values()];
  const weekdays = Array(7).fill(0);
  for (const s of top) weekdays[weekday(s.start)]++;
  // Every day of the period with its peak (0 when nothing ran), for the "agents at once" strip.
  const daily = [];
  if (from != null) for (let t = startOfDay(from); t < to; t = startOfDay(t + DAY + 3600000)) daily.push({ t, n: peak.get(dayKey(t)) ?? 0 });
  return {
    lengths, medianMin: median(mins), longestMin: mins.length ? Math.max(...mins) : 0,
    perDay: peak.size ? top.length / peak.size : 0, weekdays, weekend: top.length ? (weekdays[5] + weekdays[6]) / top.length : 0,
    peakParallel: peaks.length ? Math.max(...peaks) : 0, typicalParallel: median(peaks) ?? 0, daily,
  };
}

// A selection: days (local midnights) or slots of the week (weekday * 24 + hour). A target is what one press
// covers: days [first, last]; slots [[weekday, weekday], [hour, hour]] (a cell, an hour row, a weekday column).
// span(a, b): everything between two targets, as a drag or shift-click draws it.
export function span(kind, a, b) {
  const out = [];
  if (kind === "days") for (let t = Math.min(a[0], b[0]); t <= Math.max(a[1], b[1]); t = addDays(t, 1)) out.push(t);
  else for (let d = Math.min(a[0][0], b[0][0]); d <= Math.max(a[0][1], b[0][1]); d++)
    for (let h = Math.min(a[1][0], b[1][0]); h <= Math.max(a[1][1], b[1][1]); h++) out.push(d * 24 + h);
  return out;
}
// Whether a moment falls in the selection.
export const keepOf = ({ kind, keys }) => (kind === "days" ? (ms) => keys.has(startOfDay(ms)) : (ms) => keys.has(weekday(ms) * 24 + new Date(ms).getHours()));

// The tab ← / → move to (wrapping), or null while a date field has the caret: there they move the caret.
export function tabAfter(tabs, cur, key, typing) {
  if (typing) return null;
  const i = tabs.findIndex(([id]) => id === cur);
  return tabs[(i + (key === "right" ? 1 : tabs.length - 1)) % tabs.length][0];
}
