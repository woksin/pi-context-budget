import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHandoff } from "../src/validate.ts";
import { RETRY, validateHandoff, type HandoffInput } from "../src/core.ts";

const input: HandoffInput = { goal: "task", facts: "verified", next_step: "continue" };
const action = (id: string) => ({ id, target: "result", on_complete: "read result" });
const running = { jobs: [] as unknown[], subagents: [] as unknown[], unavailable: [] as string[], scheduled: [] as string[], finishedJobs: [] as string[] };
const ctx = { running, knownIds: [] as string[], exists: () => true, mtimeMs: () => 0, branch: [] as unknown[], enforce: true };
const entry = (name: string, args: object, timestamp = "2026-01-02T00:00:00Z") => ({ timestamp, message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });

test("watch action structure names fields and ends with retry", () => {
  const invalid = ["no", Array(21).fill(action("x")), [{ ...action("x"), id: "" }], [{ ...action("x"), target: "x".repeat(301) }], [{ ...action("x"), on_complete: 1 }], [{ ...action("x"), cancel: "" }], [action("x"), action("x")]];
  for (const watch_actions of invalid) assert.throws(() => validateHandoff({ ...input, watch_actions: watch_actions as never }), (error: Error) => error.message.includes("watch_actions") && error.message.endsWith(RETRY));
  validateHandoff({ ...input, watch_actions: [{ ...action("x"), cancel: "stop it" }] });
});
test("missing files and running ids are combined actionable errors, capped paths", () => {
  const result = checkHandoff({ ...input, files_to_read: Array.from({ length: 20 }, (_, i) => `/missing-${i}`) }, { ...ctx, exists: () => false, running: { ...running, jobs: [{ id: "job" }], subagents: [{ agentId: "agent" }, { status: "running" }] } });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join("\n"), /missing-9/);
  assert.doesNotMatch(result.errors.join("\n"), /missing-10/);
  assert.match(result.errors.join("\n"), /job.*agent/);
  assert.match(result.errors.join("\n"), /on_complete/);
  assert.ok(result.errors.every(error => error.endsWith(RETRY)));
});
test("known inventories, unique prefixes and unknown ids", () => {
  const observed = { ...running, jobs: [{ id: "abcdefgh-1" }], subagents: [{ id: "subagent-1" }], scheduled: ["scheduled | waiting"], finishedJobs: ["finished | succeeded"] };
  const check = (ids: string[], extra = {}) => checkHandoff({ ...input, watch_actions: ids.map(action) }, { ...ctx, running: observed, knownIds: ["known"], ...extra });
  assert.deepEqual(check(["abcdefgh", "subagent", "scheduled", "finished", "known"]).errors, []);
  assert.match(check(["abcdefg", "subagent"]).errors.join("\n"), /abcdefgh-1/);
  assert.match(check(["abcdefgh", "subagent", "unknown"]).errors.join("\n"), /Unknown.*unknown/);
  assert.ok(check(["abcdefgh", "subagent"], { running: { ...observed, jobs: [{ id: "abcdefgh-1" }, { id: "abcdefgh-2" }] } }).errors.length);
  const unavailable = check(["abcdefgh", "subagent", "unknown"], { running: { ...observed, unavailable: ["pi-subagents enumeration unavailable"] } });
  assert.equal(unavailable.errors.length, 0);
  assert.match(unavailable.lint.join("\n"), /unknown/);
});
test("downgrade records all objective failures as lint", () => {
  const result = checkHandoff({ ...input, files_to_read: ["/missing"], watch_actions: [action("unknown")] }, { ...ctx, enforce: false, exists: () => false, running: { ...running, jobs: [{ id: "job" }] } });
  assert.deepEqual(result.errors, []);
  assert.match(result.lint.join("\n"), /\(missing\) \/missing/);
  assert.match(result.lint.join("\n"), /job/);
  assert.match(result.lint.join("\n"), /unknown/);
});
test("stale state lint uses the latest mutating tool, excludes same-file edits and handoffs", () => {
  for (const [name, args, warns] of [
    ["edit", { path: "/source.ts" }, true], ["write", { file_path: "/source.ts" }, true],
    ["multi_edit", { path: "/source.ts" }, true], ["notebook_edit", {}, true],
    ["write", { path: "/repo/.ai-work/task/STATE.md" }, false], ["read", { path: "/source.ts" }, false],
    ["bash", { command: "git status && cat file | wc -l" }, false], ["bash", { command: "gh pr view 1; ls" }, false],
    ["bash", { command: "npm test" }, true], ["bash", { command: "git status; touch file" }, true],
  ] as const) {
    const result = checkHandoff({ ...input, files_to_read: ["/repo/.ai-work/task/STATE.md", "/repo/.ai-work/handoffs/old.md", "/ordinary.md"] }, { ...ctx, branch: [entry(name, args)] });
    assert.equal(result.lint.length, warns ? 1 : 0, name + JSON.stringify(args));
    if (warns) assert.match(result.lint[0], /State file.*1970-01-01.*state-changing tool call/);
  }
  assert.deepEqual(checkHandoff({ ...input, files_to_read: ["/STATE.md"] }, { ...ctx, mtimeMs: () => Date.parse("2026-01-03"), branch: [entry("edit", {})] }).lint, []);
  assert.deepEqual(checkHandoff({ ...input, files_to_read: ["/STATE.md"] }, { ...ctx, branch: [entry("edit", {}, "invalid")] }).lint, []);
});
test("validation bounds file observations, warnings and branch scans", () => {
  let observations = 0;
  const files = Array.from({ length: 30 }, (_, i) => `/STATE${i}.md`);
  const branch = [entry("write", {}), ...Array.from({ length: 2000 }, () => entry("read", {}))];
  assert.deepEqual(checkHandoff({ ...input, files_to_read: files }, { ...ctx, branch }).lint, []);
  const result = checkHandoff({ ...input, files_to_read: files }, { ...ctx, exists: () => { observations++; return true; }, mtimeMs: () => { observations++; return 0; }, branch: [entry("edit", {})] });
  assert.ok(observations <= 20);
  assert.ok(result.lint.length <= 8);
});
