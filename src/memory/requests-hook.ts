import { flagOn, memoryOff, readMemoryConfig, type MemoryConfig } from "./config.ts";
import { appendAnswer, newAnswerId, pickLastAnswer, redactAnswer, type AnswerBody, type AnswerKind, type AnswerParts, type AnswerRecord } from "./answers.ts";
import { appendEvent, buildBoundary, type BoundaryKind } from "./boundary.ts";
import { makeIdSet, type BlobWriter } from "./idset.ts";
import { loadScanner, type Scanner } from "./redact.ts";
import { answersBytes, closeEvent, isRequest, readSessionState } from "./requests.ts";
import { newId, type JournalEntry } from "./types.ts";
import type { HostFacts } from "./journal-hook.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileMemoryStore } from "./store.ts";

/** Contract 10.7: past this many bytes in one session file new interim answers are dropped; finals are always kept. */
export const SESSION_CAP_BYTES = 50 * 1024 * 1024;
const HELD_LIMIT = 100;
type HookContext = { cwd: string; sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getSessionName?(): string | undefined } };
type AssistantMessage = { role?: string; content?: unknown; stopReason?: string; model?: string };
export type RequestsHookDeps = { agentDir: string; configFile: string; host: () => HostFacts | undefined; blobWriter?: BlobWriter; capBytes?: number;
  log: (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void };
/** One assistant message as kept in process memory: it survives a failed write so a handoff can still carry it. */
export type RunAnswer = { id: string; kind: AnswerKind; textBytes: number; stopReason: string; parts: Omit<AnswerParts, "requests">;
  ids: string[]; body: AnswerBody; humanSeq: number; written: boolean; dropped: boolean };
export type CompactionHint = { kind: BoundaryKind; handoffPath?: string };
export type Carried = { open: string[]; lastAnswer?: RunAnswer & { sameRunAsAnswer: boolean }; degraded?: string };

const brief = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 200);
const blocks = (message: AssistantMessage): { type?: string; text?: string }[] => Array.isArray(message.content) ? message.content : [];
const textOf = (message: AssistantMessage): string => typeof message.content === "string" ? message.content :
  blocks(message).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
const hasToolCall = (message: AssistantMessage): boolean => blocks(message).some(block => block.type === "toolCall");

