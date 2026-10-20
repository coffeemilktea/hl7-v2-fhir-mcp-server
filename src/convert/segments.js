/** Segment → FHIR resource builders. */
import { CONCEPT_MAPS, TERM } from "../maps.js";
import { c, sub, rawComp, reps, unesc, toFhirDate, zonelessTime } from "./util.js";
import { systemFrom, toCodeableConcept, toIdentifier, toIdentifierEI, toIdentifiersEIP, toHumanName, toAddress, toContactPoint } from "./datatypes.js";
import { conditional } from "./bundle.js";

export const GENDER = Object.fromEntries(CONCEPT_MAPS["0001"].map.map((m) => [m.code, m.fhir]));
export const ENCOUNTER_CLASS = Object.fromEntries(CONCEPT_MAPS["0004"].map.filter((m) => m.fhir !== "(none)").map((m) => [m.code, m.fhir]));
export const ENCOUNTER_PRIORITY = Object.fromEntries(CONCEPT_MAPS["0007"].map.map((m) => [m.code, m.fhir]));
export const MARITAL = Object.fromEntries(CONCEPT_MAPS["0002"].map.map((m) => [m.code, m]));
export const ORDER_STATUS = Object.fromEntries(CONCEPT_MAPS["0038"].map.map((m) => [m.code, m.fhir]));
export const REPORT_STATUS = Object.fromEntries(CONCEPT_MAPS["0123"].map.map((m) => [m.code, m.fhir]));
export const OBS_STATUS = Object.fromEntries(CONCEPT_MAPS["0085"].map.map((m) => [m.code, m.fhir]));
export const REPORT_CATEGORY = { RAD: "imaging", LAB: "laboratory", CH: "laboratory", HM: "laboratory", MB: "laboratory", BB: "laboratory", CP: "laboratory", CT: "imaging", MR: "imaging", NM: "imaging", US: "imaging", XR: "imaging", CUS: "imaging", OT: "procedure" };

