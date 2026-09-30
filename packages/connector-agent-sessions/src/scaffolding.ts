/** Harness-owned blocks are not the person's words, even inside a spoken turn. */
const SCAFFOLD = /^(?:system-reminder|task-notification|command-(?:name|message|args)|local-command-[a-z-]+|hook[-_]output|function_calls|environment_context|user_instructions|permissions|turn_aborted)$/i;
const TAG = /<\/?([a-z][a-z0-9_-]*)(?:\s[^<>]*)?\/?>/gi;

/**
 * Scan once, dropping paired scaffolding and its payload. An unfinished block
 * drops the remainder rather than laundering harness output into owner text.
 * Ordinary XML and the words before and after a harness block survive.
 */
export function dropScaffolding(text: string): string {
  const stack: string[] = [];
  let cursor = 0;
  let out = "";
  for (const tag of text.matchAll(TAG)) {
    const name = tag[1]!.toLowerCase();
    if (stack.length === 0) out += text.slice(cursor, tag.index);
    const closing = tag[0].startsWith("</");
    if (SCAFFOLD.test(name)) {
      if (closing) {
        if (stack.at(-1) === name) stack.pop();
      } else if (!tag[0].endsWith("/>")) {
        stack.push(name);
      }
    } else if (stack.length === 0) out += tag[0];
    cursor = tag.index + tag[0].length;
  }
  if (stack.length === 0) out += text.slice(cursor);
  return out;
}
