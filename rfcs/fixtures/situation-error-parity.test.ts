/** Design-only check of the documented UX/DX/AX error-semantics example. Not a product API. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/world-model-program.md");
const MARKER = "<!-- situation-error-parity-example -->";
const REFRESH_MARKER = "<!-- situation-error-parity-refresh-unavailable -->";
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
  view_current?: boolean;
  receipt?: string;
  summary?: string;
  code?: string;
};

type Example = {
  id: string;
  evaluation_state: string;
  principal: string;
  projections: { ux: Projection; dx: Projection; ax: Projection };
};

function extractExample(markdown: string, marker = MARKER): Example {
  const at = markdown.indexOf(marker);
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

function refreshParityErrors(example: Example): string[] {
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
    if (projection.happened !== "correction_committed_refresh_unavailable") {
      errors.push(`${name} must report correction_committed_refresh_unavailable`);
    }
    if (projection.state_changed !== true) errors.push(`${name} implies the correction did not commit`);
    if (projection.blind_retry_useful !== false) errors.push(`${name} implies repeating the correction`);
    if (projection.recovery !== "retry_read") errors.push(`${name} recovery is not retry_read`);
    if (projection.hidden_target_disclosed !== false) {
      errors.push(`${name} discloses whether a hidden target exists`);
    }
    if (projection.view_current !== false) errors.push(`${name} labels the unavailable view current`);
    if (projection.receipt !== "synthetic-receipt-1") errors.push(`${name} lost the mutation receipt`);
  }
  for (const key of [...SEMANTIC_KEYS, "view_current", "receipt"] as const) {
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

test("a committed correction with an unavailable refresh preserves UX/DX/AX mutation semantics", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), REFRESH_MARKER);
  expect(example.id).toBe("correction-committed-refresh-unavailable");
  expect(refreshParityErrors(example)).toEqual([]);
});

test("refresh failure cannot imply rollback, mutation retry, or a current view", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), REFRESH_MARKER);
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, state_changed: false }),
    (projection) => ({ ...projection, receipt: undefined }),
    (projection) => ({ ...projection, blind_retry_useful: true, recovery: "repeat_correction" }),
    (projection) => ({ ...projection, view_current: true }),
  ];
  for (const mutate of mutations) {
    const broken: Example = {
      ...example,
      projections: {
        ...example.projections,
        ux: mutate(example.projections.ux),
      },
    };
    expect(refreshParityErrors(broken).length).toBeGreaterThan(0);
  }
});
