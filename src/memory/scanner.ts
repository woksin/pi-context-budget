import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Scanner = (text: string) => unknown;
export type Counts = Map<string, number>;
export const SCANNER_LOAD_TIMEOUT_MS = 2000;

/** Fail closed: the module is optional, but one that is present and unusable (or too slow to load) withholds everything. */
const BROKEN: Scanner = () => { throw new Error("secret scanner unusable"); };
const loaded = new Map<string, Promise<Scanner | undefined>>();

function wrap(module: { scan?: unknown }): Scanner {
  return typeof module.scan === "function"
    ? (text: string) => (module.scan as (t: string, a: string[], o: object) => unknown)(text, [], { diagnostics: true })
    : BROKEN;
}

function withTimeout<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function importScanner(file: string): Promise<Scanner | undefined> {
  if (!existsSync(file)) return undefined;
  try { return wrap(await import(pathToFileURL(file).href) as { scan?: unknown }); } catch { return BROKEN; }
}

/** Cached per process and per agent dir. A load that exceeds the bound caches BROKEN, so it withholds rather than degrading. */
export function loadScanner(agentDir: string, timeoutMs = SCANNER_LOAD_TIMEOUT_MS): Promise<Scanner | undefined> {
  const file = join(agentDir, "lib", "secret-mask.ts");
  let pending = loaded.get(file);
  if (!pending) { pending = withTimeout(importScanner(file), BROKEN, timeoutMs); loaded.set(file, pending); }
  return pending;
}

type Scan = { text: string; kinds: string[]; count: number; skipped: boolean; findings?: { kind: string }[] };
function validScan(value: unknown): value is Scan {
  const scan = value as Scan | null;
  return typeof scan === "object" && scan !== null && typeof scan.text === "string" && typeof scan.skipped === "boolean"
    && typeof scan.count === "number" && Number.isInteger(scan.count) && scan.count >= 0
    && Array.isArray(scan.kinds) && scan.kinds.every(kind => typeof kind === "string");
}

/** Returns the scanned text, or undefined when the result is unusable or skipped. */
export function scannerPass(text: string, scanner: Scanner, counts: Counts): string | undefined {
  const result = scanner(text);
  if (!validScan(result) || result.skipped) return undefined;
  const found = Array.isArray(result.findings) && result.findings.every(f => typeof f?.kind === "string") ? result.findings : undefined;
  const kinds = found?.length ? found.map(f => f.kind) : result.kinds;
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return result.text;
}
