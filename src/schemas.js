/**
 * Shared, lenient input schemas. Models often send numbers as strings, table
 * ids without leading zeros or message types in lower case; accept them.
 */
import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "./convert/util.js";

export const message = z
  .string()
  .trim()
  .min(1, "The message is empty.")
  .max(MAX_MESSAGE_CHARS, `The message is over ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters; send one message at a time.`)
  .describe("One HL7 v2.5.1 message starting with MSH. Delimiters are read from MSH-1/MSH-2. Segments may end in \\r, \\n or \\r\\n; MLLP framing is stripped.");

export const segmentCode = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9]{2}$/, "A segment code is three characters: a letter then two letters or digits, e.g. PID."))
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
