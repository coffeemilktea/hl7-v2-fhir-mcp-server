/** Whole-message converters: HL7 v2.5.1 message → FHIR R4 transaction Bundle. */
import { CONCEPT_MAPS, FHIR_VERSION, MESSAGE_MAPS, TERM } from "../maps.js";
import { parse, c, reps, unesc, toFhirDate, zonelessTime, first, all, withDiagnostics, MessageError } from "./util.js";
import { toCodeableConcept, toIdentifier } from "./datatypes.js";
import { makeBundle, conditional } from "./bundle.js";
import { orderGroups, mergeNarrative, noteText, convertOrders } from "./orders.js";
import { convertSIU } from "./scheduling.js";
import { convertMDM } from "./documents.js";
import {
  REPORT_CATEGORY, buildPatient, buildContact, buildEncounter, buildAllergy, buildCondition,
  buildServiceRequest, buildObservation, buildSpecimen, buildReport, practitionerRef, locationRef,
} from "./segments.js";

// ─── Message converters ──────────────────────────────────────────────────────


/** ADT^A01/A04/A05/A08/A28/A31/A40 → transaction Bundle. */
function convertADT(segs, ctx, b, trigger) {
  const pid = first(segs, "PID");
  if (!pid) throw new Error("ADT message has no PID segment; there is nothing to convert.");
  const { handle: patient } = buildPatient(pid, first(segs, "PD1"), ctx, b);

  for (const nk1 of all(segs, "NK1")) buildContact(nk1, patient, ctx, b);

  if (trigger === "A40") {
    const mrg = first(segs, "MRG");
    if (!mrg) throw new Error("ADT^A40 has no MRG segment; the losing identifier is unknown, so the merge cannot be converted.");
    const priorIdentifier = toIdentifier(reps(mrg.f(1), ctx.repSep)[0] ?? "", ctx, b.warn);
    if (!priorIdentifier) throw new Error("MRG-1 carried no usable identifier.");
    const retired = b.put("patient-retired", "Patient", {
      identifier: [priorIdentifier],
      active: false,
      link: [{ other: patient.reference, type: "replaced-by" }],
    }, conditional("Patient", priorIdentifier));
    patient.resource.link = [{ other: retired.reference, type: "replaces" }];
    b.note("Merge direction: the PID identifier survives, the MRG-1 identifier is retired (active=false, link.type=replaced-by). Reversing this is silent and retires the wrong chart.");
    b.note("Resources still pointing at the retired Patient are not rewritten by this bundle. Re-point them, or make sure every reader follows Patient.link.");
    return { patient, encounter: null };
  }

  if (trigger === "A31" || trigger === "A28") {
    if (first(segs, "PV1")) {
      b.warn(`ADT^${trigger} is a person-level update, but the message carries a PV1. No Encounter was emitted — an ${trigger} has no visit context, and creating one here is the classic ${trigger} bug.`);
    }
    return { patient, encounter: null };
  }

  const pv1 = first(segs, "PV1");
  let encounter = null;
  if (pv1) encounter = buildEncounter(pv1, first(segs, "EVN"), patient.reference, ctx, b, { trigger });
  else b.warn(`ADT^${trigger} normally carries a required PV1. None was found, so no Encounter was emitted.`);

  all(segs, "AL1").forEach((al1, i) => buildAllergy(al1, patient.reference, ctx, b, i + 1));
  all(segs, "DG1").forEach((dg1, i) => buildCondition(dg1, patient.reference, encounter, ctx, b, i + 1));

  if (trigger === "A08") {
    b.note("An A08 is a full snapshot, not a patch: a field the sender cleared arrives empty, and this bundle will not clear it downstream. Decide explicitly which semantics your pipeline implements.");
  }
  return { patient, encounter };
}

