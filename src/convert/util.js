/**
 * HL7 v2.5.1 message reading for the converters: delimiters from MSH-1/MSH-2,
 * segment splitting, the HL7 null (""), escape decoding and TS/DTM checks.
 * Field and component splitting reuse the shared hl7v2-core primitives.
 */
import { comp, toFhirDate as coreToFhirDate, checkTimestamp, zonelessTime } from "hl7v2-core";

export { zonelessTime };

/** Largest message accepted (characters). Larger input is almost certainly not one message. */
export const MAX_MESSAGE_CHARS = 1_000_000;

/** A problem with the message itself (as opposed to a bug); reported to the caller verbatim. */
export class MessageError extends Error {}

/** The HL7 null: a field or component sent as exactly "" means "delete the stored value". */
export const HL7_NULL = '""';
const isNull = (v) => typeof v === "string" && v.trim() === HL7_NULL;

const SEGMENT_ID = /^[A-Z][A-Z0-9]{2}$/;

// ─── Diagnostics sink ────────────────────────────────────────────────────────
// Conversion is synchronous, so one module-level sink collects parse-level
// warnings (invalid timestamps, ignored lines) for the conversion in progress.
let sink = null;
/** Run fn with a fresh diagnostics list; returns [result, warnings]. */
export function withDiagnostics(fn) {
  const prev = sink;
  sink = [];
  try {
    const result = fn();
    return [result, sink];
  } finally {
    sink = prev;
  }
}
const diag = (msg) => {
  if (sink && !sink.includes(msg)) sink.push(msg);
};

// ─── Delimiters and segments ─────────────────────────────────────────────────

/**
 * Read the delimiters from MSH-1 (the character after "MSH") and MSH-2 (the
 * encoding characters up to the next field separator): component, repetition,
 * escape, subcomponent, in that order. A shorter MSH-2 means the missing
 * delimiters are not used; v2.5.1 defines exactly four.
 */
export function delimiters(mshLine) {
  if (!/^MSH/.test(mshLine) || mshLine.length < 4) throw new MessageError("Message must begin with an MSH segment (MSH followed by the field separator).");
  const fieldSep = mshLine[3];
  if (/[A-Za-z0-9\s]/.test(fieldSep)) throw new MessageError(`MSH-1 field separator '${fieldSep}' is not valid: it must be a single non-alphanumeric, non-whitespace character (normally '|').`);
  const enc = mshLine.slice(4).split(fieldSep)[0];
  if (!enc) throw new MessageError("MSH-2 (encoding characters) is empty. v2.5.1 requires the component, repetition, escape and subcomponent characters, normally ^~\\&.");
  const chars = [...enc];
  const all = [fieldSep, ...chars.slice(0, 4)];
  if (new Set(all).size !== all.length) throw new MessageError(`MSH-1/MSH-2 delimiters '${fieldSep}${enc}' are not all distinct.`);
  if (chars.some((ch) => /[A-Za-z0-9\s]/.test(ch))) throw new MessageError(`MSH-2 '${enc}' contains a letter, digit or whitespace; encoding characters must be punctuation (normally ^~\\&).`);
  const ctx = { fieldSep, compSep: chars[0], repSep: chars[1], escChar: chars[2], subSep: chars[3], encoding: enc };
  if (chars.length !== 4) {
    diag(`MSH-2 '${enc}' has ${chars.length} encoding character(s); v2.5.1 defines exactly 4 (component, repetition, escape, subcomponent). ${chars.length < 4 ? "The missing delimiters were treated as unused." : "The extra characters (a v2.7+ truncation character?) were ignored."}`);
  }
  return ctx;
}

/** 1-based field accessor with the MSH numbering quirk (MSH-1 is the separator itself, MSH-2 the encoding characters). */
function fieldAccessor(name, line, ctx, nulls) {
  const parts = line.split(ctx.fieldSep);
  const isMsh = name === "MSH";
  return (n) => {
    if (isMsh && n === 1) return ctx.fieldSep;
    if (isMsh && n === 2) return ctx.encoding;
    const v = (isMsh ? parts[n - 1] : parts[n]) ?? "";
    if (isNull(v)) {
      nulls.add(`${name}-${n}`);
      return "";
    }
    return v;
  };
}

