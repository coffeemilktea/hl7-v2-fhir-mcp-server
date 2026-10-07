#!/usr/bin/env node
/**
 * HL7 v2.5.1 → FHIR R4 Mapping MCP Server
 *
 * A companion to the HL7 v2.5.1 Reference server at
 * github.com/coffeemilktea/hl7-v2-mcp-server. Where that one answers "what does
 * this segment mean?", this one answers "what does it become in FHIR?" — for
 * the three message families that carry a radiology/lab order end to end:
 * ORM (orders), ADT (patient and visit state), ORU (results).
 *
 * Implements the Model Context Protocol over Streamable HTTP.
 * Run locally: node server.js
 * Then add to claude_desktop_config.json (see README.md).
 *
 * Requires Node.js 18+
 * Dependencies: npm install @modelcontextprotocol/sdk express zod cors
 */

import express from "express";
import cors from "cors";
import { randomUUID, createHash } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const FHIR_VERSION = "4.0.1";
const TERM = "http://terminology.hl7.org/CodeSystem";

// ─── HL7 v2 datatype → FHIR datatype ─────────────────────────────────────────

const DATATYPE_MAPS = {
  XPN: {
    fhir: "HumanName",
    notes: "XPN-7 (name type) drives HumanName.use. A repeating XPN becomes repeating HumanName; the L occurrence should sort first.",
    components: [
      { comp: 1, name: "Family Name", path: "HumanName.family", note: "FN.1 only; FN.2-5 (own/spouse surname parts) have no R4 equivalent." },
      { comp: 2, name: "Given Name", path: "HumanName.given[0]" },
      { comp: 3, name: "Second/Further Given Names", path: "HumanName.given[1]", note: "Split on space if several middle names are packed in." },
      { comp: 4, name: "Suffix", path: "HumanName.suffix" },
      { comp: 5, name: "Prefix", path: "HumanName.prefix" },
      { comp: 6, name: "Degree", path: "HumanName.suffix", note: "Appended after the XPN-4 suffix." },
      { comp: 7, name: "Name Type Code", path: "HumanName.use", note: "L→official, A→anonymous, D→usual, M→maiden, N→nickname, B→old, U→temp." },
      { comp: 8, name: "Name Representation Code", path: "HumanName.extension", note: "Ideographic/phonetic scripts need iso21090-EN-representation." },
      { comp: 10, name: "Name Validity Range", path: "HumanName.period", note: "Withdrawn in v2.5 but still sent by older interfaces." },
    ],
  },
  XAD: {
    fhir: "Address",
    notes: "XAD-7 (address type) drives Address.use; Address.type stays postal/physical/both by local convention.",
    components: [
      { comp: 1, name: "Street Address", path: "Address.line[0]", note: "SAD.1 street or mailing address; SAD.2/3 append as further line entries." },
      { comp: 2, name: "Other Designation", path: "Address.line[1]" },
      { comp: 3, name: "City", path: "Address.city" },
      { comp: 4, name: "State or Province", path: "Address.state" },
      { comp: 5, name: "Zip or Postal Code", path: "Address.postalCode" },
      { comp: 6, name: "Country", path: "Address.country" },
      { comp: 7, name: "Address Type", path: "Address.use", note: "H→home, B→work, M→home (mailing), C→temp, BDL→billing, BA→old." },
      { comp: 9, name: "County/Parish Code", path: "Address.district" },
      { comp: 12, name: "Address Validity Range", path: "Address.period" },
    ],
  },
  CX: {
    fhir: "Identifier",
    notes: "The single highest-value mapping in the whole set: every cross-system link — Patient, Encounter, ServiceRequest, Coverage — is a CX in v2 and an Identifier in FHIR.",
    components: [
      { comp: 1, name: "ID Number", path: "Identifier.value" },
      { comp: 4, name: "Assigning Authority", path: "Identifier.system", note: "HD. Map the namespace ID to a real URI through your master identifier table; never emit the bare namespace as a system." },
      { comp: 5, name: "Identifier Type Code", path: "Identifier.type.coding.code", note: `Table 0203, carried over verbatim with system ${TERM}/v2-0203.` },
      { comp: 6, name: "Assigning Facility", path: "Identifier.assigner", note: "Reference(Organization); usually resolved by identifier, not contained." },
      { comp: 7, name: "Effective Date", path: "Identifier.period.start" },
      { comp: 8, name: "Expiration Date", path: "Identifier.period.end" },
    ],
  },
  XTN: {
    fhir: "ContactPoint",
    notes: "XTN-4 populated means an email address: emit system=email and use XTN-4 as the value, ignoring the phone components.",
    components: [
      { comp: 1, name: "Telephone Number", path: "ContactPoint.value", note: "Deprecated in v2.5.1 but still the only populated component on many interfaces — fall back to it when XTN-12 is empty." },
      { comp: 2, name: "Telecommunication Use Code", path: "ContactPoint.use", note: "PRN→home, ORN→work, WPN→work, VHN→home, ASN→temp, EMR→temp, NET→(email), BPN→mobile." },
      { comp: 3, name: "Telecommunication Equipment Type", path: "ContactPoint.system", note: "PH→phone, FX→fax, CP→phone (use=mobile), Internet/X.400→email, BP→pager, MD→phone." },
      { comp: 4, name: "Email Address", path: "ContactPoint.value", note: "With system=email." },
      { comp: 12, name: "Unformatted Telephone Number", path: "ContactPoint.value", note: "Preferred over XTN-1 when present." },
    ],
  },
  CE: {
    fhir: "CodeableConcept",
    notes: "CE is the v2.5.1 coded type (CWE arrives in v2.7). Components 1-3 are the primary coding, 4-6 the alternate coding, and both belong in CodeableConcept.coding — the alternate is a second coding, never a second CodeableConcept.",
    components: [
      { comp: 1, name: "Identifier", path: "CodeableConcept.coding[0].code" },
      { comp: 2, name: "Text", path: "CodeableConcept.coding[0].display" },
      { comp: 3, name: "Name of Coding System", path: "CodeableConcept.coding[0].system", note: "Table 0396 abbreviation resolved to a URI: LN→http://loinc.org, SCT→http://snomed.info/sct, I9C/I10→ICD URIs, 99zzz→a local system URI you own." },
      { comp: 4, name: "Alternate Identifier", path: "CodeableConcept.coding[1].code" },
      { comp: 5, name: "Alternate Text", path: "CodeableConcept.coding[1].display" },
      { comp: 6, name: "Name of Alternate Coding System", path: "CodeableConcept.coding[1].system" },
      { comp: 9, name: "Original Text", path: "CodeableConcept.text", note: "Not present in v2.5.1 CE — when the source is uncoded free text, put it in CodeableConcept.text and emit no coding." },
    ],
  },
  TS: {
    fhir: "dateTime | instant | date",
    notes: "Precision is preserved, not padded: YYYY → date, YYYYMMDD → date, anything with a time → dateTime. FHIR requires a timezone offset once seconds are present, so a TS with time and no offset is the single most common source of silent cross-site shifts.",
    components: [
      { comp: 1, name: "Time", path: "(the value)", note: "YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]" },
      { comp: 2, name: "Degree of Precision", path: "(dropped)", note: "Deprecated in v2.5.1; precision is expressed by the length of component 1." },
    ],
  },
  XCN: {
    fhir: "Reference(Practitioner) + Practitioner",
    notes: "An XCN is two things at once: a link and a record. Emit a Practitioner keyed on XCN-1 within the assigning authority, and reference it from the field's own path.",
    components: [
      { comp: 1, name: "ID Number", path: "Practitioner.identifier.value" },
      { comp: 2, name: "Family Name", path: "Practitioner.name.family" },
      { comp: 3, name: "Given Name", path: "Practitioner.name.given[0]" },
      { comp: 4, name: "Second/Further Given Names", path: "Practitioner.name.given[1]" },
      { comp: 5, name: "Suffix", path: "Practitioner.name.suffix" },
      { comp: 6, name: "Prefix", path: "Practitioner.name.prefix" },
      { comp: 9, name: "Assigning Authority", path: "Practitioner.identifier.system" },
      { comp: 13, name: "Identifier Type Code", path: "Practitioner.identifier.type", note: "NPI here is what makes the Practitioner nationally resolvable — map to http://hl7.org/fhir/sid/us-npi." },
    ],
  },
  HD: {
    fhir: "Organization | uri | Identifier.system",
    notes: "Context decides. As an assigning authority an HD is a system URI; as a sending/receiving facility it is an Organization; as an application it is MessageHeader.source.",
    components: [
      { comp: 1, name: "Namespace ID", path: "Organization.name | (lookup key for a system URI)" },
      { comp: 2, name: "Universal ID", path: "Identifier.system", note: "With HD-3 = ISO, emit urn:oid:<value>; with UUID, urn:uuid:<value>. This is the only component that is safe to use as a system without a lookup table." },
      { comp: 3, name: "Universal ID Type", path: "(selects the URN form)", note: "ISO, UUID, DNS, URI, GUID, x400, x500." },
    ],
  },
  PL: {
    fhir: "Reference(Location) + Location",
    notes: "PL is a hierarchy in one field. Emit one Location per populated level and chain them with Location.partOf; the bed (or the most specific populated level) is what Encounter.location.location points at.",
    components: [
      { comp: 1, name: "Point of Care", path: "Location.name (physicalType=wa/ward)" },
      { comp: 2, name: "Room", path: "Location.name (physicalType=ro)" },
      { comp: 3, name: "Bed", path: "Location.name (physicalType=bd)" },
      { comp: 4, name: "Facility", path: "Location.managingOrganization | Location (physicalType=si)" },
      { comp: 5, name: "Location Status", path: "Location.status", note: "Site-defined; not a FHIR status value set." },
      { comp: 7, name: "Building", path: "Location (physicalType=bu)" },
      { comp: 8, name: "Floor", path: "Location (physicalType=lvl)" },
      { comp: 9, name: "Location Description", path: "Location.description" },
    ],
  },
  EI: {
    fhir: "Identifier",
    notes: "EI-1 is the value; EI-2/3/4 are the same namespace triple as HD and resolve to Identifier.system the same way.",
    components: [
      { comp: 1, name: "Entity Identifier", path: "Identifier.value" },
      { comp: 2, name: "Namespace ID", path: "(lookup key for Identifier.system)" },
      { comp: 3, name: "Universal ID", path: "Identifier.system", note: "urn:oid:<value> when EI-4 is ISO." },
      { comp: 4, name: "Universal ID Type", path: "(selects the URN form)" },
    ],
  },
  CQ: {
    fhir: "Quantity",
    notes: "CQ-2 is a CE holding the unit. Prefer the UCUM alternate coding when the primary is a local unit.",
    components: [
      { comp: 1, name: "Quantity", path: "Quantity.value" },
      { comp: 2, name: "Units", path: "Quantity.code + Quantity.system", note: "Emit system=http://unitsofmeasure.org only when the code really is UCUM." },
    ],
  },
  SN: {
    fhir: "Quantity | Range | Ratio",
    notes: "SN-1 (the comparator) selects the FHIR type: '>' or '<' → Quantity.comparator; '-' → Range; ':' or '/' → Ratio; empty → plain Quantity.",
    components: [
      { comp: 1, name: "Comparator", path: "Quantity.comparator", note: "One of > < >= <= = <>" },
      { comp: 2, name: "Num1", path: "Quantity.value | Range.low.value | Ratio.numerator" },
      { comp: 3, name: "Separator/Suffix", path: "(selects the FHIR type)" },
      { comp: 4, name: "Num2", path: "Range.high.value | Ratio.denominator" },
    ],
  },
  NM: { fhir: "decimal", notes: "Straight through. Keep it a JSON number, not a string, and do not re-format the precision — FHIR preserves significant digits as written.", components: [] },
  ST: { fhir: "string", notes: "Straight through, after unescaping the HL7 escape sequences (\\F\\ \\S\\ \\R\\ \\E\\ \\T\\ \\X..\\).", components: [] },
  ID: { fhir: "code", notes: "A value from an HL7-defined table. Almost always needs a ConceptMap — see lookup_concept_map.", components: [] },
  IS: { fhir: "code | CodeableConcept", notes: "A value from a user-defined table, so the codes are site-local. Emit CodeableConcept with your own system URI rather than pretending it is a FHIR code.", components: [] },
};