/** PID (+ optional PD1) → Patient. */
export function buildPatient(pid, pd1, ctx, b) {
  const g = c(ctx);
  const identifiers = reps(pid.f(3), ctx.repSep)
    .map((r) => toIdentifier(r, ctx, b.warn))
    .filter(Boolean);
  if (!identifiers.length) b.warn("PID-3 carried no usable identifier. The Patient can only be created, never matched — every replay will make a duplicate.");
  const primary = identifiers.find((i) => i.type?.coding?.[0]?.code === "MR") ?? identifiers[0];

  const names = reps(pid.f(5), ctx.repSep).map((r) => toHumanName(r, ctx)).filter(Boolean);
  const birth = toFhirDate(g(pid.f(7), 1));
  const genderCode = g(pid.f(8), 1).toUpperCase();
  const gender = GENDER[genderCode];
  if (genderCode && !gender) b.warn(`PID-8 '${genderCode}' is not in HL7 table 0001; Patient.gender omitted rather than guessed.`);
  const telecom = [
    ...reps(pid.f(13), ctx.repSep).map((r) => toContactPoint(r, ctx, "home")),
    ...reps(pid.f(14), ctx.repSep).map((r) => toContactPoint(r, ctx, "work")),
  ].filter(Boolean);
  const addresses = reps(pid.f(11), ctx.repSep).map((r) => toAddress(r, ctx)).filter(Boolean);
  const maritalCode = g(pid.f(16), 1).toUpperCase();
  if (maritalCode && !MARITAL[maritalCode]) b.warn(`PID-16 '${maritalCode}' is not in HL7 v2.5.1 table 0002; Patient.maritalStatus omitted rather than guessed.`);
  const deathDate = toFhirDate(g(pid.f(29), 1));
  const language = toCodeableConcept(pid.f(15), ctx, b.warn);
  const birthOrder = g(pid.f(25), 1);
  const multipleBirth = g(pid.f(24), 1).toUpperCase();

  const resource = {
    ...(identifiers.length ? { identifier: identifiers } : {}),
    active: true,
    ...(names.length ? { name: names } : {}),
    ...(telecom.length ? { telecom } : {}),
    ...(gender ? { gender } : {}),
    ...(birth ? { birthDate: birth.slice(0, 10) } : {}),
    ...(deathDate
      ? { deceasedDateTime: deathDate }
      : g(pid.f(30), 1).toUpperCase() === "Y"
        ? { deceasedBoolean: true }
        : {}),
    ...(addresses.length ? { address: addresses } : {}),
    ...(maritalCode && MARITAL[maritalCode]
      ? { maritalStatus: { coding: [{ system: MARITAL[maritalCode].system ?? CONCEPT_MAPS["0002"].target, code: MARITAL[maritalCode].fhir }] } }
      : {}),
    ...(birthOrder
      ? { multipleBirthInteger: Number(birthOrder) }
      : multipleBirth === "Y" || multipleBirth === "N"
        ? { multipleBirthBoolean: multipleBirth === "Y" }
        : {}),
    ...(language ? { communication: [{ language, preferred: true }] } : {}),
  };

  if (birth && birth.includes("T")) {
    resource.extension = [{ url: "http://hl7.org/fhir/StructureDefinition/patient-birthTime", valueDateTime: birth }];
  }

  if (pd1) {
    const gp = reps(pd1.f(4), ctx.repSep)[0];
    if (gp) b.note("PD1-4 (primary care provider) is present; it becomes Patient.generalPractitioner once the Practitioner is resolved in your directory.");
    if (g(pd1.f(12), 1).toUpperCase() === "Y") {
      resource.meta = { security: [{ system: `${TERM}/v3-Confidentiality`, code: "R", display: "restricted" }] };
      b.note("PD1-12 protection indicator is Y — Patient.meta.security is set to restricted. Confirm your store honours it.");
    }
  }

  const handle = b.put("patient", "Patient", resource, conditional("Patient", primary));
  return { handle, primaryIdentifier: primary };
}

/** XCN → a Practitioner in the bundle, returning a Reference to it. */
export function practitionerRef(xcn, ctx, b) {
  const g = c(ctx);
  const s = sub(ctx);
  const id = g(xcn, 1);
  const family = g(xcn, 2);
  if (!id && !family) return undefined;
  const auth = rawComp(xcn, 9, ctx.compSep);
  const { system } = systemFrom(s(auth, 1), s(auth, 2), s(auth, 3));
  const typeCode = g(xcn, 13);
  const identifier = id
    ? {
        ...(typeCode ? { type: { coding: [{ system: `${TERM}/v2-0203`, code: typeCode }] } } : {}),
        ...(system ? { system } : typeCode === "NPI" ? { system: "http://hl7.org/fhir/sid/us-npi" } : {}),
        value: id,
      }
    : undefined;
  const name = {
    ...(family ? { family } : {}),
    ...([g(xcn, 3), g(xcn, 4)].filter(Boolean).length ? { given: [g(xcn, 3), g(xcn, 4)].filter(Boolean) } : {}),
    ...(g(xcn, 6) ? { prefix: [g(xcn, 6)] } : {}),
    ...(g(xcn, 5) ? { suffix: [g(xcn, 5)] } : {}),
  };
  const handle = b.put(
    `practitioner:${id || family}`,
    "Practitioner",
    {
      ...(identifier ? { identifier: [identifier] } : {}),
      ...(Object.keys(name).length ? { name: [name] } : {}),
    },
    conditional("Practitioner", identifier)
  );
  return handle.reference;
}

