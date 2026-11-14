// Host-free logic for pr-review: unified diff parsing, line selection → GitHub
// review comment payload, review threads → diff rows. Tested by lib.test.js.

// A name as git prints it: a tab ends one holding a space (on ---/+++), and one with special bytes comes quoted,
// C-style: "caf\303\251.md" (octal UTF-8), \t, \", \\.
const ESC = { t: "\t", n: "\n", r: "\r" };
function unquote(p) {
  p = p.replace(/\t$/, "");
  if (!p.startsWith('"')) return p;
  const s = p.slice(1, -1).replace(/%/g, "%25").replace(/\\(?:([0-7]{3})|(.))/g, (_, oct, c) => (oct ? `%${parseInt(oct, 8).toString(16).padStart(2, "0")}` : ESC[c] ?? c));
  try { return decodeURIComponent(s); } catch { return s; } // bytes that aren't UTF-8: the name with them as %XX
}
const strip = (p) => (p === "/dev/null" ? null : unquote(p).replace(/^[ab]\//, ""));

// Unified diff (git / gh pr diff) → files with flat rows:
// { kind: "hunk" | "context" | "add" | "del", old, new, text, hunk }.
export function parseDiff(text) {
  const files = [];
  let f = null, oldNo = 0, newNo = 0, hunk = -1;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git ("?a\/.*?"?) ("?b\/.*"?)$/);
      f = { path: m ? strip(m[2]) : line.slice(11), oldPath: m ? strip(m[1]) : null, status: "modified", binary: false, additions: 0, deletions: 0, rows: [] };
      files.push(f); hunk = -1;
    } else if (!f) continue;
    else if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (!m) continue;
      oldNo = +m[1]; newNo = +m[2]; hunk++;
      f.rows.push({ kind: "hunk", old: null, new: null, text: line, hunk });
    } else if (hunk >= 0 && line[0] === "+") { f.rows.push({ kind: "add", old: null, new: newNo++, text: line.slice(1), hunk }); f.additions++; }
    else if (hunk >= 0 && line[0] === "-") { f.rows.push({ kind: "del", old: oldNo++, new: null, text: line.slice(1), hunk }); f.deletions++; }
    else if (hunk >= 0 && line[0] === " ") f.rows.push({ kind: "context", old: oldNo++, new: newNo++, text: line.slice(1), hunk });
    else if (hunk >= 0) continue; // "\ No newline at end of file", trailing blank
    else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = unquote(line.slice(12)); }
    else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) f.binary = true;
    else if (line.startsWith("--- ")) f.oldPath = strip(line.slice(4)) ?? f.oldPath;
    else if (line.startsWith("+++ ")) f.path = strip(line.slice(4)) ?? f.path;
  }
  for (const x of files) if (x.status !== "renamed") x.oldPath = x.status === "added" ? null : x.path;
  return files;
}

// The side a row is commented on: deleted lines on the old side, the rest on the new.
export const sideOf = (row) => (row.kind === "del" ? "LEFT" : "RIGHT");
export const lineOf = (row, side) => (side === "LEFT" ? row.old : row.new);

// The unchanged lines a diff leaves out before rows[at] (a hunk header), or after the last hunk (at = rows.length):
// new-side lines from..to (to null: to the file's end; to < from: none), `old` being from's old-side number.
// Between hunks both sides run in step, so the gap starts one past the last numbers seen.
export function gapBefore(rows, at) {
  let old = 0, nu = 0;
  for (let i = 0; i < at; i++) { old = rows[i].old ?? old; nu = rows[i].new ?? nu; }
  const m = rows[at]?.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/);
  return { from: nu + 1, to: m ? +m[1] - (m[2] === "0" ? 0 : 1) : null, old: old + 1 }; // "+4,0": nothing added, after line 4
}

// That gap as context rows, from the new side's lines; `extra`: not part of the diff, so not commentable.
export function hiddenRows(rows, lines, at) {
  const g = gapBefore(rows, at), out = [];
  for (let n = g.from; n <= (g.to ?? lines.length); n++) out.push({ kind: "context", old: g.old + n - g.from, new: n, text: lines[n - 1] ?? "", hunk: -1, extra: true });
  return out;
}

