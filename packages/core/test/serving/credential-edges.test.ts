import { expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { serveFixture, storeEvent } from "./helpers";

test("two-line credentials are scrubbed even when the first fragment is short", async () => {
  const f = await serveFixture();
  try {
    for (const first of [0, 1, 5, 51]) {
      const body = "A".repeat(52);
      const text = `kzk_${body.slice(0, first)}\n${body.slice(first)}`;
      const id = storeEvent(f.db, `wrapped-${first}`, "2026-02-28T10:30:00Z", text, "person:ada", "public");
      const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
      expect(answer.quoted[0]?.text).toBe("[redacted:api_token]");
      expect(answer.redacted).toEqual({ api_token: 1 });
    }
  } finally { f.dispose(); }
});

test("URL userinfo credentials without a password delimiter are scrubbed", async () => {
  const f = await serveFixture();
  try {
    const credential = "synthetic" + "Credential123";
    const id = storeEvent(f.db, "url-userinfo", "2026-02-28T10:30:00Z", `custom+app://${credential}@example.test/path`, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("custom+app://[redacted:url_credentials]@example.test/path");
    expect(answer.redacted).toEqual({ url_credentials: 1 });
  } finally { f.dispose(); }
});

test("YAML block scalar credentials are removed without consuming the next field", async () => {
  const f = await serveFixture();
  try {
    for (const indicator of ["|", ">-"]) {
      const secret = "synthetic" + "Credential123";
      const id = storeEvent(f.db, `yaml-block-${indicator.length}`, "2026-02-28T10:30:00Z",
        `client_secret: ${indicator}\n  ${secret}\n  continuedValue456\npublic_note: keep this`, "person:ada", "public");
      const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
      expect(answer.quoted[0]?.text).not.toContain(secret);
      expect(answer.quoted[0]?.text).not.toContain("continuedValue456");
      expect(answer.quoted[0]?.text).toContain("public_note: keep this");
      expect(answer.redacted).toEqual({ secret_assignment: 1 });
    }
  } finally { f.dispose(); }
});

test("short Authorization credentials and line-wrapped Bearer values retain capture scrub coverage", async () => {
  const f = await serveFixture();
  try {
    const value = "Q".repeat(20);
    const text = `Authorization: Basic q\nAuthorization: Token r\nAuthorization: Bearer s\nAuthorization: t\nBearer\n${value}`;
    const id = storeEvent(f.db, "authorization-short", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("Authorization: Basic [redacted:authorization]\nAuthorization: Token [redacted:authorization]\nAuthorization: Bearer [redacted:bearer]\nAuthorization: [redacted:authorization]\nBearer\n[redacted:bearer]");
    expect(answer.redacted).toEqual({ authorization: 3, bearer: 2 });
  } finally { f.dispose(); }
});
