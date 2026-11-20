import type { JournalEntry } from "./types.ts";
import { scannerPass, type Counts, type Scanner } from "./scanner.ts";

export { loadScanner, type Scanner } from "./scanner.ts";
/** Same cap as the shared scanner (MAX_BYTES); larger text is withheld rather than scanned in parts. */
export const SCAN_CAP_BYTES = 2 * 1024 * 1024;
export type Redaction = Pick<JournalEntry, "text" | "withheld" | "redactions">;

const COMPLETE_MARKER = /^\[REDACTED:[A-Za-z0-9_-]+\]$/;
const mark = (kind: string) => `[REDACTED:${kind}]`;
const KEYLIKE_LINE = /secret|token|passw|key|credential|auth/i;
const NAME = "(?:[A-Za-z0-9]{1,32}[_-]){0,6}(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY)(?:[_-][A-Za-z0-9]{1,32}){0,6}";
const VALUE = "\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s\"',;}]+";
type Rule = { kind: string; pattern: RegExp; keep?: boolean };
/** Defence in depth. Every pattern is linear or bounded so a hostile 2 MiB body cannot stall the hook. */
const RULES: readonly Rule[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g },
  { kind: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/g },
  { kind: "aws-key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { kind: "aws-key", pattern: /(aws_?secret[A-Za-z_]{0,40}["']?\s{0,4}[=:]\s{0,4}["']?)[A-Za-z0-9\/+=]{20,}/gi, keep: true },
  { kind: "api-key", pattern: /(?<![A-Za-z0-9])sk[-_](?:(?:live|test|proj)[-_])?[A-Za-z0-9_-]{16,}/g },
  { kind: "slack-token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { kind: "bearer", pattern: /\b(Bearer\s{1,8})[A-Za-z0-9._~+\/=-]+/gi, keep: true },
  { kind: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s\/:@]{1,256}:)[^\s@\/"]{1,1024}@/gi, keep: true },
  { kind: "env-secret", pattern: new RegExp(`\\b(${NAME}(?:["']\\s{0,4}:|\\s{0,4}=)\\s{0,4})(?:${VALUE})`, "gi"), keep: true },
];

function replaceAll(text: string, rule: Rule, counts: Counts): string {
  return text.replace(rule.pattern, (match: string, prefix: unknown) => {
    const head = rule.keep && typeof prefix === "string" ? prefix : "";
    if (COMPLETE_MARKER.test(match.slice(head.length))) return match; // only a complete marker, never a marker-prefixed value
    counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
    // url-credentials keeps the trailing @ so the host stays readable.
    return `${head}${mark(rule.kind)}${rule.kind === "url-credentials" ? "@" : ""}`;
  });
}

function longRuns(text: string, counts: Counts): string {
  const run = /(?<![A-Za-z0-9+\/_=-])(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+\/_-]{40,}={0,2})(?![A-Za-z0-9+\/_-])/g;
  return text.split("\n").map(line => KEYLIKE_LINE.test(line) ? line.replace(run, () => {
    counts.set("long-secret-run", (counts.get("long-secret-run") ?? 0) + 1);
    return mark("long-secret-run");
  }) : line).join("\n");
}

/** Pass 2 runs always and after pass 1, so it is also the only pass without the shared scanner. */
export function builtinRedact(text: string, counts: Counts): string {
  return longRuns(RULES.reduce((current, rule) => replaceAll(current, rule, counts), text), counts);
}

const withheld = (reason: "redactor_failed" | "too_large"): Redaction => ({ text: null, withheld: reason, redactions: [] });

/** Fail closed. Raw text is never returned on any error path. */
export function redact(text: string, scanner?: Scanner): Redaction {
  try {
    if (typeof text !== "string") return withheld("redactor_failed");
    if (Buffer.byteLength(text, "utf8") > SCAN_CAP_BYTES) return withheld("too_large");
    const counts: Counts = new Map();
    const first = scanner ? scannerPass(text, scanner, counts) : text;
    if (first === undefined) return withheld("redactor_failed");
    const second = builtinRedact(first, counts);
    return { text: second, withheld: null, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
  } catch { return withheld("redactor_failed"); }
}
