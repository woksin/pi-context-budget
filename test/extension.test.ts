import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const base = resolve(import.meta.dirname, "../.ai-work/hooks");
mkdirSync(base, { recursive: true });
const required = { goal: "finish", next_step: "write result", facts: "Read part one" };
async function harness(mode = "enforce", overrides: Record<string, unknown> = {}, withGuard = false, hosts = new SessionHosts()) {
  const dir = mkdtempSync(join(base, "case-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json");
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  delete process.env.PI_SESSION_WRAPPER; delete process.env.PI_RELAUNCH_MARKER;
  delete process.env.PI_SESSION_WRAPPER_PID; delete process.env.PI_SESSION_LAUNCH_ID;
  if (withGuard) {
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "lib"), { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "lib/guards.ts"), 'export const isGuardOff = () => globalThis[Symbol.for("context-budget:test-guard")] === true;');
  }
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode, main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 }, ...overrides }));
  const handlers = new Map<string, (e: any, ctx: ExtensionContext) => Promise<any>>();
  let tool: any;
  const notifications: string[] = [], footer: (string | undefined)[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); }, registerTool: (value: any) => { tool = value; } } as unknown as ExtensionAPI;
  let usage: number | null = 100, shutdown = 0, compact = 0;
  const branch: any[] = [];
  const sid = `test-${dir.split("/").at(-1)}`;
  const ctx = { cwd: dir, hasUI: false, model: { provider: "test", id: "test" },
    sessionManager: { getSessionId: () => sid, getSessionFile: () => join(dir, "session.jsonl"), getHeader: () => ({}), getBranch: () => branch },
    getContextUsage: () => ({ tokens: usage }), shutdown: () => { shutdown++; },
    ui: { notify: (text: string) => notifications.push(text), setStatus: (_key: string, text?: string) => footer.push(text) },
    compact: (opts: any) => {
      compact++;
      // Real pi ordering: failed hook is awaited BEFORE compact's onError callback.
      void handlers.get("session_compact_failed")!({ reason: "manual", errorMessage: "Nothing to compact (session too small)", aborted: false, fromExtension: false }, ctx)
        .then(() => opts.onError(new Error("Nothing to compact (session too small)")));
    },
  } as unknown as ExtensionContext;
  await createContextBudgetExtension({ agentDir: process.env.PI_CODING_AGENT_DIR!, hosts })(pi);
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  await emit("session_start");
  const turn = async (tokens = 300) => { usage = tokens; return emit("turn_end", { message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } }); };
  const handoff = (input = required) => tool.execute("h", input, undefined, undefined, ctx);
  return { dir, ctx, sid, emit, turn, handoff, notifications, footer, branch, setTokens: (n: number | null) => { usage = n; }, counters: () => ({ shutdown, compact }),
    events: () => readFileSync(join(dir, "state/events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)),
    status: () => JSON.parse(readFileSync(join(dir, "state/status", `${sid}.json`), "utf8")) };
}
test("same-turn retain-none handoff, floor reset, successful progress, advisory once", async () => {
  const h = await harness();
  await h.turn(100);
  assert.equal(h.notifications.length, 1);
  await h.turn(300);
  assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
  await h.emit("tool_call", { toolName: "context_handoff" });
  const result = await h.handoff();
  const draft = await h.turn();
  assert.equal(draft.continue, true);
  assert.equal(draft.entries[0].firstKeptEntryId, null);
  assert.equal(draft.entries[0].details.n, 1);
  assert.equal(draft.entries[0].details.path, result.details.handoff.path);
  h.setTokens(null);
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
  assert.equal(h.status().handoffCount, 1);
  assert.equal(h.status().floor, null);
  await h.turn(250); // Fresh floor can exceed handoff threshold; no immediate loop.
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
});
test("observe mode logs would-do events but no blocking, handoff files, continuation, compaction, shutdown", async () => {
  const h = await harness("observe");
  await h.turn(100); await h.turn(1100);
  assert.equal(await h.emit("tool_call", { toolName: "write" }), undefined);
  assert.equal(await h.emit("agent_before_settle"), undefined);
  const result = await h.handoff();
  assert.equal(result.details.handoff, undefined);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(await h.emit("session_before_compact", { reason: "threshold" }), undefined);
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(h.counters(), { shutdown: 0, compact: 0 });
  assert.ok(h.events().some(e => e.event === "would_relaunch"));
  assert.ok(h.events().some(e => e.event === "would_block"));
  assert.equal(h.status().mode, "observe");
  assert.equal(h.status().phase, "fallback-armed");
  assert.equal(h.status().action, "relaunch");
  assert.equal(h.status().projected, true);
  assert.ok(h.events().some(e => e.event === "would_soft_notice"));
});
test("hard without wrapper commits a valid handoff and resumes instead of trapping tools", async () => {
  const h = await harness();
  await h.turn(100); await h.turn(1200);
  assert.equal((await h.emit("agent_before_settle")).continue, true);
  assert.equal(await h.emit("agent_before_settle"), undefined);
  await h.handoff();
  const committed = await h.turn(1200);
  assert.equal(committed.entries[0].type, "compaction");
  h.setTokens(null);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 0);
  assert.equal(await h.emit("tool_call", { toolName: "bash" }), undefined);
});
test("hard fallback writes marker before shutdown only in wrapper; provider errors do not relaunch", async () => {
  const h = await harness("enforce", { maxHandoffsPerSession: 1 });
  const nonce = "a".repeat(32);
  process.env.PI_SESSION_WRAPPER = "1";
  process.env.PI_SESSION_WRAPPER_PID = String(process.pid); process.env.PI_SESSION_LAUNCH_ID = nonce;
  process.env.PI_RELAUNCH_MARKER = join(h.dir, "relaunch", `${process.pid}-${nonce}.json`);
  await h.turn(100); await h.handoff(); await h.turn(1200);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 1);
  const m = JSON.parse(readFileSync(process.env.PI_RELAUNCH_MARKER, "utf8"));
  assert.equal(m.cwd, h.dir); assert.ok(existsSync(m.handoff)); assert.equal(m.launchPrompt, null);
  const err = await harness();
  process.env.PI_SESSION_WRAPPER = "1";
  process.env.PI_SESSION_WRAPPER_PID = String(process.pid); process.env.PI_SESSION_LAUNCH_ID = nonce;
  process.env.PI_RELAUNCH_MARKER = join(err.dir, `${process.pid}-${nonce}.json`);
  await err.turn(1200);
  await err.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
  await err.emit("agent_settled", { aborted: false });
  assert.equal(err.counters().shutdown, 0);
});
test("backstop summaries are unique; stale stored handoff is replaced mechanically", async () => {
  const h = await harness();
  await h.turn(100);
  await h.handoff(); await h.turn();
  const a = await h.emit("session_before_compact", { preparation: { tokensBefore: 300 }, reason: "threshold" });
  const b = await h.emit("session_before_compact", { preparation: { tokensBefore: 300 }, reason: "overflow" });
  assert.notEqual(a.compaction.summary, b.compaction.summary);
  assert.equal(a.compaction.firstKeptEntryId, null);
  await h.emit("tool_call", { toolName: "read" });
  const c = await h.emit("session_before_compact", { preparation: { tokensBefore: 300 }, reason: "overflow" });
  assert.match(c.compaction.summary, /Emergency handoff/);
});
test("idle requires pending work, commits this turn, tolerates Nothing to compact, invalidates on tool", async () => {
  const h = await harness("enforce", { idleMinutes: 0.0000001, idleMinTokens: 50, keepRecentTokens: 10 });
  await h.turn(100);
  assert.equal(await h.emit("agent_before_settle"), undefined);
  const key = Symbol.for("pi-jobs.liveManagers");
  const global = globalThis as Record<symbol, unknown>;
  global[key] = new Set([{ list: () => [{ id: "watch", status: "running", kind: "watch" }] }]);
  try {
    assert.equal((await h.emit("agent_before_settle")).continue, true);
    await h.emit("agent_start"); // Internal continuation: must NOT erase the idle request.
    await h.handoff();
    assert.equal((await h.turn(100)).entries[0].type, "compaction"); // Same-turn reset, not stored only.
    await h.emit("agent_settled", { aborted: false });
    const now = Date.now;
    Date.now = () => now() + 1000;
    try { assert.deepEqual(await h.emit("input", { source: "rpc", text: "next" }), { action: "continue" }); }
    finally { Date.now = now; }
    assert.equal(h.counters().compact, 1);
    assert.ok(h.events().some(e => e.event === "compaction_ignored" && e.data?.classification === "nothing-to-compact" || e.classification === "nothing-to-compact"));
    await h.emit("before_agent_start");
    h.setTokens(100);
    assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: "after-idle-noop" }), undefined);
  } finally { delete global[key]; }
});
test("idle handoff resets before a notification or new run within the idle window", async () => {
  const h = await harness("enforce", { idleMinTokens: 50 }); // Default 50-minute window.
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, previous = global[key];
  global[key] = new Set([{ list: () => [{ id: "watch", status: "running" }] }]);
  try {
    await h.turn(100);
    const request = await h.emit("agent_before_settle");
    assert.equal(request.continue, true);
    assert.match(request.entries[0].content, /context resets at the end of this turn/i);
    await h.emit("agent_start");
    const result = await h.handoff();
    assert.match(result.content[0].text, /context resets at the end of this turn/i);
    assert.equal(await h.emit("agent_before_settle"), undefined);
    await assert.rejects(h.handoff(), /already stored/);
    const draft = await h.turn(100);
    assert.equal(draft.continue, true);
    assert.equal(draft.entries[0].type, "compaction");
    assert.equal(draft.entries[0].firstKeptEntryId, null);
    assert.equal(draft.entries[0].details.path, result.details.handoff.path);
    assert.equal(draft.entries[0].summary, result.details.handoff.text);
    assert.equal(h.status().handoffCount, 0);
    assert.equal(draft.entries[0].details.source, "idle");
    assert.equal(h.status().tokens, null);
    assert.equal(h.status().floor, null);
    h.setTokens(null);
    await h.emit("agent_settled", { aborted: false });
    await h.emit("input", { source: "extension", text: "watch completed" });
    await h.emit("before_agent_start");
    await h.emit("agent_start");
    assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: "after-idle-commit" }), undefined);
    assert.equal(await h.emit("agent_before_settle"), undefined);
    assert.deepEqual(h.counters(), { shutdown: 0, compact: 0 });
    assert.equal(h.events().filter(e => e.event === "idle_handoff_requested").length, 1);
    const commits = h.events().filter(e => e.event === "handoff_committed");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].path, result.details.handoff.path);
    assert.equal(commits[0].source, "idle");
    h.branch.push(draft.entries[0]);
    await h.emit("session_tree");
    assert.equal(h.status().handoffCount, 0);
  } finally { global[key] = previous; }
});
test("blocked sibling keeps pending handoff; already-running sibling invalidates it", async () => {
  const h = await harness();
  await h.turn(100); await h.handoff();
  assert.equal((await h.emit("tool_call", { toolName: "read", toolCallId: "blocked" })).block, true);
  await h.emit("tool_execution_end", { toolName: "read", toolCallId: "blocked", isError: true });
  assert.equal((await h.turn()).entries[0].type, "compaction");
  await h.handoff({ ...required, facts: "Read part two and verified results" });
  await h.emit("tool_execution_end", { toolName: "read", toolCallId: "already-running", isError: false });
  assert.equal(await h.turn(), undefined);
});
test("shared guard opt-out disables blocks, handoffs and backstop, including an existing fallback", async () => {
  const global = globalThis as Record<symbol, unknown>, key = Symbol.for("context-budget:test-guard");
  const h = await harness("enforce", {}, true);
  await h.turn(1200);
  global[key] = true;
  try {
    assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
    assert.equal((await h.handoff()).details.handoff, undefined);
    assert.equal(await h.emit("session_before_compact", {}), undefined);
    assert.equal(await h.emit("agent_before_settle"), undefined);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.counters().shutdown, 0);
  } finally { delete global[key]; }
});
test("primary status exposes hosting identity and active/ended lifecycle", async () => {
  const h = await harness();
  assert.equal(h.status().primarySessionId, h.sid);
  assert.equal(h.status().state, "active");
  await h.emit("session_shutdown");
  assert.equal(h.status().primarySessionId, h.sid);
  assert.equal(h.status().state, "ended");
});
test("in-process subagent never writes the inherited parent marker", async () => {
  const hosts = new SessionHosts();
  const parent = hosts.acquire("real-primary");
  const h = await harness("enforce", { subagent: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 } }, false, hosts);
  (h.ctx.sessionManager as any).getHeader = () => ({}); // In-memory children have NO parentSession.
  const nonce = "b".repeat(32);
  process.env.PI_SESSION_WRAPPER = "1"; process.env.PI_SESSION_WRAPPER_PID = String(process.pid); process.env.PI_SESSION_LAUNCH_ID = nonce;
  process.env.PI_RELAUNCH_MARKER = join(h.dir, `${process.pid}-${nonce}.json`);
  await h.turn(1200); await h.handoff(); await h.turn(1200);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 0);
  assert.equal(existsSync(process.env.PI_RELAUNCH_MARKER), false);
  assert.equal(h.status().role, "subagent");
  assert.equal(h.status().sessionId, h.sid);
  assert.equal(h.status().pid, process.pid);
  assert.equal(h.status().primarySessionId, "real-primary");
  assert.equal(h.status().state, "active");
  await h.emit("session_shutdown"); parent.release();
  assert.equal(h.status().primarySessionId, "real-primary");
  assert.equal(h.status().state, "ended");
});
test("new external runs clear the idle-only request; invalid config falls back to observe", async () => {
  const h = await harness();
  await h.emit("before_agent_start");
  await h.handoff();
  assert.equal((await h.turn()).continue, true);
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG!, "{broken");
  await h.emit("input", { text: "next" }); await h.turn();
  assert.equal(h.status().mode, "observe");
  assert.ok(h.events().some(e => e.event === "config_error"));
});
test("observe records both warm-cache idle request and would-reset without calling compact", async () => {
  const h = await harness("observe", { idleMinutes: 0.000001, idleMinTokens: 50, keepRecentTokens: 10 });
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>;
  global[key] = new Set([{ list: () => [{ status: "running" }] }]);
  const now = Date.now;
  try {
    await h.turn(100); await h.emit("agent_before_settle");
    await h.emit("agent_settled", { aborted: false });
    Date.now = () => now() + 1000;
    await h.emit("input", { text: "next" });
    assert.ok(h.events().some(e => e.event === "would_idle_handoff"));
    assert.ok(h.events().some(e => e.event === "would_idle_compact"));
    assert.equal(h.counters().compact, 0);
  } finally { Date.now = now; delete global[key]; }
});
test("telemetry write failure cannot discard a prepared compaction boundary", async () => {
  const h = await harness();
  const status = join(h.dir, "state/status", `${h.sid}.json`);
  unlinkSync(status); mkdirSync(status); // Only this test's own generated status path.
  await h.handoff();
  const draft = await h.turn();
  assert.equal(draft.entries[0].type, "compaction");
  assert.ok(h.events().some(e => e.event === "status_error"));
});
for (const reason of ["manual", "threshold", "overflow"]) for (const mode of ["observe", "off"]) {
  test(`${mode} preserves native ${reason} compaction without a summary or cancellation`, async () => {
    const h = await harness(mode);
    assert.equal(await h.emit("session_before_compact", { reason }), undefined);
    assert.deepEqual(h.counters(), { shutdown: 0, compact: 0 });
  });
}
for (const failure of [
  { reason: "manual", aborted: true },
  { reason: "manual", errorMessage: "Nothing to compact (session too small)" },
  { reason: "manual", errorMessage: "Already compacted" },
  { reason: "overflow", errorMessage: "Compaction cancelled", aborted: true },
]) test(`benign failure leaves ordinary tools available: ${JSON.stringify(failure)}`, async () => {
  const h = await harness(); await h.turn(100);
  await h.emit("session_compact_failed", failure);
  assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: "after-cancel" }), undefined);
});
test("an inherited parent PID/nonce cannot authorize marker writing or shutdown", async () => {
  const h = await harness("enforce", { maxHandoffsPerSession: 1 });
  process.env.PI_SESSION_WRAPPER = "1";
  process.env.PI_SESSION_WRAPPER_PID = String(process.pid + 1);
  process.env.PI_SESSION_LAUNCH_ID = "c".repeat(32);
  process.env.PI_RELAUNCH_MARKER = join(h.dir, `${process.pid + 1}-${process.env.PI_SESSION_LAUNCH_ID}.json`);
  await h.turn(100); await h.handoff(); await h.turn(300);
  h.setTokens(null);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(existsSync(process.env.PI_RELAUNCH_MARKER), false);
  assert.equal(h.counters().shutdown, 0);
});
test("fork ancestry does not reduce the main budget or remove wrapper ownership", async () => {
  const h = await harness();
  (h.ctx.sessionManager as any).getHeader = () => ({ parentSession: "/main-before-fork.jsonl" });
  process.env.PI_SESSION_WRAPPER = "1"; process.env.PI_SESSION_WRAPPER_PID = String(process.pid);
  process.env.PI_SESSION_LAUNCH_ID = "d".repeat(32);
  process.env.PI_RELAUNCH_MARKER = join(h.dir, `${process.pid}-${process.env.PI_SESSION_LAUNCH_ID}.json`);
  await h.emit("session_start", { reason: "fork" });
  assert.equal(h.status().role, "main"); assert.equal(h.status().wrapper, true);
});
test("emergency backstop stays bounded even when automatic registries are enormous", async () => {
  const h = await harness();
  h.branch.push(...Array.from({ length: 4 }, () => ({ type: "message", message: { role: "user", content: "字".repeat(50000) } })));
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, previous = global[key];
  global[key] = new Set([{ list: () => Array.from({ length: 1000 }, () => ({ status: "running", command: "x".repeat(50000) })) }]);
  try {
    const result = await h.emit("session_before_compact", { reason: "overflow" });
    assert.ok(Buffer.byteLength(result.compaction.summary) < 12288);
    assert.match(result.compaction.summary, /Emergency handoff/);
  } finally { global[key] = previous; }
});
test("inactive backstop remains inert even when context observation fails", async () => {
  const h = await harness("observe");
  (h.ctx as any).getContextUsage = () => { throw new Error("probe failed"); };
  assert.equal(await h.emit("session_before_compact", { reason: "manual" }), undefined);
});
test("hook I/O failures are logged, backstop cancels instead of default summarizer", async () => {
  const h = await harness();
  (h.ctx as any).getContextUsage = () => { throw new Error("probe failed"); };
  assert.equal(await h.turn(), undefined);
  (h.ctx.sessionManager as any).getBranch = () => { throw new Error("branch unavailable"); };
  assert.deepEqual(await h.emit("session_before_compact", { preparation: { tokensBefore: 99 } }), { cancel: true });
  assert.ok(h.events().some(e => e.event === "hook_error"));
  assert.ok(h.events().some(e => e.event === "backstop_error"));
});

