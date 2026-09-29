import type { z } from "zod";

type Shape = Readonly<Record<string, z.ZodType>>;

/**
 * What the MCP adapter needs to advertise and check one core operation. It
 * holds no policy: the engine parses and refuses, and this only states the
 * grammar the engine's answer is held to.
 */
export interface McpWorldOp {
  /** The core operation this fragment describes. */
  readonly name: string;
  /**
   * Fields the operation adds to the flat `world_view` input, each optional
   * or defaulted: the SDK advertises one object, and the engine judges which
   * fields an operation takes. A field two operations share is one shared
   * schema instance.
   */
  readonly fields: Shape;
  /** The closed body grammar of each result schema id, without its `schema` key. */
  readonly data: Readonly<Record<string, Shape>>;
  /** One sentence of the generated tool description. */
  readonly summary: string;
}
