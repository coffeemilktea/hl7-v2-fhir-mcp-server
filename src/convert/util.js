/**
 * HL7 v2.5.1 message reading for the converters: delimiters from MSH-1/MSH-2,
 * segment splitting, the HL7 null (""), escape decoding and TS/DTM/TM checks.
 *
 * This module deliberately does not use the hl7v2-core parser or its TS helpers:
 * it is stricter than the core (it rejects invalid or duplicate delimiters,
 * treats a missing MSH-2 character as "not used" instead of defaulting it, and
 * records which fields carried the HL7 null), and it behaves the same whichever
 * hl7v2-core revision is installed.
 */

/** Largest message accepted (characters). Larger input is almost certainly not one message. */
export const MAX_MESSAGE_CHARS = 1_000_000;

/** A problem with the message itself (as opposed to a bug); reported to the caller verbatim. */
export class MessageError extends Error {}

/** The HL7 null: a field or component sent as exactly "" means "delete the stored value". */
const isNull = (v) => typeof v === "string" && v.trim() === '""';

const SEGMENT_ID = /^[A-Z][A-Z0-9]{2}$/;
const NOT_A_DELIMITER = /[A-Za-z0-9\s]/;

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
 * escape, subcomponent, in that order. v2.5.1 requires all four; when fewer are
 * sent, the missing delimiters are treated as not used (and reported).
 */
function delimiters(mshLine) {
  if (!/^MSH/.test(mshLine) || mshLine.length < 4) throw new MessageError("Message must begin with an MSH segment (MSH followed by the field separator).");
  const fieldSep = mshLine[3];
  if (NOT_A_DELIMITER.test(fieldSep)) throw new MessageError(`MSH-1 field separator '${fieldSep}' is not valid: it must be a single non-alphanumeric, non-whitespace character (normally '|').`);
  const enc = mshLine.slice(4).split(fieldSep)[0];
  if (!enc) throw new MessageError("MSH-2 (encoding characters) is empty. v2.5.1 requires the component, repetition, escape and subcomponent characters, normally ^~\\&.");
  const chars = [...enc];
  if (chars.some((ch) => NOT_A_DELIMITER.test(ch))) throw new MessageError(`MSH-2 '${enc}' contains a letter, digit or whitespace; encoding characters must be punctuation (normally ^~\\&).`);
  const used = [fieldSep, ...chars.slice(0, 4)];
  if (new Set(used).size !== used.length) throw new MessageError(`MSH-1/MSH-2 delimiters '${fieldSep}${enc}' are not all distinct.`);
  if (chars.length !== 4) {
    diag(`MSH-2 '${enc}' has ${chars.length} encoding character(s); v2.5.1 requires exactly 4 (component, repetition, escape, subcomponent). ${chars.length < 4 ? "The missing delimiters were treated as not used." : "The extra characters were ignored."}`);
  }
  return { fieldSep, compSep: chars[0], repSep: chars[1], escChar: chars[2], subSep: chars[3], encoding: enc };
}

