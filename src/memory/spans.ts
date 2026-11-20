import type { ClassifyEvent, FoldedItem, FoldedState, JournalEntry, Span } from "./types.ts";

export type Disposition = { resolved: boolean; uncovered: Span[]; wholeNone?: ClassifyEvent };
type Coverage = { spans: Span[]; wholeNone?: ClassifyEvent };

function insidePair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}
function uncovered(text: string, spans: Span[]): Span[] {
  const result: Span[] = [];
  let cursor = 0;
  function gap(end: number) {
    const part = text.slice(cursor, end), trimmed = part.trim();
    if (trimmed) {
      const start = cursor + part.indexOf(trimmed);
      result.push({ start, end: start + trimmed.length });
    }
  }
  // Round coverage inward: a malformed half-character span must not hide the other half.
  const safe = spans.map(({ start, end }) => ({ start: start + Number(insidePair(text, start)), end: end - Number(insidePair(text, end)) }));
  for (const span of safe.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.end <= span.start) continue;
    if (span.start > cursor) gap(span.start);
    cursor = Math.max(cursor, span.end);
  }
  gap(text.length);
  return result;
}

function directiveCoverage(item: FoldedItem): boolean {
  const isDirective = item.kind === "directive" && item.source.type === "user_message";
  return isDirective && Boolean(item.source.ref && item.source.span);
}
function disposition(entry: JournalEntry, covered?: Coverage): Disposition {
  if (covered?.wholeNone) return { resolved: true, uncovered: [], wholeNone: covered.wholeNone };
  if (entry.text === null) return { resolved: false, uncovered: [] };
  const remainder = uncovered(entry.text, covered?.spans ?? []);
  return { resolved: remainder.length === 0, uncovered: remainder };
}

/** Build once per folded snapshot. Retirement does not undo an already-recorded disposition. */
export function spanResolver(state: FoldedState): (entry: JournalEntry) => Disposition {
  const coverage = new Map<string, Coverage>();
  function forMessage(id: string): Coverage {
    if (!coverage.has(id)) coverage.set(id, { spans: [] });
    return coverage.get(id)!;
  }
  for (const item of Object.values(state.items).filter(directiveCoverage)) {
    forMessage(item.source.ref!).spans.push(item.source.span!);
  }
  for (const event of state.classifications) {
    const covered = forMessage(event.messageId);
    covered.spans.push(...event.spans);
    if (event.whole === "none") covered.wholeNone = event;
  }
  return entry => disposition(entry, coverage.get(entry.id));
}

/** Only accepted folded events confer coverage; raw/rejected events are never consulted. */
export function resolveSpans(entry: JournalEntry, state: FoldedState): Disposition {
  return spanResolver(state)(entry);
}
