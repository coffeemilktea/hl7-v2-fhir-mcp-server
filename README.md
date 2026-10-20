# HL7 v2.5.1 → FHIR R4 Mapping MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the HL7 v2.5.1 → FHIR R4
crossing. It answers *what does this v2 field become in FHIR?* at message, segment, field, data type
and code level, and converts whole messages into a FHIR R4 transaction Bundle with a warning for
every value it could not map faithfully.

| | |
|---|---|
| **Transports** | stdio (default) and Streamable HTTP |
| **Source** | HL7 v2.5.1 |
| **Target** | FHIR R4 (4.0.1) |
| **Runtime** | Node.js 20+ |
| **License** | MIT (data sources are listed in [NOTICE](NOTICE)) |

> **Companion server:** [hl7-v2-mcp-server](https://github.com/coffeemilktea/hl7-v2-mcp-server)
> answers *what does this segment mean in v2.5.1*. Both servers share its
> [`hl7v2-core`](https://github.com/coffeemilktea/hl7-v2-mcp-server/tree/main/core) package, so they
> parse messages the same way and agree on every v2.5.1 field, data type and code.

## Two sources, labelled separately

Every mapping tool answers from two places and never mixes them:

- **server**: this server's curated rules. They are what `convert_message` does.
- **ig**: the rows of the official [HL7 Version 2 to FHIR IG](https://hl7.org/fhir/uv/v2mappings/)
  (1.0.0 STU1), imported from [HL7/v2-to-fhir](https://github.com/HL7/v2-to-fhir) at a pinned commit.

The IG is written against later v2 versions, so each IG row is checked against v2.5.1. A row that
names a field or component v2.5.1 doesn't define is flagged `inV251: false` with the reason (461
of 2,524 segment rows, for example PID-40). Each IG code row carries its v2.5.1 status (`valid`,
`not-in-2.5.1` or `unverified`).

Where the server's code translations deliberately differ from the IG, `compare_with_ig` says so
code by code:

| Table | Server → FHIR | IG → FHIR |
|---|---|---|
| 0001 | N → `unknown` | N → `other` |
| 0004 | R, C → `AMB`; B → `IMP`; N, U → no class (warned) | B, C, N, R, U keep the v2-0004 code |
| 0007 | A, E → `EM`; C → `EL`; L, N → `R`; U → `UR` (v3 ActPriority) | keeps the v2-0007 code |
| 0085 | I → `registered`; R, S → `preliminary`; U → `final` | no target |
| 0119 | CA → `revoked`; HD → `on-hold`; XO, XX, SC, SN → `active`; RP → `revoked` | CA, HD → `active`; others no target |
| 0123 | A → `partial`; R → `preliminary`; Y → `entered-in-error`; Z → `unknown` | R → `partial`; A, Y, Z no target |

The server's reason for each choice is in its per-code note, which `compare_with_ig` returns as
`serverNote`.

Table 0002 (Marital Status) now matches the IG exactly.

## What's covered

| | v1 | v2 |
|---|---|---|
| Message conversions | ADT A01/A04/A08/A31/A40, ORM^O01, ORU^R01 | + **SIU** (S12–S24, S26), **MDM** (T01–T11), **OML^O21**, **OMI^O23** |
| Curated segment maps | 15 segments, 132 fields | 23 segments, 170 fields |
| Curated data type maps | 16 | 17 (adds CWE) |
| Curated ConceptMaps | 13 tables, 130 codes | 13 tables, 137 codes (0002 rebuilt with all 16 v2.5.1 codes) |
| IG reference data | — | 13 message maps, 75 segment maps, 105 data type maps, 99 ConceptMaps |
| Tools / resources | 9 / 0 | 10 / 5 |
| FHIR validator (R4, no tx server) | ORU fails (2 errors) | 13 sample bundles, **0 errors** (run in the test suite) |

## Quick start

### Claude Code

```bash
claude mcp add hl7-fhir -- npx -y hl7-v2-fhir-mcp-server
```

Or add it to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hl7-fhir": { "command": "npx", "args": ["-y", "hl7-v2-fhir-mcp-server"] }
  }
}
```

### Claude Desktop, Cursor and other stdio clients

```json
{
  "mcpServers": {
    "hl7-fhir": { "command": "npx", "args": ["-y", "hl7-v2-fhir-mcp-server"] }
  }
}
```

The Claude Desktop config is at `~/Library/Application Support/Claude/claude_desktop_config.json`
(Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Over HTTP

```bash
npx hl7-v2-fhir-mcp-server --http          # http://localhost:3001/mcp
# or from a clone: npm install && npm start
claude mcp add --transport http hl7-fhir http://localhost:3001/mcp
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port (`--port`) |
| `HOST` | `127.0.0.1` | Bind address (`--host`). A non-loopback address requires `API_KEY`. |
| `API_KEY` / `MCP_API_KEY` | _(unset)_ | Clients send `Authorization: Bearer <key>` or `X-API-Key`. Compared in constant time. |
| `ALLOWED_HOSTS` | _(loopback)_ | Extra `Host` header names to accept (DNS-rebinding protection). |
| `ALLOWED_ORIGINS` | _(none)_ | Browser origins allowed through CORS. No CORS headers are sent by default. |
| `SESSION_IDLE_MS` | `1800000` | Idle sessions are closed after this many milliseconds (30 minutes). |
| `MAX_SESSIONS` | `100` | Cap on concurrent sessions. |
| `MAX_BODY` | `4mb` | Request body limit. |
| `HL7_MCP_MAX_OUTPUT_CHARS` | `60000` | Larger tool results return an error that explains how to narrow the request. |

`/health` returns the server name and version. `node server.js` still starts the HTTP server on
port 3001, as it did in v1.

## Tools

All tools are read-only, return `structuredContent` matching a published output schema, and accept
lenient input (`"25"` or `25`; table `2` or `0002`; `siu_s12`, `SIU^S12`).

| Tool | What it does |
|---|---|
| `list_message_mappings` | Message types the server converts (and the triggers each covers), plus the IG's message maps. |
| `get_message_mapping` | Segment-to-resource plan and pitfalls for one message type; the IG message map alongside. `SIU^S13` resolves to the `SIU^S12` plan. |
| `get_segment_mapping` | Field-by-field targets for a segment: the server's rules and the IG rows (paginated, flagged against v2.5.1). |
| `get_field_mapping` | One field: its v2.5.1 definition, the server's rule and the IG rows. |
| `get_datatype_mapping` | Component mapping for a data type. `igMap` picks one IG map (CWE has 14). |
| `lookup_concept_map` | Translate a table value: server target, IG target, whether they differ, and the code's v2.5.1 status. |
| `compare_with_ig` | **New.** Every place the server's ConceptMaps differ from the IG, as a summary or code by code. |
| `which_v2_fields_feed` | Reverse lookup from a FHIR resource type. Matches whole names (`Observation` no longer matches `ObservationDefinition`). |
| `convert_datetime` | HL7 TS → FHIR date/dateTime, keeping the source precision and flagging a missing offset. |
| `convert_message` | A whole message → FHIR R4 transaction Bundle, with warnings and notes. `include=summary` returns counts and warnings only. |

Resources: `fhirmap://segment/{code}`, `fhirmap://datatype/{code}`, `fhirmap://conceptmap/{table}`,
`fhirmap://message/{type}`, `fhirmap://about`.

## What each message becomes

| Message | Resources emitted | The part that goes wrong |
|---|---|---|
| `ADT^A01` / `A04` | Patient, Encounter, Location chain, Practitioner, Condition, AllergyIntolerance | `Encounter.class` is 1..1 in R4. A PV1-2 of `U` makes a conformant Encounter impossible, so the server emits `UNK` and warns rather than defaulting to ambulatory. |
| `ADT^A08` | Patient, Encounter, Condition, AllergyIntolerance | A08 is a **snapshot**, but most pipelines treat it as a patch, so a field the sender cleared never clears downstream. |
| `ADT^A31` | Patient only | Person-level, so **no Encounter**, even when the sender includes a PV1. |
| `ADT^A40` | Patient (survivor) + Patient (retired, `active=false`) | PID survives, MRG-1 is retired with `link.type=replaced-by`. Reversing it is silent. |
| `ORM^O01`, `OML^O21`, `OMI^O23` | ServiceRequest, Patient, Encounter, Practitioner, Observation, Specimen (SPM), ImagingStudy (ZDS or IPC) | One message can carry several orders: N ServiceRequests. OBX in an order is supporting information (`category=exam`, `ServiceRequest.supportingInfo`), never a result. TQ1-9 priority uses the IG map for table 0485. OMI's IPC-3 becomes the ImagingStudy UID and IPC-1 an `ACSN` identifier. |
| `ORU^R01` | DiagnosticReport, Observation, Patient, Encounter, Specimen, Practitioner, ImagingStudy | Repeating narrative TX rows are one report. Vital-sign LOINCs get `category=vital-signs`, as the R4 vital-signs profiles require. |
| `SIU^S12`…`S26` | Appointment, Patient, Encounter, Practitioner, Location | `start`/`end` are instants, so a time without an offset can't be used. SCH-25 goes through the IG map for table 0278 (mixed case in v2.5.1: `Booked`, `Noshow`). v2.5.1 has no participant status, which R4 requires: it is data-absent unless you pass `participantStatus`. |
| `MDM^T01`…`T11` | DocumentReference, Patient, Encounter, Practitioner, ServiceRequest | TXA-12 is the document's identity across updates. TXA-19 (table 0273) sets `status`. TXA-17 has no published map to `docStatus`, so it is reported, not guessed. T06 and T10 set `relatesTo` (appends/replaces) from TXA-13. |

### Where the status fields go

| Source | Table | FHIR element |
|---|---|---|
| OBR-25 | 0123 | `DiagnosticReport.status` |
| OBX-11 | 0085 | `Observation.status` |
| ORC-5 | 0038 | `ServiceRequest.status` |
| ORC-1 | 0119 | (create / update / cancel — a verb, not a state) |
| SCH-25 | 0278 | `Appointment.status` (IG ConceptMap) |
| TXA-19 | 0273 | `DocumentReference.status` (IG) |

## Rules the converter holds to

| Rule | Why |
|---|---|
| **No invented systems** | An assigning authority with no universal ID becomes `urn:id:<namespace>` and a warning, never a fabricated `http://` URI. `HL7nnnn` coding systems resolve to the THO `v2-nnnn` code system; user-defined tables with no THO code system (e.g. 0112) get no system and a warning. |
| **No invented codes** | A value outside its table is warned about and left out. Where R4 requires an element v2.5.1 can't supply (Appointment.participant.status, DocumentReference.status), the server emits a `data-absent-reason` extension and warns. |
| **Precision is preserved** | `19800115` is a `date`; `202501` stays `2025-01`. |
| **Timezones are never assumed** | A TS with a time and no offset is converted without one and flagged; it is never used for an `instant`. |
| **Idempotent output** | `fullUrl`s come from MSH-10 and the resource's logical key, so the same message always gives the same bundle. |
| **Escapes are reversed** | HL7 escapes are decoded by the shared `hl7v2-core` parser. |
| **OBX-2 decides value[x]** | NM → `valueQuantity`, SN → Quantity/Range/Ratio, CE → `valueCodeableConcept`. CWE and IS in OBX-2 are converted but labelled as non-v2.5.1 value types. |

## Example prompts

```text
"Where does OBR-25 go in FHIR, and does the IG agree?"        → get_field_mapping, lookup_concept_map
"DiagnosticReport.effectiveDateTime is empty. Which field?"    → which_v2_fields_feed
"Where does this server differ from the HL7 v2-to-FHIR IG?"   → compare_with_ig
"Convert this SIU^S12 to an Appointment."                      → convert_message
"Will this MDM^T02 convert cleanly?"                           → convert_message(include="summary")
"How does CWE map to a CodeableConcept in the IG?"             → get_datatype_mapping(datatype="CWE", igMap="CodeableConcept")
```

## Development

```bash
# hl7v2-core lives in the companion repo; clone both side by side until it is published
git clone https://github.com/coffeemilktea/hl7-v2-mcp-server
git clone https://github.com/coffeemilktea/hl7-v2-fhir-mcp-server
cd hl7-v2-fhir-mcp-server && npm install
npm test                                            # unit, MCP, HTTP security, stdio
FHIR_VALIDATOR_JAR=/path/to/validator_cli.jar npm test   # also runs the HL7 FHIR validator (needs Java 17+)
npm run import-ig                                   # rebuild data/ig from HL7/v2-to-fhir at the pinned commit
```

The layout:

- `src/maps.js`: the curated mapping rules.
- `src/ig.js`, `data/ig/`: the IG reference data and the v2.5.1 checks on it.
- `src/convert/`: the converters (`messages`, `orders`, `scheduling`, `documents`, `segments`, `datatypes`, `bundle`).
- `src/tools/`, `src/resources.js`, `src/server.js`: the MCP surface.
- `src/transport/`, `bin/cli.js`: stdio and HTTP.

## Remote deployment (synthetic or de-identified data only)

Don't expose the server without authentication. If you bind a non-loopback `HOST` without an
`API_KEY`, the server refuses to start.

```bash
HOST=0.0.0.0 API_KEY="$(openssl rand -hex 32)" ALLOWED_HOSTS=fhir.example.org npx hl7-v2-fhir-mcp-server --http
```

The server accepts whatever message you POST. Treat remote instances as lab or synthetic-data
playgrounds, never as a place to send real PHI.

## Related

- [hl7-v2-mcp-server](https://github.com/coffeemilktea/hl7-v2-mcp-server): the companion HL7 v2.5.1 reference server
- [coffeemilktea.github.io](https://coffeemilktea.github.io/): browser-based healthcare IT tools
- [hl7-dicom-tools](https://github.com/coffeemilktea/hl7-dicom-tools): DICOM and HL7 v2 browser tools

HL7® and FHIR® are registered trademarks of Health Level Seven International. This project isn't
affiliated with or endorsed by HL7 International. MIT licensed; see [LICENSE](LICENSE) and
[NOTICE](NOTICE).