// ─── HL7 v2 table → FHIR value set ───────────────────────────────────────────

const CONCEPT_MAPS = {
  "0001": {
    name: "Administrative Sex → Patient.gender",
    target: "http://hl7.org/fhir/ValueSet/administrative-gender",
    map: [
      { code: "F", fhir: "female" },
      { code: "M", fhir: "male" },
      { code: "O", fhir: "other" },
      { code: "U", fhir: "unknown" },
      { code: "A", fhir: "other", note: "Ambiguous. R4 has no distinct code; keep the source value in an iso21090 extension if it matters clinically." },
      { code: "N", fhir: "unknown", note: "Not applicable. Consider a data-absent-reason of not-applicable instead of a gender at all." },
    ],
  },
  "0002": {
    name: "Marital Status → Patient.maritalStatus",
    target: `${TERM}/v3-MaritalStatus`,
    map: [
      { code: "A", fhir: "A", note: "Annulled" },
      { code: "D", fhir: "D", note: "Divorced" },
      { code: "M", fhir: "M", note: "Married" },
      { code: "S", fhir: "S", note: "Never Married" },
      { code: "W", fhir: "W", note: "Widowed" },
      { code: "L", fhir: "L", note: "Legally Separated" },
      { code: "P", fhir: "P", note: "Domestic partner" },
      { code: "T", fhir: "T", note: "Unmarried (domestic partner or unreported)" },
      { code: "U", fhir: "UNK", note: "Unknown — from the NullFlavor system, not v3-MaritalStatus." },
    ],
  },
  "0004": {
    name: "Patient Class → Encounter.class",
    target: `${TERM}/v3-ActCode`,
    map: [
      { code: "I", fhir: "IMP", note: "Inpatient encounter" },
      { code: "O", fhir: "AMB", note: "Ambulatory" },
      { code: "E", fhir: "EMER", note: "Emergency" },
      { code: "P", fhir: "PRENC", note: "Pre-admission" },
      { code: "R", fhir: "AMB", note: "Recurring patient — series of ambulatory visits." },
      { code: "B", fhir: "IMP", note: "Obstetrics. Class is inpatient; carry the obstetric nature in Encounter.type." },
      { code: "C", fhir: "AMB", note: "Commercial account — often not a real encounter at all; consider suppressing the Encounter." },
      { code: "N", fhir: "(none)", note: "Not applicable. Emit no Encounter; the message is patient-only." },
      { code: "U", fhir: "(none)", note: "Unknown. Encounter.class is 1..1 in R4, so a missing class means you cannot emit a conformant Encounter — flag it rather than guessing AMB." },
    ],
  },
  "0007": {
    name: "Admission Type → Encounter.priority",
    target: `${TERM}/v3-ActPriority`,
    map: [
      { code: "A", fhir: "EM", note: "Accident" },
      { code: "C", fhir: "EL", note: "Elective" },
      { code: "E", fhir: "EM", note: "Emergency" },
      { code: "L", fhir: "R", note: "Labor and delivery" },
      { code: "N", fhir: "R", note: "Newborn" },
      { code: "R", fhir: "R", note: "Routine" },
      { code: "U", fhir: "UR", note: "Urgent" },
    ],
  },
  "0038": {
    name: "Order Status (ORC-5) → ServiceRequest.status",
    target: "http://hl7.org/fhir/ValueSet/request-status",
    map: [
      { code: "A", fhir: "active", note: "Some, but not all, results available" },
      { code: "CA", fhir: "revoked", note: "Order was cancelled" },
      { code: "CM", fhir: "completed" },
      { code: "DC", fhir: "revoked", note: "Discontinued" },
      { code: "ER", fhir: "entered-in-error" },
      { code: "HD", fhir: "on-hold" },
      { code: "IP", fhir: "active", note: "In process, unspecified" },
      { code: "RP", fhir: "revoked", note: "Replaced. The replacement order carries ServiceRequest.replaces back to this one." },
      { code: "SC", fhir: "active", note: "In process, scheduled" },
    ],
  },
  "0119": {
    name: "Order Control (ORC-1) → ServiceRequest.status + intent",
    target: "http://hl7.org/fhir/ValueSet/request-status",
    note: "ORC-1 is a verb, not a state — it says what to do to the order. ORC-5 is the state. When both are present ORC-5 wins for status, and ORC-1 tells you whether this is a create, an update, or a cancel.",
    map: [
      { code: "NW", fhir: "active | order", note: "New order — create the ServiceRequest." },
      { code: "OK", fhir: "active", note: "Order accepted & OK — acknowledgement, not a state change." },
      { code: "CA", fhir: "revoked", note: "Cancel order request." },
      { code: "OC", fhir: "revoked", note: "Order cancelled." },
      { code: "DC", fhir: "revoked", note: "Discontinue request." },
      { code: "OD", fhir: "revoked", note: "Order discontinued." },
      { code: "HD", fhir: "on-hold", note: "Hold order request." },
      { code: "OH", fhir: "on-hold", note: "Order held." },
      { code: "RL", fhir: "active", note: "Release previous hold." },
      { code: "XO", fhir: "active", note: "Change order request — an update to the existing ServiceRequest, keyed on ORC-2/ORC-3." },
      { code: "XX", fhir: "active", note: "Order changed, unsolicited." },
      { code: "RP", fhir: "revoked", note: "Order replaced — the new order carries ServiceRequest.replaces." },
      { code: "RO", fhir: "active", note: "Replacement order. Emit ServiceRequest.replaces pointing at ORC-8 (parent order)." },
      { code: "SN", fhir: "active | order", note: "Send order number — filler assigns ORC-3." },
      { code: "SC", fhir: "active", note: "Status changed." },
      { code: "RE", fhir: "(no status)", note: "Observations to follow. Seen on ORU, not ORM — it means results are being reported, so it drives DiagnosticReport, not ServiceRequest.status." },
    ],
  },
  "0085": {
    name: "Observation Result Status (OBX-11) → Observation.status",
    target: "http://hl7.org/fhir/ValueSet/observation-status",
    map: [
      { code: "C", fhir: "corrected", note: "Record coming over is a correction." },
      { code: "D", fhir: "entered-in-error", note: "Deletes the OBX record." },
      { code: "F", fhir: "final" },
      { code: "I", fhir: "registered", note: "Specimen in lab, results pending." },
      { code: "P", fhir: "preliminary" },
      { code: "R", fhir: "preliminary", note: "Results entered, not verified." },
      { code: "S", fhir: "preliminary", note: "Partial results. Observation has no partial code — that lives on DiagnosticReport." },
      { code: "U", fhir: "final", note: "Results status change to final without retransmitting." },
      { code: "W", fhir: "entered-in-error", note: "Post original as wrong, e.g. wrong patient." },
      { code: "X", fhir: "cancelled", note: "Results cannot be obtained for this observation." },
    ],
  },
  "0123": {
    name: "Result Status (OBR-25) → DiagnosticReport.status",
    target: "http://hl7.org/fhir/ValueSet/diagnostic-report-status",
    map: [
      { code: "O", fhir: "registered", note: "Order received, specimen not yet received." },
      { code: "I", fhir: "registered", note: "No results available, specimen received." },
      { code: "S", fhir: "registered", note: "No results available, procedure scheduled." },
      { code: "A", fhir: "partial", note: "Some, but not all, results available." },
      { code: "P", fhir: "preliminary" },
      { code: "R", fhir: "preliminary", note: "Results stored, not yet verified." },
      { code: "F", fhir: "final" },
      { code: "C", fhir: "corrected", note: "Correction to a previously reported result." },
      { code: "X", fhir: "cancelled", note: "No results available; order cancelled." },
      { code: "Y", fhir: "entered-in-error", note: "No order on record for this test." },
      { code: "Z", fhir: "unknown", note: "No record of this patient." },
    ],
  },
  "0125": {
    name: "Value Type (OBX-2) → Observation.value[x]",
    target: "(chooses the polymorphic element)",
    note: "OBX-2 is what makes an OBX convertible at all — it tells you which value[x] to write. Getting it wrong is the most common cause of an Observation that validates but reads as gibberish.",
    map: [
      { code: "NM", fhir: "valueQuantity", note: "OBX-6 supplies the unit as a CE." },
      { code: "SN", fhir: "valueQuantity | valueRange | valueRatio", note: "The SN-3 separator decides — see get_datatype_mapping SN." },
      { code: "ST", fhir: "valueString" },
      { code: "TX", fhir: "valueString", note: "Repeating OBX-5 lines are one narrative: join them with newlines into a single Observation, not one per line." },
      { code: "FT", fhir: "valueString", note: "Strip the HL7 formatting escapes (\\.br\\, \\.sp\\) into plain newlines, or preserve them in DiagnosticReport.presentedForm." },
      { code: "CE", fhir: "valueCodeableConcept" },
      { code: "CWE", fhir: "valueCodeableConcept" },
      { code: "DT", fhir: "valueDateTime" },
      { code: "TS", fhir: "valueDateTime" },
      { code: "TM", fhir: "valueTime" },
      { code: "IS", fhir: "valueCodeableConcept", note: "Site-local table — use your own system URI." },
      { code: "ED", fhir: "(not a value)", note: "Encapsulated data. Becomes DiagnosticReport.presentedForm or Media, not Observation.value." },
      { code: "RP", fhir: "(not a value)", note: "Reference pointer — a URL to the real content. Becomes Attachment.url on presentedForm, or ImagingStudy for radiology." },
      { code: "CX", fhir: "valueString", note: "An identifier as a result value; keep the composed string." },
      { code: "XCN", fhir: "valueString" },
    ],
  },
  "0078": {
    name: "Abnormal Flags (OBX-8) → Observation.interpretation",
    target: `${TERM}/v3-ObservationInterpretation`,
    note: "Codes are carried over unchanged — only the system URI changes. That makes this the easiest table in the set, and the one most often left unmapped anyway.",
    map: [
      { code: "L", fhir: "L", note: "Below low normal" },
      { code: "H", fhir: "H", note: "Above high normal" },
      { code: "LL", fhir: "LL", note: "Below lower panic limits" },
      { code: "HH", fhir: "HH", note: "Above upper panic limits" },
      { code: "N", fhir: "N", note: "Normal" },
      { code: "A", fhir: "A", note: "Abnormal" },
      { code: "AA", fhir: "AA", note: "Critically abnormal" },
      { code: "S", fhir: "S", note: "Susceptible" },
      { code: "R", fhir: "R", note: "Resistant" },
      { code: "I", fhir: "I", note: "Intermediate" },
      { code: "U", fhir: "U", note: "Significant change up" },
      { code: "D", fhir: "D", note: "Significant change down" },
    ],
  },
  "0203": {
    name: "Identifier Type (CX-5, XCN-13) → Identifier.type",
    target: `${TERM}/v2-0203`,
    note: "Codes carry over unchanged. What matters is Identifier.system, which this table does NOT give you — that comes from the assigning authority in CX-4.",
    map: [
      { code: "MR", fhir: "MR", note: "Medical record number" },
      { code: "PI", fhir: "PI", note: "Patient internal identifier" },
      { code: "PT", fhir: "PT", note: "Patient external identifier" },
      { code: "SS", fhir: "SS", note: "Social Security number. In the US, system=http://hl7.org/fhir/sid/us-ssn." },
      { code: "DL", fhir: "DL", note: "Driver's license number" },
      { code: "AN", fhir: "AN", note: "Account number — the usual source of Encounter.identifier." },
      { code: "VN", fhir: "VN", note: "Visit number — preferred over AN for Encounter.identifier when both are sent." },
      { code: "NPI", fhir: "NPI", note: "National provider identifier. system=http://hl7.org/fhir/sid/us-npi." },
      { code: "PRN", fhir: "PRN", note: "Provider number" },
      { code: "MA", fhir: "MA", note: "Medicaid number" },
      { code: "MC", fhir: "MC", note: "Medicare number" },
    ],
  },
  "0136": {
    name: "Yes/No Indicator → boolean",
    target: "(boolean)",
    map: [
      { code: "Y", fhir: "true" },
      { code: "N", fhir: "false" },
      { code: "", fhir: "(absent)", note: "An empty indicator is not false — omit the element rather than defaulting it." },
    ],
  },
  "0396": {
    name: "Coding System (CE-3) → CodeableConcept.coding.system",
    target: "(system URIs)",
    map: [
      { code: "LN", fhir: "http://loinc.org" },
      { code: "SCT", fhir: "http://snomed.info/sct" },
      { code: "SNM3", fhir: "http://snomed.info/sct", note: "SNOMED v3 — codes are not interchangeable with SCT; translate, don't relabel." },
      { code: "I9C", fhir: "http://hl7.org/fhir/sid/icd-9-cm" },
      { code: "I10", fhir: "http://hl7.org/fhir/sid/icd-10" },
      { code: "I10P", fhir: "http://www.cms.gov/Medicare/Coding/ICD10" },
      { code: "C4", fhir: "http://www.ama-assn.org/go/cpt", note: "CPT-4" },
      { code: "HCPCS", fhir: "urn:oid:2.16.840.1.113883.6.14" },
      { code: "RXNORM", fhir: "http://www.nlm.nih.gov/research/umls/rxnorm" },
      { code: "DCM", fhir: "http://dicom.nema.org/resources/ontology/DCM" },
      { code: "UCUM", fhir: "http://unitsofmeasure.org" },
      { code: "99zzz", fhir: "(a URI you own)", note: "Any 99-prefixed system is local. Mint a stable URI per sending system — reusing one URI for two hospitals' local codes silently merges two code systems." },
    ],
  },
};

