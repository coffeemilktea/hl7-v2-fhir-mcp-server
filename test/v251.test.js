/**
 * HL7 v2.5.1 reading rules, end to end through convert(): delimiters from
 * MSH-1/MSH-2, escapes, repetitions, the HL7 null, segment terminators, input
 * validation, and the v2.5.1 datatype and table rules. Synthetic data only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../src/convert/messages.js";
import { parse, unesc, sub, tsComp, toFhirDate, toFhirTime, MAX_MESSAGE_CHARS } from "../src/convert/util.js";
import { seg } from "./fixtures.js";

const msg = (...segs) => segs.join("\r");
const res = (r, type) => r.bundle.entry.map((e) => e.resource).filter((x) => x.resourceType === type);
const one = (r, type) => {
  const all = res(r, type);
  assert.equal(all.length, 1, `exactly one ${type}`);
  return all[0];
};
const obsByCode = (r, code) => res(r, "Observation").find((o) => o.code.coding?.[0]?.code === code);

// ─── Realistic messages ──────────────────────────────────────────────────────

const ADT_A01 = msg(
  "MSH|^~\\&|EPICADT|GHH^2.16.840.1.113883.3.72.5.20^ISO|LABADT|GHH|20260301083000-0500||ADT^A01^ADT_A01|MSG00001|P|2.5.1|||AL|NE",
  "EVN|A01|20260301082900-0500|||JDOE^DOE^JOHN",
  seg("PID", {
    1: "1",
    3: "MRN0042^^^GHH^MR~999-99-9999^^^SSA^SS",
    5: "EVERYWOMAN^EVE^E^JR^MS^^L~SMITH^EVE^^^^^M",
    7: "19620320",
    8: "F",
    11: "2222 HOME STREET^APT 5^GREENSBORO^NC^27401-1020^USA^H~PO BOX 12^^GREENSBORO^NC^27402^USA^M~1 BIRTH RD^^BOSTON^MA^^USA^BDL",
    13: "^PRN^PH^^1^555^5552004~^ORN^PH^^^555^5559999~^NET^Internet^eve@example.org",
    14: "^WPN^PH^^^555^5553000^42",
    16: "M",
    24: "Y",
    25: "2",
  }),
  "PD1||||1234^WELBY^MARCUS",
  seg("NK1", { 1: "1", 2: "EVERYMAN^ADAM^A", 3: "SPO^Spouse^HL70063", 4: "2222 HOME STREET^^GREENSBORO^NC^27401", 5: "^PRN^PH^^^555^5552004" }),
  seg("PV1", { 1: "1", 2: "I", 3: "2000^2012^01^GHH", 4: "R", 7: "004777^ATTEND^AARON^A^^^DR", 10: "SUR", 19: "V00042^^^GHH^VN", 44: "20260301080000-0500" }),
  seg("AL1", { 1: "1", 2: "DA", 3: "70618^Penicillin^RXNORM", 4: "SV", 5: "HIVES~WHEEZING" }),
  seg("AL1", { 1: "2", 2: "MA", 3: "LATEX^Latex^99LOCAL" }),
  seg("DG1", { 1: "1", 2: "I10", 3: "K35.8^Acute appendicitis, other and unspecified^I10", 6: "W" }),
  seg("DG1", { 1: "2", 2: "I10", 3: "R10.3^Pain localized to other parts of lower abdomen^I10", 6: "A" })
);

const ORU_LAB = msg(
  "MSH|^~\\&|LAB|GHH|EMR|GHH|20260302101500-0500||ORU^R01^ORU_R01|LAB00017|P|2.5.1",
  "PID|1||MRN0042^^^GHH^MR||EVERYWOMAN^EVE||19620320|F",
  "PV1|1|O",
  "ORC|RE|PLO1001^EMR|FLO2002^LAB",
  seg("OBR", {
    1: "1", 2: "PLO1001^EMR", 3: "FLO2002^LAB", 4: "24323-8^Comprehensive metabolic panel^LN", 7: "20260302070000-0500",
    22: "20260302101000-0500", 24: "CH", 25: "F",
    32: "5678&PATHOLOGIST&PAT&&&&MD&&GHH&2.16.840.1.113883.3.72&ISO^20260302100000-0500",
  }),
  seg("OBX", { 1: "1", 2: "NM", 3: "2345-7^Glucose^LN", 5: "182", 6: "mg/dL^mg/dL^UCUM", 7: "70-99", 8: "H~A", 11: "F", 14: "20260302070000-0500" }),
  seg("OBX", { 1: "2", 2: "NM", 3: "2160-0^Creatinine^LN", 5: "0.9", 6: "mg/dL", 7: "<1.3", 8: "N", 11: "F" }),
  seg("OBX", { 1: "3", 2: "SN", 3: "33914-3^eGFR^LN", 5: ">^60", 6: "mL/min/{1.73_m2}^^UCUM", 11: "F" }),
  seg("OBX", { 1: "4", 2: "SN", 3: "T1^Antibody titer^99LOC", 5: "^1^:^128", 11: "F" }),
  seg("OBX", { 1: "5", 2: "NM", 3: "2951-2^Sodium^LN", 6: "mmol/L^^UCUM", 11: "X" }),
  seg("OBX", { 1: "6", 2: "SN", 3: "T2^Semi-quantitative result^99LOC", 5: "<>^5", 11: "F" }),
  seg("OBX", { 1: "7", 2: "TM", 3: "X1^Collection time^99LOC", 5: "0730", 11: "F" }),
  seg("OBX", { 1: "8", 2: "NM", 3: "X2^Bad number^99LOC", 5: "1e3", 11: "F" }),
  seg("OBX", { 1: "9", 2: "NM", 3: "X3^Not asked^99LOC", 11: "N" }),
  seg("OBX", { 1: "10", 2: "CWE", 3: "X4^Later-version type^99LOC", 5: "POS^Positive^99LOC", 11: "F" }),
  "NTE|1||Specimen slightly hemolyzed.",
  seg("SPM", { 1: "1", 2: "SP77&LAB", 4: "119297000^Blood specimen^SCT", 17: "20260302065500-0500^20260302070000-0500" })
);

const ORM_O01 = msg(
  "MSH|^~\\&|EMR|GHH|RIS|GHH|20260303090000-0500||ORM^O01^ORM_O01|ORD0003|P|2.5.1",
  "PID|1||MRN0042^^^GHH^MR||EVERYWOMAN^EVE||19620320|F",
  "PV1|1|O",
  seg("ORC", { 1: "NW", 2: "PL5001^EMR", 5: "SC", 9: "20260303090000-0500", 12: "1234^WELBY^MARCUS" }),
  seg("OBR", { 1: "1", 2: "PL5001^EMR", 4: "71046^XR CHEST 2 VIEWS^C4", 13: "Cough for 3 weeks; rule out pneumonia", 31: "R05^Cough^I10~J18.9^Pneumonia, unspecified^I10" })
);

describe("realistic v2.5.1 messages", () => {
  test("ADT^A01: identifiers, names, addresses, telecom, contacts, allergies, diagnoses", () => {
    const r = convert(ADT_A01);
    assert.equal(r.messageType, "ADT^A01");
    const p = one(r, "Patient");
    assert.deepEqual(p.identifier.map((i) => i.value), ["MRN0042", "999-99-9999"]);
    assert.deepEqual(p.name[0], { use: "official", family: "EVERYWOMAN", given: ["EVE", "E"], prefix: ["MS"], suffix: ["JR"] });
    assert.equal(p.name[1].use, "maiden");
    assert.equal(p.birthDate, "1962-03-20");
    assert.equal(p.gender, "female");
    // XAD.7: H → home, M → postal type (not home use), BDL is birth delivery location (not billing).
    assert.equal(p.address[0].use, "home");
    assert.equal(p.address[0].line.join("|"), "2222 HOME STREET|APT 5");
    assert.deepEqual([p.address[1].use, p.address[1].type], [undefined, "postal"]);
    assert.equal(p.address[2].use, undefined);
    // XTN.2: ORN is a residence (home), NET + Internet is email; PID-14 WPN with extension.
    assert.deepEqual(p.telecom.map((t) => [t.system, t.use, t.value]), [
      ["phone", "home", "+1 (555) 5552004"],
      ["phone", "home", "(555) 5559999"],
      ["email", undefined, "eve@example.org"],
      ["phone", "work", "(555) 5553000 ext. 42"],
    ]);
    assert.equal(p.multipleBirthInteger, 2);
    assert.equal(p.contact[0].name.family, "EVERYMAN");
    const enc = one(r, "Encounter");
    assert.equal(enc.class.code, "IMP");
    assert.equal(enc.period.start, "2026-03-01T08:00:00-05:00");
    const [pen, latex] = res(r, "AllergyIntolerance");
    assert.deepEqual(pen.category, ["medication"]);
    assert.deepEqual(pen.reaction[0].manifestation, [{ text: "HIVES" }, { text: "WHEEZING" }], "AL1-5 is ST: text, not codes");
    assert.equal(pen.reaction[0].severity, "severe");
    assert.equal(latex.category, undefined, "MA (miscellaneous) is not a medication allergy");
    // DG1-6: W (working) has no diagnosis-role; A → AD.
    assert.equal(enc.diagnosis[0].use, undefined);
    assert.equal(enc.diagnosis[1].use.coding[0].code, "AD");
  });

  test("ORU^R01 lab: NM/SN/TM values, units, ranges, flags, NDL interpreter, SPM DR", () => {
    const r = convert(ORU_LAB);
    const glucose = obsByCode(r, "2345-7");
    assert.deepEqual(glucose.valueQuantity, { value: 182, unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" });
    assert.deepEqual(glucose.referenceRange, [{ low: { value: 70 }, high: { value: 99 }, text: "70-99" }]);
    assert.deepEqual(glucose.interpretation.map((i) => i.coding[0].code), ["H", "A"]);
    const creat = obsByCode(r, "2160-0");
    assert.deepEqual(creat.valueQuantity, { value: 0.9, unit: "mg/dL" }, "no Quantity.code without a system (qty-3)");
    assert.deepEqual(creat.referenceRange[0].high, { value: 1.3 });
    assert.equal(obsByCode(r, "33914-3").valueQuantity.comparator, ">");
    assert.deepEqual(obsByCode(r, "T1").valueRatio, { numerator: { value: 1 }, denominator: { value: 128 } });
    const sodium = obsByCode(r, "2951-2");
    assert.equal(sodium.valueQuantity, undefined, "empty NM is no value, not 0");
    assert.equal(sodium.status, "cancelled");
    assert.equal(obsByCode(r, "T2").valueString, "<>5", "<> is not a FHIR comparator");
    assert.equal(obsByCode(r, "X1").valueTime, "07:30:00");
    const bad = obsByCode(r, "X2");
    assert.equal(bad.valueString, "1e3", "exponents are not v2 NM");
    assert.equal(obsByCode(r, "X3").status, "cancelled", "OBX-11 N (not asked) is a v2.5.1 code");
    assert.ok(!r.warnings.some((w) => /OBX-11 'N' is not in HL7 table 0085/.test(w)));
    assert.equal(obsByCode(r, "X4").valueCodeableConcept.coding[0].code, "POS");
    assert.ok(r.warnings.some((w) => /OBX-2 'CWE' is not a v2\.5\.1 table 0125 value type/.test(w)));
    assert.ok(!r.warnings.some((w) => /OBX-2 '(NM|SN|TM)' is not/.test(w)));
    const report = one(r, "DiagnosticReport");
    const interp = res(r, "Practitioner").find((p) => p.identifier?.[0]?.value === "5678");
    assert.ok(interp, "OBR-32 NDL → Practitioner");
    assert.deepEqual(interp.name[0], { family: "PATHOLOGIST", given: ["PAT"] });
    assert.equal(interp.identifier[0].system, "urn:oid:2.16.840.1.113883.3.72");
    assert.equal(report.resultsInterpreter.length, 1);
    assert.deepEqual(one(r, "Specimen").collection.collectedPeriod, { start: "2026-03-02T06:55:00-05:00", end: "2026-03-02T07:00:00-05:00" });
  });

  test("ORM^O01: OBR-13 (ST) is a note, OBR-31 repeats into reasonCode", () => {
    const r = convert(ORM_O01);
    const sr = one(r, "ServiceRequest");
    assert.deepEqual(sr.reasonCode.map((c) => c.coding[0].code), ["R05", "J18.9"]);
    assert.ok(sr.note.some((n) => /Cough for 3 weeks; rule out pneumonia/.test(n.text)));
    assert.equal(sr.code.coding[0].system, "http://www.ama-assn.org/go/cpt");
  });
});

// ─── Delimiters, escapes, repetitions, null, terminators ─────────────────────

describe("encoding rules", () => {
  test("custom delimiters are read from MSH-1/MSH-2", () => {
    const custom = msg(
      "MSH#$*%@#LAB#GHH#EMR#GHH#20260302101500-0500##ORU$R01$ORU_R01#C1#P#2.5.1######UNICODE UTF-8",
      "PID#1##MRN1$$$GHH@2.16.840.1.113883.19@ISO$MR*MRN2$$$GHH$PI##O%T%BRIEN$SEAN##19800229#M",
      "OBR#1#PL1#FL1#24331-1$Lipid panel$LN",
      "OBX#1#ST#X$t$99LOC##pipe %F% caret %S% tilde %R% amp %T% esc %E% e-acute %XC3A9%#####F"
    );
    const r = convert(custom);
    const p = one(r, "Patient");
    assert.deepEqual(p.identifier.map((i) => [i.value, i.system]), [["MRN1", "urn:oid:2.16.840.1.113883.19"], ["MRN2", "urn:id:GHH"]]);
    assert.equal(p.name[0].family, "O@BRIEN", "%T% decodes to the subcomponent separator");
    assert.equal(p.birthDate, "1980-02-29");
    assert.equal(obsByCode(r, "X").valueString, "pipe # caret $ tilde * amp @ esc % e-acute é", "MSH-18 UTF-8 hex");
  });

  test("standard escapes, hex in ISO 8859-1, formatting commands", () => {
    const ctx = { fieldSep: "|", compSep: "^", repSep: "~", escChar: "\\", subSep: "&" };
    assert.equal(unesc("a\\F\\b\\S\\c\\R\\d\\T\\e\\E\\f", ctx), "a|b^c~d&e\\f");
    assert.equal(unesc("caf\\XE9\\", ctx), "café", "default character set is ISO 8859-1");
    assert.equal(unesc("caf\\XC3A9\\", { ...ctx, charset: "UNICODE UTF-8" }), "café");
    assert.equal(unesc("line1\\.br\\line2\\.sp 2\\line4", ctx), "line1\nline2\n\nline4");
    assert.equal(unesc("\\H\\bold\\N\\ \\.in+4\\x", ctx), "bold x");
    assert.equal(unesc("keep \\Zlocal\\ and \\C2842\\", ctx), "keep \\Zlocal\\ and \\C2842\\", "unknown escapes are kept verbatim");
    assert.equal(unesc("dangling \\F", ctx), "dangling \\F");
  });

  test("a three-character MSH-2 leaves & literal (no subcomponent separator)", () => {
    const { ctx } = parse("MSH|^~\\|A|B|C|D|20260101||ADT^A04|1|P|2.5.1\rPID|1||X");
    assert.equal(ctx.subSep, undefined);
    const r = convert("MSH|^~\\|A|B|C|D|20260101||ADT^A04|1|P|2.5.1\rPID|1||M1^^^H^MR||SMITH & SONS^ANN\rPV1|1|O");
    assert.equal(one(r, "Patient").name[0].family, "SMITH & SONS");
    assert.ok(r.warnings.some((w) => /MSH-2 '\^~\\' has 3 encoding character/.test(w)));
  });

  test("\\r, \\n, \\r\\n and MLLP framing give the same bundle", () => {
    const base = convert(ADT_A01).bundle;
    assert.deepEqual(convert(ADT_A01.replace(/\r/g, "\n")).bundle, base);
    assert.deepEqual(convert(ADT_A01.replace(/\r/g, "\r\n")).bundle, base);
    assert.deepEqual(convert(`\x0B${ADT_A01}\r\x1C\r`).bundle, base);
    assert.deepEqual(convert(`﻿\n\n${ADT_A01}\n\n`).bundle, base);
  });

  test("empty vs HL7 null (\"\"): both omit the element; the null is reported as a delete", () => {
    const withSex = (v) => convert(ADT_A01.replace("|19620320|F|", `|19620320|${v}|`));
    const empty = withSex("");
    const nulled = withSex('""');
    assert.equal(one(empty, "Patient").gender, undefined);
    assert.equal(one(nulled, "Patient").gender, undefined);
    assert.ok(!nulled.warnings.some((w) => /table 0001/.test(w)), "\"\" is not an invalid code");
    assert.ok(nulled.notes.some((n) => /PID-8 was sent as the HL7 null/.test(n)));
    assert.ok(!empty.notes.some((n) => /HL7 null/.test(n)));
    const comp = convert(ADT_A01.replace("EVERYWOMAN^EVE^E^JR^MS^^L", 'EVERYWOMAN^EVE^""^JR^MS^^L'));
    assert.deepEqual(one(comp, "Patient").name[0].given, ["EVE"]);
    assert.ok(comp.notes.some((n) => /components were sent as the HL7 null/.test(n)));
  });

  test("repetitions: empty and null repetitions are skipped", () => {
    const r = convert(ADT_A01.replace("MRN0042^^^GHH^MR~999-99-9999^^^SSA^SS", 'MRN0042^^^GHH^MR~~""~999-99-9999^^^SSA^SS'));
    assert.deepEqual(one(r, "Patient").identifier.map((i) => i.value), ["MRN0042", "999-99-9999"]);
  });

  test("a stray line (unescaped line break inside a field) is reported and ignored", () => {
    const r = convert(ORU_LAB.replace("Specimen slightly hemolyzed.", "Specimen slightly\nhemolyzed."));
    assert.ok(r.warnings.some((w) => /Line \d+ \('hemolyzed\.'\) is not a segment/.test(w)));
  });
});

// ─── Timestamps ──────────────────────────────────────────────────────────────

describe("TS/DTM and TM", () => {
  test("precision is preserved and invalid calendar values are rejected", () => {
    assert.equal(toFhirDate("2026"), "2026");
    assert.equal(toFhirDate("202603"), "2026-03");
    assert.equal(toFhirDate("20260302"), "2026-03-02");
    assert.equal(toFhirDate("202603021015"), "2026-03-02T10:15:00");
    assert.equal(toFhirDate("20260302101530.1234+0530"), "2026-03-02T10:15:30.1234+05:30");
    assert.equal(toFhirDate("20260302&D"), undefined, "callers pass TS.1 only (tsComp for a TS inside a composite)");
    assert.equal(toFhirDate("20260302 1015"), undefined, "no silent truncation");
    assert.equal(toFhirDate("202603021015.5"), undefined, "a fraction needs seconds");
    for (const bad of ["20250229", "20261301", "20260302250000", "20260302101500+2500", "2026-03-02", "abc"]) {
      assert.equal(toFhirDate(bad), undefined, bad);
    }
    assert.equal(toFhirTime("0730"), "07:30:00");
    assert.equal(toFhirTime("235959.5-0500"), "23:59:59.5");
    assert.equal(toFhirTime("2460"), undefined);
  });

  test("an invalid PID-7 is reported, not converted to an impossible date", () => {
    const r = convert(ADT_A01.replace("|19620320|", "|19620230|"));
    assert.equal(one(r, "Patient").birthDate, undefined);
    assert.ok(r.warnings.some((w) => /'19620230' is not a valid v2\.5\.1 DTM/.test(w)));
  });
});

// ─── MSH checks and input validation ─────────────────────────────────────────

describe("MSH and input validation", () => {
  const rejects = (input, re) => assert.throws(() => convert(input), re);

  test("not a single v2 message", () => {
    rejects("", /empty/);
    rejects("\r\n\r\n", /empty/);
    rejects("PID|1||X", /must begin with an MSH/);
    rejects("FHS|^~\\&|A\rBHS|^~\\&|A\r" + ADT_A01, /batch/);
    rejects(`${ADT_A01}\r${ADT_A01}`, /more than one message/);
    rejects("x".repeat(MAX_MESSAGE_CHARS + 1), /limit/);
  });

  test("bad delimiters", () => {
    rejects("MSH|^~\\^|A|B", /not all distinct/);
    rejects("MSHA^~\\&A", /field separator 'A' is not valid/);
    rejects("MSH||A|B", /MSH-2 \(encoding characters\) is empty/);
    rejects("MSH|^~ &|A|B", /letter, digit or whitespace/);
  });

  test("MSH-9 must name a trigger; ACKs are not convertible; unknown types are out of scope", () => {
    rejects("MSH|^~\\&|A|B|C|D|20260101||ADT|1|P|2.5.1", /MSH-9/);
    rejects("MSH|^~\\&|A|B|C|D|20260101||ACK^A01^ACK|2|P|2.5.1\rMSA|AA|1", /acknowledgement/);
    rejects("MSH|^~\\&|A|B|C|D|20260101||ACK|2|P|2.5.1\rMSA|AA|1", /acknowledgement/);
    rejects("MSH|^~\\&|A|B|C|D|20260101||VXU^V04^VXU_V04|3|P|2.5.1", /out of scope/);
  });

  test("MSH-7/11/12 problems are warnings, not failures", () => {
    const r = convert(ADT_A01.replace("|20260301083000-0500||ADT^A01^ADT_A01|MSG00001|P|2.5.1|", "|||ADT^A01^ADT_A01|MSG00001|T|2.3|"));
    assert.ok(r.warnings.some((w) => /MSH-7 .* is empty/.test(w)));
    assert.ok(r.warnings.some((w) => /MSH-11 processing ID is 'T' \(training\)/.test(w)));
    assert.ok(r.warnings.some((w) => /MSH-12 declares version '2\.3', not 2\.5\.1/.test(w)));
    assert.equal(r.bundle.timestamp, undefined);
    const noVersion = convert(ADT_A01.replace("|P|2.5.1|", "|P||"));
    assert.ok(noVersion.warnings.some((w) => /MSH-12 \(version ID\) is empty/.test(w)));
  });
});

// ─── Composite timestamps, character sets, unused delimiters ─────────────────

describe("composites and character sets", () => {
  const H = "MSH|^~\\&|A|GHH|B|GHH|20260301083000-0500||";

  test("a TS inside a composite is read as TS.1&TS.2 (XPN.12/13, XAD.13/14, CX.7/8, DR, TQ.4)", () => {
    const ctx = parse(`${H}ADT^A04^ADT_A01|1|P|2.5.1`).ctx;
    assert.equal(tsComp(ctx)("x^20260302&D^y", 2), "20260302");
    const r = convert(msg(
      `${H}ADT^A04^ADT_A01|TS1|P|2.5.1`,
      "PID|1||MRN1^^^GHH^MR^^20200101^20301231||DOE^JANE^^^^^L^^^^^20200615&D^20250615&D||19800101|F|||&MAIN ST&12^^SPRINGFIELD^IL^62701^USA^H^^^^^^20210101&D",
      "PV1|1|O"
    ));
    const p = one(r, "Patient");
    assert.deepEqual(p.identifier[0].period, { start: "2020-01-01", end: "2030-12-31" });
    assert.deepEqual(p.name[0].period, { start: "2020-06-15", end: "2025-06-15" });
    assert.deepEqual(p.address[0].line, ["12 MAIN ST"], "SAD.3 + SAD.2 when SAD.1 is empty");
    assert.deepEqual(p.address[0].period, { start: "2021-01-01" });
    const orm = convert(msg(
      `${H}ORM^O01^ORM_O01|TS2|P|2.5.1`,
      "PID|1||MRN1^^^GHH^MR",
      seg("ORC", { 1: "NW", 2: "PL1^EMR", 5: "SC", 7: "1^^^20260310090000-0500&M^^S~1^^^20260311090000-0500^^R" })
    ));
    const sr = one(orm, "ServiceRequest");
    assert.equal(sr.occurrenceDateTime, "2026-03-10T09:00:00-05:00", "first TQ repetition, TQ.4 TS.1");
    assert.equal(sr.priority, "stat");
  });

  test("hex escapes in an unsupported MSH-18 character set are kept and reported", () => {
    const r = convert(msg(`${H}ORU^R01^ORU_R01|CS1|P|2.5.1||||||UNICODE UTF-16`, "PID|1||MRN1^^^GHH^MR", "OBR|1|P1|F1|X^Y^99L", "OBX|1|ST|X^Y^99L||caf\\X00E9\\||||||F"));
    assert.equal(obsByCode(r, "X").valueString, "caf\\X00E9\\");
    assert.ok(r.warnings.some((w) => /MSH-18 character set 'UNICODE UTF-16' is not supported/.test(w)));
    assert.equal(unesc("caf\\XE9\\", { escChar: "\\", charset: "8859/1" }), "café");
  });

  test("an unused delimiter never splits (no fallback to the default ^)", () => {
    assert.equal(sub({ compSep: "^", escChar: "\\" })("a^b", 1), "a^b");
  });

  test("AL1 with an empty or unknown AL1-2 gets no AllergyIntolerance.type", () => {
    const allergy = (type) =>
      one(convert(msg(`${H}ADT^A01^ADT_A01|AL${type}|P|2.5.1`, "PID|1||MRN1^^^GHH^MR", "PV1|1|I", `AL1|1|${type}|X^Latex^99L`)), "AllergyIntolerance");
    assert.equal(allergy("").type, undefined);
    assert.equal(allergy("ZZ").type, undefined);
    assert.equal(allergy("MC").type, undefined, "a contraindication is not an allergy");
    assert.equal(allergy("MA").type, "allergy");
  });

  test("HD universal ID becomes a system only when it is valid for its table 0301 type", () => {
    const pids = (pid3) => one(convert(msg(`${H}ADT^A01^ADT_A01|HD${pid3.length}|P|2.5.1`, `PID|1||${pid3}`, "PV1|1|I")), "Patient");
    const p = pids(
      "A^^^&2.16.840.1.113883.19&ISO~B^^^&A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11&UUID~C^^^&https://id.example.org/mrn&URI" +
      "~D^^^&hospital.example.org&DNS~E^^^&not-an-oid&ISO~F^^^&not-a-uuid&GUID"
    );
    assert.deepEqual(p.identifier.map((i) => i.system), [
      "urn:oid:2.16.840.1.113883.19",
      "urn:uuid:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "https://id.example.org/mrn",
      "urn:id:hospital.example.org",
      "urn:id:not-an-oid",
      "urn:id:not-a-uuid",
    ]);
    const r = convert(msg(`${H}ADT^A01^ADT_A01|HD2|P|2.5.1`, "PID|1||D^^^&hospital.example.org&DNS~E^^^&1.2.x&ISO", "PV1|1|I"));
    assert.ok(r.warnings.some((w) => /'hospital\.example\.org' with universal ID type 'DNS', which has no standard URI form/.test(w)));
    assert.ok(r.warnings.some((w) => /'1\.2\.x' with a universal ID that is not a valid OID/.test(w)));
  });
});
