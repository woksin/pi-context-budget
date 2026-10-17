import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, parseConfig, transition, policyStatus, type Frame, type MachineEvent, type MachineState, type Effect } from "../src/core.ts";

const config = parseConfig({ mode: "observe" });
const frame: Frame = { mode: "observe", tokens: 100000, thresholds: config.main, config, wrapped: true };

test("observe regression: soft and handoff crossings plus settle intent remain visible", () => {
  let state = initialState("observe");
  const emitted: string[][] = [];
  for (const tokens of [100000, 350000, 450000]) {
    const next = transition(state, { type: "turn_end", usage: tokens }, { ...frame, tokens });
    state = next.state;
    emitted.push(next.effects.flatMap(e => e.type === "log" ? [e.event] : []));
  }
  const settled = transition(state, { type: "agent_before_settle", pendingWork: false }, { ...frame, tokens: 450000 });
  emitted.push(settled.effects.flatMap(e => e.type === "log" ? [e.event] : []));
  assert.deepEqual(emitted, [[], ["would_soft_notice"], ["would_handoff_crossing", "would_handoff"], ["would_handoff"]]);
  assert.equal(settled.state.phase, "handoff-required");
  assert.equal(policyStatus(settled.state, { ...frame, tokens: 450000 }).action, "handoff");
});

