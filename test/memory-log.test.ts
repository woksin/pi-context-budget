import { test, afterEach } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, truncateSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { FileMemoryStore } from "../src/memory/store.ts";
import { appendRecord, scanLog, crc32 } from "../src/memory/log.ts";
import { decision, message, agent, memoryConformance } from "./memory-conformance.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "memory-log-"));
  directories.push(home);
  return new FileMemoryStore({ home });
}
memoryConformance("core", fixture);

test("torn tail: a truncated line cannot swallow the next append", () => {
  const store = fixture(), first = decision(), torn = decision(), last = decision();
  store.addItem(first, agent);
  const file = join(store.home, "events.jsonl"), complete = statSync(file).size;
  store.addItem(torn, agent);
  truncateSync(file, complete + 60);
  store.addItem(last, agent);
  assert.deepEqual(Object.keys(store.readFolded().items), [first.id, last.id]);
  assert.equal(store.health().tornTail, 1);
  assert.equal(store.health().corrupt, 0);
});

test("crash: an exited half-line writer preserves both neighbouring records", () => {
  const store = fixture(), first = decision(), last = decision();
  store.addItem(first, agent);
  const file = join(store.home, "events.jsonl");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(file)}, '\\n{"schema":"memory.event/2","id":'); process.exit(23);`]);
  assert.equal(child.status, 23);
  store.addItem(last, agent);
  assert.deepEqual(Object.keys(store.readFolded().items), [first.id, last.id]);
  assert.equal(store.health().tornTail, 1);
});

test("CRC-corrupt but parseable records are ignored without rewriting", () => {
  const store = fixture();
  store.addItem(decision(), agent);
  const file = join(store.home, "events.jsonl");
  const damaged = readFileSync(file, "utf8").replace("Use a log", "Use a bog");
  writeFileSync(file, damaged);
  assert.equal(store.health().corrupt, 1);
  assert.equal(Object.keys(store.readFolded().items).length, 0);
  assert.equal(readFileSync(file, "utf8"), damaged);
  assert.equal(crc32("123456789"), "cbf43926");
});

test("append protocol, line caps, blank lines, permissions and incomplete tail", () => {
  const store = fixture(), file = join(store.home, "events.jsonl");
  appendRecord(file, { id: "test", value: "ok" });
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.startsWith("\n{") && raw.endsWith("}\n"));
  assert.equal(statSync(store.home).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => appendRecord(file, { text: "x".repeat(8192) }), /too_large/);
  writeFileSync(file, raw + '\n{"partial":');
  assert.equal(scanLog(file).records.length, 1);
  assert.equal(scanLog(file).tornTail, 1);
  assert.ok(scanLog(file).blank > 0);
});

test("journal bodies exceeding 64 KiB use verified blobs and private files", () => {
  const store = fixture(), text = "λ".repeat(40000), entry = message({ text });
  const written = store.appendMessage(entry);
  const sha = createHash("sha256").update(text).digest("hex");
  assert.equal(written.blob?.sha256, sha);
  assert.equal(store.getMessage(entry.id!)?.text, text);
  assert.deepEqual(store.appendMessage(entry), written);
  assert.equal(readFileSync(join(store.home, "blobs", `${sha}.txt`), "utf8"), text);
  for (const directory of ["journal", "answers", "blobs"]) assert.equal(statSync(join(store.home, directory)).mode & 0o777, 0o700);
  assert.equal(statSync(join(store.home, "blobs", `${sha}.txt`)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(store.home, "blobs")), [`${sha}.txt`]);
});

test("layout: agentDir default and PI_MEMORY_HOME override", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-layout-")); directories.push(root);
  const previous = process.env.PI_MEMORY_HOME;
  try {
    delete process.env.PI_MEMORY_HOME;
    assert.equal(new FileMemoryStore({ agentDir: root }).home, join(root, "memory"));
    process.env.PI_MEMORY_HOME = join(root, "override");
    assert.equal(new FileMemoryStore({ agentDir: root }).home, join(root, "override"));
    assert.equal(new FileMemoryStore({ home: join(root, "explicit") }).home, join(root, "explicit"));
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_HOME;
    else process.env.PI_MEMORY_HOME = previous;
  }
});

test("event append is fsynced before applied, and an fsync failure cannot report applied", t => {
  const store = fixture(), file = join(store.home, "events.jsonl");
  const fsync = fs.fsyncSync;
  let synced = false, failSync = false;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (failSync) throw Error("fsync unavailable");
    assert.equal(scanLog(file).records.length, 1);
    synced = true;
    fsync(fd);
  });
  syncBuiltinESMExports();
  assert.equal(store.addItem(decision(), agent).status, "applied");
  assert.equal(synced, true);
  failSync = true;
  assert.throws(() => store.addItem(decision(), agent), /fsync unavailable/);
});

test("an appended line missing from readback returns an explicit rejection", () => {
  const store = fixture(), file = join(store.home, "events.jsonl");
  const readFolded = store.readFolded.bind(store);
  store.readFolded = () => { truncateSync(file, 0); return readFolded(); };
  const result = store.addItem(decision(), agent);
  assert.equal(result.status, "rejected");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "append_not_read_back");
  assert.ok(result.eventId);
});

// Only the extension may wire flag-gated hooks (which load the store lazily).
// Core may import the pure, type-import-only authorization helper; all other runtime files stay memory-free.
const WIRED: Record<string, string[]> = {
  "src/extension.ts": ["./memory/config.ts", "./memory/journal-hook.ts", "./memory/requests-hook.ts", "./memory/launch.ts", "./memory/tools.ts", "./memory/handoff-hook.ts", "./memory/recall.ts", "./memory/resume.ts"],
  "src/core.ts": ["./memory/authorize.ts", "./memory/handoff-block.ts"],
  "src/collect.ts": ["./memory/handoff-block.ts"],
  "src/validate.ts": ["./memory/handoff-block.ts"],
};
test("inert: no runtime file outside src/memory imports the memory store", () => {
  const root = join(import.meta.dirname, "..");
  const runtime = ["context-budget.ts", ...readdirSync(join(root, "src")).filter(name => name.endsWith(".ts")).map(name => join("src", name))];
  for (const file of runtime) {
    const imports = [...readFileSync(join(root, file), "utf8").matchAll(/from\s+["']([^"']*memory\/[^"']*)["']/g)].map(match => match[1]);
    const allowed = WIRED[file] ?? [];
    assert.deepEqual(imports.filter(path => !allowed.includes(path)), [], file);
  }
});