/** ORU^R01 → transaction Bundle. */
function convertORU(segs, ctx, b) {
  const g = c(ctx);
  const pid = first(segs, "PID");
  if (!pid) throw new Error("ORU message has no PID segment; the result has no subject.");
  const { handle: patient } = buildPatient(pid, first(segs, "PD1"), ctx, b);
  const pv1 = first(segs, "PV1");
  const encounter = pv1 ? buildEncounter(pv1, first(segs, "EVN"), patient.reference, ctx, b) : null;

  const groups = orderGroups(segs, ["ORC", "OBR"]);
  if (!groups.length) throw new Error("ORU message has no OBR segment; there is no report to convert.");

  groups.forEach((group, i) => {
    const n = i + 1;
    if (!group.obr) {
      b.warn(`Order group ${n} has an ORC with no OBR; no DiagnosticReport could be built from it.`);
      return;
    }
    const fallbackEffective = toFhirDate(g(group.obr.f(7), 1));
    const sectionCode = g(group.obr.f(24), 1).toUpperCase();
    const category = REPORT_CATEGORY[sectionCode];

    const specimen = group.spm.map((spm, j) => buildSpecimen(spm, patient.reference, ctx, b, `${n}:${j + 1}`).reference);

    const merged = mergeNarrative(group.obx, ctx);
    const results = [];
    const narrativeChunks = [];
    merged.forEach((entry, j) => {
      const key = `observation:${n}:${j + 1}`;
      const obs = buildObservation(entry.obx, patient.reference, encounter, ctx, b, key, {
        fallbackEffective,
        category,
        mergedText: entry.narrative ? entry.lines.join("\n") : undefined,
      });
      if (specimen.length) obs.resource.specimen = specimen[0];
      const text = noteText(entry.notes, ctx);
      if (text) obs.resource.note = [{ text }];
      if (entry.narrative) narrativeChunks.push(entry.lines.join("\n"));
      results.push(obs.reference);
    });

    const orderNote = noteText(group.notes, ctx);
    const conclusion = [narrativeChunks.join("\n\n"), orderNote].filter(Boolean).join("\n\n") || undefined;

    const report = buildReport(group.obr, patient.reference, encounter, ctx, b, `report:${n}`, {
      results,
      specimen,
      conclusion,
    });

    for (const zds of group.zds) {
      const uid = g(zds.f(1), 1);
      if (!uid) continue;
      const study = b.put(`imagingstudy:${n}`, "ImagingStudy", {
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
        status: "available",
        subject: patient.reference,
        ...(encounter ? { encounter: encounter.reference } : {}),
      });
      report.resource.imagingStudy = [study.reference];
    }

    const narrativeRows = merged.filter((e) => e.narrative).reduce((sum, e) => sum + e.lines.length, 0);
    const narrativeObs = merged.filter((e) => e.narrative).length;
    if (narrativeRows > narrativeObs) {
      b.note(`Report ${n}: ${narrativeRows} repeating narrative OBX rows were joined into ${narrativeObs} Observation(s) in line order, and repeated in DiagnosticReport.conclusion. A radiology report is one document, not one Observation per line.`);
    }
    b.note("Observation.status (OBX-11) and DiagnosticReport.status (OBR-25) come from different fields and may legitimately differ. Neither was copied onto the other.");
  });
  return { patient, encounter };
}

/** Message types convert_message accepts. */
export const SUPPORTED_TYPES = ["ADT", "ORM", "OML", "OMI", "ORU", "SIU", "MDM"];

/**
 * Convert any supported message into a FHIR R4 transaction Bundle.
 * Throws MessageError (or Error) for a message that cannot be converted.
 */
export function convert(message, options = {}) {
  const [result, diagnostics] = withDiagnostics(() => convertParsed(parse(message), options));
  // Parse-level findings (ignored lines, invalid timestamps) go first: they explain gaps in the bundle.
  result.warnings = [...diagnostics, ...result.warnings.filter((w) => !diagnostics.includes(w))];
  return result;
}

