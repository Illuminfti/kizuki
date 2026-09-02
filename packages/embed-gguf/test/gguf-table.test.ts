import { describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  GGUF_F32,
  TABLE_ARCHITECTURE,
  loadEmbeddingTable,
} from "../src/gguf";
import type { GgufFile } from "../src/gguf";

function tableFile(
  dims: number,
  vocab: readonly string[],
  tensorDims: readonly number[],
  weightFloats: number,
): GgufFile {
  return {
    version: 3,
    metadata: {
      "general.architecture": TABLE_ARCHITECTURE,
      "general.name": "shape-fixture",
      "embedding.embedding_length": dims,
      "tokenizer.ggml.tokens": [...vocab],
    },
    tensors: [
      {
        name: "token_embd.weight",
        dims: tensorDims,
        type: GGUF_F32,
        offset: 0,
      },
    ],
    tensor_data: new Uint8Array(weightFloats * 4),
  };
}

describe("loadEmbeddingTable shape", () => {
  test("accepts a square vocab-by-dims table", () => {
    const vocab = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const table = loadEmbeddingTable(tableFile(8, vocab, [8, 8], 64));
    expect(table.dims).toBe(8);
    expect(table.vocab).toHaveLength(8);
    expect(table.weights.length).toBe(64);
  });

  test("rejects when one axis matches both vocab and dims", () => {
    const vocab = ["a", "b", "c", "d", "e", "f", "g", "h"];
    try {
      loadEmbeddingTable(tableFile(8, vocab, [8, 16], 128));
      throw new Error("expected shape refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("config_invalid");
      expect((error as PortError).message).toContain("shape does not match");
    }
  });
});
