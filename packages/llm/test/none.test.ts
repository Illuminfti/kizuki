import { describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  NONE_LLM_DESCRIPTOR,
  NONE_LLM_ID,
  createNoneLlmPort,
} from "../src/index";
import { SAMPLE_REQUEST, temporaryLlmContext } from "./helpers";

describe("kizuki.llm.none", () => {
  test("reports unavailable health and a null model_ref", async () => {
    const temporary = temporaryLlmContext(NONE_LLM_DESCRIPTOR);
    try {
      const port = createNoneLlmPort(temporary.ctx);
      expect(port.descriptor).toEqual(NONE_LLM_DESCRIPTOR);
      expect(port.descriptor.id).toBe(NONE_LLM_ID);
      expect(port.model_ref).toBeNull();
      expect(await port.health()).toEqual({
        status: "unavailable",
        reason: "no model configured",
      });
    } finally {
      temporary.cleanup();
    }
  });

  test("complete throws unavailable instead of returning empty text", async () => {
    const temporary = temporaryLlmContext(NONE_LLM_DESCRIPTOR);
    try {
      const port = createNoneLlmPort(temporary.ctx);
      let thrown: unknown;
      try {
        await port.complete(SAMPLE_REQUEST);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PortError);
      expect((thrown as PortError).code).toBe("unavailable");
      expect((thrown as PortError).retryable).toBe(false);
      expect((thrown as PortError).message).toBe("no model configured");
    } finally {
      temporary.cleanup();
    }
  });
});
