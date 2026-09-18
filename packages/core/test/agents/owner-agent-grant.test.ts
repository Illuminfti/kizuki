import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_GRANT,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
  setGrant,
  toolAllowed,
} from "../../src/agents";
import type { Principal } from "../../src/agents";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { servePropose } from "../../src/serving/propose";
import { ServeError } from "../../src/serving/types";
import type { ServeContext } from "../../src/serving/types";
import { serveFixture } from "../serving/helpers";
import type { Fixture } from "../serving/helpers";

let fixture: Fixture | null = null;

async function newFixture(): Promise<Fixture> {
  fixture = await serveFixture();
  return fixture;
}

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

/** Enrols an agent under the named preset and returns a live serve context. */
function enrol(
  live: Fixture,
  name: string,
  grant: Partial<typeof DEFAULT_GRANT>,
): ServeContext {
  const { token } = addAgent(live.db, name, grant);
  const principal: Principal | null = authenticate(live.db, token);
  if (principal === null) throw new Error(`agent ${name} is not live`);
  return { db: live.db, vaultPath: live.vaultPath, principal };
}

/** A keyed claim a correction can retire, filed the way an agent files one. */
async function fileClaim(live: Fixture): Promise<string> {
  const envelope = await servePropose(live.agent("reader-private"), {
    kind: "claim",
    target: "facts:location.based_in",
    body: "Ada is based in Lagos.",
    subjects: ["person:ada"],
    subject: "person:ada",
    predicate: "location.based_in",
    object: "Lagos",
    provenance: [live.events["public"] as string],
  });
  const id = envelope.data?.claim_id;
  if (id === undefined) throw new Error("the fixture claim was not filed");
  return id;
}

async function refusal(run: () => Promise<unknown>): Promise<ServeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("the owner-agent preset relays an owner correction", () => {
  test("a harness the owner runs themselves may call correct", async () => {
    const live = await newFixture();
    const claimId = await fileClaim(live);
    const ctx = enrol(live, "owner-harness", OWNER_AGENT_GRANT);

    expect(toolAllowed(ctx.principal.grant, "correct")).toBe(true);

    const envelope = await dispatchServeTool(ctx, "correct", {
      statement: "Ada moved to Lisbon.",
      target: { claim_id: claimId },
    });
    expect(envelope.tool).toBe("correct");
    expect(envelope.principal).toBe("owner-harness");
  });

  test("the preset still relays at owner authority, not below it", async () => {
    const live = await newFixture();
    const ctx = enrol(live, "owner-harness", OWNER_AGENT_GRANT);
    expect(ctx.principal.grant.relay_owner_corrections).toBe(true);
  });

  test("an arbitrary agent's default grant still refuses correct", async () => {
    const live = await newFixture();
    await fileClaim(live);
    const ctx = enrol(live, "public-default", DEFAULT_GRANT);

    expect(DEFAULT_GRANT.tools).toEqual([]);
    expect(toolAllowed(ctx.principal.grant, "correct")).toBe(false);
    const error = await refusal(() =>
      dispatchServeTool(ctx, "correct", { statement: "Ada moved to Lisbon." }),
    );
    expect(error.code).toBe("tool_not_granted");
  });

  test("a grant narrowed to drop correct refuses the very next call", async () => {
    const live = await newFixture();
    const claimId = await fileClaim(live);
    const ctx = enrol(live, "owner-harness", OWNER_AGENT_GRANT);

    const first = await dispatchServeTool(ctx, "correct", {
      statement: "Ada moved to Lisbon.",
      target: { claim_id: claimId },
    });
    expect(first.tool).toBe("correct");

    setGrant(live.db, "owner-harness", {
      tools: OWNER_AGENT_GRANT.tools.filter((tool) => tool !== "correct"),
    });

    // The same context, no reconnection: authority is re-read per call.
    const error = await refusal(() =>
      dispatchServeTool(ctx, "correct", {
        statement: "Ada moved again.",
        target: { claim_id: claimId },
      }),
    );
    expect(error.code).toBe("tool_not_granted");
  });
});
