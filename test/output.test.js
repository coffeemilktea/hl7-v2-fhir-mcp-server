import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "../src/result.js";

test("results over the cap become an actionable error", () => {
  const prev = process.env.HL7_MCP_MAX_OUTPUT_CHARS;
  process.env.HL7_MCP_MAX_OUTPUT_CHARS = "2000";
  try {
    const r = ok({ items: Array.from({ length: 500 }, (_, i) => ({ i, text: "x".repeat(20) })) }, { hint: "Use offset/limit." });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /over the 2,000-character output cap.*Use offset\/limit\./);
    const small = ok({ a: 1 });
    assert.deepEqual(small.structuredContent, { a: 1 });
  } finally {
    if (prev === undefined) delete process.env.HL7_MCP_MAX_OUTPUT_CHARS;
    else process.env.HL7_MCP_MAX_OUTPUT_CHARS = prev;
  }
});