// A selection from anchor row to focus row (indices into file.rows), kept on the
// anchor's side and inside its hunk (GitHub refuses ranges across hunks).
// Returns { side, start, end, from, to } (from/to: row indices) or null.
export function selectRange(rows, anchor, focus = anchor) {
  const a = rows[anchor];
  if (!a || a.kind === "hunk" || a.extra) return null;
  const side = sideOf(a);
  const lo = Math.min(anchor, focus), hi = Math.max(anchor, focus);
  let from = anchor, to = anchor;
  for (let i = anchor - 1; i >= lo && rows[i].hunk === a.hunk; i--) if (lineOf(rows[i], side) != null) from = i;
  for (let i = anchor + 1; i <= hi && rows[i].hunk === a.hunk; i++) if (lineOf(rows[i], side) != null) to = i;
  return { side, start: lineOf(rows[from], side), end: lineOf(rows[to], side), from, to };
}

// Selection → the location fields of POST pulls/{n}/comments; given the rows, also both line numbers of the first and
// last row, their `pos` and the old path (GitLab places a note by old and new line; github.js drops them).
export function commentPayload(path, sel, rows, oldPath) {
  const p = { path, line: sel.end, side: sel.side };
  if (sel.start !== sel.end) Object.assign(p, { start_line: sel.start, start_side: sel.side });
  const end = (i) => ({ old: rows[i].old, new: rows[i].new, pos: linePos(rows, i) });
  if (rows) Object.assign(p, { old_path: oldPath ?? path, anchor: { start: end(sel.from), end: end(sel.to) } });
  return p;
}

// rows[i]'s place on both sides, [old, new], as GitLab's line codes count: its own numbers, and on the side it isn't
// on, the next line there (one past the last seen, else the hunk's start).
function linePos(rows, i) {
  let { old, new: nu } = rows[i];
  for (let j = i - 1; j >= 0 && (old == null || nu == null); j--) {
    const m = rows[j].kind === "hunk" && rows[j].text?.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    old ??= m ? +m[1] : rows[j].old != null ? rows[j].old + 1 : null;
    nu ??= m ? +m[2] : rows[j].new != null ? rows[j].new + 1 : null;
  }
  return [old, nu];
}

// Review threads → { at: Map(rowIndex → threads), loose: threads without a row }.
// A thread hangs under its last line; outdated ones (line null) are loose.
export function anchorThreads(rows, threads) {
  const at = new Map(), loose = [];
  for (const t of threads) {
    const i = t.line == null ? -1 : rows.findIndex((r) => lineOf(r, t.diffSide) === t.line);
    if (i < 0) loose.push(t);
    else at.set(i, [...(at.get(i) ?? []), t]);
  }
  return { at, loose };
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

// First index whose top + height passes y (tops ascending).
export function firstVisible(tops, heights, y) {
  let lo = 0, hi = tops.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m] + heights[m] <= y) lo = m + 1; else hi = m; }
  return lo;
}

// A diff line as drawn: tabs as four spaces.
export const shown = (text) => text.replace(/\t/g, "    ");

// Find in a diff: every match of q in the lines as drawn, files in `order` (the tree's), hunk headers skipped,
// and each review comment whose author or text has q, where its card sits (loose ones first, as drawn).
// Smart case: an upper-case letter in q makes it exact. → [{ fi, ri, start, end } | { fi, th, ci }].
export function findAll(files, q, order = files.map((_, i) => i), threads = []) {
  if (!q) return [];
  const exact = q !== q.toLowerCase(), low = (s) => (exact ? s : s.toLowerCase()), has = (s) => low(s).includes(q), out = [];
  const say = (fi, th) => th.comments.forEach((c, ci) => { if (has(`${c.author?.login ?? ""}\n${splitTag(c.body).text}`)) out.push({ fi, th: th.id, ci }); });
  for (const fi of order) {
    const { at, loose } = anchorThreads(files[fi].rows, threads.filter((t) => t.path === files[fi].path));
    loose.forEach((th) => say(fi, th));
    files[fi].rows.forEach((r, ri) => {
      const hay = r.kind === "hunk" ? "" : low(shown(r.text));
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push({ fi, ri, start: i, end: i + q.length });
      (at.get(ri) ?? []).forEach((th) => say(fi, th));
    });
  }
  return out;
}

