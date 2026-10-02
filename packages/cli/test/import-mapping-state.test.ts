import { expect, test } from "bun:test";
import {
  ConnectionError,
  decodeHostState,
  encodeHostState,
  HOST_STATE_SCHEMA,
  portableLocalAdapter,
} from "../src/connections";

const legacyIds = ["kizuki.import-legacy-wiki", "kizuki.import-legacy-events"] as const;

function bytes(connector_id: string, config: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schema: HOST_STATE_SCHEMA, connector_id, config }));
}

test("legacy path-only state remains byte-compatible and external mappings survive the codec", () => {
  for (const connector_id of legacyIds) {
    for (const config of [{ path: "/source/notes" }, { path: "/source/notes", mapping: "/config/mapping.json" }]) {
      const state = { schema: HOST_STATE_SCHEMA, connector_id, config };
      const encoded = encodeHostState(state);
      expect(encoded).toEqual(bytes(connector_id, config));
      expect(decodeHostState(encoded, connector_id)).toEqual(state);
    }
  }
});

test("a mapping field cannot widen a non-legacy connection codec", () => {
  for (const id of ["kizuki.markdown-folder", "kizuki.import-chatgpt", "kizuki.import-claude", "kizuki.import-beacon", "kizuki.screenpipe", "kizuki.beeper", "kizuki.imap"]) {
    expect(() => decodeHostState(bytes(id, { path: "/source/notes", mapping: "/config/mapping.json" }), id)).toThrow(ConnectionError);
  }
});

test("legacy mappings reject non-path values, null bytes, extra keys and missing source paths", () => {
  for (const id of legacyIds) {
    for (const mapping of [null, false, 42, {}, [], "", "relative.json", "/config/map\0ping.json"]) {
      expect(() => decodeHostState(bytes(id, { path: "/source/notes", mapping }), id)).toThrow(ConnectionError);
    }
    expect(() => decodeHostState(bytes(id, { mapping: "/config/mapping.json" }), id)).toThrow(ConnectionError);
    expect(() => decodeHostState(bytes(id, { path: "/source/notes", mapping: "/config/mapping.json", report: "/elsewhere/report" }), id)).toThrow(ConnectionError);
    expect(() => decodeHostState(bytes(id, { path: "/source/notes", mapping: "/config/mapping.json" }), "kizuki.markdown-folder")).toThrow(ConnectionError);
  }
});

test("portable path-only backup does not silently drop legacy mapping custody", () => {
  const adapter = portableLocalAdapter();
  for (const id of legacyIds) expect(adapter.connector_ids).not.toContain(id);
});
