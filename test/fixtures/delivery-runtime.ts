import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { findRuntime } from "../runtime.ts";
import { createContextBudgetExtension } from "../../src/extension.ts";
import { SessionHosts } from "../../src/storage.ts";

export async function deliveryRuntime(t: TestContext, mode: string, memory = true, keepRecentTokens = 1) {
  const runtime = findRuntime();
  if (!runtime) throw Error("Installed pi runtime required");
  const pc: any = await import(pathToFileURL(join(runtime, "dist/index.js")).href);
  const ai: any = await import("@earendil-works/pi-ai");
  const root = resolve(import.meta.dirname, "../../.ai-work/r1-runtime"); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-")), agentDir = join(dir, "agent"); mkdirSync(agentDir);
  delete process.env.PI_MEMORY_HOME;
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json"); process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode: mode === "guard-off" ? "enforce" : mode,
    memory: memory ? { journal: true, requests: true, scope: { mode: "all" } } : {} }));
  if (mode === "guard-off") { mkdirSync(join(agentDir, "lib")); writeFileSync(join(agentDir, "lib/guards.ts"), "export const isGuardOff = () => true;"); }
  const faux = ai.fauxProvider({ provider: `delivery-${mode}`, models: [{ id: "m", contextWindow: 1000000 }] });
  const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }); modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens, reserveTokens: 16 }, retry: { enabled: false } });
  const resourceLoader = new pc.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [createContextBudgetExtension({ agentDir, hosts: new SessionHosts(), launchFacts: () => ({ initialPrompt: null, relaunchPrompt: null }) })] });
  await resourceLoader.reload();
  const { session } = await pc.createAgentSession({ cwd: dir, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, noTools: "builtin", sessionManager: pc.SessionManager.inMemory(dir), settingsManager });
  t.after(async () => { await session.abort(); session.dispose(); });
  await session.bindExtensions({ mode: "interactive", uiContext: { notify() {}, setStatus() {} } });
  return { session, faux, ai };
}
