import type { EmbeddingSpace } from "@kizuki/core";
import type { EmbeddingTable } from "./gguf";

export const GGUF_PROVIDER = "gguf";
// A table embedder averages the vectors of the words it is handed, so any
// literal words in a prompt would be averaged into every query and document.
// The recipe therefore carries slots only.
export const RECIPE_PROMPT_QUERY = "{q}";
export const RECIPE_PROMPT_DOC = "{title}\n{text}";
export const RECIPE_CHUNK_TOKENS = 800;
export const RECIPE_CHUNK_OVERLAP = 120;
export const RECIPE_TOKENIZER_ID = "gguf:kizuki-whitespace";

const MODEL_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function spaceId(model: string, dims: number): string {
  return `${GGUF_PROVIDER}:${model}@${dims}`;
}

export function sanitizeModelName(name: string): string {
  const normalized = name
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!MODEL_ID.test(normalized) || normalized.length > 128) {
    return "unnamed";
  }
  return normalized;
}

export function spaceFromTable(table: EmbeddingTable): EmbeddingSpace {
  const model = sanitizeModelName(table.name);
  return Object.freeze({
    id: spaceId(model, table.dims),
    provider: GGUF_PROVIDER,
    model,
    dims: table.dims,
    prompt_query: RECIPE_PROMPT_QUERY,
    prompt_doc: RECIPE_PROMPT_DOC,
    tokenizer_id: RECIPE_TOKENIZER_ID,
    chunk: Object.freeze({
      tokens: RECIPE_CHUNK_TOKENS,
      overlap: RECIPE_CHUNK_OVERLAP,
    }),
  });
}

/** One pass, so a slot spelled inside a title or a query is never filled a second time. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{(q|title|text)\}/g, (slot, name: string) => values[name] ?? slot);
}

export function formatQuery(text: string, space: EmbeddingSpace): string {
  return fill(space.prompt_query, { q: text });
}

export function formatDoc(
  title: string,
  text: string,
  space: EmbeddingSpace,
): string {
  return fill(space.prompt_doc, { title, text });
}
