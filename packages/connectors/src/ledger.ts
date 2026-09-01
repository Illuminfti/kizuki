import { computeContentHash, ulid, validateEventInput } from "@kizuki/core";
import type { CaptureEvent, CaptureEventInput } from "@kizuki/core";
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

export class InMemoryLedger {
  readonly #events: CaptureEvent[] = [];
  readonly #dedupe = new Map<string, CaptureEvent>();

  get size(): number {
    return this.#events.length;
  }

  events(): readonly CaptureEvent[] {
    return this.#events;
  }

  accept(input: unknown): AcceptResult {
    const validated = validateEventInput(input);
    if (!validated.ok) return { status: "error", errors: validated.errors };

    try {
      const contentHash = computeContentHash(validated.value);
      const key = dedupeKey(validated.value, contentHash);
      const existing = this.#dedupe.get(key);
      if (existing !== undefined) {
        return {
          status: "duplicate",
          event_id: existing.event_id,
          content_hash: existing.content_hash,
        };
      }

      const event: CaptureEvent = {
        ...validated.value,
        event_id: ulid(),
        content_hash: contentHash,
      };
      this.#events.push(event);
      this.#dedupe.set(key, event);
      return { status: "stored", event };
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

function dedupeKey(event: CaptureEventInput, contentHash: string): string {
  return JSON.stringify([
    event.connector_id,
    event.source_record_id,
    contentHash,
  ]);
}
