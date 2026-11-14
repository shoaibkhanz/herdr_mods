import { test, expect } from "bun:test";
import { parseLsof, parseCwds, parsePs, parseEtime, slug, scratchSlug, ownerContext, owner,
  urlFor, isWeb, servers, sortServers, holds, ago, blockHeight, subAgents, cardHeight, isLocal, rootOf, kindOf, startedBy, byLine, ownerLines, stopFact, folderLabel } from "./lib.js";
import { LSOF, CWDS, PS, SCRATCH } from "./fixtures.js";

test("parseLsof: one entry per pid+host+port; IPv4/IPv6 sockets of one pid kept apart by host", () => {
  const l = parseLsof(LSOF);
  expect(l.filter((x) => x.pid === 745)).toEqual([{ pid: 745, command: "rapportd", host: "*", port: 49261 }]);
  expect(l.find((x) => x.pid === 1093)).toEqual({ pid: 1093, command: "moshi-hook", host: "127.0.0.1", port: 24543 });
  expect(l.find((x) => x.port === 3000).host).toBe("[::1]");
  expect(l.filter((x) => x.pid === 796).map((x) => x.port)).toEqual([7000, 5000]);
});

test("parseLsof: ignores non-socket name lines (a path from a broader lsof query)", () => {
  expect(parseLsof("p1\ncx\nftxt\nn/usr/lib/dyld\nfcwd\nn/\n")).toEqual([]);
});

test("parsePs: comm keeps its spaces; etime forms", () => {
  expect(parsePs(PS).get(9940)).toEqual({ pid: 9940, ppid: 9939, age: 12 * 3600 + 29 * 60 + 59,
    comm: "/Users/shoaib/Library/Application Support/Claude/claude-code/2.1.325/485fdac4332e/claude.app/Contents/MacOS/claude" });
  expect(parseEtime("03:21")).toBe(201);
  expect(parseEtime("12:29:59")).toBe(12 * 3600 + 29 * 60 + 59);
  expect(parseEtime("05-14:20:36")).toBe(5 * 86400 + 14 * 3600 + 20 * 60 + 36);
});

test("parseCwds: pid -> folder", () => {
  const c = parseCwds(CWDS);
  expect(c.get(745)).toBe("/");
  expect(c.get(8035)).toMatch(/scratchpad\/spike$/);
});

test("parsers: empty or garbage input gives empty results, never throws", () => {
  expect(parseLsof("")).toEqual([]);
  expect(parsePs("x y\n").size).toBe(0);
  expect(parseCwds("").size).toBe(0);
  expect(parseEtime("garbage")).toBe(0);
});

// ---- Ownership ----

const HOME = "/Users/me";
const term = (address, pid, fgPid, folder, extra = {}) => ({ address, state: "live", machine: null, pid,
  foreground: { pid: fgPid, cwd: folder }, cwd: folder, program: { agent: true }, status_ms: 0, ...extra });
const procs = (...rows) => new Map(rows.map(([pid, ppid, comm = "x"]) => [pid, { pid, ppid, age: 60, comm }]));

test("owner: sure through the parent chain, from a grandchild of the agent", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a")], roots: new Map([["/w/a", "/w/a"]]), home: HOME });
  const ps = procs([200, 1], [300, 200], [400, 300], [500, 400]);
  expect(owner(500, ps, "/somewhere/else", ctx)).toEqual({ kind: "sure", address: "t1" });
  expect(owner(300, ps, "/w/a", ctx)).toEqual({ kind: "sure", address: "t1" }); // the agent process itself
});

test("owner: parent pid 1 inside an agent's worktree is probable (Review Focus 2)", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a/src")], roots: new Map([["/w/a/src", "/w/a"]]), home: HOME });
  expect(owner(8035, procs([8035, 1]), "/w/a/web", ctx)).toEqual({ kind: "probable", address: "t1", why: "worktree" });
  expect(owner(8035, procs([8035, 1]), "/w/ab", ctx)).toEqual({ kind: "orphan", address: null }); // a sibling folder, not inside
});

