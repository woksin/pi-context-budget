import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const base = resolve(import.meta.dirname, "../.ai-work/overflow-1/hooks");
const overflowMessage = '400 {"error":{"message":"prompt is too long: 1000464 tokens > 1000000 maximum"}}';
export async function overflowHarness(options: { mode?: string; config?: Record<string, unknown>; guarded?: boolean; outcome?: string } = {}) {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "case-")), agentDir = join(dir, "agent");
  const initial = { mode: options.mode ?? "observe", main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 }, ...options.config };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json");
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  delete process.env.PI_SESSION_WRAPPER; delete process.env.PI_RELAUNCH_MARKER;
  delete process.env.PI_SESSION_WRAPPER_PID; delete process.env.PI_SESSION_LAUNCH_ID;
  if (options.guarded) {
    mkdirSync(join(agentDir, "lib"), { recursive: true });
    writeFileSync(join(agentDir, "lib/guards.ts"), 'export const isGuardOff = () => globalThis[Symbol.for("context-budget:test-guard")] === true;');
  }
  const setConfig = (value: Record<string, unknown>) => writeFileSync(join(dir, "config.json"), JSON.stringify({ ...initial, ...value }));
  setConfig({});
  const handlers = new Map<string, (e: any, ctx: ExtensionContext) => Promise<any>>();
  const notifications: string[] = [], sent: { text: string; opts: unknown }[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); }, registerTool: () => {},
    sendUserMessage: (text: string, opts: unknown) => { sent.push({ text, opts }); } } as unknown as ExtensionAPI;
  let outcome = options.outcome ?? "ok", lastCompactResult: any, compact = 0, usage = 100;
  let during: (() => Promise<unknown>) | undefined;
  const sid = `overflow-${dir.split("/").at(-1)}`;
  const ctx = { cwd: dir, hasUI: false, model: { provider: "test", id: "test" }, isIdle: () => true,
    sessionManager: { getSessionId: () => sid, getSessionFile: () => join(dir, "session.jsonl"), getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: usage }), shutdown: () => {}, ui: { notify: (text: string) => notifications.push(text), setStatus: () => {} },
    compact: (opts: any) => { compact++; void performCompact(opts); },
  } as unknown as ExtensionContext;
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  async function performCompact(opts: any) {
    await during?.();
    if (outcome === "ok") {
      lastCompactResult = await emit("session_before_compact", { reason: "manual", preparation: { firstKeptEntryId: "k1", tokensBefore: 999 } });
      await emit("session_compact", { reason: "manual", fromExtension: !!lastCompactResult?.compaction });
      opts.onComplete({});
      return;
    }
    const errorMessage = outcome === "fail-error" ? "summarizer failed" : "Nothing to compact (session too small)";
    // Real pi awaits its failed hook BEFORE invoking compact's onError callback.
    await emit("session_compact_failed", { reason: "manual", errorMessage, aborted: false, fromExtension: false });
    opts.onError(new Error(errorMessage));
  }
  await createContextBudgetExtension({ agentDir, hosts: new SessionHosts() })(pi);
  await emit("session_start");
  const overflow = (errorMessage = overflowMessage) => emit("turn_end", {
    message: { role: "assistant", stopReason: "error", errorMessage, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
  });
  const settle = (aborted = false) => emit("agent_settled", { aborted });
  const turn = (tokens: number) => {
    usage = tokens;
    return emit("turn_end", { message: { role: "assistant", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  };
  return { ctx, emit, turn, overflow, settle, setConfig, notifications, recover: async () => { await overflow(); await settle(); },
    setCompact: (value: string) => { outcome = value; }, duringCompact: (callback: () => Promise<unknown>) => { during = callback; },
    sent: () => sent, lastCompactResult: () => lastCompactResult, compactions: () => compact,
    events: (): any[] => readFileSync(join(dir, "state/events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)),
    status: () => JSON.parse(readFileSync(join(dir, "state/status", `${sid}.json`), "utf8")) };
}