/**
 * Parse one HL7 v2 message into delimiter context plus an ordered segment list.
 * Tolerates MLLP framing, a byte-order mark and \r, \n or \r\n terminators.
 * Throws MessageError for input that is not a single v2 message.
 */
export function parse(message) {
  let raw = String(message ?? "");
  if (raw.length > MAX_MESSAGE_CHARS) throw new MessageError(`Message is ${raw.length.toLocaleString("en-US")} characters; the limit is ${MAX_MESSAGE_CHARS.toLocaleString("en-US")}. Send one message at a time.`);
  raw = raw.replace(/^﻿/, "").replace(/\x0B/g, "").replace(/\x1C\r?\n?/g, "\r");
  const lines = raw.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);
  if (!lines.length) throw new MessageError("Message is empty: no segments found.");
  lines[0] = lines[0].trimStart();
  if (/^(FHS|BHS)/.test(lines[0])) throw new MessageError("This is an HL7 batch (FHS/BHS). Convert one message at a time: from its MSH up to the next MSH.");
  const ctx = delimiters(lines[0]);
  ctx.nulls = new Set();
  const segs = [];
  lines.forEach((line, i) => {
    const name = line.slice(0, 3);
    if (!SEGMENT_ID.test(name) || (line.length > 3 && line[3] !== ctx.fieldSep)) {
      diag(`Line ${i + 1} ('${line.slice(0, 20)}${line.length > 20 ? "…" : ""}') is not a segment (a three-character ID followed by '${ctx.fieldSep}') and was ignored. A line break inside a field value splits the segment; senders must escape it as \\.br\\.`);
      return;
    }
    if (name === "MSH" && segs.length) throw new MessageError(`The input holds more than one message (another MSH at line ${i + 1}). Convert one message at a time.`);
    segs.push({ index: segs.length, name, line, f: fieldAccessor(name, line, ctx, ctx.nulls) });
  });
  // MSH-18 (first repetition) decides how \Xhh\ bytes are read; the default is ASCII / ISO 8859-1.
  ctx.charset = rawComp(reps(segs[0].f(18), ctx.repSep)[0] ?? "", 1, ctx.compSep);
  return { ctx, segs };
}

// ─── Components, repetitions and escapes ─────────────────────────────────────

/** Component n (1-based) of a raw value, trimmed, not unescaped. */
export const rawComp = (val, n, sep) => comp(val, n, sep);
/** Non-empty repetitions of a raw field value (the HL7 null counts as empty). */
export const reps = (val, sep) => (val ?? "").split(sep ?? "\u0000").filter((x) => x.trim().length > 0 && !isNull(x));

/** Bytes of a \Xhh..\ sequence, decoded in the message character set (MSH-18). */
function hexText(hex, ctx) {
  const buf = Buffer.from(hex, "hex");
  return /UTF-?8/i.test(ctx.charset ?? "") ? buf.toString("utf8") : buf.toString("latin1");
}

/**
 * Decode the v2.5.1 escape sequences: \F\ \S\ \T\ \R\ \E\, \Xhh..\ (in the
 * MSH-18 character set), \H\ \N\ (dropped), and the formatting commands
 * \.br\ \.sp n\ \.ce\ (line breaks) and \.fi\ \.nf\ \.in\ \.ti\ \.sk n\.
 * Unknown sequences (\Cxxyy\, \Mxxyyzz\, \Z..\) are kept verbatim.
 */
