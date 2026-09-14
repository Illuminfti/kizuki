/** Design-only check of the documented UX/DX/AX error-semantics example. Not a product API. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/world-model-program.md");
const MARKER = "<!-- situation-error-parity-example -->";
const REFRESH_MARKER = "<!-- situation-error-parity-refresh-unavailable -->";
const SENSITIVITY_MARKER = "<!-- situation-error-parity-sensitivity-denied -->";
const NEW_VIEW_MARKER = "<!-- situation-error-parity-new-view-required -->";
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
  if (dx.code !== "authorization_refused") {
    errors.push("dx code must identify authorization_refused");
  }
  if (ax.code !== "authorization_refused") {
    errors.push("ax code must identify authorization_refused");
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
  if (dx.code !== "correction_committed_refresh_unavailable") {
    errors.push("dx code must identify correction_committed_refresh_unavailable");
  }
  if (ax.code !== "correction_committed_refresh_unavailable") {
    errors.push("ax code must identify correction_committed_refresh_unavailable");
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

test("authorization DX/AX diagnostic code must identify the same refusal", () => {
  const example = extractExample(readFileSync(DOC, "utf8"));
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, code: "ok" }),
    (projection) => ({ ...projection, code: "model_unavailable" }),
    (projection) => {
      const { code: _code, ...rest } = projection;
      return rest;
    },
  ];
  for (const name of ["dx", "ax"] as const) {
    for (const mutate of mutations) {
      const broken: Example = {
        ...example,
        projections: {
          ...example.projections,
          [name]: mutate(example.projections[name]),
        },
      };
      expect(parityErrors(broken).length).toBeGreaterThan(0);
    }
  }
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

test("refresh DX/AX diagnostic code must identify the committed-refresh outcome", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), REFRESH_MARKER);
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, code: "ok" }),
    (projection) => ({ ...projection, code: "authorization_refused" }),
    (projection) => {
      const { code: _code, ...rest } = projection;
      return rest;
    },
  ];
  for (const name of ["dx", "ax"] as const) {
    for (const mutate of mutations) {
      const broken: Example = {
        ...example,
        projections: {
          ...example.projections,
          [name]: mutate(example.projections[name]),
        },
      };
      expect(refreshParityErrors(broken).length).toBeGreaterThan(0);
    }
  }
  const bothWrong: Example = {
    ...example,
    projections: {
      ...example.projections,
      dx: { ...example.projections.dx, code: "ok" },
      ax: { ...example.projections.ax, code: "ok" },
    },
  };
  expect(refreshParityErrors(bothWrong).length).toBeGreaterThan(0);
});

function sensitivityParityErrors(example: Example): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") {
    errors.push("example must remain design_only");
  }
  if (example.principal.length === 0) errors.push("missing principal");
  const { ux, dx, ax } = example.projections;
  const forbiddenRecovery = new Set(["lower_sensitivity", "expand_grant", "owner_label"]);
  for (const [name, projection] of [
    ["ux", ux],
    ["dx", dx],
    ["ax", ax],
  ] as const) {
    if (projection.happened !== "sensitivity_denied") {
      errors.push(`${name} must report sensitivity_denied`);
    }
    if (projection.state_changed !== false) errors.push(`${name} implies a state change`);
    if (projection.blind_retry_useful !== false) errors.push(`${name} implies a useful blind retry`);
    if (projection.recovery !== "resolve_authorization") {
      errors.push(`${name} recovery is not resolve_authorization`);
    }
    if (forbiddenRecovery.has(projection.recovery)) {
      errors.push(`${name} recovery lowers sensitivity or invents an owner chore`);
    }
    if (projection.hidden_target_disclosed !== false) {
      errors.push(`${name} discloses whether a hidden target exists`);
    }
  }
  if (dx.code !== "sensitivity_denied") {
    errors.push("dx code must identify sensitivity_denied");
  }
  if (ax.code !== "sensitivity_denied") {
    errors.push("ax code must identify sensitivity_denied");
  }
  for (const key of SEMANTIC_KEYS) {
    if (ux[key] !== dx[key] || ux[key] !== ax[key]) {
      errors.push(`UX/DX/AX disagree on ${key}`);
    }
  }
  return errors;
}

test("the documented sensitivity-denied example keeps UX/DX/AX error semantics aligned", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), SENSITIVITY_MARKER);
  expect(example.id).toBe("sensitivity-denied-before-mutation");
  expect(sensitivityParityErrors(example)).toEqual([]);
});

test("a sensitivity projection that implies success, retry, or hidden-target disclosure fails", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), SENSITIVITY_MARKER);
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, happened: "ok", state_changed: true }),
    (projection) => ({ ...projection, blind_retry_useful: true }),
    (projection) => ({ ...projection, hidden_target_disclosed: true }),
    (projection) => ({ ...projection, recovery: "lower_sensitivity" }),
    (projection) => ({ ...projection, recovery: "owner_label" }),
  ];
  for (const mutate of mutations) {
    const broken: Example = {
      ...example,
      projections: {
        ...example.projections,
        ux: mutate(example.projections.ux),
      },
    };
    expect(sensitivityParityErrors(broken).length).toBeGreaterThan(0);
  }
});

test("sensitivity DX/AX diagnostic code must identify sensitivity_denied", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), SENSITIVITY_MARKER);
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, code: "ok" }),
    (projection) => ({ ...projection, code: "authorization_refused" }),
    (projection) => {
      const { code: _code, ...rest } = projection;
      return rest;
    },
  ];
  for (const name of ["dx", "ax"] as const) {
    for (const mutate of mutations) {
      const broken: Example = {
        ...example,
        projections: {
          ...example.projections,
          [name]: mutate(example.projections[name]),
        },
      };
      expect(sensitivityParityErrors(broken).length).toBeGreaterThan(0);
    }
  }
});

test("matching wrong sensitivity outcomes still fail the example", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), SENSITIVITY_MARKER);
  const wrong = {
    happened: "ok",
    state_changed: true,
    blind_retry_useful: true,
    recovery: "lower_sensitivity",
    hidden_target_disclosed: true,
    code: "ok",
  } as Projection;
  const allWrong: Example = {
    ...example,
    projections: { ux: wrong, dx: wrong, ax: wrong },
  };
  expect(sensitivityParityErrors(allWrong).length).toBeGreaterThan(0);
});

function newViewParityErrors(example: Example): string[] {
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
    if (projection.happened !== "new_view_required") {
      errors.push(`${name} must report new_view_required`);
    }
    if (projection.state_changed !== false) errors.push(`${name} implies a state change`);
    if (projection.blind_retry_useful !== false) {
      errors.push(`${name} implies a useful blind retry of the same baseline`);
    }
    if (projection.recovery !== "request_new_view") {
      errors.push(`${name} recovery is not request_new_view`);
    }
    if (projection.hidden_target_disclosed !== false) {
      errors.push(`${name} discloses whether a hidden target exists`);
    }
    if (projection.view_current !== false) errors.push(`${name} labels the invalid view current`);
  }
  if (dx.code !== "new_view_required") {
    errors.push("dx code must identify new_view_required");
  }
  if (ax.code !== "new_view_required") {
    errors.push("ax code must identify new_view_required");
  }
  for (const key of [...SEMANTIC_KEYS, "view_current"] as const) {
    if (ux[key] !== dx[key] || ux[key] !== ax[key]) {
      errors.push(`UX/DX/AX disagree on ${key}`);
    }
  }
  return errors;
}

test("an invalid view baseline preserves UX/DX/AX new-view-required semantics", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), NEW_VIEW_MARKER);
  expect(example.id).toBe("invalid-view-baseline-new-view-required");
  expect(newViewParityErrors(example)).toEqual([]);
});

test("stale-view counterexamples cannot imply current data, mutation, or useful blind retry", () => {
  const example = extractExample(readFileSync(DOC, "utf8"), NEW_VIEW_MARKER);
  const mutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, happened: "ok", state_changed: true }),
    (projection) => ({ ...projection, state_changed: true }),
    (projection) => ({ ...projection, view_current: true }),
    (projection) => ({ ...projection, blind_retry_useful: true, recovery: "retry_same_baseline" }),
    (projection) => ({ ...projection, hidden_target_disclosed: true }),
  ];
  for (const mutate of mutations) {
    const broken: Example = {
      ...example,
      projections: {
        ...example.projections,
        ux: mutate(example.projections.ux),
      },
    };
    expect(newViewParityErrors(broken).length).toBeGreaterThan(0);
  }
  const codeMutations: Array<(projection: Projection) => Projection> = [
    (projection) => ({ ...projection, code: "ok" }),
    (projection) => ({ ...projection, code: "authorization_refused" }),
    (projection) => {
      const { code: _code, ...rest } = projection;
      return rest;
    },
  ];
  for (const name of ["dx", "ax"] as const) {
    for (const mutate of codeMutations) {
      const broken: Example = {
        ...example,
        projections: {
          ...example.projections,
          [name]: mutate(example.projections[name]),
        },
      };
      expect(newViewParityErrors(broken).length).toBeGreaterThan(0);
    }
  }
  const wrong = {
    happened: "ok",
    state_changed: true,
    blind_retry_useful: true,
    recovery: "retry_same_baseline",
    hidden_target_disclosed: true,
    view_current: true,
    code: "ok",
  } as Projection;
  const allWrong: Example = {
    ...example,
    projections: { ux: wrong, dx: wrong, ax: wrong },
  };
  expect(newViewParityErrors(allWrong).length).toBeGreaterThan(0);
});
