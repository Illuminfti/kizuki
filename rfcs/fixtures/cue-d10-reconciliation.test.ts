/** Design-only guard that Cue decisions do not become an owner review queue. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0002-autonomous-canon.md");
const RFC4 = join(ROOT, "rfcs/0004-living-epistemic-world-model.md");
const DECISIONS = join(ROOT, "docs/decision-log.md");
const MARKER = "<!-- cue-d10-reconciliation -->";
const D10 =
  "| D10 | 2026-09-02 | No owner review queue | There is no owner review queue and there never will be one. The TUI is audit and undo only. |";

function clarification(markdown: string): string {
  const at = markdown.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(at);
  const next = rest.search(/\n### /);
  return next < 0 ? rest : rest.slice(0, next);
}

function cueErrors(section: string): string[] {
  const errors: string[] = [];
  const compact = section.toLowerCase().replace(/\s+/g, " ");
  if (!compact.includes("d10 is unchanged")) errors.push("missing unchanged D10 statement");
  if (!compact.includes("never gates those paths")) errors.push("missing never-gates statement");
  if (!compact.includes("append-only")) errors.push("missing append-only decision record");
  if (!compact.includes("external-effect intent")) errors.push("missing external-effect intent");
  if (!compact.includes("not source permission")) errors.push("missing source-permission denial");
  if (!compact.includes("execution grant")) errors.push("missing execution-grant denial");
  if (!compact.includes("proof of completion")) errors.push("missing completion-proof denial");
  if (!compact.includes("revalidate")) errors.push("missing runtime revalidation");
  if (!compact.includes("current kizuki basis")) errors.push("missing current Kizuki basis");
  if (!compact.includes("prior attempt")) errors.push("missing prior-attempt revalidation");
  if (!compact.includes("material changes invalidate")) {
    errors.push("missing material-change invalidation");
  }
  if (!compact.includes("presentation-only changes do not")) {
    errors.push("missing presentation-only exception");
  }
  if (!compact.includes("independently observed outcome")) {
    errors.push("missing separate outcome record");
  }
  if (!compact.includes("hosts no agent")) errors.push("missing no-agent statement");
  if (!compact.includes("no general execute endpoint")) errors.push("missing no-execute-endpoint");
  if (!compact.includes("does not adopt rfc 0004")) errors.push("missing RFC 0004 non-adoption");
  if (!compact.includes("amend d10")) errors.push("missing D10 non-amendment");
  if (/approval is an execution grant/.test(compact)) {
    errors.push("approval described as an execution grant");
  }
  return errors;
}

test("RFC 0002 records the Cue/D10 boundary without amending D10", () => {
  const section = clarification(readFileSync(RFC, "utf8"));
  expect(cueErrors(section)).toEqual([]);
  expect(readFileSync(DECISIONS, "utf8")).toContain(D10);
  // D22 (2026-09-18) accepts only a named minimal slice of RFC 0004; the rest stays
  // Proposed, so RFC 0004 still cannot amend the Cue/D10 boundary by itself.
  const rfc4 = readFileSync(RFC4, "utf8");
  expect(rfc4).toContain("Status: **Accepted as a minimal slice** (owner decision D22, 2026-09-18)");
  expect(rfc4).toContain("Everything else in this RFC remains Proposed and is not implemented by that acceptance.");
});

test("removing runtime revalidation or treating approval as a grant fails the Cue/D10 guard", () => {
  const section = clarification(readFileSync(RFC, "utf8"));
  expect(
    cueErrors(section.replace("revalidate its own effect authority", "trust its prior effect authority")),
  ).toContain("missing runtime revalidation");
  expect(
    cueErrors(`${section}\nApproval is an execution grant.`),
  ).toContain("approval described as an execution grant");
});
