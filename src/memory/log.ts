import { appendFileSync, readFileSync, openSync, fchmodSync, fsyncSync, closeSync } from "node:fs";
import type { LocatedRecord } from "./types.ts";

export const EVENT_LINE_BYTES = 8 * 1024;
export const JOURNAL_LINE_BYTES = 72 * 1024;
const checkedFiles = new Set<string>();
const crcTable = Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0xedb88320 : 0);
  return byte >>> 0;
});
export function crc32(body: string): string {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(body)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}
function readBytes(file: string): Buffer {
  try { return readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}
/** One O_APPEND write, including a leading delimiter to isolate any torn tail. */
export function appendRecord(file: string, record: object, maxBytes = EVENT_LINE_BYTES): void {
  const { crc: _ignored, ...body } = record as Record<string, unknown>;
  const json = JSON.stringify({ ...body, crc: crc32(JSON.stringify(body)) });
  if (Buffer.byteLength(json) > maxBytes) throw Error("too_large");
  if (!checkedFiles.has(file)) {
    const bytes = readBytes(file);
    if (bytes.length && bytes[bytes.length - 1] !== 10) console.warn(`memory torn tail: ${file}`);
    checkedFiles.add(file);
  }
  const fd = openSync(file, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    appendFileSync(fd, `\n${json}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
export type LogScan = { records: LocatedRecord[]; tornTail: number; corrupt: number; blank: number };
function decodeLine(line: string, position: number, scan: LogScan): void {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { scan.tornTail++; return; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) { scan.corrupt++; return; }
  const { crc, ...body } = value as Record<string, unknown>;
  if (crc !== crc32(JSON.stringify(body))) { scan.corrupt++; return; }
  scan.records.push({ position, record: body });
}
/** Positions are byte offsets, so replay can be delivered out of order without reordering history. */
export function scanLog(file: string, maxBytes = EVENT_LINE_BYTES): LogScan {
  const bytes = readBytes(file), scan: LogScan = { records: [], tornTail: 0, corrupt: 0, blank: 0 };
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start);
    if (end === -1) { if (bytes.subarray(start).toString().trim()) scan.tornTail++; break; }
    const line = bytes.subarray(start, end).toString("utf8");
    if (!line.trim()) scan.blank++;
    else if (end - start > maxBytes) scan.corrupt++;
    else decodeLine(line, start, scan);
    start = end + 1;
  }
  return scan;
}
