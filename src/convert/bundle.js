/** Transaction Bundle builder with stable, content-derived urn:uuid keys. */
import { createHash } from "crypto";

/** Stable urn:uuid from a logical key, so the same message always converts identically. */
export function uuidFrom(key) {
  const h = createHash("sha1").update(key).digest("hex");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function makeBundle(messageControlId) {
  const entries = [];
  const keys = new Map();
  const warnings = [];
  const notes = [];

  /**
   * Add (or fetch) a resource under a logical key. Adding the same key twice
   * merges — that is how PID and PD1 land on one Patient.
   */
  function put(key, resourceType, build, searchUrl) {
    if (keys.has(key)) return keys.get(key);
    const fullUrl = uuidFrom(`${messageControlId}|${key}`);
    const entry = {
      fullUrl,
      resource: { resourceType, ...build },
      request: searchUrl
        ? { method: "PUT", url: searchUrl }
        : { method: "POST", url: resourceType },
    };
    entries.push(entry);
    const handle = { fullUrl, entry, resource: entry.resource, reference: { reference: fullUrl } };
    keys.set(key, handle);
    return handle;
  }

  return {
    entries,
    warnings,
    notes,
    put,
    get: (key) => keys.get(key),
    warn: (message) => { if (!warnings.includes(message)) warnings.push(message); },
    note: (message) => { if (!notes.includes(message)) notes.push(message); },
    bundle: (identifier, timestamp) => ({
      resourceType: "Bundle",
      ...(identifier ? { identifier: { value: identifier } } : {}),
      type: "transaction",
      ...(timestamp ? { timestamp } : {}),
      entry: entries,
    }),
  };
}

/** Search URL for a conditional update, or undefined when no identifier qualifies. */
export const conditional = (type, identifier) =>
  identifier?.system && identifier?.value
    ? `${type}?identifier=${encodeURIComponent(identifier.system)}|${encodeURIComponent(identifier.value)}`
    : undefined;
