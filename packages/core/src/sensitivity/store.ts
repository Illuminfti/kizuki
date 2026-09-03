import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { tableExists } from "../ledger/schema";
import { SensitivityError } from "./errors";
import {
  policyForConnector,
  policyFromManifest,
  type SensitivityPolicy,
} from "./policy";
import {
  parseSensitivity,
  resolveSensitivity,
  sensitivityOrPrivate,
  stricter,
  type SensitivityResolution,
} from "./resolve";
import { initSensitivity } from "./schema";

export type SensitivitySetBy = "manifest" | "connect";

export interface ConnectorSensitivity {
  connector_id: string;
  source_key: string;
  default_sensitivity: Sensitivity;
  floor: Sensitivity;
  set_by: SensitivitySetBy;
  at: string;
}

interface ConnectorSensitivityRow {
  connector_id: string;
  source_key: string;
  default_sensitivity: string;
  floor: string;
  set_by: string;
  at: string;
}

function rowToRecord(row: ConnectorSensitivityRow): ConnectorSensitivity {
  const setBy = row.set_by === "connect" ? "connect" : "manifest";
  return {
    connector_id: row.connector_id,
    source_key: row.source_key,
    default_sensitivity: sensitivityOrPrivate(row.default_sensitivity),
    floor: sensitivityOrPrivate(row.floor),
    set_by: setBy,
    at: row.at,
  };
}

function nowOf(at?: string): string {
  return at ?? new Date().toISOString();
}

export function getConnectorSensitivity(
  db: Database,
  connector_id: string,
  source_key: string,
): ConnectorSensitivity | null {
  if (!tableExists(db, "connector_sensitivity")) return null;
  const row = db
    .query<ConnectorSensitivityRow, [string, string]>(
      `SELECT connector_id, source_key, default_sensitivity, floor, set_by, at
         FROM connector_sensitivity
        WHERE connector_id = ? AND source_key = ?`,
    )
    .get(connector_id, source_key);
  return row === null ? null : rowToRecord(row);
}

export function connectorSensitivityFor(
  db: Database,
  connectorId: string,
): SensitivityPolicy {
  if (!tableExists(db, "connector_sensitivity")) {
    return policyForConnector(connectorId);
  }
  const rows = db
    .query<ConnectorSensitivityRow, [string]>(
      `SELECT connector_id, source_key, default_sensitivity, floor, set_by, at
         FROM connector_sensitivity
        WHERE connector_id = ?
        ORDER BY source_key`,
    )
    .all(connectorId)
    .map(rowToRecord);
  if (rows.length === 0) return policyForConnector(connectorId);
  let floor: Sensitivity = "public";
  let defaultSensitivity: Sensitivity = "public";
  for (const row of rows) {
    floor = stricter(floor, row.floor);
    defaultSensitivity = stricter(defaultSensitivity, row.default_sensitivity);
  }
  return {
    default_sensitivity: stricter(floor, defaultSensitivity),
    sensitivity_floor: floor,
  };
}

