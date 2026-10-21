import { expect, test } from "bun:test";
import { scrubText } from "../../src/producer/scrub";

test("YAML secret blocks respect explicit indentation and stop at sibling fields", () => {
  const value = "synthetic" + "Credential123";
  for (const indicator of ["|2-", ">+2"]) {
    const input = `config:\n  client_secret: ${indicator}\n      ${value}\n    continuedValue456\n  public_note: keep this`;
    const scrubbed = scrubText(input);
    expect(scrubbed.text).toBe("config:\n  client_secret: [redacted:secret_assignment]\n  public_note: keep this");
    expect(scrubbed.redactions).toHaveLength(1);
    expect(scrubText(scrubbed.text).redactions).toEqual([]);
  }
});

test("nested assignment-looking lines in a YAML secret block count once", () => {
  const input = `client_secret: |\n  token: |\n    ${"synthetic" + "Credential123"}\npublic_note: keep this`;
  const scrubbed = scrubText(input);
  expect(scrubbed.text).toBe("client_secret: [redacted:secret_assignment]\npublic_note: keep this");
  expect(scrubbed.redactions).toHaveLength(1);
});

test("a wrapped token detector leaves the next assignment's name and anchors intact", () => {
  const key = `sk-${"A".repeat(24)}`;
  const scrubbed = scrubText(`key ${key}\nDB_PASSWORD=${"synthetic" + "Credential123"}`);
  expect(scrubbed.text).toBe("key [redacted:api_token]\nDB_PASSWORD=[redacted:secret_assignment]");
  const first = scrubbed.redactions[0]!;
  expect(first.end - first.start).toBe(key.length);
});