/** PL → a chain of Locations; returns a Reference to the most specific one. */
export function locationRef(pl, ctx, b, keyPrefix) {
  const g = c(ctx);
  const levels = [
    { comp: 4, type: "si", label: "facility" },
    { comp: 7, type: "bu", label: "building" },
    { comp: 8, type: "lvl", label: "floor" },
    { comp: 1, type: "wa", label: "point of care" },
    { comp: 2, type: "ro", label: "room" },
    { comp: 3, type: "bd", label: "bed" },
  ];
  let parent;
  let path = [];
  for (const level of levels) {
    const raw = level.comp === 4 ? rawComp(pl, 4, ctx.compSep).split(ctx.subSep)[0] : g(pl, level.comp);
    const name = unesc((raw ?? "").trim(), ctx);
    if (!name) continue;
    path.push(name);
    const handle = b.put(
      `location:${keyPrefix}:${path.join("/")}`,
      "Location",
      {
        status: "active",
        name,
        description: path.join(", "),
        physicalType: { coding: [{ system: `${TERM}/location-physical-type`, code: level.type }] },
        ...(parent ? { partOf: parent.reference } : {}),
      }
    );
    parent = handle;
  }
  return parent?.reference;
}

/** PV1 → Encounter. */
export function buildEncounter(pv1, evn, patientRef, ctx, b, { key = "encounter", trigger = "" } = {}) {
  const g = c(ctx);
  const classCode = g(pv1.f(2), 1).toUpperCase();
  const cls = ENCOUNTER_CLASS[classCode];
  if (!cls) {
    b.warn(`PV1-2 patient class '${classCode || "(empty)"}' does not map to a FHIR Encounter.class, which is required 1..1 in R4. Encounter emitted with class=unknown — reject the message instead if your store enforces conformance.`);
  }
  const visitIdentifier = toIdentifier(pv1.f(19), ctx, b.warn);
  const admit = toFhirDate(g(pv1.f(44), 1)) ?? (evn ? toFhirDate(g(evn.f(6), 1)) : undefined);
  const discharge = toFhirDate(g(pv1.f(45), 1));
  const participants = [
    ...reps(pv1.f(7), ctx.repSep).map((r) => ({ code: "ATND", xcn: r })),
    ...reps(pv1.f(8), ctx.repSep).map((r) => ({ code: "REF", xcn: r })),
    ...reps(pv1.f(9), ctx.repSep).map((r) => ({ code: "CON", xcn: r })),
    ...reps(pv1.f(17), ctx.repSep).map((r) => ({ code: "ADM", xcn: r })),
  ]
    .map(({ code, xcn }) => {
      const ref = practitionerRef(xcn, ctx, b);
      return ref ? { type: [{ coding: [{ system: `${TERM}/v3-ParticipationType`, code }] }], individual: ref } : undefined;
    })
    .filter(Boolean);

  const location = [];
  const current = locationRef(pv1.f(3), ctx, b, "current");
  const prior = locationRef(pv1.f(6), ctx, b, "prior");
  if (prior) location.push({ location: prior, status: "completed" });
  if (current) location.push({ location: current, status: discharge ? "completed" : "active" });

  const priorityCode = g(pv1.f(4), 1).toUpperCase();
  const serviceType = toCodeableConcept(pv1.f(10), ctx, b.warn);
  const disposition = g(pv1.f(36), 1);

  const status =
    discharge ? "finished"
    : /A05|A14/.test(trigger) ? "planned"
    : /A11|A38/.test(trigger) ? "cancelled"
    : "in-progress";

  const resource = {
    ...(visitIdentifier ? { identifier: [visitIdentifier] } : {}),
    status,
    class: cls
      ? { system: `${TERM}/v3-ActCode`, code: cls }
      : { system: `${TERM}/v3-NullFlavor`, code: "UNK", display: "unknown" },
    ...(serviceType ? { serviceType } : {}),
    ...(priorityCode && ENCOUNTER_PRIORITY[priorityCode]
      ? { priority: { coding: [{ system: `${TERM}/v3-ActPriority`, code: ENCOUNTER_PRIORITY[priorityCode] }] } }
      : {}),
    subject: patientRef,
    ...(participants.length ? { participant: participants } : {}),
    ...(admit || discharge
      ? { period: { ...(admit ? { start: admit } : {}), ...(discharge ? { end: discharge } : {}) } }
      : {}),
    ...(location.length ? { location } : {}),
    ...(disposition
      ? { hospitalization: { dischargeDisposition: { coding: [{ code: disposition }], text: disposition } } }
      : {}),
  };
  if (disposition) b.warn(`PV1-36 discharge disposition '${disposition}' is from user-defined table 0112, which has no HL7 Terminology (THO) code system; emitted without a system. Give it your local system URI.`);
  if (!visitIdentifier) b.warn("PV1-19 (visit number) is empty, so the Encounter cannot be conditionally matched; it is created new on every conversion.");
  if (zonelessTime(admit) || zonelessTime(discharge)) {
    b.warn("An Encounter timestamp has a time but no timezone offset. The receiver will apply its own locale, shifting admissions across midnight at some sites.");
  }
  return b.put(key, "Encounter", resource, conditional("Encounter", visitIdentifier));
}

