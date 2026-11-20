/** Handoff validation, rendering and storage. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchPromptKind, renderHandoff, shorten, validateHandoff, RETRY, type AutoState, type Handoff, type HandoffInput } from "../core.ts";
import { checkHandoff } from "../validate.ts";
import { handoffMemory, legacyBranch } from "../memory/handoff-hook.ts";
import { runResumeCheck } from "../resume-check.ts";
import { writeHandoff, writeLaunchPrompt } from "../storage.ts";
import { emergencyHandoff, previousHandoff } from "../collect.ts";
import { autoState, checkCommand, fileMtime, isFile, type Running } from "./observe.ts";
import type { Runtime } from "./runtime.ts";

export function checkLaunchPrompt(input: HandoffInput): void {
  if (input.launch_prompt !== undefined && launchPromptKind(input.launch_prompt, isFile) === "missing") {
    throw new Error(`launch_prompt file not found: ${shorten(input.launch_prompt)}; pass prompt text or an existing absolute path. ${RETRY}`);
  }
}

export type Observed = { running: Running; enforce: boolean };
export type Checks = { lint?: string[]; observed?: Running };

export function validateObserved(rt: Runtime, ctx: ExtensionContext, input: HandoffInput, { running, enforce }: Observed) {
  const checked = checkHandoff(input, { running, knownIds: [...rt.knownIds], exists: isFile, mtimeMs: fileMtime,
    branch: ctx.sessionManager.getBranch(), enforce, memoryIntent: rt.intent.enabled(ctx) });
  if (checked.lint.length) rt.log(ctx, "handoff_lint", { warnings: checked.lint });
  return checked;
}

function nextHandoffPath(rt: Runtime, root: string, id: string): string {
  let path: string;
  do { path = join(root, ".ai-work/handoffs", `${id}-${++rt.sequence}.md`); } while (existsSync(path));
  return path;
}

/** Prompt text becomes a file beside the handoff, so the relaunch marker always holds an absolute file path. */
function storeLaunchPrompt(input: HandoffInput, path: string, id: string, sequence: number): HandoffInput {
  if (input.launch_prompt === undefined || launchPromptKind(input.launch_prompt, isFile) !== "text") return input;
  const promptPath = join(dirname(path), `${id}-${sequence}.launch-prompt.md`);
  writeLaunchPrompt(promptPath, input.launch_prompt);
  return { ...input, launch_prompt: promptPath };
}

export async function createHandoff(rt: Runtime, ctx: ExtensionContext, input: HandoffInput, { lint = [], observed }: Checks = {}): Promise<Handoff> {
  validateHandoff(input);
  const command = checkCommand(rt, ctx);
  const resumeCheck = command ? await runResumeCheck(command, ctx.cwd) : undefined;
  const auto: AutoState = { ...autoState(rt, ctx, observed), resumeCheck, lint, discarded: rt.state.discarded };
  const id = ctx.sessionManager.getSessionId();
  const path = nextHandoffPath(rt, auto.root, id);
  input = storeLaunchPrompt(input, path, id, rt.sequence);
  const h = renderHandoff(input, { ...auto, ...await rt.requests.handoff(ctx), memory: await handoffMemory(rt.intent, ctx, rt.state.lastHandoff) }, id, rt.sequence, path, new Date().toISOString());
  writeHandoff(h, auto, input);
  rt.handoffRejections = 0;
  rt.log(ctx, "handoff_written", { path, n: h.n, bytes: Buffer.byteLength(h.text) });
  return h;
}

export function emergencyInput(rt: Runtime, ctx: ExtensionContext): HandoffInput {
  const branch = ctx.sessionManager.getBranch();
  const previous = previousHandoff(branch, rt.state.lastHandoff, path => readFileSync(path, "utf8"));
  return emergencyHandoff(legacyBranch(rt.intent, ctx, branch), ctx.sessionManager.getSessionFile(), previous, rt.state.lastHandoff?.at);
}
