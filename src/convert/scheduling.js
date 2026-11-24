/**
 * SIU (scheduling) → Appointment, following the HL7 v2-to-FHIR IG message map
 * SIU_S12 and the SCH/AIS/AIG/AIL/AIP[Appointment] segment maps, read against
 * the v2.5.1 field definitions.
 */
import { TERM } from "../maps.js";
import { c, tsComp, reps, unesc, toFhirDate, zonelessTime, first, all, MessageError } from "./util.js";
import { toCodeableConcept, toIdentifierEI } from "./datatypes.js";
import { conditional } from "./bundle.js";
import { buildPatient, buildEncounter, practitionerRef, locationRef } from "./segments.js";
import { igLookup } from "./igmaps.js";
import { checkCode } from "hl7v2-core";

const DAR = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const unknownCode = () => ({ extension: [{ url: DAR, valueCode: "unknown" }] });

/** Status implied by the trigger when SCH-25 is empty (the trigger's own definition). */
const TRIGGER_STATUS = { S15: "cancelled", S26: "noshow" };

/** An instant needs a full time and an offset; return it or undefined. */
function asInstant(fhirDate) {
  return fhirDate && fhirDate.includes("T") && !zonelessTime(fhirDate) ? fhirDate : undefined;
}

/** participant.period from a resource segment's start date/time (a dateTime, so any precision is fine). */
function resourcePeriod(seg, startField, ctx, b, label) {
  const start = toFhirDate(c(ctx)(seg.f(startField), 1));
  if (zonelessTime(start)) b.warn(`${label}: start time has no timezone offset; the receiver will apply its own locale.`);
  return start ? { start } : undefined;
}

export const PARTICIPANT_STATUSES = ["accepted", "declined", "tentative", "needs-action"];