/** AL1 → AllergyIntolerance. */
export function buildAllergy(al1, patientRef, ctx, b, n) {
  const g = c(ctx);
  const code = toCodeableConcept(al1.f(3), ctx, b.warn);
  if (!code) return;
  const CATEGORY = { DA: "medication", MA: "medication", MC: "medication", FA: "food", EA: "environment", AA: "biologic", LA: "environment", PA: "environment" };
  const SEVERITY = { SV: "severe", MO: "moderate", MI: "mild" };
  const category = CATEGORY[g(al1.f(2), 1).toUpperCase()];
  const severity = SEVERITY[g(al1.f(4), 1).toUpperCase()];
  const manifestation = reps(al1.f(5), ctx.repSep).map((r) => toCodeableConcept(r, ctx, b.warn)).filter(Boolean);
  const recorded = toFhirDate(g(al1.f(6), 1));
  b.put(`allergy:${n}`, "AllergyIntolerance", {
    clinicalStatus: { coding: [{ system: `${TERM}/allergyintolerance-clinical`, code: "active" }] },
    ...(category ? { category: [category] } : {}),
    code,
    patient: patientRef,
    ...(recorded ? { recordedDate: recorded } : {}),
    ...(manifestation.length || severity
      ? { reaction: [{ ...(manifestation.length ? { manifestation } : { manifestation: [{ text: "unspecified" }] }), ...(severity ? { severity } : {}) }] }
      : {}),
  });
  b.note("AllergyIntolerance resources from AL1 are a full snapshot of the list. Reconcile against stored allergies — anything absent here should be deactivated, not left active.");
}

/** DG1 → Condition, plus the Encounter.diagnosis back-reference. */
export function buildCondition(dg1, patientRef, encounter, ctx, b, n) {
  const g = c(ctx);
  const code = toCodeableConcept(dg1.f(3), ctx, b.warn);
  if (!code) return;
  const onset = toFhirDate(g(dg1.f(5), 1));
  const asserter = reps(dg1.f(16), ctx.repSep).map((r) => practitionerRef(r, ctx, b)).filter(Boolean)[0];
  const handle = b.put(`condition:${n}`, "Condition", {
    clinicalStatus: { coding: [{ system: `${TERM}/condition-clinical`, code: "active" }] },
    category: [{ coding: [{ system: `${TERM}/condition-category`, code: "encounter-diagnosis" }] }],
    code,
    subject: patientRef,
    ...(encounter ? { encounter: encounter.reference } : {}),
    ...(onset ? { onsetDateTime: onset } : {}),
    ...(asserter ? { asserter } : {}),
  });
  if (encounter) {
    const USE = { A: "AD", W: "DD", F: "DD" };
    const useCode = USE[g(dg1.f(6), 1).toUpperCase()];
    const rank = Number(g(dg1.f(15), 1));
    encounter.resource.diagnosis = encounter.resource.diagnosis ?? [];
    encounter.resource.diagnosis.push({
      condition: handle.reference,
      ...(useCode ? { use: { coding: [{ system: `${TERM}/diagnosis-role`, code: useCode }] } } : {}),
      ...(Number.isFinite(rank) && rank > 0 ? { rank } : {}),
    });
  }
}

