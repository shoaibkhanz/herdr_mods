// The worktree tree, pure (no herdr import) so it can be tested.

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// `git worktree list --porcelain`: one block per worktree; branch without refs/heads/, null when detached.
export function parseWorktrees(text) {
  return text.split(/\n\n+/).filter((b) => b.startsWith("worktree ")).map((b) => {
    const lines = b.split("\n");
    const branch = lines.find((l) => l.startsWith("branch "));
    return {
      path: lines[0].slice(9),
      branch: branch ? branch.slice(7).replace(/^refs\/heads\//, "") : null,
      bare: lines.includes("bare"),
      prunable: lines.some((l) => l.startsWith("prunable")),
    };
  });
}

// `git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads`.
export function parseTrack(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const [name, ...rest] = line.split(" "), t = rest.join(" ");
    if (name) out[name] = { ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0) };
  }
  return out;
}

// ordered() rows ({w, i, g, tree}) -> rows with keys, each repo's worktrees that have no space yet (greyed) after
// the nested spaces of its first main space (a bare repo has none: after its first space). An open worktree is
// matched by path or branch: git and rev-parse can print one path two ways (/tmp vs /private/tmp).
// `archived`: JSON [machine, path] -> the space closed by archiving it (or null); those aren't listed.
export function addWorktrees(rows, trees, folded, archived = {}) {
  const out = [];
  const placed = new Set();
  for (let n = 0; n < rows.length; n++) {
    const r = rows[n];
    if (r.tree) continue; // drawn with its main below
    const row = { ...r, kind: "space", key: `s:${r.w.id}`, kids: 0, parent: null };
    out.push(row);
    if (!r.g || (r.g.linked && !trees[r.g.repo]?.list.some((wt) => wt.bare)) || placed.has(r.g.repo)) continue;
    placed.add(r.g.repo);
    const kids = [];
    for (let k = n + 1; k < rows.length && rows[k].tree; k++) kids.push({ ...rows[k], kind: "space", key: `s:${rows[k].w.id}`, kids: 0, parent: row.key });
    const same = rows.filter((s) => s.g?.repo === r.g.repo);
    const tops = new Set(same.map((s) => s.g.top)), branches = new Set(same.map((s) => s.g.branch));
    const on = JSON.parse(r.g.repo)[0];
    const tree = trees[r.g.repo];
    for (const wt of tree?.list ?? []) {
      if (wt.bare || wt.prunable || tops.has(wt.path) || (wt.branch && branches.has(wt.branch))) continue;
      if (JSON.stringify([on, wt.path]) in archived) continue;
      const track = (wt.branch && tree.track[wt.branch]) || { ahead: 0, behind: 0 };
      kids.push({ kind: "wt", key: `p:${JSON.stringify([on, wt.path])}`, parent: row.key, on, path: wt.path, label: wt.branch ?? base(wt.path), ahead: track.ahead, behind: track.behind });
    }
    row.kids = kids.length;
    if (!folded.has(r.w.id)) out.push(...kids);
  }
  return out;
}

// The cursor after a refresh: kept if still there, else the nearest row before it that is, else the first.
export function nearest(keys, old, cur) {
  if (keys.includes(cur)) return cur;
  for (let i = old.indexOf(cur) - 1; i >= 0; i--) if (keys.includes(old[i])) return old[i];
  return keys[0] ?? null;
}

// The worktree a row stands for, for archive and delete: a greyed worktree, or an open space in a linked worktree.
// null for a main checkout (git can't remove it) or a folder outside git.
export function actionTarget(r) {
  if (r.kind === "wt") return { on: r.on, path: r.path, label: r.label, space: null };
  if (!r.g?.linked) return null;
  return { on: JSON.parse(r.g.repo)[0], path: r.g.top, label: r.g.branch, space: r.w.id };
}

// Archived worktrees open again in a space (from ⌘E Jump): not the space the archive closed, which can still be
// on its way out. Their keys leave the archive.
export function reopened(archived, rows) {
  return rows.filter((r) => r.g?.linked).map((r) => [JSON.stringify([JSON.parse(r.g.repo)[0], r.g.top]), r.w.id])
    .filter(([k, id]) => k in archived && archived[k] !== id).map(([k]) => k);
}

// What a row is for the Agents graph's ring (agent-graph lib's ringed): a space, or a worktree no space has open.
export function cursorOf(r) {
  if (r?.kind === "wt") return { kind: "worktree", on: r.on, path: r.path };
  return r?.w ? { kind: "space", id: r.w.id } : null;
}
