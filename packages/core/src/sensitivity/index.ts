export { SensitivityError, SENSITIVITY_ERROR_CODES } from "./errors";
export type { SensitivityErrorCode } from "./errors";
export {
  SOURCE_CLASSES,
  SOURCE_CLASS_POLICY,
  policyForConnector,
  policyForSourceClass,
  policyFromManifest,
  sourceClassForConnector,
} from "./policy";
export type { SensitivityPolicy, SourceClass } from "./policy";
export {
  parseSensitivity,
  resolveSensitivity,
  sensitivityOrPrivate,
  stricter,
} from "./resolve";
export type {
  ResolveSensitivityInput,
  SensitivityRefinement,
  SensitivityResolution,
} from "./resolve";
export {
  SENSITIVITY_SCHEMA_VERSION,
  applySensitivityV6,
  initSensitivity,
} from "./schema";
export {
  applyConnectionSensitivity,
  connectorSensitivityFor,
  getConnectorSensitivity,
  labelClaimSensitivity,
  raiseConnectorSensitivityFloor,
  seedConnectorSensitivity,
} from "./store";
export type { ConnectorSensitivity, SensitivitySetBy } from "./store";
