import { expect, test } from "bun:test";
import {
  REDACTION_KINDS,
  boundScrubText,
  fromScrubbedOffset,
  scrubText,
  toScrubbedOffset,
} from "../../src/producer/scrub";

const rep = (char: string, count: number): string => char.repeat(count);
const SK = `sk-${rep("a", 24)}`;
const GHP = `ghp_${rep("B", 36)}`;
const PAT = `github_pat_${rep("C", 30)}`;
const SLACK = `xoxb-${rep("1", 12)}-${rep("d", 12)}`;
const AWS = `AKIA${rep("Q", 16)}`;
const JWT = `eyJ${rep("h", 12)}.eyJ${rep("p", 12)}.${rep("s", 12)}`;
const DASHES = rep("-", 5);
const pemEdge = (edge: string, label: string): string => `${DASHES}${edge} ${label}${DASHES}`;
const PEM = `${pemEdge("BEGIN", "PRIVATE KEY")}\n${rep("Z", 64)}\n${rep("Y", 64)}\n${pemEdge("END", "PRIVATE KEY")}`;

test("token shapes are replaced with a kind marker and counted", () => {
  for (const [secret, kind] of [[SK, "api_token"], [GHP, "api_token"], [PAT, "api_token"], [SLACK, "api_token"], [AWS, "api_token"], [JWT, "jwt"], [PEM, "pem"]] as const) {
    const scrubbed = scrubText(`before ${secret} after`);
    expect(scrubbed.text).toBe(`before [redacted:${kind}] after`);
    expect(scrubbed.text).not.toContain(secret);
    expect(scrubbed.redactions.map(item => item.kind)).toEqual([kind]);
  }
});

test("bearer values and secret-named assignments keep their names and lose their values", () => {
  expect(scrubText(`Authorization: Bearer ${rep("q", 20)}`).text).toBe("Authorization: Bearer [redacted:bearer]");
  expect(scrubText(`-H "authorization: bearer ${rep("q", 20)}"`).text).toBe('-H "authorization: bearer [redacted:bearer]"');
  expect(scrubText("DB_PASSWORD=hunter2hunter2").text).toBe("DB_PASSWORD=[redacted:secret_assignment]");
  expect(scrubText('client_secret = "abc def"').text).toBe('client_secret = "[redacted:secret_assignment]"');
  expect(scrubText("MY_API_KEY='zzzzzzzz'").text).toBe("MY_API_KEY='[redacted:secret_assignment]'");
  expect(scrubText("auth_token=xyz12345").text).toBe("auth_token=[redacted:secret_assignment]");
  expect(scrubText("APIKEY=xyz12345").text).toBe("APIKEY=[redacted:secret_assignment]");
});

test("a token inside an assignment is one redaction of the more specific kind", () => {
  const scrubbed = scrubText(`GITHUB_TOKEN=${GHP}\nnext line`);
  expect(scrubbed.text).toBe("GITHUB_TOKEN=[redacted:api_token]\nnext line");
  expect(scrubbed.redactions).toHaveLength(1);
});

test("a bearer JWT is one jwt redaction", () => {
  const scrubbed = scrubText(`Authorization: Bearer ${JWT}`);
  expect(scrubbed.text).not.toContain("eyJ");
  expect(scrubbed.redactions).toHaveLength(1);
});

test("an unterminated PEM block is redacted to the end of the text", () => {
  const scrubbed = scrubText(`note\n${pemEdge("BEGIN", "RSA PRIVATE KEY")}\n${rep("Z", 40)}`);
  expect(scrubbed.text).toBe("note\n[redacted:pem]");
});

const TWELVE = "abandon ability able absorb accident account acid across action actor actress adapt";

test("runs of 12 or 24 lowercase words are redacted as seed phrases, prose is left alone", () => {
  const twentyFour = `${TWELVE} ${TWELVE.split(" ").reverse().join(" ")}`;
  expect(scrubText(`seed: ${TWELVE}.`).text).toBe("seed: [redacted:seed_phrase].");
  expect(scrubText(`seed: ${twentyFour}.`).text).toBe("seed: [redacted:seed_phrase].");
  const eleven = TWELVE.split(" ").slice(0, 11).join(" ");
  expect(scrubText(`words: ${eleven}.`).text).toBe(`words: ${eleven}.`);
  for (const prose of [
    "we should talk about the plan for the launch and then ship it after lunch",
    "there were many reasons that this happened during their long weekend trip",
  ]) expect(scrubText(prose).text).toBe(prose);
});

