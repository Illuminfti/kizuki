import type { SubjectRef } from "@kizuki/core";
import { headerValues } from "./mime/headers";
import type { HeaderField } from "./mime/headers";
import { decodeHeaderText } from "./mime/parse";
import { MAX_DISPLAY_NAME_CHARS, MAX_SUBJECTS, stripControls } from "./text";

/** Splits an address list on commas that are not inside quotes or brackets. */
export function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  let comment = 0;
  let group = false;
  for (const character of value) {
    if (quoted) {
      current += character;
      if (character === '"') quoted = false;
      continue;
    }
    if (group) {
      // Everything from `Team:` to the closing `;` is a group, not a mailbox.
      if (character === ";") group = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "(") comment += 1;
    if (character === ")" && comment > 0) comment -= 1;
    if (character === "<") angle = true;
    if (character === ">") angle = false;
    if (character === ":" && !angle && comment === 0) {
      group = true;
      current = "";
      continue;
    }
    if (character === "," && !angle && comment === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface ParsedAddress {
  address: string;
  phrase: string;
}

function parseAddress(
  entry: string,
  fallbacks: string[],
): ParsedAddress | null {
  const angle = /<([^>]*)>/.exec(entry);
  const address = (angle === null ? entry : (angle[1] ?? "")).trim();
  if (
    address.split("@").length !== 2 ||
    /\s/.test(address) ||
    address.length < 3
  ) {
    return null;
  }
  const rawPhrase =
    angle === null ? "" : entry.slice(0, angle.index).replace(/"/g, "").trim();
  return {
    address,
    phrase: stripControls(
      decodeHeaderText(rawPhrase, fallbacks),
      MAX_DISPLAY_NAME_CHARS,
    ),
  };
}

export function collectSubjects(
  fields: HeaderField[],
  fallbacks: string[],
): SubjectRef[] {
  const subjects: SubjectRef[] = [];
  const seen = new Set<string>();
  const add = (header: string, role: "from" | "to"): void => {
    for (const raw of headerValues(fields, header)) {
      for (const entry of splitAddressList(raw)) {
        if (subjects.length >= MAX_SUBJECTS) return;
        const parsed = parseAddress(entry, fallbacks);
        if (parsed === null) continue;
        const subjectId = `email:${parsed.address.toLowerCase()}`;
        const key = `${subjectId}\u0000${role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        subjects.push({
          subject_id: subjectId,
          role,
          ...(parsed.phrase.length > 0 ? { display_name: parsed.phrase } : {}),
        });
      }
    }
  };
  add("from", "from");
  add("to", "to");
  add("cc", "to");
  return subjects;
}

