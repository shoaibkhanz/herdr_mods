// The port card's arithmetic: its one process's live numbers from `ps`, and the Stop recheck. parseLsof, holds and
// parseEtime are copies of mods/ports/lib.js (mods don't import across folders), kept identical.

const KB_PER_MB = 1024, KB_PER_GB = 1024 * 1024;

// How long a server has run, as the card's Running line says it: "<1m", "5m", "3h 12m", "2d 20h".
export function agePrecise(sec) {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// The ports the Stop question names: ":a", ":a and :b", ":a, :b and :c", past three ":a, :b and N more", so the
// question stays within its two lines.
export function portList(ports) {
  const p = ports.map((x) => `:${x}`);
  if (p.length < 2) return p.join("");
  if (p.length > 3) return `${p.slice(0, 2).join(", ")} and ${p.length - 2} more`;
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

export const formatMem = (kb) => (kb >= KB_PER_GB ? `${(kb / KB_PER_GB).toFixed(1)} GB` : `${Math.round(kb / KB_PER_MB)} MB`);

// From mods/ports/lib.js.
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((s ?? "").trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

// `ps -p <pid> -o etime=,rss=,%cpu=` -> { age: s, rss: KB, cpu: % (one core = 100) }, or null when the process is gone.
// %cpu is ps's own recent average, so the card shows it from the first sample (no second sample to wait for).
export function parseStat(text) {
  const m = /^\s*(\S+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec((text ?? "").trim());
  return m ? { age: parseEtime(m[1]), rss: Number(m[2]), cpu: Math.round(Number(m[3])) } : null;
}

// From mods/ports/lib.js.
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

// From mods/ports/lib.js.
export const holds = (listeners, pid, port) => listeners.some((l) => l.pid === pid && l.port === port);

// `ps -o args=` with the program's absolute path replaced by its name (`command`, ps's comm basename). The path may
// hold spaces, so it's found by "/<command>" followed by a space or the end, not by splitting.
export function shortArgs(args, command) {
  const a = (args ?? "").trim();
  if (!a.startsWith("/") || !command) return a;
  const m = new RegExp(`/${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).exec(a);
  return m ? `${command}${a.slice(m.index + m[0].length)}` : a;
}

// ---- Stop's decisions ----

// Never Docker: its pid is Docker itself, and stopping it stops every container. Checked on every path to Stop.
export const canStop = (who) => !!who && who.kind !== "docker";

// `ps -p <pid> -o etime=,rss=,%cpu=`: { age, rss, cpu } while it runs; "gone" on ps's no-such-process exit (1, nothing
// printed); "error" for anything else (a timeout, a failed exec), which the card retries instead of calling it stopped.
export function statOutcome(r) {
  if (!r) return "error";
  if (r.code === 0) return parseStat(r.stdout) ?? "error";
  return r.code === 1 && !(r.stdout ?? "").trim() ? "gone" : "error";
}

// `lsof -nP -a -p <pid> -iTCP:<port> -sTCP:LISTEN -Fpcn`: true / false, or null when lsof itself failed (unknown).
// lsof exits 1 when nothing matches.
export function heldOutcome(r, pid, port) {
  if (!r) return null;
  if (r.code === 0) return holds(parseLsof(r.stdout), pid, port);
  return r.code === 1 ? false : null;
}
