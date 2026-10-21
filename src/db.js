import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { profileName } from "./profiles.js";

const DB_PATH = process.env.DB_PATH || path.resolve("data/voicebot.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

// The schema as it was before versioning (migration 1). Later changes are
// further migrations, so don't edit this.
const BASELINE = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applicants (
    application_number TEXT PRIMARY KEY,
    applicant_name     TEXT NOT NULL DEFAULT '',
    date_of_birth      TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT '',
    status_date        TEXT NOT NULL DEFAULT '',
    status_detail      TEXT NOT NULL DEFAULT '',
    action_message     TEXT NOT NULL DEFAULT '',
    simulate_api_error INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS calls (
    id                TEXT PRIMARY KEY,
    source            TEXT NOT NULL,
    remote            TEXT,
    status            TEXT NOT NULL,
    room_id           TEXT,
    call_id           TEXT,
    cli               TEXT,
    dni               TEXT,
    custom_parameters TEXT NOT NULL DEFAULT '{}',
    model             TEXT,
    voice             TEXT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    end_reason        TEXT
  );

  CREATE TABLE IF NOT EXISTS transcript (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL,
    at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    level   TEXT NOT NULL,
    text    TEXT NOT NULL,
    at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outcomes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id            TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    application_number TEXT,
    outcome            TEXT NOT NULL,
    notes              TEXT NOT NULL DEFAULT '',
    follow_up_date     TEXT,
    at                 TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS transcript_call ON transcript(call_id, id);
  CREATE INDEX IF NOT EXISTS events_call ON call_events(call_id, id);
  CREATE INDEX IF NOT EXISTS outcomes_call ON outcomes(call_id, id);
  CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at);
`;

// Room types the hotel demo starts with (and goes back to on reset). DEMO
// DATA: made-up rooms and rates, to be replaced with the hotel's own.
export const DEMO_ROOMS = [
  { code: "DLX", name: "Deluxe Room", description: "Demo room type: a standard room for up to two guests.", max_guests: 2, nightly_rate_aed: 950, inventory: 20 },
  { code: "PRM", name: "Premier Room", description: "Demo room type: a larger room for up to three guests.", max_guests: 3, nightly_rate_aed: 1250, inventory: 12 },
  { code: "STE", name: "Luxury Suite", description: "Demo room type: a suite with a separate living area.", max_guests: 4, nightly_rate_aed: 2400, inventory: 5 },
  { code: "PRS", name: "Presidential Suite", description: "Demo room type: the largest suite.", max_guests: 4, nightly_rate_aed: 9000, inventory: 1 },
];

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Ordered schema changes; PRAGMA user_version records how many have run.
// Append new ones at the end and never edit one that has shipped.
const MIGRATIONS = [
  // 1: the schema as it was before versioning.
  () => db.exec(BASELINE),
  // 2: the bot became a general FAQ line, so test applicants and per-application
  // outcomes went away.
  () => {
    db.exec("DROP TABLE IF EXISTS applicants");
    db.exec("DELETE FROM settings WHERE key = 'applicantsSeeded'");
    for (const column of ["application_number", "follow_up_date"]) {
      if (hasColumn("outcomes", column)) db.exec(`ALTER TABLE outcomes DROP COLUMN ${column}`);
    }
  },
  // 3: switchable bot profiles (each call records which one it used), and the
  // hotel demo's room types and reservations. Reservations keep the room's
  // code and name as booked, so room types can be replaced freely.
  () => {
    if (!hasColumn("calls", "profile")) db.exec("ALTER TABLE calls ADD COLUMN profile TEXT NOT NULL DEFAULT 'golden_visa'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_types (
        code             TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        max_guests       INTEGER NOT NULL,
        nightly_rate_aed REAL NOT NULL,
        inventory        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        confirmation_number TEXT PRIMARY KEY,
        guest_name          TEXT NOT NULL,
        phone               TEXT NOT NULL,
        check_in            TEXT NOT NULL,
        check_out           TEXT NOT NULL,
        nights              INTEGER NOT NULL,
        guests              INTEGER NOT NULL,
        room_code           TEXT NOT NULL,
        room_name           TEXT NOT NULL,
        total_aed           REAL NOT NULL,
        special_requests    TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'booked',
        call_id             TEXT,
        created_at          TEXT NOT NULL,
        cancelled_at        TEXT,
        cancelled_by        TEXT
      );

      CREATE INDEX IF NOT EXISTS reservations_room ON reservations(room_code, status, check_in);
      CREATE INDEX IF NOT EXISTS reservations_created ON reservations(created_at);
    `);
    if (db.prepare("SELECT COUNT(*) AS n FROM room_types").get().n === 0) {
      const insert = db.prepare(
        "INSERT INTO room_types (code, name, description, max_guests, nightly_rate_aed, inventory) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of DEMO_ROOMS) insert.run(r.code, r.name, r.description, r.max_guests, r.nightly_rate_aed, r.inventory);
    }
  },
];

