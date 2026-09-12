/** Design-only check of the documented UX/DX/AX error-semantics example. Not a product API. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/world-model-program.md");
const MARKER = "<!-- situation-error-parity-example -->";
const SEMANTIC_KEYS = [
  "happened",
  "state_changed",
  "blind_retry_useful",
  "recovery",
  "hidden_target_disclosed",
] as const;

type Projection = {
  happened: string;
  state_changed: boolean;
  blind_retry_useful: boolean;
  recovery: string;
  hidden_target_disclosed: boolean;
  summary?: string;
  code?: string;
};

type Example = {
  id: string;
  evaluation_state: string;
  principal: string;
  projections: { ux: Projection; dx: Projection; ax: Projection };
};

function extractExample(markdown: string): Example {
  const at = markdown.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const fence = markdown.slice(at).match(/```json\n([\s\S]*?)\n```/);
  expect(fence?.[1]).toBeTypeOf("string");
  return JSON.parse(fence![1]!) as Example;
}

function parityErrors(example: Example): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") {
    errors.push("example must remain design_only");
  }
  if (example.principal.length === 0) errors.push("missing principal");
  const { ux, dx, ax } = example.projections;
  for (const [name, projection] of [
    ["ux", ux],
    ["dx", dx],
    ["ax", ax],
  ] as const) {
    if (projection.happened !== "authorization_refused") {
      errors.push(`${name} must report authorization_refused`);
    }
    if (projection.state_changed !== false) errors.push(`${name} implies a state change`);
    if (projection.blind_retry_useful !== false) errors.push(`${name} implies a useful blind retry`);
    if (projection.recovery !== "resolve_authorization") {
      errors.push(`${name} recovery is not resolve_authorization`);
    }
    if (projection.hidden_target_disclosed !== false) {
      errors.push(`${name} discloses whether a hidden target exists`);
    }
  }
  for (const key of SEMANTIC_KEYS) {
    if (ux[key] !== dx[key] || ux[key] !== ax[key]) {
      errors.push(`UX/DX/AX disagree on ${key}`);
    }
  }
  return errors;
}

test("the documented authorization-refusal example keeps UX/DX/AX error semantics aligned", () => {
  const example = extractExample(readFileSync(DOC, "utf8"));
  expect(example.id).toBe("authorization-refusal-before-mutation");
  expect(parityErrors(example)).toEqual([]);
});

test("a projection that implies success, retry, or hidden-target disclosure fails the example", () => {
  const example = extractExample(readFileSync(DOC, "utf8"));
  const broken: Example = {
    ...example,
    projections: {
      ...example.projections,
      ux: {
        ...example.projections.ux,
        happened: "ok",
        state_changed: true,
        blind_retry_useful: true,
        hidden_target_disclosed: true,
      },
    },
  };
  expect(parityErrors(broken).length).toBeGreaterThan(0);
});
