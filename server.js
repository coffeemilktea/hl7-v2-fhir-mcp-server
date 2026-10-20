#!/usr/bin/env node
// Backward-compatible entry point: `node server.js` starts the HTTP server on port 3001 as in v1.
// New installs should use `npx hl7-v2-fhir-mcp-server` (stdio) or `hl7-v2-fhir-mcp-server --http`.
import { startHttp, configFromEnv } from "./src/transport/http.js";

try {
  startHttp(configFromEnv());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