test("a seed phrase inside a sentence is redacted whole, with no word left behind", () => {
  for (const text of [
    `my seed is ${TWELVE}`,
    `recovery phrase ${TWELVE}`,
    `to ${TWELVE}`,
    `${TWELVE} and then more`,
    `seed: ${TWELVE} thanks`,
    `the wallet seed is ${TWELVE} and the backup is elsewhere`,
  ]) {
    const scrubbed = scrubText(text);
    for (const word of TWELVE.split(" ")) expect(scrubbed.text).not.toContain(word);
    expect(scrubbed.redactions.map(item => item.kind)).toEqual(["seed_phrase"]);
  }
  expect(scrubText(`${TWELVE} and then more`).text).toBe("[redacted:seed_phrase] and then more");
});

test("a seed phrase split by commas or newlines is redacted, a wrapped prose paragraph is not", () => {
  expect(scrubText(`seed: ${TWELVE.split(" ").join(", ")}.`).text).toBe("seed: [redacted:seed_phrase].");
  expect(scrubText(`seed:\n${TWELVE.split(" ").join("\n")}\n\nnext`).text).toBe("seed:\n[redacted:seed_phrase]\n\nnext");
  const wrapped = "we went over the plan that the team wrote and then\nthey said the launch would slip until the vendor shipped";
  expect(scrubText(wrapped).text).toBe(wrapped);
});

test("a long name, a long value and a value with a comma cannot hide a secret assignment", () => {
  const longName = `${rep("A", 45)}_TOKEN=${rep("v", 12)}`;
  expect(scrubText(longName).text).toBe(`${rep("A", 45)}_TOKEN=[redacted:secret_assignment]`);
  expect(scrubText(`password="${rep("a", 300)}" done`).text).toBe('password="[redacted:secret_assignment]" done');
  expect(scrubText(`API_KEY=${rep("a", 300)} done`).text).toBe("API_KEY=[redacted:secret_assignment] done");
  expect(scrubText("password=abc,def123ghi next").text).toBe("password=[redacted:secret_assignment] next");
  expect(scrubText(`password="${rep("a", 10)}\u{1F600}${rep("b", 10)}"`).text).toBe('password="[redacted:secret_assignment]"');
});

test("token counters and short numeric values are not secrets", () => {
  const text = "set max_tokens=4096 and tokens=1000, then token_count=42";
  expect(scrubText(text).text).toBe(text);
  expect(scrubText("password=12345678").text).toBe("password=[redacted:secret_assignment]");
  expect(scrubText("auth_token=98765432").text).toBe("auth_token=[redacted:secret_assignment]");
});

test("ordinary text, short values and public shapes pass through unchanged", () => {
  for (const text of [
    "Mira joined Northwind on Tuesday.",
    "The token economy is discussed in chapter 3.",
    "password reset email sent",
    "Bearer authentication is described in the spec",
    "task-force meeting notes; sk-short; ghp_short",
    "TOKEN_COUNT=42",
    "See https://example.com/a?b=c for details",
  ]) {
    const scrubbed = scrubText(text);
    expect(scrubbed.text).toBe(text);
    expect(scrubbed.redactions).toEqual([]);
  }
});

test("redactions report original and scrubbed offsets and every kind is declared", () => {
  const text = `a ${SK} b ${AWS} c`;
  const scrubbed = scrubText(text);
  expect(scrubbed.text).toBe("a [redacted:api_token] b [redacted:api_token] c");
  const [first, second] = scrubbed.redactions;
  expect(text.slice(first!.start, first!.end)).toBe(SK);
  expect(scrubbed.text.slice(first!.out_start, first!.out_end)).toBe("[redacted:api_token]");
  expect(text.slice(second!.start, second!.end)).toBe(AWS);
  expect(scrubbed.text.slice(second!.out_start, second!.out_end)).toBe("[redacted:api_token]");
  for (const item of scrubbed.redactions) expect(REDACTION_KINDS).toContain(item.kind);
});

