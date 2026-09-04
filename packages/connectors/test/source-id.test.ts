import { expect, test } from "bun:test";
import { encodeSourceRecordId } from "../src/source-id";
import { jsonNestingDepth, parseBoundedJsonArray } from "../src/import-json";
import { KizukiError } from "../src";

test("length-prefixed ids do not collide across slash boundaries", () => {
  expect(encodeSourceRecordId(["a/b", "c"])).not.toBe(
    encodeSourceRecordId(["a", "b/c"]),
  );
  expect(encodeSourceRecordId(["conversation-1", "node"])).toBe(
    "v1:2:14:conversation-1:4:node",
  );
});

test("deep JSON is refused before parse", () => {
  let nest = '"x"';
  for (let depth = 0; depth < 70; depth += 1) nest = `[${nest}]`;
  expect(jsonNestingDepth(nest)).toBeGreaterThan(64);
  try {
    parseBoundedJsonArray(nest, "fixture");
    throw new Error("expected parseBoundedJsonArray to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(KizukiError);
    if (!(error instanceof KizukiError)) return;
    expect(error.message).toContain("nesting");
  }
});
