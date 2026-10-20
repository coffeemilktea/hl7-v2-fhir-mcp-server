/** The curated maps agree with the v2.5.1 definitions in hl7v2-core. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "hl7v2-core";
import { CONCEPT_MAPS, SEGMENT_MAPS, DATATYPE_MAPS, MESSAGE_MAPS } from "../src/maps.js";
import { conceptMapDivergence } from "../src/ig.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

test("every curated segment field exists in v2.5.1 under the same name", () => {
  const mismatches = [];
  for (const [seg, m] of Object.entries(SEGMENT_MAPS)) {
    if (seg === "ZDS") continue;
    for (const f of m.fields) {
      const def = core.getField(seg, f.seq);
      if (!def) mismatches.push(`${seg}-${f.seq} missing`);
      else if (norm(def.name) !== norm(f.name) && !norm(def.name).includes(norm(f.name)) && !norm(f.name).includes(norm(def.name))) mismatches.push(`${seg}-${f.seq}: '${f.name}' vs v2.5.1 '${def.name}'`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("PD1-8 is Organ Donor Code (PD1-6 is Handicap)", () => {
  const pd1 = SEGMENT_MAPS.PD1.fields;
  assert.equal(pd1.find((f) => f.seq === 8)?.name, "Organ Donor Code");
  assert.equal(pd1.find((f) => f.seq === 6), undefined);
  assert.equal(core.getField("PD1", 6).name, "Handicap");
});

test("every curated datatype component exists in v2.5.1", () => {
  const bad = [];
  for (const [dt, m] of Object.entries(DATATYPE_MAPS)) {
    const def = core.getDatatype(dt);
    assert.ok(def, `${dt} exists in v2.5.1`);
    for (const c of m.components) if (!(def.components ?? []).some((x) => x.seq === c.comp)) bad.push(`${dt}.${c.comp}`);
  }
  assert.deepEqual(bad, []);
  assert.equal(DATATYPE_MAPS.CE.components.some((c) => c.comp === 9), false, "CE has 6 components in v2.5.1");
});

test("curated ConceptMap codes are v2.5.1 codes (exceptions listed)", () => {
  // 0396: coding-system abbreviations; the curated list includes patterns and later additions handled in data.
  const skip = new Set(["0396"]);
  const notValid = [];
  for (const [t, m] of Object.entries(CONCEPT_MAPS)) {
    if (skip.has(t)) continue;
    for (const e of m.map) {
      if (e.code === "" && t === "0136") continue; // the "empty indicator" guidance row
      const st = core.checkCode(t, e.code);
      if (st?.status !== "valid") notValid.push(`${t}:${e.code}=${st?.status ?? "unknown"}`);
    }
  }
  // Every entry here is a code the server maps but v2.5.1 does not confirm; they must be explicit.
  assert.deepEqual(notValid.sort(), EXPECTED_NOT_VALID.sort());
  for (const k of EXPECTED_NOT_VALID) {
    const [t, rest] = k.split(":");
    const code = rest.split("=")[0];
    assert.equal(CONCEPT_MAPS[t].map.find((e) => e.code === code).notInV251, true, `${k} is labelled notInV251`);
  }
});

test("0002 covers all 16 v2.5.1 codes and matches the IG ConceptMap", () => {
  const v251 = core.tableCodes("0002", { status: "valid" }).map((c) => c.code).sort();
  assert.deepEqual(CONCEPT_MAPS["0002"].map.map((m) => m.code).sort(), v251);
  const d = conceptMapDivergence("0002");
  assert.deepEqual(d.summary, { same: 16, differs: 0, serverOnly: 0, igOnly: 0 });
  const by = Object.fromEntries(CONCEPT_MAPS["0002"].map.map((m) => [m.code, m]));
  assert.equal(by.A.fhir, "L");
  assert.equal(by.N.fhir, "A");
  assert.equal(by.T.fhir, "NAVU");
  assert.match(by.U.system, /v3-NullFlavor$/);
});

test("message maps list produced resources and pitfalls", () => {
  for (const [k, m] of Object.entries(MESSAGE_MAPS)) {
    assert.ok(m.produces.length, k);
    assert.ok(m.pitfalls.length, k);
    const [type, trig] = k.split("^");
    assert.ok(core.getEvent(`${type}^${trig}`), `${k} is a v2.5.1 event`);
  }
});

const EXPECTED_NOT_VALID = ["0125:CWE=not-in-2.5.1", "0125:IS=not-in-2.5.1"];
