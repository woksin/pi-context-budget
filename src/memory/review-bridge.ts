import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WriteResult } from "./types.ts";

const PREFIX = "context-budget:memory-review/v1:";
const MAX_REQUESTS = 1024;
const RECEIPT_GRACE_MS = 60_000;
export type ReviewRequest = { requestId: string; itemId: string; action: "confirm" | "reject";
  sessionId: string; generation: string; expiresAt: number };
export type ReviewReason = "applied" | "conflict" | "rejected" | "unavailable" | "unsupported_version" | "invalid_request"
  | "wrong_target" | "handoff" | "no_source" | "not_proposed" | "not_human" | "expired" | "cancelled" | "duplicate"
  | "busy" | "refused" | "stale";
export class ReviewFailure extends Error {
  readonly reason: ReviewReason;
  constructor(reason: ReviewReason) { super(reason); this.reason = reason; }
}
export interface ReviewProvider {
  readiness(): { storeId: string; sessionId?: string; generation?: string; available: boolean; reason?: ReviewReason };
  review(request: ReviewRequest, check: () => void, signal: AbortSignal, committed: (write: WriteResult) => void): Promise<WriteResult>;
  record?(result: Record<string, unknown>): void;
}
type Result = { version: 1; requestId: string; reason: ReviewReason } & Partial<ReviewRequest & WriteResult>;
type Claim = { retainUntil: number; request?: ReviewRequest; result?: Result; invalid?: ReviewReason; controller?: AbortController };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[\w-]{1,128}$/u.test(value); }
function parseRequest(value: Record<string, unknown>): ReviewRequest | undefined {
  if (!exact(value, ["requestId", "itemId", "action", "sessionId", "generation", "expiresAt"])) return;
  if (![value.requestId, value.itemId, value.sessionId, value.generation].every(identifier)) return;
  if (value.action !== "confirm" && value.action !== "reject") return;
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) < 0) return;
  return { requestId: String(value.requestId), itemId: String(value.itemId), action: value.action,
    sessionId: String(value.sessionId), generation: String(value.generation), expiresAt: Number(value.expiresAt) };
}
function identity(request: ReviewRequest): Partial<ReviewRequest> {
  const { requestId, itemId, action, sessionId, generation } = request;
  return { requestId, itemId, action, sessionId, generation };
}

function checkPending(claim: Claim): void {
  if (Date.now() >= claim.request!.expiresAt) throw new ReviewFailure("expired");
  if (claim.invalid) throw new ReviewFailure(claim.invalid);
}

/** Internal bus wiring only: no bus-supplied contexts, UI objects, actors or store paths. */
export function registerReviewBridge(pi: ExtensionAPI, provider: ReviewProvider): (reason: ReviewReason) => void {
  if (!pi.events?.on) return () => {};
  const claims = new Map<string, Claim>();
  let active: Claim | undefined;
  function prune(): void {
    const now = Date.now();
    for (const [id, claim] of claims) if (claim !== active && claim.retainUntil <= now) claims.delete(id);
  }
  function release(claim: Claim): void { if (active === claim) active = undefined; }
  const emit = (result: Result) => { pi.events.emit(PREFIX + "result", result); };
  function finish(claim: Claim, reason: ReviewReason, write?: WriteResult): void {
    if (claim.result || !claim.request) return;
    const result: Result = { version: 1, ...identity(claim.request), requestId: claim.request.requestId, reason };
    if (write) Object.assign(result, { ok: write.ok, status: write.status, eventId: write.eventId,
      ...(write.winningEventId ? { winningEventId: write.winningEventId } : {}) });
    claim.retainUntil = Math.max(claim.request.expiresAt, Date.now()) + RECEIPT_GRACE_MS;
    claim.result = Object.freeze(result);
    try { provider.record?.(result); } catch { /* Receipts are advisory, never authority. */ }
    emit(result);
  }
  function invalidate(claim: Claim, reason: ReviewReason): void {
    if (claim.result) return;
    claim.invalid = reason; finish(claim, reason); claim.controller?.abort();
  }
  async function perform(claim: Claim): Promise<void> {
    const request = claim.request!;
    const remaining = request.expiresAt - Date.now();
    const timer = setTimeout(() => invalidate(claim, remaining <= 30_000 ? "expired" : "refused"), Math.max(0, Math.min(remaining, 30_000)));
    const check = () => checkPending(claim);
    const committed = (write: WriteResult) => {
      release(claim);
      finish(claim, write.status, write);
    };
    try {
      check();
      const write = await provider.review(request, check, claim.controller!.signal, committed);
      finish(claim, write.status, write);
    } catch (error) { finish(claim, error instanceof ReviewFailure ? error.reason : "unavailable"); }
    finally { clearTimeout(timer); release(claim); }
  }
  pi.events.on(PREFIX + "probe", raw => {
    const probe = record(raw), supported = exact(probe, ["version"]) && probe.version === 1;
    pi.events.emit(PREFIX + "readiness", { ...provider.readiness(), version: 1,
      ...(!supported ? { available: false, reason: "unsupported_version" } : {}) });
  });
  pi.events.on(PREFIX + "cancel", raw => {
    const input = record(raw);
    if (!exact(input, ["requestId"]) || !identifier(input.requestId)) return;
    prune();
    const claim = claims.get(input.requestId);
    if (claim) invalidate(claim, "cancelled");
    else if (claims.size < MAX_REQUESTS) claims.set(input.requestId, { invalid: "cancelled", retainUntil: Date.now() + RECEIPT_GRACE_MS });
  });
  pi.events.on(PREFIX + "request", raw => {
    const input = record(raw);
    if (!identifier(input.requestId)) return;
    const request = parseRequest(input);
    if (!request) { emit({ version: 1, requestId: input.requestId, reason: "invalid_request" }); return; }
    prune();
    const known = claims.get(request.requestId);
    if (known) {
      if (known.result) emit(known.result);
      else if (known.invalid) { known.request = request; finish(known, known.invalid); }
      else emit({ version: 1, ...identity(request), requestId: request.requestId, reason: "duplicate" });
      return;
    }
    if (claims.size >= MAX_REQUESTS) { emit({ version: 1, requestId: request.requestId, reason: "unavailable" }); return; }
    const claim: Claim = { request, controller: new AbortController(), retainUntil: request.expiresAt + RECEIPT_GRACE_MS };
    if (active) { finish(claim, "busy"); return; }
    claims.set(request.requestId, claim); active = claim; void perform(claim);
  });
  return reason => { if (active) invalidate(active, reason); };
}
