import { randomInt } from "node:crypto";
import * as calls from "./calls.js";
import * as db from "./db.js";

// Room types and reservations for the hotel reservations demo (the taj_dubai
// profile). The rooms, rates and bookings are demo data in SQLite; none of it
// comes from a real booking system.
//
// The functions the bot's tools call never throw on bad input: they return
// { error: "<code>", ...detail } in a form the model can explain to the caller.

const DAY_MS = 86400000;
const DEFAULT_TIMEZONE = "Asia/Dubai";
export const MAX_NIGHTS = 30;
export const MAX_GUESTS = 10;
// Confirmation numbers avoid 0/O and 1/I, which are easy to mix up on the phone.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const STATUSES = ["all", "booked", "cancelled"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const round2 = (n) => Math.round(n * 100) / 100;
const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

// ── dates ───────────────────────────────────────────────────────────────────

// "YYYY-MM-DD" of a real calendar date → days since 1970-01-01, else null.
function dayNumber(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const date = new Date(t);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

const dateOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// Today's date where the hotel is.
function today(now, timezone) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  let format;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: timezone || DEFAULT_TIMEZONE });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: DEFAULT_TIMEZONE });
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Whole numbers may arrive from the model as numbers or numeric strings.
function toInt(v) {
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v);
  return Number.isInteger(v) ? v : null;
}

// Checks the dates and guests of a stay: { check_in, check_out, nights, guests, firstDay } or { error }.
function checkStay({ check_in, check_out, guests, now, timezone } = {}) {
  const inDay = dayNumber(check_in);
  if (inDay === null) return { error: "invalid_check_in", expected: "YYYY-MM-DD" };
  const outDay = dayNumber(check_out);
  if (outDay === null) return { error: "invalid_check_out", expected: "YYYY-MM-DD" };
  const todayStr = today(now, timezone);
  if (inDay < dayNumber(todayStr)) return { error: "check_in_in_past", today: todayStr };
  if (outDay <= inDay) return { error: "check_out_not_after_check_in" };
  const nights = outDay - inDay;
  if (nights > MAX_NIGHTS) return { error: "stay_too_long", max_nights: MAX_NIGHTS };
  const n = toInt(guests);
  if (n === null || n < 1 || n > MAX_GUESTS) return { error: "invalid_guests", min: 1, max: MAX_GUESTS };
  return { check_in, check_out, nights, guests: n, firstDay: inDay };
}

// ── availability ────────────────────────────────────────────────────────────

// Free for the stay if, on every night, fewer than `inventory` booked stays of
// this room type cover that night.
function isAvailable(room, stay) {
  if (room.inventory <= 0) return false;
  const stays = db.overlappingStays(room.code, stay.check_in, stay.check_out);
  if (stays.length < room.inventory) return true;
  for (let i = 0; i < stay.nights; i++) {
    const night = dateOf(stay.firstDay + i);
    const taken = stays.filter((s) => s.check_in <= night && s.check_out > night).length;
    if (taken >= room.inventory) return false;
  }
  return true;
}

const roomCode = (v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);

function option(room, stay) {
  return {
    room_code: room.code,
    room: room.name,
    max_guests: room.max_guests,
    nightly_rate_aed: room.nightly_rate_aed,
    total_aed: round2(room.nightly_rate_aed * stay.nights),
  };
}

// For the check_availability tool. `now` and `timezone` (the hotel's) decide
// what "today" is. Returns the stay and the room types free for it that fit
// the guests (cheapest first), or { error }. With room_code, says whether
// that room is free and offers the others if not.
export function checkAvailability({ check_in, check_out, guests, room_code, now, timezone } = {}) {
  const stay = checkStay({ check_in, check_out, guests, now, timezone });
  if (stay.error) return stay;
  const rooms = db.listRoomTypes();
  const code = roomCode(room_code);
  if (code) {
    const room = rooms.find((r) => r.code === code);
    if (!room) return { error: "unknown_room_code", room_codes: rooms.map((r) => r.code) };
    if (stay.guests > room.max_guests) return { error: "too_many_guests_for_room", max_guests: room.max_guests };
  }
  const largest = Math.max(0, ...rooms.map((r) => r.max_guests));
  if (stay.guests > largest) return { error: "too_many_guests", max_guests_per_room: largest };

  const options = rooms.filter((r) => stay.guests <= r.max_guests && isAvailable(r, stay)).map((r) => option(r, stay));
  const base = { check_in: stay.check_in, check_out: stay.check_out, nights: stay.nights, guests: stay.guests };
  if (!code) return { ...base, options };
  const requested = options.find((o) => o.room_code === code);
  return requested
    ? { ...base, requested_room_available: true, options: [requested] }
    : { ...base, requested_room_available: false, options };
}

