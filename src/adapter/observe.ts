/** Read-only observations of the session: running work, repositories, resume command. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { legacyReplay } from "../memory/handoff-hook.ts";
import { resumeCommand } from "../resume-check.ts";
import { collectRepos, issueClaims, pendingQuestions, runningState } from "../storage.ts";
import { chainIdentity, primaryHead } from "../collect.ts";
import type { Runtime } from "./runtime.ts";

export type Running = ReturnType<typeof runningState>;
type Collected = ReturnType<typeof collectRepos>;

export const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

export function fileMtime(path: string): number | undefined {
  try { const s = statSync(path); return s.isFile() ? s.mtimeMs : undefined; } catch { return undefined; }
}

/** Running work since the last handoff (or unbounded when `since` is false). */
export function observeRunning(rt: Runtime, ctx: ExtensionContext, since: boolean): Running {
  const lastAt = since && rt.state.lastHandoff ? Date.parse(rt.state.lastHandoff.at) : undefined;
  return runningState([...rt.knownIds], { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, lastAt);
}

export function pendingWork(rt: Runtime, ctx: ExtensionContext): boolean {
  const r = observeRunning(rt, ctx, false);
  return !!(r.jobs.length || r.subagents.length);
}

export function checkCommand(rt: Runtime, ctx: ExtensionContext) {
  if (rt.host?.subagent) return undefined;
  return resumeCommand(rt.config, ctx.sessionManager.getSessionName?.());
}

function primaryBranch(collected: Collected, primary: Collected["repos"][number] | undefined): string {
  return primary?.branch ?? (collected.repos.length ? "see repositories below" : "unknown/detached");
}

function repoFields(ctx: ExtensionContext, collected: Collected) {
  const primary = collected.repos.find(repo => repo.root === collected.cwdRoot);
  return { cwd: resolve(ctx.cwd), cwdRoot: collected.cwdRoot, root: collected.cwdRoot ?? resolve(ctx.cwd), branch: primaryBranch(collected, primary),
    head: primary?.head ?? primaryHead(collected.repos), dirty: collected.dirty, sync: primary?.sync ?? "unknown" };
}

export function autoState(rt: Runtime, ctx: ExtensionContext, observed?: Running) {
  const id = ctx.sessionManager.getSessionId(), branch = ctx.sessionManager.getBranch();
  const running = observed ?? observeRunning(rt, ctx, true);
  let claims: unknown[] = [];
  try { claims = issueClaims(join(rt.agentDir, "issue-work/registry.jsonl"), id); }
  catch { running.unavailable.push("issue_work registry absent/unreadable"); }
  const collected = collectRepos(ctx.cwd, branch, claims);
  const home = process.env.PI_QUESTIONS_HOME || join(rt.agentDir, "user-questions");
  return { ...repoFields(ctx, collected), ...running,
    repos: collected.repos, claims: collected.claims, userMessages: legacyReplay(rt.intent, ctx, branch, rt.state.lastHandoff?.at),
    questions: pendingQuestions(home, chainIdentity(branch, id, rt.state.lastHandoff?.path)) };
}
