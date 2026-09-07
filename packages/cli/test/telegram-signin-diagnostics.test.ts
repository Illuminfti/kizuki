import { expect, test } from "bun:test";
import { TelegramConnectorError } from "@kizuki/connector-telegram";
import { UsageError } from "../src/args";
import { ConnectionError } from "../src/connections";
import { telegramFailure, telegramSignInIo } from "../src/commands/connect-telegram";
import type { CliIo } from "../src/commands";

const CANCELLED = "interactive sign-in cancelled";
const WAIT_120 = "Telegram asked you to wait 120s before retrying.";
const WAIT_UNSPECIFIED = "Telegram asked you to wait before retrying.";
const CONNECTIVITY = "Telegram sign-in failed. Check connectivity and retry without changing the selected source.";
const INCOMPLETE = "Telegram sign-in did not complete; existing source state was preserved.";

function io(prompt: () => Promise<string>): CliIo {
  return {
    env: {},
    vaultOverride: null,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    out() {},
    err() {},
    prompt,
  };
}

test("local cancellation keeps UsageError wording for CLI dispatch", () => {
  const error = telegramFailure(new UsageError(CANCELLED));
  expect(error).toBeInstanceOf(UsageError);
  expect(error).not.toBeInstanceOf(ConnectionError);
  expect(error.message).toBe(CANCELLED);
});

test("a wrapped prompt exception still uses the locally observed cancellation", async () => {
  const signIn = telegramSignInIo(io(async () => {
    throw new UsageError(CANCELLED);
  }));
  await expect(signIn.prompt("Code Telegram sent you: ")).rejects.toBeInstanceOf(UsageError);
  expect(signIn.cancelled()).toBe(true);
  const wrapped = new TelegramConnectorError("unreachable", "kizuki.telegram: telegram is unreachable");
  const error = telegramFailure(wrapped, signIn.cancelled());
  expect(error).toBeInstanceOf(UsageError);
  expect(error.message).toBe(CANCELLED);
  expect(error.message).not.toContain("connectivity");
  expect(telegramFailure(wrapped).message).toBe(CONNECTIVITY);
});

test("unknown prompt errors stay sanitized and are not remembered as cancellation", async () => {
  const signIn = telegramSignInIo(io(async () => {
    throw new Error("SYNTHETIC_PHONE_SECRET");
  }));
  await expect(signIn.prompt("Telegram phone number: ")).rejects.toThrow("SYNTHETIC_PHONE_SECRET");
  expect(signIn.cancelled()).toBe(false);
  const error = telegramFailure(new Error("SYNTHETIC_PHONE_SECRET"), signIn.cancelled());
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.message).toBe(INCOMPLETE);
  expect(error.message).not.toContain("SYNTHETIC_PHONE_SECRET");
});

test("invalid terminal input is not reclassified as cancellation", async () => {
  const invalid = new UsageError("interactive sign-in received invalid terminal input");
  const signIn = telegramSignInIo(io(async () => {
    throw invalid;
  }));
  await expect(signIn.prompt("Telegram phone number: ")).rejects.toBe(invalid);
  expect(signIn.cancelled()).toBe(false);
  const error = telegramFailure(invalid, signIn.cancelled());
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.message).toBe(INCOMPLETE);
  expect(error.message).not.toBe(CANCELLED);
});

test("classified flood wait with retry_after=120 keeps duration-specific wording", () => {
  const error = telegramFailure(new TelegramConnectorError(
    "flood_wait",
    "kizuki.telegram: telegram asked us to wait 120s",
    { retry_after: 120 },
  ));
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.message).toBe(WAIT_120);
  expect(error.message).toContain("120s");
  expect(error.message).not.toContain("connectivity");
});

test("classified flood wait without a usable duration keeps wait wording and invents no count", () => {
  const cases = [
    new TelegramConnectorError("flood_wait", "kizuki.telegram: telegram asked us to wait, without saying how long"),
    new TelegramConnectorError("flood_wait", "kizuki.telegram: telegram asked us to wait 0s", { retry_after: 0 }),
    new TelegramConnectorError("flood_wait", "kizuki.telegram: telegram asked us to wait", { retry_after: Number.NaN }),
  ];
  for (const classified of cases) {
    const error = telegramFailure(classified);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(WAIT_UNSPECIFIED);
    expect(error.message).not.toMatch(/\d+s/);
    expect(error.message).not.toContain("connectivity");
    expect(error.message).not.toBe(CONNECTIVITY);
  }
});

test("ordinary unreachable errors keep the generic connectivity diagnostic", () => {
  const error = telegramFailure(new TelegramConnectorError(
    "unreachable",
    "kizuki.telegram: telegram is unreachable",
  ));
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.message).toBe(CONNECTIVITY);
  expect(error.message).not.toBe(WAIT_UNSPECIFIED);
  expect(error.message).not.toBe(CANCELLED);
});
