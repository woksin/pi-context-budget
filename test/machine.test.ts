import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, transition, policyStatus, parseConfig, classifyFailure, MAX_COMPACTION_RETRIES, restoreHistory, type HistoryItem, type MachineState, type MachineEvent, type Frame, type Effect } from "../src/core.ts";

const config = parseConfig({ mode: "enforce", main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 } });
const f: Frame = { mode: "enforce", tokens: 300, thresholds: config.main, config, wrapped: false };
const h = { text: "# Handoff unique", path: "/handoff.md", n: 1, at: "2026-10-17T00:00:00Z" };
const base = (values: Partial<MachineState> = {}): MachineState => ({ ...initialState("enforce"), floor: 100, ...values });
const kinds = (effects: Effect[]) => effects.filter(e => e.type !== "log" || e.data?.policy !== true).map(e => e.type);
const turn: MachineEvent = { type: "turn_end", usage: 300 };
const cases: { name: string; state?: Partial<MachineState>; event: MachineEvent; frame?: Partial<Frame>; phase: string; effects: string[] }[] = [
  { name: "soft crossing", event: turn, frame: { tokens: 100 }, phase: "soft-notified", effects: ["notify"] },
  { name: "soft notice once", state: { softNotified: true }, event: turn, frame: { tokens: 100 }, phase: "soft-notified", effects: [] },
  { name: "floor unknown never handoff blocks", state: { floor: null }, event: { type: "tool_call", tool: "read", id: "a" }, phase: "idle", effects: [] },
  { name: "floor-relative minimum progress", state: { floor: 280 }, event: { type: "tool_call", tool: "read", id: "a" }, phase: "idle", effects: [] },
  { name: "required blocks", event: { type: "tool_call", tool: "read", id: "a" }, phase: "handoff-required", effects: ["block"] },
  { name: "handoff exempt", event: { type: "tool_call", tool: "context_handoff", id: "a" }, phase: "handoff-required", effects: [] },
  { name: "prepare write", event: { type: "handoff_prepare" }, phase: "handoff-required", effects: ["write_handoff"] },
  { name: "pending commit", event: { type: "handoff_written", handoff: h }, phase: "handoff-pending-commit", effects: [] },
  { name: "commit at turn boundary", state: { pending: h }, event: turn, phase: "idle", effects: ["commit"] },
  { name: "hard WITHOUT wrapper recovers by valid handoff", state: { pending: h }, event: turn, frame: { tokens: 1200 }, phase: "idle", effects: ["commit"] },
  { name: "hard WITH wrapper also prefers a valid handoff", state: { pending: h }, event: turn, frame: { tokens: 1200, wrapped: true }, phase: "idle", effects: ["commit"] },
  { name: "hard without summary remains protected", event: { type: "tool_call", tool: "write", id: "a" }, frame: { tokens: 1200, wrapped: true }, phase: "fallback-armed", effects: ["block"] },
  { name: "settle handoff once", event: { type: "agent_before_settle", pendingWork: false }, phase: "handoff-required", effects: ["steer"] },
  { name: "internal agent_start cannot reset continuation", state: { settleRequest: "budget" }, event: { type: "agent_start" }, phase: "handoff-required", effects: [] },
  { name: "repeat settle never loops", state: { settleRequest: "budget" }, event: { type: "agent_before_settle", pendingWork: false }, phase: "handoff-required", effects: [] },
  { name: "idle continuation retains intent across agent_start", state: { settleRequest: "idle" }, event: { type: "agent_start" }, frame: { tokens: 100 }, phase: "idle", effects: [] },
  { name: "idle handoff pending commit", state: { settleRequest: "idle" }, event: { type: "handoff_written", handoff: h }, frame: { tokens: 100 }, phase: "handoff-pending-commit", effects: [] },
  { name: "fresh external prompt invalidates idle snapshot", state: { stored: h, settleRequest: "idle" }, event: { type: "before_agent_start" }, frame: { tokens: 100 }, phase: "idle", effects: [] },
  { name: "idle input compacts", state: { stored: h, lastSettled: 1 }, event: { type: "input", now: 4000000, streaming: false, alreadyCompacted: false }, frame: { tokens: 40000 }, phase: "compacting", effects: ["compact"] },
  { name: "already compacted input skips", state: { stored: h, lastSettled: 1 }, event: { type: "input", now: 4000000, streaming: false, alreadyCompacted: true }, frame: { tokens: 40000 }, phase: "fallback-armed", effects: [] },
  { name: "backstop IO failure is a machine-authorized cancellation", event: { type: "backstop_failed", reason: "overflow", errorMessage: "EACCES" }, frame: { tokens: 100 }, phase: "fallback-armed", effects: ["log", "cancel_compaction"] },
  { name: "backstop starts owned attempt", event: { type: "session_before_compact", reason: "threshold" }, phase: "compacting", effects: ["backstop"] },
  { name: "successful compaction disarms persistent fallback", state: { compactionFallback: true, failures: 3 }, event: { type: "session_compact", owned: true }, phase: "idle", effects: [] },
  { name: "loop cannot be bypassed by a pending handoff", state: { handoffTurns: [0, 0, 0], pending: h, softNotified: true }, event: turn, phase: "degraded", effects: ["log", "notify_degraded"] },
  { name: "wrapped cap cannot be bypassed by a pending handoff", state: { count: 10, pending: h, softNotified: true }, event: turn, frame: { wrapped: true }, phase: "fallback-armed", effects: [] },
  { name: "unwrapped cap is advisory: pending handoff still commits", state: { count: 10, pending: h, softNotified: true }, event: turn, phase: "idle", effects: ["log", "notify_cap_advisory", "commit"] },
  { name: "cap wrapper fallback", state: { count: 10, stored: h }, event: { type: "agent_settled", now: 1, aborted: false, pendingWork: false }, frame: { wrapped: true }, phase: "fallback-armed", effects: ["relaunch"] },
  { name: "unowned wrapper never relaunches past the cap, only advises", state: { count: 10 }, event: { type: "agent_settled", now: 1, aborted: false, pendingWork: false }, phase: "handoff-required", effects: ["log", "notify_cap_advisory"] },
  { name: "overflow error can recover at settled", state: { count: 10, providerFailure: "overflow" }, event: { type: "agent_settled", now: 1, aborted: false, pendingWork: false }, frame: { wrapped: true }, phase: "fallback-armed", effects: ["relaunch"] },
  { name: "provider failure never authorizes restart", state: { count: 10, providerFailure: "error" }, event: { type: "agent_settled", now: 1, aborted: false, pendingWork: false }, frame: { wrapped: true }, phase: "fallback-armed", effects: [] },
  { name: "user abort never authorizes restart", state: { count: 10 }, event: { type: "agent_settled", now: 1, aborted: true, pendingWork: false }, frame: { wrapped: true }, phase: "fallback-armed", effects: [] },
];
for (const c of cases) test(`transition: ${c.name}`, () => {
  const before = base(c.state), saved = structuredClone(before);
  Object.freeze(before.handoffTurns); Object.freeze(before.blockedCalls); Object.freeze(before);
  const next = transition(before, c.event, { ...f, ...c.frame });
  assert.equal(next.state.phase, c.phase);
  assert.deepEqual(kinds(next.effects), c.effects);
  assert.deepEqual(before, saved, "the reducer must not mutate its input");
  if (c.name === "idle handoff pending commit") { assert.equal(next.state.pending, h); assert.equal(next.state.stored, h); }
});

