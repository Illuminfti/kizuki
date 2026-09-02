import { describe, expect, test } from "bun:test";
import {
  isProducer,
  validateProposal,
} from "../src/contracts/proposal";

function rawProposal(): Record<string, unknown> {
  return {
    schema: "kizuki.proposal/v1",
    proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "claim",
    provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"],
    producer: "deterministic",
    status: "pending",
    payload: {
      subject: "person:ada",
      predicate: "works_at",
      object: "org:acme",
    },
    content_hash: "a".repeat(64),
    created_at: "2026-03-01T09:00:00Z",
  };
}

describe("isProducer", () => {
  const valid = [
    "deterministic",
    "llm",
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

describe("validateProposal accepts", () => {
  test("an agent producer with multi-event provenance", () => {
    const result = validateProposal({
      ...rawProposal(),
      producer: "agent:planner",
      provenance: ["e1", "e2", "e3"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.provenance).toEqual(["e1", "e2", "e3"]);
  });

  test("an empty payload", () => {
    expect(validateProposal({ ...rawProposal(), payload: {} }).ok).toBe(true);
  });

  test("and copies provenance rather than aliasing it", () => {
    const input = rawProposal();
    const result = validateProposal(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    (input["provenance"] as string[]).push("smuggled");
    expect(result.value.provenance).toHaveLength(1);
  });
});

describe("validateProposal rejects", () => {
  const rejected: [string, unknown, string][] = [
    ["a non-object", 42, "proposal"],
    [
      "a wrong schema tag",
      { ...rawProposal(), schema: "kizuki.event/v1" },
      "schema",
    ],
    [
      "a missing proposal_id",
      { ...rawProposal(), proposal_id: "" },
      "proposal_id",
    ],
    ["an unknown kind", { ...rawProposal(), kind: "annotation" }, "kind"],
    ["empty provenance", { ...rawProposal(), provenance: [] }, "provenance"],
    [
      "provenance as a string",
      { ...rawProposal(), provenance: "e1" },
      "provenance",
    ],
    [
      "provenance with a blank entry",
      { ...rawProposal(), provenance: ["e1", ""] },
      "provenance",
    ],
    [
      "an unknown producer",
      { ...rawProposal(), producer: "intern" },
      "producer",
    ],
    [
      "an anonymous agent producer",
      { ...rawProposal(), producer: "agent:" },
      "producer",
    ],
    ["an unknown status", { ...rawProposal(), status: "maybe" }, "status"],
    ["an array payload", { ...rawProposal(), payload: [] }, "payload"],
    ["a missing payload", { ...rawProposal(), payload: undefined }, "payload"],
    [
      "a short content_hash",
      { ...rawProposal(), content_hash: "abc" },
      "content_hash",
    ],
    [
      "an uppercase content_hash",
      { ...rawProposal(), content_hash: "A".repeat(64) },
      "content_hash",
    ],
    [
      "a bad created_at",
      { ...rawProposal(), created_at: "2026-02-30T00:00:00Z" },
      "created_at",
    ],
  ];

  for (const [name, input, field] of rejected) {
    test(name, () => {
      const result = validateProposal(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.some((e) => e.startsWith(field))).toBe(true);
    });
  }

  test("reports every broken field at once", () => {
    const result = validateProposal({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThanOrEqual(8);
  });
});