// ── confirmation numbers and names ──────────────────────────────────────────

function newConfirmationNumber() {
  for (;;) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const number = `TAJ-${code}`;
    if (!db.getReservation(number)) return number;
  }
}

// Accepts "TAJ-4K7P2X", "taj 4k7 p2x" or just "4K7P2X". Null if it can't be one.
function normalizeConfirmation(v) {
  if (typeof v !== "string") return null;
  let s = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === CODE_LENGTH + 3 && s.startsWith("TAJ")) s = s.slice(3);
  return s.length === CODE_LENGTH ? `TAJ-${s}` : null;
}

const nameTokens = (s) =>
  clean(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// The caller's surname or full name matches the name on the booking: every
// word they gave is in it, including its last word (the surname).
function nameMatches(given, stored) {
  const g = nameTokens(given);
  const s = nameTokens(stored);
  return g.length > 0 && s.length > 0 && g.every((t) => s.includes(t)) && g.includes(s.at(-1));
}

// ── reservations ────────────────────────────────────────────────────────────

function checkGuest({ guest_name, phone, special_requests }) {
  const name = clean(guest_name);
  if (name.length < 2 || name.length > 100 || !/\p{L}/u.test(name)) return { error: "invalid_guest_name" };
  const tel = clean(phone);
  if (!/^[0-9+ ]{6,20}$/.test(tel) || tel.replace(/\D/g, "").length < 6) return { error: "invalid_phone" };
  const requests = special_requests == null ? "" : clean(special_requests);
  if (requests.length > 500) return { error: "special_requests_too_long", max_characters: 500 };
  return { guest_name: name, phone: tel, special_requests: requests };
}

// For the create_reservation tool. Re-checks availability and books in one
// transaction, so two calls can't both take the last room. Returns
// { reservation } or { error }.
export function createReservation(args = {}, callId = null) {
  const stay = checkStay(args);
  if (stay.error) return stay;
  const code = roomCode(args.room_code);
  if (!code) return { error: "missing_room_code" };
  const guest = checkGuest(args);
  if (guest.error) return guest;

  const result = db.transaction(() => {
    const room = db.getRoomType(code);
    if (!room) return { error: "unknown_room_code", room_codes: db.listRoomTypes().map((r) => r.code) };
    if (stay.guests > room.max_guests) return { error: "too_many_guests_for_room", max_guests: room.max_guests };
    if (!isAvailable(room, stay)) return { error: "room_not_available" };
    const confirmation_number = newConfirmationNumber();
    db.insertReservation({
      confirmation_number,
      ...guest,
      check_in: stay.check_in,
      check_out: stay.check_out,
      nights: stay.nights,
      guests: stay.guests,
      room_code: room.code,
      room_name: room.name,
      total_aed: round2(room.nightly_rate_aed * stay.nights),
      call_id: callId == null ? null : String(callId),
      created_at: new Date().toISOString(),
    });
    return { reservation: db.getReservation(confirmation_number) };
  });
  if (result.reservation) calls.emit("reservation.changed", { reservation: result.reservation });
  return result;
}

// For the find_reservation tool: needs the confirmation number and the name
// on the booking. A wrong number and a wrong name both give "not_found".
export function findReservation(confirmation_number, guest_name) {
  if (typeof confirmation_number !== "string" || !confirmation_number.trim()) {
    return { error: "missing_confirmation_number" };
  }
  if (!nameTokens(guest_name).length) return { error: "missing_guest_name" };
  const number = normalizeConfirmation(confirmation_number);
  const reservation = number && db.getReservation(number);
  if (!reservation || !nameMatches(guest_name, reservation.guest_name)) return { error: "not_found" };
  return { reservation };
}

// For the cancel_reservation tool: the same checks as findReservation.
// Returns { reservation, already_cancelled } or { error }.
export function cancelGuestReservation(confirmation_number, guest_name, { by = "bot" } = {}) {
  const found = findReservation(confirmation_number, guest_name);
  if (found.error) return found;
  if (found.reservation.status === "cancelled") return { reservation: found.reservation, already_cancelled: true };
  return { reservation: cancelReservation(found.reservation.confirmation_number, { by }), already_cancelled: false };
}

// Cancels a booking (e.g. from the UI). Returns the reservation, unchanged if
// it was already cancelled, or null if there is no such booking.
export function cancelReservation(confirmationNumber, { by = null } = {}) {
  const number = normalizeConfirmation(confirmationNumber);
  if (!number) return null;
  const cancelled = db.markReservationCancelled(number, new Date().toISOString(), by == null ? null : String(by));
  const reservation = db.getReservation(number);
  if (cancelled && reservation) calls.emit("reservation.changed", { reservation });
  return reservation;
}

// Newest first. `status` is "all", "booked" or "cancelled".
export function listReservations({ status = "all", limit = 200 } = {}) {
  const which = STATUSES.includes(status) ? status : "all";
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
  return db.listReservations(which, n);
}

// ── room types ──────────────────────────────────────────────────────────────

// Cheapest first.
export function listRooms() {
  return db.listRoomTypes();
}

// Checks a full list of room types. Never throws; returns error messages.
export function validateRooms(list) {
  if (!Array.isArray(list)) return ["Rooms must be a list."];
  if (!list.length) return ["Add at least one room type."];
  if (list.length > 50) return ["At most 50 room types."];
  const errors = [];
  const seen = new Set();
  list.forEach((room, i) => {
    if (!isObject(room)) {
      errors.push(`Room ${i + 1} must be an object.`);
      return;
    }
    const code = room.code;
    const label = typeof code === "string" && code ? `Room ${code.slice(0, 12)}` : `Room ${i + 1}`;
    if (typeof code !== "string" || !/^[A-Z0-9_]{2,12}$/.test(code)) {
      errors.push(`${label}: code must be 2 to 12 uppercase letters, digits or underscores.`);
    } else if (seen.has(code)) {
      errors.push(`${label}: code is used more than once.`);
    } else {
      seen.add(code);
    }
    if (typeof room.name !== "string" || !room.name.trim() || room.name.length > 100) {
      errors.push(`${label}: name is required (up to 100 characters).`);
    }
    if (room.description != null && !(typeof room.description === "string" && room.description.length <= 500)) {
      errors.push(`${label}: description must be text, up to 500 characters.`);
    }
    if (!(Number.isInteger(room.max_guests) && room.max_guests >= 1 && room.max_guests <= MAX_GUESTS)) {
      errors.push(`${label}: max guests must be a whole number from 1 to ${MAX_GUESTS}.`);
    }
    const rate = room.nightly_rate_aed;
    if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= 1000000)) {
      errors.push(`${label}: nightly rate must be a number of AED above 0.`);
    }
    if (!(Number.isInteger(room.inventory) && room.inventory >= 0 && room.inventory <= 500)) {
      errors.push(`${label}: inventory must be a whole number from 0 to 500.`);
    }
  });
  return errors;
}

// Replaces all room types. Existing reservations keep the room code and name
// they were booked with. Throws if the list is invalid, so check it with
// validateRooms first. Returns listRooms().
export function replaceRooms(list) {
  const errors = validateRooms(list);
  if (errors.length) throw new Error(`Invalid rooms: ${errors.join(" ")}`);
  db.replaceRoomTypes(
    list.map((r) => ({
      code: r.code,
      name: r.name.trim(),
      description: (r.description ?? "").trim(),
      max_guests: r.max_guests,
      nightly_rate_aed: r.nightly_rate_aed,
      inventory: r.inventory,
    })),
  );
  return listRooms();
}

// Back to the demo room types. Returns listRooms().
export function resetRooms() {
  db.replaceRoomTypes(db.DEMO_ROOMS);
  return listRooms();
}