/** NK1 → Patient.contact on the already-built Patient. */
export function buildContact(nk1, patient, ctx, b) {
  const g = c(ctx);
  const name = toHumanName(reps(nk1.f(2), ctx.repSep)[0] ?? "", ctx);
  const relationship = toCodeableConcept(nk1.f(3), ctx, b.warn);
  const telecom = reps(nk1.f(5), ctx.repSep).map((r) => toContactPoint(r, ctx, "home")).filter(Boolean);
  const address = toAddress(reps(nk1.f(4), ctx.repSep)[0] ?? "", ctx);
  if (!name && !telecom.length) return;
  patient.resource.contact = patient.resource.contact ?? [];
  patient.resource.contact.push({
    ...(relationship ? { relationship: [relationship] } : {}),
    ...(name ? { name } : {}),
    ...(telecom.length ? { telecom } : {}),
    ...(address ? { address } : {}),
  });
}

/** SPM → Specimen. */
export function buildSpecimen(spm, patientRef, ctx, b, n) {
  const g = c(ctx);
  // SPM-2 is EIP: placer and filler assigned identifiers, each an EI in subcomponents.
  const { placer: spmPlacer, filler: spmFiller } = toIdentifiersEIP(spm.f(2), ctx, b.warn);
  const identifier = spmFiller ?? spmPlacer;
  const type = toCodeableConcept(spm.f(4), ctx, b.warn);
  const collected = toFhirDate(g(spm.f(17), 1));
  const received = toFhirDate(g(spm.f(18), 1));
  const site = toCodeableConcept(spm.f(8), ctx, b.warn);
  const role = g(spm.f(11), 1).toUpperCase();
  if (role && role !== "P") {
    b.warn(`SPM-11 specimen role is '${role}' (not a patient specimen). Quality-control and blind specimens do not belong on a patient chart — this Specimen was still emitted, but should probably be dropped.`);
  }
  return b.put(`specimen:${n}`, "Specimen", {
    ...(identifier ? { identifier: [identifier] } : {}),
    ...(type ? { type } : {}),
    subject: patientRef,
    ...(received ? { receivedTime: received } : {}),
    ...(collected || site
      ? { collection: { ...(collected ? { collectedDateTime: collected } : {}), ...(site ? { bodySite: site } : {}) } }
      : {}),
  }, conditional("Specimen", identifier));
}

