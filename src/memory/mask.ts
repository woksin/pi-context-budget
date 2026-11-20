import type { Redaction } from "./redact.ts";

/** Shared history/packet redaction, including private filesystem paths. */
export function redactedField(value: string, redactor: (value: string) => Redaction): string {
  const result = redactor(value);
  if (result.text === null) throw Error("withheld");
  // Filesystem paths are private history too; do not treat URL slashes as paths.
  return result.text.replace(/(^|[\s("'=])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)[^\s"'<>`]+/gu, "$1[REDACTED:path]");
}
