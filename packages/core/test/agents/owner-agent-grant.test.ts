import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_GRANT,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
  setGrant,
  toolAllowed,
} from "../../src/agents";
import type { Grant, Principal } from "../../src/agents";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { servePropose } from "../../src/serving/propose";
import { ServeError } from "../../src/serving/types";
import type { ServeContext } from "../../src/serving/types";
import { serveFixture } from "../serving/helpers";
import type { Fixture } from "../serving/helpers";

let live: Fixture;

beforeAll(async () => {
  live = await serveFixture();
});

afterAll(() => {
  live.dispose();
});

/** Enrols an agent under the named preset and returns a live serve context. */
function enrol(name: string, grant: Partial<Grant>): ServeContext {
  const { token } = addAgent(live.db, name, grant);
  const principal: Principal | null = authenticate(live.db, token);
  if (principal === null) throw new Error(`agent ${name} is not live`);
  return { db: live.db, vaultPath: live.vaultPath, principal };
}

/**
 * A keyed claim a correction can retire, filed the way an agent files one.
 * Each test takes its own predicate: an owner correction holds the key it
 * lands on, so a later agent claim on that same key would not be live.
 */
async function fileClaim(
  predicate: string,
  object: string,
  body: string,
): Promise<string> {
  const envelope = await servePropose(live.agent("reader-private"), {
    kind: "claim",
    target: `facts:${predicate}`,
    body,
    subjects: ["person:ada"],
    subject: "person:ada",
    predicate,
    object,
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
    const claimId = await fileClaim(
      "location.based_in",
      "Lagos",
      "Ada is based in Lagos.",
    );
    const ctx = enrol("owner-harness", OWNER_AGENT_GRANT);

    expect(toolAllowed(ctx.principal.grant, "correct")).toBe(true);
    // RFC 0002 §6.4: the preset relays at owner authority, not one tier down.
    expect(ctx.principal.grant.relay_owner_corrections).toBe(true);

    const envelope = await dispatchServeTool(ctx, "correct", {
      statement: "Ada moved to Lisbon.",
      target: { claim_id: claimId },
    });
    expect(envelope.tool).toBe("correct");
    expect(envelope.principal).toBe("owner-harness");
  });

  test("an arbitrary agent's default grant still refuses correct", async () => {
    const ctx = enrol("public-default", DEFAULT_GRANT);

    expect(DEFAULT_GRANT.tools).toEqual([]);
    expect(toolAllowed(ctx.principal.grant, "correct")).toBe(false);
    const error = await refusal(() =>
      dispatchServeTool(ctx, "correct", { statement: "Ada moved to Lisbon." }),
    );
    expect(error.code).toBe("tool_not_granted");
  });

  test("a grant narrowed to drop correct refuses the very next call", async () => {
    const claimId = await fileClaim(
      "employment.works_at",
      "Cedar Labs",
      "Ada works at Cedar Labs.",
    );
    const ctx = enrol("narrowed-harness", OWNER_AGENT_GRANT);

    const first = await dispatchServeTool(ctx, "correct", {
      statement: "Ada works at Rowan Freight.",
      target: { claim_id: claimId },
    });
    expect(first.tool).toBe("correct");

    setGrant(live.db, "narrowed-harness", {
      tools: OWNER_AGENT_GRANT.tools.filter((tool) => tool !== "correct"),
    });

    // The same context, no reconnection: authority is re-read per call.
    const error = await refusal(() =>
      dispatchServeTool(ctx, "correct", {
        statement: "Ada works somewhere else again.",
        target: { claim_id: claimId },
      }),
    );
    expect(error.code).toBe("tool_not_granted");
  });
});
