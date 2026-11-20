import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type IdSet } from "./types.ts";

/** Contract 10.0: at most this many ids stay inline; larger sets go to a content-addressed blob. */
export const INLINE_IDS = 32;
export type BlobWriter = (home: string, name: string, text: string) => void;
export type ResolvedIdSet = { count: number; ids: string[] } | { count: number; unresolved: true };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const BLOB_NAME = /^[a-f0-9]{64}\.txt$/;

/** temp + fsync + rename, so a reader never sees a partial blob. Content-addressed, so a rewrite is harmless. */
export const writeBlobFile: BlobWriter = (home, name, text) => {
  const target = join(home, "blobs", name), temp = `${target}.${newId()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); }
  catch (error) { closeSync(fd); unlinkSync(temp); throw error; }
  closeSync(fd);
  try { renameSync(temp, target); }
  catch (error) { unlinkSync(temp); throw error; }
};

/** The blob is written before this returns, so the caller may append the referencing record afterwards. */
export function makeIdSet(home: string, ids: Iterable<string>, writer: BlobWriter = writeBlobFile): IdSet {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length <= INLINE_IDS) return { count: sorted.length, ids: sorted };
  const body = sorted.join("\n"), sha256 = digest(body), blob = `${sha256}.txt`;
  writer(home, blob, body);
  return { count: sorted.length, sha256, blob };
}

/** A missing, corrupt or inconsistent set is `unresolved`: the count is shown, membership is never guessed. */
export function resolveIdSet(home: string, set: IdSet | undefined): ResolvedIdSet {
  const count = typeof set?.count === "number" ? set.count : 0;
  const unresolved = { count, unresolved: true as const };
  if (!set) return unresolved;
  if ("ids" in set) return Array.isArray(set.ids) && set.ids.length === count && set.ids.every(id => typeof id === "string") ? { count, ids: set.ids } : unresolved;
  if (typeof set.blob !== "string" || !BLOB_NAME.test(set.blob) || set.blob !== `${set.sha256}.txt`) return unresolved;
  try {
    const body = readFileSync(join(home, "blobs", set.blob), "utf8");
    const ids = body.split("\n");
    return digest(body) === set.sha256 && ids.length === count ? { count, ids } : unresolved;
  } catch { return unresolved; }
}
