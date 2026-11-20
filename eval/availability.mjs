// Dev-only, read-only retention measurement. See README for schema and provenance.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";

const normalize = text => text.replace(/\s+/g, " ").trim();
function requireAnnotation(condition, message) {
  if (!condition) throw new Error(`Malformed annotation: ${message}`);
}
function instant(value) {
  requireAnnotation(typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)), "invalid timestamp");
  return Date.parse(value);
}
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function validateDirective(d) {
  requireAnnotation(d && nonempty(d.id) && nonempty(d.quote), "directive needs id and quote");
  instant(d.sourceTs);
  if (d.paraphrase !== undefined) {
    requireAnnotation(nonempty(d.paraphrase), "paraphrase must be a regex string");
    try { new RegExp(d.paraphrase, "i"); }
    catch { throw new Error(`Malformed annotation: invalid paraphrase regex for ${d.id}`); }
  }
  if (d.retiredAt !== undefined) {
    requireAnnotation(instant(d.retiredAt) > instant(d.sourceTs) && nonempty(d.retirementReason), "retirement needs a later timestamp and reason");
  }
}
function validateUnique(items, label) {
  requireAnnotation(Array.isArray(items), `${label} must be an array`);
  const ids = items.map(item => item?.id);
  requireAnnotation(ids.every(nonempty) && new Set(ids).size === ids.length, `${label} need unique ids`);
}
function validateTiers(tiers, directives) {
  const ids = [...(tiers.pointer ?? []), ...(tiers.indexOnly ?? [])];
  requireAnnotation(Array.isArray(tiers.pointer ?? []) && Array.isArray(tiers.indexOnly ?? []), "tiers must be arrays");
  requireAnnotation(new Set(ids).size === ids.length && ids.every(id => directives.some(d => d.id === id)), "tiers need unique, annotated directive ids");
}
function constraints(text) {
  return [...text.matchAll(/^##\s+(?:User constraints|User directives)[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/gim)].map(m => m[1]).join("\n");
}
function classification(text, directive) {
  if (normalize(text).includes(normalize(directive.quote))) return "verbatim";
  if (directive.paraphrase && new RegExp(directive.paraphrase, "i").test(text)) return "paraphrase";
  return "absent";
}
function locationFor(handoff, directive, match) {
  if (match !== "absent") return "inline";
  const tiers = handoff.tiers ?? {};
  if ((tiers.pointer ?? []).includes(directive.id)) return "pointer";
  if ((tiers.indexOnly ?? []).includes(directive.id)) return "index-only";
  return "absent";
}
function isRetired(handoff, directive) {
  if (!directive.retiredAt) return false;
  return instant(handoff.ts) >= instant(directive.retiredAt);
}
function rowFor(handoff, directive) {
  if (isRetired(handoff, directive)) {
    return { directive: directive.id, status: "retired", reason: directive.retirementReason };
  }
  const match = classification(handoff.text, directive);
  return { directive: directive.id, status: "active", classification: match, location: locationFor(handoff, directive, match),
    inConstraints: classification(constraints(handoff.text), directive) !== "absent" };
}
function emptyStats() {
  return { applicable: 0, verbatim: 0, paraphrase: 0, absent: 0, inline: 0, pointer: 0, indexOnly: 0, inConstraints: 0, retired: 0 };
}
function percentages(stats) {
  const pct = count => stats.applicable ? 100 * count / stats.applicable : null;
  return { ...stats, availabilityPct: pct(stats.inline), constraintsPct: pct(stats.inConstraints),
    reachabilityPct: pct(stats.inline + stats.pointer + stats.indexOnly) };
}
function tally(rows) {
  const stats = emptyStats();
  for (const row of rows) {
    if (row.status === "retired") { stats.retired++; continue; }
    stats.applicable++;
    stats[row.classification]++;
    if (row.location !== "absent") stats[row.location === "index-only" ? "indexOnly" : row.location]++;
    if (row.inConstraints) stats.inConstraints++;
  }
  return percentages(stats);
}
function measureChain(chain, base) {
  requireAnnotation(Array.isArray(chain.handoffs), "handoffs must be an array");
  if (chain.directives === undefined || chain.directives.length === 0) return { id: chain.id, status: "no annotations, skipped" };
  validateUnique(chain.directives, "directives");
  chain.directives.forEach(validateDirective);
  validateUnique(chain.handoffs, "handoffs");
  const handoffs = chain.handoffs.map(h => {
    instant(h.ts);
    const text = h.file === undefined ? h.text : readFileSync(resolve(base, h.file), "utf8");
    requireAnnotation(typeof text === "string", "handoff needs text or file");
    validateTiers(h.tiers ?? {}, chain.directives);
    const rows = chain.directives.filter(d => instant(h.ts) > instant(d.sourceTs)).map(d => rowFor({ ...h, text }, d));
    return { id: h.id, ts: h.ts, rows, stats: tally(rows) };
  });
  return { id: chain.id, handoffs, stats: tally(handoffs.flatMap(h => h.rows)),
    retirements: chain.directives.filter(d => d.retiredAt).map(d => ({ directive: d.id, at: d.retiredAt, reason: d.retirementReason })) };
}
function measure(input, base) {
  requireAnnotation(input && typeof input === "object", "expected a manifest");
  validateUnique(input.chains, "chains");
  const chains = input.chains.map(chain => measureChain(chain, base));
  const totals = emptyStats();
  for (const chain of chains.filter(c => c.stats)) {
    for (const key of Object.keys(totals)) totals[key] += chain.stats[key];
  }
  return { schema: 1, exclusions: input.exclusions ?? [], chains, stats: percentages(totals) };
}

// Adapt local study snapshots; never follow dump.f into a live session.
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
function studyDirective(directive, dump) {
  const source = dump.human[directive.src];
  requireAnnotation(source, `missing source for ${directive.id}`);
  const result = { id: directive.id, quote: source.t, sourceTs: source.ts, paraphrase: directive.re };
  if (directive.end !== undefined) {
    const retirement = dump.human[directive.end];
    requireAnnotation(retirement, `missing retirement source for ${directive.id}`);
    result.retiredAt = retirement.ts;
    result.retirementReason = `Study-annotated supersession: ${retirement.t}`;
  }
  return result;
}
function studyChain(entry, base, exclusions) {
  requireAnnotation(nonempty(entry.config), "chain needs a config filename");
  const configFile = resolve(base, entry.config);
  const config = readJson(configFile);
  const dump = readJson(resolve(dirname(configFile), config.dump));
  requireAnnotation(nonempty(dump.sid) && dump.sid.startsWith(config.sid), `snapshot sid mismatch for ${entry.id}`);
  const omitted = exclusions.filter(e => e.chain === entry.id).map(e => e.id);
  requireAnnotation(omitted.every(id => config.directives.some(d => d.id === id)), "exclusions must name annotated directives");
  const directives = config.directives.filter(d => !omitted.includes(d.id)).map(d => studyDirective(d, dump));
  return { id: entry.id, sourceSid: dump.sid, directives, handoffs: [] };
}
function validateExclusions(exclusions, chains) {
  requireAnnotation(Array.isArray(exclusions), "exclusions must be an array");
  for (const exclusion of exclusions) {
    requireAnnotation(nonempty(exclusion.id) && nonempty(exclusion.reason), "exclusion needs id and reason");
    requireAnnotation(chains.some(c => c.id === exclusion.chain), "exclusion needs an annotated chain");
  }
}
async function reverify(manifestFile) {
  const manifest = readJson(manifestFile);
  const base = dirname(manifestFile);
  validateUnique(manifest.chains, "study chains");
  const unannotated = manifest.unannotated ?? [];
  validateUnique([...manifest.chains, ...unannotated], "all study chains");
  const exclusions = manifest.exclusions ?? [];
  validateExclusions(exclusions, manifest.chains);
  const chains = manifest.chains.map(entry => studyChain(entry, base, exclusions));
  requireAnnotation(nonempty(manifest.scanFile), "study needs a scanFile");
  const lines = createInterface({ input: createReadStream(resolve(base, manifest.scanFile)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const chain = chains.find(c => record.sid === c.sourceSid);
    if (chain) {
      requireAnnotation(chain.handoffs.length === 0, `duplicate study chain ${chain.id}`);
      chain.handoffs = record.comp.map((c, i) => ({ id: String(i), ts: c.ts, text: c.s }));
    }
  }
  for (const chain of chains) requireAnnotation(chain.handoffs.length > 0, `missing study chain ${chain.id}`);
  for (const entry of unannotated) {
    requireAnnotation(nonempty(entry.file), "unannotated chain needs a snapshot filename");
    readJson(resolve(base, entry.file));
    chains.push({ id: entry.id, handoffs: [] });
  }
  return { chains, exclusions };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--reverify") {
    return measure(await reverify(resolve(args[1])), process.cwd());
  }
  if (args.length !== 1) throw new Error("Usage: node eval/availability.mjs <manifest.json|-> | --reverify <local-study-manifest.json>");
  const input = JSON.parse(readFileSync(args[0] === "-" ? 0 : args[0], "utf8"));
  return measure(input, args[0] === "-" ? process.cwd() : dirname(resolve(args[0])));
}
main().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
