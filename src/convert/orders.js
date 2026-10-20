/**
 * Order messages → ServiceRequest-centred bundles:
 *   ORM^O01 (general order), OML^O21 (laboratory order), OMI^O23 (imaging order).
 */
import { TERM } from "../maps.js";
import { c, rawComp, reps, unesc, toFhirDate, first } from "./util.js";
import { toCodeableConcept, toIdentifierEI } from "./datatypes.js";
import { buildPatient, buildEncounter, buildObservation, buildSpecimen, buildServiceRequest, buildAllergy } from "./segments.js";
import { igLookup } from "./igmaps.js";

/** Split the order/result part of a message into ORC/OBR groups. */
export function orderGroups(segs, startNames) {
  const groups = [];
  let g = null;
  for (const s of segs) {
    if (startNames.includes(s.name) && (s.name === "ORC" || !g || g.obr || s.name === "OBR")) {
      if (s.name === "ORC") {
        g = { orc: s, obr: null, obx: [], notes: [], spm: [], zds: [], tq1: [], ipc: [] };
        groups.push(g);
        continue;
      }
      if (s.name === "OBR") {
        if (g && !g.obr) g.obr = s;
        else {
          g = { orc: null, obr: s, obx: [], notes: [], spm: [], zds: [], tq1: [], ipc: [] };
          groups.push(g);
        }
        continue;
      }
    }
    if (!g) continue;
    if (s.name === "OBX") g.obx.push({ obx: s, notes: [] });
    else if (s.name === "NTE") {
      if (g.obx.length) g.obx[g.obx.length - 1].notes.push(s);
      else g.notes.push(s);
    } else if (s.name === "SPM") g.spm.push(s);
    else if (s.name === "ZDS") g.zds.push(s);
    else if (s.name === "TQ1") g.tq1.push(s);
    else if (s.name === "IPC") g.ipc.push(s);
  }
  return groups;
}

/** Merge consecutive narrative (TX/FT) OBX rows that share a code into one. */
export function mergeNarrative(obxEntries, ctx) {
  const g = c(ctx);
  const out = [];
  for (const entry of obxEntries) {
    const type = g(entry.obx.f(2), 1).toUpperCase();
    const codeKey = `${g(entry.obx.f(3), 1)}|${g(entry.obx.f(4), 1)}`;
    const text = reps(entry.obx.f(5), ctx.repSep).map((r) => unesc(r, ctx)).join("\n") || unesc(entry.obx.f(5), ctx);
    const prev = out[out.length - 1];
    if ((type === "TX" || type === "FT") && prev && prev.narrative && prev.codeKey === codeKey) {
      prev.lines.push(text);
      prev.notes.push(...entry.notes);
      continue;
    }
    out.push({
      ...entry,
      codeKey,
      narrative: type === "TX" || type === "FT",
      lines: type === "TX" || type === "FT" ? [text] : null,
      notes: [...entry.notes],
    });
  }
  return out;
}

export const noteText = (ntes, ctx) =>
  ntes
    .flatMap((n) => reps(n.f(3), ctx.repSep).map((r) => unesc(r, ctx)))
    .filter((t) => t.length)
    .join("\n");

const DCM = "http://dicom.nema.org/resources/ontology/DCM";

/** TQ1 (v2.5.1's replacement for ORC-7/OBR-27 TQ) → priority and occurrence on the ServiceRequest. */
function applyTq1(tq1, request, ctx, b) {
  if (!tq1) return;
  const g = c(ctx);
  const r = request.resource;
  const prioRaw = g(tq1.f(9), 1);
  if (prioRaw) {
    const hit = igLookup("0485")(prioRaw);
    if (hit?.target) r.priority = hit.target;
    else b.note(`TQ1-9 priority '${prioRaw}' has no request-priority equivalent in the IG ConceptMap for table 0485; ServiceRequest.priority left ${r.priority ? `as '${r.priority}'` : "empty"}.`);
  }
  const start = toFhirDate(g(tq1.f(7), 1));
  const end = toFhirDate(g(tq1.f(8), 1));
  if ((start || end) && !r.occurrenceDateTime) {
    delete r.occurrenceDateTime;
    r.occurrencePeriod = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  }
  const text = unesc(g(tq1.f(11), 1), ctx);
  if (text) r.note = [...(r.note ?? []), { text }];
}

