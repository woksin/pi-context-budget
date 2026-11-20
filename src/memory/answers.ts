import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, EVENT_LINE_BYTES, scanLog } from "./log.ts";
import { resolveIdSet, writeBlobFile, type BlobWriter, type ResolvedIdSet } from "./idset.ts";
import { redact, type Scanner } from "./redact.ts";
import { newId, type BlobRef, type IdSet, type Session } from "./types.ts";
import { safeName, utf8Head } from "./validate.ts";

export const ANSWER_INLINE_BYTES = EVENT_LINE_BYTES - 1;
const recordBytes = (record: AnswerRecord) => Buffer.byteLength(JSON.stringify({ ...record, crc: "00000000" }));
/** Contract 10.2: the last answer prefers a final of at least this many bytes. */
export const SUBSTANTIVE_BYTES = 256;
export type AnswerKind = "final" | "interim";
export type AnswerRecord = {
  schema: "memory.answer/2"; id: string; at: string; session: Session; runId: string; requests: IdSet; kind: AnswerKind;
  model?: string; stopReason: string; turn: number; text: string | null; withheld: "redactor_failed" | "too_large" | "write_failed" | null;
  textBytes: number; sha256: string; blob?: BlobRef; redactions: { kind: string; count: number }[];
};
/** Redacted body of one assistant message, built once and written (or retried) later. */
export type AnswerBody = Pick<AnswerRecord, "text" | "withheld" | "redactions">;

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const answerFile = (home: string, sessionId: string) => join(home, "answers", `${sessionId}.jsonl`);
export const redactAnswer = (text: string, scanner?: Scanner): AnswerBody => redact(text, scanner);
const tail = (text: string, bytes: number) => [...utf8Head([...text].reverse().join(""), bytes)].reverse().join("");

const fitsInline = (record: AnswerRecord) => recordBytes(record) <= ANSWER_INLINE_BYTES;
function fitPreview(record: AnswerRecord): void {
  const text = record.text ?? "";
  record.blob = { sha256: record.sha256, bytes: record.textBytes };
  record.text = `${utf8Head(text, 2048)}\n…\n${tail(text, 1024)}`;
  // Escaped preview bytes count too; metadata alone that cannot fit fails without a referencing record.
  if (!fitsInline(record)) record.text = "";
  if (!fitsInline(record)) throw Error("too_large");
}
export type AnswerParts = { session: Session; runId: string; requests: IdSet; kind: AnswerKind; model?: string; stopReason: string; turn: number };
/** Large bodies keep head and tail inline; the whole redacted body goes to a blob written before the record. */
export function appendAnswer(home: string, id: string, parts: AnswerParts, body: AnswerBody, writer: BlobWriter = writeBlobFile): AnswerRecord {
  const text = body.text ?? "", textBytes = Buffer.byteLength(text);
  const record: AnswerRecord = { schema: "memory.answer/2", id, at: new Date().toISOString(), ...parts, ...body, textBytes, sha256: digest(text) };
  if (!fitsInline(record)) {
    fitPreview(record);
    writer(home, `${record.sha256}.txt`, text);
  }
  appendRecord(answerFile(home, parts.session.id), record, ANSWER_INLINE_BYTES);
  return record;
}
export const newAnswerId = newId;

function hydrate(home: string, record: AnswerRecord): AnswerRecord {
  if (!record.blob) return record;
  try {
    const text = readFileSync(join(home, "blobs", `${record.blob.sha256}.txt`), "utf8");
    return digest(text) === record.blob.sha256 ? { ...record, text } : { ...record, text: null, withheld: "too_large" };
  } catch { return { ...record, text: null, withheld: "too_large" }; }
}
const wellFormed = (record: AnswerRecord): boolean => record.schema === "memory.answer/2" && safeName(record.id) &&
  (record.kind === "final" || record.kind === "interim") && typeof record.stopReason === "string" && typeof record.runId === "string";

/** Reader contract: skip unparsable/crc-bad lines, dedup by id, never write. A missing session file is an empty log. */
export function readAnswers(home: string, sessionId: string): AnswerRecord[] {
  if (!safeName(sessionId)) return [];
  const seen = new Set<string>(), answers: AnswerRecord[] = [];
  for (const { record } of scanLog(answerFile(home, sessionId), ANSWER_INLINE_BYTES).records) {
    const answer = record as AnswerRecord;
    if (!wellFormed(answer) || seen.has(answer.id)) continue;
    seen.add(answer.id);
    answers.push(hydrate(home, answer));
  }
  return answers;
}
export const answerRequestIds = (home: string, answer: AnswerRecord): ResolvedIdSet => resolveIdSet(home, answer.requests);

type Ranked = { kind: AnswerKind; textBytes: number };
/** Contract 10.2: latest substantive final, else latest final, else latest interim. Input is in write order. */
export function pickLastAnswer<T extends Ranked>(answers: readonly T[]): T | undefined {
  const latest = (match: (a: T) => boolean) => [...answers].reverse().find(match);
  return latest(a => a.kind === "final" && a.textBytes >= SUBSTANTIVE_BYTES) ?? latest(a => a.kind === "final") ?? latest(a => a.kind === "interim");
}
