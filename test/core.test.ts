import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflowError, guardOffCrossings, parseConfig, effectiveMode, isSubagent, ownsWrapper, modelThresholds, renderHandoff, MAX_HANDOFF_BYTES, validateHandoff, shorten, RETRY, launchPromptKind, normalizeFilesToRead, effectiveThresholds } from "../src/core.ts";
import { initialState, transition, restoreHistory, type MachineEvent } from "../src/core.ts";
import { parseHandoffSections } from "../src/collect.ts";
import { atomicJson, issueClaims, runningState, watchCheck, writeHandoff, writeMarker, SessionHosts } from "../src/storage.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../.ai-work/unit");
mkdirSync(root, { recursive: true });
const dir = () => mkdtempSync(join(root, "case-"));
const config = parseConfig({});
const t = config.main;
test("overflow recovery configuration defaults and validation", () => {
  assert.equal(parseConfig({}).overflowRecovery, true);
  assert.equal(parseConfig({ overflowRecovery: false }).overflowRecovery, false);
  assert.throws(() => parseConfig({ overflowRecovery: "yes" }), /overflowRecovery must be a boolean/);
});
test("provider overflow recognition excludes throttling and unrelated failures", () => {
  const messages = ['400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1000464 tokens > 1000000 maximum"}}',
    "prompt too long", "request_too_large", "exceeds the context window", "maximum context length", "context_length_exceeded",
    "input is too long", "too many tokens", "token limit exceeded", "context overflow", "context window overflow", "input token count 100 exceeds the maximum"];
  for (const message of messages) assert.equal(isContextOverflowError(message), true, message);
  for (const message of ["rate limit: too many tokens per minute", "too many requests: context overflow", "Throttling error: too many tokens", "Service unavailable: context overflow", "provider failed"]) {
    assert.equal(isContextOverflowError(message), false, message);
  }
});
test("guard-off crossings fire once per level and re-arm below thresholds", () => {
  const clear = { handoff: false, hard: false };
  assert.deepEqual(guardOffCrossings(clear, null, t), { crossed: clear, fired: [] });
  const handoff = guardOffCrossings(clear, t.handoff, t);
  assert.deepEqual(handoff.fired, ["handoff"]);
  assert.deepEqual(guardOffCrossings(handoff.crossed, t.handoff + 1, t).fired, []);
  const hard = guardOffCrossings(handoff.crossed, t.hard, t);
  assert.deepEqual(hard.fired, ["hard"]);
  assert.deepEqual(guardOffCrossings(hard.crossed, null, t).crossed, hard.crossed);
  const dropped = guardOffCrossings(hard.crossed, t.handoff - 1, t);
  assert.deepEqual(dropped.crossed, clear);
  assert.deepEqual(guardOffCrossings(dropped.crossed, t.hard, t).fired, ["handoff", "hard"]);
});
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
test("watch actions, lint and discarded drafts render without corrupting read-first parsing", () => {
  const h = renderHandoff({ ...input, files_to_read: ["/read.md"], watch_actions: [{ id: "agent", target: "review", on_complete: "read result", cancel: "cancel agent" }] },
    { ...auto, lint: ["stale state"], discarded: [{ path: "/old.md", reason: "replaced" }], subagents: [{ id: "agent", description: "review" }] }, "s", 1, "/h.md", "now");
  assert.match(h.text, /## Watch actions\nagent \| review \| read result \| cancel agent/);
  assert.match(h.text, /## Handoff lint\nstale state/);
  assert.match(h.text, /Discarded earlier handoffs.*\/old.md — replaced/);
  assert.deepEqual(parseHandoffSections(h.text).filesToRead, ["/read.md"]);
  assert.equal(h.recordedSubagents?.[0].id, "agent");
  assert.ok(Buffer.byteLength(h.text) <= MAX_HANDOFF_BYTES);
});
test("discard detection logs once, keeps history immutable and ignores committed drafts", () => {
  const handoff = renderHandoff(input, auto, "s", 1, "/old.md", "now");
  const frame = { mode: "enforce" as const, tokens: 1, thresholds: t, config, wrapped: false };
  const cases: [MachineEvent, string][] = [
    [{ type: "tool_call", tool: "read", id: "1" }, "tool call after handoff (agent kept working)"],
    [{ type: "tool_end", tool: "read", id: "1", error: false }, "tool call after handoff (agent kept working)"],
    [{ type: "before_agent_start" }, "new run started before commit (aborted/failed turn or queued wake)"],
    [{ type: "handoff_written", handoff: { ...handoff, path: "/new.md" } }, "replaced by a newer handoff"],
    [{ type: "mode_changed" }, "mode changed"],
  ];
  for (const [event, reason] of cases) {
    const previous = { ...initialState("enforce"), stored: handoff };
    const next = transition(previous, event, { ...frame, mode: event.type === "mode_changed" ? "off" : "enforce" });
    assert.deepEqual(next.state.discarded, [{ path: "/old.md", reason }]);
    assert.deepEqual(previous.discarded, []);
    assert.equal(next.effects.filter(e => e.type === "log" && e.event === "handoff_discarded").length, 1);
    assert.deepEqual(transition({ ...previous, committedPath: handoff.path }, event, frame).state.discarded, []);
  }
  const committed = transition({ ...initialState("enforce"), pending: handoff }, { type: "turn_end" }, frame);
  assert.equal(committed.state.committedPath, handoff.path);
  assert.deepEqual(transition(committed.state, { type: "tool_call", tool: "read", id: "2" }, frame).state.discarded, []);
  const restored = restoreHistory([{ type: "tool", handoff }, { type: "compaction", owned: true }], "enforce");
  assert.deepEqual(transition(restored, { type: "tool_call", tool: "read", id: "2" }, frame).state.discarded, []);
});
test("watch actions and lint have independent UTF-8 budgets and explicit omissions", () => {
  const h = renderHandoff({ ...input, watch_actions: Array.from({ length: 20 }, (_, i) => ({ id: String(i), target: "🦀".repeat(100), on_complete: "🦀".repeat(100), cancel: "🦀".repeat(100) })) },
    { ...auto, lint: Array(8).fill("🦀".repeat(300)), discarded: Array(5).fill({ path: "/old.md", reason: "not committed" }) }, "s", 1, "/h.md", "now");
  const actions = h.text.split("## Watch actions\n")[1].split("\n\n")[0];
  const lint = h.text.split("## Handoff lint\n")[1].split("\n\n")[0];
  assert.match(actions, /omitted: \d+/);
  assert.ok(Buffer.byteLength(actions) <= 3072);
  assert.ok(Buffer.byteLength(lint) <= 1024);
  assert.ok(Buffer.byteLength(h.text) <= MAX_HANDOFF_BYTES);
  assert.ok(!h.text.includes("�"));
});
test("discard history is capped, records once and clears after the next write", () => {
  const frame = { mode: "enforce" as const, tokens: 1, thresholds: t, config, wrapped: false };
  let s = initialState("enforce");
  for (let i = 0; i < 7; i++) {
    s = { ...s, stored: { text: "draft", path: `/draft-${i}.md`, n: i, at: "now" } };
    s = transition(s, { type: "tool_end", tool: "read", id: "1", error: false }, frame).state;
    assert.ok(!transition(s, { type: "tool_end", tool: "read", id: "1", error: false }, frame).effects.some(e => e.type === "log" && e.event === "handoff_discarded"));
  }
  assert.equal(s.discarded.length, 5);
  assert.equal(s.discarded[0].path, "/draft-2.md");
  s = transition(s, { type: "handoff_written", handoff: { text: "new", path: "/new.md", n: 8, at: "now" } }, frame).state;
  assert.deepEqual(s.discarded, []);
});
test("post-reset subagents include completion actions and unavailable registries are silent", () => {
  const global = globalThis as Record<symbol, unknown>, key = Symbol.for("pi-subagents:manager");
  const old = global[key];
  const h = { recordedSubagents: [{ id: "agent" }], watchActions: [{ id: "agent", target: "review", on_complete: "read result" }] };
  try {
    global[key] = { listAgents: () => [] };
    assert.match(watchCheck(h)!, /No longer running[\s\S]*agent \| review \| read result/);
    global[key] = { listAgents: () => [{ id: "agent", status: "running" }] };
    assert.equal(watchCheck(h), undefined);
    global[key] = { getRecord: (id: string) => id === "agent" ? { id, status: "running" } : undefined };
    assert.equal(watchCheck({ watchActions: h.watchActions }), undefined);
    global[key] = { listAgents: () => [] };
    assert.match(watchCheck({ watchActions: h.watchActions })!, /Not running.*agent.*read result/);
    delete global[key];
    assert.equal(watchCheck(h), undefined);
    assert.match(watchCheck({ repos: [{ root: "/nonexistent-repository", branch: "main", head: "123456789", dirty: 0, sync: "unknown" }] })!, /Re-verify per repository[\s\S]*main@1234567.*not inspected/);
  } finally { global[key] = old; }
});
test("handoff rendering, validation, byte cap, uniqueness and exclusive persistence", () => {
  const d = dir();
  const h = renderHandoff(input, auto, "session", 1, join(d, "session-1.md"), "2026-10-17T00:00:00Z");
  assert.match(h.text, /^# Handoff session-1/);
  assert.match(h.text, /Hypotheses \(unverified\)/);
  assert.match(h.text, /Never push\./);
  assert.notEqual(h.text, renderHandoff(input, auto, "session", 2, join(d, "session-2.md"), h.at).text);
  for (const bad of [{ ...input, next_step: "" }, { ...input, files_to_read: ["relative"] }, { ...input, launch_prompt: "x".repeat(16 * 1024 + 1) }, { ...input, launch_prompt: "a\0b" }]) assert.throws(() => renderHandoff(bad, auto, "s", 1, h.path, h.at));
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
    assert.deepEqual(runningState().unavailable, ["pi-subagents registry absent", "scheduled agents: not exposed by registry", "pi-jobs registry absent"]);
    global[sk] = { hasRunning: () => true, getRecord: () => ({ id: "a", status: "running" }) };
    global[jk] = new Set([{ list: () => [{ id: "watch", kind: "watch", status: "running" }, { status: "succeeded" }] }]);
    assert.equal(runningState(["a"]).subagents.length, 1);
    assert.equal(runningState().subagents.length, 1);
    assert.equal(runningState().jobs.length, 1);
  } finally { global[sk] = oldS; global[jk] = oldJ; }
});

test("launch_prompt accepts prompt text and relative-looking strings", () => {
  for (const launch_prompt of ["relative", "Continue the review.\nThen push.", "/review this"]) validateHandoff({ ...input, launch_prompt });
});
test("validation errors show the field, a truncated offending value and the retry hint", () => {
  const long = "x".repeat(200);
  assert.throws(() => validateHandoff({ ...input, files_to_read: ["/ok", "src/a.ts"] }), (e: Error) => /^files_to_read\[1\] must be an absolute path, got "src\/a\.ts"\./.test(e.message) && e.message.includes(RETRY));
  assert.throws(() => validateHandoff({ ...input, files_to_read: ["/ok", long] }), (e: Error) => e.message.includes("…(202 chars)") && !e.message.includes(long));
  assert.throws(() => validateHandoff({ ...input, files_to_read: "nope" as never }), /files_to_read must be an array/);
  assert.throws(() => validateHandoff({ ...input, goal: 5 as never }), (e: Error) => /goal is required.*got 5/.test(e.message) && e.message.includes(RETRY));
  assert.equal(shorten("😀".repeat(100), 10), JSON.stringify("😀".repeat(100)).slice(0, 0) + Array.from(JSON.stringify("😀".repeat(100))).slice(0, 10).join("") + "…(102 chars)");
});
test("launchPromptKind distinguishes files, typo'd paths and text", () => {
  const isFile = (p: string) => p === "/real/prompt.md";
  assert.equal(launchPromptKind("/real/prompt.md", isFile), "path");
  assert.equal(launchPromptKind("/real/typo.md", isFile), "missing");
  assert.equal(launchPromptKind("/review this", isFile), "text");
  assert.equal(launchPromptKind("/real/prompt.md\nmore", isFile), "text");
  assert.equal(launchPromptKind("relative/prompt.md", isFile), "text");
});
test("normalizeFilesToRead resolves relative and home paths and passes invalid values through", () => {
  assert.deepEqual(normalizeFilesToRead(["/abs", "src/a.ts", "~/x.md"], "/work", "/home/u"), ["/abs", "/work/src/a.ts", "/home/u/x.md"]);
  assert.deepEqual(normalizeFilesToRead([5, ""], "/work"), [5, ""]);
  assert.equal(normalizeFilesToRead(undefined, "/work"), undefined);
});
test("effectiveThresholds table", () => {
  assert.deepEqual(effectiveThresholds(null, t), { soft: t.soft, handoff: t.handoff });
  assert.deepEqual(effectiveThresholds(100000, { soft: 150000, handoff: 220000, hard: 400000, minProgress: 50000 }), { soft: 150000, handoff: 220000 });
});
test("rendered handoff includes the working tree and sync, capped", () => {
  const dirty = Array.from({ length: 30 }, (_, i) => ` M file${i}.ts`).concat("…(5 more)");
  const text = renderHandoff(input, { ...auto, dirty, sync: "no upstream" }, "s", 1, "/h.md", "2026-10-17").text;
  assert.match(text, /Working tree:\n M file0\.ts/);
  assert.match(text, /…\(5 more\)\nSync: no upstream/);
  assert.match(renderHandoff(input, { ...auto, dirty: [], sync: "ahead 1, behind 0 (upstream)" }, "s", 1, "/h.md", "x").text, /Working tree:\nclean\nSync: ahead 1/);
  assert.doesNotMatch(renderHandoff(input, auto, "s", 1, "/h.md", "x").text, /Working tree/);
});
