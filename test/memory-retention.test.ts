import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryStore } from "../src/memory/store.ts";
import { appendRecord } from "../src/memory/log.ts";
import { newId } from "../src/memory/types.ts";
import { DAY_MS, STAMP_FILE, pruneJournals, retentionPass, type PruneOptions } from "../src/memory/retention.ts";
import { parseMemoryConfig, memoryOff } from "../src/memory/config.ts";
import { createJournalHook } from "../src/memory/journal-hook.ts";
import { parsePurgeArgs, registerIntentCommands } from "../src/memory/commands.ts";
import { agent, human, message, directive, decision } from "./memory-conformance.ts";
import type { FoldedState, Item, MessageInput } from "../src/memory/types.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z"), now = () => NOW;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const eligible = () => ({ eligible: true, reasons: [] });

function world() {
  const home = join(tmp("memory-retention-"), "memory");
  const store = new FileMemoryStore({ home, eligibilityCheck: eligible });
  const file = (session: string) => join(home, "journal", `${session}.jsonl`);
  const age = (session: string, days: number) => { const at = (NOW - days * DAY_MS) / 1000; utimesSync(file(session), at, at); };
  const say = (session: string, overrides: Partial<MessageInput> = {}) => {
    const entry = message({ session: { id: session, role: "main" }, ...overrides });
    store.appendMessage(entry);
    return entry;
  };
  const auto = (entry: MessageInput, overrides: Partial<Item> = {}) =>
    directive(entry, { authority: { mode: "auto", ruleVersion: 1 }, ...overrides });
  const options = (extra: Partial<PruneOptions> = {}): PruneOptions =>
    ({ home, state: () => store.readFolded(), requestsOn: false, days: 30, now, ...extra });
  const exists = (session: string) => existsSync(file(session));
  const live = (state: FoldedState) => Object.values(state.items).filter(item => item.status === "active" || item.status === "proposed");
  return { home, store, file, age, say, auto, options, exists, live };
}
function ageAll(w: ReturnType<typeof world>, days = 100) {
  for (const name of readdirSync(join(w.home, "journal"))) {
    const at = (NOW - days * DAY_MS) / 1000;
    utimesSync(join(w.home, "journal", name), at, at);
  }
}

test("old unreferenced files go; fresh, cutoff-boundary-minus and future files stay; boundary is inclusive", () => {
  const w = world();
  for (const id of ["old", "fresh", "edge", "justyoung", "future"]) w.say(id);
  w.age("old", 31); w.age("fresh", 1); w.age("edge", 30); w.age("justyoung", 30 - 1 / 86_400); w.age("future", -5);
  const result = pruneJournals(w.options());
  assert.deepEqual([w.exists("old"), w.exists("edge"), w.exists("fresh"), w.exists("justyoung"), w.exists("future")], [false, false, true, true, true]);
  assert.equal(result.removed, 2);
  assert.equal(result.examined, 5);
  assert.equal(result.kept, 3);
});

test("non-matching names, directories and symlinks are never touched", () => {
  const w = world();
  w.say("real"); w.age("real", 90);
  const state = w.store.readFolded(), journal = join(w.home, "journal"), outside = tmp("outside-"), target = join(outside, "target.jsonl");
  writeFileSync(target, "keep me");
  mkdirSync(join(outside, "dir.jsonl"));
  const old = (NOW - 90 * DAY_MS) / 1000;
  const names = ["notes.txt", ".hidden", "x.jsonl.tmp", "a b.jsonl"];
  for (const name of names) { writeFileSync(join(journal, name), "x"); utimesSync(join(journal, name), old, old); }
  mkdirSync(join(journal, "dir.jsonl"));
  symlinkSync(target, join(journal, "link.jsonl"));
  symlinkSync(join(outside, "dir.jsonl"), join(journal, "dirlink.jsonl"));
  const result = pruneJournals(w.options({ state }));
  assert.equal(w.exists("real"), false);
  assert.equal(result.removed, 1);
  for (const name of [...names, "dir.jsonl", "link.jsonl", "dirlink.jsonl"]) assert.ok(existsSync(join(journal, name)), name);
  assert.equal(readFileSync(target, "utf8"), "keep me");
  assert.ok(existsSync(join(outside, "dir.jsonl")));
});

