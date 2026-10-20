/**
 * Mapping lookup tools. Each answers from two sources, labelled separately:
 *   server — this server's curated rules (what convert_message does)
 *   ig     — the HL7 v2-to-FHIR IG rows (reference data, checked against v2.5.1)
 */
import { z } from "zod";
import * as core from "hl7v2-core";
import { FHIR_VERSION, DATATYPE_MAPS, CONCEPT_MAPS, SEGMENT_MAPS, MESSAGE_MAPS } from "../maps.js";
import * as ig from "../ig.js";
import { ok, fail, READ_ONLY } from "../result.js";
import { segmentCode, offset, limit, page, out } from "../schemas.js";

const source = z
  .enum(["server", "ig", "both"])
  .default("both")
  .describe("server = this server's curated mapping (what convert_message does); ig = the HL7 v2-to-FHIR IG rows; both (default).");

const messageKey = (s) => String(s).trim().toUpperCase().replace(/[_ ]/g, "^").split("^").slice(0, 2).join("^");
const tableId = z.union([z.string(), z.number()]).transform((v) => core.normalizeTableId(v)).describe("HL7 table number, e.g. '0001', '1' or 1.");

/** Resolve a message type to the server map that covers it (directly or via alsoCovers). */
function serverMessageMap(key) {
  if (MESSAGE_MAPS[key]) return { key, map: MESSAGE_MAPS[key] };
  for (const [k, m] of Object.entries(MESSAGE_MAPS)) if (m.alsoCovers?.includes(key)) return { key: k, map: m, coveredBy: k };
  return null;
}

const v251Field = (seg, seq) => {
  const f = core.getField(seg, seq);
  return f ? { name: f.name, dataType: f.type, optionality: f.opt, ...(f.table ? { table: f.table } : {}) } : null;
};

