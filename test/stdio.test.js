import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

test("bin/cli.js speaks MCP over stdio by default", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], stderr: "pipe" });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  const info = client.getServerVersion();
  assert.equal(info.name, "hl7-v251-to-fhir");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  const r = await client.callTool({ name: "lookup_concept_map", arguments: { table: "2", code: "A" } });
  assert.equal(r.structuredContent.server.fhir, "L");
  await client.close();
});
