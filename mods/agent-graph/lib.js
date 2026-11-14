// Host-free logic: terminals + git facts -> tree, tree -> positioned nodes and edges.

export const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const rank = (s) => RANK[s] ?? 3;
const byRank = (a, b) => a.rank - b.rank || a.name.localeCompare(b.name);
const tail = (p, n = 1) => (p ?? "").split("/").filter(Boolean).slice(-n).join("/") || "/";

// A terminal title without its harness marks: leading status glyphs and a short prompt or name before
// one (pi's "π > ", "π ⁂"), then private-use glyphs (nerd-font icons) anywhere.
export const cleanTitle = (s) =>
  (s ?? "").replace(/^(?:[^\p{L}\p{N}\p{Ps}~/]+|\p{L}{1,2}\s*>\s*|\p{L}{1,2}\s+(?=[\p{S}\p{Co}\u2042]))+/u, "")
    .replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/gu, "").replace(/\s+/g, " ").trim();

// `git rev-parse --path-format=absolute --show-toplevel --git-common-dir --abbrev-ref HEAD` -> facts.
export function parseRevParse(stdout) {
  const [top, common, branch] = stdout.trim().split("\n");
  return top && common ? { top, common, branch: branch === "HEAD" ? null : branch ?? null } : null;
}

// `gh pr list --json ...` -> branch -> newest PR (highest number).
export function prsByBranch(list) {
  const m = new Map();
  for (const p of list) if (!m.has(p.headRefName) || m.get(p.headRefName).number < p.number) m.set(p.headRefName, p);
  return m;
}

// `glab mr list` JSON -> the PR fields prsByBranch and prChip read (GitLab has no review decision here).
const MR_STATE = { opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "CLOSED" };
export const mrsAsPRs = (list) => list.map((m) => ({ number: m.iid, state: MR_STATE[m.state] ?? "OPEN", isDraft: Boolean(m.draft),
  headRefName: m.source_branch, title: m.title, url: m.web_url, reviewDecision: null }));

// The chip a worktree shows for its PR (or none).
export function prChip(pr) {
  if (!pr) return { state: "none", label: "No PR" };
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const review = state === "open" ? { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" }[pr.reviewDecision] : null;
  return { state, review: review ?? null, number: pr.number, title: pr.title ?? "", label: `#${pr.number} ${state}${review ? ` · ${review}` : ""}` };
}

const repoName = (common) => (common.endsWith("/.git") ? tail(common.slice(0, -5)) : tail(common).replace(/\.git$/, ""));

/**
 * items: [{ id, parent, machine, cwd, status, agent, name, ... }]
 * git: (machine, cwd) -> { top, common, branch, ahead, behind } | null (not a repo)
 * prs: (machine, common) -> Map branch -> PR, or undefined while unknown
 * -> repos [{ id, kind, name, machine, rank, worktrees: [{ id, kind, top, branch, path, ahead, behind, pr, rank, agents: [item + rank + children] }] }]
 */
export function buildTree(items, git, prs, { activeOnly = false } = {}) {
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map();
  const nodes = items.map((i) => ({ ...i, children: [] }));
  for (const n of nodes) if (n.parent && ids.has(n.parent) && n.parent !== n.id) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)).push(n);
  // Most urgent status in a subtree; filtered children drop out.
  const settle = (n) => {
    n.children = (kids.get(n.id) ?? []).map(settle).filter(Boolean).sort(byRank);
    n.rank = Math.min(rank(n.status), ...n.children.map((c) => c.rank));
    return activeOnly && n.rank === RANK.idle ? null : n;
  };
  const roots = nodes.filter((n) => !(n.parent && ids.has(n.parent) && n.parent !== n.id)).map(settle).filter(Boolean);

  const repos = new Map();
  for (const n of roots) {
    const g = git(n.machine, n.cwd);
    const rid = g ? `${n.machine ?? ""}|${g.common}` : `${n.machine ?? ""}|none`;
    const repo = repos.get(rid) ?? repos.set(rid, g
      ? { id: rid, kind: "repo", name: repoName(g.common), machine: n.machine, worktrees: new Map() }
      : { id: rid, kind: "none", name: "Not in git", machine: n.machine, worktrees: new Map() }).get(rid);
    const wid = `${n.machine ?? ""}|${g ? g.top : n.cwd ?? "?"}`;
    if (!repo.worktrees.has(wid)) {
      const list = g && prs(n.machine, g.common);
      repo.worktrees.set(wid, g
        ? { id: wid, kind: "worktree", machine: n.machine, top: g.top, branch: g.branch, name: g.branch ?? tail(g.top), path: tail(g.top, 2), ahead: g.ahead ?? 0, behind: g.behind ?? 0, pr: list ? prChip(g.branch && list.get(g.branch)) : null, agents: [] }
        : { id: wid, kind: "folder", machine: n.machine, branch: null, name: tail(n.cwd), path: n.cwd ?? "", pr: null, agents: [] });
    }
    repo.worktrees.get(wid).agents.push(n);
  }
  const out = [...repos.values()].map((r) => {
    const worktrees = [...r.worktrees.values()].map((w) => {
      w.agents.sort(byRank);
      w.rank = Math.min(...w.agents.map((a) => a.rank));
      return w;
    }).sort(byRank);
    return { ...r, worktrees, rank: Math.min(...worktrees.map((w) => w.rank)) };
  });
  return out.sort((a, b) => a.rank - b.rank || (a.kind === "none") - (b.kind === "none") || a.name.localeCompare(b.name));
}