for (const mode of ["off", "observe"] as const) for (const c of cases) test(`${mode} is inert: ${c.name}`, () => {
  const next = transition(base({ ...c.state, pending: h, compactionFallback: true }), c.event, { ...f, ...c.frame, mode });
  assert.ok(next.effects.every(e => e.type === "log"));
  assert.equal(next.state.compactionFallback, false);
  assert.equal(next.state.pending, undefined);
});
for (const [errorMessage, aborted, expected] of [
  ["Compaction cancelled", false, "cancelled"], ["anything", true, "cancelled"],
  ["Compaction failed: Nothing to compact (session too small)", false, "nothing-to-compact"],
  ["Already compacted", false, "nothing-to-compact"], ["ETIMEDOUT network timeout", false, "transient"],
  ["EACCES permission denied", false, "persistent"],
] as const) test(`classify failure: ${errorMessage}`, () => {
  assert.equal(classifyFailure({ errorMessage, aborted }), expected);
  const next = transition(base(), { type: "session_compact_failed", reason: "threshold", errorMessage, aborted }, { ...f, tokens: 100 });
  assert.equal(next.state.compactionFallback, expected === "persistent");
});
test("idle handoff commits at the next turn boundary without requesting another handoff", () => {
  const frame = { ...f, tokens: 100, config: { ...config, idleMinTokens: 50 } };
  let state = base();
  const step = (event: MachineEvent) => {
    const result = transition(state, event, frame);
    state = result.state;
    return result.effects;
  };
  assert.deepEqual(kinds(step({ type: "agent_before_settle", pendingWork: true })), ["steer"]);
  assert.equal(state.settleRequest, "idle");
  step({ type: "handoff_written", handoff: h });
  step({ type: "agent_start" });
  step({ type: "input", now: 1000, streaming: true, alreadyCompacted: false });
  assert.deepEqual(kinds(step({ type: "agent_before_settle", pendingWork: true })), []);
  assert.equal(state.pending, h);
  assert.deepEqual(kinds(step({ type: "tool_call", tool: "read", id: "blocked-idle" })), ["block"]);
  step({ type: "tool_end", tool: "read", id: "blocked-idle", error: true });
  assert.deepEqual(kinds(step({ type: "handoff_prepare" })), ["reject_handoff"]);
  const effects = step({ type: "turn_end", usage: 100 });
  assert.deepEqual(effects.filter(e => e.type === "commit"), [{ type: "commit", handoff: h, source: "idle" }]);
  assert.equal(state.tokens, null);
  assert.equal(state.floor, null);
  assert.equal(state.count, 0);
  assert.deepEqual(state.handoffTurns, []);
  assert.equal(state.pending, undefined);
});
test("idle commits outlive the session cap; budget and hard commits still hit it", () => {
  for (const source of ["idle", "budget", "hard"] as const) {
    const idle = source === "idle";
    const c = { ...config, idleMinTokens: 50,
      loop: idle ? config.loop : { ...config.loop, maxHandoffsWithoutProgress: config.maxHandoffsPerSession + 1 } };
    const frame = { ...f, wrapped: true, config: c, tokens: idle ? 100 : source === "hard" ? 1200 : 300 };
    let state = base();
    for (let n = 0; n < (idle ? c.maxHandoffsPerSession + 5 : c.maxHandoffsPerSession); n++) {
      state = transition(state, { type: "before_agent_start" }, frame).state;
      state = transition(state, { type: "turn_end", usage: 100 }, { ...frame, tokens: 100 }).state;
      const request = transition(state, { type: "agent_before_settle", pendingWork: true }, frame);
      assert.deepEqual(kinds(request.effects), ["steer"]);
      assert.equal(request.state.settleRequest, idle ? "idle" : "budget");
      state = transition(request.state, { type: "handoff_written", handoff: h }, frame).state;
      const commit = transition(state, { type: "turn_end", usage: frame.tokens }, frame);
      assert.deepEqual(kinds(commit.effects), ["commit"], `${source} commit ${n + 1}`);
      state = commit.state;
      assert.equal(state.count, idle ? 0 : n + 1);
      assert.equal(state.handoffTurns.length, idle ? 0 : n + 1);
      const tools = transition(state, { type: "tool_call", tool: "read", id: `${source}-${n}` }, { ...frame, tokens: null });
      assert.deepEqual(kinds(tools.effects), !idle && n + 1 === c.maxHandoffsPerSession ? ["block"] : []);
    }
  }
});
test("history restoration excludes tagged idle commits but counts budget and legacy commits", () => {
  const history: HistoryItem[] = Array.from({ length: config.maxHandoffsPerSession + 5 }, () => ({ type: "compaction", owned: true, source: "idle" }));
  const idle = restoreHistory(history, "enforce");
  assert.equal(idle.count, 0);
  assert.deepEqual(idle.handoffTurns, []);
  const budget = restoreHistory([...history, { type: "compaction", owned: true, source: "budget" }, { type: "compaction", owned: true }], "enforce");
  assert.equal(budget.count, 2);
  assert.equal(budget.handoffTurns.length, 2);
});
test("owned idle-input compaction does not consume budget or loop limits", () => {
  const frame = { ...f, tokens: 100, config: { ...config, keepRecentTokens: 10 } };
  const started = transition(base({ stored: h, lastSettled: 1 }), { type: "input", now: 4000000, streaming: false, alreadyCompacted: false }, frame);
  const backstop = transition(started.state, { type: "session_before_compact", reason: "manual" }, frame);
  assert.ok(backstop.effects.some(e => e.type === "backstop" && e.source === "idle"));
  const completed = transition(backstop.state, { type: "session_compact", owned: true }, frame);
  assert.equal(completed.state.count, 0);
  assert.deepEqual(completed.state.handoffTurns, []);
});
test("manual unowned errors never poison fallback; owned transient errors have a bounded retry budget", () => {
  const no = transition(base(), { type: "session_compact_failed", reason: "manual", errorMessage: "EACCES" }, { ...f, tokens: 100 });
  assert.equal(no.state.compactionFallback, false);
  let state = base();
  for (let n = 1; n <= MAX_COMPACTION_RETRIES + 1; n++) {
    state = transition(state, { type: "session_before_compact", reason: "threshold" }, f).state;
    state = transition(state, { type: "session_compact_failed", reason: "threshold", errorMessage: "network timeout" }, f).state;
    assert.equal(state.compactionFallback, n > MAX_COMPACTION_RETRIES);
  }
  const recovered = transition(state, { type: "session_compact", owned: true }, f).state;
  assert.equal(recovered.failures, 0); assert.equal(recovered.compactionFallback, false);
});
test("hook-before-callback ordering accounts for a failure exactly once", () => {
  const started = transition(base(), { type: "session_before_compact", reason: "manual" }, f).state;
  const hook = transition(started, { type: "session_compact_failed", reason: "manual", errorMessage: "network timeout", fromExtension: true }, f).state;
  const callback = transition(hook, { type: "session_compact_failed", reason: "manual", errorMessage: "network timeout", attempt: started.compaction!.id }, f).state;
  assert.equal(callback.failures, 1);
  assert.equal(callback.compactionFallback, false);
});
test("success resets hard recovery and loop progress re-arms only after fresh growth", () => {
  const committed = transition(base({ pending: h, compactionFallback: true }), turn, { ...f, tokens: 1200 });
  assert.equal(committed.state.tokens, null);
  assert.equal(committed.state.compactionFallback, false);
  const allowed = transition(committed.state, { type: "tool_call", tool: "read", id: "ok" }, { ...f, tokens: null });
  assert.deepEqual(allowed.effects, []);
  const loop = transition(base({ handoffTurns: [0, 0, 0] }), { type: "tool_end", tool: "read", id: "ok", error: false }, f);
  assert.notEqual(loop.state.phase, "fallback-armed");
});

