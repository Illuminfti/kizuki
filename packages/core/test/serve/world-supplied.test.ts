import { expect, test } from "bun:test";
import type { SubjectRef } from "../../src/contracts/event";
import { worldSuppliedReferences } from "../../src/serve/world-supplied";

const sourceA = "01J00000000000000000000001", sourceB = "01J00000000000000000000002";
const first = "01J00000000000000000000003", second = "01J00000000000000000000004";
const event = (text: string, subjects: SubjectRef[], event_id = first) => ({ event_id, connector_id: "fixture", text, subjects });
const mira: SubjectRef = { subject_id: "person:42", role: "from", display_name: "Mira" };

test("request handles bind exact structured subjects to separate source namespaces", () => {
  const events = [event("Mira defines flux.", [mira]), event("Mira explains flux.", [mira], second)];
  const separate = worldSuppliedReferences(events, id => id === first ? sourceA : sourceB);
  expect(separate.input).toHaveLength(2);
  expect([...separate.refs.values()].map(ref => ref.namespace.source_key)).toEqual([sourceA, sourceB]);
  expect(JSON.stringify(separate.input)).not.toContain("person:42");
  expect(JSON.stringify(separate.input)).not.toContain(sourceA);
  const same = worldSuppliedReferences(events, () => sourceA);
  expect(same.input).toHaveLength(1);
  expect(same.input[0]!.anchors.map(anchor => anchor.event_id)).toEqual([first, second]);
  expect(worldSuppliedReferences(events, () => null).input).toEqual([]);
});

test("names alone, repeated matches, shared labels, normalized matches and word fragments create no supplied authority", () => {
  for (const candidate of [
    event("Mira defines flux.", []),
    event("Mira and Mira define flux.", [mira]),
    event("Mira defines flux.", [mira, { subject_id: "person:99", role: "to", display_name: "Mira" }]),
    event("MIRA defines flux.", [mira]),
    event("Mirage defines flux.", [mira]),
    event("Mira\u0301 defines flux.", [mira]),
    event("👩‍💻 defines flux.", [{ ...mira, display_name: "👩" }]),
    event("✈️ defines flux.", [{ ...mira, display_name: "✈" }]),
    event("Mira defines flux.", [{ ...mira, display_name: " Mira " }]),
  ]) expect(worldSuppliedReferences([candidate], () => sourceA).input).toEqual([]);
  const raw = worldSuppliedReferences([event("person:42 defines flux.", [mira, { subject_id: "person:99", role: "to", display_name: "Mira" }])], () => sourceA);
  expect(raw.input).toHaveLength(1);
  expect(raw.refs.get("s0")?.id).toBe("person:42");
});

test("UTF-16 witnesses and duplicate roles remain deterministic without changing identity", () => {
  const mapped = worldSuppliedReferences([event("🧭 Mira defines flux.", [mira, { ...mira, role: "about" }])], () => sourceA);
  expect(mapped.input).toEqual([{ id: "s0", anchors: [{ event_id: first, start_utf16: 3, end_utf16: 7 }] }]);
  expect(mapped.refs.get("s0")).toEqual({ kind: "supplied", id: "person:42", namespace: { connector_id: "fixture", source_key: sourceA } });
  for (const label of ["Mira\u0301", "👩‍💻", "✈️"]) {
    expect(worldSuppliedReferences([event(`${label} defines flux.`, [{ ...mira, display_name: label }])], () => sourceA).input)
      .toEqual([{ id: "s0", anchors: [{ event_id: first, start_utf16: 0, end_utf16: label.length }] }]);
  }
});
