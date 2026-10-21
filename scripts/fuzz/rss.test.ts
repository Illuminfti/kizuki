import { expect, test } from "bun:test";
import { rssFromStatus } from "./rss";

test("RSS accounting recognizes exit_mm before the task becomes a zombie", () => {
  expect(rssFromStatus("State:\tR (running)\n", 4)).toBe(0);
  expect(rssFromStatus("State:\tZ (zombie)\n")).toBe(0);
  expect(rssFromStatus("State:\tR (running)\nVmHWM:\t2048 kB\n", 4)).toBe(2048);
});

test("missing or malformed RSS of a live worker still fails closed", () => {
  for (const status of ["", "State:\tR (running)\n", "VmHWM:\tinvalid kB\n", "VmHWM:\t0 kB\n"]) {
    expect(() => rssFromStatus(status)).toThrow("rss-accounting-failed");
  }
});