test("owner: nested worktree beats the main checkout that contains it", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a"), term("t2", 210, 310, "/w/a/.claude/worktrees/x")],
    roots: new Map([["/w/a", "/w/a"], ["/w/a/.claude/worktrees/x", "/w/a/.claude/worktrees/x"]]), home: HOME });
  expect(owner(8035, procs([8035, 1]), "/w/a/.claude/worktrees/x/app", ctx)).toEqual({ kind: "probable", address: "t2", why: "worktree" });
  expect(owner(8035, procs([8035, 1]), "/w/a/app", ctx)).toEqual({ kind: "probable", address: "t1", why: "worktree" });
});

test("owner: two agents in one worktree: the one that changed most recently", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a", { status_ms: 5 }), term("t2", 210, 310, "/w/a", { status_ms: 9 })],
    roots: new Map([["/w/a", "/w/a"]]), home: HOME });
  expect(owner(8035, procs([8035, 1]), "/w/a", ctx)).toEqual({ kind: "probable", address: "t2", why: "worktree" });
});

test("owner: an agent in ~ or in a dotfiles repo at ~ claims nothing (Review Focus 1)", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, HOME), term("t2", 210, 310, `${HOME}/.config`)],
    roots: new Map([[HOME, null], [`${HOME}/.config`, HOME]]), home: HOME });
  expect(owner(8035, procs([8035, 1]), `${HOME}/code/x`, ctx)).toEqual({ kind: "orphan", address: null });
});

test("owner: an agent in a folder that isn't a repo matches only that exact folder", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/notes")], roots: new Map([["/w/notes", null]]), home: HOME });
  expect(owner(8035, procs([8035, 1]), "/w/notes", ctx)).toEqual({ kind: "probable", address: "t1", why: "worktree" });
  expect(owner(8035, procs([8035, 1]), "/w/notes/sub", ctx)).toEqual({ kind: "orphan", address: null });
});

test("owner: Claude scratchpad matches the agent whose folder slugs to it", () => {
  const wt = "/Users/shoaib/code/experiments/margo/.claude/worktrees/ai-artifacts-research-6b95a0";
  expect(slug(wt)).toBe("-Users-shoaib-code-experiments-margo--claude-worktrees-ai-artifacts-research-6b95a0");
  expect(scratchSlug(SCRATCH)).toBe(slug(wt));
  expect(scratchSlug("/Users/me/claude-501/x/y")).toBe(null); // not under a temp folder
  const ctx = ownerContext({ terminals: [term("t2", 210, 310, wt)], roots: new Map([[wt, wt]]), home: "/Users/shoaib" });
  expect(owner(8035, parsePs(PS), SCRATCH, ctx)).toEqual({ kind: "probable", address: "t2", why: "scratch" });
});

test("owner: a remote terminal with the same pid claims nothing (Review Focus 4)", () => {
  const ctx = ownerContext({ terminals: [term("box:t9", 200, 300, "/w/a", { machine: "box" })], roots: new Map([["/w/a", "/w/a"]]), home: HOME });
  expect(owner(400, procs([400, 300], [300, 200], [200, 1]), "/w/a", ctx)).toEqual({ kind: "orphan", address: null });
});

test("owner: finished terminals claim nothing", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a", { state: "finished" })], roots: new Map([["/w/a", "/w/a"]]), home: HOME });
  expect(owner(300, procs([300, 200], [200, 1]), "/w/a", ctx).kind).toBe("orphan");
});