/** Inert unless `memory.requests` (and so `memory.journal`) is on for this session at call time. Never throws into pi. */
export function createRequestsHook(deps: RequestsHookDeps) {
  let memory: MemoryConfig = memoryOff(), store: Promise<FileMemoryStore> | undefined, scanner: Promise<Scanner | undefined> | undefined;
  let loadedFor: string | undefined, open = new Set<string>(), compactions = new Set<string>();
  let answers: RunAnswer[] = [], capture: string[] | undefined, expected: CompactionHint | undefined;
  let runId = newId(), turn = 0, humanSeq = 0, degraded: string | undefined;
  const reported = new Set<string>();
  const home = async () => (await (store ??= import("./store.ts").then(({ FileMemoryStore }) => new FileMemoryStore({ agentDir: deps.agentDir })))).home;
  const scanners = () => scanner ??= loadScanner(deps.agentDir);
  const enabled = (ctx: HookContext) => !deps.host()?.subagent && flagOn(memory, ctx.sessionManager.getSessionName?.(), "requests");
  const session = (ctx: HookContext) => ({ id: ctx.sessionManager.getSessionId(), role: "main" as const, file: ctx.sessionManager.getSessionFile?.() });

  /** Loud but non-blocking (contract 10.6): the event log gets one record per failure kind, the next render one line. */
  function degrade(ctx: HookContext, what: string, error: unknown): void {
    degraded = what;
    if (reported.has(what)) return;
    reported.add(what);
    try { deps.log(ctx as ExtensionContext, "memory_degraded", { what, error: brief(error) }); } catch { /* Logging must not escape. */ }
  }
  /** Files are the source of truth; a restarted process rebuilds its open set from them. */
  async function load(ctx: HookContext): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    if (loadedFor === id) return;
    const state = readSessionState(await home(), id);
    open = new Set(state.open.map(request => request.id));
    compactions = new Set(state.boundaries.flatMap(b => b.event.compactionEntryId ? [b.event.compactionEntryId] : []));
    humanSeq = 0; loadedFor = id;
  }
  async function persist(ctx: HookContext, answer: RunAnswer): Promise<boolean> {
    if (answer.written) return true;
    try {
      const dir = await home();
      appendAnswer(dir, answer.id, { ...answer.parts, requests: makeIdSet(dir, answer.ids, deps.blobWriter) }, answer.body, deps.blobWriter);
      answer.written = true;
    } catch (error) { degrade(ctx, "answer_write", error); }
    return answer.written;
  }
  /** Closure strictly follows a durable final answer with stopReason stop; a failure leaves the request open. */
  async function closeAnswered(ctx: HookContext, answer: RunAnswer): Promise<void> {
    if (answer.kind !== "final" || answer.stopReason !== "stop" || !answer.written) return;
    for (const id of answer.ids.filter(id => open.has(id))) {
      try { appendEvent(await home(), closeEvent(id, answer.id)); open.delete(id); }
      catch (error) { degrade(ctx, "request_close_write", error); return; }
    }
  }
  /** Keep the three candidates of the last-answer rule plus unwritten ones (bounded); everything else is on disk. */
  function keep(): void {
    const candidates = new Set([pickLastAnswer(answers), pickLastAnswer(answers.filter(a => a.kind === "final")), pickLastAnswer(answers.filter(a => a.kind === "interim"))]);
    const unwritten = answers.filter(a => !a.written && !a.dropped).slice(-HELD_LIMIT);
    answers = answers.filter(a => candidates.has(a) || unwritten.includes(a));
  }
  async function captureAnswer(message: AssistantMessage, ctx: HookContext): Promise<void> {
    const text = textOf(message), ids = capture ?? [];
    capture = undefined; turn++;
    if (!text.trim()) return;
    const body = redactAnswer(text, await scanners()), kind: AnswerKind = hasToolCall(message) ? "interim" : "final";
    const answer: RunAnswer = { id: newAnswerId(), kind, textBytes: Buffer.byteLength(body.text ?? ""), stopReason: message.stopReason ?? "unknown", ids, body,
      parts: { session: session(ctx), runId, kind, model: message.model, stopReason: message.stopReason ?? "unknown", turn }, humanSeq, written: false, dropped: false };
    answers.push(answer);
    if (kind === "interim" && memory.answers !== "all") { keep(); return; }
    if (kind === "interim" && answersBytes(await home(), answer.parts.session.id) > (deps.capBytes ?? SESSION_CAP_BYTES)) answer.dropped = true;
    else if (await persist(ctx, answer)) await closeAnswered(ctx, answer);
    keep();
  }
  async function boundary(ctx: HookContext, kind: BoundaryKind, extra: { compactionEntryId?: string; handoffPath?: string } = {}): Promise<void> {
    if (!enabled(ctx)) return;
    await load(ctx);
    if (extra.compactionEntryId && compactions.has(extra.compactionEntryId)) return;
    for (const answer of answers.filter(a => !a.written && !a.dropped)) await persist(ctx, answer);
    const last = pickLastAnswer(answers), durable = last?.written ? last : undefined, dir = await home();
    // A record is never written for an answer that is not on disk; the in-memory copy still serves the handoff.
    appendEvent(dir, buildBoundary(dir, { session: session(ctx), runId, kind, open: [...open], lastAnswerId: durable?.id,
      sameRunAsAnswer: !!durable && durable.humanSeq === humanSeq, ...extra }, deps.blobWriter));
    if (extra.compactionEntryId) compactions.add(extra.compactionEntryId);
  }
  const guarded = async (ctx: HookContext, what: string, action: () => Promise<void>): Promise<void> => {
    try { if (enabled(ctx)) await action(); } catch (error) { degrade(ctx, what, error); }
  };
  const compactionKind = (reason: string | undefined, packageInFlight: boolean): BoundaryKind => {
    if (reason === "overflow") return packageInFlight ? "overflow_package" : "overflow_native";
    return reason === "manual" ? (packageInFlight ? "overflow_package" : "manual") : "emergency";
  };
  return {
    reload(): void { memory = readMemoryConfig(deps.configFile).config; },
    reset(): void { loadedFor = undefined; open = new Set(); compactions = new Set(); answers = []; capture = undefined; expected = undefined; humanSeq = 0; degraded = undefined; reported.clear(); },
    onJournaled: (entry: JournalEntry, ctx: HookContext) => guarded(ctx, "request_open", async () => {
      if (!isRequest(entry)) return;
      await load(ctx);
      open.add(entry.id); humanSeq++;
    }),
    agentStart(): void { runId = newId(); turn = 0; answers = []; capture = undefined; expected = undefined; },
    messageStart: (message: AssistantMessage, ctx: HookContext) => guarded(ctx, "answer_capture", async () => {
      if (message?.role !== "assistant") return;
      await load(ctx);
      capture = [...open];
    }),
    /** Awaited by the runtime before the message is persisted and before turn_end, so no boundary effect can run first. */
    messageEnd: (message: AssistantMessage, ctx: HookContext) => guarded(ctx, "answer_capture", async () => {
      if (message?.role === "assistant") await captureAnswer(message, ctx);
    }),
    commit: (ctx: HookContext, handoffPath: string | undefined, idle: boolean) =>
      guarded(ctx, "boundary_write", () => boundary(ctx, idle ? "idle" : "handoff", { handoffPath })),
    expectBackstop(hint: CompactionHint): void { expected = hint; },
    compactionFailed(): void { expected = undefined; },
    compacted: (event: { compactionEntry?: { id?: string }; reason?: string }, ctx: HookContext, packageInFlight: boolean) => guarded(ctx, "boundary_write", async () => {
      const hint = expected; expected = undefined;
      await boundary(ctx, hint?.kind ?? compactionKind(event.reason, packageInFlight), { compactionEntryId: event.compactionEntry?.id, handoffPath: hint?.handoffPath });
    }),
    settled: (aborted: boolean, ctx: HookContext) => guarded(ctx, "boundary_write", async () => { if (aborted && open.size) await boundary(ctx, "abort"); }),
    /** What a handoff must still carry, from process memory (valid even when the files could not be written). */
    carried(): Carried {
      const last = pickLastAnswer(answers);
      return { open: [...open], degraded, ...(last ? { lastAnswer: { ...last, sameRunAsAnswer: last.humanSeq === humanSeq } } : {}) };
    },
  };
}
export type RequestsHook = ReturnType<typeof createRequestsHook>;
export type { AnswerRecord };
