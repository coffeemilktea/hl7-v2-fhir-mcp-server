/**
 * Code translations the converters take straight from the HL7 v2-to-FHIR IG
 * ConceptMaps (data/ig/conceptmaps.json), so they are not re-typed by hand.
 */
import { conceptMapsFor } from "../ig.js";

const cache = new Map();

/**
 * Lookup for one IG ConceptMap: code → { target, targetSystem } or null when the
 * IG lists the code with no target. Matching is exact first, then case-insensitive.
 */
export function igLookup(table, key = table) {
  if (!cache.has(key)) {
    const cm = conceptMapsFor(table).find((m) => m.key === key);
    const exact = new Map();
    const folded = new Map();
    for (const e of cm?.map ?? []) {
      if (!e.code) continue;
      const v = e.target ? { code: e.code, target: e.target, targetSystem: e.targetSystem } : { code: e.code, target: null };
      if (!exact.has(e.code)) exact.set(e.code, v);
      if (!folded.has(e.code.toUpperCase())) folded.set(e.code.toUpperCase(), v);
    }
    cache.set(key, { name: cm?.name ?? null, exact, folded });
  }
  const m = cache.get(key);
  return (code) => {
    if (!code) return undefined;
    return m.exact.get(code) ?? m.folded.get(String(code).toUpperCase());
  };
}
