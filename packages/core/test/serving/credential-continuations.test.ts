import { expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { serveFixture, storeEvent } from "./helpers";

test("a variable-length token's long second line stays private after a recognizable first line", async () => {
  const f = await serveFixture();
  try {
    for (const prefix of ["sk-", "gh" + "p_", "xa" + "pp-"]) {
      const text = `${prefix}${"A".repeat(24)}\n${"B".repeat(24)}\nnext line: keep this`;
      const id = storeEvent(f.db, `continued-${prefix}`, "2026-02-28T10:30:00Z", text, "person:ada", "public");
      const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
      expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\nnext line: keep this");
      expect(answer.redacted).toEqual({ api_token: 1 });
    }
  } finally { f.dispose(); }
});

test("a complete token leaves the next line's short prose and sibling assignment intact", async () => {
  const f = await serveFixture();
  try {
    const text = `gh${"p_"}${"A".repeat(36)}\nnext line\npassword=${"synthetic" + "Credential123"}`;
    const id = storeEvent(f.db, "token-next-line", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\nnext line\npassword=[redacted:secret_assignment]");
    expect(answer.redacted).toEqual({ api_token: 1, secret_assignment: 1 });
  } finally { f.dispose(); }
});

test("PEM headers re-flowed immediately after BEGIN and END remain private", async () => {
  const f = await serveFixture();
  try {
    const text = ["-----BEGIN", "PRIVATE KEY-----", "A".repeat(64), "-----END", "PRIVATE KEY-----", "next line: keep this"].join("\n");
    const id = storeEvent(f.db, "pem-delimiter-wrap", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:pem]\nnext line: keep this");
    expect(answer.redacted).toEqual({ pem: 1 });
  } finally { f.dispose(); }
});

test("complete tokens on consecutive lines remain two distinct redactions", async () => {
  const f = await serveFixture();
  try {
    const text = [`sk-${"A".repeat(24)}`, "gh" + `p_${"B".repeat(36)}`].join("\n");
    const id = storeEvent(f.db, "distinct-tokens", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\n[redacted:api_token]");
    expect(answer.redacted).toEqual({ api_token: 2 });
  } finally { f.dispose(); }
});

test("a complete token followed by a JWT keeps each credential's redaction kind", async () => {
  const f = await serveFixture();
  try {
    const jwt = `eyJ${"h".repeat(24)}.${"p".repeat(12)}.${"s".repeat(12)}`;
    const text = [`sk-${"A".repeat(24)}`, jwt].join("\n");
    const id = storeEvent(f.db, "token-then-jwt", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\n[redacted:jwt]");
    expect(answer.redacted).toEqual({ api_token: 1, jwt: 1 });
  } finally { f.dispose(); }
});

test("a complete token followed by a re-flowed PEM keeps both redaction kinds", async () => {
  const f = await serveFixture();
  try {
    const text = [`sk-${"A".repeat(24)}`, "-----BEGIN", "PRIVATE KEY-----", "A".repeat(64), "-----END PRIVATE", "KEY-----"].join("\n");
    const id = storeEvent(f.db, "token-then-pem", "2026-02-28T10:30:00Z", text, "person:ada", "public");
    const answer = serveTimeline(f.agent("reader-public"), { event_id: id });
    expect(answer.quoted[0]?.text).toBe("[redacted:api_token]\n[redacted:pem]");
    expect(answer.redacted).toEqual({ api_token: 1, pem: 1 });
  } finally { f.dispose(); }
});
