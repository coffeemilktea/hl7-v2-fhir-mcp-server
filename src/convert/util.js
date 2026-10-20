/**
 * Parsing helpers for the converters, built on the shared hl7v2-core parser so
 * both servers read messages the same way.
 */
import { dissect, fielder, comp, reps, unescape, toFhirDate, zonelessTime } from "hl7v2-core";

export { reps, toFhirDate, zonelessTime };
export const rawComp = (val, n, sep) => comp(val, n, sep);
export const unesc = (value, ctx) => unescape(value, ctx);

/** Parse a message into delimiter context plus an ordered segment list. */
export function parse(message) {
  const ctx = dissect(message);
  const segs = ctx.lines.map((line, i) => ({
    index: i,
    name: line.slice(0, 3).toUpperCase(),
    line,
    f: fielder(line, ctx.fieldSep),
  }));
  return { ctx, segs };
}

/** Component accessor that also unescapes — the form every mapper wants. */
export const c = (ctx) => (val, n) => unesc(rawComp(val, n, ctx.compSep), ctx);
export const sub = (ctx) => (val, n) => unesc(rawComp(val, n, ctx.subSep), ctx);
export const first = (segs, name) => segs.find((s) => s.name === name);
export const all = (segs, name) => segs.filter((s) => s.name === name);
