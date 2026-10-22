import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handoffBackoff, narrativeTokens, renderHandoff, forced, initialState, parseConfig } from "../src/core.ts";
import { pendingQuestions, watchCheck } from "../src/storage.ts";

const root = resolve(import.meta.dirname, "../.ai-work/wake-state");
mkdirSync(root, { recursive: true });
const input = { goal: "one two three", facts: "four five six", next_step: "seven eight nine" };
const auto = { cwd: "/repo", root: "/repo", branch: "main", head: "abc", jobs: [], subagents: [], claims: [], unavailable: [] };

test("word-set Jaccard is normalized, strictly above 0.9, HEAD-sensitive and expires after 15 minutes", () => {
  const at = "2026-01-01T00:00:00.000Z", now = Date.parse(at);
  const h = renderHandoff(input, auto, "s", 1, "/handoff", at);
  assert.deepEqual(narrativeTokens({ goal: "ONE, one", facts: "Two", next_step: "three!" }), ["one", "two", "three"]);
  assert.match(handoffBackoff(input, h, "abc", false, now)!, /retry after 2026-01-01T00:15:00.000Z/);
  assert.equal(handoffBackoff({ ...input, facts: input.facts + " ten" }, h, "abc", false, now), undefined); // exactly 0.9
  const longer = { ...input, facts: input.facts + " ten eleven" };
  const previous = renderHandoff(longer, auto, "s", 2, "/handoff", at);
  assert.ok(handoffBackoff({ ...longer, facts: longer.facts + " twelve" }, previous, "abc", false, now)); // 11/12
  assert.equal(handoffBackoff(input, h, "changed", false, now), undefined);
  assert.equal(handoffBackoff(input, { ...h, head: "unknown" }, "unknown", false, now), undefined);
  assert.equal(handoffBackoff(input, h, "abc", true, now), undefined);
  assert.equal(handoffBackoff(input, h, "abc", false, now + 15 * 60_000), undefined);
  assert.equal(handoffBackoff(input, { ...h, narrativeTokens: undefined }, "abc", false, now), undefined);
});

test("questions are session-scoped, latest-revision-only, read-only and bounded", () => {
  const home = mkdtempSync(join(root, "questions-"));
  const put = (id: string, rev: number, status = "open", sessionId = "s", title = "title") => {
    const dir = join(home, "items", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `r${String(rev).padStart(8, "0")}.json`), JSON.stringify({ id, status, title, asker: { sessionId } }));
  };
  put("Q-1", 1); put("Q-1", 2, "answered");
  put("Q-2", 1, "open", "other");
  put("Q-3", 1, "deferred");
  put("Q-4", 1);
  writeFileSync(join(home, "items/Q-4/r00000002.json"), "corrupt");
  put("Q-5", 1, "open", "s", "字".repeat(300) + "\nsecond line");
  for (let i = 6; i <= 30; i++) put(`Q-${i}`, 1);
  const lines = pendingQuestions(home, "s");
  assert.equal(lines.length, 20);
  assert.equal(Array.from(lines[0]).length, 200);
  assert.match(lines[0], /^Q-5 \| open \| /);
  assert.ok(lines.every(line => !line.includes("\n") && Array.from(line).length <= 200));
  assert.deepEqual(pendingQuestions(join(home, "missing"), "s"), []);
  const file = join(home, "not-directory");
  writeFileSync(file, "not a store");
  assert.deepEqual(pendingQuestions(file, "s"), []);
});

test("watch diff is absent for live work or absent/unreadable registries", () => {
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, old = global[key];
  const recorded = [{ id: "j1", label: "watch", command: "echo hello | cat" }];
  try {
    delete global[key];
    assert.equal(watchCheck(recorded), undefined);
    global[key] = new Set([{ list: () => { throw new Error("unreadable"); } }]);
    assert.equal(watchCheck(recorded), undefined);
    global[key] = new Set([{ list: () => [{ id: "j1", status: "running" }] }]);
    assert.equal(watchCheck(recorded), undefined);
    global[key] = new Set([{ list: () => [{ id: "j1", status: "completed" }] }]);
    assert.match(watchCheck(recorded)!, /j1 \| watch \| echo hello \| cat/);
  } finally { global[key] = old; }
});


test("forced handoffs use policy state tokens rather than a conflicting live measurement", () => {
  const config = parseConfig({ mode: "enforce", main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 } });
  const frame = { mode: "enforce" as const, config, thresholds: config.main, tokens: 10, wrapped: false };
  assert.equal(forced({ ...initialState("enforce"), tokens: 1000 }, frame), "hard");
  assert.equal(forced({ ...initialState("enforce"), tokens: 250, floor: 100 }, frame), true);
  assert.equal(forced({ ...initialState("enforce"), compactionFallback: true }, frame), "compaction");
  assert.equal(forced({ ...initialState("enforce"), tokens: 10, floor: 0 }, { ...frame, tokens: 1000 }), false);
});

test("questions scan only the newest 200 item directories by modification time", () => {
  const home = mkdtempSync(join(root, "question-scan-"));
  // The oldest, low-numbered open item must not be found beyond the scan cap,
  // even when all recent items belong to another session and yield no output.
  for (let n = 1; n <= 201; n++) {
    const dir = join(home, "items", `Q-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "r00000001.json"), JSON.stringify({ id: `Q-${n}`, status: "open", title: `question ${n}`,
      asker: { sessionId: n === 1 || n === 201 ? "s" : "other" } }));
    const time = new Date(Date.parse("2026-01-01T00:00:00Z") + n * 1000);
    utimesSync(dir, time, time);
  }
  assert.deepEqual(pendingQuestions(home, "s"), ["Q-201 | open | question 201"]);
  // Promoting the old item by mtime, not id, makes it eligible again.
  const newest = new Date("2026-02-01T00:00:00Z");
  utimesSync(join(home, "items/Q-1"), newest, newest);
  assert.deepEqual(pendingQuestions(home, "s"), ["Q-1 | open | question 1", "Q-201 | open | question 201"]);
});
