/**
 * MDM (medical documents) → DocumentReference, following the HL7 v2-to-FHIR IG
 * message map MDM_T02 and the TXA/OBX[DocumentReference] segment maps, read
 * against the v2.5.1 field definitions.
 */
import { TERM } from "../maps.js";
import { c, rawComp, reps, unesc, toFhirDate, zonelessTime, first, all, MessageError } from "./util.js";
import { toIdentifierEI } from "./datatypes.js";
import { conditional } from "./bundle.js";
import { buildPatient, buildEncounter, buildServiceRequest, practitionerRef } from "./segments.js";
import { orderGroups } from "./orders.js";
import { igLookup } from "./igmaps.js";
import { checkCode } from "hl7v2-core";

const DAR = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const ALT = "http://hl7.org/fhir/StructureDefinition/alternate-codes";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** Triggers whose message carries document content (structure MDM_T02). */
export const MDM_CONTENT_TRIGGERS = ["T02", "T04", "T06", "T08", "T10"];
/** relatesTo from the trigger's definition: T06 addendum, T10 replacement (both name TXA-13). */
const RELATES = { T06: "appends", T10: "replaces" };

/** OBX rows → DocumentReference.content, as in the IG OBX[DocumentReference] map. */
function contentFrom(obxRows, ctx, b) {
  const g = c(ctx);
  const content = [];
  const textLines = { TX: [], FT: [] };
  for (const obx of obxRows) {
    const type = g(obx.f(2), 1).toUpperCase();
    const values = reps(obx.f(5), ctx.repSep);
    if (type === "TX" || type === "ST") textLines.TX.push(...values.map((v) => unesc(v, ctx)));
    else if (type === "FT") textLines.FT.push(...values);
    else if (type === "ED") {
      for (const v of values) {
        const subtype = g(v, 3);
        const encoding = g(v, 4).toUpperCase();
        const data = rawComp(v, 5, ctx.compSep);
        const attachment = {};
        if (subtype) {
          attachment.contentType = subtype;
          if (!subtype.includes("/")) b.warn(`OBX-5 ED.3 '${subtype}' is not a MIME type; it was copied into Attachment.contentType as the IG specifies. Map it to a MIME type before posting.`);
        } else if (g(v, 2)) {
          attachment.extension = [{ url: ALT, valueCodeableConcept: { coding: [{ system: `${TERM}/v2-0191`, code: g(v, 2) }] } }];
        }
        if (encoding === "BASE64") attachment.data = data.replace(/\s+/g, "");
        else if (encoding === "A") attachment.data = b64(unesc(data, ctx));
        else if (encoding === "HEX") attachment.data = Buffer.from(data.replace(/\s+/g, ""), "hex").toString("base64");
        else b.warn(`OBX-5 ED.4 encoding '${encoding || "(empty)"}' is not A, Hex or Base64 (table 0299); the ED data was not converted.`);
        if (attachment.data || attachment.contentType) content.push({ attachment });
      }
    } else if (type === "RP") {
      for (const v of values) {
        const url = unesc(rawComp(v, 1, ctx.compSep), ctx);
        if (!url) continue;
        const t = g(v, 3);
        const st = g(v, 4);
        content.push({ attachment: { url, ...(t ? { contentType: st ? `${t}/${st}` : t } : {}) } });
      }
    } else if (type) {
      b.warn(`OBX-2 '${type}' in an MDM has no DocumentReference.content mapping in the IG (only ED, FT, RP and TX); the OBX was not converted.`);
    }
  }
  // FT keeps its formatting escapes, as the IG says (contentType text/hl7v2, one line per repetition).
  if (textLines.FT.length) content.push({ attachment: { contentType: "text/hl7v2", data: b64(textLines.FT.join("\n")) } });
  // TX/ST are unescaped plain text. The IG writes application/text, which is not a registered MIME type; text/plain is used instead.
  if (textLines.TX.length) {
    content.push({ attachment: { contentType: "text/plain; charset=utf-8", data: b64(textLines.TX.join("\n")) } });
    b.note("TX document text was emitted with contentType text/plain (the IG says application/text, which is not a registered MIME type).");
  }
  return content;
}

