export const RETIRED_OWNER_GATE_VERBS = [
  "review",
  "promote",
  "reject",
] as const;

export type RetiredOwnerGateVerb = (typeof RETIRED_OWNER_GATE_VERBS)[number];

export function isRetiredOwnerGateVerb(
  verb: string | undefined,
): verb is RetiredOwnerGateVerb {
  return (
    verb !== undefined &&
    (RETIRED_OWNER_GATE_VERBS as readonly string[]).includes(verb)
  );
}

export function retiredOwnerGateMessage(verb: RetiredOwnerGateVerb): string {
  return [
    `${verb} is retired. There is no owner review queue.`,
    "Inspect receipts with kizuki audit.",
    "Reverse a write with kizuki undo <receipt_id>.",
    "Correct canon with kizuki tell \"<statement>\".",
  ].join(" ");
}