const call = { type: "tool_call", tool: "write", id: "a" } as const;
const settled = { type: "agent_settled", now: 1, aborted: false, pendingWork: false } as const;
for (const [kind, st] of [["cap", { count: 10 }], ["loop", { handoffTurns: [0, 0, 0] }]] as [string, Partial<MachineState>][]) {
  if (kind === "loop") test(`unwrapped ${kind}: tools are not blocked, one notice, no steer`, () => {
    let s = base({ ...st, stored: h });
    for (const ev of [call, { type: "agent_before_settle", pendingWork: true } as const]) {
      const r = transition(s, ev, f); s = r.state; assert.deepEqual(r.effects.filter(e => e.type !== "log"), []);
    }
    const first = transition(s, settled, f);
    assert.deepEqual(first.effects.filter(e => e.type === "notify_degraded"), [{ type: "notify_degraded", reason: kind }]);
    const second = transition(first.state, settled, f);
    assert.deepEqual(kinds(second.effects), []);
    assert.deepEqual(kinds(transition(second.state, call, f).effects), []);
  });
  test(`wrapped ${kind}: still blocks and relaunches`, () => {
    const w = { ...f, wrapped: true };
    assert.deepEqual(kinds(transition(base({ ...st, stored: h }), call, w).effects), ["block"]);
    assert.deepEqual(kinds(transition(base({ ...st, stored: h }), settled, w).effects), ["relaunch"]);
  });
}
test("unwrapped restored cap session keeps in-place enforcement", () => {
  const s = restoreHistory(Array.from({ length: 10 }, () => ({ type: "compaction", owned: true, source: "budget" }) as HistoryItem), "enforce");
  assert.equal(s.count, 10);
  assert.deepEqual(kinds(transition({ ...s, floor: 100, handoffTurns: [] }, call, f).effects), ["block"]);
});
test("unwrapped hard fallback is unchanged", () => {
  assert.deepEqual(kinds(transition(base(), call, { ...f, tokens: 1200 }).effects), ["block"]);
  assert.deepEqual(kinds(transition(base(), settled, { ...f, tokens: 1200 }).effects), ["log"]);
});