export function unesc(value, ctx) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (isNull(s)) return "";
  const e = ctx.escChar;
  if (!e || !s.includes(e)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== e) {
      out += s[i];
      continue;
    }
    const end = s.indexOf(e, i + 1);
    if (end === -1) {
      out += s.slice(i);
      break;
    }
    const seq = s.slice(i + 1, end);
    let rep;
    const n = Number(/^\.(?:sp|sk)\s*\+?(\d+)$/.exec(seq)?.[1] ?? 1);
    if (seq === "F") rep = ctx.fieldSep;
    else if (seq === "S") rep = ctx.compSep;
    else if (seq === "T") rep = ctx.subSep;
    else if (seq === "R") rep = ctx.repSep;
    else if (seq === "E") rep = e;
    else if (seq === "H" || seq === "N") rep = "";
    else if (/^X(?:[0-9A-Fa-f]{2})+$/.test(seq)) rep = hexText(seq.slice(1), ctx);
    else if (seq === ".br" || seq === ".ce") rep = "\n";
    else if (/^\.sp(\s*\+?\d+)?$/.test(seq)) rep = "\n".repeat(Math.min(n, 50));
    else if (/^\.sk(\s*\+?\d+)?$/.test(seq)) rep = " ".repeat(Math.min(n, 200));
    else if (/^\.(fi|nf|in|ti)([\s+-]*\d+)?$/.test(seq)) rep = "";
    if (rep === undefined) {
      out += s.slice(i, end + 1);
    } else {
      out += rep;
    }
    i = end;
  }
  return out;
}

/** Component accessor that also unescapes and treats "" as empty — the form every mapper wants. */
export const c = (ctx) => (val, n) => {
  const v = rawComp(val, n, ctx.compSep);
  if (isNull(v)) {
    ctx.nullComponent = true;
    return "";
  }
  return unesc(v, ctx);
};
/** Subcomponent accessor (for a component that holds subcomponents). */
export const sub = (ctx) => (val, n) => {
  const v = rawComp(val, n, ctx.subSep);
  return isNull(v) ? "" : unesc(v, ctx);
};
export const first = (segs, name) => segs.find((s) => s.name === name);
export const all = (segs, name) => segs.filter((s) => s.name === name);

// ─── Dates and times ─────────────────────────────────────────────────────────

/**
 * v2.5.1 TS/DTM (or DT) → FHIR date | dateTime at the source precision, or
 * undefined when empty. An invalid value (bad format, impossible date, offset
 * out of range) is reported and yields undefined rather than a wrong date.
 * A TS that arrives as a component (TS.1&TS.2) is accepted: only TS.1 is read.
 */
export function toFhirDate(ts) {
  let v = String(ts ?? "").trim();
  if (!v || isNull(v)) return undefined;
  // TS.1 only: drop a TS.2 (degree of precision) sent as a subcomponent, whatever the separator.
  v = /^([0-9.+-]*)(?:[^0-9A-Za-z.+-].*)?$/.exec(v)?.[1] ?? v;
  const fhir = coreToFhirDate(v);
  const check = checkTimestamp(v);
  let valid = Boolean(fhir) && check.ok;
  if (valid) {
    const [y, mo, d] = [v.slice(0, 4), v.slice(4, 6), v.slice(6, 8)].map(Number);
    if (v.length >= 8 && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) valid = false;
    const tz = /([+-])(\d{2})(\d{2})$/.exec(v);
    if (tz && (+tz[2] > 14 || +tz[3] > 59)) valid = false;
  }
  if (!valid) {
    diag(`'${v}' is not a valid v2.5.1 TS/DTM (YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ] with real calendar values); the element it feeds was omitted.`);
    return undefined;
  }
  return fhir;
}

/** v2.5.1 TM (HH[MM[SS[.S[S[S[S]]]]]][+/-ZZZZ]) → FHIR time (hh:mm:ss[.s]), or undefined. The offset has no place in FHIR time and is dropped. */
export function toFhirTime(tm) {
  const v = String(tm ?? "").trim();
  const m = /^(\d{2})(\d{2})?(\d{2})?(\.\d{1,4})?([+-]\d{4})?$/.exec(v);
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59 || +(m[3] ?? 0) > 59 || (m[4] && !m[3])) return undefined;
  return `${m[1]}:${m[2] ?? "00"}:${m[3] ?? "00"}${m[4] ?? ""}`;
}