// The conversation's entries whose author or text holds q, as { ti: index, id }; the same smart case as findAll.
export function findTalk(talk, q) {
  const exact = q !== q.toLowerCase();
  return talk.flatMap((c, ti) => { const s = `${c.author ?? ""}\n${splitTag(c.body).text}`; return (exact ? s : s.toLowerCase()).includes(q) ? [{ ti, id: c.id }] : []; });
}

// GitHub @mentions (users, org/teams) as profile links, so people stand apart from the prose; code is left alone.
export const mentions = (md) => md.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+)/).map((p, i) => (i % 2 ? p
  : p.replace(/(^|[^\w`/[@.-])@([A-Za-z0-9][A-Za-z0-9-]*)(?:\/([\w.-]*\w))?(?![\w-])/g, (_, pre, u, team) =>
    `${pre}[@${u}${team ? `/${team}` : ""}](https://github.com/${team ? `orgs/${u}/teams/${team}` : u})`))).join("");

/** Changed files → folder-tree rows: folders first, then files, each by name; a folder holding only one
 *  folder folds into it ("src/lib"). Rows: { dir: true, name, depth } | { fi, name, depth } (fi: index in files). */
export function fileTree(files) {
  const node = () => ({ dirs: new Map(), files: [] }), root = node();
  files.forEach((f, fi) => {
    const parts = f.path.split("/"), name = parts.pop();
    let n = root;
    for (const p of parts) n = n.dirs.get(p) ?? n.dirs.set(p, node()).get(p);
    n.files.push({ fi, name });
  });
  const rows = [], byName = (a, b) => (a[0] ?? a.name).localeCompare(b[0] ?? b.name);
  const walk = (n, depth) => {
    for (let [name, d] of [...n.dirs].sort(byName)) {
      while (!d.files.length && d.dirs.size === 1) { const [[k, v]] = d.dirs; name += `/${k}`; d = v; }
      rows.push({ dir: true, name, depth });
      walk(d, depth + 1);
    }
    for (const f of n.files.sort(byName)) rows.push({ fi: f.fi, name: f.name, depth });
  };
  walk(root, 0);
  return rows;
}

/** Review labels, sent as a shields.io badge on its own line above the comment so GitHub shows it:
 *  [key, label, badge colour, the theme colour that matches it]. */
export const TAGS = [["statement", "Statement", "green", "ansi2"], ["question", "Question", "blue", "ansi4"], ["nit", "Nit", "purple", "ansi5"], ["minor", "Minor", "yellow", "ansi3"], ["major", "Major", "red", "ansi1"]];
const BADGE = /^!\[(statement|question|nit|minor|major)\]\(https:\/\/img\.shields\.io\/badge\/[^)\s]*\)\s*/;
export const tagBody = (tag, text) => (tag ? `![${tag}](https://img.shields.io/badge/${tag}-${TAGS.find(([k]) => k === tag)[2]})\n${text}` : text);
export function splitTag(body) {
  const m = BADGE.exec(body ?? "");
  return m ? { tag: m[1], text: body.slice(m[0].length) } : { tag: null, text: body ?? "" };
}

// Side by side: each row's place as { l, r } (row indices, null for blank) or { hunk }. Context sits on both sides;
// a run of deletions pairs line for line with the additions that follow it.
export function pairRows(rows) {
  const out = [];
  let dels = [], adds = [];
  const flush = () => { for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ l: dels[i] ?? null, r: adds[i] ?? null }); dels = []; adds = []; };
  rows.forEach((r, i) => {
    if (r.kind === "del") { if (adds.length) flush(); dels.push(i); }
    else if (r.kind === "add") adds.push(i);
    else { flush(); out.push(r.kind === "hunk" ? { hunk: i } : { l: i, r: i }); }
  });
  flush();
  return out;
}

// ← / → walk the PR list's Open · Closed · All only while ↑ / ↓ walk that list: once a PR's files are open (the rail
// may still show beside them) the arrows are the files', and the search box keeps ← / → for its caret.
export const tabArrows = ({ listShows, filesOpen, inSearch }) => listShows && !filesOpen && !inSearch;
