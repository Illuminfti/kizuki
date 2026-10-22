/** Test-only translation of authored public fixtures into the private model wire. */
export function modelQuoteWire(response: unknown, events: readonly { event_id: string; text: string }[]): unknown {
  const result = structuredClone(response) as Record<string, any>;
  if (result === null || typeof result !== "object") return result;
  result.schema = "kizuki.model-extraction/quote-anchors-v1";
  const unique = (text: string, needle: string) => needle.length > 0 && text.indexOf(needle) >= 0
    && text.indexOf(needle, text.indexOf(needle) + 1) < 0;
  const convert = (anchor: any) => {
    const text = events.find(event => event.event_id === anchor?.event_id)?.text;
    const start = anchor?.start_utf16, end = anchor?.end_utf16;
    const invalid = { event_id: anchor?.event_id, quote: "UNMATCHABLE_TEST_ANCHOR" };
    if (text === undefined || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end > text.length) return invalid;
    const selected = text.slice(start, end);
    if (unique(text, selected)) return { event_id: anchor.event_id, quote: selected };
    for (let padding = 1; padding <= text.length * 2; padding *= 2) {
      const quote = text.slice(Math.max(0, start - padding), Math.min(text.length, end + padding));
      if (unique(text, quote) && unique(quote, selected)) return { event_id: anchor.event_id, quote, select: selected };
    }
    throw new Error("fixture anchor cannot be expressed by a unique exact quote/select");
  };
  for (const mention of result.mentions ?? []) mention.anchor = convert(mention.anchor);
  for (const claim of result.claims ?? []) {
    if (Array.isArray(claim.anchors)) claim.anchors = claim.anchors.map(convert);
    if (Array.isArray(claim.perspective?.anchors)) claim.perspective.anchors = claim.perspective.anchors.map(convert);
  }
  return result;
}
