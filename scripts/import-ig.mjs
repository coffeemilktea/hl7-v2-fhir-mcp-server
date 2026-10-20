#!/usr/bin/env node
/**
 * Import the HL7 v2-to-FHIR mapping spreadsheets (HL7/v2-to-fhir, the source
 * of the IG hl7.fhir.uv.v2mappings) into data/ig/*.json as reference data.
 *
 * Pinned to one commit so the output is reproducible. Clones into .sources/
 * when IG_DIR is not given.
 *
 * Licences: the repository is Apache-2.0; the IG package (sushi-config.yaml)
 * declares CC0-1.0. Both are recorded in data/ig/meta.json.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "873b331b3890c8bc5d62ef9b4dabb41801aac70d";
const REPO = "https://github.com/HL7/v2-to-fhir.git";
const OUT = path.join(ROOT, "data", "ig");

let dir = process.env.IG_DIR;
if (!dir) {
  dir = path.join(ROOT, ".sources", "v2-to-fhir");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", REPO, dir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", dir, "checkout", "--quiet", COMMIT], { stdio: "inherit" });
}
const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
if (head !== COMMIT) console.warn(`warning: ${dir} is at ${head}, expected ${COMMIT}`);
const commitDate = execFileSync("git", ["-C", dir, "show", "-s", "--format=%cI", "HEAD"]).toString().trim();

/** RFC 4180 CSV with quoted fields that may contain commas, quotes and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
const read = (f) => parseCsv(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const unquote = (s) => clean(s).replace(/^"(.*)"$/, "$1");
const nameOf = (file, prefix) => {
  const m = new RegExp(`^${prefix}_ (.+?) - [^-]+\\.csv$`).exec(path.basename(file));
  return m ? m[1] : path.basename(file, ".csv");
};
const ls = (d) => fs.readdirSync(path.join(dir, "mappings", d)).filter((f) => f.endsWith(".csv")).sort().map((f) => path.join(dir, "mappings", d, f));
const rel = (f) => path.relative(dir, f);

// ─── Concept maps ───────────────────────────────────────────────────────────
const conceptMaps = {};
for (const f of ls("codesystems")) {
  const rows = read(f).slice(2).filter((r) => r.some((x) => clean(x)));
  const name = nameOf(f, "HL7 Concept Map");
  const table = rows.map((r) => clean(r[2])).find((s) => /^HL7\d{4}/.test(s))?.slice(3, 7) ?? null;
  const map = rows
    .filter((r) => clean(r[0]) || clean(r[6]))
    .map((r) => ({
      code: clean(r[0]) || null,
      display: clean(r[1]) || null,
      ...(clean(r[4]) || clean(r[5]) || clean(r[3]) ? { condition: clean(r[4]) || clean(r[5]) || clean(r[3]) } : {}),
      target: clean(r[6]) || null,
      targetDisplay: clean(r[8]) || null,
      targetSystem: clean(r[9]) || null,
      ...(clean(r[11]) ? { comment: clean(r[11]) } : {}),
    }));
  const key = table ? `${table}${conceptMaps[table] ? `:${name}` : ""}` : `name:${name}`;
  conceptMaps[key] = { table, name, file: rel(f), map };
}

// ─── Segment and data type maps ─────────────────────────────────────────────
function fieldMaps(file, prefix) {
  const rows = read(file);
  const hdr = rows[1].map(clean);
  const col = (label, nth = 0) => {
    let n = -1;
    for (let i = 0; i < hdr.length; i++) if (hdr[i].startsWith(label) && ++n === nth) return i;
    return -1;
  };
  const C = {
    id: col("Identifier"),
    name: col("Name"),
    v2Type: col("Data Type"),
    cond: col("Computable FHIRPath"),
    antlr: col("Computable ANTLR"),
    narrative: col("Narrative"),
    attr: col("FHIR Attribute"),
    fhirType: col("Data Type", 1),
    dtMap: col("Data Type Mapping"),
    vocab: col("Vocabulary Mapping"),
    assign: col("Assignment"),
  };
  const commentsIdx = rows[0].map(clean).lastIndexOf("Comments");
  return {
    name: nameOf(file, prefix),
    file: rel(file),
    rows: rows
      .slice(2)
      .filter((r) => clean(r[C.id]))
      .map((r) => {
        const v = (i) => (i >= 0 ? clean(r[i]) : "");
        return {
          id: v(C.id),
          name: v(C.name) || null,
          v2Type: v(C.v2Type) || null,
          ...(v(C.cond) || v(C.antlr) || v(C.narrative) ? { condition: v(C.cond) || v(C.antlr) || v(C.narrative) } : {}),
          target: v(C.attr) || null,
          fhirType: v(C.fhirType) || null,
          ...(v(C.dtMap) ? { datatypeMap: v(C.dtMap) } : {}),
          ...(v(C.vocab) ? { vocabularyMap: v(C.vocab) } : {}),
          ...(v(C.assign) ? { assignment: unquote(r[C.assign]) } : {}),
          ...(commentsIdx >= 0 && v(commentsIdx) ? { comment: v(commentsIdx) } : {}),
        };
      }),
  };
}
const segmentMaps = {};
for (const f of ls("segments")) {
  const m = fieldMaps(f, "HL7 Segment - FHIR R4");
  segmentMaps[m.name] = m;
}
const datatypeMaps = {};
for (const f of ls("datatypes")) {
  const m = fieldMaps(f, "HL7 Data Type - FHIR R4");
  datatypeMaps[m.name] = m;
}

// ─── Message maps ───────────────────────────────────────────────────────────
const messageMaps = {};
for (const f of ls("messages")) {
  const rows = read(f);
  const name = nameOf(f, "HL7 Message - FHIR R4");
  messageMaps[name] = {
    name,
    file: rel(f),
    rows: rows
      .slice(2)
      .filter((r) => clean(r[1]))
      .map((r) => ({
        id: clean(r[1]),
        syntax: clean(r[2]),
        name: clean(r[3]) || null,
        ...(clean(r[6]) || clean(r[7]) || clean(r[8]) ? { condition: clean(r[6]) || clean(r[7]) || clean(r[8]) } : {}),
        target: clean(r[9]) || null,
        segmentMap: clean(r[10]) || null,
        ...(clean(r[11]) ? { references: clean(r[11]) } : {}),
      })),
  };
}

const sushi = fs.readFileSync(path.join(dir, "sushi-config.yaml"), "utf8");
const grab = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(sushi)?.[1]?.trim() ?? null;
const meta = {
  source: "HL7/v2-to-fhir (spreadsheets behind the HL7 Version 2 to FHIR IG)",
  repository: "https://github.com/HL7/v2-to-fhir",
  commit: head,
  commitDate,
  ig: { id: grab("id"), version: grab("version"), releaseLabel: grab("releaseLabel"), fhirVersion: grab("fhirVersion"), url: "https://hl7.org/fhir/uv/v2mappings/" },
  licence: { repository: "Apache-2.0 (LICENSE in the repository)", igPackage: `${grab("license")} (sushi-config.yaml)` },
  note:
    "The IG maps HL7 v2 in general (it is written against later v2 versions). Rows naming fields that do not exist in v2.5.1 are flagged by the server; this data is reference material, not the server's conversion rules.",
  counts: {
    conceptMaps: Object.keys(conceptMaps).length,
    segmentMaps: Object.keys(segmentMaps).length,
    datatypeMaps: Object.keys(datatypeMaps).length,
    messageMaps: Object.keys(messageMaps).length,
  },
};

fs.mkdirSync(OUT, { recursive: true });
const write = (n, d) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(d, null, 1) + "\n");
write("conceptmaps.json", conceptMaps);
write("segments.json", segmentMaps);
write("datatypes.json", datatypeMaps);
write("messages.json", messageMaps);
write("meta.json", meta);
console.log(JSON.stringify(meta, null, 1));
