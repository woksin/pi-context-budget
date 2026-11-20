/** Offline real-runtime input routing. UI is stubbed; no provider is ever called. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRuntime } from "./runtime.ts";
import { classifyOrigin, type OriginContext, type OriginDecision } from "../src/memory/origin.ts";

const runtime = findRuntime();
const skip = runtime ? false : "pi runtime unavailable";
async function load(path: string) { return import(pathToFileURL(join(runtime!, "dist", path)).href); }
async function setup(t: { after(fn: () => void): void }, facts: Partial<OriginContext> = {}) {
  const pc = await load("index.js");
  const root = resolve(import.meta.dirname, "../.ai-work/origin-paths");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-")), agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  const records: OriginDecision[] = [], inputs: any[] = [], journalCalls: OriginDecision[] = [];
  let firstInput = true;
  const context: OriginContext = { hostSubagent: false, identity: { sessionId: "main", primarySessionId: "main" },
    initialPrompt: null, relaunchPrompt: null, ...facts };
  const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new pc.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [(pi: any) => pi.on("input", (event: any, ctx: any) => {
      const decision = classifyOrigin(event, { ...context, firstInput, hasUI: ctx.hasUI });
      firstInput = false;
      inputs.push(event); records.push(decision);
      if (decision.journal) journalCalls.push(decision);
      return { action: ctx.isIdle() ? "handled" : "continue" };
    })] });
  await loader.reload();
  const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await pc.createAgentSession({ cwd: dir, agentDir, modelRuntime, resourceLoader: loader,
    noTools: "builtin", sessionManager: pc.SessionManager.inMemory(dir), settingsManager });
  await session.bindExtensions({ mode: facts.hasUI === false ? "print" : "interactive", ...(facts.hasUI === false ? {} : { uiContext: {} }) });
  t.after(() => {
    try { session._isAgentRunActive = false; session.dispose(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { session, dir, records, inputs, journalCalls, context, loader };
}

test("real pi TUI typed and pasted input are human", { skip }, async t => {
  const h = await setup(t);
  for (const text of ["typed request", "pasted first line\nsecond line"]) {
    await h.session.prompt(text);
    assert.equal(h.records.at(-1)?.origin, "human");
  }
  await h.session.prompt("unknown source despite UI", { source: "future-source" });
  assert.equal(h.records.at(-1)?.origin, "unattended");
  await h.session.prompt("RPC despite UI", { source: "rpc" });
  assert.equal(h.records.at(-1)?.origin, "unattended");
});

test("real pi streaming steer and followUp retain human provenance", { skip }, async t => {
  const h = await setup(t);
  // Offline fixture opens the SDK's run boundary without starting a provider stream.
  // Exercise the real queue branches, not a mock emitter; terminal rendering is not tested.
  h.session._isAgentRunActive = true;
  await h.session.prompt("steer request", { streamingBehavior: "steer" });
  await h.session.prompt("follow up request", { streamingBehavior: "followUp" });
  await h.session.steer("direct steer");
  await h.session.followUp("direct follow up");
  assert.deepEqual(h.records.map(r => r.origin), ["human", "human", "human", "human"]);
  assert.deepEqual(h.session.getSteeringMessages(), ["steer request", "direct steer"]);
  assert.deepEqual(h.session.getFollowUpMessages(), ["follow up request", "direct follow up"]);
});

async function cliPrompt(args: string[]) {
  const { parseArgs } = await load("cli/args.js");
  const { processFileArguments } = await load("cli/file-processor.js");
  const { buildInitialMessage } = await load("cli/initial-message.js");
  const parsed = parseArgs(args);
  const files = await processFileArguments(parsed.fileArgs);
  return buildInitialMessage({ parsed, fileText: files.text, fileImages: files.images }).initialMessage;
}

test("real CLI argument and wrapper @launchPrompt plus continuation are launch", { skip }, async t => {
  const initialPrompt = await cliPrompt(["start the task"]);
  const h = await setup(t, { initialPrompt });
  await h.session.prompt(initialPrompt);
  assert.equal(h.records.at(-1)?.origin, "launch");
  const file = join(h.dir, "launch.md");
  writeFileSync(file, "stored previous handoff launch_prompt");
  // bin/pi-session supplies @file AND 'continue from <handoff>'; compare the assembled input.
  const relaunchPrompt = await cliPrompt([`@${file}`, `continue from ${join(h.dir, "handoff.md")}`]);
  assert.match(relaunchPrompt, /stored previous handoff launch_prompt/);
  const successor = await setup(t, { relaunchPrompt });
  await successor.session.prompt(relaunchPrompt);
  assert.equal(successor.records.at(-1)?.origin, "launch");
  assert.equal(successor.records.at(-1)?.injectedKind, "relaunch");
});

test("real print/no-UI and RPC paths default to unattended", { skip }, async t => {
  const h = await setup(t, { hasUI: false });
  await h.session.prompt("print request");
  await h.session.prompt("RPC request", { source: "rpc" });
  await h.session.prompt("unknown no-UI request", { source: "future-source" });
  assert.deepEqual(h.records.map(r => r.origin), ["unattended", "unattended", "unattended"]);
});

test("real sendUserMessage lane inbox and provider fallback are injected", { skip }, async t => {
  const h = await setup(t);
  await h.session.sendUserMessage("[orch order from L0] subject\nbody\n→ message (id test)");
  assert.equal(h.records.at(-1)?.origin, "injected");
  assert.equal(h.records.at(-1)?.injectedFrom, "L0");
  await h.session.sendUserMessage("Provider limits have lifted (anthropic). Continue where you stopped.");
  assert.equal(h.records.at(-1)?.origin, "injected");
});

test("real child prompt and structured retry without source never call journal", { skip }, async t => {
  for (const facts of [{ hostSubagent: true }, { identity: { sessionId: "child", primarySessionId: "main" } }]) {
    const h = await setup(t, facts);
    // Match agent-runner runAgent/resumeAgent: session.prompt(text), NO source option.
    const runner = { run: (text: string) => h.session.prompt(text) };
    await runner.run("first subagent prompt");
    await runner.run("You did not call StructuredOutput, so your answer was not recorded.\n\nCall StructuredOutput now with your complete final answer. Do not reply with prose.");
    assert.equal(h.inputs[0].source, "interactive"); // Runtime default is unsafe without child facts.
    assert.equal(h.records.length, 2);
    assert.equal(h.journalCalls.length, 0);
  }
});

test("real custom job/question wakes and child completions bypass input and journal", { skip }, async t => {
  const h = await setup(t);
  for (const customType of ["job-notification", "question-answer", "subagent-completion"]) {
    await h.session.sendCustomMessage({ customType, content: "<task-notification>done</task-notification>", display: true });
  }
  assert.equal(h.session.sessionManager.getBranch().filter((e: any) => e.type === "custom_message").length, 3);
  assert.equal(h.inputs.length, 0);
  assert.equal(h.journalCalls.length, 0);
});

test("real skill and prompt-template expansion preserves the human input origin", { skip }, async t => {
  const h = await setup(t);
  const filePath = join(h.dir, "SKILL.md");
  writeFileSync(filePath, "skill instructions");
  h.loader.getSkills = () => ({ skills: [{ name: "example", filePath, baseDir: h.dir, description: "example", source: "test", disableModelInvocation: false }], diagnostics: [] });
  h.loader.getPrompts = () => ({ prompts: [{ name: "example", content: "template $ARGUMENTS", description: "example", source: "test" }], diagnostics: [] });
  h.session._isAgentRunActive = true;
  await h.session.prompt("/skill:example task", { streamingBehavior: "steer" });
  await h.session.prompt("/example task", { streamingBehavior: "followUp" });
  assert.deepEqual(h.records.map(r => r.origin), ["human", "human"]);
  assert.match(h.session.getSteeringMessages()[0], /skill instructions/);
  assert.equal(h.session.getFollowUpMessages()[0], "template task");
});
