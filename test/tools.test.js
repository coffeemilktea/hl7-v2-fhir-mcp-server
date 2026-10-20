/** Every tool over a real MCP client (in-memory transport); the client validates structuredContent against each outputSchema. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import * as F from "./fixtures.js";

let client;
before(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});
after(async () => client.close());
const call = (name, args = {}) => client.callTool({ name, arguments: args });

test("tools have titles, read-only annotations and output schemas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} title`);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.ok(t.outputSchema, `${t.name} outputSchema`);
  }
});

test("list_message_mappings includes the new types and the IG list", async () => {
  const r = await call("list_message_mappings");
  const types = r.structuredContent.server.map((m) => m.messageType);
  for (const t of ["SIU^S12", "MDM^T02", "OML^O21", "OMI^O23"]) assert.ok(types.includes(t), t);
  assert.ok(r.structuredContent.ig.includes("VXU^V04"));
});

test("get_message_mapping resolves covered triggers and lenient keys", async () => {
  const r = await call("get_message_mapping", { messageType: "mdm_t10" });
  assert.equal(r.structuredContent.server.coveredBy, "MDM^T02");
  assert.equal(r.structuredContent.ig, null);
  const ig = await call("get_message_mapping", { messageType: "VXU^V04", source: "ig" });
  assert.ok(ig.structuredContent.ig.rows.length);
  const bad = await call("get_message_mapping", { messageType: "ZZZ^Z99" });
  assert.equal(bad.isError, true);
});

test("get_segment_mapping pages IG rows", async () => {
  const r = await call("get_segment_mapping", { segment: "pid", limit: "5" });
  assert.equal(r.structuredContent.ig.rows.length, 5);
  assert.equal(r.structuredContent.ig.nextOffset, 5);
  assert.ok(r.structuredContent.server.fields.length);
  const igOnly = await call("get_segment_mapping", { segment: "RXA", source: "server" });
  assert.equal(igOnly.isError, true);
  const rxa = await call("get_segment_mapping", { segment: "RXA", source: "ig" });
  assert.ok(rxa.structuredContent.ig.total > 0);
});

test("get_field_mapping returns the v2.5.1 definition with server and IG rows", async () => {
  const r = await call("get_field_mapping", { segment: "PD1", field: "8" });
  assert.equal(r.structuredContent.v251.name, "Organ Donor Code");
  assert.equal(r.structuredContent.server.seq, 8);
  const unmapped = await call("get_field_mapping", { segment: "PID", field: 38 });
  assert.equal(unmapped.structuredContent.server, null);
  const missing = await call("get_field_mapping", { segment: "PID", field: 99 });
  assert.equal(missing.isError, true);
});

test("get_datatype_mapping: CE has no component 9; CWE does", async () => {
  const ce = await call("get_datatype_mapping", { datatype: "ce", source: "server" });
  assert.equal(ce.structuredContent.server.components.some((c) => c.comp === 9), false);
  const cwe = await call("get_datatype_mapping", { datatype: "CWE" });
  assert.equal(cwe.structuredContent.v251.components, 9);
  assert.ok(cwe.structuredContent.ig.maps.length > 3);
  assert.equal(cwe.structuredContent.ig.maps[0].rows, undefined, "list only when there are many IG maps");
  const one = await call("get_datatype_mapping", { datatype: "CWE", source: "ig", igMap: "CodeableConcept" });
  assert.equal(one.structuredContent.ig.maps.length, 1);
  assert.ok(one.structuredContent.ig.maps[0].rows.some((r) => r.id === "CWE.9"));
});

test("lookup_concept_map shows server, IG, comparison and v2.5.1 status", async () => {
  const r = await call("lookup_concept_map", { table: 1, code: "N" });
  assert.equal(r.structuredContent.server.fhir, "unknown");
  assert.equal(r.structuredContent.ig[0].target, "other");
  assert.equal(r.structuredContent.comparison, "differs");
  assert.equal(r.structuredContent.v251.status, "valid");
  const cwe = await call("lookup_concept_map", { table: "0125", code: "CWE" });
  assert.equal(cwe.structuredContent.v251.status, "not-in-2.5.1");
  const bad = await call("lookup_concept_map", { table: "0002", code: "L" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not in the ConceptMap.*v2\.5\.1 status/);
});

test("compare_with_ig: summary and per-table rows", async () => {
  const all = await call("compare_with_ig");
  assert.ok(all.structuredContent.tables.find((t) => t.table === "0004").differs >= 5);
  const r = await call("compare_with_ig", { table: "85", status: "differs" });
  assert.deepEqual(r.structuredContent.rows.map((x) => x.code), ["I", "R", "S", "U"]);
});

test("which_v2_fields_feed matches whole resource names", async () => {
  const r = await call("which_v2_fields_feed", { resourceType: "Appointment", source: "server" });
  assert.ok(r.structuredContent.fields.some((f) => f.location === "SCH-25"));
  const obs = await call("which_v2_fields_feed", { resourceType: "Observation", limit: 500 });
  assert.ok(obs.structuredContent.fields.every((f) => !/ObservationDefinition/.test(f.path)));
  const none = await call("which_v2_fields_feed", { resourceType: "Obs" });
  assert.equal(none.isError, true);
});

test("convert_datetime", async () => {
  const r = await call("convert_datetime", { value: "202610191430" });
  assert.equal(r.structuredContent.fhir, "2026-10-19T14:30:00");
  assert.ok(r.structuredContent.warning);
  assert.equal((await call("convert_datetime", { value: "2026-10-19" })).isError, true);
});

test("convert_message: every fixture type, summary mode and errors", async () => {
  for (const m of [F.ADT_A01, F.ORM_O01, F.ORU_R01, F.SIU_S12, F.MDM_T02, F.OML_O21, F.OMI_O23]) {
    const r = await call("convert_message", { message: m, include: "summary" });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.ok(Object.keys(r.structuredContent.resourceCounts).length);
    assert.equal(r.structuredContent.bundle, undefined);
  }
  const full = await call("convert_message", { message: F.SIU_S12, participantStatus: "needs-action" });
  assert.equal(full.structuredContent.bundle.resourceType, "Bundle");
  const bad = await call("convert_message", { message: "PID|1" });
  assert.equal(bad.isError, true);
});

test("resources", async () => {
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.equal(resourceTemplates.length, 4);
  const r = await client.readResource({ uri: "fhirmap://conceptmap/2" });
  const body = JSON.parse(r.contents[0].text);
  assert.equal(body.comparison.summary.differs, 0);
  const about = JSON.parse((await client.readResource({ uri: "fhirmap://about" })).contents[0].text);
  assert.equal(about.v2Version, "2.5.1");
});