// ─── Segment → resource field maps ───────────────────────────────────────────

const SEGMENT_MAPS = {
  MSH: {
    resource: "MessageHeader (+ Bundle.meta)",
    summary: "Transport metadata. In a FHIR message Bundle it becomes MessageHeader; in the far more common transaction-Bundle conversion most of it is provenance, not payload.",
    fields: [
      { seq: 3, name: "Sending Application", path: "MessageHeader.source.name", note: "Also the natural key for Provenance.agent.who when you keep an audit trail." },
      { seq: 4, name: "Sending Facility", path: "MessageHeader.sender → Reference(Organization)" },
      { seq: 5, name: "Receiving Application", path: "MessageHeader.destination.name" },
      { seq: 6, name: "Receiving Facility", path: "MessageHeader.destination.receiver → Reference(Organization)" },
      { seq: 7, name: "Date/Time of Message", path: "Bundle.timestamp", note: "instant — a timezone offset is mandatory here even though TS makes it optional." },
      { seq: 9, name: "Message Type", path: "MessageHeader.eventCoded", note: "MSH-9.1^9.2 map to the v2-to-FHIR event; MSH-9.3 (message structure) selects which conversion profile runs." },
      { seq: 10, name: "Message Control ID", path: "Bundle.identifier.value", note: "The one field that makes a conversion idempotent — key your dedup on it." },
      { seq: 11, name: "Processing ID", path: "(routing only)", note: "D/T must never reach a production FHIR store. Reject rather than convert." },
      { seq: 12, name: "Version ID", path: "(selects the conversion profile)" },
      { seq: 21, name: "Message Profile Identifier", path: "Bundle.meta.profile", note: "If the sender declares a profile, carry it — it is the only machine-readable statement of what the message promised to contain." },
    ],
  },
  EVN: {
    resource: "(Provenance / Encounter timing)",
    summary: "No resource of its own. EVN answers when and why, which lands on Provenance and on the Encounter's period.",
    fields: [
      { seq: 2, name: "Recorded Date/Time", path: "Provenance.recorded" },
      { seq: 4, name: "Event Reason Code", path: "Encounter.reasonCode | Provenance.reason" },
      { seq: 5, name: "Operator ID", path: "Provenance.agent.who → Reference(Practitioner)" },
      { seq: 6, name: "Event Occurred", path: "Encounter.period.start (A01/A04) | Encounter.period.end (A03)", note: "EVN-6, not EVN-2, is the clinical time. EVN-2 is when the clerk typed it." },
      { seq: 7, name: "Event Facility", path: "Provenance.agent.onBehalfOf → Reference(Organization)" },
    ],
  },
  PID: {
    resource: "Patient",
    summary: "The anchor of every conversion. Everything else in the bundle references the Patient this segment produces.",
    fields: [
      { seq: 3, name: "Patient Identifier List", path: "Patient.identifier", note: "Repeating CX. The MR occurrence is what downstream conditional-updates match on — Patient?identifier=<system>|<value>." },
      { seq: 5, name: "Patient Name", path: "Patient.name", note: "XPN-7=L becomes use=official; a maiden name (M) is a second HumanName, not a separate Patient." },
      { seq: 6, name: "Mother's Maiden Name", path: "Patient.extension (patient-mothersMaidenName)" },
      { seq: 7, name: "Date/Time of Birth", path: "Patient.birthDate (+ patient-birthTime extension)", note: "Patient.birthDate is a date. A birth time (neonatal units send one) survives only in the extension." },
      { seq: 8, name: "Administrative Sex", path: "Patient.gender", note: "Table 0001. Administrative sex is not clinical sex — do not silently promote it to a US Core birth-sex extension." },
      { seq: 10, name: "Race", path: "Patient.extension (us-core-race)" },
      { seq: 11, name: "Patient Address", path: "Patient.address" },
      { seq: 13, name: "Phone Number - Home", path: "Patient.telecom (use=home)" },
      { seq: 14, name: "Phone Number - Business", path: "Patient.telecom (use=work)" },
      { seq: 15, name: "Primary Language", path: "Patient.communication.language", note: "Set communication.preferred=true; PID-15 is by definition the primary language." },
      { seq: 16, name: "Marital Status", path: "Patient.maritalStatus" },
      { seq: 17, name: "Religion", path: "Patient.extension (patient-religion)" },
      { seq: 18, name: "Patient Account Number", path: "Encounter.identifier (type AN) | Account.identifier", note: "Belongs to the account, not the person — putting it on Patient.identifier is a common and costly mistake." },
      { seq: 22, name: "Ethnic Group", path: "Patient.extension (us-core-ethnicity)" },
      { seq: 24, name: "Multiple Birth Indicator", path: "Patient.multipleBirthBoolean" },
      { seq: 25, name: "Birth Order", path: "Patient.multipleBirthInteger", note: "Mutually exclusive with multipleBirthBoolean — when PID-25 is present it replaces PID-24." },
      { seq: 29, name: "Patient Death Date and Time", path: "Patient.deceasedDateTime" },
      { seq: 30, name: "Patient Death Indicator", path: "Patient.deceasedBoolean", note: "Superseded by PID-29 when a date is present." },
      { seq: 33, name: "Last Update Date/Time", path: "Patient.meta.lastUpdated", note: "Server-maintained in FHIR — most servers overwrite it. Keep the source value in Provenance if you need it." },
    ],
  },
  PD1: {
    resource: "Patient (+ Organization)",
    summary: "Additional demographics; folds into the Patient the PID produced.",
    fields: [
      { seq: 3, name: "Patient Primary Facility", path: "Patient.managingOrganization → Reference(Organization)" },
      { seq: 4, name: "Patient Primary Care Provider", path: "Patient.generalPractitioner → Reference(Practitioner)", note: "Deprecated in v2.5.1 in favour of the ROL segment, but still the field most senders populate." },
      { seq: 6, name: "Organ Donor Code", path: "Patient.extension" },
      { seq: 11, name: "Publicity Code", path: "Patient.extension" },
      { seq: 12, name: "Protection Indicator", path: "Patient.meta.security (code RESTRICTED)", note: "Y here is a confidentiality flag with real consequences — never drop it silently." },
    ],
  },
  NK1: {
    resource: "Patient.contact | RelatedPerson",
    summary: "A next of kin is Patient.contact when it is only a contact, and a RelatedPerson when it needs to be referenced from elsewhere (a consent, an observation performer).",
    fields: [
      { seq: 2, name: "Name", path: "Patient.contact.name | RelatedPerson.name" },
      { seq: 3, name: "Relationship", path: "Patient.contact.relationship", note: `Table 0063 → ${TERM}/v2-0131 for contact roles.` },
      { seq: 4, name: "Address", path: "Patient.contact.address" },
      { seq: 5, name: "Phone Number", path: "Patient.contact.telecom" },
      { seq: 7, name: "Contact Role", path: "Patient.contact.relationship" },
      { seq: 13, name: "Organization Name - NK1", path: "Patient.contact.organization → Reference(Organization)" },
    ],
  },
  PV1: {
    resource: "Encounter",
    summary: "One PV1 makes one Encounter, plus a Location chain from PV1-3 and a Practitioner per named doctor.",
    fields: [
      { seq: 2, name: "Patient Class", path: "Encounter.class", note: "Table 0004. Required 1..1 in R4 — a missing or U class blocks a conformant Encounter." },
      { seq: 3, name: "Assigned Patient Location", path: "Encounter.location.location → Reference(Location)", note: "PL hierarchy; status=active while the patient is there." },
      { seq: 4, name: "Admission Type", path: "Encounter.priority" },
      { seq: 6, name: "Prior Patient Location", path: "Encounter.location (status=completed)", note: "On an A02 the prior location closes out and the new one opens — two location entries, not one moved." },
      { seq: 7, name: "Attending Doctor", path: "Encounter.participant (type=ATND)" },
      { seq: 8, name: "Referring Doctor", path: "Encounter.participant (type=REF)" },
      { seq: 9, name: "Consulting Doctor", path: "Encounter.participant (type=CON)" },
      { seq: 10, name: "Hospital Service", path: "Encounter.serviceType" },
      { seq: 17, name: "Admitting Doctor", path: "Encounter.participant (type=ADM)" },
      { seq: 19, name: "Visit Number", path: "Encounter.identifier (type=VN)", note: "The join key for every later message about this visit." },
      { seq: 36, name: "Discharge Disposition", path: "Encounter.hospitalization.dischargeDisposition", note: `Table 0112, carried over with system ${TERM}/v2-0112.` },
      { seq: 37, name: "Discharged to Location", path: "Encounter.hospitalization.destination → Reference(Location)" },
      { seq: 44, name: "Admit Date/Time", path: "Encounter.period.start" },
      { seq: 45, name: "Discharge Date/Time", path: "Encounter.period.end", note: "Its presence, not the trigger event, is what should set Encounter.status=finished." },
    ],
  },
  ORC: {
    resource: "ServiceRequest",
    summary: "The order-control layer. ORC carries who ordered it and what state it is in; the OBR under it carries what was ordered.",
    fields: [
      { seq: 1, name: "Order Control", path: "(selects create/update/cancel)", note: "Table 0119 — a verb, not a status. See lookup_concept_map 0119." },
      { seq: 2, name: "Placer Order Number", path: "ServiceRequest.identifier (type=PLAC)", note: "The stable key across ORM and ORU. Conditional-update on it." },
      { seq: 3, name: "Filler Order Number", path: "ServiceRequest.identifier (type=FILL)", note: "Also becomes DiagnosticReport.identifier on the matching ORU — the join between order and result." },
      { seq: 5, name: "Order Status", path: "ServiceRequest.status", note: "Table 0038. Beats ORC-1 when both are present." },
      { seq: 7, name: "Quantity/Timing", path: "ServiceRequest.occurrence[x]", note: "Withdrawn in v2.5 in favour of TQ1, but still sent. TQ.4 start / TQ.5 end become occurrencePeriod; TQ.6 priority becomes ServiceRequest.priority." },
      { seq: 9, name: "Date/Time of Transaction", path: "ServiceRequest.authoredOn" },
      { seq: 10, name: "Entered By", path: "ServiceRequest.requester → Reference(Practitioner)", note: "Fallback only — ORC-12 is the clinically responsible orderer." },
      { seq: 12, name: "Ordering Provider", path: "ServiceRequest.requester → Reference(Practitioner)" },
      { seq: 13, name: "Enterer's Location", path: "ServiceRequest.locationReference" },
      { seq: 14, name: "Call Back Phone Number", path: "ServiceRequest.contained Practitioner.telecom | extension" },
      { seq: 17, name: "Entering Organization", path: "ServiceRequest.performer → Reference(Organization)" },
      { seq: 21, name: "Ordering Facility Name", path: "ServiceRequest.requester.onBehalfOf" },
    ],
  },
  OBR: {
    resource: "ServiceRequest (in ORM) | DiagnosticReport (in ORU)",
    summary: "The same segment means two different things depending on the message. In an ORM it completes the ServiceRequest; in an ORU it heads the DiagnosticReport that the OBX rows belong to.",
    fields: [
      { seq: 2, name: "Placer Order Number", path: "ServiceRequest.identifier | DiagnosticReport.basedOn", note: "Same value as ORC-2; when the two disagree, ORC wins." },
      { seq: 3, name: "Filler Order Number", path: "ServiceRequest.identifier | DiagnosticReport.identifier" },
      { seq: 4, name: "Universal Service Identifier", path: "ServiceRequest.code | DiagnosticReport.code", note: "The single most important coded field in either message. LOINC in the alternate coding is what makes results comparable across sites." },
      { seq: 6, name: "Requested Date/Time", path: "ServiceRequest.occurrenceDateTime" },
      { seq: 7, name: "Observation Date/Time", path: "DiagnosticReport.effectiveDateTime", note: "The clinically relevant time of the study or specimen — not when the report was typed." },
      { seq: 8, name: "Observation End Date/Time", path: "DiagnosticReport.effectivePeriod.end" },
      { seq: 10, name: "Collector Identifier", path: "Specimen.collection.collector" },
      { seq: 11, name: "Specimen Action Code", path: "(routing)", note: "G/L/O/P/R/S/A. 'A' (add-on) means an amendment to an existing order, not a new one." },
      { seq: 13, name: "Relevant Clinical Information", path: "ServiceRequest.reasonCode | supportingInfo", note: "Free text as often as coded — CodeableConcept.text is the honest mapping." },
      { seq: 15, name: "Specimen Source", path: "Specimen.type + Specimen.collection.bodySite" },
      { seq: 16, name: "Ordering Provider", path: "ServiceRequest.requester | DiagnosticReport.resultsInterpreter" },
      { seq: 18, name: "Placer Field 1", path: "(site-local)", note: "In radiology this frequently carries the accession number. Check the sending system before mapping it anywhere." },
      { seq: 19, name: "Placer Field 2", path: "(site-local)" },
      { seq: 20, name: "Filler Field 1", path: "ImagingStudy.identifier (ACSN)", note: "The accession number on most RIS interfaces." },
      { seq: 22, name: "Results Rpt/Status Chng - Date/Time", path: "DiagnosticReport.issued" },
      { seq: 24, name: "Diagnostic Serv Sect ID", path: "DiagnosticReport.category", note: `Table 0074 → ${TERM}/v2-0074. RAD, LAB, CH, MB, CT…` },
      { seq: 25, name: "Result Status", path: "DiagnosticReport.status", note: "Table 0123." },
      { seq: 27, name: "Quantity/Timing", path: "ServiceRequest.occurrence[x] + priority", note: "TQ.6 priority: S(STAT)→stat, A(ASAP)→urgent, R(Routine)→routine." },
      { seq: 31, name: "Reason for Study", path: "ServiceRequest.reasonCode | DiagnosticReport.conclusionCode" },
      { seq: 32, name: "Principal Result Interpreter", path: "DiagnosticReport.resultsInterpreter", note: "NDL datatype, not XCN — component 1 is a nested CNN." },
      { seq: 44, name: "Procedure Code", path: "ServiceRequest.code (coding[1])", note: "Usually CPT. Add it as a second coding on the same CodeableConcept as OBR-4, not a separate element." },
    ],
  },
  OBX: {
    resource: "Observation",
    summary: "One OBX is one Observation, except when it is not: repeating TX lines under one OBX-3 are a single narrative Observation, and an ED/RP value is an attachment rather than a value.",
    fields: [
      { seq: 2, name: "Value Type", path: "(selects Observation.value[x])", note: "Table 0125. Read this before OBX-5." },
      { seq: 3, name: "Observation Identifier", path: "Observation.code" },
      { seq: 4, name: "Observation Sub-ID", path: "(grouping key)", note: "Groups related OBX rows — becomes Observation.component or an Observation.hasMember panel, never a field of its own." },
      { seq: 5, name: "Observation Value", path: "Observation.value[x]", note: "Type chosen by OBX-2." },
      { seq: 6, name: "Units", path: "Observation.valueQuantity.unit/code/system" },
      { seq: 7, name: "References Range", path: "Observation.referenceRange.text (+ low/high when parseable)", note: "'3.5-5.0' parses to low/high; anything else stays as text rather than being guessed at." },
      { seq: 8, name: "Abnormal Flags", path: "Observation.interpretation", note: "Table 0078." },
      { seq: 11, name: "Observation Result Status", path: "Observation.status", note: "Table 0085. Required 1..1 in R4." },
      { seq: 14, name: "Date/Time of the Observation", path: "Observation.effectiveDateTime", note: "Falls back to OBR-7 when empty." },
      { seq: 15, name: "Producer's ID", path: "Observation.performer → Reference(Organization)", note: "The performing lab — CLIA-relevant." },
      { seq: 16, name: "Responsible Observer", path: "Observation.performer → Reference(Practitioner)" },
      { seq: 17, name: "Observation Method", path: "Observation.method" },
      { seq: 18, name: "Equipment Instance Identifier", path: "Observation.device → Reference(Device)" },
      { seq: 19, name: "Date/Time of the Analysis", path: "Observation.issued" },
    ],
  },
  NTE: {
    resource: "(note on the parent resource)",
    summary: "NTE has no resource. Where it lands depends entirely on what it follows — after OBR it is DiagnosticReport.conclusion, after OBX it is Observation.note, after ORC it is ServiceRequest.note.",
    fields: [
      { seq: 2, name: "Source of Comment", path: "Annotation.author[x]", note: "L=ancillary (filler), P=orderer (placer), O=other." },
      { seq: 3, name: "Comment", path: "Annotation.text | DiagnosticReport.conclusion", note: "Repeating — join the repetitions with newlines into one annotation." },
      { seq: 4, name: "Comment Type", path: "(routing)", note: "Table 0364. PI (patient instructions) and RE (remark) belong in different places." },
    ],
  },
  AL1: {
    resource: "AllergyIntolerance",
    summary: "A snapshot list, not events: every ADT resends the full list, so the conversion has to reconcile against what is already stored rather than append.",
    fields: [
      { seq: 2, name: "Allergen Type Code", path: "AllergyIntolerance.category", note: "DA/MA/MC→medication, FA→food, EA→environment, AA→biologic." },
      { seq: 3, name: "Allergen Code/Mnemonic/Description", path: "AllergyIntolerance.code" },
      { seq: 4, name: "Allergy Severity Code", path: "AllergyIntolerance.reaction.severity", note: "SV→severe, MO→moderate, MI→mild." },
      { seq: 5, name: "Allergy Reaction Code", path: "AllergyIntolerance.reaction.manifestation" },
      { seq: 6, name: "Identification Date", path: "AllergyIntolerance.recordedDate" },
    ],
  },
  DG1: {
    resource: "Condition",
    summary: "Encounter diagnoses. Link them with Encounter.diagnosis.condition and set Condition.encounter back — the two directions are both expected.",
    fields: [
      { seq: 3, name: "Diagnosis Code - DG1", path: "Condition.code" },
      { seq: 5, name: "Diagnosis Date/Time", path: "Condition.onsetDateTime | recordedDate" },
      { seq: 6, name: "Diagnosis Type", path: "Encounter.diagnosis.use", note: "A→admitting, W→working, F→final/discharge." },
      { seq: 15, name: "Diagnosis Priority", path: "Encounter.diagnosis.rank", note: "1 is the principal diagnosis; 0 means not ranked, which is not the same as rank 0." },
      { seq: 16, name: "Diagnosing Clinician", path: "Condition.asserter → Reference(Practitioner)" },
      { seq: 19, name: "Attestation Date/Time", path: "Condition.recordedDate" },
    ],
  },
  MRG: {
    resource: "Patient.link",
    summary: "Only in ADT^A40 (and A18/A34/A44). MRG-1 is the losing identifier; the PID above it is the surviving patient.",
    fields: [
      { seq: 1, name: "Prior Patient Identifier List", path: "Patient.link.other → Reference(Patient)", note: "The retired record. It gets link.type=replaced-by pointing at the survivor, and is marked active=false." },
      { seq: 3, name: "Prior Patient Account Number", path: "Encounter.identifier (of the merged account)" },
      { seq: 5, name: "Prior Visit Number", path: "Encounter.identifier", note: "Present on an A45 (move visit) rather than a plain A40." },
      { seq: 7, name: "Prior Patient Name", path: "(verification only)", note: "Do not write it — it exists so the receiver can confirm it is merging the right person." },
    ],
  },
  SPM: {
    resource: "Specimen",
    summary: "v2.5+ replacement for the specimen components of OBR-15. Referenced from DiagnosticReport.specimen and Observation.specimen.",
    fields: [
      { seq: 2, name: "Specimen ID", path: "Specimen.identifier / accessionIdentifier" },
      { seq: 4, name: "Specimen Type", path: "Specimen.type" },
      { seq: 8, name: "Specimen Source Site", path: "Specimen.collection.bodySite" },
      { seq: 11, name: "Specimen Role", path: "(routing)", note: "Q (QC), B (blind), P (patient). Only P belongs on the patient's chart." },
      { seq: 17, name: "Specimen Collection Date/Time", path: "Specimen.collection.collectedDateTime | collectedPeriod" },
      { seq: 18, name: "Specimen Received Date/Time", path: "Specimen.receivedTime" },
      { seq: 24, name: "Specimen Condition", path: "Specimen.condition" },
    ],
  },
  ZDS: {
    resource: "ImagingStudy",
    summary: "A Z-segment, so nothing about it is standard — but the IHE Radiology Scheduled Workflow profile pins it down: ZDS-1 is the Study Instance UID.",
    fields: [
      { seq: 1, name: "Study Instance UID", path: "ImagingStudy.identifier (urn:dicom:uid)", note: "Emit as urn:oid:<uid>. This is what joins the FHIR record to the images." },
    ],
  },
};