export function convertMDM(segs, ctx, b, trigger) {
  const g = c(ctx);
  const pid = first(segs, "PID");
  if (!pid) throw new MessageError("MDM message has no PID segment; the document has no subject.");
  const txa = first(segs, "TXA");
  if (!txa) throw new MessageError("MDM message has no TXA segment; there is no document to convert.");
  const { handle: patient } = buildPatient(pid, first(segs, "PD1"), ctx, b);
  const pv1 = first(segs, "PV1");
  const encounter = pv1 ? buildEncounter(pv1, first(segs, "EVN"), patient.reference, ctx, b, { trigger }) : null;
  if (!pv1) b.warn("MDM normally carries a required PV1. None was found, so DocumentReference.context.encounter is empty.");

  // COMMON_ORDER groups (ORC/OBR before the TXA) → ServiceRequest, linked from context.related.
  const txaAt = segs.indexOf(txa);
  const groups = orderGroups(segs.slice(0, txaAt), ["ORC", "OBR"]);
  const related = groups.map((grp, i) => buildServiceRequest(grp.orc, grp.obr, patient.reference, encounter, ctx, b, `servicerequest:${i + 1}`, []).reference);

  // Identifiers: TXA-12 unique document number → masterIdentifier; TXA-16 file name → identifier.
  const master = toIdentifierEI(txa.f(12), ctx, b.warn);
  if (!master) b.warn("TXA-12 (unique document number) is empty; it is required in v2.5.1 and is the key later T04–T11 messages use. The DocumentReference cannot be matched.");
  const fileName = unesc(g(txa.f(16), 1), ctx);

  // Status: TXA-19 availability (table 0273), as in the IG.
  const avail = g(txa.f(19), 1).toUpperCase();
  let statusProps;
  if (avail === "AV") statusProps = { status: "current" };
  else if (["CA", "OB", "UN"].includes(avail)) {
    statusProps = { _status: { extension: [{ url: ALT, valueCodeableConcept: { coding: [{ system: `${TERM}/v2-0273`, code: avail }] } }] } };
    b.note(`TXA-19 '${avail}' has no DocumentReference.status equivalent; as in the IG it is carried in an alternate-codes extension on status.`);
  } else {
    statusProps = { _status: { extension: [{ url: DAR, valueCode: "unknown" }] } };
    b.warn(`TXA-19 (availability) is '${avail || "(empty)"}', not one of AV/CA/OB/UN. DocumentReference.status is required; emitted as data-absent-reason=unknown.`);
  }

  // TXA-17 completion status (0271): the IG has no ConceptMap to docStatus, so it is reported, not mapped.
  const completion = g(txa.f(17), 1).toUpperCase();
  if (completion) {
    const st = checkCode("0271", completion);
    b.note(`TXA-17 completion status '${completion}'${st?.entry ? ` (${st.entry.display})` : ""} was not mapped: the HL7 v2-to-FHIR IG publishes no ConceptMap from table 0271 to DocumentReference.docStatus.`);
  } else b.warn("TXA-17 (document completion status) is empty; it is required in v2.5.1.");

  // Type: TXA-2 (IS, user-defined table 0270).
  const typeCode = g(txa.f(2), 1);
  let type;
  if (typeCode) {
    const st = checkCode("0270", typeCode);
    type = st?.status === "valid"
      ? { coding: [{ system: `${TERM}/v2-0270`, code: st.entry.code, display: st.entry.display }] }
      : { coding: [{ code: typeCode }], text: typeCode };
    if (st?.status !== "valid") b.warn(`TXA-2 '${typeCode}' is not a suggested value of user-defined table 0270; emitted without a code system. Give it your local system URI.`);
  } else b.warn("TXA-2 (document type) is empty; it is required in v2.5.1.");

  // Confidentiality: TXA-18 via the IG DocumentConfidentialityStatus ConceptMap.
  const conf = g(txa.f(18), 1);
  const confHit = igLookup("0272")(conf);
  const securityLabel = confHit?.target ? [{ coding: [{ system: confHit.targetSystem, code: confHit.target }] }] : [];
  if (conf && !confHit?.target) b.warn(`TXA-18 '${conf}' has no mapping in the IG ConceptMap for table 0272; securityLabel omitted.`);

  // Date: TXA-6 origination date/time when it includes a time with an offset (date is an instant).
  const origination = toFhirDate(g(txa.f(6), 1));
  const date = origination && origination.includes("T") && !zonelessTime(origination) ? origination : undefined;
  if (origination && !date) b.warn("TXA-6 (origination date/time) has no time or no timezone offset, so it cannot be DocumentReference.date (an instant). Omitted.");

  const author = reps(txa.f(9), ctx.repSep).map((r) => practitionerRef(r, ctx, b)).filter(Boolean);
  const authenticator = reps(txa.f(10), ctx.repSep).map((r) => practitionerRef(r, ctx, b)).find(Boolean);

  // relatesTo for addenda and replacements: TXA-13 parent document number.
  const parent = toIdentifierEI(txa.f(13), ctx, b.warn);
  const relatesTo = [];
  if (RELATES[trigger]) {
    if (parent) relatesTo.push({ code: RELATES[trigger], target: { type: "DocumentReference", identifier: parent } });
    else b.warn(`MDM^${trigger} is an ${trigger === "T06" ? "addendum" : "replacement"}, but TXA-13 (parent document number) is empty, so relatesTo could not be set.`);
  }
  if (trigger === "T08") b.note("MDM^T08 is an edit of the same document (same TXA-12); this bundle updates the DocumentReference matched on masterIdentifier.");
  if (trigger === "T11") b.note("MDM^T11 cancels the document; DocumentReference.status follows TXA-19 (normally CA).");

  // Content (only the MDM_T02-structure triggers carry OBX content).
  const obx = all(segs.slice(txaAt + 1), "OBX");
  const content = contentFrom(obx, ctx, b);
  if (!content.length) {
    if (MDM_CONTENT_TRIGGERS.includes(trigger)) b.warn(`MDM^${trigger} should carry the document in OBX, but no convertible content was found. DocumentReference.content is required 1..* in R4.`);
    else b.note(`MDM^${trigger} is a notification without content (structure MDM_T01). DocumentReference.content is required 1..* in R4, so this resource is not conformant until the content arrives.`);
  }
  const notes = all(segs.slice(txaAt + 1), "NTE").flatMap((n) => reps(n.f(3), ctx.repSep).map((r) => unesc(r, ctx))).filter(Boolean);

  const resource = {
    ...(master ? { masterIdentifier: master } : {}),
    ...(fileName ? { identifier: [{ value: fileName }] } : {}),
    ...statusProps,
    ...(type ? { type } : {}),
    subject: patient.reference,
    ...(date ? { date } : {}),
    ...(author.length ? { author } : {}),
    ...(authenticator ? { authenticator } : {}),
    ...(relatesTo.length ? { relatesTo } : {}),
    ...(notes.length ? { description: notes.join("\n") } : {}),
    ...(securityLabel.length ? { securityLabel } : {}),
    content,
    ...(encounter || related.length
      ? { context: { ...(encounter ? { encounter: [encounter.reference] } : {}), ...(related.length ? { related } : {}) } }
      : {}),
  };
  const doc = b.put("documentreference", "DocumentReference", resource, conditional("DocumentReference", master));
  return { patient, encounter, document: doc };
}
