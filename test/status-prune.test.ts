import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicJson, pruneStatus, writeMarker } from "../src/storage.ts";

const root = mkdtempSync(join(tmpdir(), "pcb-status-prune-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const day = 24 * 60 * 60 * 1000, time = Date.parse("2026-01-20T00:00:00Z");
const now = () => time, dead = () => false;
function fixture() {
  const dir = mkdtempSync(join(root, "status-"));
  mkdirSync(join(dir, "status"));
  return dir;
}
function record(dir: string, id: string, data: unknown = { pid: 123 }, age = 8 * day) {
  const path = join(dir, "status", `${id}.json`);
  atomicJson(path, data);
  utimesSync(path, (time - age) / 1000, (time - age) / 1000);
  return path;
}
function events(dir: string): any[] {
  return readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function mock(t: TestContext, object: any, method: string, implementation: (...args: any[]) => any) {
  t.mock.method(object, method, implementation);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("default retention is strictly older than seven days, with one summary event", () => {
  const dir = fixture();
  const old = record(dir, "old"), boundary = record(dir, "boundary", { pid: 123 }, 7 * day);
  const recent = record(dir, "recent", { pid: 123 }, 7 * day - 1);
  pruneStatus(dir, { now, pidAlive: dead });
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(boundary));
  assert.ok(existsSync(recent));
  assert.deepEqual(events(dir), [{ at: new Date(time).toISOString(), event: "status_pruned", examined: 3, removed: 1, kept: 2, errors: 0, capped: false }]);
  assert.equal(existsSync(join(dir, "status/.prune.lock")), false);
  assert.equal(statSync(join(dir, "status/.last-prune")).mode & 0o777, 0o600);
});

test("retention can be injected", () => {
  const dir = fixture(), path = record(dir, "old", { pid: 123 }, 2 * day);
  pruneStatus(dir, { now, retentionMs: day, pidAlive: dead });
  assert.equal(existsSync(path), false);
});

test("live PIDs are kept, including the actual current process", () => {
  const dir = fixture(), path = record(dir, "live", { pid: process.pid });
  pruneStatus(dir, { now });
  assert.ok(existsSync(path));
});

for (const code of ["EPERM", "EACCES", "UNKNOWN", "ESRCH"]) {
  test(`PID probe ${code} only deletes on ESRCH`, t => {
    const dir = fixture(), path = record(dir, "probe");
    mock(t, process, "kill", () => { throw Object.assign(Error(code), { code }); });
    pruneStatus(dir, { now });
    assert.equal(existsSync(path), code !== "ESRCH");
  });
}

test("current session is kept by filename and recorded identity without probing its PID", () => {
  const dir = fixture(), current = record(dir, "current"), alias = record(dir, "alias", { pid: 123, sessionId: "current" });
  pruneStatus(dir, { now, currentSessionId: "current", pidAlive: () => { assert.fail("current PID must not be probed"); } });
  assert.ok(existsSync(current));
  assert.ok(existsSync(alias));
  assert.equal(events(dir)[0].errors, 0);
});

test("retained relaunch markers protect status, handoff and session evidence", () => {
  const dir = fixture(), marker = join(dir, "retained-marker.json"), handoff = join(dir, "handoff.md"), sessionFile = join(dir, "session.jsonl");
  writeFileSync(handoff, "handoff");
  writeFileSync(sessionFile, "session");
  writeMarker(marker, { cwd: dir, launchPrompt: null, handoff, sessionFile });
  const path = record(dir, "protected", { pid: 123, relaunchMarker: marker, lastHandoffPath: handoff, sessionFile });
  const missing = record(dir, "consumed", { pid: 123, relaunchMarker: join(dir, "missing-marker.json") });
  pruneStatus(dir, { now, pidAlive: dead });
  assert.ok(existsSync(path));
  assert.ok(existsSync(marker));
  assert.ok(existsSync(handoff));
  assert.ok(existsSync(sessionFile));
  assert.equal(existsSync(missing), false);
});

test("marker lookup errors fail closed", t => {
  const dir = fixture(), marker = join(dir, "unreadable-marker.json"), path = record(dir, "protected", { pid: 123, relaunchMarker: marker });
  const stat = fs.statSync;
  mock(t, fs, "statSync", (file, ...args) => {
    if (file === marker) throw Object.assign(Error("denied"), { code: "EACCES" });
    return (stat as any)(file, ...args);
  });
  pruneStatus(dir, { now, pidAlive: dead });
  assert.ok(existsSync(path));
});

test("corrupt, missing and invalid PID records are kept", () => {
  const dir = fixture();
  const corrupt = record(dir, "corrupt");
  writeFileSync(corrupt, "{");
  utimesSync(corrupt, 0, 0);
  const paths = [{}, null, { pid: null }, { pid: "123" }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }].map((data, i) => record(dir, `invalid-${i}`, data));
  pruneStatus(dir, { now, pidAlive: dead });
  for (const path of [corrupt, ...paths]) assert.ok(existsSync(path));
  assert.equal(events(dir)[0].removed, 0);
});

test("unreadable records are kept without preventing other deletions", t => {
  const dir = fixture(), bad = record(dir, "bad"), good = record(dir, "good"), read = fs.readFileSync;
  mock(t, fs, "readFileSync", (path, ...args) => {
    if (path === bad) throw Object.assign(Error("denied"), { code: "EACCES" });
    return (read as any)(path, ...args);
  });
  assert.doesNotThrow(() => pruneStatus(dir, { now, pidAlive: dead }));
  assert.ok(existsSync(bad));
  assert.equal(existsSync(good), false);
  assert.equal(events(dir)[0].errors, 1);
});

test("the daily throttle skips a second run and allows the exact boundary", () => {
  const dir = fixture();
  record(dir, "first");
  pruneStatus(dir, { now, pidAlive: dead });
  const second = record(dir, "second");
  pruneStatus(dir, { now: () => time + day - 1, pidAlive: dead });
  assert.ok(existsSync(second));
  assert.equal(events(dir).length, 1);
  pruneStatus(dir, { now: () => time + day, pidAlive: dead });
  assert.equal(existsSync(second), false);
  assert.equal(events(dir).length, 2);
});

test("fresh lock contention skips, while a stale lock is recovered", () => {
  const dir = fixture(), path = record(dir, "old"), lock = join(dir, "status/.prune.lock");
  mkdirSync(lock);
  utimesSync(lock, time / 1000, time / 1000);
  pruneStatus(dir, { now, pidAlive: dead });
  assert.ok(existsSync(path));
  assert.ok(existsSync(lock));
  assert.equal(existsSync(join(dir, "events.jsonl")), false);
  utimesSync(lock, (time - 10001) / 1000, (time - 10001) / 1000);
  pruneStatus(dir, { now, pidAlive: dead });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(lock), false);
});

test("a replaced stale lock is not removed", t => {
  const dir = fixture(), path = record(dir, "old"), lock = join(dir, "status/.prune.lock");
  mkdirSync(lock);
  utimesSync(lock, 0, 0);
  const stat = fs.statSync;
  let reads = 0;
  mock(t, fs, "statSync", (file, ...args) => {
    if (file === lock && ++reads === 2) { rmSync(lock, { recursive: true }); mkdirSync(lock); }
    return (stat as any)(file, ...args);
  });
  pruneStatus(dir, { now, pidAlive: dead });
  assert.ok(existsSync(path));
  assert.ok(existsSync(lock));
});

test("file caps count retained records and later passes continue then wrap", () => {
  const dir = fixture(), kept = record(dir, "a", { pid: process.pid });
  const b = record(dir, "b"), c = record(dir, "c");
  const opts = { now, throttleMs: 0, maxFiles: 1, pidAlive: (pid: number) => pid === process.pid };
  pruneStatus(dir, opts);
  assert.ok(existsSync(kept));
  assert.ok(existsSync(b));
  assert.equal(events(dir)[0].examined, 1);
  assert.equal(events(dir)[0].capped, true);
  pruneStatus(dir, opts);
  assert.equal(existsSync(b), false);
  assert.ok(existsSync(c));
  const earlier = record(dir, "aa");
  pruneStatus(dir, opts);
  assert.equal(existsSync(c), false);
  assert.ok(existsSync(earlier));
  pruneStatus(dir, { ...opts, maxFiles: 2 });
  assert.equal(existsSync(earlier), false);
});

test("elapsed-time cap stops early and the next run resumes", () => {
  const dir = fixture(), a = record(dir, "a"), b = record(dir, "b");
  let tick = time - 100;
  pruneStatus(dir, { now: () => tick += 100, throttleMs: 0, pidAlive: dead });
  assert.equal(existsSync(a), false);
  assert.ok(existsSync(b));
  assert.equal(events(dir)[0].examined, 1);
  assert.equal(events(dir)[0].capped, true);
  pruneStatus(dir, { now, throttleMs: 0, pidAlive: dead });
  assert.equal(existsSync(b), false);
});

test("default file cap is 5000", () => {
  const dir = fixture();
  for (let i = 0; i < 5001; i++) record(dir, String(i).padStart(4, "0"));
  pruneStatus(dir, { now, pidAlive: dead });
  assert.equal(events(dir)[0].examined, 5000);
  assert.equal(events(dir)[0].capped, true);
  assert.equal(readdirSync(join(dir, "status")).filter(name => name.endsWith(".json")).length, 1);
});

test("a status replaced during its PID check is kept", () => {
  const dir = fixture(), path = record(dir, "changing");
  pruneStatus(dir, { now, pidAlive: () => { atomicJson(path, { pid: process.pid }); return false; } });
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
});

test("missing directories, unusable paths and throwing dependencies never escape", () => {
  const missing = join(fixture(), "missing");
  assert.doesNotThrow(() => pruneStatus(missing));
  const dir = fixture(), path = record(dir, "old");
  assert.doesNotThrow(() => pruneStatus(dir, { now: () => { throw Error("clock"); } }));
  assert.doesNotThrow(() => pruneStatus(dir, { now, pidAlive: () => { throw Error("unknown PID"); } }));
  assert.ok(existsSync(path));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "file");
  assert.doesNotThrow(() => pruneStatus(file));
});

test("deletion and event-log failures never throw and still release the lock", t => {
  const dir = fixture(), path = record(dir, "old");
  mkdirSync(join(dir, "events.jsonl"));
  mock(t, fs, "rmSync", () => { throw Error("delete unavailable"); });
  assert.doesNotThrow(() => pruneStatus(dir, { now, pidAlive: dead }));
  assert.ok(existsSync(path));
  assert.equal(existsSync(join(dir, "status/.prune.lock")), false);
});
