/**
 * Streamable HTTP transport, hardened for local and remote use:
 *  - binds to 127.0.0.1 by default; refuses a non-loopback bind without API_KEY
 *  - Host-header validation (DNS-rebinding protection) and Origin checks
 *  - no CORS unless ALLOWED_ORIGINS lists the browser origins to allow
 *  - constant-time API key comparison
 *  - idle sessions expire; the number of live sessions is capped
 */
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createServer, SERVER_NAME, VERSION } from "../server.js";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost";
}

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? "127.0.0.1",
    apiKey: env.API_KEY || env.MCP_API_KEY || "",
    allowedHosts: list(env.ALLOWED_HOSTS),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    sessionIdleMs: Number(env.SESSION_IDLE_MS ?? 30 * 60 * 1000),
    maxSessions: Number(env.MAX_SESSIONS ?? 100),
    bodyLimit: env.MAX_BODY ?? "4mb",
  };
}

function keyMatches(given, expected) {
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

const rpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Build the Express app. Returns { app, sessions, close } so tests can drive it. */
export function createApp(cfg) {
  const loopback = isLoopbackHost(cfg.host);
  if (!loopback && !cfg.apiKey) {
    throw new Error(
      `Refusing to bind to non-loopback HOST=${cfg.host} without API_KEY (or MCP_API_KEY). ` +
        "Set HOST=127.0.0.1 for local use, or set API_KEY and send Authorization: Bearer <key> (or X-API-Key). Remote deployments are for synthetic or de-identified data only."
    );
  }
  const app = express();
  app.disable("x-powered-by");

  // DNS-rebinding protection: always for a loopback bind; for other binds when ALLOWED_HOSTS is set.
  const allowedHosts = [...(loopback ? LOOPBACK_HOSTNAMES : []), ...cfg.allowedHosts];
  if (loopback || cfg.allowedHosts.length) app.use(hostHeaderValidation(allowedHosts));

  // Origin check: browsers always send Origin; reject origins that are not allowed.
  const originAllowed = (origin) => {
    if (cfg.allowedOrigins.includes(origin)) return true;
    if (!loopback) return false;
    try {
      return LOOPBACK_HOSTNAMES.includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) return rpcError(res, 403, -32000, `Origin not allowed: ${origin}`);
    next();
  });
  if (cfg.allowedOrigins.length) {
    app.use(
      cors({
        origin: cfg.allowedOrigins,
        exposedHeaders: ["Mcp-Session-Id"],
        allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
      })
    );
  }

  app.get("/health", (_req, res) => res.json({ status: "ok", server: SERVER_NAME, version: VERSION }));

  app.use((req, res, next) => {
    if (!cfg.apiKey) return next();
    const hdr = req.headers.authorization || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    const key = bearer || String(req.headers["x-api-key"] || "").trim();
    if (!key || !keyMatches(key, cfg.apiKey)) return rpcError(res, 401, -32001, "Unauthorized — send Authorization: Bearer <API_KEY> or X-API-Key");
    next();
  });
  app.use(express.json({ limit: cfg.bodyLimit }));

  /** sessionId -> { server, transport, lastSeen } */
  const sessions = new Map();
  const closeSession = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  };
  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > cfg.sessionIdleMs) closeSession(id);
  };
  const timer = setInterval(sweep, Math.max(1000, Math.min(60_000, cfg.sessionIdleMs / 2)));
  timer.unref();

  const notFound = (res) => rpcError(res, 404, -32001, "Session not found or expired. Re-initialize with POST /mcp.");
  /** Refresh a live session; a session already past its idle limit is closed, not revived. */
  const touch = (id) => {
    const s = sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > cfg.sessionIdleMs) {
      closeSession(id);
      return undefined;
    }
    s.lastSeen = Date.now();
    return s;
  };

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) {
        const entry = touch(sessionId);
        if (!entry) return notFound(res);
        return await entry.transport.handleRequest(req, res, req.body);
      }
      sweep();
      if (sessions.size >= cfg.maxSessions) return rpcError(res, 503, -32000, `Too many open sessions (${cfg.maxSessions}). Close one or retry later.`);
      // A new session gets its own server instance; one McpServer cannot back concurrent transports.
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { server, transport, lastSeen: Date.now() }),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        server.close().catch(() => {});
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("POST /mcp failed:", err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });

  const forward = (method) => async (req, res) => {
    const id = req.headers["mcp-session-id"];
    const entry = touch(id);
    if (!entry) return notFound(res);
    try {
      await entry.transport.handleRequest(req, res);
    } catch (err) {
      console.error(`${method} /mcp failed:`, err);
      if (!res.headersSent) res.status(500).end();
    } finally {
      if (method === "DELETE") closeSession(id);
    }
  };
  app.get("/mcp", forward("GET"));
  app.delete("/mcp", forward("DELETE"));

  // Malformed JSON and oversized bodies → JSON-RPC errors rather than HTML.
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.too.large") return rpcError(res, 413, -32600, `Request body exceeds ${cfg.bodyLimit}.`);
    if (err?.type === "entity.parse.failed") return rpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
    console.error(err);
    return rpcError(res, 500, -32603, "Internal server error");
  });

  const close = () => {
    clearInterval(timer);
    for (const id of [...sessions.keys()]) closeSession(id);
  };
  return { app, sessions, close };
}

export function startHttp(cfg = configFromEnv()) {
  const { app, close } = createApp(cfg);
  const httpServer = app.listen(cfg.port, cfg.host, () => {
    const where = isLoopbackHost(cfg.host) ? `http://localhost:${httpServer.address().port}` : `http://${cfg.host}:${httpServer.address().port}`;
    console.error(`HL7 v2.5.1 → FHIR MCP server listening on ${where}/mcp (bind ${cfg.host})`);
    console.error(`Health check: ${where}/health`);
    console.error(cfg.apiKey ? "API key auth enabled (Authorization: Bearer or X-API-Key)" : "No API_KEY set — acceptable only because HOST is loopback");
  });
  const shutdown = () => {
    close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return httpServer;
}