export const SIZE = { repo: { w: 200, h: 64 }, worktree: { w: 252, h: 64 }, agent: { w: 268, h: 64 } };
const GAP_X = 72, ROW = 76, REPO_GAP = 16;
const statusOf = (r) => Object.keys(RANK)[r] ?? "idle";

/**
 * Layered columns: repo | worktree | agent | sub-agent...; each leaf takes a row,
 * parents sit centred on their children. -> { nodes, edges, width, height }
 * nodes: { id, kind, x, y, w, h, data }; edges: { from, to, status, a: {x,y}, b: {x,y} } (right-mid -> left-mid).
 */
export function layout(repos) {
  const nodes = [], edges = [];
  const colX = (c) => (c === 0 ? 0 : c === 1 ? SIZE.repo.w + GAP_X : SIZE.repo.w + SIZE.worktree.w + 2 * GAP_X + (c - 2) * (SIZE.agent.w + GAP_X));
  let y = 0, right = 0;
  const place = (kind, data, col) => {
    const kids = kind === "repo" ? data.worktrees : kind === "worktree" ? data.agents : data.children;
    const placed = kids.map((c) => place(kind === "repo" ? "worktree" : "agent", c, col + 1));
    const s = SIZE[kind];
    const mid = (n) => n.y + n.h / 2;
    const cy = placed.length ? (mid(placed[0]) + mid(placed[placed.length - 1])) / 2 : y + s.h / 2;
    if (!placed.length) y += ROW;
    const n = { id: `${kind[0]}:${data.id}`, kind, x: colX(col), y: cy - s.h / 2, w: s.w, h: s.h, data };
    nodes.push(n);
    right = Math.max(right, n.x + n.w);
    for (const p of placed) edges.push({ from: n.id, to: p.id, status: statusOf(p.data.rank), a: { x: n.x + n.w, y: cy }, b: { x: p.x, y: mid(p) } });
    return n;
  };
  repos.forEach((r, i) => {
    if (i) y += REPO_GAP;
    place("repo", r, 0);
  });
  return { nodes, edges, width: right, height: Math.max(0, y - (ROW - SIZE.agent.h)) };
}

// Two theme colours (#rrggbb) blended, k of `b`: an opaque stand-in for `b` at alpha k over `a`.
export const mix = (a, b, k) => "#" + [1, 3, 5].map((i) =>
  Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("");

// The cards the graph rings (node ids): where the sidebar's cursor is (cursor: { kind: "agent", id } an Inbox card,
// { kind: "space", id } a space -> the worktrees its agents work in, { kind: "worktree", on, path } an unopened one),
// else the focused terminal's agent (foc).
export function ringed(repos, cursor, foc) {
  if (!cursor) return new Set(foc ? [`a:${foc}`] : []);
  if (cursor.kind === "agent") return new Set([`a:${cursor.id}`]);
  if (cursor.kind === "worktree") return new Set([`w:${cursor.on ?? ""}|${cursor.path}`]);
  const inSpace = (a) => a.space === cursor.id || a.children.some(inSpace);
  return new Set(repos.flatMap((r) => r.worktrees).filter((w) => w.agents.some(inSpace)).map((w) => `w:${w.id}`));
}

// Inbox and Spaces each share their cursor (null without the keyboard); while it moves between them both can be
// set for a moment, and the newer one is where it went.
export const sidebarCursor = (inbox, spaces) => (inbox && spaces ? (inbox.at > spaces.at ? inbox : spaces) : inbox ?? spaces ?? null);