for (const [kind, st] of [["loop", { handoffTurns: [0, 0, 0] }]] as [string, Partial<MachineState>][]) {
  test(`unwrapped ${kind} with a stale pending handoff: no block, prepare is accepted`, () => {
    const s = base({ ...st, pending: h, stored: h });
    assert.deepEqual(kinds(transition(s, call, f).effects), []);
    const prep = transition(s, { type: "handoff_prepare" }, f);
    assert.deepEqual(kinds(prep.effects), ["write_handoff"]);
    assert.equal(prep.state.pending, undefined);
    const again = transition(transition(prep.state, { type: "handoff_written", handoff: h }, f).state, { type: "handoff_prepare" }, f);
    assert.deepEqual(kinds(again.effects), ["write_handoff"]);
  });
  test(`status: ${kind} is degraded/none unwrapped, fallback-armed/relaunch wrapped`, () => {
    const s = base(st);
    assert.deepEqual(policyStatus(s, f), { phase: "degraded", action: "none", fallbackReason: kind });
    const w = policyStatus(s, { ...f, wrapped: true });
    assert.equal(w.phase, "fallback-armed"); assert.equal(w.action, "relaunch");
    assert.equal(transition(s, turn, f).state.phase, "degraded");
  });
}
test("status: unwrapped hard stays fallback-armed/relaunch", () => {
  const p = policyStatus(base({ tokens: 1200 }), { ...f, tokens: 1200 });
  assert.equal(p.phase, "fallback-armed"); assert.equal(p.action, "relaunch");
});