test("offsets map both ways and never split a redaction", () => {
  const text = `ab ${SK} cd`;
  const scrubbed = scrubText(text);
  const marker = "[redacted:api_token]";
  const inMarker = scrubbed.redactions[0]!.out_start + 3;
  expect(toScrubbedOffset(scrubbed.redactions, 0, "start")).toBe(0);
  expect(toScrubbedOffset(scrubbed.redactions, 3, "start")).toBe(3);
  expect(toScrubbedOffset(scrubbed.redactions, 3 + SK.length, "end")).toBe(3 + marker.length);
  expect(toScrubbedOffset(scrubbed.redactions, 3 + 5, "start")).toBe(3);
  expect(toScrubbedOffset(scrubbed.redactions, 3 + 5, "end")).toBe(3 + marker.length);
  expect(toScrubbedOffset(scrubbed.redactions, text.length, "end")).toBe(scrubbed.text.length);
  expect(fromScrubbedOffset(scrubbed.redactions, 3, "start")).toBe(3);
  expect(fromScrubbedOffset(scrubbed.redactions, inMarker, "start")).toBe(3);
  expect(fromScrubbedOffset(scrubbed.redactions, inMarker, "end")).toBe(3 + SK.length);
  expect(fromScrubbedOffset(scrubbed.redactions, 3 + marker.length, "start")).toBe(3 + SK.length);
  expect(fromScrubbedOffset(scrubbed.redactions, scrubbed.text.length, "end")).toBe(text.length);
});

test("encoded and invisible credential forms preserve original anchor offsets", () => {
  const value = "a".repeat(24);
  for (const secret of [`sk-${value.slice(0, 10)}${String.fromCodePoint(0x200b)}${value.slice(10)}`, encodeURIComponent(`sk-${value}`).replace("sk-", "sk%2D")]) {
    const source = `before ${secret} after`;
    const scrubbed = scrubText(source);
    expect(scrubbed.text).toBe("before [redacted:api_token] after");
    const span = scrubbed.redactions[0]!;
    expect(source.slice(span.start, span.end)).toBe(secret);
    expect(fromScrubbedOffset(scrubbed.redactions, scrubbed.text.length, "end")).toBe(source.length);
  }
  const encodedInvisible = `sk-${"a".repeat(10)}${encodeURIComponent(String.fromCodePoint(0x200b))}${"a".repeat(14)}`;
  expect(scrubText(encodedInvisible).text).toBe("[redacted:api_token]");
});

test("a second scrub is idempotent, but a forged marker cannot hide a credential suffix", () => {
  const once = scrubText(`password=${"a".repeat(12)}`);
  expect(scrubText(once.text).redactions).toEqual([]);
  expect(scrubText("password=[redacted:secret_assignment]extra123").text).toBe("password=[redacted:secret_assignment]");
  for (const source of [`Authorization: Bearer ${rep("q", 20)}`, `Authorization: Basic ${rep("q", 20)}`, "postgres://svc:syntheticPass123@example.test/app"]) {
    const first = scrubText(source);
    expect(scrubText(first.text).redactions).toEqual([]);
  }
});

test("PEM scanning stops at non-key packet text and handles re-flowed headers", () => {
  const header = pemEdge("BEGIN", "PRIVATE\nKEY");
  const source = `${header}\n${"Z".repeat(32)}\nnext packet line: visible`;
  expect(scrubText(source).text).toBe("[redacted:pem]next packet line: visible");
  expect(scrubText(`${pemEdge("BEGIN", "X")} field end\nnext packet line`).text)
    .toBe("[redacted:pem] field end\nnext packet line");
});

test("named JSON and YAML credentials include short values and quoted dollar values", () => {
  for (const source of ["password: abc", '"password": "$example"', "auth_token=1234", "api key: abc", `password=${"\n".repeat(1100)}syntheticValue123`]) {
    const scrubbed = scrubText(source);
    expect(scrubbed.redactions).toHaveLength(1);
    expect(scrubbed.text).toContain("[redacted:secret_assignment]");
  }
});

test("a scan cutoff cannot expose the first half of a wrapped credential", () => {
  const first = `sk-${"a".repeat(10)}`;
  const prefix = `ordinary note\n${first}\n`;
  const bounded = boundScrubText(prefix + "B".repeat(24) + " tail", prefix.length + 5);
  expect(scrubText(bounded.text).text).not.toContain(first);
});

test("complete PEM keys include legacy metadata lines", () => {
  const source = [pemEdge("BEGIN", "RSA PRIVATE KEY"), "Proc-Type: 4,ENCRYPTED", "DEK-Info: SYNTHETIC,ABCDEF", "", "Z".repeat(64), pemEdge("END", "RSA PRIVATE KEY")].join("\n");
  expect(scrubText(`before ${source} after`).text).toBe("before [redacted:pem] after");
});

test("authorization without a scheme keeps the session connector's protection", () => {
  const value = "synthetic" + "Credential123";
  expect(scrubText(`Authorization: ${value}`).text).not.toContain(value);
});

test("surrounding prose cannot hide a recognizable credential prefix", () => {
  const credential = `kzk_${rep("A", 52)}`;
  expect(scrubText(`note${credential}tail`).text).not.toContain(credential);
});