/** 1-based field accessor with the MSH numbering quirk (MSH-1 is the separator itself, MSH-2 the encoding characters). */
function fieldAccessor(name, line, ctx) {
  const parts = line.split(ctx.fieldSep);
  const isMsh = name === "MSH";
  return (n) => {
    if (isMsh && n === 1) return ctx.fieldSep;
    if (isMsh && n === 2) return ctx.encoding;
    const v = (isMsh ? parts[n - 1] : parts[n]) ?? "";
    if (isNull(v)) {
      ctx.nulls.add(`${name}-${n}`);
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
  const ctx = { ...delimiters(lines[0]), nulls: new Set(), nullComponent: false };
  const segs = [];
  lines.forEach((line, i) => {
    const name = line.slice(0, 3);
    if (!SEGMENT_ID.test(name) || (line.length > 3 && line[3] !== ctx.fieldSep)) {
      diag(`Line ${i + 1} ('${line.slice(0, 20)}${line.length > 20 ? "…" : ""}') is not a segment (a three-character ID followed by '${ctx.fieldSep}') and was ignored. A line break inside a field value splits the segment; senders must escape it as \\.br\\.`);
      return;
    }
    if (name === "MSH" && segs.length) throw new MessageError(`The input holds more than one message (another MSH at line ${i + 1}). Convert one message at a time.`);
    segs.push({ index: segs.length, name, line, f: fieldAccessor(name, line, ctx) });
  });
  // MSH-18 (first repetition) decides how \Xhh\ bytes are read; empty means ASCII.
  ctx.charset = rawComp(reps(segs[0].f(18), ctx.repSep)[0] ?? "", 1, ctx.compSep).toUpperCase();
  return { ctx, segs };
}

// ─── Components, repetitions and escapes ─────────────────────────────────────

/** Split on a delimiter; an unused (undefined) delimiter means no split. */
const splitOn = (val, sep) => (sep ? String(val ?? "").split(sep) : [String(val ?? "")]);
/** Component (or subcomponent) n, 1-based, of a raw value: trimmed, not unescaped. */
export const rawComp = (val, n, sep) => (splitOn(val, sep)[n - 1] ?? "").trim();
/** Non-empty repetitions of a raw field value (the HL7 null counts as empty). */
export const reps = (val, sep) => splitOn(val, sep).filter((x) => x.trim().length > 0 && !isNull(x));

/** MSH-18 values (table 0211) whose \Xhh\ bytes this server can decode, and how. */
const HEX_DECODERS = {
  "": "latin1", // MSH-18 empty: ASCII, the v2.5.1 default
  ASCII: "latin1",
  "8859/1": "latin1",
  "UNICODE UTF-8": "utf8",
};

/** Bytes of a \Xhh..\ sequence in the message character set (MSH-18), or undefined when that set is not supported. */
function hexText(hex, ctx) {
  const encoding = HEX_DECODERS[ctx.charset ?? ""];
  if (!encoding) {
    diag(`MSH-18 character set '${ctx.charset}' is not supported for \\X..\\ hex escapes (only ASCII, 8859/1 and UNICODE UTF-8); they were kept verbatim.`);
    return undefined;
  }
  return Buffer.from(hex, "hex").toString(encoding);
}

/**
 * Decode the v2.5.1 escape sequences (section 2.7): \F\ \S\ \T\ \R\ \E\,
 * \Xhh..\ (in the MSH-18 character set), \H\ \N\ (highlighting, dropped) and
 * the formatting commands: \.br\, \.sp n\ and \.ce\ become line breaks,
 * \.sk n\ spaces; \.fi\ \.nf\ \.in n\ \.ti n\ are dropped. Unknown or
 * unsupported sequences (\Cxxyy\, \Mxxyyzz\, \Z..\) are kept verbatim.
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
    const count = () => Math.min(Number(/(\d+)$/.exec(seq)?.[1] ?? 1), 50);
    let rep;
    if (seq === "F") rep = ctx.fieldSep;
    else if (seq === "S") rep = ctx.compSep;
    else if (seq === "T") rep = ctx.subSep;
    else if (seq === "R") rep = ctx.repSep;
    else if (seq === "E") rep = e;
    else if (seq === "H" || seq === "N") rep = "";
    else if (/^X(?:[0-9A-Fa-f]{2})+$/.test(seq)) rep = hexText(seq.slice(1), ctx);
    else if (seq === ".br" || seq === ".ce") rep = "\n";
    else if (/^\.sp(\s*\+?\d+)?$/.test(seq)) rep = "\n".repeat(count());
    else if (/^\.sk(\s*\+?\d+)?$/.test(seq)) rep = " ".repeat(count());
    else if (/^\.(fi|nf|in|ti)(\s*[+-]?\d+)?$/.test(seq)) rep = "";
    out += rep ?? s.slice(i, end + 1);
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
/** TS.1 of a TS carried as component n of a composite (TS.1 & TS.2 subcomponents), e.g. DR, XPN.12, CX.7. */
export const tsComp = (ctx) => (val, n) => sub(ctx)(rawComp(val, n, ctx.compSep), 1);
export const first = (segs, name) => segs.find((s) => s.name === name);
export const all = (segs, name) => segs.filter((s) => s.name === name);

// ─── Dates and times ─────────────────────────────────────────────────────────

// v2.5.1 DTM / TS.1: YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]; the fraction only after seconds.
const DTM_RE = /^(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(\.\d{1,4})?)?)?)?)?)?([+-]\d{4})?$/;
// v2.5.1 TM: HH[MM[SS[.S[S[S[S]]]]]][+/-ZZZZ].
const TM_RE = /^(\d{2})(?:(\d{2})(?:(\d{2})(\.\d{1,4})?)?)?([+-]\d{4})?$/;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const offsetOk = (tz) => !tz || (+tz.slice(1, 3) <= 14 && +tz.slice(3) <= 59);

/**
 * v2.5.1 TS.1/DTM (or DT) → FHIR date | dateTime at the source precision
 * (missing minutes/seconds are written as 00, which FHIR requires), or
 * undefined when empty. An invalid value — wrong format, impossible date or
 * offset — is reported and yields undefined rather than a wrong date. Callers
 * pass TS.1 only (for a TS inside a composite, use tsComp).
 */
export function toFhirDate(ts) {
  const v = String(ts ?? "").trim();
  if (!v || isNull(v)) return undefined;
  const m = DTM_RE.exec(v);
  const [, y, mo, d, h, mi, s, frac, tz] = m ?? [];
  const valid =
    m && (!mo || (+mo >= 1 && +mo <= 12)) && (!d || (+d >= 1 && +d <= daysIn(+y, +mo))) &&
    (!h || +h <= 23) && (!mi || +mi <= 59) && (!s || +s <= 60) && offsetOk(tz);
  if (!valid) {
    diag(`'${v}' is not a valid v2.5.1 DTM (YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ] with real calendar values); the element it feeds was omitted.`);
    return undefined;
  }
  if (!mo) return y;
  if (!d) return `${y}-${mo}`;
  if (!h) return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${h}:${mi ?? "00"}:${s ?? "00"}${frac ?? ""}${tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : ""}`;
}

/** True when a converted timestamp carries a time but no zone offset. */
export const zonelessTime = (fhirDate) => Boolean(fhirDate && fhirDate.includes("T") && !/[+-]\d{2}:\d{2}$/.test(fhirDate));

/** v2.5.1 TM → FHIR time (hh:mm:ss[.s]), or undefined. FHIR time has no offset, so a TM offset is dropped. */
export function toFhirTime(tm) {
  const m = TM_RE.exec(String(tm ?? "").trim());
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59 || +(m[3] ?? 0) > 59 || !offsetOk(m[5])) return undefined;
  return `${m[1]}:${m[2] ?? "00"}:${m[3] ?? "00"}${m[4] ?? ""}`;
}
