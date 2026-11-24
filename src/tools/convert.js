/** Conversion tools: whole messages and single timestamps. */
import { z } from "zod";
import { convert, SUPPORTED_TYPES } from "../convert/messages.js";
import { PARTICIPANT_STATUSES } from "../convert/scheduling.js";
import { toFhirDate, zonelessTime, MessageError } from "../convert/util.js";
import { ok, fail, READ_ONLY } from "../result.js";
import { message, out } from "../schemas.js";

export function register(server) {
  server.registerTool(
    "convert_datetime",
    {
      title: "Convert an HL7 timestamp",
      description: "Convert an HL7 v2.5.1 TS/DTM value to a FHIR date or dateTime, preserving the source precision.",
      inputSchema: { value: z.string().min(1).describe("HL7 timestamp, e.g. 20250901143000-0500") },
      outputSchema: out({ source: z.string(), fhir: z.string(), fhirType: z.string(), warning: z.string().optional() }),
      annotations: { title: "Convert an HL7 timestamp", ...READ_ONLY },
    },
    async ({ value }) => {
      const v = value.trim();
      const fhir = toFhirDate(v);
      if (!fhir) return fail(`'${value}' is not a valid HL7 TS. Expected YYYY[MM[DD[HH[MM[SS[.SSSS]]]]]][+/-ZZZZ].`);
      return ok({
        source: v,
        fhir,
        fhirType: fhir.includes("T") ? "dateTime" : fhir.length === 10 ? "date" : "date (reduced precision)",
        ...(zonelessTime(fhir)
          ? { warning: "The source has a time but no timezone offset. FHIR instant requires one, and dateTime requires one whenever a time is present — the receiver will otherwise apply its own locale." }
          : {}),
      });
    }
  );

  server.registerTool(
    "convert_message",
    {
      title: "Convert an HL7 v2 message to FHIR",
      description:
        `Convert a full HL7 v2.5.1 message (${SUPPORTED_TYPES.join(", ")}) into a FHIR R4 transaction Bundle, with a warning for everything that could not be mapped faithfully. ` +
        "Use synthetic or de-identified messages.",
      inputSchema: {
        message,
        include: z
          .enum(["bundle", "summary", "both"])
          .default("both")
          .describe("bundle = the Bundle only; summary = counts, warnings and notes only; both (default)."),
        participantStatus: z
          .enum(PARTICIPANT_STATUSES)
          .optional()
          .describe("SIU only: Appointment.participant.status to apply to every participant. v2.5.1 SIU has no per-participant status, so by default the status is data-absent (which fails strict R4 validation)."),
      },
      outputSchema: out({ messageType: z.string().optional(), fhirVersion: z.string().optional(), resourceCounts: z.record(z.number()).optional(), warnings: z.array(z.string()).optional(), notes: z.array(z.string()).optional() }),
      annotations: { title: "Convert an HL7 v2 message to FHIR", ...READ_ONLY },
    },
    async ({ message, include, participantStatus }) => {
      let result;
      try {
        result = convert(message, { participantStatus });
      } catch (err) {
        // MessageError = a problem with the message; anything else is a defect in this server.
        if (err instanceof MessageError) return fail(`Conversion failed: ${err.message}`);
        return fail(`Internal error while converting (please report it with a synthetic copy of the message): ${err.name}: ${err.message}`);
      }
      const summary = {
        messageType: result.messageType,
        fhirVersion: result.fhirVersion,
        resourceCounts: result.resourceCounts,
        warnings: result.warnings,
        notes: result.notes,
      };
      const hint = "Use include=summary to see counts and warnings only, or split the message.";
      if (include === "summary") return ok(summary);
      if (include === "bundle") return ok(result.bundle, { hint });
      return ok({ ...summary, bundle: result.bundle }, { hint });
    }
  );
}
