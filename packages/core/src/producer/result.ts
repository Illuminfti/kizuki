import type { ModelUsage, ProduceInput, ProduceResult, ProducerDiagnostic, ProducerPort, DroppedDraft } from "../contracts/producer";
import { PRODUCER_CONTRACT, PRODUCER_REJECT_REASONS } from "../contracts/producer";
import { parseExtractResponseV2, PRODUCER_V2_CONTRACT, type ProducerV2ParseInput, type DroppedDraftV2, PRODUCER_V2_UNAVAILABLE_REASONS, type ProduceResultV2 } from "../contracts/producer-v2";
import { assertPortContract } from "../contracts/ports";
import { cloneExactJson, isPlainObject } from "../util/validate";
import { readProducerDiagnostic } from "./diagnostics";
import { MAX_CLAIMS_PER_RESPONSE, MAX_EVENT_ID_CHARS, MAX_EVENT_IDS_PER_CLAIM, MAX_PREDICATE_CHARS, MAX_SUBJECT_CHARS, parseExtractResponse } from "./schema";
/** Local validation metadata, never accepted from a producer's wire result. */

export interface ValidatedProduceResult<T = ProduceResult> {
  readonly result: T;
  readonly usage_known: boolean;
}
const MAX_USAGE = 1000000000;
// V1 may aggregate one 64-draft response per quoted event in its bounded call plan.
const MAX_RESULT_CLAIMS = 8 * MAX_CLAIMS_PER_RESPONSE;
const MAX_DROPPED = MAX_RESULT_CLAIMS + 8;
const integer = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_USAGE;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) ||
  optional.includes(key));

function invalidResult(): ValidatedProduceResult {
  return { usage_known: false, result: {
      status: "rejected", reason: "schema_invalid",
      usage: { calls: 1, input_tokens: 0, output_tokens: 0 }, diagnostic: { stage: "response", rule: "bad_response" }
    } };
}

function readUsage(value: unknown): ModelUsage | undefined {
  if (!isPlainObject(value) || !exact(value, ["calls", "input_tokens", "output_tokens"]) ||
    !integer(value.calls) || !integer(value.input_tokens) || !integer(value.output_tokens)) {
    return undefined;
  }
  return { calls: value.calls, input_tokens: value.input_tokens, output_tokens: value.output_tokens };
}

function eventIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_EVENT_IDS_PER_CLAIM &&
    value.every(id => bounded(id, MAX_EVENT_ID_CHARS)) && new Set(value).size === value.length;
}

function readDroppedV1(value: unknown): DroppedDraft[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DROPPED) {
    return undefined;
  }
  const dropped: DroppedDraft[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      return undefined;
    }
    if (item.reason === "unknown_predicate" &&
      exact(item, ["reason", "predicate", "event_ids"]) &&
      bounded(item.predicate, MAX_PREDICATE_CHARS) &&
      eventIds(item.event_ids)) {
      dropped.push({ reason: item.reason, predicate: item.predicate, event_ids: [...item.event_ids] });
    }
    else if (item.reason === "unknown_subject" &&
      exact(item, ["reason", "subject", "event_ids"]) &&
      bounded(item.subject, MAX_SUBJECT_CHARS) &&
      eventIds(item.event_ids)) {
      dropped.push({ reason: item.reason, subject: item.subject, event_ids: [...item.event_ids] });
    }
    else if (item.reason === "event_too_large" &&
      exact(item, ["reason", "event_id", "chars"]) &&
      bounded(item.event_id, MAX_EVENT_ID_CHARS) &&
      integer(item.chars)) {
      dropped.push({ reason: item.reason, event_id: item.event_id, chars: item.chars });
    }
    else {
      return undefined;
    }
  }
  return dropped;
}

export function validateProduceResult(raw: unknown, contract?: typeof PRODUCER_CONTRACT): ValidatedProduceResult;

