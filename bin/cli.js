#!/usr/bin/env node
/**
 * hl7-v2-fhir-mcp-server
 *   (no flags)   stdio transport — what `npx hl7-v2-fhir-mcp-server` and local MCP clients use
 *   --http       Streamable HTTP on HOST:PORT (default 127.0.0.1:3001) at /mcp
 */
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.error(`Usage: hl7-v2-fhir-mcp-server [--http] [--port N] [--host H]

  (default)     Run over stdio for local MCP clients.
  --http        Run Streamable HTTP at http://HOST:PORT/mcp.
  --port N      HTTP port (env PORT, default 3001).
  --host H      HTTP bind address (env HOST, default 127.0.0.1). Non-loopback requires API_KEY.

Environment: API_KEY, ALLOWED_HOSTS, ALLOWED_ORIGINS, SESSION_IDLE_MS, MAX_SESSIONS, MAX_BODY, HL7_MCP_MAX_OUTPUT_CHARS`);
  process.exit(0);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--http") || opt("--port") || opt("--host")) {
  if (opt("--port")) process.env.PORT = opt("--port");
  if (opt("--host")) process.env.HOST = opt("--host");
  const { startHttp, configFromEnv } = await import("../src/transport/http.js");
  try {
    startHttp(configFromEnv());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else {
  const { startStdio } = await import("../src/transport/stdio.js");
  await startStdio();
}