/** OBX-5 → the right Observation.value[x], chosen by OBX-2. */
export function observationValue(valueType, raw, units, ctx, b, location) {
  const g = c(ctx);
  const type = (valueType || "").toUpperCase();
  const unitCc = toCodeableConcept(units, ctx, () => {});
  const unitCode = unitCc?.coding?.[0]?.code;
  const unitSystem = unitCc?.coding?.[0]?.system;
  const quantity = (value) => ({
    valueQuantity: {
      value,
      ...(unitCode ? { unit: unitCc.coding[0].display || unitCode } : {}),
      ...(unitSystem ? { system: unitSystem } : {}),
      ...(unitCode ? { code: unitCode } : {}),
    },
  });

  switch (type) {
    case "NM": {
      const n = Number(unesc(raw, ctx));
      if (!Number.isFinite(n)) {
        b.warn(`${location}: OBX-2 is NM but OBX-5 '${raw}' is not numeric; emitted as valueString so the result is not lost.`);
        return { valueString: unesc(raw, ctx) };
      }
      return quantity(n);
    }
    case "SN": {
      const [cmp, n1, sep, n2] = [1, 2, 3, 4].map((i) => g(raw, i));
      const a = Number(n1);
      const bNum = Number(n2);
      if (sep === "-" && Number.isFinite(a) && Number.isFinite(bNum)) {
        return { valueRange: { low: { value: a, ...(unitCode ? { unit: unitCode } : {}) }, high: { value: bNum, ...(unitCode ? { unit: unitCode } : {}) } } };
      }
      if ((sep === ":" || sep === "/") && Number.isFinite(a) && Number.isFinite(bNum)) {
        return { valueRatio: { numerator: { value: a }, denominator: { value: bNum } } };
      }
      if (!Number.isFinite(a)) return { valueString: unesc(raw, ctx) };
      const q = quantity(a);
      if (cmp && cmp !== "=") q.valueQuantity.comparator = cmp;
      return q;
    }
    case "CE":
    case "CWE":
    case "IS":
    case "ID": {
      const cc = toCodeableConcept(raw, ctx, b.warn);
      return cc ? { valueCodeableConcept: cc } : undefined;
    }
    case "DT":
    case "TS":
    case "DTM": {
      const d = toFhirDate(g(raw, 1));
      return d ? { valueDateTime: d } : { valueString: unesc(raw, ctx) };
    }
    case "TM":
      return { valueTime: unesc(raw, ctx) };
    case "ED":
    case "RP":
      b.warn(`${location}: OBX-2 is ${type} (encapsulated data / reference pointer). Its content belongs in DiagnosticReport.presentedForm or an ImagingStudy, not Observation.value — the raw value was kept as valueString for review.`);
      return { valueString: unesc(raw, ctx) };
    default:
      return { valueString: unesc(raw, ctx) };
  }
}

/**
 * LOINC codes that trigger the FHIR R4 vital-signs profiles (observation-vitalsigns
 * and its children). An Observation with one of these codes must carry
 * category=vital-signs or it fails validation.
 */
export const VITAL_SIGN_LOINCS = new Set([
  "85353-1", "9279-1", "8867-4", "2708-6", "59408-5", "8310-5", "8302-2", "9843-4", "29463-7", "39156-5", "85354-9", "8480-6", "8462-4",
]);
const isVitalSign = (cc) => Boolean(cc?.coding?.some((cd) => cd.system === "http://loinc.org" && VITAL_SIGN_LOINCS.has(cd.code)));

/** A group of OBX rows (already merged if they were a repeating narrative) → Observation. */
export function buildObservation(obx, patientRef, encounter, ctx, b, key, { fallbackEffective, category, mergedText } = {}) {
  const g = c(ctx);
  const code = toCodeableConcept(obx.f(3), ctx, b.warn);
  const statusCode = g(obx.f(11), 1).toUpperCase();
  const status = OBS_STATUS[statusCode];
  if (!status) {
    b.warn(`${key}: OBX-11 '${statusCode || "(empty)"}' is not in HL7 table 0085. Observation.status is required 1..1 — emitted as 'unknown'.`);
  }
  const categories = [category, isVitalSign(code) ? "vital-signs" : undefined].filter(Boolean);
  const effective = toFhirDate(g(obx.f(14), 1)) ?? fallbackEffective;
  const issued = toFhirDate(g(obx.f(19), 1));
  const interpretation = reps(obx.f(8), ctx.repSep)
    .map((flag) => ({ coding: [{ system: `${TERM}/v3-ObservationInterpretation`, code: unesc(flag.trim(), ctx) }] }));
  const range = unesc(obx.f(7), ctx).trim();
  const rangeMatch = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/.exec(range);
  const method = toCodeableConcept(obx.f(17), ctx, () => {});
  const performer = [
    ...reps(obx.f(16), ctx.repSep).map((r) => practitionerRef(r, ctx, b)),
  ].filter(Boolean);

  if (isVitalSign(code) && !effective) {
    b.warn(`${key}: OBX-3 is a vital-sign LOINC but OBX-14 (observation date/time) is empty. The R4 vital-signs profile requires effective[x]; supply OBX-14.`);
  }
  const value =
    mergedText !== undefined
      ? { valueString: mergedText }
      : observationValue(g(obx.f(2), 1), obx.f(5), obx.f(6), ctx, b, key);

  return b.put(key, "Observation", {
    status: status ?? "unknown",
    ...(categories.length ? { category: categories.map((code) => ({ coding: [{ system: `${TERM}/observation-category`, code }] })) } : {}),
    ...(code ? { code } : { code: { text: "unspecified" } }),
    subject: patientRef,
    ...(encounter ? { encounter: encounter.reference } : {}),
    ...(effective ? { effectiveDateTime: effective } : {}),
    ...(issued ? { issued } : {}),
    ...(performer.length ? { performer } : {}),
    ...(value ?? {}),
    ...(interpretation.length ? { interpretation } : {}),
    ...(method ? { method } : {}),
    ...(range
      ? {
          referenceRange: [
            rangeMatch
              ? { low: { value: Number(rangeMatch[1]) }, high: { value: Number(rangeMatch[2]) }, text: range }
              : { text: range },
          ],
        }
      : {}),
  });
}

