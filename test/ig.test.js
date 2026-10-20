/** The imported IG reference data: provenance, v2.5.1 flags and comparisons. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { igMeta, segmentMapsFor, datatypeMapsFor, conceptMapsFor, conceptMapDivergence, allDivergences, messageMapFor } from "../src/ig.js";

test("IG data is pinned and its licences are recorded", () => {
  const m = igMeta();
  assert.equal(m.commit, "873b331b3890c8bc5d62ef9b4dabb41801aac70d");
  assert.equal(m.ig.id, "hl7.fhir.uv.v2mappings");
  assert.match(m.licence.igPackage, /CC0-1\.0/);
  assert.match(m.licence.repository, /Apache-2\.0/);
  assert.deepEqual(m.counts, { conceptMaps: 99, segmentMaps: 75, datatypeMaps: 105, messageMaps: 13 });
});

test("IG rows for fields that v2.5.1 does not define are flagged", () => {
  const pid = segmentMapsFor("PID").find((m) => m.map === "PID[Patient]");
  const pid40 = pid.rows.find((r) => r.id === "PID-40");
  assert.equal(pid40.inV251, false);
  assert.match(pid40.reason, /does not exist in v2\.5\.1/);
  const pid5 = pid.rows.find((r) => r.id === "PID-5");
  assert.equal(pid5.inV251, true);
  assert.equal(pid5.v251Name, "Patient Name");
  const cwe = datatypeMapsFor("CWE").find((m) => m.map === "CWE[CodeableConcept]");
  assert.equal(cwe.rows.find((r) => r.id === "CWE.9").inV251, true);
  assert.equal(cwe.rows.find((r) => r.id === "CWE.10").inV251, false);
});

test("IG code rows carry their v2.5.1 status", () => {
  const sched = conceptMapsFor("0278")[0];
  assert.equal(sched.map.find((e) => e.code === "Booked").v251, "valid");
  assert.equal(sched.map.find((e) => e.code === "Discontinued").v251, "unverified");
});

test("divergences from the IG are reported, not hidden", () => {
  const d1 = conceptMapDivergence("0001");
  assert.deepEqual(d1.rows.filter((r) => r.status === "differs").map((r) => [r.code, r.server, r.ig]), [["N", "unknown", "other"]]);
  const d4 = conceptMapDivergence("0004");
  assert.deepEqual(d4.rows.filter((r) => r.status === "differs").map((r) => r.code), ["R", "B", "C", "N", "U"]);
  const d123 = conceptMapDivergence("0123");
  assert.ok(d123.rows.some((r) => r.code === "R" && r.status === "differs" && r.ig === "partial"));
  const all = allDivergences();
  assert.ok(all.find((t) => t.table === "0002").differs === 0);
});

test("IG message maps are available for the new conversions", () => {
  for (const k of ["SIU^S12", "MDM^T02", "OML^O21"]) assert.ok(messageMapFor(k)?.rows.length, k);
  assert.equal(messageMapFor("OMI^O23"), null, "the IG has no OMI map");
});
