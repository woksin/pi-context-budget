import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScanner, redact, SCAN_CAP_BYTES, type Scanner } from "../src/memory/redact.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function agentDir(moduleSource?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-redact-"));
  dirs.push(dir);
  if (moduleSource !== undefined) { mkdirSync(join(dir, "lib")); writeFileSync(join(dir, "lib", "secret-mask.ts"), moduleSource); }
  return dir;
}
/** Identity scanner: proves the built-in pass stands alone when the shared one finds nothing. */
const PASSTHROUGH = "export const scan = (text: string) => ({ text, kinds: [], count: 0, skipped: false });";
const j = (...parts: string[]) => parts.join("");
const body = j("A1b2C3d4E5", "f6G7h8I9j0", "K1l2M3n4O5");
// Built at runtime from fragments: no secret-like literal exists in the repository.
const CANARIES: Record<string, { text: string; secret: string }> = {
  github: { secret: j("gh", "p_", body), text: j("token ", "gh", "p_", body, " end") },
  github_oauth: { secret: j("gh", "o_", body), text: j("gh", "o_", body) },
  github_server: { secret: j("gh", "s_", body), text: j("x=", "gh", "s_", body) },
  github_pat: { secret: j("github", "_pat_", body, "_zz"), text: j("github", "_pat_", body, "_zz") },
  aws_access: { secret: j("AK", "IA", "ABCDEFGH12345678"), text: j("id AK", "IA", "ABCDEFGH12345678 ok") },
  aws_session: { secret: j("AS", "IA", "ABCDEFGH12345678"), text: j("AS", "IA", "ABCDEFGH12345678") },
  aws_secret: { secret: j("wJalrXUtnFEMI", "/K7MDENG/bPxRfiCY"), text: j("aws_", "secret_access_key = ", "wJalrXUtnFEMI", "/K7MDENG/bPxRfiCY") },
  sk_live: { secret: j("sk", "_live_", body), text: j("key ", "sk", "_live_", body) },
  sk_dash: { secret: j("sk", "-", body, "ZZ"), text: j("sk", "-", body, "ZZ") },
  slack: { secret: j("xo", "xb-", "1234567890-abcdefghij"), text: j("xo", "xb-", "1234567890-abcdefghij") },
  jwt: { secret: j("ey", "JhbGciOi", ".ey", "JzdWIiOiIx", ".sig_abc-123"), text: j("jwt ey", "JhbGciOi", ".ey", "JzdWIiOiIx", ".sig_abc-123") },
  bearer: { secret: j("abcDEF123", "456ghiJKL"), text: j("Authorization: Bear", "er ", "abcDEF123", "456ghiJKL") },
  pem: { secret: j("MIIEvQIBADANBg", "kqhkiG9w0BAQEFAA"),
    text: j("-----BEGIN PRIVATE ", "KEY-----\n", "MIIEvQIBADANBg", "kqhkiG9w0BAQEFAA", "\n-----END PRIVATE ", "KEY-----") },
  pem_unterminated: { secret: j("MIIEvQIBADANBg", "kqhkiG9w0BAQEFAA"), text: j("-----BEGIN PRIVATE ", "KEY-----\n", "MIIEvQIBADANBg", "kqhkiG9w0BAQEFAA") },
  url_credentials: { secret: j("hunter", "2pass"), text: j("postgres://", "admin:", "hunter", "2pass", "@db.example.com/app") },
  env_assignment: { secret: j("s3cr3t", "Value99"), text: j("MY_APP_", "TOKEN", "=", "s3cr3t", "Value99") },
  env_password: { secret: j("p@ss", "w0rd-Zq"), text: j("export DB_", "PASSWORD", "=\"", "p@ss", "w0rd-Zq", "\"") },
  env_json: { secret: j("s3cr3t", "Value99"), text: j("{\"api_", "key\": \"", "s3cr3t", "Value99", "\"}") },
  long_hex: { secret: "0123456789abcdef".repeat(3), text: j("the signing ", "key line: ", "0123456789abcdef".repeat(3)) },
  long_base64: { secret: j("QUJDREVGR0hJSktMTU5PUFFSU1RV", "VldYWVphYmNkZWZnaGlqa2xtbm9w"), text: j("password hash ", "QUJDREVGR0hJSktMTU5PUFFSU1RV", "VldYWVphYmNkZWZnaGlqa2xtbm9w") },
};

for (const [name, { text, secret }] of Object.entries(CANARIES)) {
  test(`built-in pass alone redacts ${name} when the shared scanner is absent`, async () => {
    assert.equal(await loadScanner(agentDir()), undefined);
    const result = redact(`before\n${text}\nafter`, undefined);
    assert.equal(result.withheld, null);
    assert.ok(!result.text!.includes(secret), result.text!);
    assert.match(result.text!, /^before\n/);
    // An unterminated PEM block swallows the rest of the text, by design.
    if (name !== "pem_unterminated") assert.match(result.text!, /\nafter$/);
    assert.ok(result.redactions.length > 0 && result.redactions.every(r => r.count > 0));
  });
  test(`built-in pass still redacts ${name} when the shared scanner finds nothing`, async () => {
    const scanner = await loadScanner(agentDir(PASSTHROUGH));
    assert.ok(scanner);
    assert.ok(!redact(text, scanner).text!.includes(secret));
  });
}

