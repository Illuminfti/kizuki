import { expect, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import { classify, guarded } from "../src/guard";
import { PROVIDER, Rpc, Wait } from "./helpers";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function thrownBy(source: AsyncIterable<unknown>): Promise<unknown> {
  try {
    await collect(source);
  } catch (error) {
    return error;
  }
  return null;
}

test("a reported wait keeps its seconds through classification", () => {
  const error = classify(new Wait(42), PROVIDER);
  expect(error.code).toBe("flood_wait");
  expect(error.retry_after).toBe(42);
});

test("a dead session, a bad phone number and anything else are separated", () => {
  expect(classify(new Rpc("SESSION_REVOKED"), PROVIDER).code).toBe(
    "unauthenticated",
  );
  expect(classify(new Rpc("PHONE_NUMBER_INVALID"), PROVIDER).code).toBe(
    "invalid_phone",
  );
  expect(classify(new Rpc("CHAT_ID_INVALID"), PROVIDER).code).toBe(
    "parse_error",
  );
  expect(classify(new Error("socket hang up"), PROVIDER).code).toBe(
    "unreachable",
  );
});

test("an error this package already raised is passed through unchanged", () => {
  const original = new TelegramConnectorError("missing_session", "kizuki.telegram: no");
  expect(classify(original, PROVIDER)).toBe(original);
});

test("a wait raised part way through a page is normalised, not leaked", async () => {
  const page = async function* (): AsyncGenerator<number> {
    yield 1;
    yield 2;
    throw new Wait(30);
  };
  const error = await thrownBy(guarded(page, (item) => item, PROVIDER));
  expect(error).toBeInstanceOf(TelegramConnectorError);
  expect((error as TelegramConnectorError).code).toBe("flood_wait");
  expect((error as TelegramConnectorError).retry_after).toBe(30);
});

test("a page that refuses to open at all is normalised too", async () => {
  const error = await thrownBy(
    guarded(
      () => {
        throw new Rpc("CHANNEL_PRIVATE");
      },
      (item: unknown) => item,
      PROVIDER,
    ),
  );
  expect((error as TelegramConnectorError).code).toBe("parse_error");
});

test("a mapper that trips over a provider record does not escape raw", async () => {
  const page = async function* (): AsyncGenerator<number> {
    yield 1;
  };
  const error = await thrownBy(
    guarded(
      page,
      () => {
        throw new Rpc("PEER_ID_INVALID");
      },
      PROVIDER,
    ),
  );
  expect((error as TelegramConnectorError).code).toBe("parse_error");
});

test("records the mapper rejects are skipped and the rest are yielded", async () => {
  const page = async function* (): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  };
  const kept = await collect(
    guarded(page, (item) => (item === 2 ? null : item), PROVIDER),
  );
  expect(kept).toEqual([1, 3]);
});

test("abandoning a page closes the provider iterator", async () => {
  let closed = false;
  const page = async function* (): AsyncGenerator<number> {
    try {
      yield 1;
      yield 2;
    } finally {
      closed = true;
    }
  };
  for await (const item of guarded(page, (value) => value, PROVIDER)) {
    expect(item).toBe(1);
    break;
  }
  expect(closed).toBe(true);
});
