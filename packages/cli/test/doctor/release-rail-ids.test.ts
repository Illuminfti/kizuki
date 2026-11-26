import { expect, test } from "bun:test";
import { RAIL_IDS } from "../../../core/src/serve/rail-registry";
import { RELEASE_RAIL_IDS } from "../../../../scripts/release-rails";

test("release scripts expect exactly the registered rails", () => {
  expect([...RELEASE_RAIL_IDS]).toEqual([...RAIL_IDS]);
});
