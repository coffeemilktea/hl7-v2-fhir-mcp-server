/** Message conversion: the review fixes, the existing converters and the new ones. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../src/convert/messages.js";
import * as F from "./fixtures.js";
import { setField, dropSegment } from "./fixtures.js";

const res = (r, type) => r.bundle.entry.map((e) => e.resource).filter((x) => x.resourceType === type);
const one = (r, type) => {
  const all = res(r, type);
  assert.equal(all.length, 1, `exactly one ${type}`);
  return all[0];
};
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");

describe("review fixes", () => {
  test("0002: v2 A (Separated) → v3 L, N (Annulled) → A, U → NullFlavor UNK", () => {
    const withMarital = (code) => convert(setField(F.ADT_A01, "PID", 16, code));
    assert.deepEqual(one(withMarital("A"), "Patient").maritalStatus.coding[0], { system: "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus", code: "L" });
    assert.equal(one(withMarital("N"), "Patient").maritalStatus.coding[0].code, "A");
    assert.deepEqual(one(withMarital("U"), "Patient").maritalStatus.coding[0], { system: "http://terminology.hl7.org/CodeSystem/v3-NullFlavor", code: "UNK" });
    const bad = withMarital("L");
    assert.equal(one(bad, "Patient").maritalStatus, undefined);
    assert.ok(bad.warnings.some((w) => /PID-16 'L' is not in HL7 v2\.5\.1 table 0002/.test(w)));
  });
  test("vital-sign LOINCs get Observation.category = vital-signs", () => {
    const r = convert(F.ORU_R01);
    const hr = res(r, "Observation").find((o) => o.code.coding[0].code === "8867-4");
    assert.ok(hr.category.some((c) => c.coding[0].code === "vital-signs"));
    assert.ok(hr.category.some((c) => c.coding[0].code === "imaging"), "OBR-24 category kept too");
  });
  test("vital sign without OBX-14 is warned about", () => {
    const r = convert(setField(F.OML_O21, "OBX", 14, ""));
    assert.ok(r.warnings.some((w) => /vital-sign LOINC but OBX-14/.test(w)));
  });
  test("CWE.9 original text becomes CodeableConcept.text", () => {
    const r = convert(setField(F.ADT_A01, "PV1", 10, "MED^Medicine^99LOCAL^^^^^^General medicine"));
    assert.equal(one(r, "Encounter").serviceType.text, "General medicine");
  });
  test("EI identifiers keep their namespace (ORC-2/3, OBR-2/3)", () => {
    const r = convert(F.OML_O21);
    const sr = one(r, "ServiceRequest");
    assert.deepEqual(sr.identifier[0], { system: "urn:id:EMR", value: "PL4001", type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "PLAC" }] } });
  });
  test("PV1-36 discharge disposition is not given a non-existent THO system", () => {
    const r = convert(F.ADT_A03);
    const enc = one(r, "Encounter");
    assert.deepEqual(enc.hospitalization.dischargeDisposition, { coding: [{ code: "01" }], text: "01" });
    assert.equal(enc.status, "finished");
  });
});

describe("existing conversions still behave", () => {
  test("ORM: ServiceRequest + ImagingStudy from ZDS", () => {
    const r = convert(F.ORM_O01);
    assert.equal(one(r, "ServiceRequest").status, "active");
    assert.match(one(r, "ImagingStudy").identifier[0].value, /^urn:oid:1\.2\.840/);
  });
  test("A40 retires the MRG identifier", () => {
    const pts = res(convert(F.ADT_A40), "Patient");
    assert.equal(pts.length, 2);
    assert.equal(pts.find((p) => p.active === false).identifier[0].value, "MRN99999");
  });
  test("A31 with PV1 emits no Encounter", () => {
    assert.equal(res(convert(F.ADT_A31), "Encounter").length, 0);
  });
  test("conversion is deterministic", () => {
    assert.deepEqual(convert(F.SIU_S12).bundle, convert(F.SIU_S12).bundle);
  });
  test("unsupported types are refused with the supported list", () => {
    assert.throws(() => convert("MSH|^~\\&|A|B|C|D|20261019||VXU^V04^VXU_V04|1|P|2.5.1"), /out of scope.*SIU, MDM/);
  });
});

describe("SIU → Appointment", () => {
  test("S12 booked appointment", () => {
    const r = convert(F.SIU_S12);
    const a = one(r, "Appointment");
    assert.equal(a.status, "booked");
    assert.equal(a.start, "2026-10-21T09:00:00-07:00");
    assert.equal(a.end, "2026-10-21T09:30:00-07:00");
    assert.equal(a.minutesDuration, 30);
    assert.deepEqual(a.identifier.map((i) => i.value), ["APT1001", "APT1001F"]);
    assert.equal(a.serviceType[0].coding[0].code, "74177");
    assert.equal(a.appointmentType.coding[0].system, "http://terminology.hl7.org/CodeSystem/v2-0277");
    assert.equal(a.participant.length, 3, "patient, practitioner, location");
    assert.ok(a.participant.every((p) => p._status?.extension?.[0]?.valueCode === "unknown"));
    assert.ok(r.warnings.some((w) => /participant\.status is required/.test(w)));
  });
  test("participantStatus option is applied and noted", () => {
    const r = convert(F.SIU_S12, { participantStatus: "accepted" });
    assert.ok(one(r, "Appointment").participant.every((p) => p.status === "accepted"));
    assert.ok(r.notes.some((n) => /because the caller asked for it/.test(n)));
  });
  test("upper-case 0278 code is matched but flagged", () => {
    const r = convert(setField(F.SIU_S12, "SCH", 25, "BOOKED"));
    assert.equal(one(r, "Appointment").status, "booked");
    assert.ok(r.warnings.some((w) => /SCH-25 'BOOKED' is not confirmed as a v2\.5\.1 table 0278 value; matched 'Booked'/.test(w)));
  });
  test("0278 code with no IG target → data-absent status", () => {
    const r = convert(setField(F.SIU_S12, "SCH", 25, "Blocked"));
    const a = one(r, "Appointment");
    assert.equal(a.status, undefined);
    assert.equal(a._status.extension[0].valueCode, "unknown");
  });
  test("S15 with empty SCH-25 is cancelled (trigger semantics)", () => {
    const msg = setField(setField(F.SIU_S12, "SCH", 25, ""), "MSH", 9, "SIU^S15^SIU_S12");
    const r = convert(msg);
    assert.equal(one(r, "Appointment").status, "cancelled");
  });
  test("zoneless start is not used as an instant", () => {
    const msg = setField(dropSegment(F.SIU_S12, "AIS"), "TQ1", 7, "202610210900");
    const r = convert(msg);
    assert.equal(one(r, "Appointment").start, undefined);
    assert.ok(r.warnings.some((w) => /cannot be Appointment\.start/.test(w)));
  });
});

describe("MDM → DocumentReference", () => {
  test("T02 document with TX content", () => {
    const r = convert(F.MDM_T02);
    const d = one(r, "DocumentReference");
    assert.equal(d.status, "current");
    assert.equal(d.masterIdentifier.value, "DOC5001");
    assert.equal(d.type.coding[0].code, "DS");
    assert.equal(d.date, "2026-10-19T14:30:00-07:00");
    assert.equal(d.securityLabel[0].coding[0].code, "R");
    assert.equal(d.content[0].attachment.contentType, "text/plain; charset=utf-8");
    assert.equal(b64(d.content[0].attachment.data), "Patient discharged in good condition.\nFollow up in 2 weeks.");
    assert.ok(d.context.encounter[0].reference.startsWith("urn:uuid:"));
    assert.ok(r.notes.some((n) => /TXA-17 completion status 'AU'/.test(n)));
  });
  test("T10 replacement relates to the parent document", () => {
    const d = one(convert(F.MDM_T10), "DocumentReference");
    assert.equal(d.relatesTo[0].code, "replaces");
    assert.equal(d.relatesTo[0].target.identifier.value, "DOC5001");
  });
  test("ED content is decoded to base64 with ED.3 as contentType", () => {
    const msg = setField(setField(F.MDM_T02, "OBX", 2, "ED"), "OBX", 5, "^AP^application/pdf^Base64^JVBERi0xLjQK");
    const d = one(convert(msg), "DocumentReference");
    assert.deepEqual(d.content[0].attachment, { contentType: "application/pdf", data: "JVBERi0xLjQK" });
  });
  test("missing TXA-12 is warned about; T01 notification has no content", () => {
    const msg = setField(setField(dropSegment(F.MDM_T02, "OBX"), "TXA", 12, ""), "MSH", 9, "MDM^T01^MDM_T01");
    const r = convert(msg);
    assert.ok(r.warnings.some((w) => /TXA-12/.test(w)));
    assert.ok(r.notes.some((n) => /notification without content/.test(n)));
  });
  test("unavailable document status goes in an alternate-codes extension", () => {
    const d = one(convert(setField(F.MDM_T02, "TXA", 19, "UN")), "DocumentReference");
    assert.equal(d.status, undefined);
    assert.equal(d._status.extension[0].valueCodeableConcept.coding[0].code, "UN");
  });
});

describe("OML / OMI orders", () => {
  test("OML^O21: specimen, supporting info, TQ1 priority and timing", () => {
    const r = convert(F.OML_O21);
    const sr = one(r, "ServiceRequest");
    assert.equal(sr.priority, "stat");
    assert.equal(sr.occurrencePeriod.start, "2026-10-19T11:00:00-07:00");
    assert.equal(sr.specimen.length, 1);
    assert.equal(sr.supportingInfo.length, 1);
    const spm = one(r, "Specimen");
    assert.equal(spm.identifier[0].value, "SF4001", "filler specimen ID preferred");
    assert.equal(spm.type.coding[0].system, "http://terminology.hl7.org/CodeSystem/v2-0487");
    const obs = one(r, "Observation");
    assert.ok(obs.category.some((c) => c.coding[0].code === "exam"));
    assert.equal(obs.basedOn, undefined, "supporting info, not fulfilment");
  });
  test("OMI^O23: IPC → ImagingStudy (UID, DICOM modality) + ACSN identifier", () => {
    const r = convert(F.OMI_O23);
    const sr = one(r, "ServiceRequest");
    assert.ok(sr.identifier.some((i) => i.value === "ACC3001" && i.type.coding[0].code === "ACSN"));
    const study = one(r, "ImagingStudy");
    assert.equal(study.identifier[0].value, "urn:oid:1.2.840.113619.2.55.3.1.1");
    assert.deepEqual(study.modality, [{ system: "http://dicom.nema.org/resources/ontology/DCM", code: "CT", display: "Computed Tomography" }]);
    assert.equal(study.basedOn[0].reference, r.bundle.entry.find((e) => e.resource.resourceType === "ServiceRequest").fullUrl);
  });
});
