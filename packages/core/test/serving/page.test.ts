import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertClaim } from "../../src/claims/store";
import { serveGetPage } from "../../src/serving/page";
import type { GetPageArgs } from "../../src/serving/page";
import { ServeError } from "../../src/serving/types";
import { serializePage } from "../../src/vault/frontmatter";
import { write } from "../canon/helpers";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("serveGetPage", () => {
  test("resolves a page by id and by vault-relative path", () => {
    const byId = serveGetPage(fixture.owner(), { id: "person:ada" });
    expect(byId.canon).toHaveLength(1);
    expect(byId.canon[0]?.path).toBe("entities/person-ada.md");
    expect(byId.canon[0]?.excerpt).toContain("Ada keeps the kettle warm.");
    expect(byId.canon[0]?.truncated).toBe(false);

    const byPath = serveGetPage(fixture.owner(), {
      path: "entities/person-ada.md",
    });
    expect(byPath.canon[0]?.page_id).toBe("person:ada");
  });

  test("exactly one selector is required", () => {
    const ctx = fixture.owner();
    expect(refusal(() => serveGetPage(ctx, {} as GetPageArgs)).code).toBe(
      "invalid_arguments",
    );
    expect(
      refusal(() =>
        serveGetPage(ctx, { id: "person:ada", path: "entities/person-ada.md" }),
      ).code,
    ).toBe("invalid_arguments");
  });

  test("a path that tries to leave the vault is refused", () => {
    const ctx = fixture.owner();
    for (const path of ["../x.md", "/abs.md", "a\\b.md"]) {
      expect(refusal(() => serveGetPage(ctx, { path })).code).toBe(
        "invalid_arguments",
      );
    }
  });

  test("an absent page neither confirms nor denies existence", () => {
    const envelope = serveGetPage(fixture.owner(), { id: "fact:nowhere" });
    expect(envelope.canon).toEqual([]);
    expect(envelope.denied).toEqual([]);
  });

  test("an archived page is absent, not a denial", () => {
    const envelope = serveGetPage(fixture.owner(), { id: "fact:archived" });
    expect(envelope.canon).toEqual([]);
    expect(envelope.denied).toEqual([]);
  });

  test("an unlabeled page is withheld from the owner too", () => {
    const envelope = serveGetPage(fixture.owner(), { id: "fact:unlabeled" });
    expect(envelope.canon).toEqual([]);
    expect(envelope.denied).toEqual([
      { reason: "missing_sensitivity", count: 1 },
    ]);
  });

  test("a held page reports the hold", () => {
    const envelope = serveGetPage(fixture.owner(), {
      path: fixture.heldPath,
    });
    expect(envelope.canon).toEqual([]);
    expect(envelope.denied).toEqual([{ reason: "held", count: 1 }]);
  });

  test("a page above the ceiling is withheld with its reason", () => {
    const envelope = serveGetPage(fixture.agent("reader-public"), {
      id: "fact:kettle",
    });
    expect(envelope.canon).toEqual([]);
    expect(envelope.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
  });

  test("a long body is truncated on a code point, never inside a pair", () => {
    const body = `${"a".repeat(65_535)}\u{1F600}tail`;
    writeFileSync(
      join(fixture.vaultPath, "facts/long.md"),
      serializePage({
        data: {
          id: "fact:long",
          title: "Long kettle note",
          type: "fact",
          status: "active",
          sensitivity: "public",
          taint: "clean",
        },
        body,
      }),
      "utf8",
    );

    const chunk = serveGetPage(fixture.owner(), { id: "fact:long" }).canon[0];
    expect(chunk?.truncated).toBe(true);
    expect(Array.from(chunk?.excerpt ?? "")).toHaveLength(65_536);
    expect(chunk?.excerpt.endsWith("\u{1F600}")).toBe(true);
  });

  test("a chunk names the tier of the receipt that wrote its page", async () => {
    const filed = await insertClaim(
      { db: fixture.db },
      {
        kind: "entity",
        target: "facts:receipted",
        body: "A kettle page the receipted writer produced.",
        frontmatter: { type: "fact", title: "Receipted kettle note" },
        provenance: [fixture.events["public"] as string],
        subjects: ["person:linus"],
        producer: "deterministic",
        confidence: 1,
        sensitivity: "public",
      },
    );
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    const receipt = write(
      { db: fixture.db, vault_path: fixture.vaultPath },
      filed.claim,
      { writer: "import" },
    );

    const written = serveGetPage(fixture.owner(), { path: receipt.page_path });
    expect(receipt.page_path).toBe("facts/receipted.md");
    expect(written.canon[0]?.authority).toBe(receipt.authority);
    // A hand-authored page no receipt covers borrows no tier.
    expect(
      serveGetPage(fixture.owner(), { id: "person:ada" }).canon[0]?.authority,
    ).toBeNull();
  });
});

describe("serveGetPage validates before it reads", () => {
  test("a malformed selector is refused without walking the vault", () => {
    const ctx = {
      ...fixture.owner(),
      vaultPath: join(fixture.vaultPath, "gone"),
    };

    expect(refusal(() => serveGetPage(ctx, { path: "../escape.md" })).code).toBe(
      "invalid_arguments",
    );
    expect(refusal(() => serveGetPage(ctx, { id: "" })).code).toBe(
      "invalid_arguments",
    );
    // The same unreadable vault does fail once the selector is usable, which
    // is what makes the refusal above evidence and not a coincidence.
    expect(refusal(() => serveGetPage(ctx, { id: "person:ada" })).code).toBe(
      "error",
    );
  });
});
