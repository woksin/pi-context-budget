import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpans } from "../src/memory/spans.ts";
import { foldEvents } from "../src/memory/fold.ts";
import { message, directive, agent } from "./memory-conformance.ts";
import type { JournalEntry } from "../src/memory/types.ts";
function entry(text: string | null): JournalEntry {
  return { ...message({ text, withheld: text === null ? "too_large" : null }), schema: "memory.journal/2", textBytes: 0, sha256: "" };
}
test("union of overlapping spans and whitespace resolves; gaps replay verbatim", () => {
  const source = entry("  first second  "), state = foldEvents([], []);
  const item = directive(source, { text: "first", source: { type: "user_message", ref: source.id, span: { start: 2, end: 7 } } });
  state.items[item.id] = { ...item, status: "done", at: "2026", eventId: "add", changedBy: "add" };
  assert.deepEqual(resolveSpans(source, state).uncovered, [{ start: 8, end: 14 }]);
  state.classifications.push({ schema: "memory.event/2", id: "classify", at: "2026", actor: agent,
    type: "classify", messageId: source.id, whole: null, spans: [{ start: 6, end: 14, result: "none", itemIds: [] }] });
  assert.equal(resolveSpans(source, state).resolved, true);
  assert.equal(resolveSpans(entry(" \n\t"), state).resolved, true);
  assert.equal(resolveSpans(entry(null), state).resolved, false);
});
test("classification boundary inside a surrogate pair never replays half a code point", () => {
  const source = entry("😀x"), state = foldEvents([], []);
  state.classifications.push({ schema: "memory.event/2", id: "classify", at: "2026", actor: agent,
    type: "classify", messageId: source.id, whole: null, spans: [{ start: 0, end: 1, result: "none", itemIds: [] }] });
  const result = resolveSpans(source, state);
  const remainder = result.uncovered.map(span => source.text!.slice(span.start, span.end)).join("");
  assert.equal(Buffer.from(remainder).toString("utf8"), remainder);
});
