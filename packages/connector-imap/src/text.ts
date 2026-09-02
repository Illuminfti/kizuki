export const MAX_TEXT_CODE_POINTS = 262_144;
export const MAX_HEADER_VALUE_CHARS = 4_096;
export const MAX_SUBJECTS = 200;
export const MAX_FILENAME_CHARS = 255;
export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_FOLDER_NAME_CHARS = 255;

/** Server- and sender-controlled text is never shown or stored as it arrives. */
export function stripControls(text: string, limit: number): string {
  const cleaned = Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return Array.from(cleaned).slice(0, limit).join("");
}
