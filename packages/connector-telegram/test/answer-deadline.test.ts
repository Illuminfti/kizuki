import { expect, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import { ANSWER_DEADLINE_MS, answeredWithin } from "../src/client";

test("an answer inside the deadline is returned and the client is kept", async () => {
  let abandoned = 0;
  expect(await answeredWithin(Promise.resolve("config"), 50, () => { abandoned += 1; })).toBe("config");
  await Bun.sleep(80);
  expect(abandoned).toBe(0);
});

test("a server that never answers is unreachable after the deadline and the client is abandoned", async () => {
  let abandoned = 0;
  const started = Date.now();
  let caught: unknown = null;
  try {
    await answeredWithin(new Promise<never>(() => {}), 40, () => { abandoned += 1; });
  } catch (error) {
    caught = error;
  }
  expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  expect(caught).toBeInstanceOf(TelegramConnectorError);
  expect((caught as TelegramConnectorError).code).toBe("unreachable");
  expect((caught as TelegramConnectorError).message).toBe("kizuki.telegram: telegram did not answer within 1s");
  expect(abandoned).toBe(1);
});

test("a refusal inside the deadline reaches the caller as it was raised", async () => {
  const refusal = new Error("AUTH_KEY_UNREGISTERED");
  let abandoned = 0;
  await expect(answeredWithin(Promise.reject(refusal), 50, () => { abandoned += 1; })).rejects.toBe(refusal);
  await Bun.sleep(80);
  expect(abandoned).toBe(0);
});

test("the deadline outlasts the library's own connection attempts and undercuts the host's batch deadline", () => {
  expect(ANSWER_DEADLINE_MS).toBeGreaterThan(3 * 10_000);
  expect(ANSWER_DEADLINE_MS).toBeLessThan(60_000);
});
