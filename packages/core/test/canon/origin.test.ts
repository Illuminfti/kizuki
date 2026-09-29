import { describe, expect, test } from "bun:test";
import { briefPath } from "../../src/serve/notifier-file";
import {
  AUTO_CANON_PREFIX,
  isDaemonBriefPath,
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

  test("the daemon's daily brief pages are machine origin; other dashboards stay human", () => {
    expect(isDaemonBriefPath("dashboards/brief-2026-09-17.md")).toBe(true);
    expect(isMachineOriginPath("dashboards/brief-2026-09-17.md")).toBe(true);
    expect(isMachineOriginPath("dashboards/weekly.md")).toBe(false);
    expect(isMachineOriginPath("dashboards/brief-2026-09-17.md.bak")).toBe(false);
    expect(isMachineOriginPath("notes/dashboards/brief-2026-09-17.md")).toBe(false);
    // The classifier and the writer agree on where the brief lives.
    expect(isDaemonBriefPath(briefPath("/vault", "2026-09-17").slice("/vault/".length))).toBe(true);
    // A loop create aimed at a brief path is still moved under auto/.
    expect(machineOriginPath("dashboards/brief-2026-09-17.md")).toBe("auto/dashboards/brief-2026-09-17.md");
  });
});