function migrate() {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const run of MIGRATIONS.slice(version)) run();
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

migrate();

export const dbPath = DB_PATH;

// Runs `fn` (synchronous) in one write transaction and returns its result.
// Not for use inside another transaction.
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── settings ────────────────────────────────────────────────────────────────

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const putSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function readSetting(key) {
  const row = getSetting.get(key);
  return row ? JSON.parse(row.value) : undefined;
}

export function writeSetting(key, value) {
  putSetting.run(key, JSON.stringify(value));
}

// ── calls ───────────────────────────────────────────────────────────────────

// Calls from before profiles existed were all Golden Visa calls.
const DEFAULT_PROFILE = "golden_visa";

const insertCallRow = db.prepare(
  `INSERT INTO calls (id, source, remote, status, model, voice, profile, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const updateCallRow = db.prepare(
  `UPDATE calls SET status = ?, room_id = ?, call_id = ?, cli = ?, dni = ?, custom_parameters = ?,
     ended_at = ?, end_reason = ?, profile = ? WHERE id = ?`,
);
const insertTranscript = db.prepare("INSERT INTO transcript (call_id, role, text, at) VALUES (?, ?, ?, ?)");
const updateTranscript = db.prepare("UPDATE transcript SET text = ? WHERE id = ?");
const insertCallEvent = db.prepare("INSERT INTO call_events (call_id, level, text, at) VALUES (?, ?, ?, ?)");
const insertOutcome = db.prepare("INSERT INTO outcomes (call_id, outcome, notes, at) VALUES (?, ?, ?, ?)");

export function insertCall(info) {
  insertCallRow.run(
    info.id,
    info.source,
    info.remote,
    info.status,
    info.model,
    info.voice,
    info.profile || DEFAULT_PROFILE,
    info.startedAt,
  );
}

export function updateCall(info) {
  updateCallRow.run(
    info.status,
    info.roomId,
    info.callId == null ? null : String(info.callId),
    info.cli,
    info.dni,
    JSON.stringify(info.customParameters || {}),
    info.endedAt,
    info.endReason,
    info.profile || DEFAULT_PROFILE,
    info.id,
  );
}

export function addTranscript(callId, entry) {
  return Number(insertTranscript.run(callId, entry.role, entry.text, entry.at).lastInsertRowid);
}

export function updateTranscriptText(rowId, text) {
  updateTranscript.run(text, rowId);
}

export function addCallEvent(callId, entry) {
  insertCallEvent.run(callId, entry.level, entry.text, entry.at);
}

export function addOutcome(callId, entry) {
  insertOutcome.run(callId, entry.outcome, entry.notes || "", entry.at);
}

function toCallInfo(row) {
  return {
    id: row.id,
    source: row.source,
    remote: row.remote,
    status: row.status,
    roomId: row.room_id,
    callId: row.call_id,
    cli: row.cli,
    dni: row.dni,
    customParameters: JSON.parse(row.custom_parameters || "{}"),
    model: row.model,
    voice: row.voice,
    profile: row.profile,
    profileName: profileName(row.profile),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

// Finished calls without transcripts, newest first.
export function recentCalls(limit = 50) {
  return db
    .prepare(
      `SELECT calls.*, (SELECT outcome FROM outcomes o WHERE o.call_id = calls.id ORDER BY o.id DESC LIMIT 1) AS last_outcome
       FROM calls WHERE status = 'ended' ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ ...toCallInfo(row), lastOutcome: row.last_outcome }));
}

