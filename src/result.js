/**
 * Tool result helpers: every successful result carries structuredContent plus
 * a JSON text copy, and is capped so one call cannot flood the client context.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 60_000;

export function maxOutputChars() {
  const n = Number(process.env.HL7_MCP_MAX_OUTPUT_CHARS);
  return Number.isFinite(n) && n > 1000 ? n : DEFAULT_MAX_OUTPUT_CHARS;
}

/** Successful result. `hint` explains how to narrow the request if it is too large. */
export function ok(data, { hint } = {}) {
  let text = JSON.stringify(data, null, 2);
  const cap = maxOutputChars();
  if (text.length > cap) text = JSON.stringify(data);
  if (text.length > cap) {
    return fail(
      `Result is ${text.length.toLocaleString("en-US")} characters, over the ${cap.toLocaleString("en-US")}-character output cap (HL7_MCP_MAX_OUTPUT_CHARS). ` +
        (hint ?? "Narrow the request with offset/limit or a filter.")
    );
  }
  return { content: [{ type: "text", text }], structuredContent: data };
}

/** Error result the model can read and act on. */
export function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Annotations for pure, local, read-only tools. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Same, but the output can differ between calls (timestamps, generated ids). */
export const READ_ONLY_NON_IDEMPOTENT = { ...READ_ONLY, idempotentHint: false };