// ─── Message → bundle shape ──────────────────────────────────────────────────

const MESSAGE_MAPS = {
  "ADT^A01": {
    description: "Admit/Visit Notification",
    bundle: "transaction",
    produces: ["Patient", "Encounter", "Location", "Practitioner", "Condition", "AllergyIntolerance", "RelatedPerson"],
    segments: [
      { seg: "PID", resource: "Patient", note: "Conditional update on the MR identifier." },
      { seg: "PD1", resource: "Patient", note: "Merged into the same Patient." },
      { seg: "NK1", resource: "Patient.contact / RelatedPerson" },
      { seg: "PV1", resource: "Encounter", note: "status=in-progress; period.start from PV1-44 or EVN-6." },
      { seg: "PV1-3", resource: "Location", note: "One Location per populated PL level, chained by partOf." },
      { seg: "AL1", resource: "AllergyIntolerance" },
      { seg: "DG1", resource: "Condition", note: "Plus an Encounter.diagnosis back-reference." },
      { seg: "IN1", resource: "Coverage", note: "Out of scope for this server — insurance conversion has its own failure modes." },
    ],
    pitfalls: [
      "Encounter.class is 1..1. A PV1-2 of U or an absent PV1 makes a conformant Encounter impossible — fail the message rather than defaulting to AMB.",
      "An A01 is a full snapshot. Treat it as an upsert of the whole patient, not a patch: fields absent from the message are absent by assertion, not unchanged.",
    ],
  },
  "ADT^A04": {
    description: "Register a Patient (outpatient)",
    bundle: "transaction",
    produces: ["Patient", "Encounter", "Location", "Practitioner", "Condition", "AllergyIntolerance"],
    segments: [
      { seg: "PID", resource: "Patient" },
      { seg: "PV1", resource: "Encounter", note: "PV1-2 should be O → Encounter.class=AMB." },
      { seg: "AL1", resource: "AllergyIntolerance" },
      { seg: "DG1", resource: "Condition" },
    ],
    pitfalls: ["Structurally identical to A01; only the expected patient class differs. Share one converter and branch on PV1-2, not on the trigger event."],
  },
  "ADT^A08": {
    description: "Update Patient Information",
    bundle: "transaction",
    produces: ["Patient", "Encounter", "Location", "Practitioner", "Condition", "AllergyIntolerance"],
    segments: [
      { seg: "PID", resource: "Patient", note: "The most common message in any interface. Same mapping as A01." },
      { seg: "PV1", resource: "Encounter", note: "Update, not create — match on PV1-19." },
      { seg: "AL1", resource: "AllergyIntolerance", note: "A full resend of the list. Reconcile: mark stored allergies absent from this message as inactive rather than deleting." },
    ],
    pitfalls: [
      "A08 is a snapshot, but most receivers treat it as a patch, so an emptied field never clears downstream. Decide which semantics you implement and document it.",
      "A08 can carry a changed MRN. If PID-3 no longer matches the stored identifier you have an unannounced merge, not an update — quarantine it.",
    ],
  },
  "ADT^A31": {
    description: "Update Person Information",
    bundle: "transaction",
    produces: ["Patient"],
    segments: [
      { seg: "PID", resource: "Patient" },
      { seg: "PD1", resource: "Patient" },
    ],
    pitfalls: [
      "A31 is person-level, not visit-level: there is no PV1 and no Encounter. Emitting one because your A08 converter always does is the classic A31 bug.",
    ],
  },
  "ADT^A40": {
    description: "Merge Patient — Patient Identifier List",
    bundle: "transaction",
    produces: ["Patient (survivor)", "Patient (retired)"],
    segments: [
      { seg: "PID", resource: "Patient", note: "The SURVIVING patient — the identifier that remains valid." },
      { seg: "MRG", resource: "Patient.link", note: "The LOSING patient. Set active=false and link.type=replaced-by → the survivor." },
    ],
    pitfalls: [
      "Direction is reversible and reversing it is silent: PID survives, MRG loses. Getting it backwards retires the wrong chart and the message still validates.",
      "The retired Patient must keep its identifier — references stored elsewhere still resolve to it, which is exactly what link exists for.",
      "Resources referencing the losing patient are not rewritten by the merge. Either re-point them or rely on link traversal, but do not assume a FHIR server does it for you.",
    ],
  },
  "ORM^O01": {
    description: "General Order",
    bundle: "transaction",
    produces: ["ServiceRequest", "Patient", "Encounter", "Practitioner", "Observation"],
    segments: [
      { seg: "PID", resource: "Patient" },
      { seg: "PV1", resource: "Encounter", note: "Optional in an ORM; when absent, ServiceRequest carries no encounter." },
      { seg: "ORC", resource: "ServiceRequest", note: "status/intent; identifiers from ORC-2/ORC-3." },
      { seg: "OBR", resource: "ServiceRequest", note: "Same resource as the ORC above it — code, timing, reason." },
      { seg: "OBX", resource: "Observation", note: "Order-entry answers (weight, creatinine, LMP), not results. category=exam, and they support the request rather than fulfilling it." },
      { seg: "NTE", resource: "ServiceRequest.note" },
      { seg: "ZDS", resource: "ImagingStudy.identifier", note: "IHE radiology: the Study Instance UID assigned at order time." },
    ],
    pitfalls: [
      "One ORM can carry several ORC/OBR pairs — that is N ServiceRequests in one bundle, not one with repeated codes.",
      "OBX in an ORM is not a result. Giving those Observations category=laboratory puts order-entry answers into the patient's result history.",
      "ORC-1 (verb) and ORC-5 (state) both exist and disagree often. ORC-5 sets status; ORC-1 decides create vs update vs cancel.",
    ],
  },
  "ORU^R01": {
    description: "Unsolicited Observation Result",
    bundle: "transaction",
    produces: ["DiagnosticReport", "Observation", "Patient", "Specimen", "Practitioner", "ImagingStudy"],
    segments: [
      { seg: "PID", resource: "Patient" },
      { seg: "PV1", resource: "Encounter" },
      { seg: "ORC", resource: "ServiceRequest (referenced)", note: "Usually a reference to the already-converted order, via ORC-2 — do not re-create it from scratch." },
      { seg: "OBR", resource: "DiagnosticReport", note: "One OBR = one report. status from OBR-25, effective from OBR-7, issued from OBR-22." },
      { seg: "OBX", resource: "Observation", note: "Each becomes DiagnosticReport.result[n]." },
      { seg: "NTE", resource: "DiagnosticReport.conclusion | Observation.note", note: "Depends on which segment it follows." },
      { seg: "SPM", resource: "Specimen" },
      { seg: "ZDS", resource: "ImagingStudy" },
    ],
    pitfalls: [
      "A radiology narrative arrives as dozens of repeating TX OBX rows. They are one report, not dozens of observations — join them into DiagnosticReport.conclusion (or one narrative Observation), preserving line order.",
      "Observation.status and DiagnosticReport.status come from different fields (OBX-11, OBR-25) and legitimately differ. Do not copy one into the other.",
      "A corrected result (OBR-25=C) must update the original DiagnosticReport, matched on the filler order number — appending a second report leaves both visible to clinicians.",
      "DiagnosticReport.result ordering is the report's reading order. Bundle entries are unordered, so the order must be carried in the result[] list itself.",
    ],
  },
};

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** Split a message into segment lines and recover its delimiters from MSH. */
function dissect(message) {
  let raw = String(message).replace(/^\x0B/, "").replace(/\x1C\x0D?$/, "");
  raw = raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  const lines = raw
    .split("\r")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  const msh = lines[0] ?? "";
  return {
    lines,
    fieldSep: msh.length > 3 ? msh[3] : "|",
    compSep: msh.length > 4 ? msh[4] : "^",
    repSep: msh.length > 5 ? msh[5] : "~",
    escChar: msh.length > 6 ? msh[6] : "\\",
    subSep: msh.length > 7 ? msh[7] : "&",
  };
}

