import { describe, expect, test } from "bun:test";
import {
  AUTO_CANON_PREFIX,
  isMachineOriginPath,
  machineOriginPath,
} from "../../src/canon/origin";

describe("machine-origin canon paths", () => {
  test("loop creates are prefixed; already-prefixed paths stay put", () => {
    expect(AUTO_CANON_PREFIX).toBe("auto");
    expect(machineOriginPath("people/grace.md")).toBe("auto/people/grace.md");
    expect(machineOriginPath("auto/people/grace.md")).toBe("auto/people/grace.md");
    expect(isMachineOriginPath("auto/people/grace.md")).toBe(true);
    expect(isMachineOriginPath("people/grace.md")).toBe(false);
    expect(isMachineOriginPath("auto")).toBe(true);
    expect(isMachineOriginPath("autograph.md")).toBe(false);
  });
});
