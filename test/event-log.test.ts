import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { appendEvent, EVENT_LOG_KEEP, EVENT_LOG_MAX_BYTES, TURN_LOG_KEEP } from "../src/storage.ts";

const root = mkdtempSync(join(tmpdir(), "pcb-event-log-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  return mkdtempSync(join(root, "event-log-"));
}
const archives = (dir: string, base = "events") => readdirSync(dir).filter(name => name.startsWith(`${base}-`) && name.endsWith(".jsonl")).sort();
const lines = (dir: string, name: string): any[] => readFileSync(join(dir, name), "utf8").trim().split("\n").map(line => JSON.parse(line));
const now = () => Date.parse("2026-01-02T03:04:05.006Z");

test("event log defaults and below-cap appends preserve JSON lines without archives", () => {
  assert.equal(EVENT_LOG_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(EVENT_LOG_KEEP, 5);
  assert.equal(TURN_LOG_KEEP, 2);
  const dir = fixture();
  appendEvent(dir, { id: 1 }, { maxBytes: 100 });
  appendEvent(dir, { id: 2 }, { maxBytes: 100 });
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(archives(dir), []);
  assert.equal(statSync(join(dir, "events.jsonl")).mode & 0o777, 0o600);
});

test("at or above the cap the next append rotates the intact old file", () => {
  for (const maxBytes of [9, 8]) {
    const dir = fixture();
    appendEvent(dir, { id: 1 }, { maxBytes, now });
    assert.deepEqual(archives(dir), []);
    appendEvent(dir, { id: 2 }, { maxBytes, now });
    assert.deepEqual(archives(dir), ["events-20260102T030405006Z.jsonl"]);
    assert.deepEqual(lines(dir, archives(dir)[0]), [{ id: 1 }]);
    assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 2 }]);
    assert.equal(existsSync(join(dir, "events.lock")), false);
  }
});

test("rotation prunes all but the newest keep archives", () => {
  const dir = fixture();
  let time = now();
  for (let id = 0; id < 8; id++) appendEvent(dir, { id }, { maxBytes: 1, keep: 3, now: () => time++ });
  assert.equal(archives(dir).length, 3);
  assert.deepEqual(archives(dir).flatMap(name => lines(dir, name)), [{ id: 4 }, { id: 5 }, { id: 6 }]);
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 7 }]);
});

test("same-millisecond rotations keep the newest archives", () => {
  const dir = fixture();
  for (let id = 0; id < 6; id++) appendEvent(dir, { id }, { maxBytes: 1, keep: 3, now });
  assert.deepEqual(archives(dir), ["events-20260102T030405006Z-002.jsonl", "events-20260102T030405006Z-003.jsonl", "events-20260102T030405006Z-004.jsonl"]);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith("events-")).flatMap(name => lines(dir, name)).map(line => line.id).sort(), [2, 3, 4]);
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 5 }]);
});

test("turns are separate, rotate independently, and use their own retention default", () => {
  const dir = fixture();
  let time = now();
  for (let id = 0; id < 8; id++) {
    appendEvent(dir, { event: "turn", id }, { maxBytes: 1, now: () => time++ });
    appendEvent(dir, { event: "handoff", id }, { maxBytes: 1, now: () => time++ });
  }
  assert.equal(archives(dir, "turns").length, TURN_LOG_KEEP);
  assert.equal(archives(dir).length, EVENT_LOG_KEEP);
  for (const name of readdirSync(dir)) {
    assert.ok(lines(dir, name).every(line => (line.event === "turn") === name.startsWith("turns")));
  }
});

test("first append rotates a pre-existing oversize file once", () => {
  const dir = fixture();
  const old = JSON.stringify({ event: "turn", payload: "old".repeat(1000) }) + "\n";
  writeFileSync(join(dir, "events.jsonl"), old);
  appendEvent(dir, { id: "new" }, { maxBytes: 100, now });
  appendEvent(dir, { id: "next" }, { maxBytes: 100, now });
  assert.equal(archives(dir).length, 1);
  assert.equal(readFileSync(join(dir, archives(dir)[0]), "utf8"), old);
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: "new" }, { id: "next" }]);
});

test("stale locks are broken but fresh held locks only defer rotation", () => {
  for (const stale of [false, true]) {
    const dir = fixture();
    appendEvent(dir, { id: 1 });
    const lock = join(dir, "events.lock");
    mkdirSync(lock);
    const time = (now() - (stale ? 10001 : 9999)) / 1000;
    utimesSync(lock, time, time);
    appendEvent(dir, { id: 2 }, { maxBytes: 1, now });
    assert.equal(archives(dir).length, stale ? 1 : 0);
    assert.equal(existsSync(lock), !stale);
    assert.equal(readdirSync(dir).some(name => name.includes("stale")), false);
    assert.equal(readdirSync(dir).filter(name => name.endsWith(".jsonl")).flatMap(name => lines(dir, name)).length, 2);
  }
});

test("stale-lock revalidation does not remove a newly recreated lock", t => {
  const dir = fixture(), lock = join(dir, "events.lock");
  appendEvent(dir, { id: 1 });
  mkdirSync(lock);
  utimesSync(lock, 0, 0);
  const realStat = fs.statSync;
  let reads = 0;
  t.mock.method(fs, "statSync", (path: fs.PathLike, ...args: any[]) => {
    if (path === lock && ++reads === 2) {
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
    }
    return (realStat as any)(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  appendEvent(dir, { id: 2 }, { maxBytes: 1 });
  assert.ok(reads >= 2, "stale lock must be rechecked before removal");
  assert.equal(existsSync(lock), true);
  assert.deepEqual(archives(dir), []);
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 1 }, { id: 2 }]);
});

test("rotation failure still appends and releases the lock", t => {
  const dir = fixture();
  appendEvent(dir, { id: 1 });
  t.mock.method(fs, "renameSync", () => { throw Error("rotation unavailable"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  appendEvent(dir, { id: 2 }, { maxBytes: 1 });
  assert.equal(existsSync(join(dir, "events.lock")), false);
  assert.deepEqual(lines(dir, "events.jsonl"), [{ id: 1 }, { id: 2 }]);
});

test("same-millisecond rotations never overwrite an archive", () => {
  const dir = fixture();
  for (let id = 0; id < 10; id++) appendEvent(dir, { id }, { maxBytes: 1, keep: 20, now });
  assert.equal(archives(dir).length, 9);
  const ids = readdirSync(dir).flatMap(name => lines(dir, name)).map(line => line.id).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 10 }, (_, id) => id));
});

test("six concurrent appenders retain every unique JSON line exactly once", async () => {
  const dir = fixture();
  const module = new URL("../src/storage.ts", import.meta.url).href;
  const workers = 6, count = 100;
  await Promise.all(Array.from({ length: workers }, (_, worker) => new Promise<void>((resolve, reject) => {
    const code = `import { appendEvent } from ${JSON.stringify(module)};
      for (let n = 0; n < ${count}; n++) appendEvent(${JSON.stringify(dir)}, { id: ${worker} * ${count} + n, text: "λ".repeat(30) }, { maxBytes: 200, keep: 1000 });`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(Error(`worker ${worker}: exit ${code}: ${stderr}`)));
  })));
  const ids = readdirSync(dir).filter(name => name.endsWith(".jsonl")).flatMap(name => lines(dir, name)).map(line => line.id).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: workers * count }, (_, id) => id));
  assert.ok(archives(dir).length <= 1000);
  assert.equal(existsSync(join(dir, "events.lock")), false);
});