test("resume check runs before writing and only after a committed reset, before the resumed context", async t => {
  const old = process.env.PI_RESUME_CHECK;
  delete process.env.PI_RESUME_CHECK;
  t.after(() => { if (old === undefined) delete process.env.PI_RESUME_CHECK; else process.env.PI_RESUME_CHECK = old; });
  const h = await harness("enforce", { resumeChecks: { L0: "printf x >> checks; cat checks" } });
  (h.ctx.sessionManager as any).getSessionName = () => "L0";
  assert.equal(await h.emit("context", { messages: [] }), undefined);
  const result = await h.handoff(), file = result.details.handoff.path;
  assert.match(readFileSync(file, "utf8"), /## Resume check\ncommand: .*\nexit: 0\nx/);
  assert.equal(readFileSync(join(h.dir, "checks"), "utf8"), "x");
  assert.equal(await h.emit("context", { messages: [] }), undefined); // not reset yet
  const committed = await h.turn();
  h.branch.push({ ...committed.entries[0], id: "boundary-1" });
  h.setTokens(null);
  const resumed = await h.emit("context", { messages: [] });
  assert.match(resumed.messages[0].content, /after context reset.*\ncommand: .*\nexit: 0\nxx/s);
  assert.equal(readFileSync(join(h.dir, "checks"), "utf8"), "xx");
  await h.emit("context", { messages: [] });
  assert.equal(readFileSync(join(h.dir, "checks"), "utf8"), "xx"); // no rerun per tool turn
  const second = await h.emit("session_before_compact", { reason: "manual" });
  h.branch.push({ type: "compaction", id: "boundary-2", details: second.compaction.details });
  await h.emit("context", { messages: [] });
  assert.equal(readFileSync(join(h.dir, "checks"), "utf8"), "xxx");
});

test("env resume check beats config; nonzero status does not break either injection point", async t => {
  const old = process.env.PI_RESUME_CHECK;
  process.env.PI_RESUME_CHECK = "echo from-env; exit 9";
  t.after(() => { if (old === undefined) delete process.env.PI_RESUME_CHECK; else process.env.PI_RESUME_CHECK = old; });
  const h = await harness("enforce", { resumeChecks: { L0: "echo from-config" } });
  (h.ctx.sessionManager as any).getSessionName = () => "L0";
  const handoff = await h.handoff();
  assert.match(handoff.details.handoff.text, /exit: 9\nfrom-env/);
  assert.ok(!handoff.details.handoff.text.includes("from-config"));
  const committed = await h.turn();
  h.branch.push({ ...committed.entries[0], id: "env-boundary" });
  assert.match((await h.emit("context", { messages: [] })).messages[0].content, /exit: 9\nfrom-env/);
});

test("resume commands stay inactive in off/observe and guard-off; unconfigured enforcement stays unchanged", async t => {
  const old = process.env.PI_RESUME_CHECK;
  process.env.PI_RESUME_CHECK = "touch should-not-run";
  t.after(() => { if (old === undefined) delete process.env.PI_RESUME_CHECK; else process.env.PI_RESUME_CHECK = old; });
  for (const m of ["off", "observe"]) {
    const h = await harness(m);
    await h.handoff();
    h.branch.push({ type: "compaction", id: m, details: { kind: "handoff" } });
    assert.equal(await h.emit("context", { messages: [] }), undefined);
    assert.equal(existsSync(join(h.dir, "should-not-run")), false);
  }
  const h = await harness("enforce", {}, true), key = Symbol.for("context-budget:test-guard");
  const global = globalThis as Record<symbol, unknown>, previous = global[key];
  global[key] = true;
  try {
    await h.handoff();
    h.branch.push({ type: "compaction", id: "guard-off", details: { kind: "handoff" } });
    assert.equal(await h.emit("context", { messages: [] }), undefined);
    assert.equal(existsSync(join(h.dir, "should-not-run")), false);
  } finally { global[key] = previous; }
  delete process.env.PI_RESUME_CHECK;
  const disabled = await harness();
  assert.ok(!(await disabled.handoff()).details.handoff.text.includes("## Resume check"));
  disabled.branch.push({ type: "compaction", id: "disabled", details: { kind: "handoff" } });
  assert.equal(await disabled.emit("context", { messages: [] }), undefined);
});

test("enforced in-process subagents skip inherited and configured resume checks at both injection points", async t => {
  const old = process.env.PI_RESUME_CHECK;
  process.env.PI_RESUME_CHECK = "touch should-not-run";
  t.after(() => { if (old === undefined) delete process.env.PI_RESUME_CHECK; else process.env.PI_RESUME_CHECK = old; });
  const hosts = new SessionHosts(), parent = hosts.acquire("primary");
  t.after(() => parent.release());
  const h = await harness("enforce", { resumeChecks: { coordinator: "touch should-not-run" } }, false, hosts);
  t.after(() => h.emit("session_shutdown"));
  (h.ctx.sessionManager as any).getSessionName = () => "coordinator";
  const check = async (id: string) => {
    const handoff = await h.handoff({ ...required, facts: id });
    assert.ok(!handoff.details.handoff.text.includes("## Resume check"));
    const committed = await h.turn();
    h.branch.push({ ...committed.entries[0], id });
    assert.equal(await h.emit("context", { messages: [] }), undefined);
    assert.equal(existsSync(join(h.dir, "should-not-run")), false);
  };
  assert.equal(h.status().role, "subagent");
  await check("env-subagent");
  delete process.env.PI_RESUME_CHECK;
  await check("configured-subagent");
});


test("queued wake starting a run cannot discard an idle handoff before its turn boundary", async () => {
  const h = await harness("enforce", { idleMinTokens: 50 });
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, old = global[key];
  global[key] = new Set([{ list: () => [{ id: "j1", status: "running" }] }]);
  try {
    await h.turn(100);
    await h.emit("agent_before_settle");
    const stored = await h.handoff();
    await h.emit("input", { streamingBehavior: "followUp", text: "wake notification" });
    await h.emit("before_agent_start");
    const boundary = await h.turn(100);
    assert.equal(boundary.entries[0].details.path, stored.details.handoff.path);
    assert.equal(boundary.entries[0].details.source, "idle");
  } finally { global[key] = old; }
});

test("near-duplicate tool errors back off, survive history restore, and yield to hard recovery", async () => {
  const h = await harness();
  const first = await h.handoff();
  await h.turn(100);
  h.branch.push({ type: "message", message: { role: "toolResult", toolName: "context_handoff", details: first.details } });
  await h.emit("session_tree");
  await assert.rejects(h.handoff(), /unchanged repository HEAD; retry after .*15 min back-off/);
  h.setTokens(1200);
  const forced = await h.handoff();
  assert.ok(forced.details.handoff);
  assert.equal((await h.turn(1200)).entries[0].type, "compaction");
});

test("optional session-owned questions render in automatic state", async t => {
  const h = await harness(), old = process.env.PI_QUESTIONS_HOME;
  process.env.PI_QUESTIONS_HOME = join(h.dir, "questions");
  t.after(() => { if (old === undefined) delete process.env.PI_QUESTIONS_HOME; else process.env.PI_QUESTIONS_HOME = old; });
  const dir = join(process.env.PI_QUESTIONS_HOME, "items", "Q-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "r00000001.json"), JSON.stringify({ id: "Q-1", status: "open", title: "Approve rollout", asker: { sessionId: h.sid } }));
  const result = await h.handoff();
  assert.match(result.details.handoff.text, /## Pending questions\nQ-1 \| open \| Approve rollout/);
});

test("first resumed call checks missing jobs with full commands, including after restore", async () => {
  const h = await harness(), key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, old = global[key];
  const command = "echo " + "x".repeat(800);
  global[key] = new Set([{ list: () => [{ id: "watch-1", label: "CI", command, status: "running" }] }]);
  try {
    await h.handoff();
    const committed = await h.turn(100);
    h.branch.push({ ...committed.entries[0], id: "watch-reset" });
    await h.emit("session_tree"); // metadata must also work when tool results were pruned
    global[key] = new Set();
    const resumed = await h.emit("context", { messages: [] });
    assert.ok(resumed.messages[0].content.includes(`watch-1 | CI | ${command}`));
    assert.match(resumed.messages[0].content, /## Watch check/);
    assert.equal(await h.emit("context", { messages: [] }), undefined); // first resumed call only
  } finally { global[key] = old; }
});

test("mode mismatch footer names the reason and logs once until resolved", async () => {
  const h = await harness("enforce", { enforceCwds: [] });
  assert.equal(h.footer.at(-1), "context-budget: configured enforce, effective observe (cwd restriction)");
  await h.turn(); await h.turn();
  assert.equal(h.events().filter(e => e.event === "mode_mismatch").length, 1);
  writeFileSync(join(h.dir, "config.json"), JSON.stringify({ mode: "enforce" }));
  await h.emit("input");
  assert.equal(h.footer.at(-1), undefined);
  const guarded = await harness("enforce", {}, true);
  const key = Symbol.for("context-budget:test-guard"), global = globalThis as Record<symbol, unknown>;
  global[key] = true;
  try {
    await guarded.emit("tool_call", { toolName: "read" });
    assert.equal(guarded.footer.at(-1), "context-budget: configured enforce, effective off (context guard off)");
  } finally { delete global[key]; }
});

test("a reused factory and child session_start cannot flip the parent's mode", async () => {
  const h = await harness();
  const dir = process.env.PI_CODING_AGENT_DIR!;
  const factory = createContextBudgetExtension({ agentDir: dir, hosts: new SessionHosts() });
  const bind = async (ctx: ExtensionContext) => {
    const handlers = new Map<string, any>();
    await factory({ on: (name: string, fn: any) => handlers.set(name, fn), registerTool: () => {} } as unknown as ExtensionAPI);
    await handlers.get("session_start")({}, ctx);
    return handlers;
  };
  const parent = await bind(h.ctx);
  writeFileSync(join(h.dir, "config.json"), JSON.stringify({ mode: "off" }));
  const child = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "child" } } as ExtensionContext;
  const childHandlers = await bind(child);
  await childHandlers.get("session_shutdown")({}, child);
  await parent.get("turn_end")({ message: { role: "assistant", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } }, h.ctx);
  assert.equal(h.status().mode, "enforce");
});


for (const trigger of ["handoff threshold", "compaction fallback"]) test(`forced near-duplicate handoffs bypass back-off at ${trigger}`, async () => {
  const h = await harness();
  await h.turn(100);
  const first = await h.handoff();
  await h.turn(100);
  await h.turn(100); // Establish a new floor after the first reset.
  if (trigger === "handoff threshold") h.setTokens(250);
  else {
    await h.emit("session_before_compact", { reason: "threshold" });
    await h.emit("session_compact_failed", { type: "session_compact_failed", reason: "threshold", errorMessage: "EACCES" });
  }
  assert.ok((await h.emit("tool_call", { toolName: "read", toolCallId: "blocked" })).block);
  const second = await h.handoff(); // Same narrative, unchanged HEAD, within 15 minutes.
  assert.ok(second.details.handoff);
  assert.notEqual(second.details.handoff.path, first.details.handoff.path);
  const committed = await h.turn(trigger === "handoff threshold" ? 250 : 100);
  assert.equal(committed.entries[0].details.path, second.details.handoff.path);
});

for (const failure of ["aborted", "error", "overflow"]) test(`new prompt discards pending handoff after ${failure} turn`, async () => {
  const h = await harness();
  await h.turn(100);
  await h.handoff();
  const stopped = await h.emit("turn_end", { message: { role: "assistant", stopReason: failure === "aborted" ? "aborted" : "error",
    errorMessage: failure === "overflow" ? "context overflow" : "provider failed", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  assert.equal(stopped, undefined);
  await h.emit("agent_settled", { aborted: failure === "aborted" });
  await h.emit("input", { text: "new user prompt" });
  await h.emit("before_agent_start");
  await h.emit("agent_start");
  assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: "fresh-read" }), undefined);
  assert.equal(await h.turn(100), undefined, "new prompt must not be pruned by a stale handoff reset");
  assert.ok(!h.events().some(e => e.event === "handoff_committed"));
});

test("missing UI does not emit mode-mismatch status errors", async () => {
  const h = await harness("enforce", { enforceCwds: [] });
  (h.ctx as any).ui = undefined;
  await h.emit("tool_call", { toolName: "read" });
  await h.turn(10);
  assert.ok(!h.events().some(e => e.event === "status_error" || e.event === "hook_error"));
});
