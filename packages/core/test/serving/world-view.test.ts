import { openLedger } from "../../src/ledger/db";
import { expect, test } from "bun:test";
import { OWNER } from "../../src/agents/types";
import {
  WorldViewError,
  readWorldView,
} from "../../src/serving/world-view";

const AT = "2026-01-02T00:00:00.000Z";
const FROM = "2026-01-01T00:00:00.000Z";

function token(fill: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, () => fill)).toString(
    "base64url",
  );
}

const OBJECT = token(1);
const SNAPSHOT = token(2);

function ctx() {
  return {
    db: openLedger(":memory:"),
    vaultPath: "/tmp/kizuki-world-view-test",
    principal: OWNER,
  };
}

function situationInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    operation: "situation",
    situation: { kind: "object", token: OBJECT },
    valid: { kind: "all" },
    knownAt: { kind: "current" },
    ...overrides,
  };
}

test("an absent situation is not_found", () => {
  expect(readWorldView(ctx(), situationInput())).toEqual({ status: "not_found" });
});

test("an absent concept is not_found", () => {
  expect(
    readWorldView(ctx(), {
      operation: "concept",
      concept: { kind: "object", token: OBJECT },
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    }),
  ).toEqual({ status: "not_found" });
});

test("unknown extra keys are refused", () => {
  expect(() => readWorldView(ctx(), situationInput({ extra: true }))).toThrow(
    WorldViewError,
  );
});

test("a malformed wire token is refused", () => {
  expect(() =>
    readWorldView(
      ctx(),
      situationInput({ situation: { kind: "object", token: "not-a-token" } }),
    ),
  ).toThrow(WorldViewError);
});

test("overlap validity must end after it starts", () => {
  expect(() =>
    readWorldView(
      ctx(),
      situationInput({ valid: { kind: "overlap", from: AT, until: FROM } }),
    ),
  ).toThrow(WorldViewError);
});

test("a snapshot knownAt explicitly reports unavailable history", () => {
  expect(
    readWorldView(
      ctx(),
      situationInput({
        knownAt: { kind: "snapshot", ref: { kind: "snapshot", token: SNAPSHOT } },
      }),
    ),
  ).toEqual({ schema:"kizuki.world-view/v1",operation:"situation",result:{status:"unavailable",reason:"history"} });
});

 test("noncanonical base64 pad bits are refused",()=> {
  const alias="A".repeat(42)+"B";
  expect(()=>readWorldView(ctx(),situationInput({situation:{kind:"object",token:alias}}))).toThrow(WorldViewError);
});
