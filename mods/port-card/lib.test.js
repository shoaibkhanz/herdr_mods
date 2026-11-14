import { test, expect } from "bun:test";
import { formatMem, parseStat, parseLsof, holds, shortArgs, canStop, statOutcome, heldOutcome } from "./lib.js";

test("formatMem: KB from ps rss to MB or GB", () => {
  expect(formatMem(18848)).toBe("18 MB");
  expect(formatMem(213792)).toBe("209 MB");
  expect(formatMem(3 * 1024 * 1024 + 300 * 1024)).toBe("3.3 GB");
});

test("parseStat: `ps -o etime=,rss=,%cpu=` line, CPU shown from the first sample; null when the process is gone", () => {
  expect(parseStat("    12:52:51 213792  15.0\n")).toEqual({ age: 12 * 3600 + 52 * 60 + 51, rss: 213792, cpu: 15 });
  expect(parseStat(" 2-19:19:53   3376 103.6")).toEqual({ age: 2 * 86400 + 19 * 3600 + 19 * 60 + 53, rss: 3376, cpu: 104 }); // two cores
  expect(parseStat("")).toBe(null);
});

test("holds (copied from ports): only while that pid holds that port", () => {
  const l = parseLsof("p22073\ncPython\nf3\nn127.0.0.1:8765\n");
  expect(holds(l, 22073, 8765)).toBe(true);
  expect(holds(l, 22073, 8766)).toBe(false);
  expect(holds(parseLsof(""), 22073, 8765)).toBe(false);
});

test("shortArgs: the program's path becomes its name; arguments kept; paths with spaces handled", () => {
  expect(shortArgs("/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python -m http.server 8765 --bind 127.0.0.1", "Python"))
    .toBe("Python -m http.server 8765 --bind 127.0.0.1");
  expect(shortArgs("/Users/me/Library/Application Support/x/bin/node server.js", "node")).toBe("node server.js");
  expect(shortArgs("npm run dev", "node")).toBe("npm run dev"); // not a path: as is
  expect(shortArgs("/usr/bin/vite", "vite")).toBe("vite");
  expect(shortArgs("", "node")).toBe("");
});

test("canStop: never Docker (stopping it stops every container), whatever path asks (review: Critical 1)", () => {
  expect(canStop({ kind: "docker" })).toBe(false);
  expect(canStop(undefined)).toBe(false);
  for (const kind of ["sure", "probable", "orphan"]) expect(canStop({ kind })).toBe(true);
});

test("statOutcome: a failed or timed-out ps is an error to retry, not a stopped process (review: Important 3)", () => {
  expect(statOutcome(null)).toBe("error");
  expect(statOutcome({ code: -1, stdout: "", stderr: "timed out" })).toBe("error");
  expect(statOutcome({ code: 1, stdout: "", stderr: "" })).toBe("gone");
  expect(statOutcome({ code: 0, stdout: "    12:52:51 213792   0.0\n" })).toEqual({ age: 46371, rss: 213792, cpu: 0 });
});

test("heldOutcome: lsof's no-match exit is 'not held'; a failure is unknown (null), never 'not held'", () => {
  expect(heldOutcome({ code: 0, stdout: "p22073\ncPython\nf3\nn127.0.0.1:8765\n" }, 22073, 8765)).toBe(true);
  expect(heldOutcome({ code: 1, stdout: "" }, 22073, 8765)).toBe(false);
  expect(heldOutcome(null, 22073, 8765)).toBe(null);
  expect(heldOutcome({ code: -1, stdout: "" }, 22073, 8765)).toBe(null);
});
