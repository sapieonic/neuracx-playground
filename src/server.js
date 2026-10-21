import { createServer } from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { CallSession } from "./call-session.js";
import * as calls from "./calls.js";
import { apiKey, PROFILES, publicConfig, resetConfig, updateConfig, VOICES } from "./config.js";
import * as db from "./db.js";
import * as hotel from "./hotel.js";
import { log } from "./log.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
// /ws is an alias for /stream.
const STREAM_PATHS = ["/stream", "/ws"];
// Optional shared secret NeuraCX must put in the stream URL (?token=...).
const STREAM_TOKEN = process.env.STREAM_TOKEN || "";
// Password for the UI and its API (basic auth, any username). Required in production.
const UI_PASSWORD = process.env.UI_PASSWORD || "";
// Most calls the server takes at once; further stream connections get 503.
const MAX_CALLS = parseInt(process.env.MAX_CALLS || "20", 10);
// Only trust X-Forwarded-For when a proxy we control (Caddy) sets it.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// NeuraCX media frames are a few KB of JSON; anything near this is not a real frame.
const MAX_FRAME_BYTES = 1024 * 1024;

if (process.env.NODE_ENV === "production" && !UI_PASSWORD) {
  log.error("UI_PASSWORD must be set when NODE_ENV=production (the UI and API would be open to anyone). Add it to .env.");
  process.exit(1);
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const app = express();

app.get("/health", (req, res) => res.json({ status: "ok", activeCalls: calls.list().active.length }));

if (UI_PASSWORD) {
  app.use((req, res, next) => {
    const [, encoded] = (req.headers.authorization || "").match(/^basic\s+(\S+)/i) || [];
    const password = encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
    if (safeEqual(password, UI_PASSWORD)) return next();
    res.set("WWW-Authenticate", 'Basic realm="neuracx-quick-enabler"').status(401).send("Authentication required");
  });
}

// Browsers can send body-less cross-site POSTs (with the saved basic-auth
// credentials) but not custom headers, so every state-changing API call must
// carry X-Requested-With. The UI's fetch wrapper adds it.
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.get("x-requested-with") === "fetch") return next();
  res.status(403).json({ error: "Missing X-Requested-With: fetch header" });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(import.meta.dirname, "../public")));

app.get("/api/config", (req, res) => {
  res.json({ config: publicConfig(), voices: VOICES, profiles: PROFILES });
});

app.put("/api/config", (req, res) => {
  const { errors, config } = updateConfig(req.body || {});
  if (errors) return res.status(400).json({ errors });
  log.info("Config updated from UI");
  res.json({ config });
});

// Body { profile } resets only that use case; no body resets everything but the API key.
app.post("/api/config/reset", (req, res) => {
  const profile = req.body?.profile;
  if (profile !== undefined && !PROFILES.some((p) => p.id === profile)) {
    return res.status(400).json({ error: "Unknown profile" });
  }
  log.info(profile ? `Config for ${profile} reset to defaults from UI` : "Config reset to defaults from UI");
  res.json({ config: profile ? resetConfig(profile) : resetConfig() });
});

// ── hotel (Taj Dubai demo) ──────────────────────────────────────────────────

app.get("/api/hotel/rooms", (req, res) => res.json({ rooms: hotel.listRooms() }));

app.put("/api/hotel/rooms", (req, res) => {
  const rooms = req.body?.rooms;
  const errors = Array.isArray(rooms) ? hotel.validateRooms(rooms) : ["rooms must be a list."];
  if (errors.length) return res.status(400).json({ errors });
  hotel.replaceRooms(rooms);
  log.info(`Hotel rooms updated from UI (${rooms.length})`);
  res.json({ rooms: hotel.listRooms() });
});

app.post("/api/hotel/rooms/reset", (req, res) => {
  log.info("Hotel rooms reset to the demo set from UI");
  res.json({ rooms: hotel.resetRooms() });
});

const RESERVATION_FILTERS = ["all", "booked", "cancelled"];

app.get("/api/hotel/reservations", (req, res) => {
  const status = req.query.status ?? "all";
  if (!RESERVATION_FILTERS.includes(status)) {
    return res.status(400).json({ error: `status must be ${RESERVATION_FILTERS.join(", ")}` });
  }
  res.json({ reservations: hotel.listReservations({ status }) });
});

