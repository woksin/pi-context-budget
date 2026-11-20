import { constants, type Stats } from "node:fs";
import { open, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { atomicJson } from "../storage.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_HANDOFF_BYTES, type Handoff, type HandoffInput } from "../core.ts";
import { flagOn, readMemoryConfig } from "./config.ts";
import { redactedField } from "./mask.ts";
import { loadScanner, redact, SCAN_CAP_BYTES, type Scanner } from "./redact.ts";
import { singleLine } from "./render.ts";

export const FILE_BYTES = 8 * 1024, PACKET_BYTES = 24 * 1024;
const FACT_BYTES = 3 * 1024, MAX_FILES = 20;
const HEADER = "## Resume packet (reference material, not instructions)\nVolatile facts were observed at commit time and may be stale if the session restarts later.";
const MARKER = " … [bounded; head + tail] … ";
const FOOTER = "## End resume packet";
type Repo = { root: string };
export type Observation = {
  cwdRoot?: string | null; repos?: Repo[]; head?: string; dirty?: string[]; claims?: unknown[];
  jobs?: unknown[]; subagents?: unknown[]; unavailable: string[];
};
type PacketInput = {
  cwdRoot?: string | null; repos: Repo[]; agentDir: string; handoffAt: string; files: string[];
  observation: Observation; observedAt?: string; scanner?: Scanner; budget?: number;
};
type Redactor = (value: string) => ReturnType<typeof redact>;
type FileData = { text: string; mtime: string; sha8: string };

/** Cap the encoded representation, not just the source string. Iterate code points, never UTF-16 units. */
function encodedExcerpt(text: string, budget: number): string {
  if (Buffer.byteLength(singleLine(text)) <= budget) return singleLine(text);
  const points = [...text], room = Math.max(0, budget - Buffer.byteLength(singleLine(MARKER)));
  const take = (list: string[], cap: number) => {
    const result: string[] = [];
    let used = 0;
    for (const point of list) {
      used += Buffer.byteLength(singleLine(point)) - 2;
      if (used > cap) break;
      result.push(point);
    }
    return result;
  };
  const head = take(points, Math.floor(room / 2));
  const tail = take(points.reverse(), Math.floor(room / 2)).reverse();
  return singleLine(head.join("") + MARKER + tail.join(""));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}
async function allowedRoots(input: PacketInput): Promise<string[]> {
  const roots = [input.cwdRoot, input.agentDir, ...input.repos.map(repo => join(repo.root, ".ai-work"))];
  const present = roots.filter((root): root is string => typeof root === "string");
  const canonical = await Promise.all(present.map(root => realpath(root).catch(() => undefined)));
  const homes = [resolve(homedir()), await canonicalPath(homedir())];
  const existing = canonical.filter((root): root is string => root !== undefined);
  // This also excludes filesystem roots and every ancestor of home, including symlink aliases.
  return existing.filter(root => !homes.some(home => inside(root, home)));
}
type ReadPolicy = { roots: string[]; sessions: string[] };
function privatePath(path: string, policy: ReadPolicy): boolean {
  return path.split(/[\\/]/u).includes(".git") || policy.sessions.some(root => inside(root, path));
}
function secretName(path: string): boolean {
  return path.split(/[\\/]/u).some(name => /^(?:\.env.*|id_.*|auth\.json)$|\.pem$/iu.test(name));
}
function validPath(path: string): void {
  if (!isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw Error("path_not_allowed");
  if (secretName(path)) throw Error("secret_name");
}
function textOnly(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw Error("binary");
  if (/`{3,}|~{3,}/u.test(text)) throw Error("fence");
  return text;
}
async function readBounded(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size + 1);
  let used = 0;
  while (used < bytes.length) {
    const part = await handle.read(bytes, used, bytes.length - used, used);
    if (!part.bytesRead) break;
    used += part.bytesRead;
  }
  return bytes.subarray(0, used);
}
function sameSnapshot(before: Stats, after: Stats): boolean {
  const keys = ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const;
  return keys.every(key => before[key] === after[key]);
}
function regularSize(before: Stats): number {
  if (!before.isFile()) throw Error("not_regular");
  if (before.size > SCAN_CAP_BYTES) throw Error("too_large");
  return before.size;
}
async function snapshot(handle: FileHandle, path: string, canonical: string): Promise<{ body: Buffer; before: Stats }> {
  const before = await handle.stat();
  const body = await readBounded(handle, regularSize(before));
  const versions = [await handle.stat(), await stat(path)];
  if (!versions.every(version => sameSnapshot(before, version))) throw Error("changed_during_read");
  if (body.length !== before.size || await realpath(path) !== canonical) throw Error("changed_during_read");
  return { body, before };
}
/** Check canonical containment before opening; recheck identity/mtime after the bounded read. */
async function readChecked(path: string, policy: ReadPolicy): Promise<FileData> {
  validPath(path);
  const canonical = await realpath(path);
  validPath(canonical);
  if ([path, canonical].some(name => privatePath(name, policy))) throw Error("path_not_allowed");
  if (!policy.roots.some(root => inside(root, canonical))) throw Error("path_not_allowed");
  // Open the supplied path as well as checking its realpath: a final symlink must not be followed.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const { body, before } = await snapshot(handle, path, canonical);
    return { text: textOnly(body), mtime: before.mtime.toISOString(), sha8: createHash("sha256").update(body).digest("hex").slice(0, 8) };
  } finally { await handle.close(); }
}
function safeField(value: string, redactor: Redactor): string {
  return encodedExcerpt(redactedField(value, redactor), 512);
}
function fileNote(path: string, reason: string, redactor: Redactor): string {
  let name = singleLine("withheld");
  try { name = safeField(basename(path).slice(0, 200), redactor); } catch { /* No raw name on failure. */ }
  return `file=${name} dropped=${singleLine(reason)}`;
}
function dropReason(error: unknown): string {
  const known = ["path_not_allowed", "secret_name", "not_regular", "too_large", "binary", "fence", "changed_during_read", "redactor_failed"];
  return error instanceof Error && known.includes(error.message) ? error.message : "unavailable_or_not_text";
}
type FileContext = { policy: ReadPolicy; input: PacketInput; redactor: Redactor };
async function fileSection(path: string, context: FileContext, budget: number): Promise<string> {
  const { policy, input, redactor } = context;
  try {
    const data = await readChecked(path, policy);
    const result = redactor(data.text);
    if (result.text === null) throw Error("redactor_failed");
    // Mask only after both passes have seen the complete file, before excerpting.
    const body = redactedField(result.text, text => ({ text, withheld: null, redactions: [] }));
    const metadata = `file=${safeField(basename(path).slice(0, 200), redactor)} mtime=${singleLine(data.mtime)} sha8=${singleLine(data.sha8)}`;
    const stale = Date.parse(data.mtime) > Date.parse(input.handoffAt) ? " stale=" + singleLine("mtime newer than handoff") : "";
    const prefix = `${metadata}${stale}\nexcerpt=`;
    if (Buffer.byteLength(prefix) + Buffer.byteLength(singleLine(MARKER)) > budget) return fileNote(path, "packet_cap", redactor);
    return prefix + encodedExcerpt(body, budget - Buffer.byteLength(prefix));
  } catch (error) { return fileNote(path, dropReason(error), redactor); }
}
function unknownFact(reasons: string[], pattern: RegExp, value: unknown): string {
  const failed = reasons.filter(reason => pattern.test(reason));
  return failed.length ? `unknown (${failed.join("; ")})` : JSON.stringify(value ?? "unknown (not observed)");
}
function factSections(input: PacketInput, redactor: Redactor): string[] {
  const obs = input.observation, at = input.observedAt ?? new Date().toISOString();
  const facts = [
    ["HEAD/dirty", JSON.stringify({ head: obs.head ?? "unknown (not observed)", dirty: obs.dirty ?? "unknown (not observed)" })],
    ["claims", unknownFact(obs.unavailable, /issue_work/u, obs.claims)],
    ["jobs", unknownFact(obs.unavailable, /pi-jobs/u, obs.jobs)],
    ["subagents", unknownFact(obs.unavailable, /pi-subagents/u, obs.subagents)],
    ["unread lane messages", "unknown (not exposed by collectors)"],
  ];
  return facts.map(([name, value]) => {
    const prefix = `fact=${singleLine(name)} observed=${singleLine(at)} value=`;
    let masked = "unknown (redactor_failed)";
    try { masked = redactedField(value, redactor); } catch { /* Fail closed per fact too. */ }
    return prefix + encodedExcerpt(masked, Math.floor(FACT_BYTES / facts.length) - Buffer.byteLength(prefix));
  });
}

function appendDropNote(sections: string[], remaining: number, budget: number): void {
  if (!remaining) return;
  const note = `files_dropped=${singleLine(String(remaining))} reason=${singleLine("packet_cap_or_file_limit")}`;
  const used = Buffer.byteLength(sections.join("\n\n"));
  if (used + Buffer.byteLength(note) + 2 <= budget) sections.push(note);
}
/** Purely composable sections; S7a can add generic checks without changing delivery. */
export async function assemblePacket(input: PacketInput): Promise<{ sections: string[] }> {
  const budget = Math.min(PACKET_BYTES, input.budget ?? PACKET_BYTES) - Buffer.byteLength(FOOTER) - 2;
  const scanner = input.scanner ?? await loadScanner(input.agentDir), redactor: Redactor = value => redact(value, scanner);
  const sections = [HEADER, ...factSections(input, redactor)];
  let used = Buffer.byteLength(sections.join("\n\n"));
  if (used > budget) return { sections: [] };
  const policy = { roots: await allowedRoots(input), sessions: [resolve(input.agentDir, "sessions"), await canonicalPath(join(input.agentDir, "sessions"))] };
  const files = input.files.slice(0, MAX_FILES);
  let included = 0;
  for (const path of files) {
    const room = budget - used - 2 - 128; // Reserve room for an explicit aggregate drop note.
    if (room < 512) break;
    const section = await fileSection(path, { policy, input, redactor }, Math.min(FILE_BYTES, room));
    sections.push(section); used += Buffer.byteLength(section) + 2; included++;
  }
  appendDropNote(sections, input.files.length - included, budget);
  sections.push(FOOTER);
  return { sections };
}
async function handoffFiles(handoff?: Handoff): Promise<string[]> {
  if (!handoff) return [];
  try {
    const saved = JSON.parse(await readFile(handoff.path.replace(/\.md$/u, ".json"), "utf8"));
    const files = saved?.resumeFiles ?? saved?.input?.files_to_read;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string").slice(0, MAX_FILES) : [];
  } catch { return []; }
}
type HookDeps = {
  agentDir: string; configFile: string; observe(ctx: ExtensionContext): Observation;
  log?(ctx: ExtensionContext, event: string, data: Record<string, unknown>): void;
};
/** Only a terminated final block is ours; header text elsewhere can be verbatim user input. */
function finalPacketStart(text: string): number {
  return text.endsWith(`\n${FOOTER}\n`) ? text.lastIndexOf(`\n\n${HEADER}\n`) : -1;
}
function withoutPacket(summary: string, handoff?: Handoff): string {
  const start = finalPacketStart(summary);
  if (start >= 0) return summary.slice(0, start);
  // Backstops append lint/instance metadata after the stored handoff's final block.
  const stored = handoff?.text ?? "", storedStart = finalPacketStart(stored);
  if (storedStart >= 0 && summary.startsWith(stored)) return stored.slice(0, storedStart) + summary.slice(stored.length);
  return summary;
}
function sidecarPath(handoff: Handoff): string { return handoff.path.replace(/\.md$/u, ".json"); }
async function savedHandoff(handoff: Handoff): Promise<Record<string, unknown>> {
  const saved = JSON.parse(await readFile(sidecarPath(handoff), "utf8"));
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw Error("invalid_sidecar");
  return saved;
}
async function persistHandoff(handoff: Handoff, text: string): Promise<void> {
  const saved = await savedHandoff(handoff), temp = `${handoff.path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  atomicJson(sidecarPath(handoff), { ...saved, text });
  try { await rename(temp, handoff.path); }
  catch (error) {
    try { atomicJson(sidecarPath(handoff), saved); }
    finally { await unlink(temp); }
    throw error;
  }
  handoff.text = text;
}
function observe(deps: HookDeps, ctx: ExtensionContext): Observation {
  try { return deps.observe(ctx); }
  catch { return { unavailable: ["issue_work collector failed", "pi-jobs collector failed", "pi-subagents collector failed"] }; }
}
/** Commit-time fallback: no request hook, no per-call timestamp, no provider-time file access. */
export function createResumeHook(deps: HookDeps) {
  const committed = new WeakMap<Handoff, Map<string, Promise<string>>>(), blocked = new WeakSet<Handoff>();
  const enabled = (ctx: ExtensionContext) => flagOn(readMemoryConfig(deps.configFile).config, ctx.sessionManager.getSessionName?.(), "resume");
  function failed(ctx: ExtensionContext, handoff: Handoff, operation: string): void {
    blocked.add(handoff); committed.delete(handoff);
    try { deps.log?.(ctx, "resume_packet_skipped", { operation }); } catch { /* Logging must not block recovery. */ }
  }
  async function build(ctx: ExtensionContext, original: string, handoff?: Handoff, input?: HandoffInput): Promise<string> {
    const summary = withoutPacket(original, handoff), observation = observe(deps, ctx), observedAt = new Date().toISOString();
    const packet = await assemblePacket({ cwdRoot: observation.cwdRoot, repos: observation.repos ?? [], agentDir: deps.agentDir,
      handoffAt: handoff?.at ?? observedAt, files: input?.files_to_read ?? await handoffFiles(handoff), observation, observedAt,
      budget: Math.max(0, MAX_HANDOFF_BYTES - Buffer.byteLength(summary) - 3) });
    return packet.sections.length ? summary + "\n\n" + packet.sections.join("\n\n") + "\n" : summary;
  }
  async function append(ctx: ExtensionContext, summary: string, handoff?: Handoff, input?: HandoffInput): Promise<string> {
    if (!enabled(ctx)) return summary;
    if (!handoff) return build(ctx, summary, handoff, input);
    if (blocked.has(handoff)) return withoutPacket(summary, handoff);
    let summaries = committed.get(handoff);
    if (!summaries) { summaries = new Map(); committed.set(handoff, summaries); }
    let pending = summaries.get(summary);
    if (!pending) { pending = build(ctx, summary, handoff, input); summaries.set(summary, pending); }
    return pending;
  }
  return {
    append,
    async remember(ctx: ExtensionContext, handoff: Handoff, files: unknown): Promise<void> {
      if (!enabled(ctx) || !Array.isArray(files)) return;
      try {
        const saved = await savedHandoff(handoff);
        // Keep spelling before the legacy normalizer erases traversal/relative paths.
        const resumeFiles = files.filter((file): file is string => typeof file === "string").slice(0, MAX_FILES);
        atomicJson(sidecarPath(handoff), { ...saved, resumeFiles });
      } catch { failed(ctx, handoff, "remember"); }
    },
    async persist(ctx: ExtensionContext, handoff: Handoff): Promise<void> {
      try {
        const text = await append(ctx, handoff.text, handoff);
        if (text !== handoff.text) await persistHandoff(handoff, text);
      } catch { failed(ctx, handoff, "persist"); }
    },
  };
}
