# HL7 v2.5.1 → FHIR R4 Mapping MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the crossing between the two
standards that actually carry an order end to end. It answers **what does this v2 field become in
FHIR R4** at field, datatype and code-value level, and it converts whole **ORM, ADT and ORU**
messages into a FHIR **transaction Bundle** — with a warning for every value it could not map
faithfully, rather than a plausible guess.

| | |
|---|---|
| **Protocol** | MCP Streamable HTTP |
| **Source** | HL7 v2.5.1 |
| **Target** | FHIR R4 (4.0.1) |
| **Runtime** | Node.js 18+ |
| **License** | MIT |

> **What this is not:** a certified conversion engine. The output is a syntactically valid R4
> transaction Bundle built from one message in isolation — it has no patient index, no identifier
> registry and no memory of earlier messages. Assigning authorities that carry no universal ID come
> out as `urn:id:` placeholders, and every one of them is reported in `warnings`. Resolve those
> against your own registry before anything reaches a shared store.

> **Companion server:** [hl7-v2-mcp-server](https://github.com/coffeemilktea/hl7-v2-mcp-server)
> answers *what does this segment mean* against the v2.5.1 standard. This one answers *what does it
> become in R4*. The default port here is 3001, chosen so both can run at once.

---

## Quick start

```bash
git clone https://github.com/coffeemilktea/hl7-v2-fhir-mcp-server.git
cd hl7-v2-fhir-mcp-server
npm install
npm start
# HL7 v2.5.1 → FHIR MCP server listening on http://localhost:3001/mcp
```

### Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows). The two servers complement each other — run
both:

```json
{
  "mcpServers": {
    "hl7-reference": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "hl7-to-fhir": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Restart Claude Desktop. The nine tools appear in the tool panel.

### Add to Claude Code

In your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "hl7-to-fhir": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port the server listens on |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback requires `API_KEY`. |
| `API_KEY` | _(unset)_ | Bearer / X-API-Key secret. Required when `HOST` is not loopback. |

A health check is served at `/health`.

---

## Tools

Nine tools: six that explain the mapping, three that perform it.

| Tool | Parameters | What it does |
|---|---|---|
| `list_message_mappings` | — | Every message type the server converts, the FHIR resources each produces, and how many documented pitfalls it carries. |
| `get_message_mapping` | `messageType` | The full segment-to-resource plan for one message type, including the pitfalls that make that message different from its neighbours. |
| `get_segment_mapping` | `segment` | Field-by-field FHIR targets for one segment — PID, PV1, ORC, OBR, OBX, MRG, SPM, NTE, AL1, DG1, NK1, PD1, EVN, MSH, ZDS. |
| `get_field_mapping` | `segment`, `field` | One field, e.g. OBR-25 or PID-5, with the FHIR element it feeds and the caveat attached to it. |
| `get_datatype_mapping` | `datatype` | Component-level mapping for a v2 datatype — XPN, XAD, CX, XTN, CE, TS, XCN, HD, PL, EI, CQ, SN and the primitives. |
| `lookup_concept_map` | `table`, `code?` | Translate a v2 table value to its FHIR code, or list a whole table. Tables 0001, 0002, 0004, 0007, 0038, 0078, 0085, 0119, 0123, 0125, 0136, 0203, 0396. |
| `which_v2_fields_feed` | `resourceType` | Reverse lookup. Name a FHIR resource and get every v2 field that lands in it — the question you actually have when a FHIR element is empty and you need to know which segment failed you. |
| `convert_datetime` | `value` | HL7 TS to FHIR date/dateTime, preserving the source precision instead of padding it, and flagging a time sent with no timezone offset. |
| `convert_message` | `message`, `include?` | A whole ORM, ADT or ORU message to a FHIR R4 transaction Bundle, plus the warnings and notes the conversion generated. Ask for the bundle, the summary, or both. |

---

## What each message becomes

Conversion is a transaction Bundle. Resources with a usable business identifier get a conditional
`PUT` so a replayed message updates rather than duplicates; resources without one fall back to
`POST`, and the missing identifier is reported as a warning.

| Message | Resources emitted | The part that goes wrong |
|---|---|---|
| `ORM^O01` | ServiceRequest, Patient, Encounter, Practitioner, Location, Observation, ImagingStudy | One ORM can carry several ORC/OBR pairs — that is **N ServiceRequests**, not one with repeated codes. And OBX inside an ORM is an order-entry answer, not a result: it is emitted with `category=exam` and `basedOn` the request, never `laboratory`. |
| `ADT^A01` / `A04` | Patient, Encounter, Location chain, Practitioner, Condition, AllergyIntolerance | `Encounter.class` is 1..1 in R4. A PV1-2 of `U` makes a conformant Encounter impossible, so the server emits `UNK` and warns rather than quietly defaulting to ambulatory. |
| `ADT^A08` | Patient, Encounter, Condition, AllergyIntolerance | A08 is a **snapshot**, but most pipelines treat it as a patch, so a field the sender cleared never clears downstream. A changed MRN in an A08 is an unannounced merge, not an update. |
| `ADT^A31` | Patient only | Person-level, so there is **no Encounter** — even when the sender includes a PV1. Emitting one anyway, because the A08 converter always does, is the classic A31 bug; the server warns instead. |
| `ADT^A40` | Patient (survivor) + Patient (retired, `active=false`) | PID survives, MRG-1 is retired with `link.type=replaced-by`. The direction is reversible and reversing it is **silent** — the wrong chart is retired and the bundle still validates. |
| `ORU^R01` | DiagnosticReport, Observation, Patient, Encounter, Specimen, Practitioner, ImagingStudy | A radiology narrative arrives as dozens of repeating TX rows. They are **one report**: the server joins consecutive narrative OBX rows sharing a code into a single Observation, in line order, and repeats the text in `DiagnosticReport.conclusion`. |

### Where the two status fields go

The most common conversion defect in an ORU is copying one status onto the other. They come from
different fields, use different tables, and legitimately differ — a final report can contain a
corrected line.

| Source | Table | FHIR element |
|---|---|---|
| OBR-25 | 0123 | `DiagnosticReport.status` |
| OBX-11 | 0085 | `Observation.status` |
| ORC-5 | 0038 | `ServiceRequest.status` |
| ORC-1 | 0119 | (create / update / cancel — a verb, not a state) |

---

## Rules the converter holds to

Every one of these is a place where a conversion can look successful and be wrong. The server's
position on each is fixed, and departures are reported rather than absorbed.

| Rule | Why |
|---|---|
| **No invented systems** | An assigning authority with no universal ID becomes `urn:id:<namespace>` and a warning — never a fabricated `http://` URI. Two hospitals' local codes sharing one system URI silently merges two code systems. |
| **Precision is preserved** | `19800115` is a `date`; `202501` stays `2025-01`. Padding a partial timestamp to midnight invents a time the sender never asserted. |
| **Timezones are never assumed** | A TS with a time and no offset is converted without one and flagged. Applying the receiver's locale is what shifts admissions across midnight between sites. |
| **Out-of-table codes fail loudly** | A PID-8 that is not in table 0001 leaves `Patient.gender` absent rather than mapping to the nearest plausible neighbour. |
| **Idempotent output** | `fullUrl`s are derived from MSH-10 and the resource's logical key, so converting the same message twice produces byte-identical bundles — diffable in a test suite. |
| **Escapes are reversed** | `\F\`, `\S\`, `\T\`, `\R\`, `\E\`, `\X..\` and `\.br\` are decoded before the text reaches FHIR. A FHIR string containing `\.br\` is a conversion that stopped halfway. |
| **OBX-2 decides value[x]** | NM becomes `valueQuantity`, SN becomes Quantity, Range or Ratio depending on its separator, CE becomes `valueCodeableConcept`. An NM that is not numeric falls back to `valueString` with a warning instead of being dropped. |
| **ED and RP are not values** | Encapsulated data and reference pointers belong in `presentedForm` or an ImagingStudy. The raw value is kept as a string for review and flagged, not filed as a result. |

---

## Example prompts

Once connected, you can ask Claude questions like:

```text
# Field-level mapping
"Where does OBR-25 go in FHIR?"
  → get_field_mapping(segment="OBR", field=25)

# Reverse lookup — the question you have at 2am
"DiagnosticReport.effectiveDateTime is empty. Which v2 field feeds it?"
  → which_v2_fields_feed(resourceType="DiagnosticReport")

# Code translation
"What does patient class 'B' become in Encounter.class?"
  → lookup_concept_map(table="0004", code="B")

# Whole-message conversion
"Convert this ORU to FHIR and tell me what didn't map cleanly."
  → convert_message(message="MSH|^~\&|RIS|HOSP|...", include="both")

# Just the diagnosis, not the payload
"Will this ADT^A08 convert cleanly?"
  → convert_message(message="...", include="summary")

# Merge safety
"Which patient does this A40 retire?"
  → get_message_mapping(messageType="ADT^A40")
    convert_message(...)   survivor keeps PID-3, MRG-1 goes active=false with replaced-by

# Datatype detail
"How do I get an email address out of an XTN?"
  → get_datatype_mapping(datatype="XTN")

# Timestamps
"Is 20250901143000 safe to send as a FHIR instant?"
  → convert_datetime(value="20250901143000")
```

---

---

## ⚠️ Remote deploy warning (lab / synthetic only)

**Do not expose this server on the public internet without authentication.**

Defaults are intentional for local use:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind loopback only |
| `PORT` | see above | HTTP port |
| `API_KEY` (or `MCP_API_KEY`) | _(unset)_ | Optional on loopback; **required** for any non-loopback bind |

If you set `HOST=0.0.0.0` (or any non-loopback address) and omit `API_KEY`, the process
**refuses to start**. When `API_KEY` is set, every route except `/health` requires
`Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`.

These servers hold HL7 reference/mapping logic and will happily accept whatever message
you POST — treat remote instances as **lab or synthetic-data playgrounds**, never as a
place to send real PHI.

### Deploying remotely (only with auth)

Railway, Render, and similar hosts typically bind `0.0.0.0`. That is fine **only** if you
also set a strong `API_KEY` (and prefer putting the service behind your own gateway).

**Do not** recommend or configure a wide-open Railway/Render deploy with open CORS and no
auth — that was an earlier mistake in this README.

```bash
# Example: remote bind with auth
HOST=0.0.0.0 API_KEY="$(openssl rand -hex 32)" PORT=3000 npm start
# Clients: Authorization: Bearer <that key>
```

## Related

- [hl7-v2-mcp-server](https://github.com/coffeemilktea/hl7-v2-mcp-server) — the companion HL7 v2.5.1
  reference server
- [coffeemilktea.github.io](https://coffeemilktea.github.io/) — browser-based healthcare IT tools,
  including a browser-side HL7 v2 ↔ FHIR converter
- [hl7-dicom-tools](https://github.com/coffeemilktea/hl7-dicom-tools) — the DICOM and HL7 v2 browser tools

Mappings follow FHIR R4 (4.0.1) and the HL7 v2-to-FHIR conventions. HL7® and FHIR® are registered
trademarks of Health Level Seven International; this project is not affiliated with or endorsed by
HL7 International.

MIT licensed — see [LICENSE](LICENSE).
