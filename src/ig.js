/**
 * The HL7 Version 2 to FHIR IG (hl7.fhir.uv.v2mappings) as reference data,
 * imported by scripts/import-ig.mjs from HL7/v2-to-fhir at a pinned commit.
 *
 * The IG is written against later v2 versions. Every row is checked against
 * the v2.5.1 definitions in hl7v2-core and flagged when the field, component
 * or code does not exist in v2.5.1. Nothing here drives the converter; the
 * converter's own rules are in maps.js, and differences are reported.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSegment, getDatatype, checkCode, getTable, normalizeTableId } from "hl7v2-core";
import { CONCEPT_MAPS } from "./maps.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "ig");
const cache = new Map();
const load = (name) => {
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8")));
  return cache.get(name);
};
export const igMeta = () => load("meta");
const conceptMaps = () => load("conceptmaps");
const segmentMaps = () => load("segments");
const datatypeMaps = () => load("datatypes");
const messageMaps = () => load("messages");

export const attribution = () => {
  const m = igMeta();
  return {
    source: `HL7 v2-to-FHIR IG ${m.ig.version} (${m.ig.releaseLabel}), ${m.repository} @ ${m.commit.slice(0, 7)}`,
    licence: `${m.licence.igPackage}; repository ${m.licence.repository}`,
  };
};

/** Does SEG-n (or SEG-n.c) exist in v2.5.1? */
function v251FieldStatus(id) {
  const m = /^([A-Z0-9]{3})-(\d+)(?:\.(\d+))?/.exec(id);
  if (!m) return null;
  const seg = getSegment(m[1]);
  if (!seg) return { inV251: false, reason: `Segment ${m[1]} is not defined in v2.5.1.` };
  const field = seg.fields.find((f) => f.seq === Number(m[2]));
  if (!field) return { inV251: false, reason: `${m[1]}-${m[2]} does not exist in v2.5.1 (${m[1]} has ${seg.fields.length} fields there).` };
  const out = { inV251: true, v251Name: field.name, v251Type: field.type };
  if (field.opt === "W" || field.opt === "B") out.v251Usage = field.opt === "W" ? "W (withdrawn)" : "B (backward compatibility)";
  return out;
}

/** Does DT.n exist in v2.5.1? */
function v251ComponentStatus(id) {
  const m = /^([A-Z0-9]+)\.(\d+)/.exec(id);
  if (!m) return null;
  const dt = getDatatype(m[1]);
  if (!dt) return { inV251: false, reason: `Datatype ${m[1]} is not defined in v2.5.1.` };
  const comp = (dt.components ?? []).find((c) => c.seq === Number(m[2]));
  if (!comp) return { inV251: false, reason: `${m[1]}.${m[2]} does not exist in v2.5.1 (${m[1]} has ${(dt.components ?? []).length} components there).` };
  return { inV251: true, v251Name: comp.name, v251Type: comp.type };
}

const annotate = (rows, check) => rows.map((r) => ({ ...r, ...(check(r.id) ?? {}) }));

/** IG segment maps for one segment (a segment can map to several resources). */
export function segmentMapsFor(segment, { field } = {}) {
  const seg = String(segment).toUpperCase();
  return Object.values(segmentMaps())
    .filter((m) => m.name.startsWith(`${seg}[`))
    .map((m) => ({
      map: m.name,
      sourceFile: m.file,
      rows: annotate(
        field ? m.rows.filter((r) => r.id === `${seg}-${field}` || r.id.startsWith(`${seg}-${field}.`)) : m.rows,
        v251FieldStatus
      ),
    }))
    .filter((m) => !field || m.rows.length);
}

/** IG datatype maps for one v2 datatype. */
export function datatypeMapsFor(datatype) {
  const dt = String(datatype).toUpperCase();
  return Object.values(datatypeMaps())
    .filter((m) => m.name === dt || m.name.startsWith(`${dt}[`))
    .map((m) => ({ map: m.name, sourceFile: m.file, rows: annotate(m.rows, v251ComponentStatus) }));
}

/** IG message map, e.g. "SIU^S12" → SIU_S12. */
export function messageMapFor(messageType) {
  const key = String(messageType).toUpperCase().replace(/[\^ ]/g, "_");
  const m = messageMaps()[key];
  return m ? { map: m.name, sourceFile: m.file, rows: m.rows } : null;
}
export const igMessageTypes = () => Object.keys(messageMaps()).map((k) => k.replace("_", "^"));

/** All IG ConceptMaps for one v2 table, with each code's v2.5.1 status. */
export function conceptMapsFor(table) {
  const id = normalizeTableId(table);
  return Object.entries(conceptMaps())
    .filter(([key, m]) => m.table === id || key === id || key.startsWith(`${id}:`))
    .map(([key, m]) => ({
      key,
      name: m.name,
      sourceFile: m.file,
      map: m.map.map((e) => {
        if (!e.code) return e;
        const st = checkCode(id, e.code);
        return { ...e, v251: st ? st.status : getTable(id) ? "not-in-table" : "table-unknown" };
      }),
    }));
}
export const igConceptMapKeys = () => Object.keys(conceptMaps());

const norm = (v) => {
  const s = String(v ?? "").trim();
  if (!s || s.startsWith("(")) return null;
  return s.split(/\s*\|\s*|\s+/)[0];
};

/**
 * Compare the server's ConceptMap for a table with the IG's primary one.
 * Returns null when either side has no map for the table.
 */
export function conceptMapDivergence(table) {
  const id = normalizeTableId(table);
  const server = CONCEPT_MAPS[id];
  const ig = conceptMapsFor(id).find((m) => m.key === id) ?? conceptMapsFor(id)[0];
  if (!server || !ig) return null;
  const igBy = new Map();
  for (const e of ig.map) if (e.code && !igBy.has(e.code)) igBy.set(e.code, e);
  const rows = [];
  const seen = new Set();
  for (const s of server.map) {
    seen.add(s.code);
    const i = igBy.get(s.code);
    const serverCode = norm(s.fhir);
    const igCode = i?.target ?? null;
    let status;
    if (!i) status = "server-only";
    else if (serverCode === igCode) status = "same";
    else if (!serverCode && !igCode) status = "same";
    else status = "differs";
    rows.push({ code: s.code, server: s.fhir, ig: igCode, ...(i?.targetSystem ? { igSystem: i.targetSystem } : {}), status, ...(s.note ? { serverNote: s.note } : {}) });
  }
  for (const [code, i] of igBy) {
    if (seen.has(code)) continue;
    rows.push({ code, server: null, ig: i.target, ...(i.targetSystem ? { igSystem: i.targetSystem } : {}), status: "ig-only" });
  }
  const count = (st) => rows.filter((r) => r.status === st).length;
  return {
    table: id,
    igMap: ig.name,
    summary: { same: count("same"), differs: count("differs"), serverOnly: count("server-only"), igOnly: count("ig-only") },
    rows,
  };
}

/** Divergence summary for every table the server maps. */
export function allDivergences() {
  return Object.keys(CONCEPT_MAPS)
    .map((t) => conceptMapDivergence(t))
    .filter(Boolean)
    .map(({ table, igMap, summary, rows }) => ({ table, igMap, ...summary, differingCodes: rows.filter((r) => r.status === "differs").map((r) => r.code) }));
}
