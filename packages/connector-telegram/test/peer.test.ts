import { expect, test } from "bun:test";
import { hasPublicHandle } from "../src/peer";

test("a live primary handle makes a channel public", () => {
  expect(hasPublicHandle({ username: "acme" })).toBe(true);
});

test("an alias counts only while telegram still says it is active", () => {
  expect(hasPublicHandle({ usernames: [{ username: "acme", active: true }] })).toBe(
    true,
  );
  expect(
    hasPublicHandle({ usernames: [{ username: "acme", active: false }] }),
  ).toBe(false);
  expect(hasPublicHandle({ usernames: [{ username: "acme" }] })).toBe(false);
  expect(
    hasPublicHandle({
      usernames: [
        { username: "old", active: false },
        { username: "acme", active: true },
      ],
    }),
  ).toBe(true);
});

test("an entity that says nothing usable fails closed to private", () => {
  expect(hasPublicHandle(null)).toBe(false);
  expect(hasPublicHandle("acme")).toBe(false);
  expect(hasPublicHandle({})).toBe(false);
  expect(hasPublicHandle({ username: "" })).toBe(false);
  expect(hasPublicHandle({ username: 7 })).toBe(false);
  expect(hasPublicHandle({ usernames: [] })).toBe(false);
  expect(hasPublicHandle({ usernames: "acme" })).toBe(false);
  expect(hasPublicHandle({ usernames: [null, 3, { active: true }] })).toBe(false);
  expect(
    hasPublicHandle({ usernames: [{ username: "acme", active: "yes" }] }),
  ).toBe(false);
});
