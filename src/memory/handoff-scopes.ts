import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainIdentity } from "../collect.ts";
import { git } from "../storage.ts";
import type { MemoryStoreCore } from "./store.ts";
import type { Scope } from "./types.ts";

/** Strip transport differences, credentials and suffixes from a remote's repository identity. */
export function canonicalRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const address = remote.replace(/^[^/@:]+@([^/:]+):/, "https://$1/");
  try {
    const url = new URL(address);
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) return undefined;
    return `https://${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  } catch { return undefined; }
}
function repository(cwd: string): { root: string; remote?: string } | undefined {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;
  return { root, remote: canonicalRemote(git(root, ["remote", "get-url", "origin"])) };
}
function taskScopes(store: MemoryStoreCore, sessionIds: string[]): Scope[] {
  const sources = new Set<string>();
  for (const sessionId of sessionIds) {
    let cursor: string | undefined;
    do {
      const page = store.listMessages({ sessionId, limit: 1000, cursor });
      for (const entry of page.items) if (sessionIds.includes(entry.session.id)) sources.add(entry.id);
      cursor = page.cursor;
    } while (cursor !== undefined);
  }
  return Object.values(store.readFolded().items)
    .filter(item => item.scope.kind === "task" && !!item.source.ref && sources.has(item.source.ref))
    .map(item => item.scope);
}

/** Keys come from runtime identity and journal provenance, not a model-selected task/repo key. */
export function selectedHandoffScopes(ctx: ExtensionContext, store: MemoryStoreCore, lastPath?: string) {
  const { sessionIds } = chainIdentity(ctx.sessionManager.getBranch?.() ?? [], ctx.sessionManager.getSessionId(), lastPath);
  const repo = repository(ctx.cwd), lane = ctx.sessionManager.getSessionName?.();
  const scopes: Scope[] = [{ kind: "global", key: "*" }, ...sessionIds.map(key => ({ kind: "session" as const, key }))];
  if (repo) scopes.push({ kind: "repo", key: repo.root });
  if (repo?.remote) scopes.push({ kind: "repo", key: repo.remote });
  if (lane) scopes.push({ kind: "lane", key: lane });
  scopes.push(...taskScopes(store, sessionIds));
  const unique = [...new Map(scopes.map(scope => [JSON.stringify(scope), scope])).values()];
  return { scopes: unique, sessionIds, repo };
}

export function normaliseRepoScope(scope: Scope, repo: ReturnType<typeof selectedHandoffScopes>["repo"]): Scope {
  if (scope.kind !== "repo" || !repo?.remote) return scope;
  const matches = scope.key === repo.root || canonicalRemote(scope.key) === repo.remote;
  return matches ? { kind: "repo", key: repo.remote } : scope;
}