export function convertSIU(segs, ctx, b, trigger, { participantStatus } = {}) {
  const pstatus = () => (participantStatus ? { status: participantStatus } : { _status: unknownCode() });
  const g = c(ctx);
  const sch = first(segs, "SCH");
  if (!sch) throw new MessageError("SIU message has no SCH segment; there is no appointment to convert.");

  const pid = first(segs, "PID");
  let patient = null;
  let encounter = null;
  if (pid) {
    patient = buildPatient(pid, first(segs, "PD1"), ctx, b).handle;
    const pv1 = first(segs, "PV1");
    if (pv1) encounter = buildEncounter(pv1, null, patient.reference, ctx, b, { trigger });
  } else {
    b.warn("SIU message has no PID. Appointment.participant then has no patient; a patient-less appointment is legal in v2 (e.g. a blocked slot) but most FHIR stores expect one.");
  }

  // Identifiers: SCH-1 placer, SCH-2 filler.
  const identifier = [];
  const placer = toIdentifierEI(sch.f(1), ctx, b.warn);
  const filler = toIdentifierEI(sch.f(2), ctx, b.warn);
  if (placer) identifier.push({ ...placer, type: { coding: [{ system: `${TERM}/v2-0203`, code: "PLAC" }] } });
  if (filler) identifier.push({ ...filler, type: { coding: [{ system: `${TERM}/v2-0203`, code: "FILL" }] } });
  if (!identifier.length) b.warn("Neither SCH-1 nor SCH-2 carried an appointment ID. The Appointment cannot be matched by later S13–S26 updates.");

  // Status: SCH-25 through the IG FillerStatusCodes ConceptMap.
  const statusRaw = g(sch.f(25), 1);
  const statusMap = igLookup("0278");
  const hit = statusMap(statusRaw);
  let status;
  if (statusRaw) {
    const v251 = checkCode("0278", statusRaw);
    if (v251?.status !== "valid") {
      const exact = checkCode("0278", hit?.code ?? "");
      b.warn(
        `SCH-25 '${statusRaw}' is ${v251?.status === "unverified" ? "not confirmed as a v2.5.1 table 0278 value" : "not a v2.5.1 table 0278 value"}` +
          (hit && exact?.status === "valid" ? `; matched '${hit.code}' case-insensitively.` : ".")
      );
    }
    if (hit?.target) status = hit.target;
    else b.warn(`SCH-25 '${statusRaw}' has no Appointment.status in the HL7 v2-to-FHIR IG ConceptMap (FillerStatusCodes). Appointment.status is required; emitted as data-absent-reason=unknown.`);
  } else if (TRIGGER_STATUS[trigger]) {
    status = TRIGGER_STATUS[trigger];
    b.note(`SCH-25 was empty; Appointment.status '${status}' comes from the trigger event SIU^${trigger}.`);
  } else {
    b.warn("SCH-25 (filler status) is empty. Appointment.status is required in R4; emitted as data-absent-reason=unknown rather than guessed.");
  }

  // Codes: SCH-7 reason, SCH-8 appointment type (v2.5.1 CE).
  const reason = toCodeableConcept(sch.f(7), ctx, b.warn);
  const apptType = toCodeableConcept(sch.f(8), ctx, b.warn);

  // Timing: TQ1-7/8 (preferred in v2.5.1) else SCH-11 (TQ, retained for backward compatibility) components 4/5.
  const tq1 = first(segs, "TQ1");
  const sch11 = reps(sch.f(11), ctx.repSep)[0] ?? "";
  const tqStart = toFhirDate(g(tq1?.f(7) ?? "", 1)) ?? toFhirDate(tsComp(ctx)(sch11, 4));
  const tqEnd = toFhirDate(g(tq1?.f(8) ?? "", 1)) ?? toFhirDate(tsComp(ctx)(sch11, 5));
  const ais = all(segs, "AIS");
  const aisStart = ais.map((s) => toFhirDate(g(s.f(4), 1))).find(Boolean);
  const startRaw = tqStart ?? aisStart;
  const start = asInstant(startRaw);
  const end = asInstant(tqEnd);
  if (startRaw && !start) b.warn(`The appointment start '${startRaw}' has no timezone offset (or no time), so it cannot be Appointment.start (an instant). Omitted.`);

  // Duration: SCH-9 in the units of SCH-10, only when the units are minutes.
  const duration = Number(g(sch.f(9), 1));
  const units = g(sch.f(10), 1).toLowerCase();
  let minutesDuration;
  if (Number.isFinite(duration) && duration > 0) {
    if (["min", "minute", "minutes"].includes(units)) minutesDuration = duration;
    else b.warn(`SCH-9 duration ${duration} is in units '${g(sch.f(10), 1) || "(none)"}', not minutes; Appointment.minutesDuration omitted.`);
  }

  // Participants.
  const participant = [];
  if (patient) participant.push({ actor: patient.reference, ...pstatus() });
  for (const aip of all(segs, "AIP")) {
    const ref = reps(aip.f(3), ctx.repSep).map((r) => practitionerRef(r, ctx, b)).find(Boolean);
    if (!ref) continue;
    const role = toCodeableConcept(aip.f(4), ctx, b.warn);
    const period = resourcePeriod(aip, 6, ctx, b, "AIP-6");
    participant.push({ ...(role ? { type: [role] } : {}), actor: ref, ...pstatus(), ...(period ? { period } : {}) });
  }
  all(segs, "AIL").forEach((ail, i) => {
    const ref = locationRef(ail.f(3), ctx, b, `ail${i + 1}`);
    if (!ref) return;
    const period = resourcePeriod(ail, 6, ctx, b, "AIL-6");
    participant.push({ actor: ref, ...pstatus(), ...(period ? { period } : {}) });
  });
  for (const aig of all(segs, "AIG")) {
    const type = toCodeableConcept(aig.f(4), ctx, b.warn);
    const id = toCodeableConcept(aig.f(3), ctx, () => {});
    const period = resourcePeriod(aig, 8, ctx, b, "AIG-8");
    if (!type && !id) continue;
    participant.push({
      ...(type ? { type: [type] } : {}),
      ...(id ? { actor: { display: id.coding?.[0]?.display ?? id.coding?.[0]?.code ?? id.text } } : {}),
      ...pstatus(),
      ...(period ? { period } : {}),
    });
  }
  // SCH-12 placer contact, SCH-16 filler contact, SCH-20 entered by are people around the booking, not attendees.
  const contacts = [
    [12, "placer contact"],
    [16, "filler contact"],
  ];
  for (const [seq, label] of contacts) {
    const ref = reps(sch.f(seq), ctx.repSep).map((r) => practitionerRef(r, ctx, b)).find(Boolean);
    if (ref) b.note(`SCH-${seq} (${label}) became a Practitioner in the bundle but not an Appointment.participant: in v2.5.1 it is the person to contact about the booking, not an attendee.`);
  }
  if (participant.length && participantStatus) {
    b.note(`participant.status '${participantStatus}' was applied to every participant because the caller asked for it (participantStatus option); it does not come from the message.`);
  } else if (participant.length) {
    b.warn("Appointment.participant.status is required in R4 but v2.5.1 has no per-participant status in SIU except the resource segments' filler status, which uses table 0278 (appointment status). Each participant carries data-absent-reason=unknown instead of a guessed status, which the FHIR validator reports as an error; pass participantStatus to choose a value explicitly.");
  }
  if (!participant.length) b.warn("No participant could be built (no PID, AIP, AIL or AIG). Appointment.participant is required 1..* in R4.");

  // basedOn: SCH-26 placer order / SCH-27 filler order → ServiceRequest by identifier.
  const basedOn = [
    [26, "PLAC"],
    [27, "FILL"],
  ]
    .map(([seq, code]) => {
      const ident = toIdentifierEI(sch.f(seq), ctx, b.warn);
      return ident ? { type: "ServiceRequest", identifier: { ...ident, type: { coding: [{ system: `${TERM}/v2-0203`, code }] } } } : undefined;
    })
    .filter(Boolean);

  const serviceType = ais.map((s) => toCodeableConcept(s.f(3), ctx, b.warn)).filter(Boolean);
  const comment = all(segs, "NTE")
    .flatMap((n) => reps(n.f(3), ctx.repSep).map((r) => unesc(r, ctx)))
    .filter(Boolean)
    .join("\n");

  const resource = {
    ...(identifier.length ? { identifier } : {}),
    ...(status ? { status } : { _status: unknownCode() }),
    ...(serviceType.length ? { serviceType } : {}),
    ...(apptType ? { appointmentType: apptType } : {}),
    ...(reason ? { reasonCode: [reason] } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(minutesDuration ? { minutesDuration } : {}),
    ...(basedOn.length ? { basedOn } : {}),
    ...(comment ? { comment } : {}),
    participant,
  };
  const needsTimes = status && !["proposed", "cancelled", "waitlist"].includes(status);
  if (needsTimes && (!start || !end)) {
    b.warn(`Appointment status '${status}' requires both start and end (R4 invariant app-3), but ${!start ? "start" : "end"} could not be derived. Supply TQ1-7/TQ1-8 with timezone offsets.`);
  }
  if (encounter) b.note("The PV1 in this SIU produced an Encounter; it is the visit context, not a record that the appointment took place.");
  const appt = b.put("appointment", "Appointment", resource, conditional("Appointment", filler ?? placer));
  return { patient, encounter, appointment: appt };
}
