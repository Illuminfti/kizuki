import { expect, test } from "bun:test";
import type {
  ClaimV2Assertion,
  ClaimV2IdentityControl,
  ClaimV2Semantic,
} from "../../src/contracts/claim-v2";
import {
  CLAIM_V2_SCHEMA,
  validateClaimV2Semantic,
} from "../../src/contracts/claim-v2";
import { semanticKey, supportKey } from "../../src/claims/claim-v2-keys";

const EVENT_ID = "01JCV2KEYSAAAAAAAAAAAAAAA1";
const OTHER_EVENT_ID = "01JCV2KEYSAAAAAAAAAAAAAAA2";
const DIGEST = "1".repeat(64);

function assertion(
  overrides: Partial<ClaimV2Assertion> = {},
): ClaimV2Assertion {
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "assertion",
    subject: { kind: "occurrence", id: "occ-grace" },
    predicate: "role.holds",
    object: { kind: "literal", value: "partnerships lead" },
    perspective: {
      holder: { kind: "occurrence", id: "occ-grace" },
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      anchors: [{ event_id: EVENT_ID, start_utf16: 0, end_utf16: 5 }],
    },
    context: [
      { kind: "occurrence", id: "ctx-acme" },
      { kind: "supplied", id: "ctx-work" },
    ],
    polarity: "positive",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    temporal_basis: "explicit",
    anchors: [{ event_id: EVENT_ID, start_utf16: 0, end_utf16: 12 }],
    ...overrides,
  };
}

/** Every fixture the key tests compare must be a payload Core would accept. */
test("the key fixtures are valid claim/v2 payloads", () => {
  expect(validateClaimV2Semantic(assertion()).ok).toBe(true);
});

test("the semantic key ignores fields RFC 0003 excludes from claim identity", () => {
  const base = assertion();
  const expected = semanticKey(base);

  // The frozen DTO carries none of these; the key must read only what it names,
  // so an extra property riding on the object cannot change claim identity.
  const withBody = {
    ...base,
    body: "Grace leads partnerships at Acme.",
  } as unknown as ClaimV2Semantic;
  expect(semanticKey(withBody)).toBe(expected);

  const withAlias = {
    ...base,
    display_alias: "Gracie",
  } as unknown as ClaimV2Semantic;
  expect(semanticKey(withAlias)).toBe(expected);

  const withScore = {
    ...base,
    model_score: 0.42,
  } as unknown as ClaimV2Semantic;
  expect(semanticKey(withScore)).toBe(expected);

  const withAuthority = {
    ...base,
    authority: "owner_correction",
  } as unknown as ClaimV2Semantic;
  expect(semanticKey(withAuthority)).toBe(expected);
});

test("evidence position corroborates instead of forking the semantic key", () => {
  const base = assertion();
  const elsewhere = assertion({
    anchors: [{ event_id: OTHER_EVENT_ID, start_utf16: 40, end_utf16: 52 }],
    perspective: {
      ...base.perspective,
      anchors: [{ event_id: OTHER_EVENT_ID, start_utf16: 40, end_utf16: 45 }],
    },
  });
  expect(validateClaimV2Semantic(elsewhere).ok).toBe(true);
  expect(semanticKey(elsewhere)).toBe(semanticKey(base));
});

test("the semantic key separates meaning-bearing differences", () => {
  const base = assertion();
  const expected = semanticKey(base);

  expect(semanticKey(assertion({ predicate: "role.held" }))).not.toBe(expected);
  expect(semanticKey(assertion({ polarity: "negative" }))).not.toBe(expected);
  expect(
    semanticKey(
      assertion({ context: [{ kind: "supplied", id: "ctx-hobby" }] }),
    ),
  ).not.toBe(expected);
  expect(semanticKey(assertion({ context: [] }))).not.toBe(expected);
  expect(
    semanticKey(assertion({ valid_from: "2026-02-01T00:00:00.000Z" })),
  ).not.toBe(expected);
  expect(
    semanticKey(assertion({ valid_to: "2026-06-01T00:00:00.000Z" })),
  ).not.toBe(expected);
  expect(
    semanticKey(
      assertion({
        valid_from: null,
        valid_to: null,
        temporal_basis: "unknown",
      }),
    ),
  ).not.toBe(expected);
  expect(
    semanticKey(assertion({ subject: { kind: "supplied", id: "occ-grace" } })),
  ).not.toBe(expected);
  expect(
    semanticKey(
      assertion({
        object: {
          kind: "subject",
          ref: { kind: "occurrence", id: "occ-role" },
        },
      }),
    ),
  ).not.toBe(expected);
  expect(
    semanticKey(
      assertion({ perspective: { ...base.perspective, mode: "reported" } }),
    ),
  ).not.toBe(expected);
  expect(
    semanticKey(
      assertion({
        perspective: { ...base.perspective, interpretation: "inferred" },
      }),
    ),
  ).not.toBe(expected);
});

