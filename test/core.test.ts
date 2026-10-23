import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, effectiveMode, isSubagent, ownsWrapper, modelThresholds, renderHandoff, MAX_HANDOFF_BYTES } from "../src/core.ts";
import { atomicJson, issueClaims, runningState, writeHandoff, writeMarker, SessionHosts } from "../src/storage.ts";
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
  assert.equal(isSubagent({ sessionId: "child", primarySessionId: "main" }), true);
  assert.equal(isSubagent({ sessionId: "forked-main", primarySessionId: "forked-main" }), false);
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
test("process hosting distinguishes live SDK children from forked/resumed primary sessions", () => {
  const hosts = new SessionHosts();
  const main = hosts.acquire("main-with-parentSession");
  assert.equal(main.subagent, false);
  assert.equal(main.primarySessionId, "main-with-parentSession");
  const child = hosts.acquire("in-memory-child-without-parentSession");
  assert.equal(child.subagent, true);
  assert.equal(child.primarySessionId, main.primarySessionId);
  child.release();
  const resumed = hosts.acquire("resumed-child");
  assert.equal(resumed.subagent, true);
  resumed.release(); main.release();
  const fork = hosts.acquire("fork-with-parentSession");
  assert.equal(fork.subagent, false);
  assert.equal(fork.primarySessionId, "fork-with-parentSession");
  assert.equal(child.primarySessionId, "main-with-parentSession");
  fork.release();
  assert.equal(hosts.acquire("resumed-main-with-parentSession").subagent, false);
});
test("wrapper ownership binds process, hosting and unique launch nonce", () => {
  const id = "a".repeat(32);
  const env = { PI_SESSION_WRAPPER: "1", PI_SESSION_WRAPPER_PID: "123", PI_SESSION_LAUNCH_ID: id, PI_RELAUNCH_MARKER: `/markers/123-${id}.json` };
  assert.equal(ownsWrapper(123, env, false), true);
  assert.equal(ownsWrapper(456, env, false), false); // inherited subprocess env
  assert.equal(ownsWrapper(123, env, true), false); // in-process SDK child
  assert.equal(ownsWrapper(123, { ...env, PI_SESSION_LAUNCH_ID: "b".repeat(32) }, false), false);
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
test("automatic metadata has a fixed budget independent of pending-work volume", () => {
  const records = Array.from({ length: 1000 }, () => ({ command: "字".repeat(50000) }));
  const rendered = renderHandoff(input, { ...auto, jobs: records, subagents: records, claims: records }, "session", 1, "/handoff.md", "2026-10-17");
  assert.ok(Buffer.byteLength(rendered.text) < MAX_HANDOFF_BYTES);
  assert.match(rendered.text, /omitted/);
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
