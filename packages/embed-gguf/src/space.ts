import type { EmbeddingSpace } from "@kizuki/core";
import type { EmbeddingTable } from "./gguf";

export const GGUF_PROVIDER = "gguf";
export const RECIPE_PROMPT_QUERY = "task: search result | query: {q}";
export const RECIPE_PROMPT_DOC = "title: {title} | text: {text}";
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

export function formatQuery(text: string, space: EmbeddingSpace): string {
  return space.prompt_query.replaceAll("{q}", text);
}

export function formatDoc(
  title: string,
  text: string,
  space: EmbeddingSpace,
): string {
  return space.prompt_doc
    .replaceAll("{title}", title)
    .replaceAll("{text}", text);
}
