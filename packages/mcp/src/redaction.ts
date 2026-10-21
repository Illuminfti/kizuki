import { z } from "zod";

/** Replacement counts only; credential values never enter an envelope. */
export const REDACTED = z.record(z.string(), z.int().min(1));
