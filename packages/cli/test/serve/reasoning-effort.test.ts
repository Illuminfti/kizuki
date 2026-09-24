import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, listRunReceipts, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, runCliAsync, tempVault } = createHelpers();
afterEach(cleanup);

const MODEL_REF = "kizuki.llm.openai-compatible:synthetic@127.0.0.1";

function writeServeToml(vault: string, llm: string): void {
  const path = join(vault, ".kizuki", "serve.toml");
  writeFileSync(
    path,
    `[ports.llm]\nid = "kizuki.llm.openai-compatible"\n${llm}`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

describe("[ports.llm] reasoning_effort", () => {
  test("doctor and serve status show the effective effort beside the bound model", () => {
    const setup = tempVault();
    writeServeToml(
      setup.vault,
      'base_url = "http://127.0.0.1:9/v1"\nmodel = "synthetic"\nreasoning_effort = "low"\n',
    );
    const line = `canon writing: on (${MODEL_REF}, reasoning_effort=low)`;

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain(line);
    const doctorJson = JSON.parse(
      runCli(setup.env, "doctor", "--json").stdout,
    ).data;
    expect(doctorJson.serve.model).toMatchObject({
      canon_writing: "on",
      model_ref: MODEL_REF,
      reasoning_effort: "low",
    });
    expect(doctorJson.model_config_error).toBeNull();

    const status = runCli(setup.env, "serve", "status");
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain(line);
    const statusJson = JSON.parse(
      runCli(setup.env, "serve", "status", "--json").stdout,
    ).data;
    expect(statusJson.doctor.model).toMatchObject({
      canon_writing: "on",
      model_ref: MODEL_REF,
      reasoning_effort: "low",
    });

    writeServeToml(
      setup.vault,
      'base_url = "http://127.0.0.1:9/v1"\nmodel = "synthetic"\n',
    );
    const unset = runCli(setup.env, "doctor", "--json");
    expect(JSON.parse(unset.stdout).data.serve.model).toMatchObject({
      model_ref: MODEL_REF,
      reasoning_effort: null,
    });
    expect(runCli(setup.env, "serve", "status").stdout).toContain(
      `canon writing: on (${MODEL_REF}, reasoning_effort=provider-default)`,
    );
  });

  test("an invalid effort refuses the model binding with a clear config error", () => {
    const setup = tempVault();
    writeServeToml(
      setup.vault,
      'base_url = "http://127.0.0.1:9/v1"\nmodel = "synthetic"\nreasoning_effort = "extreme"\n',
    );
    const error =
      "reasoning_effort must be one of none, minimal, low, medium, high";

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.stdout).not.toContain("canon writing: on");
    expect(doctor.stdout).toContain("canon writing: unverified");
    expect(doctor.stdout).toContain(`model configuration invalid: ${error}`);
    const report = JSON.parse(
      runCli(setup.env, "doctor", "--json").stdout,
    ).data;
    expect(report.model_config_error).toBe(error);
    expect(report.serve.model.canon_writing).toBe("unverified");

    const foreground = runCli(setup.env, "serve", "run", "sync", "--json");
    expect(foreground.exitCode).toBe(1);
    expect(JSON.parse(foreground.stdout).data.errors).toEqual([
      "rail runtime acquisition failed",
    ]);
  });

  test("serve sends the effort on the extraction request and keeps the model identity", async () => {
    const setup = tempVault();
    const notes = join(setup.root, "effort-notes");
    mkdirSync(notes);
    writeFileSync(
      join(notes, "ada.md"),
      "Ada joined the orchard library project.",
    );
    const endpoint = startFakeEndpoint((request) => {
      const prompt = (
        request.body as { messages: { content: string }[] }
      ).messages
        .map((message) => message.content)
        .join("\n");
      const eventId = /event:([0-9A-HJKMNP-TV-Z]{26})/.exec(prompt)?.[1];
      if (eventId === undefined)
        throw new Error("synthetic prompt fixture mismatch");
      const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 3 };
      const claim = {
        id: "c0",
        subject: { kind: "mention", id: "m0" },
        predicate: "employment.role",
        object: { kind: "literal", value: "orchard library collaborator" },
        body: "Ada contributes to the orchard library.",
        polarity: "positive",
        perspective: {
          holder: null,
          speaker: null,
          addressee: null,
          mode: "asserted",
          interpretation: "explicit",
          anchors: [],
        },
        context: [],
        valid_from: null,
        valid_to: null,
        temporal_basis: "unknown",
        confidence: 0.7,
        sensitivity: "personal",
        anchors: [anchor],
      };
      const content = {
        schema: "kizuki.producer-response/v2",
        mentions: [{ id: "m0", label: "Ada", anchor, candidate_refs: [] }],
        claims: [claim],
      };
      return Response.json({
        id: "synthetic",
        model: "synthetic",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      });
    });
    const database = join(setup.vault, ".kizuki", "kizuki.db");
    try {
      expect(
        runCli(setup.env, "import", "markdown-folder", "--source", notes)
          .exitCode,
      ).toBe(1);
      const grantDb = openLedger(database);
      try {
        const source = listConnections(grantDb).find(
          (item) => item.connector_id === "kizuki.markdown-folder",
        )!;
        // Consent binds endpoint and model only; the effort is not part of it.
        setSourceGrant(grantDb, {
          source_key: source.source_key,
          expected_revision: 0,
          operation_id: "fixture-effort-grant",
          policy: {
            purposes: [
              "capture",
              "recall",
              "session",
              "derive",
              "extract",
              "export",
            ],
            allowed_fields: ["text", "subjects", "attachments", "metadata"],
            retention: "persistent_owned_until_revoked",
            sensitivity_floor: "public",
            egress: {
              model_endpoint: `${endpoint.base_url}/chat/completions`,
              model: "synthetic",
              external_retention: "provider_managed",
            },
          },
        });
      } finally {
        grantDb.close();
      }
      expect(
        runCli(setup.env, "import", "markdown-folder", "--source", notes)
          .exitCode,
      ).toBe(0);
      writeServeToml(
        setup.vault,
        `base_url = "${endpoint.base_url}"\nmodel = "synthetic"\nreasoning_effort = "minimal"\nmax_retries = 0\ntimeout_ms = 5000\n`,
      );

      const run = await runCliAsync(
        setup.env,
        "serve",
        "run",
        "sync",
        "--json",
      );
      expect(run.exitCode, run.stderr).toBe(0);
      expect(endpoint.requests).toHaveLength(1);
      const body = endpoint.requests[0]!.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual([
        "model",
        "messages",
        "max_tokens",
        "reasoning_effort",
      ]);
      expect(body).toMatchObject({
        model: "synthetic",
        reasoning_effort: "minimal",
      });
      const db = openLedger(database);
      try {
        const receipt = listRunReceipts(db)
          .filter((item) => item.rail === "sync")
          .at(-1)!;
        expect(receipt.claims_extracted).toBe(1);
        expect(receipt.model).toMatchObject({ model_ref: MODEL_REF, calls: 1 });
      } finally {
        db.close();
      }
    } finally {
      endpoint.stop();
    }
  });
});
