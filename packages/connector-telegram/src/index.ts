export type {
  AppCredentials,
  MessagesQuery,
  PeerType,
  SignInFlow,
  TelegramApi,
  TelegramApiFactory,
  TelegramAttachment,
  TelegramDialog,
  TelegramErrorCode,
  TelegramMessage,
  TelegramUser,
} from "./api";
export { TelegramConnectorError } from "./api";
export {
  PLACEHOLDER_CREDENTIALS_MESSAGE,
  appCredentials,
} from "./app-credentials";
export { createRealApi } from "./client";
export {
  TelegramConnector,
  createTelegramConnector,
} from "./connector";
export type {
  TelegramConnectorConfig,
  TelegramDeps,
} from "./connector";
export {
  BATCH_LIMIT,
  EDIT_WINDOW,
  MAX_DIALOGS,
  TELEGRAM_CURSOR_SCHEMA,
  encodeCursor,
  parseCursor,
} from "./cursor";
export type { DialogCursor, SyncPass, TelegramCursor } from "./cursor";
export {
  TELEGRAM_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_VERSION,
  mapMessage,
  userDisplay,
} from "./map";
export { MAX_PLAN_IDS, PurgeIndex } from "./plan";
export {
  FIXTURE_ACCOUNT,
  FIXTURE_CREDENTIALS,
  FIXTURE_OBSERVED_AT,
  FIXTURE_SESSION,
  ScriptedTelegramApi,
  fixtureAccount,
  scriptedDeps,
} from "./scripted";
export type { ScriptedAccount, ScriptedSignIn } from "./scripted";
export { TELEGRAM_STATE_SCHEMA, encodeState, parseState } from "./state";
export type { TelegramState } from "./state";
