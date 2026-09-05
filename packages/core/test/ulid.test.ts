import { describe, expect, test } from "bun:test";
import { isUlid, ulid } from "../src/util/ulid";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  test("is 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(CROCKFORD);
  });

  test("never emits the ambiguous letters I, L, O or U", () => {
    const sample = Array.from({ length: 500 }, ulid).join("");
    expect(sample).not.toMatch(/[ILOU]/);
  });

  test("encodes the current time in the first 10 characters", () => {
    const before = Date.now();
    const id = ulid();
    const after = Date.now();
    const decoded = decodeTime(id);
    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
  });

  test("is strictly ascending across a tight burst", () => {
    const ids = Array.from({ length: 5000 }, ulid);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  test("orders ids that share a millisecond by their random field", () => {
    const ids = Array.from({ length: 5000 }, ulid);
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const prefix = id.slice(0, 10);
      const group = groups.get(prefix) ?? [];
      group.push(id);
      groups.set(prefix, group);
    }
    // A 5000-id burst cannot span 5000 milliseconds, so collisions are certain.
    const collided = [...groups.values()].filter((g) => g.length > 1);
    expect(collided.length).toBeGreaterThan(0);
    for (const group of collided) {
      expect([...group].sort()).toEqual(group);
      expect(new Set(group).size).toBe(group.length);
    }
  });

  test("sorts lexicographically in creation order across milliseconds", async () => {
    const first = ulid();
    await Bun.sleep(2);
    const second = ulid();
    expect(second > first).toBe(true);
    expect([second, first].sort()).toEqual([first, second]);
  });

  test("produces 10k unique, well-formed ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = ulid();
      expect(id).toMatch(CROCKFORD);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  test("keeps the randomness field varying across milliseconds", async () => {
    const a = ulid().slice(10);
    await Bun.sleep(2);
    const b = ulid().slice(10);
    expect(a).not.toBe(b);
  });
});

describe("isUlid", () => {
  test("accepts a generated id and a known fixture", () => {
    expect(isUlid(ulid())).toBe(true);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  test("rejects lowercase, short, overflowing, and ambiguous ids", () => {
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isUlid("81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAO")).toBe(false);
    expect(isUlid(null)).toBe(false);
    expect(isUlid(1)).toBe(false);
  });
});

function decodeTime(id: string): number {
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = 0;
  for (const char of id.slice(0, 10)) {
    time = time * 32 + ENCODING.indexOf(char);
  }
  return time;
}


test("randomness overflow never regresses monotonic state", () => {
  const modulePath = new URL("../src/util/ulid.ts", import.meta.url).pathname;
  const script = `
    const { ulid, isUlid } = await import(${JSON.stringify(modulePath)});
    let time = 123456;
    Date.now = () => time;
    crypto.getRandomValues = (bytes) => { bytes.fill(255); return bytes; };
    const first = ulid();
    for (let i = 0; i < 3; i++) {
      let refused = false;
      try { ulid(); } catch { refused = true; }
      if (!refused) throw new Error("overflow resumed with regressed randomness");
    }
    time += 1;
    const later = ulid();
    if (!isUlid(later) || later <= first) throw new Error("next-millisecond ordering failed");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
});

test("random generation failure does not advance the committed timestamp", () => {
  const modulePath = new URL("../src/util/ulid.ts", import.meta.url).pathname;
  const script = `
    const { ulid } = await import(${JSON.stringify(modulePath)});
    let time = 123456;
    Date.now = () => time;
    let broken = false;
    crypto.getRandomValues = (bytes) => { if (broken) throw new Error("random unavailable"); bytes.fill(1); return bytes; };
    const first = ulid();
    time += 1;
    broken = true;
    try { ulid(); } catch {}
    time -= 1;
    broken = false;
    const next = ulid();
    if (next.slice(0, 10) !== first.slice(0, 10) || next <= first) throw new Error("failed random generation committed state");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
});
