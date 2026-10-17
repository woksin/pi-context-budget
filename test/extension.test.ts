import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContextBudgetExtension } from "../src/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const base = resolve(import.meta.dirname, "../.ai-work/hooks");
mkdirSync(base, { recursive: true });
const required = { goal: "finish", next_step: "write result", facts: "Read part one" };
async function harness(mode = "enforce", overrides: Record<string, unknown> = {}, withGuard = false) {
  const dir = mkdtempSync(join(base, "case-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json");
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  delete process.env.PI_SESSION_WRAPPER; delete process.env.PI_RELAUNCH_MARKER;
  if (withGuard) {
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "lib"), { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "lib/guards.ts"), 'export const isGuardOff = () => globalThis[Symbol.for("context-budget:test-guard")] === true;');
  }
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode, main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 }, ...overrides }));
  const handlers = new Map<string, (e: any, ctx: ExtensionContext) => Promise<any>>();
  let tool: any;
  const notifications: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); }, registerTool: (value: any) => { tool = value; } } as unknown as ExtensionAPI;
  let usage: number | null = 100, shutdown = 0, compact = 0;
  const branch: any[] = [];
  const sid = `test-${dir.split("/").at(-1)}`;
  const ctx = { cwd: dir, hasUI: false, model: { provider: "test", id: "test" },
    sessionManager: { getSessionId: () => sid, getSessionFile: () => join(dir, "session.jsonl"), getHeader: () => ({}), getBranch: () => branch },
    getContextUsage: () => ({ tokens: usage }), shutdown: () => { shutdown++; },
    ui: { notify: (text: string) => notifications.push(text) },
    compact: (opts: any) => { compact++; opts.onError(new Error("Nothing to compact (session too small)")); },
  } as unknown as ExtensionContext;
  await createContextBudgetExtension({ agentDir: process.env.PI_CODING_AGENT_DIR! })(pi);
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  await emit("session_start");
  const turn = async (tokens = 300) => { usage = tokens; return emit("turn_end", { message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } }); };
  const handoff = () => tool.execute("h", required, undefined, undefined, ctx);
  return { dir, ctx, sid, emit, turn, handoff, notifications, branch, setTokens: (n: number | null) => { usage = n; }, counters: () => ({ shutdown, compact }),
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
  assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold" }), { cancel: true });
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(h.counters(), { shutdown: 0, compact: 0 });
  assert.ok(h.events().some(e => e.event === "would_relaunch"));
  assert.ok(h.events().some(e => e.event === "would_block"));
  assert.equal(h.status().mode, "observe");
});
test("handoff continuation once; hard fallback never shuts down without wrapper", async () => {
  const h = await harness();
  await h.turn(100); await h.turn(1200);
  assert.equal((await h.emit("agent_before_settle")).continue, true);
  assert.equal(await h.emit("agent_before_settle"), undefined);
  await h.handoff();
  await h.turn(1200);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 0);
  assert.equal((await h.emit("tool_call", { toolName: "bash" })).block, true);
  assert.ok(h.events().some(e => e.event === "relaunch_unavailable"));
});
test("hard fallback writes marker before shutdown only in wrapper; provider errors do not relaunch", async () => {
  const h = await harness();
  process.env.PI_SESSION_WRAPPER = "1";
  process.env.PI_RELAUNCH_MARKER = join(h.dir, "relaunch", "42.json");
  await h.turn(1200);
  await h.handoff(); await h.turn(1200);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 1);
  const m = JSON.parse(readFileSync(process.env.PI_RELAUNCH_MARKER, "utf8"));
  assert.equal(m.cwd, h.dir); assert.ok(existsSync(m.handoff)); assert.equal(m.launchPrompt, null);
  const err = await harness();
  process.env.PI_SESSION_WRAPPER = "1";
  process.env.PI_RELAUNCH_MARKER = join(err.dir, "marker.json");
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
test("idle requires pending work, stores only, tolerates Nothing to compact, invalidates on tool", async () => {
  const h = await harness("enforce", { idleMinutes: 0.0000001, idleMinTokens: 50, keepRecentTokens: 10 });
  await h.turn(100);
  assert.equal(await h.emit("agent_before_settle"), undefined);
  const key = Symbol.for("pi-jobs.liveManagers");
  const global = globalThis as Record<symbol, unknown>;
  global[key] = new Set([{ list: () => [{ id: "watch", status: "running", kind: "watch" }] }]);
  try {
    assert.equal((await h.emit("agent_before_settle")).continue, true);
    await h.handoff();
    assert.equal(await h.turn(100), undefined); // Store only, not turn_end compaction.
    await h.emit("agent_settled", { aborted: false });
    const now = Date.now;
    Date.now = () => now() + 1000;
    try { assert.deepEqual(await h.emit("input", { source: "rpc", text: "next" }), { action: "continue" }); }
    finally { Date.now = now; }
    assert.equal(h.counters().compact, 1);
    assert.ok(h.events().some(e => e.event === "idle_compact" && e.outcome.includes("Nothing to compact")));
  } finally { delete global[key]; }
});
test("blocked sibling keeps pending handoff; already-running sibling invalidates it", async () => {
  const h = await harness();
  await h.turn(100); await h.handoff();
  assert.equal((await h.emit("tool_call", { toolName: "read", toolCallId: "blocked" })).block, true);
  await h.emit("tool_execution_end", { toolName: "read", toolCallId: "blocked", isError: true });
  assert.equal((await h.turn()).entries[0].type, "compaction");
  await h.handoff();
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
    assert.deepEqual(await h.emit("session_before_compact", {}), { cancel: true });
    assert.equal(await h.emit("agent_before_settle"), undefined);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.counters().shutdown, 0);
  } finally { delete global[key]; }
});
test("in-process subagent never writes the inherited parent marker", async () => {
  const h = await harness("enforce", { subagent: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 } });
  (h.ctx.sessionManager as any).getHeader = () => ({ parentSession: "/parent.jsonl" });
  process.env.PI_SESSION_WRAPPER = "1"; process.env.PI_RELAUNCH_MARKER = join(h.dir, "parent-marker.json");
  await h.turn(1200); await h.handoff(); await h.turn(1200);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.counters().shutdown, 0);
  assert.equal(existsSync(process.env.PI_RELAUNCH_MARKER), false);
  assert.equal(h.status().role, "subagent");
});
test("new external runs clear the idle-only request; invalid config falls back to observe", async () => {
  const h = await harness();
  await h.emit("agent_start");
  await h.handoff();
  assert.equal((await h.turn()).continue, true);
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG!, "{broken");
  await h.emit("input", { text: "next" }); await h.turn();
  assert.equal(h.status().mode, "observe");
  assert.ok(h.events().some(e => e.event === "config_error"));
});
test("observe records both warm-cache idle request and would-reset without calling compact", async () => {
  const h = await harness("observe", { idleMinutes: 0.000001, idleMinTokens: 50 });
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>;
  global[key] = new Set([{ list: () => [{ status: "running" }] }]);
  const now = Date.now;
  try {
    await h.turn(100); await h.emit("agent_settled", { aborted: false });
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
test("hook I/O failures are logged, backstop cancels instead of default summarizer", async () => {
  const h = await harness();
  (h.ctx as any).getContextUsage = () => { throw new Error("probe failed"); };
  assert.equal(await h.turn(), undefined);
  (h.ctx.sessionManager as any).getBranch = () => { throw new Error("branch unavailable"); };
  assert.deepEqual(await h.emit("session_before_compact", { preparation: { tokensBefore: 99 } }), { cancel: true });
  assert.ok(h.events().some(e => e.event === "hook_error"));
  assert.ok(h.events().some(e => e.event === "backstop_error"));
});
