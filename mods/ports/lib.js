// Ports' decisions, as pure functions over `lsof`/`ps` text and Herdr's terminals(): which servers are listening,
// which agent owns each, and how a row reads. main.js does the IO and the drawing; lib.test.js pins every rule.

// ---- Parsers ----

// `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` -> [{ pid, command, host, port }], one per distinct pid+host+port.
// -F prints one field a line: p<pid> starts a process, c<command>, f<fd>, n<name>. Only "host:port" names count.
export function parseLsof(text) {
  const out = [], seen = new Set();
  let pid = 0, command = "";
  for (const line of (text ?? "").split("\n")) {
    const tag = line[0], v = line.slice(1);
    if (tag === "p") { pid = Number(v); command = ""; }
    else if (tag === "c") command = v;
    else if (tag === "n" && pid) {
      const m = /^(.+):(\d+)$/.exec(v);
      if (!m) continue;
      const key = `${pid}|${m[1]}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, host: m[1], port: Number(m[2]) });
    }
  }
  return out;
}

// `lsof -a -p <pids> -d cwd -Fpn` -> Map pid -> folder.
export function parseCwds(text) {
  const out = new Map();
  let pid = 0;
  for (const line of (text ?? "").split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// ps's elapsed time, [[dd-]hh:]mm:ss -> seconds; 0 when it isn't one.
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((s ?? "").trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

// `ps -axo pid=,ppid=,etime=,comm=` -> Map pid -> { pid, ppid, age, comm }. comm is last: on macOS it's a full path
// that may hold spaces.
export function parsePs(text) {
  const out = new Map();
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, ppid: Number(m[2]), age: parseEtime(m[3]), comm: m[4].trim() });
  }
  return out;
}

// ---- Ownership ----

const DOCKER = /^(com\.docker\.|vpnkit|OrbStack)/; // Docker Desktop / OrbStack: they publish containers' ports
const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const MAX_HOPS = 64;

export const basename = (path) => (path ?? "").split("/").filter(Boolean).pop() ?? "";
const inside = (path, root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

// Claude Code names a project's folders by its path with every non-alphanumeric character as "-".
export const slug = (path) => (path ?? "").replace(/[^A-Za-z0-9]/g, "-");

// A Claude Code scratchpad, <temp>/claude-<uid>/<slug>/…: the slug of the project it belongs to.
export function scratchSlug(cwd) {
  if (!cwd || !TEMP_ROOTS.some((r) => cwd.startsWith(r))) return null;
  return /\/claude-\d+\/([^/]+)/.exec(cwd)?.[1] ?? null;
}

// What owner() needs from Herdr's terminals(), for this computer's live terminals only (a remote terminal's pid is
// another machine's). roots: Map folder -> its git top-level, or null when it isn't in a repo.
//   byPid: shell pid and foreground pid -> address; fg: agents' foreground pids (their own ports are hidden);
//   areas: the folder each terminal claims for a server with no terminal above it.
// A live terminal on this computer. Remote ones carry a machine and a "<machine>/" address (AGENTS.md); either marks
// one, since a remote pid can equal a local one.
export const isLocal = (t) => t.state === "live" && t.machine == null && !String(t.address ?? "").includes("/");

// `git -C <dir> rev-parse --show-toplevel`: the top-level, null for a folder that isn't in a repo (exit 128 saying so),
// undefined for anything else (a timeout, a failed exec): not remembered, so the next poll asks again.
export function rootOf(r) {
  if (r?.code === 0) return r.stdout.trim() || undefined;
  return r?.code === 128 && /not a git repository/i.test(r.stderr ?? "") ? null : undefined;
}

export function ownerContext({ terminals, roots, home }) {
  const local = (terminals ?? []).filter(isLocal);
  const byPid = new Map(), fg = new Set(), areas = [];
  const strip = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  for (const t of local) {
    if (t.pid) byPid.set(t.pid, t.address);
    if (t.foreground?.pid) {
      byPid.set(t.foreground.pid, t.address);
      if (t.program?.agent || t.report) fg.add(t.foreground.pid);
    }
    const folder = t.foreground?.cwd ?? t.cwd;
    if (!folder) continue;
    const top = roots?.get(folder) ?? null;
    const root = strip(top ?? folder);
    if (root === strip(home ?? "") || root === "/") continue; // ~ or / would claim every orphan on the machine
    areas.push({ root, exact: !top, slug: slug(folder), address: t.address, seq: t.status_ms ?? 0 });
  }
  return { byPid, fg, areas };
}

const latest = (list) => list.reduce((a, b) => (b.seq > a.seq ? b : a));

// Who owns a process: "sure" (a terminal is on its parent chain), "docker", "probable" (its folder is inside a
// terminal's worktree, or it's that agent's Claude scratchpad), else "orphan".
export function owner(pid, procs, cwd, ctx) {
  const seen = new Set();
  for (let p = pid, hops = 0; p > 1 && hops < MAX_HOPS && !seen.has(p); hops++) {
    if (ctx.byPid.has(p)) return { kind: "sure", address: ctx.byPid.get(p) };
    seen.add(p);
    const proc = procs.get(p);
    if (!proc) break;
    p = proc.ppid;
  }
  if (DOCKER.test(basename(procs.get(pid)?.comm))) return { kind: "docker", address: null };
  const by = startedBy(pid, procs, cwd);
  if (by.app || (by.agent && !by.left)) return { kind: "orphan", address: null }; // another app's agent: not a guess's
  if (cwd) {
    const hits = ctx.areas.filter((a) => (a.exact ? cwd === a.root : inside(cwd, a.root)));
    if (hits.length) {
      const deepest = Math.max(...hits.map((a) => a.root.length));
      return { kind: "probable", address: latest(hits.filter((a) => a.root.length === deepest)).address };
    }
    const s = scratchSlug(cwd);
    const mine = s ? ctx.areas.filter((a) => a.slug === s) : [];
    if (mine.length) return { kind: "probable", address: latest(mine).address };
  }
  return { kind: "orphan", address: null };
}

// Who started a process Herdr doesn't own, so a row never just says "no agent": the agent CLI on its parent chain
// (claude, codex…), the app at the chain's top (/Applications/<App>.app, never Herdr), or, when its parent is gone,
// the Claude session whose scratchpad it was left in. place: its worktree's name, else its folder's.
const AGENT_NAMES = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "pi", omp: "omp" };
const APP = /^(?:\/System|\/Users\/[^/]+)?\/Applications\/(?:Utilities\/)?([^/]+)\.app\//;
export function startedBy(pid, procs, cwd) {
  let agent = null, app = null;
  const seen = new Set([pid]);
  for (let p = procs.get(pid)?.ppid, hops = 0; p > 1 && hops < MAX_HOPS && !seen.has(p) && !app; hops++) {
    seen.add(p);
    const comm = procs.get(p)?.comm ?? "";
    agent ??= AGENT_NAMES[basename(comm).replace(/^-/, "")] ?? null;
    const name = APP.exec(comm)?.[1];
    if (name && !name.startsWith("Herdr")) app = name;
    p = procs.get(p)?.ppid;
  }
  const scratch = scratchSlug(cwd);
  const left = !agent && !app && procs.get(pid)?.ppid === 1;
  return { agent: agent ?? (left && scratch ? "Claude" : null), app, left,
    place: /\/worktrees\/([^/]+)/.exec(cwd ?? "")?.[1] ?? (scratch ? /-worktrees-(.+)$/.exec(scratch)?.[1] ?? null : basename(cwd) || null) };
}

// startedBy as a row reads it ("Claude app", "Codex in iTerm", "left by Claude Code"); full adds the place (the card).
export function byLine(by, full = false) {
  const line = by.app ? (by.agent ? `${by.agent} in ${by.app}` : `${by.app} app`)
    : by.left ? (by.agent ? `left by ${by.agent}` : by.place ? `left running in ${by.place}` : "left running")
    : by.agent ?? (by.place ? `in ${by.place}` : "outside Herdr");
  return full && by.place && !line.includes(by.place) ? `${line} · ${by.place}` : line;
}

// ---- Servers (the rows) ----

const AGENT_BINS = ["claude", "codex", "omp", "pi", "opencode"];
// ponytail: a table of well-known non-web ports and programs, never a request to the port (a one-shot login
// callback would take a probe as its answer). Upgrade: probe on the person's own click.
const DB_PORTS = [5432, 3306, 6379, 27017, 11211];
const DB_NAMES = ["postgres", "mysqld", "redis-server", "mongod", "memcached"];
const DEBUG_PORTS = [9229, 9230]; // node --inspect
const OTHER_PORTS = [5672, 1883, 2181, 9092]; // AMQP, MQTT, ZooKeeper, Kafka: not web, not a database
const ANY = ["*", "0.0.0.0", "[::]"];
const LOOPBACK = (h) => h === "[::1]" || h === "localhost" || h.startsWith("127.");

export function urlFor(hosts, port) {
  const has = (h) => hosts.includes(h);
  const host = hosts.some((h) => ANY.includes(h)) || (has("127.0.0.1") && has("[::1]")) ? "localhost"
    : has("127.0.0.1") ? "127.0.0.1" : has("[::1]") ? "[::1]" : hosts[0];
  return `http://${host}:${port}`;
}

// What a server is, for its icon: "docker", "db", "debug", "other" (not web), else "web".
export function kindOf({ port, command, owner }) {
  if (owner?.kind === "docker") return "docker";
  if (DB_PORTS.includes(port) || DB_NAMES.includes(basename(command))) return "db";
  if (DEBUG_PORTS.includes(port)) return "debug";
  return OTHER_PORTS.includes(port) ? "other" : "web";
}

export const isWeb = (port, comm) => kindOf({ port, command: comm }) === "web";

export const holds = (listeners, pid, port) => listeners.some((l) => l.pid === pid && l.port === port);

export function ago(seconds) {
  const m = Math.floor(seconds / 60);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// An ancestor of pid that also listens on port: then pid is a worker sharing its supervisor's socket.
function heldAbove(pid, port, procs, holders) {
  const seen = new Set([pid]);
  for (let p = procs.get(pid)?.ppid, hops = 0; p > 1 && hops < MAX_HOPS && !seen.has(p); hops++) {
    if (holders.has(`${p}:${port}`)) return true;
    seen.add(p);
    p = procs.get(p)?.ppid;
  }
  return false;
}

// ponytail: an orphan is shown when it runs from home or a temp folder and isn't an agent binary; that drops system
// services. A service started from ~ would show; a name list is the upgrade.
const worthShowing = (o, cwd, comm, home) =>
  o.kind !== "orphan" || (!!cwd && (inside(cwd, home) || TEMP_ROOTS.some((r) => cwd.startsWith(r))) && !AGENT_BINS.includes(basename(comm)));

// Every listening server worth a row: one per pid+port (hosts merged), workers folded into their supervisor, the
// agents' own ports and system services left out.
export function servers({ listeners, procs, cwds, ctx, home }) {
  const groups = new Map();
  for (const l of listeners) {
    const key = `${l.pid}:${l.port}`;
    const g = groups.get(key) ?? { pid: l.pid, port: l.port, command: l.command, hosts: [] };
    groups.set(key, { ...g, hosts: g.hosts.includes(l.host) ? g.hosts : [...g.hosts, l.host] });
  }
  const portsOf = (pid) => [...new Set(listeners.filter((l) => l.pid === pid).map((l) => l.port))].sort((a, b) => a - b);
  const out = [];
  for (const [key, g] of groups) {
    if (heldAbove(g.pid, g.port, procs, groups) || ctx.fg.has(g.pid)) continue;
    const cwd = cwds.get(g.pid) ?? null, comm = procs.get(g.pid)?.comm ?? g.command;
    const o = owner(g.pid, procs, cwd ?? undefined, ctx);
    if (!worthShowing(o, cwd, comm, home)) continue;
    out.push({ key, pid: g.pid, port: g.port, ports: portsOf(g.pid), command: basename(comm) || g.command, hosts: g.hosts,
      url: urlFor(g.hosts, g.port), web: isWeb(g.port, comm), kind: kindOf({ port: g.port, command: comm, owner: o }),
      network: g.hosts.some((h) => ANY.includes(h) || !LOOPBACK(h)), age: procs.get(g.pid)?.age ?? 0, cwd, owner: o,
      by: o.kind === "orphan" ? startedBy(g.pid, procs, cwd) : null });
  }
  return out;
}

export function sortServers(list) {
  const orphan = (s) => s.owner.kind === "orphan";
  return [...list].sort((a, b) => orphan(a) - orphan(b) || (orphan(a) ? b.age - a.age : a.port - b.port));
}

// ---- The block ----

export const ROW_H = 30, HEADER_H = 41, EMPTY_H = 32, MAX_ROWS = 5, FOOT_H = 32;

// The block's height: Ports' rows, then the sidebar's last row, "Working N" (FOOT_H). A function of the row count
// only, so it can't chase Inbox's fitSpaces in a resize loop.
export const blockHeight = (rows, folded) =>
  folded ? 0 : (rows ? HEADER_H + Math.min(rows, MAX_ROWS) * ROW_H : EMPTY_H) + FOOT_H;

// Sub-agents an agent started itself (`hc run --bg`): no tab, so agents() misses them, but a working one still counts
// in "Working N". A copy of mods/inbox/lib.js subAgents (mods don't import across folders), kept identical.
export const subAgents = (terminals, known) => terminals
  .filter((x) => x.state === "live" && x.parent && (x.program?.agent || x.report) && !known.has(x.address))
  .map((x) => ({ address: x.address, status: x.status === "error" ? "blocked" : x.status, program: x.program, title: x.title || x.name,
    space_name: (x.foreground?.cwd ?? x.cwd ?? "").split("/").filter(Boolean).pop(), sub: true }));

// ---- The card ----

// The port card's measures (mods/port-card draws with the same numbers): it opens as a centred dialog, which needs
// its height up front, so the height follows the lines the card will show.
export const CARD = { width: 560, pad: 24, gap: 16, header: 22, url: 34, line: 20, task: 20, fieldGap: 10, buttons: 34 };

export function cardHeight(server, who) {
  const owned = who.kind === "sure" || who.kind === "probable";
  const fields = [true, !!who.branch, true, !!server.cwd && server.cwd !== who.folder, true, true, server.ports.length > 1].filter(Boolean).length;
  const body = fields * CARD.line + (fields - 1) * CARD.fieldGap + (owned && who.task ? CARD.task : 0);
  return 2 * CARD.pad + CARD.header + CARD.url + body + CARD.buttons + 3 * CARD.gap;
}