const cap = { count: 10 };
test("unwrapped cap: handoff required blocks tools and context_handoff commits in place", () => {
  assert.deepEqual(kinds(transition(base(cap), call, f).effects), ["block"]);
  assert.deepEqual(kinds(transition(base(cap), { type: "tool_call", tool: "context_handoff", id: "c" }, f).effects), []);
  assert.deepEqual(kinds(transition(base(cap), { type: "handoff_prepare" }, f).effects), ["write_handoff"]);
  const written = transition(base(cap), { type: "handoff_written", handoff: h }, f).state;
  assert.equal(written.phase, "handoff-pending-commit");
  const done = transition(written, turn, f);
  assert.deepEqual(done.effects.filter(e => e.type === "commit").length, 1);
  assert.equal(done.state.count, 11);
  assert.notEqual(done.state.phase, "degraded"); assert.notEqual(done.state.phase, "fallback-armed");
  assert.deepEqual(policyStatus(base({ ...cap, tokens: 300 }), f), { phase: "handoff-required", action: "handoff", fallbackReason: null });
});
test("unwrapped cap at hard: tools blocked, no relaunch, stored handoff commits in place", () => {
  const hard = { ...f, tokens: 1200 };
  assert.deepEqual(kinds(transition(base(cap), call, hard).effects), ["block"]);
  const set = transition(base(cap), settled, hard).effects;
  assert.equal(set.some(e => e.type === "relaunch"), false);
  assert.ok(set.some(e => e.type === "log" && e.event === "relaunch_unavailable"));
  const turned = transition(base({ ...cap, stored: h }), turn, hard);
  assert.equal(turned.effects.filter(e => e.type === "commit").length, 1);
});
test("unwrapped cap: advisory once per turn, again next turn, never on wrapped", () => {
  const s0 = base({ ...cap, softNotified: true });
  const t1 = transition(s0, turn, f);
  assert.equal(t1.effects.filter(e => e.type === "notify_cap_advisory").length, 1);
  assert.ok(t1.effects.some(e => e.type === "log" && e.event === "cap_advisory" && e.data?.count === 10 && e.data?.cap === 10));
  const set = transition(t1.state, settled, f);
  assert.equal(set.effects.some(e => e.type === "notify_cap_advisory"), false);
  const t2 = transition(set.state, turn, f);
  assert.equal(t2.effects.filter(e => e.type === "notify_cap_advisory").length, 1);
  const w = { ...f, wrapped: true };
  assert.equal(transition(s0, turn, w).effects.some(e => e.type === "notify_cap_advisory"), false);
  assert.deepEqual(policyStatus(base(cap), w).phase, "fallback-armed");
  assert.equal(policyStatus(base(cap), w).action, "relaunch");
  assert.deepEqual(kinds(transition(base({ ...cap, stored: h }), settled, w).effects), ["relaunch"]);
});
test("unwrapped loop: notice every turn and still unblocked", () => {
  const st = base({ handoffTurns: [0, 0, 0] });
  const t1 = transition(st, turn, f), t2 = transition(t1.state, turn, f);
  for (const r of [t1, t2]) assert.equal(r.effects.filter(e => e.type === "notify_degraded").length, 1);
  assert.deepEqual(kinds(transition(t2.state, call, f).effects), []);
  assert.equal(transition(t2.state, settled, f).effects.some(e => e.type === "notify_degraded"), false);
});
test("unwrapped loop at hard self-heals after a successful non-handoff tool (no deadlock)", () => {
  const hard = { ...f, tokens: 1200 };
  let s = base({ handoffTurns: [0, 0, 0] });
  assert.deepEqual(kinds(transition(s, call, hard).effects), []);
  s = transition(s, { type: "tool_end", tool: "write", id: "a", error: false }, hard).state;
  assert.deepEqual(s.handoffTurns, []);
  assert.deepEqual(kinds(transition(s, call, hard).effects), ["block"]);
  assert.deepEqual(kinds(transition(s, { type: "handoff_prepare" }, hard).effects), ["write_handoff"]);
  s = transition(s, { type: "handoff_written", handoff: h }, hard).state;
  assert.equal(transition(s, turn, hard).effects.filter(e => e.type === "commit").length, 1);
});
test("unwrapped cap at hard: after commit the next tool call is not blocked", () => {
  const hard = { ...f, tokens: 1200 };
  const s = transition(base({ ...cap, pending: h }), turn, hard).state;
  assert.deepEqual(kinds(transition(s, call, { ...f, tokens: null }).effects), []);
});
