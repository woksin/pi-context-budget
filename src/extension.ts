/** Pi adapter: collect observations, translate events, execute pure-machine outputs. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processSessionHosts, type SessionHosts } from "./storage.ts";
import { processLaunchFacts, type LaunchFacts } from "./memory/launch.ts";
import { createRuntime } from "./adapter/build.ts";
import { wireEvents } from "./adapter/events.ts";

export default async function (pi: ExtensionAPI) {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return createContextBudgetExtension({ agentDir: getAgentDir() })(pi);
}

export function createContextBudgetExtension({ agentDir, hosts = processSessionHosts(), launchFacts = processLaunchFacts }: { agentDir: string; hosts?: SessionHosts; launchFacts?: () => LaunchFacts }) {
  return async function contextBudgetExtension(pi: ExtensionAPI) {
    wireEvents(await createRuntime(pi, { agentDir, hosts, launchFacts }));
  };
}
