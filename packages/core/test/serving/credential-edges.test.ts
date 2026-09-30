import { expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { serveFixture, storeEvent } from "./helpers";

test("two-line credentials are scrubbed even when the first fragment is short", async () => {
  const f = await serveFixture();
  try {
    for (const first of [0, 1, 5, 51]) {
      for (const suffix of ["", "Q"]) {
        const body = "A".repeat(52);
        const text = `kzk_${body.slice(0, first)}\n${body.slice(first)}${suffix}`;
        const id = storeEvent(f.db, `wrapped-${first}-${suffix.length}`, "2026-02-28T10:30:00Z", text, "person:ada", "public");
        const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
        expect(answer.quoted[0]?.text).toBe("[redacted:api_token]");
        expect(answer.redacted).toEqual({ api_token: 1 });
      }
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

test("an invalid outer prefix cannot hide a credential wrapped inside it", async () => {
  const f = await serveFixture();
  try {
    const text = `kzk_sk-${"A".repeat(12)}\n${"A".repeat(12)}`;
    const id = storeEvent(f.db, "wrapped-nested-prefix", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:api_token]");
    expect(answer.redacted).toEqual({ api_token: 1 });
  } finally { f.dispose(); }
});

test("encoded URL userinfo is scrubbed before decoding changes its delimiters", async () => {
  const f = await serveFixture();
  try {
    const password = encodeURIComponent(["p/q", "r s"].join("@"));
    const id = storeEvent(f.db, "url-encoded-userinfo", "2026-02-28T10:30:00Z",
      `custom://reader:${password}@example.test/path`, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("custom://[redacted:url_credentials]@example.test/path");
    expect(answer.redacted).toEqual({ url_credentials: 1 });
  } finally { f.dispose(); }
});

test("URL passwords are scrubbed when the username is empty", async () => {
  const f = await serveFixture();
  try {
    const value = "synthetic" + "Credential123";
    const id = storeEvent(f.db, "url-password-only", "2026-02-28T10:30:00Z",
      `redis://:${value}@example.test/0`, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("redis://[redacted:url_credentials]@example.test/0");
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
    const short = ["q", "r", "s", "t"];
    const text = `Authorization: Basic ${short[0]}\nAuthorization: Token ${short[1]}\nAuthorization: Bearer ${short[2]}\nAuthorization: ${short[3]}\nBearer\n${value}`;
    const id = storeEvent(f.db, "authorization-short", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("Authorization: Basic [redacted:authorization]\nAuthorization: Token [redacted:authorization]\nAuthorization: Bearer [redacted:bearer]\nAuthorization: [redacted:authorization]\nBearer\n[redacted:bearer]");
    expect(answer.redacted).toEqual({ authorization: 3, bearer: 2 });
  } finally { f.dispose(); }
});
