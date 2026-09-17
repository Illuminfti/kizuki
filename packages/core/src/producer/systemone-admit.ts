import type { ClaimDraft, DroppedDraft, QuotedEvent } from "../contracts/producer";
import {
  SYSTEMONE_ADMIT_NOUL_MIN,
  type SystemOnePort,
  type SystemOneQuestion,
} from "../contracts/systemone";
import { PortError } from "../contracts/ports";

export type SystemOneAdmitResult =
  | { status: "ok"; claims: ClaimDraft[]; dropped: DroppedDraft[] }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: "schema_invalid" };

function classifyError(error: unknown): SystemOneAdmitResult {
  if (error instanceof PortError) {
    if (error.code === "unavailable" || error.code === "timeout") {
      return { status: "unavailable", reason: error.message };
    }
    if (error.message.startsWith("rejected:")) {
      return { status: "rejected", reason: "schema_invalid" };
    }
  }
  return { status: "unavailable", reason: "systemone unavailable" };
}

/**
 * Optional typed admission after LLM extraction. Does not write canon.
 * Unconfigured ports are a no-op. A configured but dead port is unavailable,
 * never an empty keep.
 */
export async function admitExtractedClaims(
  drafts: readonly ClaimDraft[],
  events: readonly QuotedEvent[],
  port: SystemOnePort | undefined,
  deadline_ms: number,
): Promise<SystemOneAdmitResult> {
  if (port === undefined || port.model_ref === null || drafts.length === 0) {
    return { status: "ok", claims: [...drafts], dropped: [] };
  }

  const questions: Record<string, SystemOneQuestion> = {};
  for (let index = 0; index < drafts.length; index += 1) {
    questions[`admit_${index}`] = {
      type: "noul",
      instructions:
        "Is this extracted claim supported by the quoted events it cites, without copying captured text?",
      criteria: {
        true: "The cited events support the claim and the body is a paraphrase",
        false: "The claim is unsupported, contradicted, or copies captured text",
      },
    };
  }

  let response;
  try {
    response = await port.evaluate({
      state: {
        events: events.map((event) => ({
          event_id: event.event_id,
          text: event.text,
        })),
        drafts: drafts.map((draft, index) => ({
          index,
          subject: draft.subject,
          predicate: draft.predicate,
          object: draft.object,
          body: draft.body,
          event_ids: [...draft.event_ids],
        })),
      },
      questions,
      deadline_ms,
    });
  } catch (error) {
    return classifyError(error);
  }

  const claims: ClaimDraft[] = [];
  const dropped: DroppedDraft[] = [];
  for (const [index, draft] of drafts.entries()) {
    const answer = response.answers[`admit_${index}`];
    if (answer === undefined || answer.type !== "noul") {
      return { status: "rejected", reason: "schema_invalid" };
    }
    if (
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      return { status: "rejected", reason: "schema_invalid" };
    }
    if (answer.noul < SYSTEMONE_ADMIT_NOUL_MIN) {
      dropped.push({
        reason: "systemone_rejected",
        event_ids: [...draft.event_ids],
      });
      continue;
    }
    claims.push(draft);
  }
  return { status: "ok", claims, dropped };
}
