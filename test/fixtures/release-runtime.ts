import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STAGE_ZERO = { journal: false, requests: false, intent: false, resume: false, recall: false,
  trustRpc: false, scope: { mode: "only", names: [] }, coordinators: [] };

/** The same adapter harness can run current or extracted tag sources. */
export async function createReleaseRuntime(memory?: unknown, source = new URL("../../src/", import.meta.url)) {
  const { createContextBudgetExtension } = await import(new URL("extension.ts", source).href);
  const { SessionHosts } = await import(new URL("storage.ts", source).href);
  const base = new URL("../../.ai-work/release-fixtures/", import.meta.url).pathname;
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "case-")), agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  // An isolated, empty repository prevents the checkout's HEAD/dirty state entering the golden.
  execFileSync("git", ["init", "--quiet", "--initial-branch=fixture", dir]);
  writeFileSync(join(dir, ".gitignore"), "*\n");
  const configFile = join(dir, "config.json");
  process.env.PI_CONTEXT_BUDGET_CONFIG = configFile;
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  delete process.env.PI_MEMORY_HOME;
  writeFileSync(configFile, JSON.stringify({ mode: "enforce", ...(memory === undefined ? {} : { memory }) }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
  const tools: any[] = [];
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.push(tool), getActiveTools: () => ["read", "context_handoff"],
    getAllTools: () => [{ name: "read" }, { name: "context_handoff" }] } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, model: { provider: "test", id: "test" },
    sessionManager: { getSessionId: () => "s", getSessionFile: () => join(dir, "session.jsonl"),
      getSessionName: () => undefined, getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: 10 }), shutdown() {}, ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  await createContextBudgetExtension({ agentDir, hosts: new SessionHosts(),
    launchFacts: () => ({ initialPrompt: null, relaunchPrompt: null }) })(pi);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start");
  const handoff = async () => {
    const result = await tools.find(tool => tool.name === "context_handoff").execute("handoff",
      { goal: "work", facts: "verified", next_step: "continue" }, undefined, undefined, ctx);
    const written = result.details.handoff;
    // Only fixture-specific metadata is normalised; all handoff content is compared byte-for-byte.
    return readFileSync(written.path, "utf8").replaceAll(dir, "/fixture").replace(`Timestamp: ${written.at}`, "Timestamp: fixture-time");
  };
  return { dir, agentDir, configFile, emit, tools, handoff };
}

export async function releaseFixture(memory?: unknown, source?: URL) {
  const { emit, tools, handoff } = await createReleaseRuntime(memory, source);
  await emit("input", { text: "same task", source: "interactive" });
  const before = { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "same task" }], timestamp: 0 }] };
  const first = (await emit("context", before))?.messages ?? before.messages;
  await emit("session_compact", { reason: "manual", fromExtension: false, compactionEntry: { id: "native" } });
  const after = { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "after reset" }], timestamp: 1 }] };
  const second = (await emit("context", after))?.messages ?? after.messages;
  return JSON.parse(JSON.stringify({ handoff: await handoff(), providerContexts: [first, second], tools }));
}