test("live items protect their evidence; retired and unreferenced files are removed; fold is unchanged", () => {
  const w = world();
  const active = w.say("s-active"), proposedSource = w.say("s-proposed"), retiredSource = w.say("s-retired"), ancestorSource = w.say("s-ancestor");
  const successorSource = w.say("s-successor"), commandSource = w.say("s-command", { text: "/directive Always lint", originEvidence: ["tui-confirm"] });
  w.say("s-unref");
  const item = w.auto(active); assert.equal(w.store.addItem(item, agent).ok, true);
  assert.equal(w.store.addItem(directive(proposedSource), agent).ok, true);
  const retired = w.auto(retiredSource); w.store.addItem(retired, agent);
  assert.equal(w.store.retireItem(retired.id, "done", "Finished", { type: "agent_decision" }, agent).ok, true);
  const ancestor = w.auto(ancestorSource); w.store.addItem(ancestor, agent);
  const successor = w.auto(successorSource, { supersedes: [ancestor.id] });
  assert.equal(w.store.addItem(successor, agent).ok, true);
  const command = decision({ kind: "directive", text: "Always lint", source: { type: "user_message", ref: commandSource.id, span: { start: 11, end: 22 } },
    authority: { mode: "command", ruleVersion: 1, commandRef: commandSource.id } });
  assert.equal(w.store.addItem(command, human).ok, true);
  ageAll(w);
  const before = w.store.readFolded();
  assert.equal(before.items[ancestor.id]!.status, "superseded");
  const result = pruneJournals(w.options());
  for (const kept of ["s-active", "s-proposed", "s-ancestor", "s-successor", "s-command"]) assert.ok(w.exists(kept), kept);
  for (const gone of ["s-retired", "s-unref"]) assert.equal(w.exists(gone), false, gone);
  assert.equal(result.removed, 2);
  assert.equal(result.protectedCount, 5);
  const after = new FileMemoryStore({ home: w.home, eligibilityCheck: eligible }).readFolded();
  assert.deepEqual(w.live(after), w.live(before));
  assert.ok(w.live(after).length >= 4);
  assert.equal(after.items[ancestor.id]!.status, "superseded");
});

test("a confirm of a proposed item and its cited source are kept", () => {
  const w = world();
  const source = w.say("s-confirmed"); w.say("s-other");
  const order = directive(source);
  w.store.addItem(order, agent);
  assert.equal(w.store.confirm(order.id, human).ok, true);
  assert.equal(w.store.readFolded().items[order.id]!.status, "active");
  ageAll(w);
  pruneJournals(w.options());
  assert.ok(w.exists("s-confirmed"));
  assert.equal(w.exists("s-other"), false);
});

test("open requests protect only when requests are on; closed requests do not", () => {
  const w = world();
  const open = w.say("s-open"), closed = w.say("s-closed");
  appendRecord(join(w.home, "events.jsonl"), { schema: "memory.event/2", id: newId(), at: new Date().toISOString(), actor: human,
    type: "request_close", requestId: closed.id, status: "abandoned", reason: "done" });
  assert.ok(open && closed);
  ageAll(w);
  const off = pruneJournals(w.options({ dryRun: true, requestsOn: false }));
  assert.equal(off.wouldRemove, 2);
  const on = pruneJournals(w.options({ requestsOn: true }));
  assert.equal(on.removed, 1);
  assert.ok(w.exists("s-open"));
  assert.equal(w.exists("s-closed"), false);
  assert.equal(on.protectedCount, 1);
});

test("fail safe: broken evidence, throwing fold or unreadable file keeps everything", () => {
  const w = world();
  const source = w.say("s-live"); w.say("s-dead");
  w.store.addItem(w.auto(source), agent);
  ageAll(w);
  assert.equal(pruneJournals(w.options({ state: () => { throw new Error("boom"); } })).removed, 0);
  writeFileSync(join(w.home, "events.jsonl"), "garbage not json\n", { flag: "a" });
  assert.equal(pruneJournals(w.options()).removed, 0);
  assert.ok(w.exists("s-dead") && w.exists("s-live"));
});

test("an unreadable candidate is kept", { skip: process.getuid?.() === 0 }, () => {
  const w = world();
  const source = w.say("s-live"); w.say("s-locked");
  w.store.addItem(w.auto(source), agent);
  ageAll(w);
  chmodSync(w.file("s-locked"), 0o000);
  try {
    const result = pruneJournals(w.options());
    assert.equal(result.removed, 0);
    assert.ok(w.exists("s-locked"));
  } finally { chmodSync(w.file("s-locked"), 0o600); }
});

test("the current session file is never removed", () => {
  const w = world();
  w.say("current"); w.say("other");
  ageAll(w);
  const result = pruneJournals(w.options({ currentSessionId: "current" }));
  assert.ok(w.exists("current"));
  assert.equal(w.exists("other"), false);
  assert.equal(result.removed, 1);
});

test("a file appended to after it was inspected is kept", () => {
  const w = world();
  w.say("racy"); ageAll(w);
  let calls = 0;
  const result = pruneJournals(w.options({ state: () => {
    if (calls++ === 0) { writeFileSync(w.file("racy"), "more\n", { flag: "a" }); utimesSync(w.file("racy"), (NOW - 100 * DAY_MS) / 1000, (NOW - 100 * DAY_MS) / 1000); }
    return w.store.readFolded();
  } }));
  assert.equal(result.removed, 0);
  assert.ok(w.exists("racy"));
});

