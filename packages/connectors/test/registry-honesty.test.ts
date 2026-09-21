/**
 * The registry is part of the release surface inventory:
 * `scripts/release-evidence.ts` hashes `packages/connectors/src/registry.ts`
 * and projects `defaultConnectorRegistry` into `connectors_registered`. These
 * tests hold that projection still and keep the registry's own comments from
 * claiming more or less than the tree does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KizukiError, defaultConnectorRegistry, getConnector } from "../src";

const REGISTRY_SOURCE = readFileSync(
  join(import.meta.dir, "..", "src", "registry.ts"),
  "utf8",
);

/**
 * One line per registered connector, carrying every field
 * `connectorsRegistered()` reports for it.
 */
function registeredSurface(): string[] {
  const descriptors = new Map(
    defaultConnectorRegistry.list().map((item) => [item.id, item]),
  );
  return defaultConnectorRegistry.ids().map((connectorId) => {
    const port = descriptors.get(
      connectorId.replace(/^kizuki\./, "kizuki.connector."),
    );
    if (port === undefined) throw new Error(`no port for ${connectorId}`);
    return [
      connectorId,
      port.contract,
      `minor=${port.contract_minor}`,
      `lease=${port.requires_lease}`,
      `package=${port.optional_package}`,
      `supports=${[...port.supports].join("+")}`,
    ].join(" ");
  });
}

const REGISTERED_SURFACE = [
  "kizuki.beeper kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-beeper supports=backfill+sync+tombstones+fixture",
  "kizuki.gmail kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-gmail supports=backfill+sync+tombstones+fixture+sign_in",
  "kizuki.google-calendar kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-google-calendar supports=backfill+sync+tombstones+fixture+sign_in",
  "kizuki.ics kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-ics supports=backfill+sync+tombstones+fixture+sign_in",
  "kizuki.imap kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-imap supports=backfill+sync+tombstones+purge+fixture+sign_in",
  "kizuki.import-beacon kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+fixture",
  "kizuki.import-chatgpt kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+fixture",
  "kizuki.import-claude kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+fixture",
  "kizuki.import-legacy-events kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+tombstones+fixture",
  "kizuki.import-legacy-wiki kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+tombstones+fixture",
  "kizuki.import-omnivore kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+purge+fixture",
  "kizuki.import-pocket kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+purge+fixture",
  "kizuki.import-whatsapp kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+purge+fixture",
  "kizuki.import-x-archive kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-x supports=backfill+sync+fixture",
  "kizuki.markdown-folder kizuki.connector/v1 minor=1 lease=false package=@kizuki/connectors supports=backfill+sync+tombstones+fixture",
  "kizuki.screenpipe kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-screenpipe supports=backfill+sync+fixture",
  "kizuki.telegram kizuki.connector/v1 minor=1 lease=false package=@kizuki/connector-telegram supports=backfill+sync+purge+fixture+sign_in",
  "kizuki.x kizuki.connector/v1 minor=3 lease=false package=@kizuki/connector-x/api supports=backfill+sync+fixture+sign_in",
];

describe("connector registry honesty", () => {
  test("the registered surface release evidence reports is unchanged", () => {
    expect(registeredSurface()).toEqual(REGISTERED_SURFACE);
  });

  test("WHOOP stays a component the registry never builds", () => {
    expect(defaultConnectorRegistry.ids()).not.toContain("kizuki.whoop");
    try {
      getConnector("kizuki.whoop", {});
      throw new Error("expected getConnector to refuse kizuki.whoop");
    } catch (error) {
      expect(error).toBeInstanceOf(KizukiError);
      if (!(error instanceof KizukiError)) return;
      expect(error.code).toBe("unknown_connector");
    }
  });

  test("the X API comment keeps the fail-closed fact and claims nothing about the CLI", () => {
    expect(REGISTRY_SOURCE).toContain(
      "createXApiConnector(config, deps). An unbound registry",
    );
    expect(REGISTRY_SOURCE).not.toMatch(/CLI does not enroll/);
  });
});
