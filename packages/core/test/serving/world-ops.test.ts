import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withWorldOps } from "@kizuki/core/testing";
import {
  WORLD_DESCRIBE_SCHEMA,
  WORLD_OPS,
  WorldViewError,
  activeWorldOps,
  readWorldView,
  serveWorldView,
  worldOpInputKeys,
  worldOpRegistry,
} from "@kizuki/core/world";
import type { BuildOp, ClaimsOp, WorldOp } from "@kizuki/core/world";
import { purgeEvents } from "../../src/ledger/purge";
import { ServeError } from "../../src/serving/types";
import { worldFixture } from "./world-fixture";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";
import { PING_INPUT, PING_SCHEMA, pingOp } from "./world-test-op";

setDefaultTimeout(60_000);

let fixture: Fixture;
beforeAll(async () => {
  fixture = await serveFixture();
});
afterAll(() => fixture.dispose());

const DESCRIBE = { operation: "describe" };

describe("the operation registry", () => {
  test("registers the shipped operations and describe, in a stable order", () => {
    expect(WORLD_OPS.map((op) => op.name)).toEqual([
      "find_concepts",
      "find_situations",
      "concept",
      "situation",
      "describe",
      "evidence",
    ]);
  });

  test("every operation declares a parse, a run, its keys and a data schema id", () => {
    for (const op of WORLD_OPS) {
      expect(typeof op.run).toBe("function");
      if (op.source === "claims") expect(typeof op.parse).toBe("function");
      expect(op.dataSchemas.length).toBeGreaterThan(0);
      expect(worldOpInputKeys(op)[0]).toBe("operation");
    }
  });

  test("an operation missing a piece is refused when the registry is built", () => {
    const whole = pingOp as WorldOp;
    expect(() => worldOpRegistry([whole])).not.toThrow();
    expect(() => worldOpRegistry([whole, whole])).toThrow(/duplicate/);
    expect(() => worldOpRegistry([{ ...pingOp, name: "" }])).toThrow(/name/);
    expect(() => worldOpRegistry([{ ...pingOp, dataSchemas: [] as unknown as readonly [string] }])).toThrow(/data schema/);
    expect(() => worldOpRegistry([{ ...pingOp, parse: undefined } as unknown as WorldOp])).toThrow(/parse/);
    expect(() => worldOpRegistry([{ ...pingOp, run: undefined } as unknown as WorldOp])).toThrow(/run/);
    expect(() => worldOpRegistry([{ ...pingOp, keys: { required: ["valid"], optional: [] } }])).toThrow(/common key/);
  });

  test("a test-only operation routes through Core inside one transaction with no edit to the reader", async () => {
    const ctx = fixture.owner();
    expect(() => readWorldView(ctx, PING_INPUT)).toThrow(WorldViewError);
    await withWorldOps([pingOp], () => {
      const result = readWorldView(ctx, PING_INPUT);
      expect(result as unknown).toEqual({
        schema: "kizuki.world-view/v1",
        operation: "ping",
        result: {
          status: "current",
          view: { status: "not_issued" },
          data: { schema: PING_SCHEMA, echo: "hello", inTransaction: true },
        },
      });
      expect(() => readWorldView(ctx, { ...PING_INPUT, text: 3 })).toThrow(WorldViewError);
      expect(() => readWorldView(ctx, { ...PING_INPUT, extra: 1 })).toThrow(WorldViewError);
      const { valid: _valid, ...bare } = PING_INPUT;
      expect(() => readWorldView(ctx, bare)).toThrow(WorldViewError);
      const envelope = serveWorldView(ctx, { ...PING_INPUT });
      expect(envelope.schema).toBe("kizuki.envelope/v2");
      expect(envelope.data).toMatchObject({ operation: "ping" });
    });
    expect(() => readWorldView(ctx, PING_INPUT)).toThrow(WorldViewError);
  });

  test("an operation that reads claims answers history for a past time cutoff before it runs", async () => {
    await withWorldOps([pingOp], () => {
      const result = readWorldView(fixture.owner(), {
        ...PING_INPUT,
        knownAt: { kind: "time", at: "2026-01-01T00:00:00.000Z" },
      });
      expect(result).toEqual({
        schema: "kizuki.world-view/v1",
        operation: "ping",
        result: { status: "unavailable", reason: "history" },
      });
    });
  });

  test("a body whose schema the operation did not declare fails closed on Core and HTTP alike", async () => {
    const wrong: ClaimsOp<{ text: string }> = {
      ...pingOp,
      name: "wrong",
      run: () => ({ status: "data", data: { schema: "kizuki.test-undeclared/v1" }, gaps: null }),
    };
    await withWorldOps([wrong], () => {
      const input = { ...PING_INPUT, operation: "wrong" };
      expect(() => readWorldView(fixture.owner(), input)).toThrow(ServeError);
      expect(() => serveWorldView(fixture.owner(), { ...input })).toThrow(ServeError);
    });
  });

  test("withWorldOps refuses an overlapping use and restores the shipped registry however it ends", async () => {
    const other: WorldOp = { ...pingOp, name: "other" } as WorldOp;
    const seen = () => activeWorldOps().map((op) => op.name);
    const first = withWorldOps([pingOp], async () => {
      await Promise.resolve();
      expect(() => withWorldOps([other], () => 0)).toThrow(/sequential-only/);
      expect(seen()).toContain("ping");
      expect(seen()).not.toContain("other");
    });
    expect(() => withWorldOps([other], () => 0)).toThrow(/sequential-only/);
    await first;
    expect(seen()).toEqual(WORLD_OPS.map((op) => op.name));
    expect(() => withWorldOps([pingOp], () => { throw new Error("boom"); })).toThrow("boom");
    await expect(withWorldOps([pingOp], async () => { throw new Error("late"); })).rejects.toThrow("late");
    expect(seen()).toEqual(WORLD_OPS.map((op) => op.name));
  });

  test("no source file outside the test seam imports withWorldOps", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..");
    const offenders: string[] = [];
    for (const file of new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scanSync({ cwd: root })) {
      if (file === "packages/core/src/testing.ts" || file === "packages/core/src/world/ops/registry.ts") continue;
      if (readFileSync(join(root, file), "utf8").includes("withWorldOps")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("a result over the response bound is unavailable, never a partial body", async () => {
    const big: ClaimsOp<{ text: string }> = {
      ...pingOp,
      name: "big",
      run: () => ({ status: "data", data: { schema: PING_SCHEMA, blob: "x".repeat(300 * 1024) }, gaps: null }),
    };
    await withWorldOps([big], () => {
      expect(readWorldView(fixture.owner(), { ...PING_INPUT, operation: "big" }) as unknown).toEqual({
        schema: "kizuki.world-view/v1",
        operation: "big",
        result: { status: "unavailable", reason: "budget" },
      });
    });
  });

  test("a build operation over the response bound is unavailable too", async () => {
    const big: BuildOp = {
      source: "build",
      name: "bigbuild",
      dataSchemas: [PING_SCHEMA],
      run: () => ({ status: "data", data: { schema: PING_SCHEMA, blob: "x".repeat(300 * 1024) }, gaps: null }),
    };
    await withWorldOps([big], () => {
      expect(readWorldView(fixture.owner(), { operation: "bigbuild" }) as unknown).toEqual({
        schema: "kizuki.world-view/v1",
        operation: "bigbuild",
        result: { status: "unavailable", reason: "budget" },
      });
    });
  });

  test("gaps reported by an operation make the result incomplete with those reasons", async () => {
    const partial: ClaimsOp<{ text: string }> = {
      ...pingOp,
      name: "partial",
      run: () => ({ status: "data", data: { schema: PING_SCHEMA }, gaps: ["coverage"] }),
    };
    await withWorldOps([partial], () => {
      expect(readWorldView(fixture.owner(), { ...PING_INPUT, operation: "partial" }) as unknown).toEqual({
        schema: "kizuki.world-view/v1",
        operation: "partial",
        result: { status: "incomplete", data: { schema: PING_SCHEMA }, reasons: ["coverage"] },
      });
    });
  });
});

describe("describe", () => {
  function data(ctx: ReturnType<Fixture["owner"]>): unknown {
    const result = readWorldView(ctx, DESCRIBE);
    if ("status" in result || result.result.status !== "current") throw new Error(JSON.stringify(result));
    return result.result.data;
  }

  test("names the registered kinds, operations and vocabulary, and nothing else", () => {
    expect(data(fixture.owner())).toEqual({
      schema: WORLD_DESCRIBE_SCHEMA,
      vocabulary: "kizuki.world-vocabulary/v1",
      kinds: [
        { id: "concept", state: "shipped", population: "typed_extraction" },
        { id: "situation", state: "shipped", population: "typed_extraction" },
      ],
      operations: WORLD_OPS.map((op) => ({
        name: op.name,
        inputKeys: worldOpInputKeys(op),
        resultSchemas: op.dataSchemas,
      })),
    });
  });

  test("is byte-identical for every principal holding the grant and does not depend on vault contents", async () => {
    const before = JSON.stringify(data(fixture.owner()));
    expect(JSON.stringify(data(fixture.agent("reader-public")))).toBe(before);
    expect(JSON.stringify(data(fixture.agent("reader-private")))).toBe(before);
    const seeded = await worldFixture(fixture.db, { kind: "situation", subject: "project:describe", label: "Describe" });
    expect(JSON.stringify(data(fixture.owner()))).toBe(before);
    purgeEvents(fixture.db, fixture.vaultPath, { event_id: seeded.eventId }, "describe-purge");
    expect(JSON.stringify(data(fixture.owner()))).toBe(before);
    expect(before).not.toMatch(/count|total/);
  });

  test("lists an operation only while it is registered", async () => {
    const names = (value: unknown) => (value as { operations: { name: string }[] }).operations.map((op) => op.name);
    expect(names(data(fixture.owner()))).not.toContain("ping");
    await withWorldOps([pingOp], () => {
      expect(names(data(fixture.owner()))).toContain("ping");
    });
    expect(names(data(fixture.owner()))).not.toContain("ping");
  });

  test("takes the common keys uniformly: defaults change no byte, a past cutoff is history, malformed or foreign keys are refused", () => {
    const bare = JSON.stringify(readWorldView(fixture.owner(), DESCRIBE));
    const uniform = { ...DESCRIBE, valid: { kind: "all" }, knownAt: { kind: "current" } };
    expect(JSON.stringify(readWorldView(fixture.owner(), uniform))).toBe(bare);
    expect(JSON.stringify(readWorldView(fixture.owner(), { ...DESCRIBE, valid: { kind: "unknown_only" } }))).toBe(bare);
    expect(readWorldView(fixture.owner(), { ...DESCRIBE, knownAt: { kind: "time", at: "2026-01-01T00:00:00.000Z" } })).toEqual({
      schema: "kizuki.world-view/v1",
      operation: "describe",
      result: { status: "unavailable", reason: "history" },
    });
    expect(() => readWorldView(fixture.owner(), { ...DESCRIBE, valid: { kind: "at" } })).toThrow(WorldViewError);
    expect(() => readWorldView(fixture.owner(), { ...DESCRIBE, knownAt: { kind: "now" } })).toThrow(WorldViewError);
    expect(() => readWorldView(fixture.owner(), { ...DESCRIBE, label: "x" })).toThrow(WorldViewError);
  });

  test("needs the grant", () => {
    expect(() => readWorldView(fixture.agent("search-only"), DESCRIBE)).toThrow(ServeError);
  });
});
