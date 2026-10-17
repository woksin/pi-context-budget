import { test } from "node:test";
import assert from "node:assert/strict";
import { Budget, parseConfig, effectiveMode, isSubagent, modelThresholds, renderHandoff, shouldBlock, MAX_HANDOFF_BYTES } from "../src/core.ts";
import { atomicJson, issueClaims, runningState, writeHandoff, writeMarker } from "../src/storage.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../.ai-work/unit");
mkdirSync(root, { recursive: true });
const dir = () => mkdtempSync(join(root, "case-"));
const config = parseConfig({});
const t = config.main;
test("defaults, model overrides, roles and validated config", () => {
  assert.equal(config.mode, "observe");
  assert.equal(t.handoff, 400000);
  assert.equal(config.subagent.hard, 300000);
  assert.equal(isSubagent({ parentSession: "/parent.jsonl" }), true);
  for (const header of [undefined, {}, { parentSession: "" }]) assert.equal(isSubagent(header), false);
  const c = parseConfig({ mode: "enforce", models: { "x/y": { main: { handoff: 350000 } } } });
  assert.equal(modelThresholds(c, "x/y", false).handoff, 350000);
  assert.equal(modelThresholds(c, "x/y", true).handoff, 200000);
  for (const raw of [null, [], { mode: "oops" }, { idleMinutes: 0 }, { main: { hard: 1 } }, { models: { x: null } }, { maxHandoffsPerSession: 1.5 }, { enforceCwds: [12] }, { enforceCwds: ["relative"] }]) {
    assert.throws(() => parseConfig(raw));
  }
});
test("enforceCwds prefix boundaries, globs, empty list, guard opt-out", () => {
  const c = parseConfig({ mode: "enforce", enforceCwds: ["/repo/one", "/lanes/*/work"] });
  assert.equal(effectiveMode(c, "/repo/one"), "enforce");
  assert.equal(effectiveMode(c, "/repo/one/child"), "enforce");
  assert.equal(effectiveMode(c, "/repo/onerous"), "observe");
  assert.equal(effectiveMode(c, "/lanes/a/work"), "enforce");
  assert.equal(effectiveMode(c, "/lanes/a/b/work"), "observe");
  assert.equal(effectiveMode(c, "/repo/one", true), "off");
  assert.equal(effectiveMode(parseConfig({ mode: "enforce", enforceCwds: [] }), "/repo"), "observe");
});
test("threshold equality, unknown/null floor, floor-relative progress and hard fallback", () => {
  const b = new Budget();
  assert.equal(b.action(450000, t, config), "none");
  b.measureUsage(410000);
  assert.equal(b.action(450000, t, config), "none");
  assert.equal(b.action(460000, t, config), "handoff");
  b.resetFloor();
  assert.equal(b.action(null, t, config), "none");
  assert.equal(b.action(600000, t, config), "relaunch");
  b.measureUsage(100000);
  assert.equal(b.action(399999, t, config), "none");
  assert.equal(b.action(400000, t, config), "handoff");
});
test("loop/cap guard, progress reset and turn window", () => {
  const b = new Budget();
  for (let n = 0; n < 3; n++) { b.turn++; b.committed(); }
  assert.equal(b.action(null, t, config), "relaunch");
  b.progressed();
  assert.equal(b.action(null, t, config), "none");
  b.handoffTurns = [1, 2, 3]; b.turn = 20;
  assert.equal(b.looped(config), false);
  b.count = config.maxHandoffsPerSession;
  assert.equal(b.action(null, t, config), "relaunch");
});
test("blocking only in enforce, only context_handoff exempt; wrapper-backed fallback stops blocking", () => {
  for (const mode of ["observe", "off"] as const) for (const action of ["none", "handoff", "relaunch"] as const) {
    assert.equal(shouldBlock(mode, "write", action, true, false), false);
  }
  assert.equal(shouldBlock("enforce", "context_handoff", "handoff", true, false), false);
  assert.equal(shouldBlock("enforce", "read", "handoff", false, false), true);
  assert.equal(shouldBlock("enforce", "Agent", "relaunch", false, false), true);
  assert.equal(shouldBlock("enforce", "read", "relaunch", false, true), false);
});
const input = { goal: "task", next_step: "read files", facts: "HEAD unknown", hypotheses: "untested theory", user_constraints: "Never push." };
const auto = { cwd: "/repo", root: "/repo", branch: "main", head: "abc", jobs: [], subagents: [], claims: [], unavailable: [] };
test("handoff rendering, validation, byte cap, uniqueness and exclusive persistence", () => {
  const d = dir();
  const h = renderHandoff(input, auto, "session", 1, join(d, "session-1.md"), "2026-10-17T00:00:00Z");
  assert.match(h.text, /^# Handoff session-1/);
  assert.match(h.text, /Hypotheses \(unverified\)/);
  assert.match(h.text, /Never push\./);
  assert.notEqual(h.text, renderHandoff(input, auto, "session", 2, join(d, "session-2.md"), h.at).text);
  for (const bad of [{ ...input, next_step: "" }, { ...input, files_to_read: ["relative"] }, { ...input, launch_prompt: "relative" }]) assert.throws(() => renderHandoff(bad, auto, "s", 1, h.path, h.at));
  assert.throws(() => renderHandoff({ ...input, facts: "é".repeat(MAX_HANDOFF_BYTES / 2) }, auto, "s", 1, h.path, h.at), /limit/);
  writeHandoff(h, auto);
  assert.equal(readFileSync(h.path, "utf8"), h.text);
  assert.equal(JSON.parse(readFileSync(h.path.replace(/md$/, "json"), "utf8")).auto.head, "abc");
  assert.throws(() => writeHandoff(h, auto), /EEXIST/);
});
test("atomic markers have exact absolute paths and no temporary data in final file", () => {
  const path = join(dir(), "99.json");
  const m = { cwd: "/repo", launchPrompt: "/launch.md", handoff: "/h.md", sessionFile: "/session.jsonl" };
  writeMarker(path, m);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), m);
  assert.throws(() => writeMarker(path, { ...m, cwd: "relative" }), /absolute/);
  atomicJson(path, { update: true });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { update: true });
});
test("issue claims use latest global ownership/state; corrupt partial lines ignored", () => {
  const path = join(dir(), "registry.jsonl");
  const events = [
    { repo: "example/project", issue: 1, sessionId: "me", state: "in-progress" },
    { repo: "example/project", issue: 2, sessionId: "me", state: "in-progress" },
    { repo: "example/project", issue: 2, sessionId: "other", state: "in-progress" },
    { repo: "example/project", issue: 3, sessionId: "me", state: "done" },
  ];
  writeFileSync(path, events.map(e => JSON.stringify(e)).join("\n") + "\n{partial");
  assert.deepEqual(issueClaims(path, "me"), [{ repo: "example/project", issue: 1, state: "in-progress", pr: undefined, branch: undefined }]);
});
test("optional Symbol registries degrade gracefully and retain pending watches/subagents", () => {
  const global = globalThis as Record<symbol, unknown>;
  const sk = Symbol.for("pi-subagents:manager"), jk = Symbol.for("pi-jobs.liveManagers");
  const oldS = global[sk], oldJ = global[jk];
  try {
    delete global[sk]; delete global[jk];
    assert.equal(runningState().unavailable.length, 2);
    global[sk] = { hasRunning: () => true, getRecord: () => ({ id: "a", status: "running" }) };
    global[jk] = new Set([{ list: () => [{ id: "watch", kind: "watch", status: "running" }, { status: "succeeded" }] }]);
    assert.equal(runningState(["a"]).subagents.length, 1);
    assert.equal(runningState().subagents.length, 1);
    assert.equal(runningState().jobs.length, 1);
  } finally { global[sk] = oldS; global[jk] = oldJ; }
});
