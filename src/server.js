/** Build the MCP server: mapping lookups, IG reference data and message conversion. */
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as mappings from "./tools/mappings.js";
import * as convertTools from "./tools/convert.js";
import * as resources from "./resources.js";

const pkg = createRequire(import.meta.url)("../package.json");
export const SERVER_NAME = "hl7-v251-to-fhir";
export const VERSION = pkg.version;
export { convert } from "./convert/messages.js";

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, title: "HL7 v2.5.1 → FHIR R4", version: VERSION },
    {
      instructions:
        "HL7 v2.5.1 → FHIR R4 mapping and conversion. Look up message, segment, field, datatype and code mappings (this server's curated rules and the HL7 v2-to-FHIR IG, labelled separately), compare them, and convert ADT, ORM, OML, OMI, ORU, SIU and MDM messages into transaction Bundles. Read the warnings: they list everything that could not be mapped faithfully. Use synthetic or de-identified messages.",
    }
  );
  mappings.register(server);
  convertTools.register(server);
  resources.register(server);
  return server;
}
