import { describe, expect, test } from "bun:test";
import { PortError } from "../../src/contracts/ports";
import type {
  PortHealth,
  SystemOnePort,
  SystemOneRequest,
  SystemOneResponse,
} from "../../src";
import {
  SYSTEMONE_CONTRACT,
  SYSTEMONE_CONTRACT_MINOR,
  admitExtractedClaims,
} from "../../src";
import { validatePortDescriptor } from "../../src/contracts/ports";
import { draft, GRACE_EVENT } from "./helpers";

function scriptedSystemOne(
  script: (request: SystemOneRequest) => SystemOneResponse | Error,
  modelRef: string | null = "kizuki.systemone.jev:jev-latest@127.0.0.1",
): SystemOnePort {
  return {
    descriptor: validatePortDescriptor({
      id: "test.kizuki.systemone.scripted",
      kind: "systemone",
      contract: SYSTEMONE_CONTRACT,
      contract_minor: SYSTEMONE_CONTRACT_MINOR,
      supports: ["evaluate"],
      requires_lease: false,
      optional_package: null,
    }),
    model_ref: modelRef,
    async health(): Promise<PortHealth> {
      return { status: "ready", detail: {} };
    },
    async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
      const result = script(request);
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {},
  };
}

describe("systemone admission", () => {
  test("unconfigured is a no-op keep", async () => {
    const claims = [draft()];
    const result = await admitExtractedClaims(claims, [GRACE_EVENT], undefined, 1_000);
    expect(result).toEqual({ status: "ok", claims, dropped: [] });
  });

  test("keeps high noul and drops low noul without writing canon", async () => {
    const keep = draft();
    const drop = draft({ object: "invented role", body: "Grace is CEO." });
    const port = scriptedSystemOne(() => ({
      model: "jev-latest",
      answers: {
        admit_0: { type: "noul", noul: 0.94 },
        admit_1: { type: "noul", noul: 0.12 },
      },
      usage: { input_tokens: 8, output_tokens: 2 },
    }));
    const result = await admitExtractedClaims([keep, drop], [GRACE_EVENT], port, 1_000);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.claims).toEqual([keep]);
    expect(result.dropped).toEqual([
      { reason: "systemone_rejected", event_ids: [GRACE_EVENT.event_id] },
    ]);
  });

  test("a dead configured port is unavailable, not an empty keep", async () => {
    const port = scriptedSystemOne(
      () => new PortError("unavailable", "http 503", true),
    );
    const result = await admitExtractedClaims([draft()], [GRACE_EVENT], port, 1_000);
    expect(result).toEqual({ status: "unavailable", reason: "http 503" });
  });
});
