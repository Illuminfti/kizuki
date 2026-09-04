import { accept, computeContentHash, openLedger, validateEventInput } from "@kizuki/core";
import type { CaptureEvent, CaptureEventInput } from "@kizuki/core";
import type { Database } from "bun:sqlite";
import { errorMessage } from "./util";

export interface StoredAcceptResult {
  status: "stored";
  event: CaptureEvent;
}

export interface DuplicateAcceptResult {
  status: "duplicate";
  event_id: string;
  content_hash: string;
}

export interface ErrorAcceptResult {
  status: "error";
  errors: string[];
}

export type AcceptResult =
  | StoredAcceptResult
  | DuplicateAcceptResult
  | ErrorAcceptResult;

/**
 * Conformance double that talks to a real core ledger. Callers receive frozen
 * copies; mutating a returned event cannot change what the next accept sees.
 */
export class InMemoryLedger {
  readonly #db: Database;
  readonly #byKey = new Map<string, CaptureEvent>();

  constructor() {
    this.#db = openLedger(":memory:");
  }

  get size(): number {
    return this.#byKey.size;
  }

  events(): readonly CaptureEvent[] {
    return [...this.#byKey.values()].map((event) => freezeEvent(event));
  }

  accept(input: unknown): AcceptResult {
    const validated = validateEventInput(input);
    if (!validated.ok) return { status: "error", errors: validated.errors };

    try {
      const contentHash = computeContentHash(validated.value);
      const key = dedupeKey(validated.value, contentHash);
      const result = accept(this.#db, validated.value);
      if (result.status === "error") {
        return { status: "error", errors: [result.error] };
      }
      if (result.status === "duplicate") {
        const existing = this.#byKey.get(key);
        if (existing === undefined) {
          return {
            status: "error",
            errors: ["event: core reported a duplicate the double does not hold"],
          };
        }
        return {
          status: "duplicate",
          event_id: existing.event_id,
          content_hash: existing.content_hash,
        };
      }
      const event = freezeEvent(result.event);
      this.#byKey.set(key, event);
      return { status: "stored", event: freezeEvent(event) };
    } catch (error) {
      return {
        status: "error",
        errors: [`event: cannot canonicalize or store: ${errorMessage(error)}`],
      };
    }
  }

  acceptMany(inputs: readonly unknown[]): AcceptResult[] {
    return inputs.map((input) => this.accept(input));
  }
}

function freezeEvent(event: CaptureEvent): CaptureEvent {
  return Object.freeze(structuredClone(event));
}

function dedupeKey(event: CaptureEventInput, contentHash: string): string {
  return JSON.stringify([
    event.connector_id,
    event.source_record_id,
    contentHash,
  ]);
}
