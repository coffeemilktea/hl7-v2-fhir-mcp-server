/** Synthetic HL7 v2.5.1 messages. No real patient data. */
const msg = (...segs) => segs.join("\r");
/** Build a segment from { fieldNumber: value } so positions are explicit. */
export function seg(name, fields) {
  const max = Math.max(0, ...Object.keys(fields).map(Number));
  const parts = [name];
  for (let i = 1; i <= max; i++) parts.push(fields[i] ?? "");
  return parts.join("|");
}

export const ADT_A01 = msg(
  "MSH|^~\\&|ADT|HOSP|PACS|HOSP|20261019080000-0700||ADT^A01^ADT_A01|A01-0001|P|2.5.1",
  "EVN||20261019080000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE^Q||19800214|F|||123 MAIN ST^^SPRINGFIELD^IL^62701^USA||^PRN^PH^^1^217^5551234",
  seg("PV1", { 1: "1", 2: "I", 3: "4WEST^401^A^HOSP", 7: "1234^SMITH^ANNA^^^^DR", 10: "MED", 19: "V0001^^^HOSP^VN", 44: "20261019075500-0700" })
);
export const ADT_A04 = msg(
  "MSH|^~\\&|ADT|HOSP|RIS|HOSP|20261019090000-0700||ADT^A04^ADT_A01|A04-0001|P|2.5.1",
  "EVN||20261019090000-0700",
  "PID|1||MRN22222^^^HOSP^MR||ROE^RICHARD||19750101|M",
  seg("PV1", { 1: "1", 2: "O", 3: "RAD^^^HOSP", 19: "V0002^^^HOSP^VN" })
);
export const ADT_A03 = msg(
  "MSH|^~\\&|ADT|HOSP|PACS|HOSP|20261020110000-0700||ADT^A03^ADT_A03|A03-0001|P|2.5.1",
  "EVN||20261020110000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE^Q||19800214|F",
  seg("PV1", { 1: "1", 2: "I", 3: "4WEST^401^A^HOSP", 19: "V0001^^^HOSP^VN", 36: "01", 44: "20261019075500-0700", 45: "20261020103000-0700" })
);
export const ADT_A08 = msg(
  "MSH|^~\\&|ADT|HOSP|PACS|HOSP|20261019130000-0700||ADT^A08^ADT_A01|MSG0004|P|2.5.1",
  "EVN||20261019130000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE^Q||19800214|F",
  seg("PV1", { 1: "1", 2: "I", 3: "4WEST^401^A^HOSP", 19: "V0001^^^HOSP^VN" })
);
export const ADT_A31 = msg(
  "MSH|^~\\&|MPI|HOSP|PACS|HOSP|20261019140000-0700||ADT^A31^ADT_A05|A31-0001|P|2.5.1",
  "EVN||20261019140000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE^Q||19800214|F",
  "PV1|1|N"
);
export const ADT_A40 = msg(
  "MSH|^~\\&|ADT|HOSP|PACS|HOSP|20261019130000-0700||ADT^A40^ADT_A39|MSG0003|P|2.5.1",
  "EVN||20261019130000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE",
  "MRG|MRN99999^^^HOSP^MR"
);
export const ORM_O01 = msg(
  "MSH|^~\\&|RIS|HOSP|PACS|HOSP|20261019103000-0700||ORM^O01^ORM_O01|MSG0001|P|2.5.1",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  "PV1|1|O",
  seg("ORC", { 1: "NW", 2: "PL1001", 3: "FL2001", 5: "SC", 9: "20261019103000-0700" }),
  seg("OBR", { 1: "1", 2: "PL1001", 3: "FL2001", 4: "71046^XR CHEST 2 VIEWS^CPT", 7: "20261019103000-0700", 18: "ACC789" }),
  "ZDS|1.2.840.113619.2.55.3.604688119.969.1268071029.320^RIS^Application^DICOM"
);
export const ORU_R01 = msg(
  "MSH|^~\\&|RIS|HOSP|EMR|HOSP|20261019120000-0700||ORU^R01^ORU_R01|MSG0002|P|2.5.1",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  "ORC|RE|PL1001|FL2001",
  seg("OBR", { 1: "1", 2: "PL1001", 3: "FL2001", 4: "71046^XR CHEST 2 VIEWS^CPT", 7: "20261019103000-0700", 18: "ACC789", 22: "20261019115500-0700", 24: "RAD", 25: "F" }),
  seg("OBX", { 1: "1", 2: "TX", 3: "71046&IMP^Impression^CPT", 5: "No acute cardiopulmonary process.", 11: "F", 14: "20261019115500-0700" }),
  seg("OBX", { 1: "2", 2: "NM", 3: "8867-4^Heart rate^LN", 5: "72", 6: "/min^beats per minute^UCUM", 7: "60-100", 8: "N", 11: "F" })
);
export const OMI_O23 = msg(
  "MSH|^~\\&|EMR|HOSP|RIS|HOSP|20261019100000-0700||OMI^O23^OMI_O23|OMI-0001|P|2.5.1",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  "PV1|1|O",
  seg("ORC", { 1: "NW", 2: "PL3001", 5: "SC", 9: "20261019100000-0700" }),
  "OBR|1|PL3001||74177^CT ABD PELVIS W CONTRAST^CPT|||20261019100000-0700",
  "IPC|ACC3001^HOSP|RP3001|1.2.840.113619.2.55.3.1.1|SPS3001|CT^Computed Tomography^DCM"
);
export const SIU_S12 = msg(
  "MSH|^~\\&|SCHED|HOSP|RIS|HOSP|20261019090000-0700||SIU^S12^SIU_S12|SIU-0001|P|2.5.1",
  seg("SCH", { 1: "APT1001^SCHED", 2: "APT1001F^RIS", 6: "NEW^New appointment", 7: "ROUTINE^^HL70276", 8: "Normal^^HL70277", 9: "30", 10: "min", 16: "1234^SMITH^ANNA", 20: "5678^CLERK^CAL", 25: "Booked^Booked^HL70278" }),
  seg("TQ1", { 1: "1", 7: "20261021090000-0700", 8: "20261021093000-0700" }),
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  "RGS|1|A",
  seg("AIS", { 1: "1", 2: "A", 3: "74177^CT ABD PELVIS W CONTRAST^CPT", 4: "20261021090000-0700", 7: "30", 8: "min" }),
  seg("AIL", { 1: "1", 2: "A", 3: "CT1^^^HOSP", 6: "20261021090000-0700" }),
  seg("AIP", { 1: "1", 2: "A", 3: "1234^SMITH^ANNA", 6: "20261021090000-0700" })
);

