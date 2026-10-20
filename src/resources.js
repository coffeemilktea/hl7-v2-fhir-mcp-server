/** MCP resources: read-only views of the mapping data by URI. */
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SEGMENT_MAPS, CONCEPT_MAPS, MESSAGE_MAPS, DATATYPE_MAPS } from "./maps.js";
import * as ig from "./ig.js";
import { normalizeTableId } from "hl7v2-core";

const json = (uri, data) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] });

export function register(server) {
  server.registerResource(
    "segment-mapping",
    new ResourceTemplate("fhirmap://segment/{code}", { list: undefined }),
    { title: "Segment → FHIR mapping", description: "Server and IG mapping for one segment, e.g. fhirmap://segment/OBR", mimeType: "application/json" },
    async (uri, { code }) => {
      const k = String(code).toUpperCase();
      const s = SEGMENT_MAPS[k];
      const maps = ig.segmentMapsFor(k);
      if (!s && !maps.length) throw new Error(`No mapping for segment '${code}'.`);
      return json(uri, { segment: k, server: s ?? null, ig: { maps, ...ig.attribution() } });
    }
  );
  server.registerResource(
    "datatype-mapping",
    new ResourceTemplate("fhirmap://datatype/{code}", { list: undefined }),
    { title: "Datatype → FHIR mapping", description: "Server and IG mapping for one data type, e.g. fhirmap://datatype/CX", mimeType: "application/json" },
    async (uri, { code }) => {
      const k = String(code).toUpperCase();
      const maps = ig.datatypeMapsFor(k);
      if (!DATATYPE_MAPS[k] && !maps.length) throw new Error(`No mapping for datatype '${code}'.`);
      return json(uri, { datatype: k, server: DATATYPE_MAPS[k] ?? null, ig: { maps, ...ig.attribution() } });
    }
  );
  server.registerResource(
    "conceptmap",
    new ResourceTemplate("fhirmap://conceptmap/{table}", { list: undefined }),
    { title: "Table → FHIR ConceptMap", description: "Server and IG ConceptMaps for one v2 table, with the comparison, e.g. fhirmap://conceptmap/0002", mimeType: "application/json" },
    async (uri, { table }) => {
      const id = normalizeTableId(table);
      const maps = ig.conceptMapsFor(id);
      if (!CONCEPT_MAPS[id] && !maps.length) throw new Error(`No ConceptMap for table '${table}'.`);
      return json(uri, { table: id, server: CONCEPT_MAPS[id] ?? null, ig: { maps, ...ig.attribution() }, comparison: ig.conceptMapDivergence(id) });
    }
  );
  server.registerResource(
    "message-mapping",
    new ResourceTemplate("fhirmap://message/{type}", { list: undefined }),
    { title: "Message → FHIR mapping", description: "Server and IG map for one message type, e.g. fhirmap://message/SIU_S12", mimeType: "application/json" },
    async (uri, { type }) => {
      const key = String(type).toUpperCase().replace(/_/g, "^");
      const s = MESSAGE_MAPS[key];
      const i = ig.messageMapFor(key);
      if (!s && !i) throw new Error(`No mapping for message '${type}'.`);
      return json(uri, { messageType: key, server: s ?? null, ig: i ? { ...i, ...ig.attribution() } : null });
    }
  );
  server.registerResource(
    "about",
    "fhirmap://about",
    { title: "About this server's data", description: "Sources, versions and licences of the mapping data", mimeType: "application/json" },
    async (uri) => json(uri, { fhirVersion: "4.0.1", v2Version: "2.5.1", ig: ig.igMeta(), divergences: ig.allDivergences() })
  );
}
