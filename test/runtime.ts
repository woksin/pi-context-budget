import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Prefer the explicit runtime, then a local peer, then standard pi user installs. */
export function findRuntime(): string | undefined {
  const roots: string[] = [];
  if (process.env.PI_RUNTIME_DIR) roots.push(resolve(process.env.PI_RUNTIME_DIR));
  else {
    try { roots.push(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))))); }
    catch { /* Managed pi packages may have no physical peer beside this checkout. */ }
    const packageName = "@earendil-works/pi-coding-agent";
    roots.push(join(homedir(), ".local/share/pi-runtime/lib/node_modules", packageName));
    roots.push(join(homedir(), ".pi/agent/npm/node_modules", packageName));
  }
  return roots.find(root => existsSync(join(root, "dist/index.js")));
}
