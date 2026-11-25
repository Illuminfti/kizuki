import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { accept } from "../../src/ledger/ledger";
import { rebuildSearch } from "../../src/search";
import { createRedactor } from "../../src/serving/redact";
import { serveContextPacketV2 } from "../../src/serving/packet";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import type { SliceItem } from "../../src/contracts/world-slice";
import { compilePacketUnits, packetSliceBudget } from "../../src/world/slice/compile";
import { queryTerms, sliceItemRelevance } from "../../src/world/slice/relevance";
import { OWNER } from "../../src/agents";
import { validEvent } from "../fixtures";
import { cardFixture } from "./card-fixture";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";

beforeEach(() => setSystemTime(new Date("2026-10-21T12:00:00.000Z")));
afterEach(() => setSystemTime());

const purposes = ["capture", "derive", "recall", "session", "export", "correction"] as const;
const sliceItems = (body: string): SliceItem[] =>
  body.split("\n").filter(line => line.includes(" :: slice ")).map(line => JSON.parse(line.split(" :: slice ")[1]!));

test("compilePacketUnits enforces the share cap while allowing the first required unit up to full budget", () => {
  const within = (c: readonly number[], d: readonly number[], limit: number) =>
    [...c, ...d].reduce((sum, n) => sum + n, 0) <= limit;
  expect(packetSliceBudget(100, 2000)).toBe(1240);

  // Share cap holds when multiple required units exceed shareLimit.
  const multi = compilePacketUnits([600, 600], [100], within, 1000, 2000);
  expect(multi.constraints).toEqual([600]);
  expect(multi.detail).toEqual([100]);
  expect(multi.overflow).toBe(true);
  expect(multi.truncated).toBe(true);

  // Single required unit larger than shareLimit still fits up to fullLimit.
  const narrow = compilePacketUnits([700], [100], within, 500, 1000);
  expect(narrow.constraints).toEqual([700]);
  expect(narrow.detail).toEqual([]);
  expect(narrow.overflow).toBe(false);
  expect(narrow.truncated).toBe(true);

  // Required unit larger than fullLimit overflows cleanly with empty constraints.
  const tooSmall = compilePacketUnits([700], [100], within, 250, 450);
  expect(tooSmall.constraints).toEqual([]);
  expect(tooSmall.detail).toEqual([100]);
  expect(tooSmall.overflow).toBe(true);
  expect(tooSmall.truncated).toBe(true);
});

test("sliceItemRelevance scores visible terms and ignores redacted text", () => {
  const token = "A".repeat(43);
  const item: SliceItem = {
    kind: "situation",
    node: { kind: "object", token },
    relation: {
      schema: "kizuki.relation/v1",
      claim: { kind: "claim", token },
      subject: { kind: "object", token },
      predicate: "situation.blocker",
      object: { kind: "literal", value: "Verify culvert drainage before winter" },
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", evidence: [] },
      context: [],
      polarity: "positive",
      valid: { kind: "unknown" },
      temporalBasis: "unknown",
      assessments: [],
      conflict: "none_observed",
    },
    evidence: [],
  };
  const terms = queryTerms("the Harbor culvert drainage");
  expect(terms).toEqual(["harbor", "culvert", "drainage"]);
  const plain = createRedactor(OWNER, []);
  expect(sliceItemRelevance(item, terms, plain, ["Harbor"])).toBe(3);
  const redacted = createRedactor(OWNER, ["culvert", "Harbor"]);
  expect(sliceItemRelevance(item, terms, redacted, ["Harbor"])).toBe(1);
});

test("recall ranks query-matching required relations first and reserves packet room for captures", async () => {
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL, purposes: [...purposes] });
  try {
    const subject = "project:harbor";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
    await f.write("situation.label", { kind: "literal", value: "Harbor" }, { subject });
    await f.write("situation.blocker", { kind: "literal", value: "Await generic checklist approval." }, { subject });
    await f.write("situation.commitment", { kind: "literal", value: "Inspect spillway gates by Friday." }, { subject });
    await f.write("situation.commitment", { kind: "literal", value: "Publish annual harbor report." }, { subject });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const at = "2026-10-20T12:00:00.000Z";
    const captured = accept(f.db, {
      ...validEvent(),
      connector_id: "card.fixture",
      source_record_id: "harbor-capture-note",
      occurred_at: at,
      observed_at: at,
      text: "Harbor spillway inspection log confirms valve readiness.",
      sensitivity_hint: "public",
      subjects: [{ subject_id: subject, role: "about" }],
    }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
    expect(captured.status).toBe("stored");
    rebuildSearch(f.db, f.ctx.vaultPath);

    const response = await serveContextPacketV2(f.ctx, { purpose: "recall", query: "Harbor spillway", budget_tokens: 2000 });
    if (!response.data || !("data" in response.data.result)) throw new Error("packet missing");
    const packet = response.data.result.data;
    const items = sliceItems(packet.packetMd);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.relation.object).toEqual({ kind: "literal", value: "Inspect spillway gates by Friday." });
    expect(packet.packetMd).toContain("Harbor spillway inspection log confirms valve readiness.");
    expect(packet.tokens).toBe(packetTokens(packet.packetMd));
    expect(packet.tokens).toBeLessThanOrEqual(2000);
  } finally {
    f.dispose();
  }
}, 120_000);
