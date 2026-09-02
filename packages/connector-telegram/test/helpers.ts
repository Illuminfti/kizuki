import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CaptureEventInput,
  ConnectionStateWriter,
  SignInIo,
} from "@kizuki/core";
import { TelegramConnectorError } from "../src/api";
import { TelegramConnector } from "../src/connector";
import type { TelegramConnectorConfig, TelegramDeps } from "../src/connector";
import {
  ScriptedTelegramApi,
} from "../src/scripted";
import {
  FIXTURE_CREDENTIALS,
  FIXTURE_OBSERVED_AT,
  FIXTURE_SESSION,
  fixtureAccount,
} from "../src/fixture";
import type {
  ScriptedAccount,
} from "../src/fixture";
import { TELEGRAM_STATE_SCHEMA, encodeState } from "../src/state";

/** Any core-minted ULID shape; the connector only ever echoes what it was given. */
export const STATE_REF = "file:connections/01JJ0000000000000000000000.state";

const directories: string[] = [];

export function temporary(prefix = "kizuki-telegram-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export interface Harness {
  connector: TelegramConnector;
  api: ScriptedTelegramApi;
  account: ScriptedAccount;
  clock: { now: number };
  sleeps: number[];
  /** A second connector over the same account: what the next process sees. */
  restart(): Promise<TelegramConnector>;
}

export function harness(options: {
  account?: ScriptedAccount;
  config?: TelegramConnectorConfig;
  session?: string;
  now?: number;
} = {}): Harness {
  const account = options.account ?? fixtureAccount();
  const api = new ScriptedTelegramApi(account, options.session ?? FIXTURE_SESSION);
  const clock = { now: options.now ?? Date.parse(FIXTURE_OBSERVED_AT) };
  const sleeps: number[] = [];
  const deps: Partial<TelegramDeps> = {
    api: () => api,
    credentials: () => FIXTURE_CREDENTIALS,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const config = options.config ?? { state_ref: STATE_REF };
  const connector = new TelegramConnector(config, deps);
  const restart = async (): Promise<TelegramConnector> => {
    const fresh = new TelegramConnector(config, deps);
    await fresh.connect(stateResolver());
    return fresh;
  };
  return { connector, api, account, clock, sleeps, restart };
}

export function stateText(
  user_id = "1001",
  session = FIXTURE_SESSION,
): string {
  return new TextDecoder().decode(
    encodeState({ schema: TELEGRAM_STATE_SCHEMA, user_id, session }),
  );
}

export function stateResolver(text = stateText()) {
  return async (ref: string): Promise<string> => {
    if (ref !== STATE_REF) throw new Error(`unexpected ref: ${ref}`);
    return text;
  };
}

export async function connected(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const built = harness(options);
  await built.connector.connect(stateResolver());
  return built;
}

/** Repeats one mode until the cursor stops moving, exactly as the runner does. */
export async function drain(
  connector: TelegramConnector,
  mode: "backfill" | "sync",
  cursor: string | null = null,
): Promise<{ events: CaptureEventInput[]; cursor: string; batches: number }> {
  const events: CaptureEventInput[] = [];
  let current = cursor;
  let batches = 0;
  for (;;) {
    const before = current;
    const batch = mode === "backfill"
      ? await connector.backfill(current)
      : await connector.sync(current);
    batches += 1;
    events.push(...batch.events);
    if (batch.cursor === null) throw new Error("the walk dropped its cursor");
    current = batch.cursor;
    if (current === before) return { events, cursor: current, batches };
    if (batches > 100) throw new Error("the walk did not settle");
  }
}

export class ScriptedIo implements SignInIo {
  readonly prompts: { question: string; secret: boolean }[] = [];
  readonly notices: string[] = [];
  readonly opened: string[] = [];
  readonly #answers: string[];

  constructor(answers: string[]) {
    this.#answers = [...answers];
  }

  async prompt(question: string, opts?: { secret?: boolean }): Promise<string> {
    this.prompts.push({ question, secret: opts?.secret === true });
    const next = this.#answers.shift();
    if (next === undefined) {
      throw new Error("the sign-in script ran out of answers");
    }
    return next;
  }

  notify(text: string): void {
    this.notices.push(text);
  }

  async openUrl(url: string): Promise<void> {
    this.opened.push(url);
  }
}

export class CapturingWriter implements ConnectionStateWriter {
  readonly writes: Uint8Array[] = [];

  async write(state: Uint8Array): Promise<void> {
    this.writes.push(state);
  }
}

export async function rejection(
  operation: () => Promise<unknown>,
): Promise<TelegramConnectorError> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  return thrown as TelegramConnectorError;
}
