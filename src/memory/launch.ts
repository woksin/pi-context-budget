import type { OriginContext } from "./origin.ts";

export type LaunchFacts = Pick<OriginContext, "initialPrompt" | "relaunchPrompt">;

/** Mirrors pi's `cli/args.js` (runtime 1.2.0): options that never take a value and never carry a prompt. */
const FLAGS = new Set(["-c", "--continue", "-r", "--resume", "--no-session", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne",
  "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc", "--verbose", "--approve", "-a",
  "--no-approve", "-na", "--offline"]);
/** Options that consume the next argument as their value. */
const VALUED = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session", "--session-id",
  "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill", "--prompt-template",
  "--theme", "--use-theme", "--tui-mode"]);

/** True only when every argument is a known option (and its value): no positional message, no `@file`, no `--`, no `-p/--print`, nothing unrecognised. */
function promptFree(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (FLAGS.has(arg)) continue;
    if (!VALUED.has(arg)) return false; // positional, @file, --, -p, --mode, an extension flag that may swallow a prompt, anything unknown
    const value = args[++index];
    if (value === undefined || value.startsWith("-") || value.startsWith("@")) return false;
  }
  return true;
}

/**
 * Verified launch facts, fail closed. `null` means "verified: none"; `undefined` means unknown (the origin gate then
 * journals the first input as unattended). Relaunch (`bin/pi-session`) always passes `@promptfile`/`continue from <handoff>`
 * positionally, so a prompt-free argv also proves this process is not a relaunch. The environment alone proves nothing.
 */
export function deriveLaunchFacts(args: readonly string[], stdinIsTTY: boolean | undefined): LaunchFacts {
  const verified = stdinIsTTY === true && promptFree(args);
  return { initialPrompt: verified ? null : undefined, relaunchPrompt: verified ? null : undefined };
}
/** `process.argv` is `[runtime, script, ...args]`; any other shape is unknown. */
export function processLaunchFacts(argv: readonly string[] = process.argv, stdinIsTTY: boolean | undefined = process.stdin.isTTY): LaunchFacts {
  return argv.length >= 2 ? deriveLaunchFacts(argv.slice(2), stdinIsTTY) : deriveLaunchFacts(["unknown"], stdinIsTTY);
}