test("dry run deletes nothing and reports the counts a real run produces", () => {
  const w = world();
  const source = w.say("s-live"); w.say("s-a"); w.say("s-b"); w.say("s-new");
  w.store.addItem(w.auto(source), agent);
  ageAll(w); w.age("s-new", 1);
  const dry = pruneJournals(w.options({ dryRun: true }));
  assert.deepEqual(readdirSync(join(w.home, "journal")).sort(), ["s-a.jsonl", "s-b.jsonl", "s-live.jsonl", "s-new.jsonl"]);
  assert.equal(dry.removed, 0);
  const real = pruneJournals(w.options());
  assert.equal(real.removed, dry.wouldRemove);
  assert.deepEqual({ ...real, removed: 0, wouldRemove: dry.wouldRemove }, dry);
});

test("a missing journal directory is a quiet no-op and nothing is created", () => {
  const home = join(tmp("memory-retention-empty-"), "memory");
  const result = pruneJournals({ home, state: () => { throw new Error("never"); }, requestsOn: false, days: 30, now });
  assert.equal(result.examined, 0);
  assert.equal(retentionPass({ home, state: () => { throw new Error("never"); }, requestsOn: false, days: 30, now }), undefined);
  assert.equal(existsSync(home), false);
});

test("retentionPass: daily throttle, stamp written even when capped, cursor resumes", () => {
  const w = world();
  for (const id of ["a", "b", "c"]) w.say(id);
  ageAll(w);
  const base = { home: w.home, state: () => w.store.readFolded(), requestsOn: false, days: 30 };
  const first = retentionPass({ ...base, now, maxFiles: 1 })!;
  assert.deepEqual([first.removed, first.capped, first.cursor], [1, true, "a.jsonl"]);
  assert.deepEqual(JSON.parse(readFileSync(join(w.home, STAMP_FILE), "utf8")), { at: NOW, cursor: "a.jsonl" });
  assert.equal(retentionPass({ ...base, now: () => NOW + DAY_MS - 1 }), undefined);
  assert.equal(readdirSync(join(w.home, "journal")).length, 2);
  const second = retentionPass({ ...base, now: () => NOW + DAY_MS, maxFiles: 1 })!;
  assert.deepEqual([second.examined, second.removed, second.cursor], [1, 1, "b.jsonl"]);
  const third = retentionPass({ ...base, now: () => NOW + 2 * DAY_MS })!;
  assert.deepEqual([third.removed, third.capped], [1, false]);
  assert.equal(JSON.parse(readFileSync(join(w.home, STAMP_FILE), "utf8")).cursor, "");
});

test("the time cap stops the pass and reports capped", () => {
  const w = world();
  for (const id of ["a", "b", "c"]) w.say(id);
  ageAll(w);
  let tick = 0;
  const result = pruneJournals(w.options({ maxMs: 5, now: () => NOW + (tick++) * 4 }));
  assert.equal(result.capped, true);
  assert.ok(result.removed < 3);
});

test("memory config: retentionDays defaults to 30, accepts 1..3650, anything else turns the block off", () => {
  assert.equal(parseMemoryConfig({ memory: { journal: true } }).config.retentionDays, 30);
  assert.equal(memoryOff().retentionDays, 30);
  for (const days of [1, 90, 3650]) assert.equal(parseMemoryConfig({ memory: { journal: true, retentionDays: days } }).config.retentionDays, days);
  for (const days of [0, -1, 1.5, "30", 4000, null, NaN]) {
    const parsed = parseMemoryConfig({ memory: { journal: true, retentionDays: days } });
    assert.deepEqual(parsed.config, memoryOff(), String(days));
    assert.deepEqual(parsed.reasons, ["memory.retentionDays must be an integer from 1 to 3650"]);
  }
});

function hookWorld(memory: unknown) {
  const dir = tmp("memory-retention-hook-"), agentDir = join(dir, "agent"), configFile = join(dir, "config.json");
  mkdirSync(agentDir);
  writeFileSync(configFile, JSON.stringify(memory === undefined ? {} : { memory }));
  const logs: Array<[string, any]> = [];
  const saved = process.env.PI_MEMORY_HOME; delete process.env.PI_MEMORY_HOME;
  dirs.push(dir);
  const hook = createJournalHook({ agentDir, configFile, host: () => undefined, log: (_ctx, event, data) => { logs.push([event, data]); } });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "current", getSessionName: () => undefined } };
  return { dir, agentDir, hook, ctx, logs, restore: () => { if (saved !== undefined) process.env.PI_MEMORY_HOME = saved; } };
}

