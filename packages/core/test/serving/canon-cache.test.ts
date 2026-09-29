import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { serveGetPage } from "../../src/serving/page";
import { loadCanon } from "../../src/serving/canon";
import { recordedPage, serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: Fixture;
beforeAll(async () => {
  fixture = await serveFixture();
});
afterAll(() => fixture.dispose());

function fresh(id: string, title: string) {
  return {
    id,
    title,
    type: "fact",
    status: "active",
    sensitivity: "public",
    taint: "clean",
    subjects: [] as string[],
  };
}

test("a canon write is visible to the next served call", async () => {
  const context = fixture.owner();
  const before = loadCanon(context);
  expect(before.byId.has("fact:cache-probe")).toBe(false);
  expect(serveGetPage(context, { id: "fact:cache-probe" }).canon).toEqual([]);

  const written = await recordedPage(fixture.db, fixture.vaultPath, "facts/cache-probe.md", fresh("fact:cache-probe", "Probe"), "First wording.");
  const after = loadCanon(context);
  expect(after.byId.get("fact:cache-probe")?.body.trim()).toBe("First wording.");
  expect(after.authority.get("facts/cache-probe.md")).toBe(written.receipt.authority);
  expect(serveGetPage(context, { id: "fact:cache-probe" }).canon[0]?.excerpt.trim()).toBe("First wording.");
});

test("an edit through the receipted writer is visible to the next served call", async () => {
  const context = fixture.owner();
  await recordedPage(fixture.db, fixture.vaultPath, "facts/cache-edit.md", fresh("fact:cache-edit", "Edit"), "Old wording.");
  expect(serveGetPage(context, { id: "fact:cache-edit" }).canon[0]?.excerpt.trim()).toBe("Old wording.");
  const edited = await recordedPage(fixture.db, fixture.vaultPath, "facts/cache-edit.md", fresh("fact:cache-edit", "Edit"), "Corrected wording.");
  const chunk = serveGetPage(context, { id: "fact:cache-edit" }).canon[0];
  expect(chunk?.excerpt.trim()).toBe("Corrected wording.");
  expect(chunk?.authority).toBe(edited.receipt.authority);
});

test("loaded pages are copies: changing one never changes the next load", () => {
  const context = fixture.owner();
  const first = loadCanon(context).byId.get("person:ada")!;
  first.data["title"] = "tampered";
  expect(loadCanon(context).byId.get("person:ada")?.data["title"]).toBe("Ada");
});