export const OML_O21 = msg(
  "MSH|^~\\&|EMR|HOSP|LIS|HOSP|20261019100000-0700||OML^O21^OML_O21|OML-0001|P|2.5.1",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  "PV1|1|O",
  seg("ORC", { 1: "NW", 2: "PL4001^EMR", 5: "SC", 9: "20261019100000-0700" }),
  seg("TQ1", { 1: "1", 7: "20261019110000-0700", 9: "S^Stat^HL70485" }),
  seg("OBR", { 1: "1", 2: "PL4001^EMR", 4: "2345-7^Glucose [Mass/volume] in Serum or Plasma^LN" }),
  seg("OBX", { 1: "1", 2: "NM", 3: "29463-7^Body weight^LN", 5: "70", 6: "kg^kilogram^UCUM", 11: "F", 14: "20261019095000-0700" }),
  seg("SPM", { 1: "1", 2: "SP4001&EMR^SF4001&LIS", 4: "SER^Serum^HL70487", 17: "20261019095500-0700" })
);
export const MDM_T02 = msg(
  "MSH|^~\\&|TRANS|HOSP|EMR|HOSP|20261019150000-0700||MDM^T02^MDM_T02|MDM-0001|P|2.5.1",
  "EVN|T02|20261019150000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  seg("PV1", { 1: "1", 2: "O", 19: "V0003^^^HOSP^VN" }),
  seg("TXA", { 1: "1", 2: "DS", 3: "TX", 6: "20261019143000-0700", 9: "1234^SMITH^ANNA", 12: "DOC5001^TRANS", 17: "AU", 18: "R", 19: "AV" }),
  seg("OBX", { 1: "1", 2: "TX", 3: "18842-5^Discharge summary^LN", 5: "Patient discharged in good condition.~Follow up in 2 weeks.", 11: "F" })
);
export const MDM_T10 = msg(
  "MSH|^~\\&|TRANS|HOSP|EMR|HOSP|20261020090000-0700||MDM^T10^MDM_T02|MDM-0002|P|2.5.1",
  "EVN|T10|20261020090000-0700",
  "PID|1||MRN12345^^^HOSP^MR||DOE^JANE||19800214|F",
  seg("PV1", { 1: "1", 2: "O", 19: "V0003^^^HOSP^VN" }),
  seg("TXA", { 1: "1", 2: "DS", 6: "20261020085500-0700", 12: "DOC5002^TRANS", 13: "DOC5001^TRANS", 17: "LA", 19: "AV" }),
  seg("OBX", { 1: "1", 2: "TX", 3: "18842-5^Discharge summary^LN", 5: "Corrected: follow up in 1 week.", 11: "F" })
);

export const ALT_DELIMS = "MSH#$*@!#RIS#HOSP#PACS#HOSP#20261019103000##ORM$O01$ORM_O01#MSG9#P#2.5.1\rPID#1##123$$$HOSP$MR##DOE$JANE";

/** Replace field n (standard numbering) of the first segment `seg` in a message. */
export function setField(message, seg, n, value) {
  return message
    .split("\r")
    .map((line) => {
      if (!line.startsWith(seg + "|")) return line;
      const parts = line.split("|");
      const idx = seg === "MSH" ? n - 1 : n;
      while (parts.length <= idx) parts.push("");
      parts[idx] = value;
      return parts.join("|");
    })
    .join("\r");
}
export const dropSegment = (message, seg) => message.split("\r").filter((l) => !l.startsWith(seg + "|")).join("\r");
