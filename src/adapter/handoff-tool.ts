/** The context_handoff tool: schema and validated execution. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { degradedFor, fallbackFor, forced, handoffBackoff, normalizeFilesToRead, validateHandoff, type Effect, type Handoff, type HandoffInput } from "../core.ts";
import { handoffHead } from "../storage.ts";
import { checkLaunchPrompt, createHandoff, validateObserved } from "./handoff.ts";
import { execute, run } from "./effects.ts";
import { frame, mode, step } from "./mode.ts";
import { observeRunning } from "./observe.ts";
import type { Runtime } from "./runtime.ts";

type WriteIntent = Extract<Effect, { type: "write_handoff" }>;
type Checked = ReturnType<typeof validateObserved>;

const DESCRIPTION = "Write a concise structured handoff, then END THIS TURN without more tools. Recovery continues automatically; an idle request resets the context at the end of this turn. Separate facts from hypotheses and preserve user constraints verbatim.";
const watchItem = { type: "string", minLength: 1, maxLength: 300 };
const PARAMETERS = { type: "object", properties: {
  goal: { type: "string", minLength: 1, description: "What the session is trying to achieve." },
  next_step: { type: "string", minLength: 1, description: "The single next action to take on resume." },
  facts: { type: "string", minLength: 1, description: "Verified facts only; verify before relying on them." },
  decisions: { type: "string", description: "Decisions made and why." },
  user_constraints: { type: "string", description: "User constraints, verbatim." },
  open_items: { type: "string", description: "Unfinished work and open questions." },
  hypotheses: { type: "string", description: "Unverified theories, kept separate from facts." },
  files_to_read: { type: "array", items: { type: "string", description: "ABSOLUTE path (relative paths are resolved against the cwd)." }, description: "Existing files to read first on resume; relative paths resolve against cwd. Keep state files current." },
  watch_actions: { type: "array", maxItems: 20, description: "Required for each running watch/job/subagent. Use its exact id (or a unique prefix of at least 8 characters), target and completion follow-up.", items: { type: "object", properties: {
    id: { ...watchItem }, target: { ...watchItem }, on_complete: { ...watchItem }, cancel: { ...watchItem },
  }, required: ["id", "target", "on_complete"], additionalProperties: false } },
  launch_prompt: { type: "string", description: "Optional. The prompt to start the relaunched session with: either the prompt text (saved to a file for you) or an ABSOLUTE path to an existing file containing it." },
}, required: ["goal", "next_step", "facts"], additionalProperties: false };

const text = (value: string, details: { handoff?: Handoff } = {}) => ({ content: [{ type: "text" as const, text: value }], details });

function normalizeInput(input: HandoffInput, cwd: string): HandoffInput {
  input = { ...input, files_to_read: normalizeFilesToRead(input.files_to_read, cwd) as string[] | undefined };
  if (input.files_to_read === undefined) delete input.files_to_read;
  return input;
}

function rejectionKind(error: string): string {
  if (error.startsWith("files_to_read")) return "missing_files";
  return error.startsWith("Unknown") ? "unknown_ids" : "missing_actions";
}

function rejectIfInvalid(rt: Runtime, ctx: ExtensionContext, checked: Checked): void {
  if (!checked.errors.length) return;
  rt.handoffRejections++;
  rt.log(ctx, "handoff_rejected", { reasons: checked.errors.length, kinds: checked.errors.map(rejectionKind) });
  throw new Error(checked.errors.join("\n"));
}

function storedMessage(intent: WriteIntent, lintNotice: string): string {
  return (intent.idleOnly ? "Handoff stored. End this turn without further tools; the context resets at the end of this turn." : "Handoff stored. End this turn without further tools; recovery continues automatically.") + lintNotice;
}

async function writeValidated(rt: Runtime, ctx: ExtensionContext, original: HandoffInput, intent: WriteIntent) {
  const resumeFiles = original.files_to_read;
  const input = normalizeInput(original, ctx.cwd);
  validateHandoff(input);
  checkLaunchPrompt(input);
  const f = frame(rt, ctx), observed = observeRunning(rt, ctx, true);
  const checked = validateObserved(rt, ctx, input, { running: observed, enforce: !fallbackFor(rt.state, f) && rt.handoffRejections < 2 });
  rejectIfInvalid(rt, ctx, checked);
  const refusal = handoffBackoff(input, rt.state.lastHandoff, handoffHead(ctx.cwd, ctx.sessionManager.getBranch()), Boolean(forced(rt.state, f)));
  if (refusal) throw new Error(refusal);
  const handoff = await createHandoff(rt, ctx, input, { lint: checked.lint, observed });
  await rt.resume.remember(ctx, handoff, resumeFiles);
  const lintNotice = checked.lint.length ? " Handoff lint recorded warnings; they are in the handoff file." : "";
  await run(rt, { type: "handoff_written", handoff }, ctx);
  if (degradedFor(rt.state, frame(rt, ctx))) {
    return text(`Handoff written to ${handoff.path}. The session reached its handoff loop limit and cannot relaunch, so the context will not reset: continue the task, and ask the user to start a fresh session from this handoff.${lintNotice}`, { handoff });
  }
  return text(storedMessage(intent, lintNotice), { handoff });
}

export function registerHandoffTool(rt: Runtime): void {
  rt.pi.registerTool({
    name: "context_handoff", label: "Context handoff", description: DESCRIPTION, parameters: PARAMETERS as never,
    async execute(_id, input: HandoffInput, _signal, _update, ctx) {
      const effects = step(rt, { type: "handoff_prepare" }, ctx);
      const intent = effects.find(e => e.type === "write_handoff");
      if (!intent || mode(rt, ctx) !== "enforce") {
        await execute(rt, effects, ctx);
        return text("Handoff inactive; no automatic action. Continue the task.");
      }
      return writeValidated(rt, ctx, input, intent);
    },
  });
}
