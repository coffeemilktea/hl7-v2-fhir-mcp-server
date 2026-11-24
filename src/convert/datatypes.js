/** HL7 v2 datatype → FHIR datatype converters. */
import { CONCEPT_MAPS, TERM } from "../maps.js";
import { c, sub, tsComp, rawComp, reps, unesc, toFhirDate } from "./util.js";

/**
 * Resolve an HD-shaped namespace triple to an Identifier.system URI.
 * Only the universal ID is safe without a site lookup table; a bare namespace
 * gets a urn:id: form and a warning rather than a fabricated http URI.
 */
export function systemFrom(namespace, universalId, universalType) {
  if (universalId) {
    const t = (universalType || "").toUpperCase();
    if (t === "ISO") return { system: `urn:oid:${universalId}`, assumed: false };
    if (t === "UUID" || t === "GUID") return { system: `urn:uuid:${universalId}`, assumed: false };
    if (t === "URI" || t === "DNS") return { system: universalId, assumed: false };
    return { system: `urn:id:${universalId}`, assumed: true };
  }
  if (namespace) return { system: `urn:id:${namespace}`, assumed: true };
  return { system: undefined, assumed: false };
}

export const CODE_SYSTEM_URIS = Object.fromEntries(
  CONCEPT_MAPS["0396"].map.filter((m) => m.fhir.startsWith("http") || m.fhir.startsWith("urn:")).map((m) => [m.code, m.fhir])
);

/** CE/CWE → CodeableConcept. Both the primary and alternate coding are kept. */
export function toCodeableConcept(value, ctx, warn) {
  const g = c(ctx);
  const [code, display, sysAbbr, altCode, altDisplay, altSysAbbr] = [1, 2, 3, 4, 5, 6].map((n) => g(value, n));
  // CWE.9 Original Text (v2.5.1 CWE has 9 components; CE has 6, so it is empty there).
  const originalText = g(value, 9);
  if (!code && !altCode) {
    const raw = String(value ?? "").trim();
    const text = originalText || display || (raw.includes(ctx.compSep) ? "" : unesc(raw, ctx));
    return text ? { text } : undefined;
  }
  const coding = [];
  const push = (cd, disp, abbr, version) => {
    if (!cd) return;
    // Table 0396 "HL7nnnn" = HL7-defined table nnnn → its THO code system.
    const hl7Table = /^HL7(\d{4})$/.exec(abbr ?? "")?.[1];
    const known = CODE_SYSTEM_URIS[abbr] || (hl7Table ? `${TERM}/v2-${hl7Table}` : undefined);
    const system = known || (abbr ? `urn:id:${abbr}` : undefined);
    if (abbr && !known && warn) {
      warn(`Coding system '${abbr}' is not an HL7 table 0396 abbreviation; emitted as ${system}. Map it to a URI you own before this reaches a shared store.`);
    }
    if (!abbr && warn) warn(`Code '${cd}' arrived with no coding system (CE-3 empty); emitted without a system, which makes it unresolvable.`);
    coding.push({ ...(system ? { system } : {}), ...(version ? { version } : {}), code: cd, ...(disp ? { display: disp } : {}) });
  };
  // CWE.7/CWE.8 coding system versions (empty for CE).
  push(code, display, sysAbbr, g(value, 7));
  push(altCode, altDisplay, altSysAbbr, g(value, 8));
  const text = originalText || display;
  return { coding, ...(text ? { text } : {}) };
}

/** A repeating CE/CWE field → one CodeableConcept per repetition. */
export const toCodeableConcepts = (field, ctx, warn) =>
  reps(field, ctx.repSep).map((r) => toCodeableConcept(r, ctx, warn)).filter(Boolean);

/** CX → Identifier. */
export function toIdentifier(value, ctx, warn) {
  const g = c(ctx);
  const s = sub(ctx);
  const id = g(value, 1);
  if (!id) return undefined;
  const auth = rawComp(value, 4, ctx.compSep);
  const { system, assumed } = systemFrom(s(auth, 1), s(auth, 2), s(auth, 3));
  if (assumed && warn) {
    warn(`Identifier '${id}' has assigning authority '${s(auth, 1) || s(auth, 2)}' with no universal ID type; emitted as ${system}. Replace it with the real system URI from your identifier registry.`);
  }
  const typeCode = g(value, 5);
  return {
    ...(typeCode ? { type: { coding: [{ system: `${TERM}/v2-0203`, code: typeCode }] } } : {}),
    ...(system ? { system } : {}),
    value: id,
    // CX.7/CX.8 effective and expiration date (DT).
    ...period(value, ctx, 7, 8),
  };
}

/**
 * v2.5.1 table 0200 (XPN.7 name type) → HumanName.use: L Legal → official,
 * R Registered (animals only) → official, D Display → usual, M Maiden,
 * N Nickname, S Coded pseudo-name (anonymity) → anonymous. A Alias, B Name at
 * birth, C Adopted, I Licensing, P Partner/spouse, T Indigenous/tribal and
 * U Unspecified have no HumanName.use equivalent and leave it empty.
 */
export const XPN_USE = { L: "official", R: "official", D: "usual", M: "maiden", N: "nickname", S: "anonymous" };

/** { period } from two TS/DT components of a composite (effective / expiration), or {}. */
const period = (value, ctx, from, to) => {
  const ts = tsComp(ctx);
  const start = toFhirDate(ts(value, from));
  const end = toFhirDate(ts(value, to));
  return start || end ? { period: { ...(start ? { start } : {}), ...(end ? { end } : {}) } } : {};
};