/** IPC (imaging procedure control, OMI) → ImagingStudy + accession identifier on the ServiceRequest. */
function applyIpc(ipcs, request, patient, encounter, ctx, b, n) {
  const g = c(ctx);
  ipcs.forEach((ipc, j) => {
    const accession = toIdentifierEI(ipc.f(1), ctx, b.warn);
    if (accession) {
      const ids = request.resource.identifier ?? (request.resource.identifier = []);
      if (!ids.some((i) => i.value === accession.value && i.type?.coding?.[0]?.code === "ACSN")) {
        ids.push({ ...accession, type: { coding: [{ system: `${TERM}/v2-0203`, code: "ACSN" }] } });
      }
    }
    const uid = g(ipc.f(3), 1);
    if (!uid) return;
    const modality = toCodeableConcept(ipc.f(5), ctx, () => {});
    const dcm = modality?.coding?.find((cd) => cd.system === DCM);
    if (modality && !dcm) b.note(`IPC-5 modality '${modality.coding?.[0]?.code ?? modality.text}' is not coded in DICOM (CE-3 'DCM'); ImagingStudy.modality left empty.`);
    b.put(`imagingstudy:${n}:${j + 1}`, "ImagingStudy", {
      identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
      status: "registered",
      ...(dcm ? { modality: [{ system: DCM, code: dcm.code, ...(dcm.display ? { display: dcm.display } : {}) }] } : {}),
      subject: patient.reference,
      ...(encounter ? { encounter: encounter.reference } : {}),
      basedOn: [request.reference],
    });
  });
  if (ipcs.length) {
    b.note("IPC-2 (requested procedure ID), IPC-4 (scheduled procedure step ID) and IPC-7/9 (station, AE title) have no FHIR R4 element and no IG mapping; they were not converted. IPC-1 became an ACSN identifier (FHIR identifier-type code) on the ServiceRequest, IPC-3 the ImagingStudy identifier.");
  }
}

/** ORM^O01, OML^O21 and OMI^O23 → transaction Bundle. */
export function convertOrders(segs, ctx, b, type) {
  const g = c(ctx);
  const pid = first(segs, "PID");
  if (!pid) throw new Error(`${type} message has no PID segment; the order has no subject.`);
  const { handle: patient } = buildPatient(pid, first(segs, "PD1"), ctx, b);
  const pv1 = first(segs, "PV1");
  const encounter = pv1 ? buildEncounter(pv1, first(segs, "EVN"), patient.reference, ctx, b) : null;
  if (type !== "ORM") {
    const firstOrder = segs.findIndex((s) => s.name === "ORC");
    segs
      .slice(0, firstOrder < 0 ? segs.length : firstOrder)
      .filter((s) => s.name === "AL1")
      .forEach((al1, i) => buildAllergy(al1, patient.reference, ctx, b, i + 1));
  }

  const groups = orderGroups(segs, ["ORC", "OBR"]);
  if (!groups.length) throw new Error(`${type} message has no ORC segment; there is no order to convert.`);

  groups.forEach((group, i) => {
    const n = i + 1;
    const notes = [noteText(group.notes, ctx)].filter(Boolean);
    const request = buildServiceRequest(group.orc, group.obr, patient.reference, encounter, ctx, b, `servicerequest:${n}`, notes);
    applyTq1(group.tq1[0], request, ctx, b);
    if (group.tq1.length > 1) b.note(`Order ${n} has ${group.tq1.length} TQ1 segments; only the first was used for priority and timing.`);

    for (const zds of group.zds) {
      const uid = g(zds.f(1), 1);
      if (!uid) continue;
      b.put(`imagingstudy:${n}`, "ImagingStudy", {
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
        status: "registered",
        subject: patient.reference,
        ...(encounter ? { encounter: encounter.reference } : {}),
        basedOn: [request.reference],
      });
    }
    applyIpc(group.ipc, request, patient, encounter, ctx, b, n);

    const specimens = group.spm.map((spm, j) => buildSpecimen(spm, patient.reference, ctx, b, `${n}:${j + 1}`).reference);
    if (specimens.length) request.resource.specimen = specimens;

    const supporting = [];
    mergeNarrative(group.obx, ctx).forEach((entry, j) => {
      const key = `observation:${n}:${j + 1}`;
      const obs = buildObservation(entry.obx, patient.reference, encounter, ctx, b, key, {
        category: "exam",
        mergedText: entry.narrative ? entry.lines.join("\n") : undefined,
      });
      const text = noteText(entry.notes, ctx);
      if (text) obs.resource.note = [{ text }];
      supporting.push(obs.reference);
    });
    if (supporting.length) {
      request.resource.supportingInfo = supporting;
      b.note("OBX rows inside an order are order-entry answers (weight, creatinine, LMP), not results. They are emitted with category=exam and linked from ServiceRequest.supportingInfo (as in the IG) — never category=laboratory, which would file them as results.");
    }
    if (!group.orc) b.warn(`Order ${n} has an OBR with no preceding ORC. Status and requester had to come from the OBR alone.`);
  });

  if (groups.length > 1) {
    b.note(`This ${type} carried ${groups.length} order groups, so the bundle holds ${groups.length} separate ServiceRequests — not one request with repeated codes.`);
  }
  return { patient, encounter };
}
