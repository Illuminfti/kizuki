import { describe, expect, test } from "bun:test";
import type { CaptureEvent } from "../../src/contracts/event";
import type { SyncBatch } from "../../src/contracts/connector";
import {
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
} from "../../src/contracts/page-candidate";
import { runBatch } from "../../src/ingest/run";
import { CONVERSATION_EVENT_KINDS } from "../../src/staging/budget";
import { proposalsForEvent } from "../../src/staging/producers";
import { event, memoryDb } from "./helpers";
import { validEvent } from "../fixtures";
import { listClaims } from "../../src/claims/store";

const SESSION = "kizuki.claude-code-sessions";

function message(
  index: number,
  overrides: Partial<CaptureEvent> = {},
): CaptureEvent {
  return event({
    event_id: `evt-${index}`,
    connector_id: SESSION,
    source_record_id: `session-1/${index}`,
    kind: "message",
    occurred_at: "2026-09-01T09:00:00Z",
    text: `turn ${index}: ${"the migration plan changed. ".repeat(20)}`,
    subjects: [
      { subject_id: "session-role:user", role: "from" },
      {
        subject_id: "project:0123456789ab",
        role: "about",
        display_name: "app",
      },
    ],
    ...overrides,
  });
}

describe("conversational events are evidence, not capture notes", () => {
  test("5,000 session messages on one day file no capture note", () => {
    let notes = 0;
    let bytes = 0;
    const targets = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) {
      for (const proposal of proposalsForEvent(message(index))) {
        if (proposal.kind === "claim") notes += 1;
        if (proposal.target != null) targets.add(proposal.target);
        bytes += proposal.body.length;
      }
    }
    expect(notes).toBe(0);
    expect([...targets].some((target) => target.startsWith("captures/"))).toBe(
      false,
    );
    // Only the two shared subject stubs remain, each a few dozen bytes per event.
    expect(targets.size).toBe(2);
    expect(bytes / 5_000).toBeLessThan(256);
  });

  test("emails and every other conversational kind are treated the same way", () => {
    expect([...CONVERSATION_EVENT_KINDS]).toEqual(["message", "email"]);
    for (const kind of CONVERSATION_EVENT_KINDS) {
      const proposals = proposalsForEvent(
        event({ kind, connector_id: "kizuki.imap" }),
      );
      expect(proposals.map((proposal) => proposal.kind)).toEqual(["entity"]);
    }
  });

  test("entity stubs for the speakers are still proposed", () => {
    const proposals = proposalsForEvent(message(1));
    expect(proposals.map((proposal) => proposal.kind)).toEqual([
      "entity",
      "entity",
    ]);
    expect(proposals.map((proposal) => proposal.target)).toEqual([
      "kizuki.claude-code-sessions/session-role/user",
      "kizuki.claude-code-sessions/project/0123456789ab",
    ]);
  });

  test("page-kind events keep the capture note exactly", () => {
    for (const kind of ["file", "page"]) {
      const proposals = proposalsForEvent(
        event({
          kind,
          connector_id: "kizuki.markdown-folder",
          text: "line one\n\nline two",
        }),
      );
      const note = proposals.find((proposal) => proposal.kind === "claim");
      expect(note?.target).toBe("captures/kizuki.markdown-folder/2026-02-28");
      expect(note?.body).toBe(
        `Captured from \`kizuki.markdown-folder\` (${kind}) at 2026-02-28T10:30:00Z.\n\n> line one\n>\n> line two`,
      );
      expect(note?.frontmatter).toEqual({
        type: "source",
        title: "Capture from kizuki.markdown-folder at 2026-02-28T10:30:00Z",
        "x-connector": "kizuki.markdown-folder",
        "x-capture-kind": kind,
      });
    }
  });

  test("a message that proposes its own typed page under a grant still files that page", () => {
    const metadata = {
      [PAGE_CANDIDATE_KEY]: {
        schema: PAGE_CANDIDATE_SCHEMA,
        type: "person",
        title: "Ada",
        target: "entities/ada",
        extensions: {},
        confidence: 1,
      },
    };
    const proposals = proposalsForEvent(message(1, { metadata }), {
      page_candidates: true,
    });
    expect(proposals.map((proposal) => proposal.target)).toContain(
      "entities/ada",
    );
    expect(
      proposals.filter((proposal) =>
        (proposal.target ?? "").startsWith("captures/"),
      ),
    ).toEqual([]);
  });

  test("a batch of messages through ingest stores every event and stages no capture claim", () => {
    const db = memoryDb([]);
    const events = Array.from({ length: 40 }, (_, index) => ({
      ...validEvent(),
      connector_id: SESSION,
      source_record_id: `session-1/${index}`,
      text: `turn ${index} of a working session`,
      occurred_at: "2026-09-01T09:00:00Z",
    }));
    const batch: SyncBatch = { events, cursor: null };
    const run = runBatch(db, batch, { page_candidates: false });
    expect(run.errors).toEqual([]);
    expect(run.stored).toBe(40);
    const claims = listClaims(db, { limit: 1000 });
    expect(claims.filter((claim) => claim.kind === "claim")).toEqual([]);
    expect(
      claims.filter((claim) => (claim.target ?? "").startsWith("captures/")),
    ).toEqual([]);
  });
});
