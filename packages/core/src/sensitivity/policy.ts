import type { Sensitivity } from "../agents/types";
import { sensitivityOrPrivate, stricter } from "./resolve";

export const SOURCE_CLASSES = [
  "direct_messaging",
  "email",
  "health_biometrics",
  "calendar",
  "local_files",
  "agent_session",
  "public_posts",
  "saved_web",
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

export interface SensitivityPolicy {
  default_sensitivity: Sensitivity;
  sensitivity_floor: Sensitivity;
}

/** Seed policy per source class, not per vendor (RFC 0002 §8.2). */
export const SOURCE_CLASS_POLICY: Record<SourceClass, SensitivityPolicy> = {
  direct_messaging: {
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  },
  email: { default_sensitivity: "private", sensitivity_floor: "personal" },
  health_biometrics: {
    default_sensitivity: "private",
    sensitivity_floor: "private",
  },
  calendar: { default_sensitivity: "private", sensitivity_floor: "personal" },
  local_files: { default_sensitivity: "private", sensitivity_floor: "personal" },
  agent_session: {
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  },
  public_posts: { default_sensitivity: "public", sensitivity_floor: "public" },
  saved_web: { default_sensitivity: "personal", sensitivity_floor: "public" },
};

const CLOSED: SensitivityPolicy = {
  default_sensitivity: "private",
  sensitivity_floor: "private",
};

const CONNECTOR_SOURCE_CLASS: Readonly<Record<string, SourceClass>> = {
  "kizuki.markdown-folder": "local_files",
  "kizuki.import-chatgpt": "agent_session",
  "kizuki.import-claude": "agent_session",
  "kizuki.screenpipe": "local_files",
};

export function sourceClassForConnector(
  connectorId: string,
): SourceClass | null {
  return CONNECTOR_SOURCE_CLASS[connectorId] ?? null;
}

export function policyForSourceClass(
  sourceClass: SourceClass,
): SensitivityPolicy {
  return SOURCE_CLASS_POLICY[sourceClass];
}

export function policyForConnector(connectorId: string): SensitivityPolicy {
  const sourceClass = sourceClassForConnector(connectorId);
  return sourceClass === null ? CLOSED : SOURCE_CLASS_POLICY[sourceClass];
}

export function policyFromManifest(manifest: {
  default_sensitivity: unknown;
  sensitivity_floor: unknown;
}): SensitivityPolicy {
  const floor = sensitivityOrPrivate(manifest.sensitivity_floor);
  const defaultSensitivity = sensitivityOrPrivate(manifest.default_sensitivity);
  return {
    default_sensitivity: stricter(floor, defaultSensitivity),
    sensitivity_floor: floor,
  };
}
