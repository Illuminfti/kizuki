import { expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { blockquote, createRedactor, oneLine, redactValue } from "../../src/serving/redact";
import { SECRETS, TAG_TEXT } from "../helpers/synthetic-secrets";

const AGENT = { kind: "agent" } as const;

test("the owner's redactor strips hidden characters and leaves credential text alone", () => {
  const redactor = createRedactor(OWNER);
  expect(redactor.text(`${TAG_TEXT} ${SECRETS["ghp"]!.text}`)).toBe(`hiddentags and bidi controls ${SECRETS["ghp"]!.text}`);
  expect(redactor.counts).toEqual({});
});

test("an agent's redactor strips hidden characters first, so they cannot split a secret", () => {
  const redactor = createRedactor(AGENT);
  const split = `sk-${"a".repeat(10)}\u{E0041}${"a".repeat(14)}`;
  expect(redactor.text(split)).toBe("[redacted:api_token]");
  expect(redactor.counts).toEqual({ api_token: 1 });
});

test("redactValue copies nested structures and touches only strings", () => {
  const redactor = createRedactor(AGENT);
  const input = { id: "01ABC", n: 3, list: [`DB_PASSWORD=${"x".repeat(9)}`, { deep: SECRETS["jwt"]!.text }], nothing: null };
  const output = redactValue(redactor, input);
  expect(output).toEqual({ id: "01ABC", n: 3, list: ["DB_PASSWORD=[redacted:secret_assignment]", { deep: "[redacted:jwt]" }], nothing: null });
  expect(input.list[0]).toContain("xxxxxxxxx");
  expect(redactor.counts).toEqual({ secret_assignment: 1, jwt: 1 });
});

test("blockquote prefixes every line, blank ones included, whatever the line break", () => {
  expect(blockquote("a\n\nb\r\nc d e")).toBe("> a\n>\n> b\n> c\n> d\n> e");
});

test("oneLine keeps a label on one line", () => {
  expect(oneLine(" a\n- [page:x] b ")).toBe("a - [page:x] b");
});

test("an object of any shape is walked as JSON would serialize it", () => {
  class Row {
    label = `DB_PASSWORD=${"y".repeat(9)}`;
  }
  const redactor = createRedactor(AGENT);
  const output: unknown = redactValue<unknown>(redactor, { when: new Date(0), row: new Row() });
  expect(output).toEqual({ when: "1970-01-01T00:00:00.000Z", row: { label: "DB_PASSWORD=[redacted:secret_assignment]" } });
});