test("owner: docker by its process name; a parent cycle or missing parent ends the walk", () => {
  const ctx = ownerContext({ terminals: [], roots: new Map(), home: HOME });
  expect(owner(77, procs([77, 1, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"]), "/", ctx)).toEqual({ kind: "docker", address: null });
  expect(owner(5, procs([5, 6], [6, 5]), "/", ctx)).toEqual({ kind: "orphan", address: null });
  expect(owner(5, procs([5, 999]), undefined, ctx)).toEqual({ kind: "orphan", address: null });
});

// ---- Who started a server Herdr doesn't own (never just "no agent") ----

const MARGO = "/Users/shoaib/code/experiments/margo";
// Recorded 2026-11-14: vite started by an agent in the Claude desktop app, in a margo worktree.
const CLAUDE_APP = procs([86717, 86454, "node"], [86454, 86453, "node"], [86453, 17303, "/Applications/Claude.app/Contents/Helpers/disclaimer"],
  [17303, 1, "/Applications/Claude.app/Contents/MacOS/Claude"]);

test("startedBy: an agent in the Claude desktop app names the app and its worktree", () => {
  const by = startedBy(86717, CLAUDE_APP, `${MARGO}/.claude/worktrees/merge-overnight/app`);
  expect(by).toEqual({ agent: null, app: "Claude", left: false, place: "merge-overnight" });
  expect(byLine(by)).toBe("Claude app");
  expect(byLine(by, true)).toBe("Claude app");
});

test("startedBy: Codex CLI in iTerm names both; a Codex desktop app reads as an app", () => {
  const iterm = procs([500, 400, "node"], [400, 300, "-zsh"], [300, 250, "codex"], [250, 200, "-zsh"], [200, 150, "login"],
    [150, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"]);
  expect(byLine(startedBy(500, iterm, "/w/app"))).toBe("Codex in iTerm");
  expect(byLine(startedBy(500, procs([500, 90, "node"], [90, 1, "/Applications/Codex.app/Contents/MacOS/Codex"]), "/w/app"))).toBe("Codex app");
  expect(byLine(startedBy(500, procs([500, 90, "node"], [90, 1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]), "/w/app")))
    .toBe("Terminal app");
});

test("startedBy: Claude Code under the Claude app reads once, not 'Claude in Claude'", () => {
  const ps = procs([500, 400, "node"], [400, 300, "claude"], [300, 1, "/Applications/Claude.app/Contents/MacOS/Claude"]);
  expect(byLine(startedBy(500, ps, "/w/app"))).toBe("Claude app");
});

test("startedBy: a server whose Claude session has ended says so", () => {
  const by = startedBy(8035, procs([8035, 1, "/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python"]), SCRATCH);
  expect(by).toEqual({ agent: "Claude", app: null, left: true, place: "ai-artifacts-research-6b95a0" }); // its own Python.app isn't an app
  expect(byLine(by)).toBe("Claude ended");
  expect(byLine(by, true)).toBe("Started by a Claude session that has ended");
  const gone = startedBy(8035, procs([8035, 1, "python"]), "/Users/me/code/site");
  expect(byLine(gone)).toBe("in site");
  expect(byLine(gone, true)).toBe("What started it has ended");
});

test("startedBy: Herdr is never the app; with nothing to name, the folder", () => {
  const herdr = procs([500, 400, "node"], [400, 300, "/bin/zsh"], [300, 1, "/Users/me/Applications/Herdr.app/Contents/MacOS/Herdr"]);
  expect(startedBy(500, herdr, "/Users/me/code/site").app).toBe(null);
  expect(byLine(startedBy(500, procs([500, 400, "node"], [400, 300, "/bin/zsh"], [300, 1, "sshd"]), "/Users/me/code/site"))).toBe("in site");
  expect(byLine(startedBy(500, procs([500, 400, "node"], [400, 1, "sshd"]), null))).toBe("outside Herdr");
});

test("owner: a server another app started isn't guessed onto a Herdr agent in the same repo", () => {
  const ctx = ownerContext({ terminals: [term("t3p", 200, 300, MARGO)], roots: new Map([[MARGO, MARGO]]), home: "/Users/shoaib" });
  expect(owner(86717, CLAUDE_APP, `${MARGO}/.claude/worktrees/merge-overnight/app`, ctx)).toEqual({ kind: "orphan", address: null });
  expect(owner(8035, procs([8035, 1]), `${MARGO}/web`, ctx)).toEqual({ kind: "probable", address: "t3p", why: "worktree" }); // left behind: still a guess
});

test("servers: an orphan row carries who started it; an owned one doesn't", () => {
  const ctx = ownerContext({ terminals: [term("t1", 300, 310, "/Users/shoaib/w")], roots: new Map([["/Users/shoaib/w", "/Users/shoaib/w"]]), home: "/Users/shoaib" });
  const ps = new Map([...CLAUDE_APP, [320, { pid: 320, ppid: 310, age: 60, comm: "node" }]]);
  const listeners = [{ pid: 86717, command: "node", host: "[::1]", port: 1491 }, { pid: 320, command: "node", host: "[::1]", port: 3000 }];
  const cwds = new Map([[86717, `${MARGO}/.claude/worktrees/merge-overnight/app`], [320, "/Users/shoaib/w"]]);
  const rows = servers({ listeners, procs: ps, cwds, ctx, home: "/Users/shoaib" });
  expect(rows.find((r) => r.port === 1491).by).toEqual({ agent: null, app: "Claude", left: false, place: "merge-overnight" });
  expect(rows.find((r) => r.port === 3000).by).toBe(null);
});

// ---- Servers ----

const L = (pid, host, port, command = "node") => ({ pid, command, host, port });
const noCtx = () => ownerContext({ terminals: [], roots: new Map(), home: HOME });

test("urlFor: the address the server is actually on", () => {
  expect(urlFor(["*"], 5173)).toBe("http://localhost:5173");
  expect(urlFor(["127.0.0.1", "[::1]"], 5173)).toBe("http://localhost:5173");
  expect(urlFor(["127.0.0.1"], 8000)).toBe("http://127.0.0.1:8000");
  expect(urlFor(["[::1]"], 3000)).toBe("http://[::1]:3000");
  expect(urlFor(["100.64.0.7"], 8080)).toBe("http://100.64.0.7:8080");
});

test("isWeb: databases and debuggers aren't web", () => {
  expect(isWeb(5432, "/opt/homebrew/bin/postgres")).toBe(false);
  expect(isWeb(9229, "node")).toBe(false);
  expect(isWeb(6380, "/usr/local/bin/redis-server")).toBe(false);
  expect(isWeb(5173, "node")).toBe(true);
});

test("servers: uvicorn --reload's two pids on one port are one row, the supervisor's (Review Focus 5)", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a", { program: { agent: false } })], roots: new Map(), home: HOME });
  const rows = servers({ listeners: [L(100, "127.0.0.1", 8000, "Python"), L(101, "127.0.0.1", 8000, "Python")],
    procs: procs([300, 200], [100, 300, "uvicorn"], [101, 100, "python"]), cwds: new Map(), ctx, home: HOME });
  expect(rows.map((r) => [r.pid, r.port])).toEqual([[100, 8000]]);
  expect(rows[0].owner).toEqual({ kind: "sure", address: "t1" });
});

test("servers: the same port number on unrelated pids is two rows, each with its own address", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 210, "/w/a"), term("t2", 300, 310, "/w/b")], roots: new Map(), home: HOME });
  const rows = servers({ listeners: [L(400, "127.0.0.1", 3000), L(500, "[::1]", 3000)],
    procs: procs([400, 210], [500, 310], [210, 200], [310, 300]), cwds: new Map(), ctx, home: HOME });
  expect(rows.map((r) => r.url).sort()).toEqual(["http://127.0.0.1:3000", "http://[::1]:3000"]);
});

