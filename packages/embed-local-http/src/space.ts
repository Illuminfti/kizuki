import { createHash } from "node:crypto";
import type { EmbeddingSpace } from "@kizuki/core";
import type { LocalHttpEmbeddingConfig } from "./config";
import { TOKENIZER_ID } from "./tokens";

export const LOCAL_HTTP_PROVIDER = "local-http";

export function sanitizeModelName(name: string): string {
  const cleaned = name
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "unnamed" : cleaned.slice(0, 96);
}

/**
 * The id names everything that changes a vector: model, width, both prompts and
 * the token estimate. A prompt edit therefore starts a new space, and rows
 * embedded under the old one stop matching instead of silently mixing. The
 * endpoint and wire format are not part of it: the same model behind either
 * API answers in the same space.
 */
export function spaceFromConfig(
  config: LocalHttpEmbeddingConfig,
): EmbeddingSpace {
  const model = sanitizeModelName(config.model);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        config.model,
        config.dims,
        config.prompt_query,
        config.prompt_doc,
        TOKENIZER_ID,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return Object.freeze({
    id: `${LOCAL_HTTP_PROVIDER}:${model}@${config.dims}#${digest}`,
    provider: LOCAL_HTTP_PROVIDER,
    model,
    dims: config.dims,
    prompt_query: config.prompt_query,
    prompt_doc: config.prompt_doc,
    tokenizer_id: TOKENIZER_ID,
    chunk: Object.freeze({
      tokens: config.chunk_tokens,
      overlap: config.chunk_overlap,
    }),
  });
}

function fill(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replaceAll(
    /\{(q|title|text)\}/g,
    (slot, name: string) => values[name] ?? slot,
  );
}

export function frameQuery(text: string, space: EmbeddingSpace): string {
  return fill(space.prompt_query, { q: text });
}

export function frameDoc(
  title: string,
  text: string,
  space: EmbeddingSpace,
): string {
  return fill(space.prompt_doc, { title, text });
}