test("hook: memory absent or journal off creates nothing and logs nothing", async () => {
  for (const memory of [undefined, { journal: false }, { journal: true, scope: { mode: "only", names: [] } }]) {
    const h = hookWorld(memory);
    try {
      await h.hook.retention(h.ctx);
      assert.equal(existsSync(join(h.agentDir, "memory")), false);
      assert.deepEqual(readdirSync(h.agentDir), []);
      assert.deepEqual(h.logs, []);
    } finally { h.restore(); }
  }
});

test("hook: journal on prunes old files daily, keeps the current session, and logs one summary", async () => {
  const h = hookWorld({ journal: true, scope: { mode: "all" }, retentionDays: 10 });
  try {
    const journal = join(h.agentDir, "memory", "journal");
    await h.hook.retention(h.ctx);
    assert.equal(existsSync(journal), false, "no journal dir: nothing is created");
    const store = new FileMemoryStore({ agentDir: h.agentDir });
    for (const id of ["current", "stale", "young"]) store.appendMessage(message({ session: { id, role: "main" } }));
    const old = (Date.now() - 40 * DAY_MS) / 1000;
    for (const id of ["current", "stale"]) utimesSync(join(journal, `${id}.jsonl`), old, old);
    await h.hook.retention(h.ctx);
    assert.deepEqual(readdirSync(journal).sort(), ["current.jsonl", "young.jsonl"]);
    assert.ok(existsSync(join(h.agentDir, "memory", STAMP_FILE)));
    assert.equal(h.logs.filter(([event]) => event === "journal_pruned").length, 1);
    assert.equal(h.logs.find(([event]) => event === "journal_pruned")![1].removed, 1);
    await h.hook.retention(h.ctx);
    assert.equal(h.logs.filter(([event]) => event === "journal_pruned").length, 1, "throttled");
  } finally { h.restore(); }
});

test("purge args: --days N, --dry-run, both; everything else refused", () => {
  assert.deepEqual(parsePurgeArgs([]), { dryRun: false });
  assert.deepEqual(parsePurgeArgs(["--days", "7"]), { days: 7, dryRun: false });
  assert.deepEqual(parsePurgeArgs(["--dry-run"]), { dryRun: true });
  assert.deepEqual(parsePurgeArgs(["--dry-run", "--days", "3650"]), { days: 3650, dryRun: true });
  for (const bad of [["--days", "0"], ["--days", "x"], ["--days"], ["--days", "3651"], ["--days", "1.5"], ["--days", "-1"], ["--force"],
    ["--dry-run", "--dry-run"], ["--days", "1", "--days", "2"], ["7"]]) {
    assert.throws(() => parsePurgeArgs(bad), /Use \/memory purge \[--days N\] \[--dry-run\]/, bad.join(" "));
  }
});

function commandWorld(config: ReturnType<typeof memoryOff>) {
  const w = world();
  const commands = new Map<string, (text: string, ctx: any) => Promise<void>>(), replies: string[] = [];
  const pi = { registerCommand: (name: string, def: any) => commands.set(name, def.handler), sendMessage: (m: any) => replies.push(m.content) };
  const runtime = { enabled: () => true, store: async () => w.store, actor: () => agent, agentDir: join(w.home, ".."), memoryConfig: () => config };
  registerIntentCommands(pi as never, runtime as never);
  const ctx = { mode: "print", cwd: "/tmp", sessionManager: { getSessionId: () => "current", getSessionName: () => undefined } };
  const memory = (text: string) => commands.get("memory")!(text, ctx);
  return { w, memory, replies };
}

test("/memory purge: refused when the journal is off; dry run and real run report counts", async () => {
  const saved = process.env.PI_MEMORY_HOME; delete process.env.PI_MEMORY_HOME;
  try {
    const off = commandWorld(memoryOff());
    off.w.say("old"); ageAll(off.w);
    await off.memory("purge");
    assert.deepEqual(off.replies, ["memory disabled"]);
    assert.ok(off.w.exists("old"));

    const on = commandWorld({ ...memoryOff(), journal: true, scope: { mode: "all", names: [] } });
    on.w.say("old"); on.w.say("recent");
    const longAgo = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(on.w.file("old"), longAgo, longAgo);
    await on.memory("purge --dry-run");
    assert.ok(on.w.exists("old"));
    await on.memory("purge --days 0");
    await on.memory("purge");
    assert.equal(on.w.exists("old"), false);
    assert.ok(on.w.exists("recent"));
    assert.deepEqual(on.replies, ["purge: would remove 1, kept 1 (protected 0), errors 0", "Use /memory purge [--days N] [--dry-run]",
      "purge: removed 1, kept 1 (protected 0), errors 0"]);
  } finally { if (saved !== undefined) process.env.PI_MEMORY_HOME = saved; }
});