test("servers: the agent's own port is hidden; a shell's foreground dev server is kept", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 300, "/w/a"), term("t2", 210, 310, "/w/b", { program: { agent: false } })],
    roots: new Map(), home: HOME });
  const rows = servers({ listeners: [L(300, "127.0.0.1", 51304, "2.1.325"), L(310, "*", 5173)],
    procs: procs([300, 200], [310, 210]), cwds: new Map(), ctx, home: HOME });
  expect(rows.map((r) => r.port)).toEqual([5173]);
});

test("servers: orphans only under home or tmp and not an agent binary (rapportd, ControlCenter dropped)", () => {
  const rows = servers({ listeners: parseLsof(LSOF), procs: parsePs(PS), cwds: parseCwds(CWDS), ctx: noCtx(), home: "/Users/shoaib" });
  expect(rows.map((r) => [r.pid, r.port])).toEqual([[8035, 18791], [8035, 18792]]);
  expect(rows[0].owner.kind).toBe("orphan");
  expect(rows[0].command).toBe("Python");
  const agentBin = servers({ listeners: [L(9940, "127.0.0.1", 4000)], procs: parsePs(PS), cwds: new Map([[9940, "/Users/shoaib/x"]]),
    ctx: noCtx(), home: "/Users/shoaib" });
  expect(agentBin).toEqual([]);
});

