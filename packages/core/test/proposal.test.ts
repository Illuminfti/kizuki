import { describe, expect, test } from "bun:test";
import {
  CLAIM_SCHEMA,
  isProducer,
  validateClaim,
} from "../src/contracts/proposal";

function rawClaim(): Record<string, unknown> {
  return {
    schema: CLAIM_SCHEMA,
    claim_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "claim",
    target: null,
    subject: "person:ada",
    predicate: "employment.works_at",
    object: "org:acme",
    polarity: "positive",
    claim_key: "a".repeat(64),
    body: "Ada works at Acme.",
    frontmatter: { type: "fact" },
    provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"],
    subjects: ["person:ada"],
    producer: "deterministic",
    model_ref: null,
    authority: "connector_evidence",
    confidence: 0.8,
    sensitivity: "personal",
    taint: "clean",
    valid_from: "2026-03-01T09:00:00Z",
    valid_to: null,
    asserted_at: "2026-03-01T09:00:00Z",
    retracted_at: null,
    status: "live",
    superseded_by: null,
    receipt_id: null,
    body_hash: "b".repeat(64),
    created_at: "2026-03-01T09:00:00Z",
    corroboration: 1,
    last_confirmed_at: "2026-03-01T09:00:00Z",
  };
}

describe("isProducer", () => {
  const valid = [
    "deterministic",
    "llm",
    "model",
    "owner",
    "agent:reviewer",
    "agent:cli-2",
    "agent:a.b_c-1",
  ];
  for (const p of valid) {
    test(`accepts ${p}`, () => expect(isProducer(p)).toBe(true));
  }

  const invalid: unknown[] = [
    "agent:",
    "agent",
    "human",
    "Agent:x",
    "agent:-x",
    "",
    null,
    3,
  ];
  for (const p of invalid) {
    test(`rejects ${JSON.stringify(p)}`, () =>
      expect(isProducer(p)).toBe(false));
  }
});

describe("validateClaim accepts", () => {
  test("an agent producer with multi-event provenance", () => {
    const result = validateClaim({
      ...rawClaim(),
      producer: "agent:planner",
      provenance: ["e1", "e2", "e3"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.provenance).toEqual(["e1", "e2", "e3"]);
  });

  test("an empty frontmatter object", () => {
    expect(validateClaim({ ...rawClaim(), frontmatter: {} }).ok).toBe(true);
  });

  test("and copies provenance rather than aliasing it", () => {
    const input = rawClaim();
    const result = validateClaim(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    (input["provenance"] as string[]).push("smuggled");
    expect(result.value.provenance).toHaveLength(1);
  });
});

describe("validateClaim rejects", () => {
  const rejected: [string, unknown, string][] = [
    ["a non-object", 42, "claim"],
    [
      "a wrong schema tag",
      { ...rawClaim(), schema: "kizuki.event/v1" },
      "schema",
    ],
    [
      "a missing claim_id",
      { ...rawClaim(), claim_id: "" },
      "claim_id",
    ],
    ["an unknown kind", { ...rawClaim(), kind: "annotation" }, "kind"],
    ["empty provenance", { ...rawClaim(), provenance: [] }, "provenance"],
    [
      "provenance as a string",
      { ...rawClaim(), provenance: "e1" },
      "provenance",
    ],
    [
      "provenance with a blank entry",
      { ...rawClaim(), provenance: ["e1", ""] },
      "provenance",
    ],
    [
      "an unknown producer",
      { ...rawClaim(), producer: "intern" },
      "producer",
    ],
    [
      "an anonymous agent producer",
      { ...rawClaim(), producer: "agent:" },
      "producer",
    ],
    ["a stored llm producer", { ...rawClaim(), producer: "llm" }, "producer"],
    ["an unknown status", { ...rawClaim(), status: "maybe" }, "status"],
    ["an unknown authority", { ...rawClaim(), authority: "hearsay" }, "authority"],
    [
      "a short body_hash",
      { ...rawClaim(), body_hash: "abc" },
      "body_hash",
    ],
    [
      "an uppercase body_hash",
      { ...rawClaim(), body_hash: "A".repeat(64) },
      "body_hash",
    ],
    [
      "a bad created_at",
      { ...rawClaim(), created_at: "2026-02-30T00:00:00Z" },
      "created_at",
    ],
  ];

  for (const [name, input, field] of rejected) {
    test(name, () => {
      const result = validateClaim(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.some((e) => e.startsWith(field))).toBe(true);
    });
  }

  test("reports every broken field at once", () => {
    const result = validateClaim({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThanOrEqual(8);
  });
});
