import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import { canonicalRemote } from "./handoff-scopes.ts";
import type { FoldedItem, Scope } from "./types.ts";

export const QUESTION_LIMITS = Object.freeze({ files: 128, bytes: 64 * 1024, entries: 4096 });
type Counts = { read: number; ignored: number; malformed: number; unknown: number; limited: number };
type Repository = { root: string; remote?: string };
type Options = { agentDir: string; repo?: Repository; env?: Record<string, string | undefined> };
type Question = { id: string; title: string; body: string; repo: string | null; status: string;
  updatedAt: string; history: unknown[]; options?: { key: string; text: string }[]; answer?: { text: string; option?: string } };
const statuses = ["open", "answered", "decided", "deferred", "withdrawn", "superseded", "closed"];

/** Enumeration is bounded too. Never use a partial revision listing to select stale history. */
function entries(path: string, counts: Counts) {
  const directory = opendirSync(path), found = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (found.length === QUESTION_LIMITS.entries) { counts.limited++; return []; }
      found.push(entry);
    }
    return found.sort((a, b) => a.name < b.name ? -1 : Number(a.name > b.name));
  } finally { directory.closeSync(); }
}
function inside({ root, path }: { root: string; path: string }): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function latest({ root, id, counts }: { root: string; id: string; counts: Counts }): string | undefined {
  const directory = realpathSync(join(root, id));
  if (!inside({ root, path: directory })) { counts.ignored++; return undefined; }
  const revisions = entries(directory, counts).filter(entry => /^r\d{8,}\.json$/.test(entry.name))
    .sort((a, b) => Number(BigInt(b.name.slice(1, -5)) - BigInt(a.name.slice(1, -5))));
  const top = revisions[0];
  if (!top || !top.isFile()) { counts.ignored++; return undefined; }
  return join(directory, top.name);
}

/** O_RDONLY, no symlink following, no unbounded readFile allocation, and no writes of any kind. */
function readRevision({ path, counts }: { path: string; counts: Counts }): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) { counts.ignored++; return undefined; }
    if (stat.size > QUESTION_LIMITS.bytes) { counts.limited++; return undefined; }
    const buffer = Buffer.alloc(QUESTION_LIMITS.bytes);
    let size = 0, n = 0;
    do {
      n = readSync(fd, buffer, size, buffer.length - size, null);
      size += n;
    } while (n && size < buffer.length);
    if (fstatSync(fd).size > QUESTION_LIMITS.bytes) { counts.limited++; return undefined; }
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { closeSync(fd); }
}
function questionText(item: Question): boolean {
  return [item.title, item.body].every(value => typeof value === "string") && !!item.title;
}
function questionMetadata(item: Question): boolean {
  const repoKnown = item.repo === null || typeof item.repo === "string" && !!item.repo;
  const dated = typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
  return repoKnown && dated && Array.isArray(item.history) && statuses.includes(item.status);
}
function selectedOption(item: Question) {
  if (!Array.isArray(item.options)) return undefined;
  return item.options.find(option => option?.key === item.answer?.option && typeof option.text === "string");
}
function questionAnswer(item: Question): boolean {
  if (item.status !== "decided") return true;
  if (typeof item.answer?.text !== "string") return false;
  if (item.answer.option === undefined) return true;
  return typeof item.answer.option === "string" && !!selectedOption(item);
}
function question(candidate: { value: unknown; id: string }): boolean {
  const { value, id } = candidate;
  if (!value || typeof value !== "object") return false;
  const item = value as Question;
  return item.id === id && questionText(item) && questionMetadata(item) && questionAnswer(item);
}
function repoMatches({ recorded, repo, remote }: { recorded: string; repo: Repository; remote?: string }): boolean {
  // pi-questions stores the last two origin path components, or the root basename without an origin.
  if (!remote) return [repo.root, basename(repo.root)].includes(recorded);
  const name = remote.split("/").filter(Boolean).slice(-2).join("/");
  return [repo.root, name, remote].includes(recorded) || canonicalRemote(recorded) === remote;
}
function questionScope({ recorded, repo }: { recorded: string | null; repo?: Repository }): Scope {
  if (recorded === null) return { kind: "global", key: "*" };
  const remote = canonicalRemote(repo?.remote);
  if (repo && repoMatches({ recorded, repo, remote })) return { kind: "repo", key: remote ?? repo.root };
  return { kind: "repo", key: recorded };
}
function answerText(item: Question): string[] {
  const answer = item.answer!;
  if (answer.option === undefined) return [answer.text];
  return [`${answer.option}: ${selectedOption(item)!.text}`, answer.text];
}
function projected(item: Question, repo?: Repository): FoldedItem {
  const id = `question_item:${item.id}`;
  return { id, kind: "decision", scope: questionScope({ recorded: item.repo, repo }),
    text: [item.title, item.body, ...answerText(item)].join("\n"), source: { type: "question_item", ref: item.id },
    supersedes: [], status: "active", at: item.updatedAt, eventId: id, changedBy: id };
}
function readItem({ root, id, options, counts }: { root: string; id: string; options: Options; counts: Counts }): FoldedItem | undefined {
  try {
    const file = latest({ root, id, counts });
    if (!file) return undefined;
    counts.read++;
    const value = readRevision({ path: file, counts });
    if (value === undefined) return undefined;
    if (!question({ value, id })) { counts.unknown++; return undefined; }
    const item = value as Question;
    if (item.status !== "decided") { counts.ignored++; return undefined; }
    return projected(item, options.repo);
  } catch { counts.malformed++; return undefined; }
}

function itemEntries(root: string, counts: Counts) {
  return entries(root, counts).filter(entry => {
    const valid = entry.isDirectory() && /^Q-\d+$/.test(entry.name);
    if (!valid) counts.ignored++;
    return valid;
  }).sort((a, b) => Number(BigInt(b.name.slice(2)) - BigInt(a.name.slice(2))));
}
function collectItems(root: string, options: Options, counts: Counts): FoldedItem[] {
  const items: FoldedItem[] = [];
  for (const entry of itemEntries(root, counts)) {
    if (counts.read >= QUESTION_LIMITS.files) { counts.limited++; break; }
    const item = readItem({ root, id: entry.name, options, counts });
    if (item) items.push(item);
  }
  return items;
}

/** Minimal tolerant adapter for pi-questions' immutable items/Q-n/r########.json store. */
export function readQuestionItems(options: Options): { items: FoldedItem[]; counts: Counts } {
  const counts: Counts = { read: 0, ignored: 0, malformed: 0, unknown: 0, limited: 0 };
  try {
    const env = options.env ?? process.env, home = env.PI_QUESTIONS_HOME || join(options.agentDir, "user-questions");
    const path = join(home, "items");
    if (!lstatSync(path).isDirectory()) { counts.ignored++; return { items: [], counts }; }
    return { items: collectItems(realpathSync(path), options, counts), counts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") counts.malformed++;
    return { items: [], counts };
  }
}