test("context array order does not change the semantic key", () => {
  const base = assertion();
  const reversed = assertion({ context: [...base.context].reverse() });
  expect(semanticKey(reversed)).toBe(semanticKey(base));
});

test("length delimiting keeps adjacent fields from being confused", () => {
  const left = assertion({
    subject: { kind: "occurrence", id: "ab" },
    predicate: "c.d",
  });
  const right = assertion({
    subject: { kind: "occurrence", id: "a" },
    predicate: "bc.d",
  });
  expect(semanticKey(left)).not.toBe(semanticKey(right));
});

function identityControl(
  overrides: Partial<ClaimV2IdentityControl> = {},
): ClaimV2IdentityControl {
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "identity_control",
    change: {
      action: "merge",
      left: { kind: "occurrence", id: "occ-a" },
      right: { kind: "occurrence", id: "occ-b" },
    },
    expected_component_digest: DIGEST,
    policy_version: "identity.policy.v1",
    ...overrides,
  };
}

test("identity controls key on their canonical action, digest and policy", () => {
  expect(validateClaimV2Semantic(identityControl()).ok).toBe(true);
  const expected = semanticKey(identityControl());
  expect(semanticKey(identityControl())).toBe(expected);
  expect(
    semanticKey(identityControl({ policy_version: "identity.policy.v2" })),
  ).not.toBe(expected);
  expect(
    semanticKey(identityControl({ expected_component_digest: "2".repeat(64) })),
  ).not.toBe(expected);
  expect(
    semanticKey(
      identityControl({
        change: {
          action: "merge",
          left: { kind: "occurrence", id: "occ-a" },
          right: { kind: "occurrence", id: "occ-c" },
        },
      }),
    ),
  ).not.toBe(expected);
  // The two discriminators live in the same domain and must not collide.
  expect(semanticKey(identityControl())).not.toBe(semanticKey(assertion()));
});

const SEMANTIC = semanticKey(assertion());

function supportInput(
  overrides: Partial<Parameters<typeof supportKey>[0]> = {},
) {
  return {
    semantic_key: SEMANTIC,
    source_key: "src-mail",
    grant_revision: 1,
    events: [{ event_id: EVENT_ID, event_content_hash: "a".repeat(64) }],
    anchors: [{ event_id: EVENT_ID, start_utf16: 3, end_utf16: 9 }],
    ...overrides,
  };
}

test("the same event and UTF-16 span yields the same support key", () => {
  expect(supportKey(supportInput())).toBe(supportKey(supportInput()));
  expect(
    supportKey(
      supportInput({
        anchors: [
          { event_id: EVENT_ID, start_utf16: 3, end_utf16: 9 },
          { event_id: OTHER_EVENT_ID, start_utf16: 1, end_utf16: 4 },
        ],
      }),
    ),
  ).toBe(
    supportKey(
      supportInput({
        anchors: [
          { event_id: OTHER_EVENT_ID, start_utf16: 1, end_utf16: 4 },
          { event_id: EVENT_ID, start_utf16: 3, end_utf16: 9 },
        ],
      }),
    ),
  );
});

test("the support key separates spans, events, sources and semantics", () => {
  const expected = supportKey(supportInput());
  expect(
    supportKey(
      supportInput({
        anchors: [{ event_id: EVENT_ID, start_utf16: 4, end_utf16: 9 }],
      }),
    ),
  ).not.toBe(expected);
  expect(
    supportKey(
      supportInput({
        anchors: [{ event_id: EVENT_ID, start_utf16: 3, end_utf16: 10 }],
      }),
    ),
  ).not.toBe(expected);
  expect(
    supportKey(
      supportInput({
        anchors: [{ event_id: OTHER_EVENT_ID, start_utf16: 3, end_utf16: 9 }],
      }),
    ),
  ).not.toBe(expected);
  expect(
    supportKey(
      supportInput({
        events: [
          { event_id: OTHER_EVENT_ID, event_content_hash: "a".repeat(64) },
        ],
      }),
    ),
  ).not.toBe(expected);
  expect(
    supportKey(
      supportInput({
        events: [{ event_id: EVENT_ID, event_content_hash: "b".repeat(64) }],
      }),
    ),
  ).not.toBe(expected);
  expect(supportKey(supportInput({ source_key: "src-chat" }))).not.toBe(
    expected,
  );
  expect(supportKey(supportInput({ grant_revision: 2 }))).not.toBe(expected);
  expect(
    supportKey(supportInput({ semantic_key: semanticKey(identityControl()) })),
  ).not.toBe(expected);
});

test("semantic and support identities stay in separate domains", () => {
  expect(supportKey(supportInput())).not.toBe(SEMANTIC);
});