/** ORC + OBR → ServiceRequest. */
export function buildServiceRequest(orc, obr, patientRef, encounter, ctx, b, key, notes) {
  const g = c(ctx);
  const placer = toIdentifierEI(orc?.f(2) || obr?.f(2) || "", ctx, b.warn);
  const filler = toIdentifierEI(orc?.f(3) || obr?.f(3) || "", ctx, b.warn);
  const identifiers = [];
  if (placer) identifiers.push({ ...placer, type: { coding: [{ system: `${TERM}/v2-0203`, code: "PLAC" }] } });
  if (filler) identifiers.push({ ...filler, type: { coding: [{ system: `${TERM}/v2-0203`, code: "FILL" }] } });
  if (!identifiers.length) b.warn("Neither ORC-2 nor ORC-3 carried an order number. The ServiceRequest cannot be matched by the ORU that reports on it.");

  const control = g(orc?.f(1) ?? "", 1).toUpperCase();
  const statusCode = g(orc?.f(5) ?? "", 1).toUpperCase();
  let status = ORDER_STATUS[statusCode];
  if (!status) {
    const fromControl = CONCEPT_MAPS["0119"].map.find((m) => m.code === control);
    status = fromControl && fromControl.fhir.startsWith("active") ? "active"
      : fromControl && !fromControl.fhir.startsWith("(") ? fromControl.fhir.split(" ")[0]
      : "unknown";
    if (statusCode) b.warn(`ORC-5 '${statusCode}' is not in HL7 table 0038; status derived from ORC-1 '${control}' instead.`);
    else b.note(`ORC-5 was empty, so ServiceRequest.status was derived from the ORC-1 order control '${control}'. ORC-1 is a verb, not a state — confirm the sender's convention.`);
  }

  const code = toCodeableConcept(obr?.f(4) ?? "", ctx, b.warn);
  const procedure = toCodeableConcept(obr?.f(44) ?? "", ctx, () => {});
  if (code && procedure?.coding?.length) code.coding = [...(code.coding ?? []), ...procedure.coding];

  const requester = reps(orc?.f(12) ?? "", ctx.repSep).map((r) => practitionerRef(r, ctx, b)).filter(Boolean)[0]
    ?? reps(obr?.f(16) ?? "", ctx.repSep).map((r) => practitionerRef(r, ctx, b)).filter(Boolean)[0]
    ?? reps(orc?.f(10) ?? "", ctx.repSep).map((r) => practitionerRef(r, ctx, b)).filter(Boolean)[0];

  const timing = orc?.f(7) || obr?.f(27) || "";
  const priorityCode = g(timing, 6).toUpperCase();
  const PRIORITY = { S: "stat", A: "asap", R: "routine", P: "routine", C: "routine", T: "asap" };
  const occurrence = toFhirDate(g(obr?.f(6) ?? "", 1)) ?? toFhirDate(g(timing, 4));

  const reason = [toCodeableConcept(obr?.f(31) ?? "", ctx, () => {}), toCodeableConcept(obr?.f(13) ?? "", ctx, () => {})].filter(Boolean);

  return b.put(key, "ServiceRequest", {
    ...(identifiers.length ? { identifier: identifiers } : {}),
    status,
    intent: "order",
    ...(priorityCode && PRIORITY[priorityCode] ? { priority: PRIORITY[priorityCode] } : {}),
    ...(code ? { code } : {}),
    subject: patientRef,
    ...(encounter ? { encounter: encounter.reference } : {}),
    ...(occurrence ? { occurrenceDateTime: occurrence } : {}),
    ...(toFhirDate(g(orc?.f(9) ?? "", 1)) ? { authoredOn: toFhirDate(g(orc.f(9), 1)) } : {}),
    ...(requester ? { requester } : {}),
    ...(reason.length ? { reasonCode: reason } : {}),
    ...(notes?.length ? { note: [{ text: notes.join("\n") }] } : {}),
  }, conditional("ServiceRequest", placer && identifiers[0]));
}