test("servers: docker's ports are kept though its folder is /", () => {
  const rows = servers({ listeners: [L(77, "*", 5432, "com.docke")], procs: procs([77, 1, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"]),
    cwds: new Map([[77, "/"]]), ctx: noCtx(), home: HOME });
  expect(rows.map((r) => [r.port, r.owner.kind, r.web])).toEqual([[5432, "docker", false]]);
});

test("servers: one row per pid+port with hosts merged; ports lists every port of the pid; network flag", () => {
  const ctx = ownerContext({ terminals: [term("t1", 200, 210, "/w/a")], roots: new Map(), home: HOME });
  const rows = servers({ listeners: [L(400, "127.0.0.1", 5173), L(400, "[::1]", 5173), L(400, "*", 24678)],
    procs: procs([400, 210], [210, 200]), cwds: new Map(), ctx, home: HOME });
  expect(rows.map((r) => [r.port, r.url, r.network, r.ports])).toEqual([
    [5173, "http://localhost:5173", false, [5173, 24678]],
    [24678, "http://localhost:24678", true, [5173, 24678]],
  ]);
  expect(rows[0].key).toBe("400:5173");
});

test("sortServers: owned by port, then orphans oldest first; input not mutated", () => {
  const r = (port, kind, age) => ({ port, age, owner: { kind } });
  const input = [r(9000, "orphan", 10), r(8000, "sure", 1), r(9001, "orphan", 99), r(3000, "probable", 5), r(5432, "docker", 1)];
  const copy = [...input];
  expect(sortServers(input).map((x) => x.port)).toEqual([3000, 5432, 8000, 9001, 9000]);
  expect(input).toEqual(copy);
});

test("holds: true only while that pid holds that port (Review Focus 3)", () => {
  const l = parseLsof(LSOF);
  expect(holds(l, 1093, 24543)).toBe(true);
  expect(holds(l, 1093, 5173)).toBe(false);
  expect(holds(l, 99999, 24543)).toBe(false);
});

test("ago: now, minutes, hours, days", () => {
  expect([ago(30), ago(12 * 60), ago(3 * 3600 + 5), ago(2 * 86400)]).toEqual(["now", "12m", "3h", "2d"]);
});

test("blockHeight: from the row count alone (no measured size to chase); 0 folded; capped rows; Working's 32px foot", () => {
  expect(blockHeight(0, true)).toBe(0);
  expect(blockHeight(3, true)).toBe(0);
  expect(blockHeight(0)).toBe(32 + 32);
  expect(blockHeight(2)).toBe(41 + 2 * 30 + 32);
  expect(blockHeight(9)).toBe(41 + 5 * 30 + 32);
});

test("subAgents (from inbox's lib): live agent sub-terminals agents() misses; not tab agents, shells or the dead", () => {
  const terms = [
    { address: "t1", state: "live", parent: null, status: "working", program: { agent: true } },
    { address: "t6", state: "live", parent: "t1", status: "working", program: { agent: true }, cwd: "/w/y" },
    { address: "t3", state: "live", parent: "t1", status: "error", program: { agent: true }, cwd: "/w/x" },
    { address: "t4", state: "live", parent: "t1", status: "working", program: { agent: false } },
    { address: "t5", state: "finished", parent: "t1", status: "working", program: { agent: true } },
  ];
  expect(subAgents(terms, new Set(["t1"])).map((a) => [a.address, a.status])).toEqual([["t6", "working"], ["t3", "blocked"]]);
});

test("cardHeight: owned with Folder 308, orphan with Folder and Also on 338; each optional field adds 30", () => {
  const owned = { kind: "probable", folder: "/Users/shoaib/code/herdr-mods" };
  expect(cardHeight({ cwd: SCRATCH, ports: [8799] }, owned)).toBe(308);
  expect(cardHeight({ cwd: SCRATCH, ports: [18791, 18792] }, { kind: "orphan", folder: null })).toBe(338);
  expect(cardHeight({ cwd: "/Users/shoaib/code/herdr-mods", ports: [8799] }, owned)).toBe(278); // no Folder
});

test("isLocal: remote terminals are told by their machine/ address prefix as well as machine (review: Important 2)", () => {
  expect(isLocal({ address: "t1", state: "live", machine: null })).toBe(true);
  expect(isLocal({ address: "box/t9", state: "live" })).toBe(false); // no machine key, remote by address
  expect(isLocal({ address: "t9", state: "live", machine: "box" })).toBe(false);
  expect(isLocal({ address: "t1", state: "finished", machine: null })).toBe(false);
  const ctx = ownerContext({ terminals: [{ address: "box/t9", state: "live", pid: 200, foreground: { pid: 300, cwd: "/w/a" }, cwd: "/w/a", program: { agent: true } }],
    roots: new Map([["/w/a", "/w/a"]]), home: HOME });
  expect(owner(400, procs([400, 300], [300, 200], [200, 1]), "/w/a", ctx)).toEqual({ kind: "orphan", address: null });
});

test("rootOf: only a clean answer is kept; a timeout or failure isn't remembered as 'not a repo' (review: Important 4)", () => {
  expect(rootOf({ code: 0, stdout: "/w/a\n" })).toBe("/w/a");
  expect(rootOf({ code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" })).toBe(null);
  expect(rootOf({ code: -1, stdout: "", stderr: "timed out" })).toBe(undefined);
  expect(rootOf(null)).toBe(undefined);
});

test("kindOf: what a server is, for its icon: web, a database, a debugger, Docker, or other", () => {
  expect(kindOf({ port: 5173, command: "node", owner: { kind: "sure" } })).toBe("web");
  expect(kindOf({ port: 5432, command: "postgres", owner: { kind: "orphan" } })).toBe("db");
  expect(kindOf({ port: 6380, command: "redis-server", owner: { kind: "sure" } })).toBe("db");
  expect(kindOf({ port: 9229, command: "node", owner: { kind: "sure" } })).toBe("debug");
  expect(kindOf({ port: 5432, command: "com.docker.backend", owner: { kind: "docker" } })).toBe("docker");
  expect(kindOf({ port: 5672, command: "beam.smp", owner: { kind: "sure" } })).toBe("other");
});

test("isWeb follows kindOf: only web servers offer Open", () => {
  expect([isWeb(5173, "node"), isWeb(5432, "x"), isWeb(9229, "node"), isWeb(5672, "beam.smp")]).toEqual([true, false, false, false]);
});

// ---- The port card's words (ports decides, port-card draws) ----

test("ownerLines: sure agent, the space on line 1, what it's doing and the branch on line 2", () => {
  expect(ownerLines({ kind: "sure", program: "Claude Code", space: "Testing-Herdr-Mods", task: "Herdr agent graph animation testing", branch: "main" }))
    .toEqual({ line1: "Claude Code · Testing-Herdr-Mods", line2: "Herdr agent graph animation testing · main" });
});

test("ownerLines: probable says why; repeats and blanks are dropped; an empty line 2 falls back to the folder", () => {
  expect(ownerLines({ kind: "probable", probable: true, why: "scratch", program: "Claude Code", space: "S", branch: "main" }).line2)
    .toBe("Probably: it runs in this agent's scratchpad · main");
  expect(ownerLines({ kind: "probable", probable: true, why: "worktree", program: "Codex", space: "S" }).line2).toBe("Probably: it runs in this agent's worktree");
  expect(ownerLines({ kind: "sure", program: "Claude Code", space: "Claude Code", task: "Claude Code", branch: "" }).line1).toBe("Claude Code");
  expect(ownerLines({ kind: "sure", program: "Claude Code", space: "S", task: "main", branch: "main" }).line2).toBe("main");
  expect(ownerLines({ kind: "sure", program: "zsh", space: "website", task: "", branch: null, folder: "/Users/me/code/site", home: "/Users/me" }).line2).toBe("~/code/site");
});

test("ownerLines: orphans and docker", () => {
  const ended = { agent: "Claude", app: null, left: true, place: "ai-artifacts-research-6b95a0" };
  expect(ownerLines({ kind: "orphan", by: ended })).toEqual({ line1: "Started by a Claude session that has ended", line2: "in ai-artifacts-research-6b95a0" });
  expect(ownerLines({ kind: "orphan", by: { agent: null, app: "Claude", left: false, place: "merge-overnight" } }).line1).toBe("Claude app");
  expect(ownerLines({ kind: "orphan", by: { agent: null, app: null, left: false, place: "site" } })).toEqual({ line1: "Started outside Herdr", line2: "in site" });
  expect(ownerLines({ kind: "orphan", by: { agent: null, app: null, left: true, place: "site" } }).line1).toBe("What started it has ended");
  expect(ownerLines({ kind: "docker" })).toEqual({ line1: "Docker", line2: "Docker Desktop publishes this port. Stop it in Docker." });
});

test("stopFact: the deciding fact for every owner, never a verdict", () => {
  const p = "Claude Code";
  const facts = [
    [{ kind: "sure", status: "working", program: p }, "Claude Code is working."],
    [{ kind: "sure", status: "blocked", program: p }, "Claude Code needs you."],
    [{ kind: "sure", status: "idle", program: p }, null],
    [{ kind: "probable", probable: true, status: "working", program: p }, "It may be Claude Code's, which is working."],
    [{ kind: "probable", probable: true, status: "blocked", program: p }, "It may be Claude Code's, which needs you."],
    [{ kind: "probable", probable: true, status: "done", program: p }, "It may be Claude Code's."],
    [{ kind: "orphan", by: { agent: "Claude", app: null, left: true } }, "Its Claude session has ended."],
    [{ kind: "orphan", by: { agent: "Codex", app: "iTerm", left: false } }, "Codex in iTerm started it."],
    [{ kind: "orphan", by: { agent: null, app: "Claude", left: false } }, "The Claude app started it."],
    [{ kind: "orphan", by: { agent: null, app: null, left: true } }, "What started it has ended."],
    [{ kind: "orphan", by: { agent: null, app: null, left: false } }, "It was started outside Herdr."],
  ];
  for (const [who, fact] of facts) expect(stopFact(who)).toBe(fact);
  expect(facts.some(([, f]) => /safe/i.test(f ?? ""))).toBe(false);
});

test("folderLabel: a Claude scratchpad by name, home as ~", () => {
  expect(folderLabel(SCRATCH, "/Users/shoaib")).toBe("Claude scratchpad/spike");
  expect(folderLabel("/Users/me/code/site", "/Users/me")).toBe("~/code/site");
  expect(folderLabel(null, "/Users/me")).toBe("");
});

test("ownerLines: an ended session outside a worktree still says where (the folder label), never a blank line 2", () => {
  const by = startedBy(8035, procs([8035, 1, "python"]), "/private/tmp/claude-501/-Users-shoaib-code-herdr-mods/abc/scratchpad/spike");
  expect(by.place).toBe(null);
  expect(ownerLines({ kind: "orphan", by, folderText: "Claude scratchpad/spike" }).line2).toBe("in Claude scratchpad/spike");
});