/** XPN → HumanName. */
export function toHumanName(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  // XPN.1 is FN: only FN.1 (surname) has a HumanName equivalent.
  const family = s(rawComp(value, 1, ctx.compSep), 1);
  const given = [g(value, 2), g(value, 3)].filter(Boolean);
  // XPN.4 suffix, XPN.6 degree (deprecated in v2.5.1), XPN.14 professional suffix.
  const suffix = [g(value, 4), g(value, 6), g(value, 14)].filter(Boolean);
  const prefix = g(value, 5);
  const use = XPN_USE[g(value, 7).toUpperCase()];
  if (!family && !given.length) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(family ? { family } : {}),
    ...(given.length ? { given } : {}),
    ...(prefix ? { prefix: [prefix] } : {}),
    ...(suffix.length ? { suffix: [...new Set(suffix)] } : {}),
    // XPN.12/13 effective and expiration date (XPN.10 is the deprecated DR form).
    ...period(value, ctx, 12, 13),
  };
}

/**
 * v2.5.1 table 0190 (XAD.7 address type) → Address.use / Address.type.
 * H home, B/O work, C temp, BA old; M mailing is type=postal (it says nothing
 * about use). BDL (birth delivery location), BR, N, F, L, P and RH have no
 * Address.use equivalent and leave it empty.
 */
export const XAD_USE = { H: "home", B: "work", O: "work", C: "temp", BA: "old" };
export const XAD_TYPE = { M: "postal" };

/** XAD → Address. */
export function toAddress(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  // XAD.1 is SAD: street or mailing address & street name & dwelling number. SAD.1 is the
  // whole line; when only SAD.2/SAD.3 are sent, the line is built from them.
  const sad = rawComp(value, 1, ctx.compSep);
  const street = s(sad, 1) || [s(sad, 3), s(sad, 2)].filter(Boolean).join(" ");
  const line = [street, g(value, 2)].filter(Boolean);
  const city = g(value, 3);
  const state = g(value, 4);
  const postalCode = g(value, 5);
  const country = g(value, 6);
  const typeCode = g(value, 7).toUpperCase();
  const use = XAD_USE[typeCode];
  const type = XAD_TYPE[typeCode];
  const district = g(value, 9);
  if (!line.length && !city && !postalCode && !state && !country) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(type ? { type } : {}),
    ...(line.length ? { line } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
    // XAD.13/XAD.14 effective and expiration date (XAD.12 is the deprecated DR form).
    ...period(value, ctx, 13, 14),
  };
}

/**
 * v2.5.1 table 0201 (XTN.2 use) → ContactPoint.use. PRN/ORN/VHN are residences
 * (home), WPN work, BPN a beeper (mobile); ASN answering service, EMR emergency
 * and NET network address say nothing about use. PRS is v2.6+, kept for senders on later versions.
 */
export const XTN_USE = { PRN: "home", ORN: "home", VHN: "home", WPN: "work", BPN: "mobile", PRS: "mobile" };
/** Table 0202 (XTN.3 equipment type) → ContactPoint.system. TDD and TTY are v2.6+, kept for senders on later versions. */
export const XTN_SYSTEM = { PH: "phone", FX: "fax", CP: "phone", BP: "pager", MD: "other", TDD: "other", TTY: "other", INTERNET: "email", "X.400": "email" };

/** XTN → ContactPoint. `defaultUse` applies only when XTN.2 is empty (e.g. home for PID-13, work for PID-14). */
export function toContactPoint(value, ctx, defaultUse) {
  const g = c(ctx);
  const email = g(value, 4);
  const useCode = g(value, 2).toUpperCase();
  const equip = g(value, 3).toUpperCase();
  const use = useCode ? XTN_USE[useCode] : defaultUse;
  if (email) return { system: "email", value: email, ...(use ? { use } : {}) };
  // XTN.12 unformatted number, else XTN.1 (deprecated), else XTN.5 country + XTN.6 area + XTN.7 local [+ XTN.8 extension].
  const parts = [g(value, 5) && `+${g(value, 5).replace(/^\+/, "")}`, g(value, 6) && `(${g(value, 6)})`, g(value, 7)].filter(Boolean).join(" ");
  const number = g(value, 12) || g(value, 1) || (g(value, 7) ? parts + (g(value, 8) ? ` ext. ${g(value, 8)}` : "") : "");
  if (!number) return undefined;
  const system = XTN_SYSTEM[equip] || (equip === "" && useCode === "NET" ? "email" : "phone");
  const mobile = equip === "CP" || useCode === "BPN";
  return { system, value: number, ...(mobile ? { use: "mobile" } : use ? { use } : {}) };
}

/**
 * EI → Identifier. EI-1 is the value and EI-2/3/4 (namespace, universal ID,
 * universal ID type) resolve Identifier.system, as for HD. Pass `level: "sub"`
 * for an EI carried as subcomponents (e.g. inside EIP).
 */
export function toIdentifierEI(value, ctx, warn, { level = "comp" } = {}) {
  const get = level === "sub" ? sub(ctx) : c(ctx);
  const id = get(value, 1);
  if (!id) return undefined;
  const { system, assumed } = systemFrom(get(value, 2), get(value, 3), get(value, 4));
  if (assumed && warn) {
    warn(`Identifier '${id}' has namespace '${get(value, 2) || get(value, 3)}' with no universal ID type; emitted as ${system}. Replace it with the real system URI from your identifier registry.`);
  }
  return { ...(system ? { system } : {}), value: id };
}

/** EIP → { placer, filler } Identifiers (each EI is carried as subcomponents). */
export function toIdentifiersEIP(value, ctx, warn) {
  const placer = toIdentifierEI(rawComp(value, 1, ctx.compSep), ctx, warn, { level: "sub" });
  const filler = toIdentifierEI(rawComp(value, 2, ctx.compSep), ctx, warn, { level: "sub" });
  return { placer, filler };
}
