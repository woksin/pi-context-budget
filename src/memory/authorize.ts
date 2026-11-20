import type { EligibilityCheck, Span } from "./types.ts";
import type { Effect, Frame, MachineEvent, MachineState } from "../core.ts";

const RULE_VERSION = 1;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function validSpan(text: string, span: Span): boolean {
  return Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end > span.start && span.end <= text.length;
}
function pasteMiddle(text: string, span: Span): boolean {
  if (bytes(text) <= 4096) return false;
  return bytes(text.slice(0, span.end)) > 1024 && bytes(text.slice(span.start)) > 1024;
}
function structured(line: string): boolean {
  return /^\s*(?:\d{4}-\d\d-\d\d[T ]|\[?\d\d:\d\d:\d\d|at \S+.*\(|[{}\[\]]\s*[,}]?\s*$|[\[{].*[:"]|"[^"\n]+"\s*:)/u.test(line)
    || (line.match(/\b[\w.-]+=[^\s]+/gu)?.length ?? 0) >= 2;
}
type Line = { text: string; start: number; end: number; fenced: boolean; quoted?: boolean };
function lines(text: string): Line[] {
  let fence: string | undefined;
  return Array.from(text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu), match => {
    const line = match[0].replace(/[\r\n]+$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u.exec(line);
    const fenced = fence !== undefined || marker !== null;
    if (marker) fence = fence === undefined ? marker[1] : closeFence(fence, marker);
    return { text: line, start: match.index!, end: match.index! + match[0].length, fenced };
  });
}
function closeFence(open: string, marker: RegExpExecArray): string | undefined {
  if (!/^[\t \r]*$/u.test(marker[2])) return open;
  return marker[1][0] === open[0] && marker[1].length >= open.length ? undefined : open;
}
function containerContent(row: Pick<Line, "text">): string {
  return row.text.replace(/^(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t](?:\[[ xX]\][ \t])?)+/u, "");
}
function markQuoted(rows: Line[]): Line[] {
  let quoted = false;
  return rows.map(row => {
    const content = containerContent(row);
    if (/^[\t \r]*$/u.test(content)) quoted = false;
    if (/^ {0,3}>/u.test(content)) quoted = true;
    return { ...row, quoted };
  });
}
function codeOrQuote(row: Line): boolean {
  return row.fenced || row.quoted === true || /^(?: {4}| {0,3}\t)/u.test(containerContent(row));
}
function codeClosers(markers: RegExpMatchArray[]): (number | undefined)[][] {
  const closers: (number | undefined)[][] = [[], []], seen: (number | undefined)[] = [];
  // The whole-message rule has already excluded runs of three or more backticks.
  for (let i = markers.length - 1; i >= 0; i--) {
    closers[0][i] = seen[0]; closers[1][i] = seen[1];
    seen[markers[i][0].length - 1] = i;
  }
  return closers;
}
function escapedMarker(input: { text: string; marker: RegExpMatchArray }): boolean {
  let start = input.marker.index! - 1;
  while (input.text[start] === "\\") start--;
  return (input.marker.index! - 1 - start) % 2 === 1;
}
function inlineCode(input: { text: string; span: Span }): boolean {
  const markers = [...input.text.matchAll(/`+/gu)], closers = codeClosers(markers);
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i], width = marker[0].length - Number(escapedMarker({ text: input.text, marker }));
    if (width === 0) continue;
    const close = closers[width - 1][i];
    if (close === undefined) continue;
    if (input.span.start < markers[close].index! + width && input.span.end > marker.index!) return true;
    i = close;
  }
  return false;
}
function unsafeLine(rows: Line[], index: number): boolean {
  const row = rows[index];
  if (codeOrQuote(row)) return true;
  const neighbors = rows.slice(Math.max(0, index - 2), index + 3).filter(line => line.text.trim());
  return neighbors.filter(line => structured(line.text)).length >= Math.ceil(neighbors.length / 2);
}
function unsafeSpan(rows: Line[], span: Span): boolean {
  return rows.some((line, i) => line.start < span.end && line.end > span.start && unsafeLine(rows, i));
}
function structurallyEligible(text: string, span: Span): boolean {
  if (!validSpan(text, span)) return false;
  if (/`{3,}|~{3,}|<(?:pre|code)/iu.test(text)) return false;
  if (span.end - span.start > 600 || pasteMiddle(text, span)) return false;
  if (inlineCode({ text, span })) return false;
  // HTML quotation contents can continue across blank lines; conservatively keep their remaining context quoted.
  if (/<(?:blockquote|q)\b/iu.test(text.slice(0, span.end))) return false;
  return !unsafeSpan(markQuoted(lines(text)), span);
}
/** Versioned, origin-independent predicate. The store separately requires a human journal origin. */
export const eligibilityCheck: EligibilityCheck = (text, span, ruleVersion) => ({
  eligible: ruleVersion === RULE_VERSION && structurallyEligible(text, span), reasons: [],
});

const RECOVERY_TOOLS = new Set(["memory_add", "memory_retire", "memory_classify", "memory_list", "recall"]);
export type RecoveryWindow = { used: number; calls: string[] };
function windowEvent(event: MachineEvent): boolean {
  return event.type === "session_compact";
}
function recoveryCall(state: MachineState, id: string): Effect[] {
  const window = state.memoryRecovery ?? { used: 0, calls: [] };
  if (window.used >= 12) {
    state.blockedCalls.push(id);
    return [{ type: "block", reason: "Memory recovery limit reached. Call context_handoff now, then end this turn." }];
  }
  state.memoryRecovery = { used: window.used + 1, calls: [...window.calls, id] };
  return [];
}
function finishRecovery(state: MachineState, event: MachineEvent): boolean {
  if (event.type !== "tool_end") return false;
  const window = state.memoryRecovery;
  if (!window?.calls.includes(event.id)) return false;
  state.memoryRecovery = { ...window, calls: window.calls.filter(id => id !== event.id) };
  return true;
}
function recoveryTool(event: MachineEvent, frame: Frame): event is Extract<MachineEvent, { type: "tool_call" }> {
  if (!frame.memoryIntent || event.type !== "tool_call") return false;
  return RECOVERY_TOOLS.has(event.tool);
}
/** undefined delegates to the unchanged FSM. An empty effect list means an exempt call. */
export function memoryRecovery(state: MachineState, event: MachineEvent, frame: Frame, required: boolean): Effect[] | undefined {
  if (windowEvent(event)) delete state.memoryRecovery;
  if (finishRecovery(state, event)) return frame.memoryIntent ? [] : undefined;
  if (!recoveryTool(event, frame)) return;
  if (state.pending || required) return recoveryCall(state, event.id);
  delete state.memoryRecovery;
}
export function recoverySteer(input: { text: string; enabled: boolean; idleOnly?: boolean }): string {
  return input.enabled && !input.idleOnly ? `${input.text} Before context_handoff, classify unresolved messages with memory_classify (up to 12 memory recovery calls).` : input.text;
}