export function validateProduceResult(raw: unknown, contract: typeof PRODUCER_V2_CONTRACT, input: ProducerV2ParseInput): ValidatedProduceResult<ProduceResultV2>;
/** Complete status union validation precedes every consumed result field. */
export function validateProduceResult(raw: unknown, contract: string = PRODUCER_CONTRACT, input?: ProducerV2ParseInput): ValidatedProduceResult<ProduceResult | ProduceResultV2> {
  try {
    if (contract !== PRODUCER_CONTRACT && contract !== PRODUCER_V2_CONTRACT) {
      return invalidResult();
    }
    const errors: string[] = [];
    const value = cloneExactJson(raw, "producer result", {
      maxDepth: 12, maxKeysPerObject: 24, maxArrayLength: 1024,
      maxStringBytes: 1600000, maxKeyBytes: 128, maxTotalBytes: 2 * 1024 * 1024
    }, errors);
    if (!isPlainObject(value)) {
      return invalidResult();
    }
    const usage = readUsage(value.usage);
    if (usage === undefined) {
      return invalidResult();
    }
    if (value.status === "unavailable" || value.status === "rejected") {
      if (!exact(value, ["status", "reason", "usage"], ["diagnostic"])) {
        return invalidResult();
      }
      const diagnostic = value.diagnostic === undefined ? undefined : readProducerDiagnostic(value.diagnostic);
      if (value.diagnostic !== undefined && diagnostic === undefined) {
        return invalidResult();
      }
      const detail = diagnostic === undefined ? {} : { diagnostic };
      if (value.status === "rejected") {
        if (typeof value.reason !== "string" || !(PRODUCER_REJECT_REASONS as readonly string[]).includes(value.reason)) {
          return invalidResult();
        }
        return { usage_known: true, result: {
            status: "rejected", reason: value.reason as Extract<ProduceResult, {
              status: "rejected";
            }>["reason"], usage, ...detail
          } };
      }
      if (typeof value.reason !== "string" || value.reason.length > 16384) {
        return invalidResult();
      }
      if (contract === PRODUCER_V2_CONTRACT && !(PRODUCER_V2_UNAVAILABLE_REASONS as readonly string[]).includes(value.reason)) {
        return invalidResult();
      }
      // V1 permits any wire string; operational consumers receive only this fixed value.
      return { usage_known: true, result: {
          status: "unavailable", reason: contract === PRODUCER_CONTRACT ? "unavailable" : value.reason as (typeof PRODUCER_V2_UNAVAILABLE_REASONS)[number], usage, ...detail
        } };
    }
    if (value.status !== "ok") {
      return invalidResult();
    }
    if (contract === PRODUCER_CONTRACT) {
      if (!exact(value, ["status", "claims", "usage"], ["dropped"]) ||
        !Array.isArray(value.claims) ||
        value.claims.length > MAX_RESULT_CLAIMS) {
        return invalidResult();
      }
      const claims: Extract<ProduceResult, {
        status: "ok";
      }>["claims"] = [];
      for (let offset = 0; offset < value.claims.length; offset += MAX_CLAIMS_PER_RESPONSE) {
        const parsed = parseExtractResponse(JSON.stringify({ claims: value.claims.slice(offset, offset + MAX_CLAIMS_PER_RESPONSE) }));
        if (!parsed.ok) {
          return invalidResult();
        }
        claims.push(...parsed.claims);
      }
      const dropped = value.dropped === undefined ? undefined : readDroppedV1(value.dropped);
      if (value.dropped !== undefined && dropped === undefined) {
        return invalidResult();
      }
      return { usage_known: true, result: {
          status: "ok", claims, usage, ...(dropped === undefined ? {} : { dropped })
        } };
    }
    if (!exact(value, ["status", "response", "usage"], ["dropped"]) || input === undefined) {
      return invalidResult();
    }
    const parsed = parseExtractResponseV2(JSON.stringify(value.response), input);
    if (!parsed.ok) {
      return invalidResult();
    }
    const dropped: DroppedDraftV2[] = [...parsed.dropped];
    if (value.dropped !== undefined) {
      if (!Array.isArray(value.dropped) || value.dropped.length > 128) {
        return invalidResult();
      }
      for (const item of value.dropped) {
        if (!isPlainObject(item) || !exact(item, ["reason", "id"]) || item.reason !== "unknown_predicate" ||
          typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id)) {
          return invalidResult();
        }
        dropped.push({ reason: "unknown_predicate", id: item.id });
      }
    }
    if (dropped.length > 128 || new Set(dropped.map(item => item.id)).size !== dropped.length ||
      dropped.some(item => parsed.response.claims.some(claim => claim.id === item.id))) {
      return invalidResult();
    }
    return { usage_known: true, result: {
        status: "ok", response: parsed.response, usage, ...(dropped.length === 0 ? {} : { dropped })
      } };
  }
  catch {
    // An in-process port may throw through a proxy trap. Never expose its error.
    return invalidResult();
  }
}
/** Runtime v1 call boundary. V2 emission remains unavailable until B2. */
export async function invokeProducer(producer: Pick<ProducerPort, "descriptor" | "produce">, input: ProduceInput): Promise<ValidatedProduceResult> {
  try {
    assertPortContract(producer.descriptor, "producer");
    return validateProduceResult(await producer.produce(input));
  }
  catch {
    return { usage_known: false, result: {
        status: "unavailable", reason: "unavailable",
        usage: { calls: 1, input_tokens: 0, output_tokens: 0 }, diagnostic: { stage: "transport", rule: "unavailable" }
      } };
  }
}