/**
 * Build a 1-based field accessor for a segment line. MSH is offset-corrected so
 * f(1) is the field separator, matching how the standard numbers them.
 */
function fielder(line, fieldSep) {
  const isMsh = line.startsWith("MSH");
  const parts = line.split(fieldSep);
  return (n) => (isMsh ? (n === 1 ? fieldSep : parts[n - 1] ?? "") : parts[n] ?? "");
}

/** Parse a message into delimiter context plus an ordered segment list. */
function parse(message) {
  const ctx = dissect(message);
  const segs = ctx.lines.map((line, i) => ({
    index: i,
    name: line.slice(0, 3).toUpperCase(),
    line,
    f: fielder(line, ctx.fieldSep),
  }));
  return { ctx, segs };
}

const rawComp = (val, n, sep) => ((val ?? "").split(sep)[n - 1] ?? "").trim();
const reps = (val, sep) => (val ?? "").split(sep).filter((x) => x.trim().length > 0);

/** Reverse the HL7 escape sequences so the FHIR string is the real text. */
function unesc(value, ctx) {
  if (!value) return value;
  const e = ctx.escChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(value)
    .replace(new RegExp(`${e}F${e}`, "g"), ctx.fieldSep)
    .replace(new RegExp(`${e}S${e}`, "g"), ctx.compSep)
    .replace(new RegExp(`${e}T${e}`, "g"), ctx.subSep)
    .replace(new RegExp(`${e}R${e}`, "g"), ctx.repSep)
    .replace(new RegExp(`${e}\\.br${e}`, "g"), "\n")
    .replace(new RegExp(`${e}X([0-9A-Fa-f]+)${e}`, "g"), (_m, hex) =>
      hex.match(/.{1,2}/g).map((b) => String.fromCharCode(parseInt(b, 16))).join("")
    )
    .replace(new RegExp(`${e}E${e}`, "g"), ctx.escChar);
}

