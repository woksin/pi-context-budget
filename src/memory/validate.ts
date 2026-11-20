import { isAbsolute } from "node:path";
import type { AddEvent, Authority, ClassifyEvent, FoldedState, FoldOptions, Item, ItemStatus, JournalEntry, MemoryEvent, MessageInput,
  RetireEvent, Source, Span } from "./types.ts";

export class ValidationError extends Error {
  readonly winningEventId?: string;
  constructor(reason: string, winningEventId?: string) {
    super(reason);
    this.winningEventId = winningEventId;
  }
}
export function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ValidationError(reason);
}
export function safeName(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
export function utf8Head(text: string, bytes: number): string {
  let result = "", used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    result += char;
  }
  return result;
}
function validateSession(entry: MessageInput): void {
  requireValid(entry.session, "invalid_session");
  requireValid(safeName(entry.session.id), "invalid_session");
  requireValid(["main", "subagent"].includes(entry.session.role), "invalid_session");
  requireValid(typeof entry.cwd === "string" && isAbsolute(entry.cwd), "invalid_cwd");
}
function validateOrigin(entry: MessageInput): void {
  requireValid(["human", "unattended", "launch", "injected"].includes(entry.origin), "invalid_origin");
  requireValid(Array.isArray(entry.originEvidence), "invalid_origin");
  requireValid(entry.originEvidence.every(value => typeof value === "string"), "invalid_origin");
  if (entry.injectedKind !== undefined) requireValid(["lane_message", "brief", "notice", "reminder", "relaunch", "unknown"].includes(entry.injectedKind), "invalid_origin");
}
function validRedaction(value: { kind: string; count: number }): boolean {
  return typeof value.kind === "string" && Number.isInteger(value.count) && value.count >= 0;
}
function validateBody(entry: MessageInput): void {
  requireValid(Array.isArray(entry.redactions), "invalid_redactions");
  requireValid(entry.redactions.every(validRedaction), "invalid_redactions");
  if (entry.text === null) requireValid(["redactor_failed", "too_large"].includes(entry.withheld!), "invalid_withheld");
  else {
    requireValid(typeof entry.text === "string", "invalid_withheld");
    requireValid(entry.withheld === null, "invalid_withheld");
  }
}
export function validateMessage(entry: MessageInput): void {
  requireValid(safeName(entry.id), "invalid_message");
  requireValid(Number.isFinite(Date.parse(entry.at)), "invalid_message");
  validateSession(entry);
  validateOrigin(entry);
  validateBody(entry);
}
function validateSpan(span: Span | undefined, text: string): asserts span is Span {
  requireValid(span, "invalid_span");
  requireValid(Number.isInteger(span.start) && Number.isInteger(span.end), "invalid_span");
  requireValid(span.start >= 0 && span.end > span.start && span.end <= text.length, "invalid_span");
}
function sourceMessage(source: Source, messages: Map<string, JournalEntry>): JournalEntry {
  const message = messages.get(source.ref!);
  requireValid(message, "no_source");
  return message;
}
const normalise = (text: string) => text.replace(/\s+/gu, " ").trim();
function validateQuote(item: Item, message: JournalEntry): void {
  requireValid(message.text !== null, "no_source");
  validateSpan(item.source.span, message.text);
  const quote = message.text.slice(item.source.span.start, item.source.span.end);
  const expected = Buffer.byteLength(quote) > 4096 ? utf8Head(quote, 1024) : quote;
  requireValid(normalise(item.text) === normalise(expected), "quote_mismatch");
}
function validateAuthority(authority: Authority | undefined): asserts authority is Authority {
  requireValid(authority, "not_authorised");
  requireValid(["none", "auto", "command"].includes(authority.mode), "not_authorised");
  requireValid(Number.isInteger(authority.ruleVersion) && authority.ruleVersion > 0, "not_authorised");
}
function validCommand(item: Item, message: JournalEntry): boolean {
  const authority = item.authority!;
  return authority.ruleVersion === 1 && message.text!.startsWith("/directive ") && item.source.span!.start >= 11 && authority.commandRef === message.id;
}
function autoEligible(item: Item, message: JournalEntry, options: FoldOptions): boolean {
  try { return options.eligibilityCheck?.(message.text!, item.source.span!, item.authority!.ruleVersion).eligible ?? false; }
  catch { return false; }
}
function directiveStatus(item: Item, message: JournalEntry, options: FoldOptions): ItemStatus {
  validateAuthority(item.authority);
  if (message.origin !== "human") return "proposed";
  if (item.authority.mode === "command") return validCommand(item, message) ? "active" : "proposed";
  if (item.authority.mode === "auto") return autoEligible(item, message, options) ? "active" : "proposed";
  return "proposed";
}
function validateSupersedes(item: Item, state: FoldedState, status: ItemStatus): void {
  requireValid(Array.isArray(item.supersedes), "invalid_supersedes");
  requireValid(new Set(item.supersedes).size === item.supersedes.length, "invalid_supersedes");
  for (const id of item.supersedes) {
    const target = state.items[id];
    requireValid(target, "no_source");
    if (target.status !== "active") throw new ValidationError("conflict", target.changedBy);
    if (target.kind === "directive") requireValid(item.kind === "directive", "would_override_user");
    requireValid(status === "active", "not_authorised");
  }
}
function validateScope(item: Item): void {
  requireValid(item.scope, "invalid_scope");
  requireValid(["global", "repo", "lane", "session", "task"].includes(item.scope.kind), "invalid_scope");
  requireValid(typeof item.scope.key === "string" && item.scope.key.length > 0, "invalid_scope");
  if (item.scope.kind === "global") requireValid(item.scope.key === "*", "invalid_scope");
}
function validateItem(item: Item): void {
  requireValid(item && safeName(item.id), "invalid_item");
  requireValid(["directive", "order", "decision"].includes(item.kind), "invalid_item");
  validateScope(item);
  requireValid(typeof item.text === "string" && item.text.length > 0, "invalid_item");
  requireValid(Buffer.byteLength(JSON.stringify(item)) <= 4096, "too_large");
  requireValid(item.source, "no_source");
  requireValid(["user_message", "coordinator_order", "agent_decision"].includes(item.source.type), "no_source");
}
function validateDirective(item: Item, messages: Map<string, JournalEntry>, options: FoldOptions): ItemStatus {
  requireValid(item.source.type === "user_message", "no_source");
  const message = sourceMessage(item.source, messages);
  requireValid(message.origin !== "injected", "not_human");
  validateQuote(item, message);
  return directiveStatus(item, message, options);
}
function validateOrder(item: Item, messages: Map<string, JournalEntry>, options: FoldOptions): void {
  requireValid(item.source.type === "coordinator_order", "no_source");
  const message = sourceMessage(item.source, messages);
  requireValid(message.origin === "injected", "not_authorised");
  requireValid(message.injectedKind === "lane_message", "not_authorised");
  requireValid(options.coordinators?.includes(message.injectedFrom!), "not_authorised");
  validateQuote(item, message);
}
function validateAdd(event: AddEvent, state: FoldedState, messages: Map<string, JournalEntry>, options: FoldOptions): ItemStatus {
  const item = event.item;
  validateItem(item);
  let status: ItemStatus = "active";
  switch (item.kind) {
    case "directive": status = validateDirective(item, messages, options); break;
    case "order": validateOrder(item, messages, options); break;
    case "decision": if (item.source.type !== "agent_decision") sourceMessage(item.source, messages); break;
  }
  validateSupersedes(item, state, status);
  return status;
}
function activeItem(itemId: string, state: FoldedState) {
  const item = state.items[itemId];
  requireValid(item, "no_source");
  if (item.status !== "active") throw new ValidationError("conflict", item.changedBy);
  return item;
}
function validateHumanRetirement(event: RetireEvent, itemAt: string, messages: Map<string, JournalEntry>): void {
  const source = sourceMessage(event.source, messages);
  requireValid(event.source.type === "user_message", "would_override_user");
  requireValid(source.origin === "human", "would_override_user");
  requireValid(Date.parse(source.at) > Date.parse(itemAt), "would_override_user");
}
function validateRetire(event: RetireEvent, state: FoldedState, messages: Map<string, JournalEntry>): void {
  const item = activeItem(event.itemId, state);
  requireValid(["done", "superseded", "withdrawn"].includes(event.status), "invalid_retirement");
  requireValid(typeof event.reason === "string" && event.reason.trim(), "invalid_retirement");
  requireValid(event.source, "no_source");
  requireValid(["user_message", "coordinator_order", "agent_decision", "question_item"].includes(event.source.type), "no_source");
  if (event.source.type !== "agent_decision") sourceMessage(event.source, messages);
  if (item.kind !== "directive") return;
  if (event.status !== "done") validateHumanRetirement(event, item.at, messages);
}
function validateClassificationSpan(span: ClassifyEvent["spans"][number], state: FoldedState, message: JournalEntry): void {
  validateSpan(span, message.text ?? "");
  requireValid(["directive", "decision", "none"].includes(span.result), "invalid_classification");
  requireValid(Array.isArray(span.itemIds), "invalid_classification");
  for (const id of span.itemIds) {
    const item = state.items[id];
    requireValid(item, "no_source");
    requireValid(item.source.ref === message.id && item.kind === span.result, "no_source");
  }
}
function validateWithheldClassification(event: ClassifyEvent): void {
  requireValid(event.whole === "none", "not_authorised");
  requireValid(event.actor.kind === "human", "not_authorised");
  requireValid(event.spans.length === 0, "not_authorised");
}
function validateClassify(event: ClassifyEvent, state: FoldedState, messages: Map<string, JournalEntry>): void {
  const message = messages.get(event.messageId);
  requireValid(message, "no_source");
  requireValid(Array.isArray(event.spans), "invalid_classification");
  requireValid([null, "none"].includes(event.whole), "invalid_classification");
  if (message.text === null) validateWithheldClassification(event);
  if (event.whole === "none") requireValid(typeof event.reason === "string" && event.reason.trim(), "invalid_classification");
  for (const span of event.spans) validateClassificationSpan(span, state, message);
}
function validateEnvelope(event: MemoryEvent): void {
  requireValid(event && event.schema === "memory.event/2", "invalid_event");
  requireValid(safeName(event.id), "invalid_event");
  requireValid(Number.isFinite(Date.parse(event.at)), "invalid_event");
  requireValid(event.actor, "invalid_actor");
  requireValid(["human", "agent", "coordinator", "system"].includes(event.actor.kind), "invalid_actor");
  requireValid(typeof event.actor.id === "string", "invalid_actor");
  requireValid(["pi", "claude-code", "copilot-cli", "direct", "other"].includes(event.actor.harness), "invalid_actor");
}
function validateConfirm(event: MemoryEvent & { type: "confirm" }, state: FoldedState): void {
  requireValid(event.actor.kind === "human" && event.via === "ui", "not_authorised");
  requireValid(state.items[event.itemId]?.status === "proposed", "not_proposed");
}
/** Runtime validation is deliberately repeated for raw, CRC-valid log records. */
export function validateEvent(event: MemoryEvent, state: FoldedState, messages: Map<string, JournalEntry>, options: FoldOptions): ItemStatus | undefined {
  validateEnvelope(event);
  switch (event.type) {
    case "add": return validateAdd(event, state, messages, options);
    case "confirm": validateConfirm(event, state); return;
    case "retire": validateRetire(event, state, messages); return;
    case "classify": validateClassify(event, state, messages); return;
    // Answer persistence and request/boundary operations belong to S3c/S3d.
    // Until then raw records cannot bypass their future fold-time validation.
    default: throw new ValidationError("unsupported_event");
  }
}