export function getCall(id) {
  const row = db.prepare("SELECT * FROM calls WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...toCallInfo(row),
    transcript: db.prepare("SELECT role, text, at FROM transcript WHERE call_id = ? ORDER BY id").all(id),
    log: db.prepare("SELECT level, text, at FROM call_events WHERE call_id = ? ORDER BY id").all(id),
    outcomes: db.prepare("SELECT outcome, notes, at FROM outcomes WHERE call_id = ? ORDER BY id").all(id),
  };
}

// Calls that were live when the server last stopped can't be resumed.
export function closeInterruptedCalls() {
  return db
    .prepare("UPDATE calls SET status = 'ended', ended_at = ?, end_reason = 'server restarted' WHERE status != 'ended'")
    .run(new Date().toISOString()).changes;
}

// ── hotel demo: room types and reservations ─────────────────────────────────

const plain = (row) => (row ? { ...row } : null);

const selectRooms = db.prepare(
  `SELECT code, name, description, max_guests, nightly_rate_aed, inventory FROM room_types
   ORDER BY nightly_rate_aed, code`,
);
const selectRoom = db.prepare(
  "SELECT code, name, description, max_guests, nightly_rate_aed, inventory FROM room_types WHERE code = ?",
);
const deleteRooms = db.prepare("DELETE FROM room_types");
const insertRoom = db.prepare(
  "INSERT INTO room_types (code, name, description, max_guests, nightly_rate_aed, inventory) VALUES (?, ?, ?, ?, ?, ?)",
);
const RESERVATION_COLUMNS = `confirmation_number, guest_name, phone, check_in, check_out, nights, guests, room_code,
  room_name, total_aed, special_requests, status, call_id, created_at, cancelled_at, cancelled_by`;
const selectReservation = db.prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE confirmation_number = ?`);
const selectReservations = db.prepare(
  `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE (? = 'all' OR status = ?)
   ORDER BY created_at DESC, rowid DESC LIMIT ?`,
);
// Booked stays of one room type that share at least one night with [from, to).
const selectOverlapping = db.prepare(
  `SELECT check_in, check_out FROM reservations
   WHERE room_code = ? AND status = 'booked' AND check_in < ? AND check_out > ?`,
);
const insertReservationRow = db.prepare(
  `INSERT INTO reservations (confirmation_number, guest_name, phone, check_in, check_out, nights, guests, room_code,
     room_name, total_aed, special_requests, status, call_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
);
const cancelReservationRow = db.prepare(
  `UPDATE reservations SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
   WHERE confirmation_number = ? AND status = 'booked'`,
);

export function listRoomTypes() {
  return selectRooms.all().map(plain);
}

export function getRoomType(code) {
  return plain(selectRoom.get(code));
}

// Swaps all room types for `rooms` in one go. Reservations are untouched.
export function replaceRoomTypes(rooms) {
  transaction(() => {
    deleteRooms.run();
    for (const r of rooms) insertRoom.run(r.code, r.name, r.description, r.max_guests, r.nightly_rate_aed, r.inventory);
  });
}

export function getReservation(confirmationNumber) {
  return plain(selectReservation.get(confirmationNumber));
}

export function listReservations(status, limit) {
  return selectReservations.all(status, status, limit).map(plain);
}

export function overlappingStays(roomCode, from, to) {
  return selectOverlapping.all(roomCode, to, from).map(plain);
}

export function insertReservation(r) {
  insertReservationRow.run(
    r.confirmation_number,
    r.guest_name,
    r.phone,
    r.check_in,
    r.check_out,
    r.nights,
    r.guests,
    r.room_code,
    r.room_name,
    r.total_aed,
    r.special_requests,
    r.call_id,
    r.created_at,
  );
}

// Returns whether a booked reservation was cancelled.
export function markReservationCancelled(confirmationNumber, at, by) {
  return cancelReservationRow.run(at, by, confirmationNumber).changes > 0;
}