type Sample = { tokens: number | null; event: MachineEvent };
const at = (tokens: number | null, event: MachineEvent): Sample => ({ tokens, event });
const turn = (tokens: number): Sample => at(tokens, { type: "turn_end", usage: tokens });
const handoff = { text: "# Handoff test", path: "/handoff.md", n: 1, at: "2026-10-17" };
// Explicit naming contract, independent of the production projection helper.
function expected(effect: Effect): { event: string; source: string } {
  if (effect.type === "log") {
    const names: Record<string, string> = { handoff_required: "would_handoff", relaunch_required: "would_relaunch", idle_compact_requires_handoff: "would_idle_compact" };
    return { event: names[effect.event] ?? `would_${effect.event}`, source: `log:${effect.event}` };
  }
  if (effect.type === "steer") return { event: effect.idleOnly ? "would_idle_handoff" : "would_handoff", source: effect.type };
  if (effect.type === "write_handoff") return { event: effect.idleOnly ? "would_idle_handoff_write" : "would_handoff_write", source: effect.type };
  const names = { notify: "would_soft_notice", reject_handoff: "would_handoff_rejected", block: "would_block", commit: "would_handoff_commit",
    compact: "would_idle_compact", backstop: "would_backstop", relaunch: "would_relaunch", cancel_compaction: "would_cancel_compaction" };
  return { event: names[effect.type], source: effect.type };
}
const sequences: { name: string; seed?: Partial<MachineState>; samples: Sample[]; notices?: number }[] = [
  { name: "soft, handoff, block, bounded settle and hard relaunch", notices: 1, samples: [
    turn(100000), turn(350000), turn(350000), turn(450000),
    at(450000, { type: "tool_call", tool: "read", id: "blocked" }),
    at(450000, { type: "tool_end", tool: "read", id: "blocked", error: false }),
    at(450000, { type: "agent_before_settle", pendingWork: false }), at(450000, { type: "agent_start" }),
    at(450000, { type: "agent_before_settle", pendingWork: false }), turn(650000),
    at(650000, { type: "agent_settled", now: 1, pendingWork: false, aborted: false }),
    at(650000, { type: "agent_settled", now: 2, pendingWork: false, aborted: false }),
  ] },
  { name: "soft notice re-arms only below the threshold", notices: 2, samples: [turn(350000), turn(350000), turn(200000), turn(350000)] },
  { name: "handoff crossing re-arms after action clears", notices: 1, samples: [turn(450000), turn(450000), turn(350000), turn(450000)] },
  { name: "idle request and reset precondition without a prepared handoff", notices: 1, samples: [
    turn(350000), at(350000, { type: "agent_before_settle", pendingWork: true }), at(350000, { type: "agent_start" }),
    at(350000, { type: "agent_before_settle", pendingWork: true }),
    at(350000, { type: "agent_settled", now: 1, pendingWork: true, aborted: false }),
    at(350000, { type: "input", now: 4000000, streaming: false, alreadyCompacted: false }),
  ] },
  { name: "stored idle handoff, compaction and callback correlation", seed: { stored: handoff, lastHandoff: handoff, lastSettled: 1 }, samples: [
    at(350000, { type: "input", now: 4000000, streaming: false, alreadyCompacted: false }),
    at(350000, { type: "session_before_compact", reason: "manual" }), at(null, { type: "session_compact", owned: true, attempt: 1 }),
    at(null, { type: "session_compact", owned: true, attempt: 1 }), at(null, { type: "before_agent_start" }),
  ] },
  { name: "write, rejection and commit intents", samples: [
    at(350000, { type: "handoff_prepare" }), at(350000, { type: "handoff_written", handoff }),
    at(350000, { type: "handoff_prepare" }), turn(350000),
  ] },
  { name: "owned transient failure, persistent backstop failure and recovery", samples: [
    at(350000, { type: "session_before_compact", reason: "threshold" }),
    at(350000, { type: "session_compact_failed", reason: "threshold", errorMessage: "network timeout" }),
    at(350000, { type: "backstop_failed", reason: "overflow", errorMessage: "EACCES" }),
    at(null, { type: "session_compact", owned: true }),
  ] },
  { name: "cap relaunch latch", seed: { count: 10 }, samples: [
    turn(100000), at(100000, { type: "agent_settled", now: 1, pendingWork: false, aborted: false }),
    at(100000, { type: "agent_settled", now: 2, pendingWork: false, aborted: false }),
  ] },
];
for (const sequence of sequences) test(`observe/enforce parity: ${sequence.name}`, () => {
  let enforced: MachineState = { ...initialState("enforce"), floor: 100000, ...sequence.seed };
  let observed: MachineState = { ...initialState("observe"), floor: 100000, ...sequence.seed };
  const all: string[] = [];
  for (const sample of sequence.samples) {
    const saved = structuredClone(observed);
    const real = transition(enforced, sample.event, { ...frame, tokens: sample.tokens, mode: "enforce" });
    const preview = transition(observed, sample.event, { ...frame, tokens: sample.tokens });
    assert.deepEqual(observed, saved, "projection cannot mutate its input");
    assert.ok(preview.effects.every(e => e.type === "log" && e.event.startsWith("would_")));
    assert.deepEqual(preview.effects.map(e => ({ event: e.type === "log" ? e.event : "SIDE EFFECT", source: e.type === "log" ? e.data?.effect : undefined })), real.effects.map(expected));
    assert.deepEqual(preview.state.observation, real.state, "the enforce latches must remain identical");
    assert.equal(preview.state.phase, real.state.phase);
    assert.equal(preview.state.pending, undefined, "preview cannot prepare an actual commit");
    all.push(...preview.effects.flatMap(e => e.type === "log" ? [e.event] : []));
    enforced = real.state; observed = preview.state;
  }
  if (sequence.notices !== undefined) assert.equal(all.filter(e => e === "would_soft_notice").length, sequence.notices);
});
test("activating enforcement discards preview-only commits and latches", () => {
  let state: MachineState = { ...initialState("observe"), floor: 100000 };
  state = transition(state, { type: "handoff_written", handoff }, { ...frame, tokens: 350000 }).state;
  state = transition(state, { type: "turn_end", usage: 350000 }, { ...frame, tokens: 350000 }).state;
  assert.equal(state.observation?.count, 1);
  assert.equal(state.count, 0);
  const enabled = transition(state, { type: "mode_changed" }, { ...frame, mode: "enforce", tokens: 100000 });
  assert.equal(enabled.state.observation, undefined);
  assert.equal(enabled.state.count, 0);
  assert.equal(enabled.state.pending, undefined);
  assert.deepEqual(enabled.effects, []);
});
test("a previewed soft notice cannot suppress the first actual notice on activation", () => {
  const observed = transition(initialState("observe"), { type: "turn_end", usage: 100000 }, { ...frame, tokens: 350000 });
  assert.equal(observed.state.softNotified, false);
  assert.equal(observed.state.observation?.softNotified, true);
  const enabled = transition(observed.state, { type: "turn_end", usage: 350000 }, { ...frame, mode: "enforce", tokens: 350000 });
  assert.equal(enabled.effects.filter(e => e.type === "notify").length, 1);
});
for (const mode of ["off", "observe"] as const) test(`an actual soft notice remains latched across ${mode}`, () => {
  let state = transition(initialState("enforce"), { type: "turn_end", usage: 100000 }, { ...frame, mode: "enforce", tokens: 350000 }).state;
  assert.equal(state.softNotified, true);
  state = transition(state, { type: "turn_end", usage: 350000 }, { ...frame, mode, tokens: 350000 }).state;
  const enabled = transition(state, { type: "turn_end", usage: 350000 }, { ...frame, mode: "enforce", tokens: 350000 });
  assert.ok(enabled.effects.every(e => e.type !== "notify"));
});
test("status projects observe decisions but guard-off reports no action", () => {
  const observed = transition(initialState("observe"), { type: "turn_end", usage: 100000 }, { ...frame, tokens: 650000 }).state;
  assert.deepEqual(policyStatus(observed, { ...frame, tokens: 650000 }), { phase: "fallback-armed", action: "relaunch", fallbackReason: "hard" });
  assert.deepEqual(policyStatus(observed, { ...frame, mode: "off" }), { phase: "idle", action: "none", fallbackReason: null });
});