app.post("/api/hotel/reservations/:code/cancel", (req, res) => {
  const reservation = hotel.cancelReservation(req.params.code, { by: "ui" });
  if (!reservation) return res.status(404).json({ error: "No reservation with that confirmation number" });
  log.info(`Reservation ${reservation.confirmation_number} cancelled from UI`);
  res.json({ reservation });
});

app.get("/api/info", (req, res) => {
  res.json({ streamPaths: STREAM_PATHS, streamToken: STREAM_TOKEN, apiKeySet: Boolean(apiKey()) });
});

app.get("/api/calls", (req, res) => res.json(calls.list()));

app.get("/api/calls/:id", (req, res) => {
  const call = calls.details(req.params.id);
  if (!call) return res.status(404).json({ error: "No call with that id" });
  res.json({ call });
});

app.post("/api/calls/:id/hangup", (req, res) => {
  const session = calls.get(req.params.id);
  if (!session) return res.status(404).json({ error: "No active call with that id" });
  session.hangup("hung up from the UI");
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  // Some browsers (Firefox) only fire EventSource "open", which the UI loads its
  // data on, once the first bytes arrive.
  res.write(": connected\n\n");
  const forward = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  calls.events.on("event", forward);
  req.on("close", () => {
    clearInterval(ping);
    calls.events.off("event", forward);
  });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Bad JSON bodies, oversized bodies and anything thrown in a handler end up
// here. Errors go to the log; the response never includes a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error(`${req.method} ${req.path} failed:`, err);
  const message = status < 500 && err.expose ? err.message : status < 500 ? "Bad request" : "Internal server error";
  res.status(status).json({ error: message });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
let shuttingDown = false;

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (!STREAM_PATHS.includes(url.pathname)) return reject(socket, "404 Not Found");
  if (STREAM_TOKEN && !safeEqual(url.searchParams.get("token") || "", STREAM_TOKEN)) {
    log.warn(`Rejected stream connection from ${req.socket.remoteAddress}: bad or missing token`);
    return reject(socket, "401 Unauthorized");
  }
  if (shuttingDown || wss.clients.size >= MAX_CALLS) {
    log.warn(`Rejected stream connection from ${req.socket.remoteAddress}: ${shuttingDown ? "shutting down" : `already at MAX_CALLS (${MAX_CALLS})`}`);
    return reject(socket, "503 Service Unavailable");
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const forwarded = TRUST_PROXY && req.headers["x-forwarded-for"]?.split(",")[0].trim();
    const remote = forwarded || req.socket.remoteAddress;
    const source = url.searchParams.get("source") === "browser" ? "browser" : "telephony";
    try {
      new CallSession(ws, { source, remote });
    } catch (e) {
      // e.g. the database is unavailable; drop this call rather than the server.
      log.error(`Could not start call session: ${e.stack || e}`);
      ws.close(1011);
    }
  });
});

const interrupted = db.closeInterruptedCalls();
if (interrupted) log.warn(`Marked ${interrupted} call(s) left open by the last run as ended`);

server.listen(PORT, () => {
  const cfg = publicConfig();
  const profile = cfg.profiles[cfg.activeProfile];
  log.info(`Database: ${db.dbPath}`);
  log.info(`Listening on http://localhost:${server.address().port}`);
  log.info(`NeuraCX stream URL: wss://<public-host>/stream${STREAM_TOKEN ? "?token=<STREAM_TOKEN>" : ""}`);
  log.info(`Use case ${profile.name}, model ${cfg.model}, voice ${profile.voice}, Gemini key ${apiKey() ? "set" : "NOT set (add it in the UI or .env)"}`);
  if (!UI_PASSWORD) log.warn("UI_PASSWORD is not set, so anyone who can reach this server can change the bot.");
});

// Ctrl+C locally, `docker stop` in Docker: send exit on live calls so NeuraCX
// drops them cleanly, then stop.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  for (const call of calls.list().active) calls.get(call.id)?.hangup("server shutting down");
  server.close();
  setTimeout(() => {
    // Closing the sockets lets each call record its end in the database.
    for (const ws of wss.clients) ws.terminate();
    setTimeout(() => process.exit(0), 200);
  }, 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
