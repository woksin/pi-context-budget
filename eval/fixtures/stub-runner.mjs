// Deterministic protocol stub, not a model or evidence of real compliance.
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.schema !== 1 || request.model !== "stub@1" || !request.probe?.criterion) {
  throw new Error("Unexpected replay request");
}
console.log(JSON.stringify({ compliant: request.probe.directive, reason: "Fixture-only canned judgement." }));
