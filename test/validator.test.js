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
import { execFileSync, spawnSync } from "child_process";
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
  execFileSync("java", ["-jar", jar, ...files, "-version", "4.0.1", "-tx", "n/a", "-output", out], { stdio: "ignore", timeout: 590_000 });
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  const outcomes = result.entry ? result.entry.map((e) => e.resource) : [result];
  const errors = [];
  outcomes.forEach((o, i) => {
    for (const iss of o.issue ?? []) {
      if (iss.severity === "error" || iss.severity === "fatal") errors.push(`${FIXTURES[i]}: ${iss.expression?.[0] ?? ""} ${iss.details?.text ?? ""}`);
    }
  });
  assert.deepEqual(errors, []);
});
