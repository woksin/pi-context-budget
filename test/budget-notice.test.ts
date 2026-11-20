import { test } from "node:test";
import assert from "node:assert/strict";
import { canHandoff, softNotice } from "../src/budget-notice.ts";

const mainNotice = "Context budget: soft threshold reached. Finish the current atomic step, bring .ai-work/<task>/STATE.md up to date (and any task notes), and prepare your handoff; call context_handoff at the next safe point. The handoff becomes mandatory at the handoff threshold, after which only a few state-recording calls are allowed.";
const uiNotice = "Context is large (soft threshold): the agent is asked to update its state file and prepare a handoff; none is forced yet.";
const finishNotice = "Context budget: soft threshold reached. Finish the current step and return your final answer now.";

test("handoff-capable sessions retain the exact model and UI notices", () => {
  assert.equal(softNotice({ handoffAvailable: true }), mainNotice);
  assert.equal(softNotice({ handoffAvailable: true }, uiNotice), uiNotice);
});
test("omitted capability preserves existing policy callers' notice selection", () => {
  assert.equal(softNotice({}), mainNotice);
  assert.equal(softNotice({}, uiNotice), uiNotice);
});
test("unavailable handoff selects the finish notice for both model and UI", () => {
  assert.equal(softNotice({ handoffAvailable: false }), finishNotice);
  assert.equal(softNotice({ handoffAvailable: false }, uiNotice), finishNotice);
});
test("main and not-yet-acquired sessions can hand off when the tool is active", () => {
  const tools = { getActiveTools: () => ["read", "context_handoff"] };
  assert.equal(canHandoff(tools, { subagent: false }), true);
  assert.equal(canHandoff(tools), true);
});
test("subagents never query handoff tools, even if the API would fail", () => {
  const tools = { getActiveTools: (): string[] => { throw new Error("must not query a subagent's tools"); } };
  assert.equal(canHandoff(tools, { subagent: true }), false);
});
for (const names of [[], ["read"], ["context_handoff_extra"]]) {
  test(`main sessions without the exact active handoff tool cannot hand off: ${JSON.stringify(names)}`, () => {
    assert.equal(canHandoff({ getActiveTools: () => names }, { subagent: false }), false);
  });
}
test("missing tool-list API keeps main-session handoff enforcement (fail closed)", () => {
  assert.equal(canHandoff({}, { subagent: false }), true);
  assert.equal(canHandoff({}, { subagent: true }), false);
});
test("the active-tool query retains its receiver", () => {
  const tools = { names: ["context_handoff"], getActiveTools() { return this.names; } };
  assert.equal(canHandoff(tools, { subagent: false }), true);
});