/** Component accessor that also unescapes — the form every mapper wants. */
const c = (ctx) => (val, n) => unesc(rawComp(val, n, ctx.compSep), ctx);
const sub = (ctx) => (val, n) => unesc(rawComp(val, n, ctx.subSep), ctx);

// ─── Datatype converters ─────────────────────────────────────────────────────

/** HL7 TS/DTM → FHIR date | dateTime, preserving the source precision. */
function toFhirDate(ts) {
  const v = String(ts ?? "").trim();
  if (!v) return undefined;
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\.\d{1,4})?([+-]\d{4})?$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  if (!mo) return y;
  if (!d) return `${y}-${mo}`;
  if (!h) return `${y}-${mo}-${d}`;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "";
  const time = `${h}:${mi ?? "00"}:${s ?? "00"}${s && frac ? frac : ""}`;
  return `${y}-${mo}-${d}T${time}${offset}`;
}

/** True when a converted timestamp carries a time but no zone offset. */
const zonelessTime = (fhirDate) => Boolean(fhirDate && fhirDate.includes("T") && !/[+-]\d{2}:\d{2}$/.test(fhirDate));

/**
 * Resolve an HD-shaped namespace triple to an Identifier.system URI.
 * Only the universal ID is safe without a site lookup table; a bare namespace
 * gets a urn:id: form and a warning rather than a fabricated http URI.
 */
function systemFrom(namespace, universalId, universalType) {
  if (universalId) {
    const t = (universalType || "").toUpperCase();
    if (t === "ISO") return { system: `urn:oid:${universalId}`, assumed: false };
    if (t === "UUID" || t === "GUID") return { system: `urn:uuid:${universalId}`, assumed: false };
    if (t === "URI" || t === "DNS") return { system: universalId, assumed: false };
    return { system: `urn:id:${universalId}`, assumed: true };
  }
  if (namespace) return { system: `urn:id:${namespace}`, assumed: true };
  return { system: undefined, assumed: false };
}

const CODE_SYSTEM_URIS = Object.fromEntries(
  CONCEPT_MAPS["0396"].map.filter((m) => m.fhir.startsWith("http") || m.fhir.startsWith("urn:")).map((m) => [m.code, m.fhir])
);

/** CE/CWE → CodeableConcept. Both the primary and alternate coding are kept. */
function toCodeableConcept(value, ctx, warn) {
  const g = c(ctx);
  const [code, display, sysAbbr, altCode, altDisplay, altSysAbbr] = [1, 2, 3, 4, 5, 6].map((n) => g(value, n));
  if (!code && !altCode) {
    const text = unesc(String(value ?? "").trim(), ctx);
    return text ? { text } : undefined;
  }
  const coding = [];
  const push = (cd, disp, abbr) => {
    if (!cd) return;
    const system = CODE_SYSTEM_URIS[abbr] || (abbr ? `urn:id:${abbr}` : undefined);
    if (abbr && !CODE_SYSTEM_URIS[abbr] && warn) {
      warn(`Coding system '${abbr}' is not an HL7 table 0396 abbreviation; emitted as ${system}. Map it to a URI you own before this reaches a shared store.`);
    }
    if (!abbr && warn) warn(`Code '${cd}' arrived with no coding system (CE-3 empty); emitted without a system, which makes it unresolvable.`);
    coding.push({ ...(system ? { system } : {}), code: cd, ...(disp ? { display: disp } : {}) });
  };
  push(code, display, sysAbbr);
  push(altCode, altDisplay, altSysAbbr);
  return { coding, ...(display ? { text: display } : {}) };
}

/** CX → Identifier. */
function toIdentifier(value, ctx, warn) {
  const g = c(ctx);
  const s = sub(ctx);
  const id = g(value, 1);
  if (!id) return undefined;
  const auth = rawComp(value, 4, ctx.compSep);
  const { system, assumed } = systemFrom(s(auth, 1), s(auth, 2), s(auth, 3));
  if (assumed && warn) {
    warn(`Identifier '${id}' has assigning authority '${s(auth, 1) || s(auth, 2)}' with no universal ID type; emitted as ${system}. Replace it with the real system URI from your identifier registry.`);
  }
  const typeCode = g(value, 5);
  return {
    ...(typeCode ? { type: { coding: [{ system: `${TERM}/v2-0203`, code: typeCode }] } } : {}),
    ...(system ? { system } : {}),
    value: id,
  };
}

const XPN_USE = { L: "official", A: "anonymous", D: "usual", M: "maiden", N: "nickname", B: "old", U: "temp", C: "usual", I: "usual", S: "anonymous", T: "temp" };

/** XPN → HumanName. */
function toHumanName(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  const family = s(rawComp(value, 1, ctx.compSep), 1) || g(value, 1);
  const given = [g(value, 2), g(value, 3)].filter(Boolean);
  const suffix = [g(value, 4), g(value, 6)].filter(Boolean);
  const prefix = g(value, 5);
  const use = XPN_USE[g(value, 7).toUpperCase()];
  if (!family && !given.length) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(family ? { family } : {}),
    ...(given.length ? { given } : {}),
    ...(prefix ? { prefix: [prefix] } : {}),
    ...(suffix.length ? { suffix } : {}),
  };
}

const XAD_USE = { H: "home", B: "work", O: "work", M: "home", C: "temp", BA: "old", BDL: "billing", P: "temp", RH: "home" };

