/** HL7 v2 datatype → FHIR datatype converters. */
import { CONCEPT_MAPS, TERM } from "../maps.js";
import { c, sub, rawComp, unesc } from "./util.js";

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
  const push = (cd, disp, abbr) => {
    if (!cd) return;
    // Table 0396 "HL7nnnn" = HL7-defined table nnnn → its THO code system.
    const hl7Table = /^HL7(\d{4})$/.exec(abbr ?? "")?.[1];
    const known = CODE_SYSTEM_URIS[abbr] || (hl7Table ? `${TERM}/v2-${hl7Table}` : undefined);
    const system = known || (abbr ? `urn:id:${abbr}` : undefined);
    if (abbr && !known && warn) {
      warn(`Coding system '${abbr}' is not an HL7 table 0396 abbreviation; emitted as ${system}. Map it to a URI you own before this reaches a shared store.`);
    }
    if (!abbr && warn) warn(`Code '${cd}' arrived with no coding system (CE-3 empty); emitted without a system, which makes it unresolvable.`);
    coding.push({ ...(system ? { system } : {}), code: cd, ...(disp ? { display: disp } : {}) });
  };
  push(code, display, sysAbbr);
  push(altCode, altDisplay, altSysAbbr);
  const text = originalText || display;
  return { coding, ...(text ? { text } : {}) };
}

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
  };
}

export const XPN_USE = { L: "official", A: "anonymous", D: "usual", M: "maiden", N: "nickname", B: "old", U: "temp", C: "usual", I: "usual", S: "anonymous", T: "temp" };

/** XPN → HumanName. */
export function toHumanName(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  const family = s(rawComp(value, 1, ctx.compSep), 1) || g(value, 1);
  const given = [g(value, 2), g(value, 3)].filter(Boolean);
  const suffix = [g(value, 4), g(value, 6)].filter(Boolean);
  const prefix = g(value, 5);
  const use = XPN_USE[g(value, 7).toUpperCase()];
  if (!family && !given.length) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(family ? { family } : {}),
    ...(given.length ? { given } : {}),
    ...(prefix ? { prefix: [prefix] } : {}),
    ...(suffix.length ? { suffix } : {}),
  };
}

export const XAD_USE = { H: "home", B: "work", O: "work", M: "home", C: "temp", BA: "old", BDL: "billing", P: "temp", RH: "home" };

/** XAD → Address. */
export function toAddress(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  const streetRaw = rawComp(value, 1, ctx.compSep);
  const line = [s(streetRaw, 1) || unesc(streetRaw, ctx), g(value, 2)].filter(Boolean);
  const city = g(value, 3);
  const state = g(value, 4);
  const postalCode = g(value, 5);
  const country = g(value, 6);
  const use = XAD_USE[g(value, 7).toUpperCase()];
  const district = g(value, 9);
  if (!line.length && !city && !postalCode) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(line.length ? { line } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
  };
}

export const XTN_USE = { PRN: "home", ORN: "work", WPN: "work", VHN: "home", ASN: "temp", EMR: "temp", NET: "home", BPN: "mobile", PRS: "mobile" };
export const XTN_SYSTEM = { PH: "phone", FX: "fax", CP: "phone", BP: "pager", MD: "phone", TDD: "other", TTY: "other", Internet: "email", "X.400": "email" };

/** XTN → ContactPoint. */
export function toContactPoint(value, ctx, defaultUse) {
  const g = c(ctx);
  const email = g(value, 4);
  const useCode = g(value, 2).toUpperCase();
  const equip = g(value, 3);
  const use = XTN_USE[useCode] || defaultUse;
  if (email) return { system: "email", value: email, ...(use ? { use } : {}) };
  const number = g(value, 12) || g(value, 1) || [g(value, 6), g(value, 7)].filter(Boolean).join("");
  if (!number) return undefined;
  const system = XTN_SYSTEM[equip] || XTN_SYSTEM[equip?.toUpperCase()] || "phone";
  const mobile = equip?.toUpperCase() === "CP" || useCode === "BPN";
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
