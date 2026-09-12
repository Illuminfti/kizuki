import { afterEach, expect, test } from "bun:test";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";
import { insertClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import {
  PACKET_TOKENIZER_ID,
  serveContextPacket,
} from "../../src/serving/packet";
import { claimInput } from "../claims/helpers";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

const encoding = new Tiktoken(ranks);
const count = (text: string) => encoding.encode(text, [], []).length;
const CJK_UNIT = "知識と記憶は文脈によって変わります。中文检索保持来源。한국어문장도섞다。";

function cjkRun(codePoints: number): string {
  const unit = Array.from(CJK_UNIT);
  const out: string[] = [];
  while (out.length < codePoints) out.push(unit[out.length % unit.length] as string);
  return out.join("");
}

let fixture: Fixture | undefined;
afterEach(() => fixture?.dispose());

async function live() {
  fixture = await serveFixture();
  return fixture;
}

async function plantMixed(
  f: Fixture,
  page: { id: string; path: string; title: string; body: string; subject: string },
) {
  await recordedPage(
    f.db,
    f.vaultPath,
    page.path,
    {
      id: page.id,
      title: page.title,
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: [page.subject],
    },
    page.body,
    [f.events["public"] as string],
  );
  const allowedEvent = storeEvent(
    f.db,
    `rec-${page.id}-allowed`,
    "2026-09-11T12:00:00Z",
    "allowed-timeline-han kettle brief",
    page.subject,
    "public",
  );
  const secretEvent = storeEvent(
    f.db,
    `rec-${page.id}-secret`,
    "2026-09-11T13:00:00Z",
    "secret-han-private-orchard must not leak",
    page.subject,
    "private",
  );
  const allowedClaim = await insertClaim(
    { db: f.db },
    claimInput(f.events["public"] as string, {
      subject: page.subject,
      subjects: [page.subject],
      predicate: "employment.works_at",
      object: "allowed-claim-han",
      body: "Ada works at allowed-claim-han.",
      sensitivity: "public",
    }),
  );
  if (allowedClaim.outcome !== "stored") throw new Error(`allowed claim: ${allowedClaim.outcome}`);
  const allowedClaimId = allowedClaim.claim.claim_id;
  const secretClaim = await insertClaim(
    { db: f.db },
    claimInput(f.events["public"] as string, {
      subject: page.subject,
      subjects: [page.subject],
      predicate: "preference.prefers",
      object: "secret-han-claim-object",
      body: "Ada prefers secret-han-claim-object.",
      sensitivity: "private",
    }),
  );
  if (secretClaim.outcome !== "stored") throw new Error(`secret claim: ${secretClaim.outcome}`);
  const secretClaimId = secretClaim.claim.claim_id;
  rebuildDerived(f.db, f.vaultPath);
  return {
    allowedEvent,
    secretEvent,
    allowedClaimId,
    secretClaimId,
  };
}

test("a 600-code-point CJK canon atom at default 450 still packs later allowed evidence", async () => {
  const f = await live();
  const body = cjkRun(600);
  expect(Array.from(body)).toHaveLength(600);
  const planted = await plantMixed(f, {
    id: "fact:han-packet-canon",
    path: "facts/han-packet-canon.md",
    title: "HanPacketCanon",
    body,
    subject: "person:han-packet",
  });
  const envelope = await serveContextPacket(f.agent("reader-public"), {
    query: "HanPacketCanon",
    include: ["canon", "timeline", "claims"],
    subjects: ["person:han-packet"],
    since: "2026-09-10T00:00:00Z",
    until: "2026-09-13T00:00:00Z",
  });
  const data = envelope.data!;
  expect(data.budget_tokens).toBe(450);
  expect(data.tokenizer).toBe(PACKET_TOKENIZER_ID);
  expect(data.tokens_estimate).toBe(count(data.packet_md));
  expect(count(data.packet_md)).toBeLessThanOrEqual(450);
  expect(data.packet_md.startsWith("KIZUKI CONTEXT v1\n")).toBe(true);
  expect(data.packet_md.split("\n").length).toBeGreaterThan(3);
  expect(data.packet_md).toContain("## canon");
  expect(data.packet_md).toContain("[page:fact:han-packet-canon]");
  expect(data.packet_md).toContain("allowed-timeline-han");
  expect(data.packet_md).toContain("allowed-claim-han");
  expect(data.packet_md).toContain(planted.allowedEvent);
  expect(data.sections.canon).toBeGreaterThan(0);
  expect(data.sections.timeline).toBeGreaterThan(0);
  expect(data.sections.claims).toBeGreaterThan(0);
  const han = envelope.canon.find((chunk) => chunk.page_id === "fact:han-packet-canon");
  expect(han).toBeDefined();
  expect(han!.truncated).toBe(true);
  expect(body.startsWith(han!.excerpt)).toBe(true);
  expect(Array.from(han!.excerpt).length).toBeLessThan(600);
  expect(data.packet_md).toContain(han!.excerpt.slice(0, 12));
  const rendered = JSON.stringify(envelope);
  expect(rendered).not.toContain("secret-han-private-orchard");
  expect(rendered).not.toContain("secret-han-claim-object");
  expect(rendered).not.toContain(planted.secretEvent);
  expect(rendered).not.toContain(planted.secretClaimId);
});

test("a dense CJK title is projected so later allowed evidence can still pack at 450", async () => {
  const f = await live();
  const title = cjkRun(400);
  expect(Array.from(title)).toHaveLength(400);
  const planted = await plantMixed(f, {
    id: "fact:han-title-canon",
    path: "facts/han-title-canon.md",
    title,
    body: "HanTitleCanon dense-title body.",
    subject: "person:han-title",
  });
  const envelope = await serveContextPacket(f.agent("reader-public"), {
    query: "HanTitleCanon",
    include: ["canon", "timeline", "claims"],
    subjects: ["person:han-title"],
    since: "2026-09-10T00:00:00Z",
    until: "2026-09-13T00:00:00Z",
  });
  const data = envelope.data!;
  expect(data.budget_tokens).toBe(450);
  expect(data.tokens_estimate).toBe(count(data.packet_md));
  expect(count(data.packet_md)).toBeLessThanOrEqual(450);
  expect(data.packet_md).toContain("[page:fact:han-title-canon]");
  expect(data.packet_md).toContain("allowed-timeline-han");
  expect(data.packet_md).toContain("allowed-claim-han");
  expect(data.sections.timeline).toBeGreaterThan(0);
  expect(data.sections.claims).toBeGreaterThan(0);
  const han = envelope.canon.find((chunk) => chunk.page_id === "fact:han-title-canon");
  expect(han).toBeDefined();
  expect(han!.truncated).toBe(true);
  expect(title.startsWith(han!.title)).toBe(true);
  expect(Array.from(han!.title).length).toBeLessThan(400);
  const rendered = JSON.stringify(envelope);
  expect(rendered).not.toContain("secret-han-private-orchard");
  expect(rendered).not.toContain("secret-han-claim-object");
  expect(rendered).not.toContain(planted.secretEvent);
  expect(rendered).not.toContain(planted.secretClaimId);
});