export function seedConnectorSensitivity(
  db: Database,
  connection: { connector_id: string; source_key: string },
  policy: SensitivityPolicy,
  at?: string,
): ConnectorSensitivity {
  initSensitivity(db);
  const existing = getConnectorSensitivity(
    db,
    connection.connector_id,
    connection.source_key,
  );
  if (existing !== null) return existing;
  const stamped = nowOf(at);
  const record: ConnectorSensitivity = {
    connector_id: connection.connector_id,
    source_key: connection.source_key,
    default_sensitivity: stricter(
      policy.sensitivity_floor,
      policy.default_sensitivity,
    ),
    floor: policy.sensitivity_floor,
    set_by: "manifest",
    at: stamped,
  };
  db.query(
    `INSERT INTO connector_sensitivity
       (connector_id, source_key, default_sensitivity, floor, set_by, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.connector_id,
    record.source_key,
    record.default_sensitivity,
    record.floor,
    record.set_by,
    record.at,
  );
  return record;
}

export function raiseConnectorSensitivityFloor(
  db: Database,
  connection: { connector_id: string; source_key: string },
  requested: Sensitivity,
  manifestFloor: Sensitivity,
  at?: string,
): ConnectorSensitivity {
  if (SENSITIVITY_ORDER[requested] < SENSITIVITY_ORDER[manifestFloor]) {
    throw new SensitivityError(
      "floor_below_manifest",
      `sensitivity floor ${requested} is below the manifest floor ${manifestFloor}`,
    );
  }
  const current = seedConnectorSensitivity(
    db,
    connection,
    {
      default_sensitivity: requested,
      sensitivity_floor: manifestFloor,
    },
    at,
  );
  if (SENSITIVITY_ORDER[requested] < SENSITIVITY_ORDER[current.floor]) {
    throw new SensitivityError(
      "floor_below_current",
      `sensitivity floor ${requested} is below the current floor ${current.floor}`,
    );
  }
  if (
    requested === current.floor &&
    SENSITIVITY_ORDER[current.default_sensitivity] >= SENSITIVITY_ORDER[requested]
  ) {
    return current;
  }
  const stamped = nowOf(at);
  const next: ConnectorSensitivity = {
    ...current,
    floor: requested,
    default_sensitivity: stricter(current.default_sensitivity, requested),
    set_by: "connect",
    at: stamped,
  };
  db.query(
    `UPDATE connector_sensitivity
        SET default_sensitivity = ?, floor = ?, set_by = ?, at = ?
      WHERE connector_id = ? AND source_key = ?`,
  ).run(
    next.default_sensitivity,
    next.floor,
    next.set_by,
    next.at,
    next.connector_id,
    next.source_key,
  );
  return next;
}

export function applyConnectionSensitivity(
  db: Database,
  connection: { connector_id: string; source_key: string },
  manifest: {
    default_sensitivity?: unknown;
    sensitivity_floor?: unknown;
  },
  requested?: Sensitivity,
  at?: string,
): ConnectorSensitivity {
  const policy = policyFromManifest(manifest);
  const seeded = seedConnectorSensitivity(db, connection, policy, at);
  if (requested === undefined) return seeded;
  return raiseConnectorSensitivityFloor(
    db,
    connection,
    requested,
    policy.sensitivity_floor,
    at,
  );
}

export function labelClaimSensitivity(
  db: Database,
  input: {
    connector_ids: readonly string[];
    event_hints?: readonly unknown[];
    model_label?: unknown;
    owner_label?: unknown;
    owner_override?: boolean;
  },
): SensitivityResolution {
  let floor: Sensitivity = "public";
  let connectorDefault: Sensitivity = "public";
  if (input.connector_ids.length === 0) {
    floor = "private";
    connectorDefault = "private";
  } else {
    for (const connectorId of input.connector_ids) {
      const policy = connectorSensitivityFor(db, connectorId);
      floor = stricter(floor, policy.sensitivity_floor);
      connectorDefault = stricter(
        connectorDefault,
        policy.default_sensitivity,
      );
    }
  }

  const hints = (input.event_hints ?? [])
    .map(parseSensitivity)
    .filter((hint): hint is Sensitivity => hint !== null);
  let raising: Sensitivity | undefined;
  let hintIgnored = false;
  for (const hint of hints) {
    if (SENSITIVITY_ORDER[hint] > SENSITIVITY_ORDER[connectorDefault]) {
      raising = raising === undefined ? hint : stricter(raising, hint);
    } else if (SENSITIVITY_ORDER[hint] < SENSITIVITY_ORDER[connectorDefault]) {
      hintIgnored = true;
    }
  }

  const resolved = resolveSensitivity({
    connector_floor: floor,
    connector_default: connectorDefault,
    ...(input.model_label === undefined ? {} : { model_label: input.model_label }),
    ...(raising === undefined ? {} : { event_hint: raising }),
    ...(input.owner_label === undefined ? {} : { owner_label: input.owner_label }),
    ...(input.owner_override === true ? { owner_override: true } : {}),
  });
  return hintIgnored ? { ...resolved, hint_ignored: true } : resolved;
}