/** OBR → DiagnosticReport (ORU only). */
export function buildReport(obr, patientRef, encounter, ctx, b, key, { results, specimen, conclusion }) {
  const g = c(ctx);
  const filler = toIdentifierEI(obr.f(3), ctx, b.warn);
  const placer = toIdentifierEI(obr.f(2), ctx, b.warn);
  const statusCode = g(obr.f(25), 1).toUpperCase();
  const status = REPORT_STATUS[statusCode];
  if (!status) b.warn(`OBR-25 '${statusCode || "(empty)"}' is not in HL7 table 0123. DiagnosticReport.status is required 1..1 — emitted as 'unknown'.`);
  if (statusCode === "C") {
    b.note("OBR-25 is C (correction). This bundle must UPDATE the existing DiagnosticReport matched on the filler order number — appending a second report leaves both visible to clinicians.");
  }
  const sectionCode = g(obr.f(24), 1).toUpperCase();
  const category = REPORT_CATEGORY[sectionCode];
  const code = toCodeableConcept(obr.f(4), ctx, b.warn);
  const effective = toFhirDate(g(obr.f(7), 1));
  const issued = toFhirDate(g(obr.f(22), 1));
  const interpreter = reps(obr.f(32), ctx.repSep)
    .map((r) => practitionerRef(rawComp(r, 1, ctx.subSep) ? r.split(ctx.subSep).join(ctx.compSep) : r, ctx, b))
    .filter(Boolean);

  const identifiers = [];
  if (filler) identifiers.push({ ...filler, type: { coding: [{ system: `${TERM}/v2-0203`, code: "FILL" }] } });

  return b.put(key, "DiagnosticReport", {
    ...(identifiers.length ? { identifier: identifiers } : {}),
    ...(placer ? { basedOn: [{ type: "ServiceRequest", identifier: { ...placer, type: { coding: [{ system: `${TERM}/v2-0203`, code: "PLAC" }] } } }] } : {}),
    status: status ?? "unknown",
    ...(sectionCode
      ? {
          category: [{
            coding: [
              { system: `${TERM}/v2-0074`, code: sectionCode },
              ...(category ? [{ system: `${TERM}/observation-category`, code: category }] : []),
            ],
          }],
        }
      : {}),
    ...(code ? { code } : { code: { text: "unspecified" } }),
    subject: patientRef,
    ...(encounter ? { encounter: encounter.reference } : {}),
    ...(effective ? { effectiveDateTime: effective } : {}),
    ...(issued ? { issued } : {}),
    ...(interpreter.length ? { resultsInterpreter: interpreter } : {}),
    ...(specimen?.length ? { specimen } : {}),
    ...(results.length ? { result: results } : {}),
    ...(conclusion ? { conclusion } : {}),
  }, conditional("DiagnosticReport", filler));
}
