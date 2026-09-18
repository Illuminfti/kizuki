import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { withOwnedRoots } from "./temp-root";

const PREFIX = "kizuki-temp-root-";

async function settled(read: () => string): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = read();
    if (value !== "") return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the pending run never claimed a directory");
}

test("a finished run never removes a directory a pending run still owns", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let claimed = "";
  const pending = withOwnedRoots(PREFIX, async (makeRoot) => {
    claimed = await makeRoot();
    await held;
  });
  const pendingRoot = await settled(() => claimed);

  let finishedRoot = "";
  await withOwnedRoots(PREFIX, async (makeRoot) => {
    finishedRoot = await makeRoot();
  });

  expect(finishedRoot).not.toBe(pendingRoot);
  expect(await stat(pendingRoot).then((entry) => entry.isDirectory())).toBe(
    true,
  );
  await expect(stat(finishedRoot)).rejects.toThrow();

  release();
  await pending;
  await expect(stat(pendingRoot)).rejects.toThrow();
});

test("a rejected run still removes the directories it owned", async () => {
  let owned = "";
  await expect(
    withOwnedRoots(PREFIX, async (makeRoot) => {
      owned = await makeRoot();
      throw new Error("body failed");
    }),
  ).rejects.toThrow("body failed");
  expect(owned).not.toBe("");
  await expect(stat(owned)).rejects.toThrow();
});

test("a synchronous directory is owned by the run that created it", async () => {
  let owned = "";
  await withOwnedRoots(PREFIX, async (makeRoot) => {
    owned = makeRoot.sync();
    expect((await stat(owned)).isDirectory()).toBe(true);
  });
  await expect(stat(owned)).rejects.toThrow();
});

test("an explicit prefix overrides the factory default", async () => {
  await withOwnedRoots(PREFIX, async (makeRoot) => {
    expect(await makeRoot("kizuki-temp-root-other-")).toContain(
      "kizuki-temp-root-other-",
    );
    expect(makeRoot.sync("kizuki-temp-root-other-")).toContain(
      "kizuki-temp-root-other-",
    );
  });
});