/** XAD → Address. */
function toAddress(value, ctx) {
  const g = c(ctx);
  const s = sub(ctx);
  const streetRaw = rawComp(value, 1, ctx.compSep);
  const line = [s(streetRaw, 1) || unesc(streetRaw, ctx), g(value, 2)].filter(Boolean);
  const city = g(value, 3);
  const state = g(value, 4);
  const postalCode = g(value, 5);
  const country = g(value, 6);
  const use = XAD_USE[g(value, 7).toUpperCase()];
  const district = g(value, 9);
  if (!line.length && !city && !postalCode) return undefined;
  return {
    ...(use ? { use } : {}),
    ...(line.length ? { line } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
  };
}

const XTN_USE = { PRN: "home", ORN: "work", WPN: "work", VHN: "home", ASN: "temp", EMR: "temp", NET: "home", BPN: "mobile", PRS: "mobile" };
const XTN_SYSTEM = { PH: "phone", FX: "fax", CP: "phone", BP: "pager", MD: "phone", TDD: "other", TTY: "other", Internet: "email", "X.400": "email" };

/** XTN → ContactPoint. */
function toContactPoint(value, ctx, defaultUse) {
  const g = c(ctx);
  const email = g(value, 4);
  const useCode = g(value, 2).toUpperCase();
  const equip = g(value, 3);
  const use = XTN_USE[useCode] || defaultUse;
  if (email) return { system: "email", value: email, ...(use ? { use } : {}) };
  const number = g(value, 12) || g(value, 1) || [g(value, 6), g(value, 7)].filter(Boolean).join("");
  if (!number) return undefined;
  const system = XTN_SYSTEM[equip] || XTN_SYSTEM[equip?.toUpperCase()] || "phone";
  const mobile = equip?.toUpperCase() === "CP" || useCode === "BPN";
  return { system, value: number, ...(mobile ? { use: "mobile" } : use ? { use } : {}) };
}

// ─── Bundle builder ──────────────────────────────────────────────────────────

/** Stable urn:uuid from a logical key, so the same message always converts identically. */
function uuidFrom(key) {
  const h = createHash("sha1").update(key).digest("hex");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function makeBundle(messageControlId) {
  const entries = [];
  const keys = new Map();
  const warnings = [];
  const notes = [];

  /**
   * Add (or fetch) a resource under a logical key. Adding the same key twice
   * merges — that is how PID and PD1 land on one Patient.
   */
  function put(key, resourceType, build, searchUrl) {
    if (keys.has(key)) return keys.get(key);
    const fullUrl = uuidFrom(`${messageControlId}|${key}`);
    const entry = {
      fullUrl,
      resource: { resourceType, ...build },
      request: searchUrl
        ? { method: "PUT", url: searchUrl }
        : { method: "POST", url: resourceType },
    };
    entries.push(entry);
    const handle = { fullUrl, entry, resource: entry.resource, reference: { reference: fullUrl } };
    keys.set(key, handle);
    return handle;
  }

  return {
    entries,
    warnings,
    notes,
    put,
    get: (key) => keys.get(key),
    warn: (message) => { if (!warnings.includes(message)) warnings.push(message); },
    note: (message) => { if (!notes.includes(message)) notes.push(message); },
    bundle: (identifier, timestamp) => ({
      resourceType: "Bundle",
      ...(identifier ? { identifier: { value: identifier } } : {}),
      type: "transaction",
      ...(timestamp ? { timestamp } : {}),
      entry: entries,
    }),
  };
}

/** Search URL for a conditional update, or undefined when no identifier qualifies. */
const conditional = (type, identifier) =>
  identifier?.system && identifier?.value
    ? `${type}?identifier=${encodeURIComponent(identifier.system)}|${encodeURIComponent(identifier.value)}`
    : undefined;

// ─── Segment converters ──────────────────────────────────────────────────────

const GENDER = Object.fromEntries(CONCEPT_MAPS["0001"].map.map((m) => [m.code, m.fhir]));
const ENCOUNTER_CLASS = Object.fromEntries(CONCEPT_MAPS["0004"].map.filter((m) => m.fhir !== "(none)").map((m) => [m.code, m.fhir]));
const ENCOUNTER_PRIORITY = Object.fromEntries(CONCEPT_MAPS["0007"].map.map((m) => [m.code, m.fhir]));
const MARITAL = Object.fromEntries(CONCEPT_MAPS["0002"].map.map((m) => [m.code, m.fhir]));
const ORDER_STATUS = Object.fromEntries(CONCEPT_MAPS["0038"].map.map((m) => [m.code, m.fhir]));
const REPORT_STATUS = Object.fromEntries(CONCEPT_MAPS["0123"].map.map((m) => [m.code, m.fhir]));
const OBS_STATUS = Object.fromEntries(CONCEPT_MAPS["0085"].map.map((m) => [m.code, m.fhir]));
const REPORT_CATEGORY = { RAD: "imaging", LAB: "laboratory", CH: "laboratory", HM: "laboratory", MB: "laboratory", BB: "laboratory", CP: "laboratory", CT: "imaging", MR: "imaging", NM: "imaging", US: "imaging", XR: "imaging", CUS: "imaging", OT: "procedure" };

/** PID (+ optional PD1) → Patient. */
function buildPatient(pid, pd1, ctx, b) {
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
      ? { maritalStatus: { coding: [{ system: MARITAL[maritalCode] === "UNK" ? `${TERM}/v3-NullFlavor` : `${TERM}/v3-MaritalStatus`, code: MARITAL[maritalCode] }] } }
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
function practitionerRef(xcn, ctx, b) {
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
function locationRef(pl, ctx, b, keyPrefix) {
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
function buildEncounter(pv1, evn, patientRef, ctx, b, { key = "encounter", trigger = "" } = {}) {
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
      ? { hospitalization: { dischargeDisposition: { coding: [{ system: `${TERM}/v2-0112`, code: disposition }] } } }
      : {}),
  };
  if (!visitIdentifier) b.warn("PV1-19 (visit number) is empty, so the Encounter cannot be conditionally matched; it is created new on every conversion.");
  if (zonelessTime(admit) || zonelessTime(discharge)) {
    b.warn("An Encounter timestamp has a time but no timezone offset. The receiver will apply its own locale, shifting admissions across midnight at some sites.");
  }
  return b.put(key, "Encounter", resource, conditional("Encounter", visitIdentifier));
}

/** AL1 → AllergyIntolerance. */
function buildAllergy(al1, patientRef, ctx, b, n) {
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
function buildCondition(dg1, patientRef, encounter, ctx, b, n) {
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
function buildContact(nk1, patient, ctx, b) {
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
function buildSpecimen(spm, patientRef, ctx, b, n) {
  const g = c(ctx);
  const identifier = toIdentifier(rawComp(spm.f(2), 1, ctx.compSep) ? spm.f(2) : "", ctx, b.warn);
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
function observationValue(valueType, raw, units, ctx, b, location) {
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

/** A group of OBX rows (already merged if they were a repeating narrative) → Observation. */
function buildObservation(obx, patientRef, encounter, ctx, b, key, { fallbackEffective, category, mergedText } = {}) {
  const g = c(ctx);
  const code = toCodeableConcept(obx.f(3), ctx, b.warn);
  const statusCode = g(obx.f(11), 1).toUpperCase();
  const status = OBS_STATUS[statusCode];
  if (!status) {
    b.warn(`${key}: OBX-11 '${statusCode || "(empty)"}' is not in HL7 table 0085. Observation.status is required 1..1 — emitted as 'unknown'.`);
  }
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

  const value =
    mergedText !== undefined
      ? { valueString: mergedText }
      : observationValue(g(obx.f(2), 1), obx.f(5), obx.f(6), ctx, b, key);

  return b.put(key, "Observation", {
    status: status ?? "unknown",
    ...(category ? { category: [{ coding: [{ system: `${TERM}/observation-category`, code: category }] }] } : {}),
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
function buildServiceRequest(orc, obr, patientRef, encounter, ctx, b, key, notes) {
  const g = c(ctx);
  const placer = toIdentifier(orc?.f(2) || obr?.f(2) || "", ctx, b.warn);
  const filler = toIdentifier(orc?.f(3) || obr?.f(3) || "", ctx, b.warn);
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
function buildReport(obr, patientRef, encounter, ctx, b, key, { results, specimen, conclusion }) {
  const g = c(ctx);
  const filler = toIdentifier(obr.f(3), ctx, b.warn);
  const placer = toIdentifier(obr.f(2), ctx, b.warn);
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

// ─── Message converters ──────────────────────────────────────────────────────

const first = (segs, name) => segs.find((s) => s.name === name);
const all = (segs, name) => segs.filter((s) => s.name === name);

/** Split the order/result part of a message into ORC/OBR groups. */
function orderGroups(segs, startNames) {
  const groups = [];
  let g = null;
  for (const s of segs) {
    if (startNames.includes(s.name) && (s.name === "ORC" || !g || g.obr || s.name === "OBR")) {
      if (s.name === "ORC") {
        g = { orc: s, obr: null, obx: [], notes: [], spm: [], zds: [] };
        groups.push(g);
        continue;
      }
      if (s.name === "OBR") {
        if (g && !g.obr) g.obr = s;
        else {
          g = { orc: null, obr: s, obx: [], notes: [], spm: [], zds: [] };
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
  }
  return groups;
}

/** Merge consecutive narrative (TX/FT) OBX rows that share a code into one. */
function mergeNarrative(obxEntries, ctx) {
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

const noteText = (ntes, ctx) =>
  ntes
    .flatMap((n) => reps(n.f(3), ctx.repSep).map((r) => unesc(r, ctx)))
    .filter((t) => t.length)
    .join("\n");

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

/** ORM^O01 → transaction Bundle. */
function convertORM(segs, ctx, b) {
  const g = c(ctx);
  const pid = first(segs, "PID");
  if (!pid) throw new Error("ORM message has no PID segment; the order has no subject.");
  const { handle: patient } = buildPatient(pid, first(segs, "PD1"), ctx, b);
  const pv1 = first(segs, "PV1");
  const encounter = pv1 ? buildEncounter(pv1, first(segs, "EVN"), patient.reference, ctx, b) : null;

  const groups = orderGroups(segs, ["ORC", "OBR"]);
  if (!groups.length) throw new Error("ORM message has no ORC segment; there is no order to convert.");

  groups.forEach((group, i) => {
    const n = i + 1;
    const notes = [noteText(group.notes, ctx)].filter(Boolean);
    const request = buildServiceRequest(group.orc, group.obr, patient.reference, encounter, ctx, b, `servicerequest:${n}`, notes);

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

    mergeNarrative(group.obx, ctx).forEach((entry, j) => {
      const key = `observation:${n}:${j + 1}`;
      const obs = buildObservation(entry.obx, patient.reference, encounter, ctx, b, key, {
        category: "exam",
        mergedText: entry.narrative ? entry.lines.join("\n") : undefined,
      });
      obs.resource.basedOn = [request.reference];
      const text = noteText(entry.notes, ctx);
      if (text) obs.resource.note = [{ text }];
    });
    if (group.obx.length) {
      b.note("OBX rows inside an ORM are order-entry answers (weight, creatinine, LMP), not results. They are emitted with category=exam and basedOn the ServiceRequest — never category=laboratory, which would file them as results.");
    }
    if (!group.orc) b.warn(`Order ${n} has an OBR with no preceding ORC. Status and requester had to come from the OBR alone.`);
  });

  if (groups.length > 1) {
    b.note(`This ORM carried ${groups.length} ORC/OBR pairs, so the bundle holds ${groups.length} separate ServiceRequests — not one request with repeated codes.`);
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

/** Convert any supported message into a FHIR R4 transaction Bundle. */
function convert(message) {
  const { ctx, segs } = parse(message);
  const msh = segs[0];
  if (!msh || msh.name !== "MSH") throw new Error("Message does not begin with an MSH segment.");
  const g = c(ctx);
  const type = g(msh.f(9), 1).toUpperCase();
  const trigger = g(msh.f(9), 2).toUpperCase();
  const controlId = g(msh.f(10), 1);
  const version = g(msh.f(12), 1);
  const timestamp = toFhirDate(g(msh.f(7), 1));

  const b = makeBundle(controlId || "no-control-id");
  if (!controlId) {
    b.warn("MSH-10 (message control ID) is empty. Bundle identifiers and the urn:uuid keys are then unstable, so the same message will not convert idempotently.");
  }
  if (version && version !== "2.5.1") {
    b.warn(`MSH-12 declares version '${version}', not 2.5.1. The mappings still apply, but check the fields this server reads against that version before trusting the output.`);
  }
  const processing = g(msh.f(11), 1).toUpperCase();
  if (processing && processing !== "P") {
    b.warn(`MSH-11 processing ID is '${processing}' (not production). This bundle must not be posted to a production FHIR store.`);
  }
  if (zonelessTime(timestamp)) {
    b.warn("MSH-7 has a time with no timezone offset, but Bundle.timestamp is an instant, which requires one. The offset was left off — supply the sender's zone before posting.");
  }

  let result;
  const messageType = `${type}^${trigger}`;
  if (type === "ADT") result = convertADT(segs, ctx, b, trigger);
  else if (type === "ORM" || (type === "OMG" || type === "OML")) result = convertORM(segs, ctx, b);
  else if (type === "ORU") result = convertORU(segs, ctx, b);
  else throw new Error(`Message type '${messageType}' is out of scope. This server converts ORM, ADT and ORU messages.`);

  if (type === "ADT" && !MESSAGE_MAPS[messageType]) {
    b.warn(`ADT^${trigger} has no dedicated profile here; it was converted with the generic ADT rules (Patient + Encounter). Documented triggers: A01, A04, A08, A31, A40.`);
  }

  const bundle = b.bundle(controlId, timestamp && timestamp.includes("T") && !zonelessTime(timestamp) ? timestamp : undefined);
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

// ─── MCP Server ──────────────────────────────────────────────────────────────

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * Build a fully-registered server instance.
 * One McpServer per transport: an instance cannot be shared across concurrent
 * sessions, so each session gets its own.
 */
function createServer() {
  const server = new McpServer({ name: "hl7-v251-to-fhir", version: "1.0.0" });

  server.tool(
    "list_message_mappings",
    "List the HL7 v2.5.1 message types this server converts and the FHIR R4 resources each one produces.",
    {},
    async () =>
      json(
        Object.entries(MESSAGE_MAPS).map(([type, m]) => ({
          messageType: type,
          description: m.description,
          produces: m.produces,
          pitfallCount: m.pitfalls.length,
        }))
      )
  );

  server.tool(
    "get_message_mapping",
    "Get the full segment-to-resource plan for one HL7 v2.5.1 message type, including the known conversion pitfalls.",
    { messageType: z.string().describe("Message type and trigger, e.g. ORM^O01, ADT^A08, ORU^R01") },
    async ({ messageType }) => {
      const key = messageType.toUpperCase().replace(/[_ ]/g, "^");
      const m = MESSAGE_MAPS[key];
      if (!m) return fail(`No mapping for '${key}'. Available: ${Object.keys(MESSAGE_MAPS).join(", ")}`);
      return json({ messageType: key, fhirVersion: FHIR_VERSION, ...m });
    }
  );

  server.tool(
    "get_segment_mapping",
    "Get the field-by-field FHIR mapping for one HL7 v2.5.1 segment.",
    { segment: z.string().describe("Segment code, e.g. PID, PV1, ORC, OBR, OBX, MRG, SPM, ZDS") },
    async ({ segment }) => {
      const key = segment.toUpperCase();
      const m = SEGMENT_MAPS[key];
      if (!m) return fail(`No mapping for segment '${key}'. Available: ${Object.keys(SEGMENT_MAPS).join(", ")}`);
      return json({ segment: key, fhirVersion: FHIR_VERSION, ...m });
    }
  );

  server.tool(
    "get_field_mapping",
    "Get the FHIR target for one HL7 v2.5.1 field, e.g. PID-5 or OBR-25, with the datatype mapping that applies to it.",
    {
      segment: z.string().describe("Segment code, e.g. OBR"),
      field: z.number().int().positive().describe("Field sequence number, e.g. 25 for OBR-25"),
    },
    async ({ segment, field }) => {
      const key = segment.toUpperCase();
      const m = SEGMENT_MAPS[key];
      if (!m) return fail(`No mapping for segment '${key}'. Available: ${Object.keys(SEGMENT_MAPS).join(", ")}`);
      const f = m.fields.find((x) => x.seq === field);
      if (!f) {
        return fail(
          `${key}-${field} has no FHIR mapping in this server. Mapped fields for ${key}: ${m.fields.map((x) => x.seq).join(", ")}. An unmapped field is not necessarily unmappable — it may just have no agreed target.`
        );
      }
      return json({ location: `${key}-${field}`, resource: m.resource, ...f });
    }
  );

  server.tool(
    "get_datatype_mapping",
    "Get the component-by-component FHIR datatype mapping for an HL7 v2.5.1 datatype.",
    { datatype: z.string().describe("HL7 datatype, e.g. XPN, XAD, CX, XTN, CE, TS, XCN, HD, PL, EI, CQ, SN") },
    async ({ datatype }) => {
      const key = datatype.toUpperCase();
      const m = DATATYPE_MAPS[key];
      if (!m) return fail(`No mapping for datatype '${key}'. Available: ${Object.keys(DATATYPE_MAPS).join(", ")}`);
      return json({ datatype: key, ...m });
    }
  );

  server.tool(
    "lookup_concept_map",
    "Translate an HL7 v2.5.1 table value into its FHIR code, or list a whole table's ConceptMap.",
    {
      table: z.string().describe("HL7 table number as a string, e.g. '0001', '0004', '0085', '0123', '0125'"),
      code: z.string().optional().describe("Optional single v2 code to translate, e.g. 'F'"),
    },
    async ({ table, code }) => {
      const m = CONCEPT_MAPS[table];
      if (!m) return fail(`No ConceptMap for table '${table}'. Available: ${Object.keys(CONCEPT_MAPS).join(", ")}`);
      if (!code) return json({ table, ...m });
      const hit = m.map.find((x) => x.code.toUpperCase() === code.toUpperCase());
      if (!hit) {
        return fail(
          `'${code}' is not in table ${table} (${m.name}). Valid codes: ${m.map.map((x) => x.code).join(", ")}. A value outside the table should be flagged, not mapped to a plausible neighbour.`
        );
      }
      return json({ table, name: m.name, target: m.target, ...hit });
    }
  );

  server.tool(
    "which_v2_fields_feed",
    "Reverse lookup: given a FHIR resource type, list every HL7 v2.5.1 field this server maps into it.",
    { resourceType: z.string().describe("FHIR R4 resource type, e.g. Patient, Encounter, ServiceRequest, DiagnosticReport, Observation") },
    async ({ resourceType }) => {
      const needle = resourceType.toLowerCase();
      const hits = [];
      for (const [seg, m] of Object.entries(SEGMENT_MAPS)) {
        for (const f of m.fields) {
          if (f.path.toLowerCase().includes(needle)) {
            hits.push({ location: `${seg}-${f.seq}`, name: f.name, path: f.path, ...(f.note ? { note: f.note } : {}) });
          }
        }
      }
      if (!hits.length) return fail(`Nothing in this server maps into '${resourceType}'. Mapped resources: ${[...new Set(Object.values(SEGMENT_MAPS).map((m) => m.resource))].join("; ")}`);
      return json({ resourceType, fieldCount: hits.length, fields: hits });
    }
  );

  server.tool(
    "convert_datetime",
    "Convert an HL7 v2.5.1 TS/DTM value to a FHIR date or dateTime, preserving the source precision.",
    { value: z.string().describe("HL7 timestamp, e.g. 20250901143000-0500") },
    async ({ value }) => {
      const out = toFhirDate(value.trim());
      if (!out) return fail(`'${value}' is not a valid HL7 TS. Expected YYYY[MM[DD[HH[MM[SS[.SSSS]]]]]][+/-ZZZZ].`);
      return json({
        source: value.trim(),
        fhir: out,
        fhirType: out.includes("T") ? "dateTime" : out.length === 10 ? "date" : "date (reduced precision)",
        ...(zonelessTime(out)
          ? { warning: "The source has a time but no timezone offset. FHIR instant requires one, and dateTime requires one whenever seconds are present — the receiver will otherwise apply its own locale." }
          : {}),
      });
    }
  );

  server.tool(
    "convert_message",
    "Convert a full HL7 v2.5.1 ORM, ADT or ORU message into a FHIR R4 transaction Bundle, with warnings for everything that could not be mapped faithfully.",
    {
      message: z.string().describe("HL7 message text (pipe-delimited). An MLLP wrapper is stripped automatically."),
      include: z
        .enum(["bundle", "summary", "both"])
        .optional()
        .describe("bundle = the Bundle only; summary = counts, warnings and notes only; both (default) = everything."),
    },
    async ({ message, include = "both" }) => {
      let result;
      try {
        result = convert(message);
      } catch (err) {
        return fail(`Conversion failed: ${err.message}`);
      }
      const summary = {
        messageType: result.messageType,
        fhirVersion: result.fhirVersion,
        resourceCounts: result.resourceCounts,
        warnings: result.warnings,
        notes: result.notes,
      };
      if (include === "summary") return json(summary);
      if (include === "bundle") return json(result.bundle);
      return json({ ...summary, bundle: result.bundle });
    }
  );

  return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

// ─── Bind + auth ─────────────────────────────────────────────────────────────
// Default: loopback only, no auth required (local Claude Desktop / Cursor).
// Non-loopback binds (0.0.0.0, LAN, cloud) REQUIRE API_KEY — otherwise refuse
// to start. Remote hosts are lab/synthetic data only; never expose without auth.

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_KEY = process.env.API_KEY || process.env.MCP_API_KEY || "";

function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

if (!isLoopbackHost(HOST) && !API_KEY) {
  console.error(
    `Refusing to bind to non-loopback HOST=${HOST} without API_KEY (or MCP_API_KEY).\n` +
      `Set HOST=127.0.0.1 for local use, or set API_KEY and send Authorization: Bearer <key>\n` +
      `(or X-API-Key) when deploying remotely. Remote deployments are for lab/synthetic data only.`
  );
  process.exit(1);
}

function requireAuth(req, res, next) {
  if (req.path === "/health") return next();
  if (!API_KEY) return next();
  const hdr = req.headers.authorization || "";
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  const key = bearer || String(req.headers["x-api-key"] || "").trim();
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized — send Authorization: Bearer <API_KEY> or X-API-Key" },
      id: null,
    });
  }
  next();
}

const app = express();
app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] })); // local MCP clients; remote use MUST set API_KEY
app.use(express.json({ limit: "8mb" }));
app.use(requireAuth);

/** sessionId -> { server, transport } */
const sessions = new Map();

const notFound = (res) =>
  res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found or expired. Re-initialize with POST /mcp." },
    id: null,
  });

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return notFound(res);
      return await entry.transport.handleRequest(req, res, req.body);
    }

    // No session header — this is an initialize request. Give it its own
    // server instance; a single McpServer cannot back concurrent transports.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { server, transport }),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("POST /mcp failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const entry = sessions.get(req.headers["mcp-session-id"]);
  if (!entry) return notFound(res);
  try {
    await entry.transport.handleRequest(req, res);
  } catch (err) {
    console.error("GET /mcp failed:", err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const entry = sessions.get(sessionId);
  if (!entry) return notFound(res);
  try {
    await entry.transport.handleRequest(req, res);
  } catch (err) {
    console.error("DELETE /mcp failed:", err);
    if (!res.headersSent) res.status(500).end();
  } finally {
    sessions.delete(sessionId);
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", server: "hl7-v251-to-fhir", fhirVersion: FHIR_VERSION }));

app.listen(PORT, HOST, () => {
  const where = isLoopbackHost(HOST) ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`HL7 v2.5.1 → FHIR MCP server listening on ${where}/mcp (bind ${HOST})`);
  console.log(`Health check: ${where}/health`);
  if (API_KEY) console.log("API key auth enabled (Authorization: Bearer or X-API-Key)");
  else console.log("No API_KEY set — acceptable only because HOST is loopback");
});

export { convert, toFhirDate, parse, SEGMENT_MAPS, MESSAGE_MAPS, DATATYPE_MAPS, CONCEPT_MAPS };
