import { expect, test } from "bun:test";
import { createRedactor } from "../../src/serving/redact";

test("assembly scrubs credentials newly formed across sanitized fields", () => {
  const value = "synthetic" + "Credential123";
  for (const parts of [
    ["password=", value],
    ["custom://", "reader:", value, "@example.test"],
    ["sk-", "A".repeat(24)],
    ["Authorization: Basic ", Buffer.from(`reader:${value}`).toString("base64")],
  ]) {
    const redactor = createRedactor({ kind: "agent" });
    const output = redactor.join(parts);
    expect(output).toContain("[redacted:");
    expect(Object.values(redactor.counts)).toEqual([1]);
    expect(redactor.text(output)).toBe(output);
  }
});

test("formatting and assembly preserve a clipped marker without recounting it", () => {
  const redactor = createRedactor({ kind: "agent" });
  const preview = redactor.text(`password=${"synthetic" + "Credential123"}`, { offset: 0, span: 15 });
  const quote = redactor.format(preview, (text) => `> ${text}\n`);
  const packet = redactor.join(["HEADER\n", quote]);
  expect(packet).toContain(preview);
  expect(redactor.text(packet)).toBe(packet);
  expect(redactor.counts).toEqual({ secret_assignment: 1 });
});
