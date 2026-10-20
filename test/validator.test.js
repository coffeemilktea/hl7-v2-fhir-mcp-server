/**
 * Run the official HL7 FHIR validator (R4 4.0.1, no terminology server) on the
 * bundles converted from every fixture. Skipped when Java or the validator jar
 * is unavailable; set FHIR_VALIDATOR_JAR to the jar's path (CI downloads it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { convert } from "../src/convert/messages.js";
import * as F from "./fixtures.js";

const jar = process.env.FHIR_VALIDATOR_JAR;
const java = spawnSync("java", ["-version"]).status === 0;
const skip = !jar || !fs.existsSync(jar) ? "FHIR_VALIDATOR_JAR not set" : !java ? "java not installed" : false;

const FIXTURES = ["ADT_A01", "ADT_A03", "ADT_A04", "ADT_A08", "ADT_A31", "ADT_A40", "ORM_O01", "ORU_R01", "OML_O21", "OMI_O23", "SIU_S12", "MDM_T02", "MDM_T10"];

test("converted bundles pass the HL7 FHIR R4 validator with 0 errors", { skip, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-validate-"));
  const files = FIXTURES.map((k) => {
    // SIU: v2.5.1 has no participant status; choose one explicitly so the bundle is conformant.
    const { bundle } = convert(F[k], k.startsWith("SIU") ? { participantStatus: "needs-action" } : {});
    const f = path.join(dir, `${k}.json`);
    fs.writeFileSync(f, JSON.stringify(bundle));
    return f;
  });
  const out = path.join(dir, "validation.json");
  // Capture the validator's console output: a failed package download from packages.fhir.org or a
  // bad jar exits non-zero without writing `out`, and the log is the only clue to what went wrong.
  const run = spawnSync("java", ["-jar", jar, ...files, "-version", "4.0.1", "-tx", "n/a", "-output", out], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 590_000,
  });
  const log = () => `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
  assert.ok(!run.error, `could not run the validator: ${run.error?.message}\n${log()}`);
  assert.ok(run.status === 0 && fs.existsSync(out), `validator exited with ${run.status ?? run.signal} and wrote no report:\n${log()}`);
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  const outcomes = result.entry ? result.entry.map((e) => e.resource) : [result];
  assert.equal(outcomes.length, files.length, "one OperationOutcome per bundle");
  const errors = [];
  outcomes.forEach((o, i) => {
    // Name each issue by the file the validator reports, not by position in the output.
    const file = o.extension?.find((x) => x.url === "http://hl7.org/fhir/StructureDefinition/operationoutcome-file")?.valueString;
    const name = file ? path.basename(file, ".json") : FIXTURES[i];
    for (const iss of o.issue ?? []) {
      if (iss.severity === "error" || iss.severity === "fatal") errors.push(`${name}: ${iss.expression?.[0] ?? ""} ${iss.details?.text ?? ""}`);
    }
  });
  assert.deepEqual(errors, []);
});
