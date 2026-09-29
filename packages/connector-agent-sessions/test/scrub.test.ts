import { expect, test } from "bun:test";
import {
  MAX_SCAN_CHARS,
  MAX_TEXT_BYTES,
  redact,
  sanitize,
  truncateUtf8,
} from "../src/scrub";

// Every credential below is a synthetic string shaped like the real thing.
const SECRETS: Record<string, string> = {
  pem:
    "-----BEGIN " +
    "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticsyntheticsynthetic\n-----END " +
    "RSA PRIVATE KEY-----",
  sk: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  github: "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789",
  slack: "xo" + "xb-1234567890-abcdefghijkl",
  aws: "AKI" + "AABCDEFGHIJKLMNOP",
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlc2lnbmF0dXJl",
  authorization: "Authorization: Bearer abcdef0123456789abcdef",
  bearer: "curl -H 'X-Auth: Bearer abcdefghijklmnop0123456789'",
  google: "AI" + "zaSyA-1234567890abcdefghijklmnopqrstu",
  url_credentials: "postgres://appuser:hunter2hunter2@db.example.test/app",
  assignment: ["API", "TOKEN"].join("_") + "=" + ["abcdef", "123456"].join(""),
};

test("each secret shape is replaced and counted", () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    const { text, redactions } = redact(`before ${secret} after`);
    expect(Object.keys(redactions)).toContain(
      kind === "bearer" ? "bearer" : kind,
    );
    expect(text).toContain("before ");
    expect(text).toContain(" after");
    for (const part of secret
      .split(/[\s=:]+/)
      .filter((piece) => piece.length > 12)) {
      expect(text).not.toContain(part);
    }
  }
});

test("assignments keep the name and survive as prose when they hold no secret", () => {
  expect(redact('"password": "correct-horse"').text).toBe(
    '"password": [redacted:assignment]',
  );
  expect(redact("DB_PASSWORD=abc123xyz").text).toBe(
    "DB_PASSWORD=[redacted:assignment]",
  );
  expect(redact("the token: string type").text).toBe("the token: string type");
  expect(redact("TOKEN=$OTHER_VAR").text).toBe("TOKEN=$OTHER_VAR");
});

test("text without secrets is untouched", () => {
  const plain = "We decided to keep the export format stable.";
  expect(redact(plain)).toEqual({ text: plain, redactions: {} });
});

test("terminal escapes, controls and bidi controls are removed", () => {
  const dirty =
    "\u001b[31mred\u001b[0m \u001b]8;;http://x.test\u0007link\u001b]8;;\u0007 a‮b⁦c⁩ d\u0000e\r\nf g";
  const { text, changed } = sanitize(dirty);
  expect(changed).toBe(true);
  expect(text).toBe("red link abc de\nf\ng");
});

test("unpaired surrogates become replacement characters", () => {
  expect(sanitize("a\ud800b").text).toBe("a�b");
  expect(sanitize("ok \u{1F600}").text).toBe("ok \u{1F600}");
});

test("truncation cuts at a character boundary inside the byte bound", () => {
  const text = "\u{1F600}".repeat(MAX_TEXT_BYTES);
  const cut = truncateUtf8(text, MAX_TEXT_BYTES);
  expect(cut.truncated).toBe(true);
  expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  expect(cut.text).not.toContain("�");
  expect(truncateUtf8("short", MAX_TEXT_BYTES)).toEqual({
    text: "short",
    truncated: false,
  });
});

test("redaction cost does not grow with adversarial line size", () => {
  const dotted = "a.".repeat(100_000) + " token";
  const repeated = "token".repeat(40_000) + " ";
  const dashed = "a-".repeat(100_000) + " secret=x";
  for (const input of [dotted, repeated, dashed]) {
    const started = performance.now();
    const { text } = redact(input);
    expect(performance.now() - started).toBeLessThan(250);
    expect(text.length).toBeLessThan(input.length);
  }
});

test("no token pattern is quadratic on a 200K adversarial line", () => {
  const inputs = [
    "-eyJaaaaaa".repeat(20_000),
    "eyJaaaaaaaa.".repeat(16_000),
    "eyJaaaaaaaa.bbbbbbbb.".repeat(10_000),
    "sk-".repeat(66_000),
    "Bearer ".repeat(30_000),
    "Authorization: ".repeat(14_000),
    "gh".repeat(100_000),
    "xoxb-".repeat(40_000),
    "AKIA".repeat(50_000),
    "AIza".repeat(50_000),
    "://".repeat(66_000),
    "://a:".repeat(40_000),
    ["-----BEGIN", "PRIVATE KEY-----"].join(" ").repeat(7_400),
  ];
  for (const input of inputs) {
    const started = performance.now();
    redact(input);
    expect(performance.now() - started).toBeLessThan(250);
  }
});

test("a secret split by the scan bound is not left as a prefix", () => {
  const filler = "word ".repeat(Math.ceil(MAX_SCAN_CHARS / 5));
  const secret = "AKI" + "AABCDEFGHIJKLMNOP";
  const cut = filler.slice(0, MAX_SCAN_CHARS - 10);
  const { text } = redact(cut + secret + " tail");
  expect(text).not.toContain("AKIAABCD");
});

test("zero-width and tag characters are removed and counted as a change", () => {
  const smuggled =
    "sk-​proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345 " +
    String.fromCodePoint(0xe0069, 0xe0067);
  const clean = sanitize(smuggled);
  expect(clean.changed).toBe(true);
  expect(clean.text).toBe("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345 ");
  expect(redact(clean.text).redactions).toEqual({ sk: 1 });
});