export function register(server) {
  server.registerTool(
    "list_message_mappings",
    {
      title: "List message mappings",
      description: "List the HL7 v2.5.1 message types this server converts (and the triggers each covers), plus the message maps published in the HL7 v2-to-FHIR IG.",
      inputSchema: {},
      outputSchema: out({ fhirVersion: z.string(), server: z.array(z.object({ messageType: z.string() }).passthrough()), ig: z.array(z.string()) }),
      annotations: { title: "List message mappings", ...READ_ONLY },
    },
    async () =>
      ok({
        fhirVersion: FHIR_VERSION,
        server: Object.entries(MESSAGE_MAPS).map(([type, m]) => ({
          messageType: type,
          description: m.description,
          produces: m.produces,
          ...(m.alsoCovers ? { alsoCovers: m.alsoCovers } : {}),
          pitfallCount: m.pitfalls.length,
        })),
        ig: ig.igMessageTypes(),
        igSource: ig.attribution(),
      })
  );

  server.registerTool(
    "get_message_mapping",
    {
      title: "Get a message mapping",
      description: "Segment-to-resource plan for one HL7 v2.5.1 message type (e.g. ORU^R01, SIU^S12, MDM^T02), with known pitfalls, and the IG message map when one exists.",
      inputSchema: { messageType: z.string().min(1).describe("Message type and trigger, e.g. ORM^O01, adt_a08, SIU^S13. Case-insensitive; _ or ^."), source },
      outputSchema: out({ messageType: z.string() }),
      annotations: { title: "Get a message mapping", ...READ_ONLY },
    },
    async ({ messageType, source }) => {
      const key = messageKey(messageType);
      const s = source !== "ig" ? serverMessageMap(key) : null;
      const i = source !== "server" ? ig.messageMapFor(key) : null;
      if (!s && !i) {
        return fail(`No mapping for '${key}'. Server: ${Object.keys(MESSAGE_MAPS).join(", ")}. IG: ${ig.igMessageTypes().join(", ")}.`);
      }
      return ok({
        messageType: key,
        fhirVersion: FHIR_VERSION,
        ...(s ? { server: { ...(s.coveredBy ? { coveredBy: s.coveredBy } : {}), ...s.map } } : source !== "ig" ? { server: null } : {}),
        ...(i ? { ig: { ...i, ...ig.attribution() } } : source !== "server" ? { ig: null } : {}),
      });
    }
  );

  server.registerTool(
    "get_segment_mapping",
    {
      title: "Get a segment mapping",
      description:
        "Field-by-field FHIR mapping for one HL7 v2.5.1 segment. IG rows are flagged inV251=false when they name a field that does not exist in v2.5.1 (the IG is written against later versions). IG rows are paginated.",
      inputSchema: { segment: segmentCode, source, offset, limit: limit(100, 500) },
      outputSchema: out({ segment: z.string() }),
      annotations: { title: "Get a segment mapping", ...READ_ONLY },
    },
    async ({ segment, source, offset, limit }) => {
      const s = source !== "ig" ? SEGMENT_MAPS[segment] : undefined;
      const maps = source !== "server" ? ig.segmentMapsFor(segment) : [];
      if (!s && !maps.length) {
        return fail(`No mapping for segment '${segment}'${source === "server" ? " in this server" : ""}. Server segments: ${Object.keys(SEGMENT_MAPS).join(", ")}.${source === "server" ? " Try source=ig for the IG's segment maps." : ""}`);
      }
      const rows = maps.flatMap((m) => m.rows.map((r) => ({ map: m.map, ...r })));
      const { items, ...slice } = core.paginate(rows, offset, limit);
      return ok(
        {
          segment,
          fhirVersion: FHIR_VERSION,
          ...(source !== "ig" ? { server: s ?? null } : {}),
          ...(source !== "server"
            ? { ig: { maps: maps.map((m) => ({ map: m.map, sourceFile: m.sourceFile, rowCount: m.rows.length })), ...slice, rows: items, ...ig.attribution() } }
            : {}),
        },
        { hint: "Use source=server, or page the IG rows with offset/limit." }
      );
    }
  );

  server.registerTool(
    "get_field_mapping",
    {
      title: "Get a field mapping",
      description: "FHIR target for one HL7 v2.5.1 field (e.g. PID-5, OBR-25), with its v2.5.1 definition, this server's rule and the IG rows for it.",
      inputSchema: {
        segment: segmentCode,
        field: z.coerce.number().int().positive().describe("Field sequence number, e.g. 25 for OBR-25. A string like '25' is accepted."),
      },
      outputSchema: out({ location: z.string() }),
      annotations: { title: "Get a field mapping", ...READ_ONLY },
    },
    async ({ segment, field }) => {
      const def = v251Field(segment, field);
      const m = SEGMENT_MAPS[segment];
      const f = m?.fields.find((x) => x.seq === field);
      const rows = ig.segmentMapsFor(segment, { field });
      if (!def && !f && !rows.length) return fail(`${segment}-${field} is not defined in HL7 v2.5.1 and has no mapping.`);
      return ok({
        location: `${segment}-${field}`,
        v251: def,
        server: f ? { resource: m.resource, ...f } : null,
        ...(f ? {} : { serverNote: "No curated mapping in this server. An unmapped field is not necessarily unmappable — see the IG rows." }),
        ig: rows.length ? { maps: rows, ...ig.attribution() } : null,
      });
    }
  );

  server.registerTool(
    "get_datatype_mapping",
    {
      title: "Get a datatype mapping",
      description: "Component-by-component FHIR mapping for an HL7 v2.5.1 data type (XPN, CX, CE, CWE, TS ...). IG rows naming components that v2.5.1 does not define are flagged inV251=false.",
      inputSchema: {
        datatype: z.string().trim().min(1).transform((s) => s.toUpperCase()).describe("HL7 data type, e.g. XPN, CX, CWE."),
        source,
        igMap: z.string().optional().describe("One IG map by target, e.g. 'CodeableConcept' for CWE[CodeableConcept]. When a type has more than 3 IG maps and this is omitted, only the map list is returned."),
      },
      outputSchema: out({ datatype: z.string() }),
      annotations: { title: "Get a datatype mapping", ...READ_ONLY },
    },
    async ({ datatype, source, igMap }) => {
      const s = source !== "ig" ? DATATYPE_MAPS[datatype] : undefined;
      let maps = source !== "server" ? ig.datatypeMapsFor(datatype) : [];
      if (igMap) {
        const want = igMap.toLowerCase().replace(/^.*\[|\]$/g, "");
        maps = maps.filter((m) => /\[(.+)\]$/.exec(m.map)?.[1].toLowerCase() === want);
        if (!maps.length) return fail(`No IG map ${datatype}[${igMap}]. Available: ${ig.datatypeMapsFor(datatype).map((m) => m.map).join(", ")}.`);
      } else if (maps.length > 3) {
        maps = maps.map((m) => ({ map: m.map, sourceFile: m.sourceFile, rowCount: m.rows.length }));
      }
      if (!s && !maps.length) return fail(`No mapping for datatype '${datatype}'. Server: ${Object.keys(DATATYPE_MAPS).join(", ")}.`);
      const d = core.getDatatype(datatype);
      return ok(
        {
          datatype,
          v251: d ? { name: d.name ?? null, components: (d.components ?? []).length } : null,
          ...(source !== "ig" ? { server: s ?? null } : {}),
          ...(source !== "server" ? { ig: { maps, ...ig.attribution() } } : {}),
        },
        { hint: "Pass igMap to pick one IG map, or source=server for the curated mapping only." }
      );
    }
  );

  server.registerTool(
    "lookup_concept_map",
    {
      title: "Look up a ConceptMap",
      description:
        "Translate an HL7 v2.5.1 table value to FHIR, or list a table's ConceptMap. Shows this server's target, the IG's target, whether they differ, and the code's v2.5.1 status (valid, not-in-2.5.1 or unverified).",
      inputSchema: {
        table: tableId,
        code: z.string().optional().describe("Optional single v2 code to translate, e.g. 'F'."),
        source,
      },
      outputSchema: out({ table: z.string() }),
      annotations: { title: "Look up a ConceptMap", ...READ_ONLY },
    },
    async ({ table, code, source }) => {
      const s = source !== "ig" ? CONCEPT_MAPS[table] : undefined;
      const igMaps = source !== "server" ? ig.conceptMapsFor(table) : [];
      if (!s && !igMaps.length) {
        return fail(`No ConceptMap for table '${table}'. Server: ${Object.keys(CONCEPT_MAPS).join(", ")}. IG: ${ig.igConceptMapKeys().filter((k) => /^\d/.test(k)).join(", ")}.`);
      }
      const div = ig.conceptMapDivergence(table);
      if (!code) {
        return ok(
          { table, ...(source !== "ig" ? { server: s ?? null } : {}), ...(source !== "server" ? { ig: igMaps.length ? { maps: igMaps, ...ig.attribution() } : null } : {}), ...(div && source === "both" ? { divergence: div.summary } : {}) },
          { hint: "Pass code to translate a single value, or source=server / source=ig to get one side only." }
        );
      }
      const v251 = core.checkCode(table, code);
      const v251Status = !v251?.table ? "table not in v2.5.1 data" : v251.known ? v251.status : "not a code in the v2.5.1 table";
      const hit = s?.map.find((x) => x.code === code) ?? s?.map.find((x) => x.code.toUpperCase() === code.toUpperCase());
      const igHits = igMaps.map((m) => ({ map: m.name, ...(m.map.find((e) => e.code === code) ?? m.map.find((e) => e.code?.toUpperCase() === code.toUpperCase()) ?? { target: null, note: "Code not listed in this IG map." }) }));
      if (!hit && !igHits.some((h) => h.code)) {
        return fail(
          `'${code}' is not in the ConceptMap for table ${table}${s ? ` (${s.name})` : ""}. v2.5.1 status: ${v251Status}.${s ? ` Server codes: ${s.map.map((x) => x.code).join(", ")}.` : ""} A value outside the table should be flagged, not mapped to a plausible neighbour.`
        );
      }
      const row = div?.rows.find((r) => r.code === (hit?.code ?? code));
      return ok({
        table,
        code,
        v251: v251 ? { status: v251Status, ...(v251.entry ? { display: v251.entry.display } : {}), ...(v251.entry?.reason ? { reason: v251.entry.reason } : {}) } : null,
        ...(source !== "ig" ? { server: hit ? { name: s.name, target: s.target, ...hit } : null } : {}),
        ...(source !== "server" ? { ig: igHits.length ? igHits : null } : {}),
        ...(row && source === "both" ? { comparison: row.status } : {}),
      });
    }
  );

  server.registerTool(
    "compare_with_ig",
    {
      title: "Compare ConceptMaps with the IG",
      description:
        "Where this server's code translations differ from the HL7 v2-to-FHIR IG. Without a table: a summary for every table the server maps. With a table: code-by-code rows (same, differs, server-only, ig-only) and the server's rationale where it gives one.",
      inputSchema: { table: tableId.optional(), status: z.enum(["all", "same", "differs", "server-only", "ig-only"]).default("all").describe("Filter code rows by comparison status (with a table only).") },
      outputSchema: out({ igSource: z.object({ source: z.string(), licence: z.string() }) }),
      annotations: { title: "Compare ConceptMaps with the IG", ...READ_ONLY },
    },
    async ({ table, status }) => {
      if (!table) return ok({ igSource: ig.attribution(), tables: ig.allDivergences() });
      const d = ig.conceptMapDivergence(table);
      if (!d) return fail(`Table '${table}' is not mapped by both this server and the IG. Server tables: ${Object.keys(CONCEPT_MAPS).join(", ")}.`);
      return ok({ igSource: ig.attribution(), ...d, rows: status === "all" ? d.rows : d.rows.filter((r) => r.status === status) });
    }
  );

  server.registerTool(
    "which_v2_fields_feed",
    {
      title: "Which v2 fields feed a resource",
      description: "Reverse lookup: every HL7 v2.5.1 field that maps into a FHIR R4 resource type. Matches whole resource-type names, so Observation does not match ObservationDefinition.",
      inputSchema: {
        resourceType: z.string().trim().min(1).describe("FHIR R4 resource type, e.g. Patient, Encounter, Appointment, DocumentReference."),
        source,
        offset,
        limit: limit(100, 500),
      },
      outputSchema: out({ resourceType: z.string(), ...page.shape }),
      annotations: { title: "Which v2 fields feed a resource", ...READ_ONLY },
    },
    async ({ resourceType, source, offset, limit }) => {
      const esc = resourceType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^A-Za-z])${esc}(?![A-Za-z])`, "i");
      const hits = [];
      if (source !== "ig") {
        for (const [seg, m] of Object.entries(SEGMENT_MAPS)) {
          for (const f of m.fields) if (re.test(f.path)) hits.push({ source: "server", location: `${seg}-${f.seq}`, name: f.name, path: f.path, ...(f.note ? { note: f.note } : {}) });
        }
      }
      if (source !== "server") {
        const want = resourceType.toLowerCase();
        for (const seg of Object.keys(core.segments())) {
          for (const m of ig.segmentMapsFor(seg)) {
            const target = /\[(.+?)(?:-.*)?\]$/.exec(m.map)?.[1]?.toLowerCase();
            if (target !== want) continue;
            for (const r of m.rows) if (r.target) hits.push({ source: "ig", map: m.map, location: r.id, name: r.name, path: r.target, ...(r.inV251 === false ? { inV251: false } : {}) });
          }
        }
      }
      if (!hits.length) return fail(`Nothing maps into '${resourceType}'. Server resources: ${[...new Set(Object.values(SEGMENT_MAPS).map((m) => m.resource))].join("; ")}`);
      const { items, ...p } = core.paginate(hits, offset, limit);
      return ok({ resourceType, ...p, fields: items });
    }
  );
}
