import { describe, expect, test } from "bun:test";
import { CLAIM_V2_SCHEMA, validateClaimV2Semantic, type ClaimV2Assertion, type ClaimV2IdentityControl } from "../../src/contracts/claim-v2";

const semantic = {
  schema: CLAIM_V2_SCHEMA,
  discriminator: "assertion",
  subject: { kind: "occurrence", id: "occ-1" },
  predicate: "classification.instance_of",
  object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } },
  perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
  context: [],
  polarity: "positive",
  valid_from: null,
  valid_to: null,
  temporal_basis: "unknown",
  anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }],
} satisfies ClaimV2Assertion;

describe("claim v2 semantic payload", () => {
  test("accepts a discriminated ordinary assertion", () => {
    expect(validateClaimV2Semantic(semantic)).toEqual({ ok: true, value: semantic });
  });

  test("rejects invalid temporal combinations and unnormalized context", () => {
    expect(validateClaimV2Semantic({ ...semantic, temporal_basis: "unknown", valid_from: "2026-01-01T00:00:00Z" })).toMatchObject({ ok: false });
    expect(validateClaimV2Semantic({ ...semantic, context: [{ kind: "supplied", id: "b" }, { kind: "supplied", id: "a" }] })).toMatchObject({ ok: false });
  });

  test("rejects a reversed interval ending at a leap second", () => {
    expect(validateClaimV2Semantic({
      ...semantic,
      temporal_basis: "explicit",
      valid_from: "2017-01-01T00:00:00Z",
      valid_to: "2016-12-31T23:59:60Z",
    })).toMatchObject({ ok: false });
  });

  test("accepts an increasing interval within one millisecond", () => {
    expect(validateClaimV2Semantic({
      ...semantic,
      temporal_basis: "explicit",
      valid_from: "2026-01-01T00:00:00.0001Z",
      valid_to: "2026-01-01T00:00:00.0002Z",
    })).toMatchObject({ ok: true });
  });

  test("rejects equal interval endpoints with different UTC offsets", () => {
    expect(validateClaimV2Semantic({
      ...semantic,
      temporal_basis: "explicit",
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-01-01T01:00:00+01:00",
    })).toMatchObject({ ok: false });
  });

  test("accepts bounded identity controls but does not confuse them with assertions", () => {
    const control = {
      schema: CLAIM_V2_SCHEMA,
      discriminator: "identity_control",
      change: { action: "merge", left: { kind: "occurrence", id: "occ-1" }, right: { kind: "supplied", id: "s0" } },
      expected_component_digest: "a".repeat(64),
      policy_version: "identity/v1",
    } satisfies ClaimV2IdentityControl;
    expect(validateClaimV2Semantic(control)).toEqual({ ok: true, value: control });
    expect(validateClaimV2Semantic({ ...control, change: { ...control.change, action: "identity.same_as" } })).toMatchObject({ ok: false });
  });

  test("requires attribution anchors for named holders, speakers, and addressees", () => {
    const named = structuredClone(semantic) as any;
    named.perspective.holder = { kind: "supplied", id: "s0" };
    expect(validateClaimV2Semantic(named)).toMatchObject({ ok: false });
  });

  test("accepts ingress-valid colon refs and snapshots mutable or accessor input", () => {
    const long = `person:${"a".repeat(200)}`;
    const mutable = structuredClone(semantic) as any;
    mutable.subject = { kind: "supplied", id: long };
    const parsed = validateClaimV2Semantic(mutable);
    expect(parsed).toMatchObject({ ok: true, value: { subject: { id: long } } });
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBe(true);
    const accessor = { ...semantic } as Record<string, unknown>;
    Object.defineProperty(accessor, "subject", { enumerable: true, get() { throw Error("must not run"); } });
    expect(validateClaimV2Semantic(accessor)).toEqual({ ok: false, errors: ["invalid claim/v2 payload"] });
  });

  test("requires canonical merge endpoints and bounded, normalized partitions", () => {
    const control = { schema: CLAIM_V2_SCHEMA, discriminator: "identity_control", change: { action: "merge", left: { kind: "occurrence", id: "occ:1" }, right: { kind: "supplied", id: "person:grace" } }, expected_component_digest: "a".repeat(64), policy_version: "identity/v1" } as const;
    expect(validateClaimV2Semantic(control)).toMatchObject({ ok: true });
    expect(validateClaimV2Semantic({ ...control, change: { ...control.change, left: control.change.right, right: control.change.left } })).toMatchObject({ ok: false });
    const partitions = Array.from({ length: 17 }, (_, index) => [{ kind: "supplied" as const, id: `person:${index}` }]);
    expect(validateClaimV2Semantic({ ...control, change: { action: "separate", partitions } })).toMatchObject({ ok: false });
    expect(validateClaimV2Semantic({ ...control, change: { action: "separate", partitions: [
      [{ kind: "supplied", id: "person:a" }, { kind: "supplied", id: "person:b" }],
      [{ kind: "supplied", id: "person:b" }, { kind: "supplied", id: "person:c" }],
    ] } })).toMatchObject({ ok: false });
  });

  test("snapshot failures and unresolved observed dates cannot escape as valid durable semantics", () => {
    const proxy = new Proxy({}, { getPrototypeOf() { throw Error("synthetic-private-claim-canary"); } });
    expect(validateClaimV2Semantic(proxy)).toEqual({ ok: false, errors: ["invalid claim/v2 payload"] });
    expect(validateClaimV2Semantic({ ...semantic, temporal_basis: "observed" })).toMatchObject({ ok: false });
    expect(validateClaimV2Semantic({ ...semantic, temporal_basis: "observed", valid_from: "2026-01-01T00:00:00Z" })).toMatchObject({ ok: true });
    expect(validateClaimV2Semantic({ ...semantic, subject: { kind: "supplied", id: "" } }).ok).toBe(false);
    expect(validateClaimV2Semantic({ ...semantic, anchors: [{ event_id: "event:forged", start_utf16: 0, end_utf16: 4 }] }).ok).toBe(false);
  });

  test("the full bounded partition accepts ingress-sized refs and rejects one extra member", () => {
    const refs = Array.from({ length: 257 }, (_, index) => ({ kind: "supplied" as const,
      id: `person:${String(index).padStart(3, "0")}:${"x".repeat(1013)}` }));
    const control = { schema: CLAIM_V2_SCHEMA, discriminator: "identity_control", expected_component_digest: "a".repeat(64), policy_version: "identity/v1" };
    expect(validateClaimV2Semantic({ ...control, change: { action: "separate", partitions: [refs.slice(0, 128), refs.slice(128, 256)] } }).ok).toBe(true);
    expect(validateClaimV2Semantic({ ...control, change: { action: "separate", partitions: [refs.slice(0, 128), refs.slice(128)] } }).ok).toBe(false);
  });
});
