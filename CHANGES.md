# Changes

## 2.0.0 (unreleased, branch `buildout`)

### Fixes from the review

- **Table 0002 (Marital Status)** was built from v3 codes as if they were v2 codes (v2 `A` = Separated was sent as v3 `A` = Annulled; `L` is not a v2.5.1 code; N, C, G, R, E, I, B, O were missing). Rebuilt with all 16 v2.5.1 codes as mapped by the IG ConceptMap `table-hl70002-to-v3-maritalstatus`; U, O and T go to v3-NullFlavor (UNK, OTH, NAVU). An out-of-table PID-16 now warns.
- **CE component 9** removed (CE has 6 components in v2.5.1). A CWE map was added (9 components; CWE.9 Original Text → `CodeableConcept.text`, which the converter now uses).
- **PD1-6 "Organ Donor Code"** corrected to **PD1-8** (PD1-6 is Handicap).
- **ORU vital signs failed the FHIR validator** (no `Observation.category`). Observations whose OBX-3 is an R4 vital-sign LOINC now get `category=vital-signs` (alongside the OBR-24 category), and a missing OBX-14 on a vital sign is warned about.
- **`which_v2_fields_feed`** matched substrings ("Observation" hit "ObservationDefinition"); it now matches whole resource names.
- Also found while refactoring:
  - EI identifiers (ORC-2/3, OBR-2/3) were read as CX, so the namespace in EI-2 was lost. They now resolve `Identifier.system` like HD. SPM-2 is read as EIP (placer/filler subcomponents).
  - PV1-36 cited `http://terminology.hl7.org/CodeSystem/v2-0112`, which does not exist in HL7 Terminology; it is now emitted without a system, with a warning.
  - `HL7nnnn` coding systems (table 0396) resolve to the THO `v2-nnnn` code system instead of `urn:id:HL7nnnn`.
  - The CE map note said CWE "arrives in v2.7"; CWE is defined in v2.5.1.
  - Table 0125 entries CWE and IS are labelled as not v2.5.1 value types (added in v2.6 and v2.7).

### HL7 v2-to-FHIR IG as reference data

- `scripts/import-ig.mjs` imports the IG source spreadsheets from HL7/v2-to-fhir at a pinned commit (`873b331`, 2025-10-07) into `data/ig/`: 13 message maps, 75 segment maps (2,524 rows), 105 data type maps (1,078 rows), 99 ConceptMaps (5,253 rows).
- Licences recorded in `data/ig/meta.json` and NOTICE: repository Apache-2.0, IG package CC0-1.0.
- Every IG row is checked against v2.5.1 (`inV251`, with the reason when false) and every IG code row carries its v2.5.1 status. The IG never drives conversion.
- The mapping tools return `server` and `ig` sections side by side; new `compare_with_ig` lists every divergence (0001, 0004, 0007, 0085, 0119, 0123; 0002 now matches).

### New conversions

- **SIU^S12** (and S13–S24, S26, which share SIU_S12) → Appointment, Patient, Encounter, Practitioner, Location. SCH-25 via the IG ConceptMap for table 0278; TQ1-7/8 (or SCH-11) → start/end, only as instants with offsets; SCH-9/10 → minutesDuration when in minutes; AIS/AIG/AIL/AIP → serviceType and participants; SCH-26/27 → basedOn. S15/S26 imply cancelled/noshow when SCH-25 is empty. Participant status has no v2.5.1 source: data-absent by default, or the caller's `participantStatus`.
- **MDM^T01–T11** → DocumentReference. TXA-12 → masterIdentifier, TXA-19 → status (IG), TXA-18 → securityLabel (IG), TXA-2 → type, TXA-6 → date, TXA-9/10 → author/authenticator, TXA-13 → relatesTo for T06 (appends) and T10 (replaces). OBX TX/FT/ED/RP → content as in the IG (TX uses `text/plain`, not the IG's unregistered `application/text`). TXA-17 is reported, not mapped (no published ConceptMap).
- **OML^O21** and **OMI^O23** share the order converter with ORM: SPM → Specimen linked from `ServiceRequest.specimen`; TQ1 → priority (IG map for 0485) and occurrencePeriod; IPC → ImagingStudy (Study Instance UID, DICOM modality) and an ACSN accession identifier. Order OBX now link through `ServiceRequest.supportingInfo` (as in the IG) instead of `Observation.basedOn`.

### Server

- Split into `src/maps.js`, `src/ig.js`, `src/convert/*`, `src/tools/*`, `src/resources.js`, `src/transport/*`; parsing comes from the shared `hl7v2-core` package.
- stdio transport by default (`bin/cli.js`, so `npx hl7-v2-fhir-mcp-server` works once published); `--http` for Streamable HTTP on port 3001. `node server.js` still starts HTTP.
- HTTP hardening: Host-header validation (DNS rebinding), Origin checks, no CORS unless `ALLOWED_ORIGINS`, idle-session expiry and a session cap, constant-time API-key comparison, JSON-RPC errors for bad bodies.
- `registerTool` with titles, read-only annotations and output schemas; `structuredContent` on every result; lenient inputs; output cap (`HL7_MCP_MAX_OUTPUT_CHARS`) with a hint; pagination for IG rows.
- Resources: `fhirmap://segment/{code}`, `datatype/{code}`, `conceptmap/{table}`, `message/{type}`, `about`.
- SDK 1.32.1, express 5, zod 3.25; Node 20+; lockfile committed.

### Coverage

| | v1 | v2 |
|---|---|---|
| Message conversions | ADT (5 triggers), ORM^O01, ORU^R01 | + SIU (14 triggers), MDM (11), OML^O21, OMI^O23 |
| Curated segment maps | 15 segments / 132 fields | 23 / 170 |
| Curated data type maps | 16 | 17 |
| Curated ConceptMaps | 13 tables / 130 codes | 13 / 137 |
| IG reference data | none | 13 + 75 + 105 + 99 maps |
| Tools / resources | 9 / 0 | 10 / 5 |
| Tests | 0 | 62 (including the HL7 FHIR validator on 13 bundles: 0 errors) |

### Breaking changes

- Default transport is stdio; use `--http` (or `node server.js`) for HTTP.
- No CORS headers by default; set `ALLOWED_ORIGINS` for browser clients.
- Tool results now include `server` / `ig` sections; `get_field_mapping` returns a result (with the v2.5.1 definition and IG rows) for fields the server does not map, instead of an error.
- Order OBX use `ServiceRequest.supportingInfo` instead of `Observation.basedOn`.
- Requires the `hl7v2-core` package. Until it is published the dependency is `file:../hl7-v2-mcp-server/core`; switch to `^1.0.0` after publishing.