test("both passes compose: scanner output feeds the built-in pass and redactions merge", async () => {
  const masking = `export const scan = (text: string) => ({ text: text.replace("MASKME", "[REDACTED:custom]"), kinds: ["custom"], count: 1, skipped: false, findings: [{ kind: "custom", line: 1 }] });`;
  const scanner = await loadScanner(agentDir(masking));
  const result = redact(`MASKME ${CANARIES.github.text}`, scanner);
  assert.ok(!result.text!.includes("MASKME") && !result.text!.includes(CANARIES.github.secret));
  assert.deepEqual(result.redactions.map(r => r.kind).sort(), ["custom", "github-token"]);
});

test("ordinary prose and code are not redacted", () => {
  const prose = "monkey: banana\nPlease rotate the key tomorrow and use the token endpoint.\nhttps://example.com/a/b?c=d\nsrc/memory/redact.ts";
  assert.deepEqual(redact(prose, undefined), { text: prose, withheld: null, redactions: [] });
});

test("scanner throwing withholds: no text, no raw-text hash input", async () => {
  const scanner = await loadScanner(agentDir("export const scan = () => { throw new Error('boom'); };"));
  const result = redact(CANARIES.github.text, scanner);
  assert.deepEqual(result, { text: null, withheld: "redactor_failed", redactions: [] });
  assert.ok(!JSON.stringify(result).includes(CANARIES.github.secret));
});

for (const [label, source] of Object.entries({
  "null result": "export const scan = () => null;",
  "string result": "export const scan = (t: string) => t;",
  "missing text": "export const scan = () => ({ kinds: [], count: 0, skipped: false });",
  "text not a string": "export const scan = () => ({ text: 5, kinds: [], count: 0, skipped: false });",
  "kinds not an array": "export const scan = (t: string) => ({ text: t, kinds: 'x', count: 0, skipped: false });",
  "negative count": "export const scan = (t: string) => ({ text: t, kinds: [], count: -1, skipped: false });",
  "skipped": "export const scan = (t: string) => ({ text: 'withheld', kinds: ['x'], count: 0, skipped: true });",
  "no scan export": "export const other = 1;",
  "scan is not a function": "export const scan = 7;",
  "module fails to load": "export const scan = (",
})) {
  test(`unrecognised or unusable scanner (${label}) withholds`, async () => {
    const scanner = await loadScanner(agentDir(source));
    assert.ok(scanner, "a present but unusable module must not silently fall back to raw text");
    assert.deepEqual(redact(CANARIES.sk_live.text, scanner), { text: null, withheld: "redactor_failed", redactions: [] });
  });
}

test("oversize input is withheld as too_large in both modes", async () => {
  const huge = "a".repeat(SCAN_CAP_BYTES + 1);
  assert.deepEqual(redact(huge, undefined), { text: null, withheld: "too_large", redactions: [] });
  assert.deepEqual(redact(huge, await loadScanner(agentDir(PASSTHROUGH))), { text: null, withheld: "too_large", redactions: [] });
  assert.equal(redact("a".repeat(SCAN_CAP_BYTES), undefined).withheld, null);
  // The cap is in bytes, not code units.
  assert.equal(redact("é".repeat(SCAN_CAP_BYTES / 2 + 1), undefined).withheld, "too_large");
});

test("non-string input withholds instead of throwing", () => {
  assert.equal(redact(undefined as unknown as string, undefined).withheld, "redactor_failed");
});

test("hostile near-cap bodies finish quickly (no catastrophic backtracking)", () => {
  const bodies = ["a-".repeat(SCAN_CAP_BYTES / 2), "a_".repeat(SCAN_CAP_BYTES / 2), "KEY=".repeat(SCAN_CAP_BYTES / 4),
    "http://a:".repeat(SCAN_CAP_BYTES / 9), "-----BEGIN X-----".repeat(SCAN_CAP_BYTES / 17), `key ${"A".repeat(SCAN_CAP_BYTES - 8)}`,
    "Bearer ".repeat(SCAN_CAP_BYTES / 7)];
  for (const text of bodies) {
    const started = Date.now();
    const result = redact(text, undefined);
    assert.ok(Date.now() - started < 5000, `slow on ${text.slice(0, 12)}`);
    assert.ok(result.text !== undefined);
  }
});

test("a scanner that mutates nothing cannot cause raw text to be returned on failure paths", () => {
  const failing: Scanner = () => { throw new Error("x"); };
  const result = redact(CANARIES.pem.text, failing);
  assert.equal(result.text, null);
});