function convertParsed({ ctx, segs }, options) {
  const msh = segs[0];
  const g = c(ctx);
  const type = g(msh.f(9), 1).toUpperCase();
  const trigger = g(msh.f(9), 2).toUpperCase();
  if (!type || !trigger) throw new MessageError(`MSH-9 (message type) must give the message code and trigger event, e.g. ADT^A01^ADT_A01; got '${unesc(msh.f(9), ctx) || "(empty)"}'.`);
  const controlId = g(msh.f(10), 1);
  const version = g(msh.f(12), 1);
  const timestamp = toFhirDate(g(msh.f(7), 1));

  const b = makeBundle(controlId || "no-control-id");
  if (!controlId) {
    b.warn("MSH-10 (message control ID) is empty. Bundle identifiers and the urn:uuid keys are then unstable, so the same message will not convert idempotently.");
  }
  if (!version) {
    b.warn("MSH-12 (version ID) is empty; it is required. The message was read as v2.5.1.");
  } else if (version !== "2.5.1") {
    b.warn(`MSH-12 declares version '${version}', not 2.5.1. It was read with the v2.5.1 field definitions; check the fields this server reads against that version before trusting the output.`);
  }
  const processing = g(msh.f(11), 1).toUpperCase();
  if (!processing) b.warn("MSH-11 (processing ID) is empty; it is required. Treat the bundle as non-production until the sender fills it in.");
  else if (processing !== "P") {
    b.warn(`MSH-11 processing ID is '${processing}' (${processing === "T" ? "training" : processing === "D" ? "debugging" : "not production"}). This bundle must not be posted to a production FHIR store.`);
  }
  if (!g(msh.f(7), 1)) b.warn("MSH-7 (date/time of message) is empty; it is required. Bundle.timestamp was omitted.");
  if (zonelessTime(timestamp)) {
    b.warn("MSH-7 has a time with no timezone offset, but Bundle.timestamp is an instant, which requires one. The offset was left off — supply the sender's zone before posting.");
  }

  let result;
  const messageType = `${type}^${trigger}`;
  if (type === "ACK") throw new MessageError("This is an acknowledgement (ACK); it carries no clinical content to convert.");
  if (type === "ADT") result = convertADT(segs, ctx, b, trigger);
  else if (type === "ORM" || type === "OML" || type === "OMI") result = convertOrders(segs, ctx, b, type);
  else if (type === "ORU") result = convertORU(segs, ctx, b);
  else if (type === "SIU") result = convertSIU(segs, ctx, b, trigger, options);
  else if (type === "MDM") result = convertMDM(segs, ctx, b, trigger);
  else throw new Error(`Message type '${messageType}' is out of scope. This server converts ${SUPPORTED_TYPES.join(", ")} messages.`);

  if (type === "ADT" && !MESSAGE_MAPS[messageType]) {
    b.warn(`ADT^${trigger} has no dedicated profile here; it was converted with the generic ADT rules (Patient + Encounter). Documented triggers: A01, A04, A08, A31, A40.`);
  }

  if (ctx.nulls.size || ctx.nullComponent) {
    const where = [...ctx.nulls].join(", ");
    b.note(`${where ? `${where} ${ctx.nulls.size === 1 ? "was" : "were"}` : "Some components were"} sent as the HL7 null "" (delete the stored value)${where && ctx.nullComponent ? ", as were some components" : ""}. The matching FHIR elements are absent: a PUT of the whole resource clears them, but a merge or PATCH pipeline must delete them explicitly.`);
  }

  const bundle = b.bundle(controlId,timestamp && timestamp.includes("T") && !zonelessTime(timestamp) ? timestamp : undefined);
  return {
    messageType,
    fhirVersion: FHIR_VERSION,
    bundle,
    warnings: b.warnings,
    notes: b.notes,
    resourceCounts: bundle.entry.reduce((acc, e) => {
      acc[e.resource.resourceType] = (acc[e.resource.resourceType] ?? 0) + 1;
      return acc;
    }, {}),
  };
}
