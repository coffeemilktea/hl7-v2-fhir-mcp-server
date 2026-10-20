/**
 * Shared, lenient input schemas. Models often send numbers as strings, table
 * ids without leading zeros or message types in lower case; accept them.
 */
import { z } from "zod";

export const message = z
  .string()
  .min(1)
  .describe("HL7 v2 message text (pipe-delimited). Segments may end in \\r, \\n or \\r\\n; MLLP framing (0x0B ... 0x1C 0x0D) is stripped automatically.");

export const segmentCode = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.toUpperCase())
  .describe("Three-character segment code, e.g. MSH, PID, OBR, OBX, ZDS. Case-insensitive.");

export const offset = z.coerce.number().int().min(0).default(0).describe("Index of the first item to return (pagination). Default 0.");
export const limit = (def, max) =>
  z.coerce.number().int().min(1).max(max).default(def).describe(`Maximum items to return (1–${max}). Default ${def}.`);

/** Pagination block every list result includes. */
export const page = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  nextOffset: z.number().int().nullable(),
});

export const issue = z.object({ location: z.string(), message: z.string() });

/**
 * Output schema helper: an object schema that allows extra keys, so optional
 * informational fields do not break clients that validate structuredContent.
 */
export const out = (shape) => z.object(shape).passthrough();
