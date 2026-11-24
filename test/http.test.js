import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { createApp, configFromEnv } from "../src/transport/http.js";

/** fetch() cannot override Host, so use node:http for the rebinding test. */
function rawPost(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function start(overrides = {}) {
  const cfg = { ...configFromEnv({}), port: 0, ...overrides };
  const { app, sessions, close } = createApp(cfg);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, base: `http://127.0.0.1:${port}`, sessions, stop: () => new Promise((r) => { close(); server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

describe("HTTP transport (loopback, no key)", { timeout: 30_000 }, () => {
  let s;
  before(async () => (s = await start()));
  after(async () => s.stop());

  test("health", async () => {
    const r = await fetch(`${s.base}/health`);
    assert.equal((await r.json()).status, "ok");
  });
  test("full MCP session over Streamable HTTP", async () => {
    const client = new Client({ name: "t", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`));
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 8);
      const r = await client.callTool({ name: "get_segment_mapping", arguments: { segment: "PID", field: 3 } });
      assert.equal(r.structuredContent.v251.dataType, "CX");
      assert.equal(s.sessions.size, 1);
      await transport.terminateSession();
    } finally {
      await client.close();
    }
    assert.equal(s.sessions.size, 0);
  });
  test("DNS rebinding: foreign Host header is rejected", async () => {
    assert.equal(await rawPost(s.port, { ...HEADERS, host: "evil.example:1234" }, JSON.stringify(INIT)), 403);
    assert.equal(await rawPost(s.port, { ...HEADERS, host: `localhost:${s.port}` }, JSON.stringify(INIT)), 200);
  });
  test("foreign Origin is rejected; localhost origin allowed", async () => {
    let r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, origin: "https://evil.example" }, body: JSON.stringify(INIT) });
    assert.equal(r.status, 403);
    r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, origin: "http://localhost:5173" }, body: JSON.stringify(INIT) });
    assert.equal(r.status, 200);
  });
  test("no CORS headers by default", async () => {
    const r = await fetch(`${s.base}/health`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
  test("unknown session is 404", async () => {
    const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, "mcp-session-id": "nope" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    assert.equal(r.status, 404);
  });
  test("malformed JSON is a JSON-RPC parse error", async () => {
    const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: HEADERS, body: "{not json" });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, -32700);
  });
});

describe("HTTP transport limits and auth", { timeout: 30_000 }, () => {
  test("refuses a non-loopback bind without an API key", () => {
    assert.throws(() => createApp({ ...configFromEnv({}), host: "0.0.0.0" }), /Refusing/);
  });
  test("API key required and compared", async () => {
    const s = await start({ apiKey: "s3cret-key" });
    try {
      let r = await fetch(`${s.base}/mcp`, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
      assert.equal(r.status, 401);
      r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, authorization: "Bearer wrong" }, body: JSON.stringify(INIT) });
      assert.equal(r.status, 401);
      r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, "x-api-key": "s3cret-key" }, body: JSON.stringify(INIT) });
      assert.equal(r.status, 200);
      r = await fetch(`${s.base}/health`);
      assert.equal(r.status, 200);
    } finally {
      await s.stop();
    }
  });
  test("CORS only for listed origins", async () => {
    const s = await start({ allowedOrigins: ["https://app.example"] });
    try {
      const r = await fetch(`${s.base}/health`, { headers: { origin: "https://app.example" } });
      assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example");
    } finally {
      await s.stop();
    }
  });
  test("idle sessions expire and the session cap applies", async () => {
    // Idle 300 ms but the sweep timer only runs every 1 s: expiry must not depend on the sweep.
    const s = await start({ sessionIdleMs: 300, maxSessions: 1 });
    try {
      let r = await fetch(`${s.base}/mcp`, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
      assert.equal(r.status, 200);
      const sid = r.headers.get("mcp-session-id");
      await r.text();
      r = await fetch(`${s.base}/mcp`, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
      assert.equal(r.status, 503);
      await new Promise((res) => setTimeout(res, 600));
      r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...HEADERS, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      assert.equal(r.status, 404);
      assert.equal(s.sessions.size, 0);
    } finally {
      await s.stop();
    }
  });
  test("oversized body is 413", async () => {
    const s = await start({ bodyLimit: "1kb" });
    try {
      const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: HEADERS, body: JSON.stringify({ ...INIT, pad: "x".repeat(4000) }) });
      assert.equal(r.status, 413);
    } finally {
      await s.stop();
    }
  });
});
