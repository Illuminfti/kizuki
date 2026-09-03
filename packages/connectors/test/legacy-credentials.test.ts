import { describe, expect, test } from "bun:test";
import { PAGE_CANDIDATE_KEY } from "@kizuki/core";
import {
  isCredentialName,
  nameWords,
  withoutCredentials,
} from "../src/legacy/credentials";
import {
  LEGACY_EVENTS_FIXTURE,
  LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
  fixtureMappingHash as eventsMappingHash,
} from "../src/import-legacy-events/fixture";
import { rowToEvent } from "../src/import-legacy-events/rows";
import {
  LEGACY_WIKI_FIXTURE_OBSERVED_AT,
  fixtureMappingHash as wikiMappingHash,
} from "../src/import-legacy-wiki/fixture";
import { parseLegacyWikiMapping } from "../src/import-legacy-wiki/mapping";
import { planLegacyWiki } from "../src/import-legacy-wiki/plan";
import type { ScanResult } from "../src/import-legacy-wiki/scan";

/** Never a real one: the point is that the name alone decides. */
const SYNTHETIC = "SYNTHETIC-NOT-A-CREDENTIAL";

describe("what reads as a credential name", () => {
  test("splits a name the way estates write one", () => {
    expect(nameWords("api_key")).toEqual(["api", "key"]);
    expect(nameWords("apiKey")).toEqual(["api", "key"]);
    expect(nameWords("X-Auth-Token")).toEqual(["x", "auth", "token"]);
    expect(nameWords("  ")).toEqual([]);
  });

  test("a credential word anywhere in the name is one", () => {
    for (const key of [
      "password",
      "PASSWORD",
      "pwd",
      "passphrase",
      "user_password",
      "api_key",
      "apiKey",
      "APIKEY",
      "access-token",
      "refresh_token",
      "clientSecret",
      "private_key",
      "signing.key",
      "X-Auth-Token",
      "authorization",
      "cookie",
      "session_token",
      "mnemonic",
    ]) {
      expect(isCredentialName(key)).toBe(true);
    }
  });

  test("an ordinary field that merely sounds like one is kept", () => {
    for (const key of [
      "title",
      "public_key",
      "keywords",
      "keys",
      "author",
      "session",
      "tokenizer",
      "secretary",
      "born",
      "",
    ]) {
      expect(isCredentialName(key)).toBe(false);
    }
  });

  test("a bag keeps its order, its other values, and any own __proto__", () => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of [
      ["title", "Ada"],
      ["api_key", SYNTHETIC],
      ["__proto__", "still data"],
      ["born", 1815],
    ] as const) {
      Object.defineProperty(data, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const { data: kept, redacted } = withoutCredentials(data);
    expect(redacted).toEqual(["api_key"]);
    expect(Object.keys(kept)).toEqual(["title", "__proto__", "born"]);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(JSON.stringify(kept)).not.toContain(SYNTHETIC);
  });

  test("a bag with nothing to redact is handed back unchanged", () => {
    const data = { title: "Ada" };
    expect(withoutCredentials(data).data).toBe(data);
  });
});

describe("a credential-shaped wiki field", () => {
  const scan: ScanResult = {
    files: [
      {
        relpath: "notes/keys.md",
        content: `---\ntitle: Keys\napi_key: ${SYNTHETIC}\nborn: 1815\n---\nbody\n`,
        mtimeMs: 1,
        size: 60,
      },
    ],
    skipped: [],
    truncated: false,
  };

  const { events, report } = planLegacyWiki(
    scan,
    parseLegacyWikiMapping({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { field: "type", values: {}, default: "topic" },
    }),
    {
      observedAt: LEGACY_WIKI_FIXTURE_OBSERVED_AT,
      mappingHash: wikiMappingHash(),
    },
  );

  test("never reaches the event, the candidate or the report", () => {
    expect(JSON.stringify(events)).not.toContain(SYNTHETIC);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC);
    const event = events[0];
    const candidate = event?.metadata[PAGE_CANDIDATE_KEY] as {
      extensions: Record<string, unknown>;
    };
    expect(Object.keys(candidate.extensions)).not.toContain("x-api-key");
    // The page still imports, and everything else it carried survives.
    expect(candidate.extensions["x-born"]).toBe(1815);
  });

  test("is reported as dropped by name, so the owner knows it was there", () => {
    expect(report.pages[0]?.fields).toContainEqual({
      key: "api_key",
      outcome: "dropped",
      note: "credential",
    });
  });
});

describe("a credential-shaped export column", () => {
  const event = rowToEvent(
    {
      position: 1n,
      values: {
        id: "row-1",
        type: "msg",
        ts: 1_767_225_600,
        subject: "The kettle",
        body: "It is on.",
        api_key: SYNTHETIC,
        extra: "t-9",
      },
    },
    LEGACY_EVENTS_FIXTURE.mapping,
    {
      observedAt: LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
      mappingHash: eventsMappingHash(),
    },
  );

  test("never reaches the event, whatever the mapping says about the rest", () => {
    expect("event" in event).toBe(true);
    expect(JSON.stringify(event)).not.toContain(SYNTHETIC);
  });

  test("leaves the column name behind as the record that it was dropped", () => {
    if (!("event" in event)) throw new Error("unexpected skip");
    expect(event.event.metadata["__credential_columns"]).toEqual(["api_key"]);
    expect(event.event.metadata["extra"]).toBe("t-9");
  });
});
