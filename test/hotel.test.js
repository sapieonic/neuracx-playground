import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.js opens the database on import, so point it at a temp file first.
const dir = mkdtempSync(path.join(tmpdir(), "ncx-hotel-"));
process.env.DB_PATH = path.join(dir, "test.db");
const hotel = await import("../src/hotel.js");
const calls = await import("../src/calls.js");
after(() => rmSync(dir, { recursive: true, force: true }));

// Midday on 21 October 2026 in Dubai.
const now = new Date("2026-10-21T08:00:00Z");
const tz = "Asia/Dubai";
const stay = (check_in, check_out, guests = 2, extra = {}) => ({ check_in, check_out, guests, now, timezone: tz, ...extra });
const guest = { guest_name: "Priya Sharma", phone: "+971 50 123 4567" };
const book = (room_code, check_in, check_out, extra = {}) =>
  hotel.createReservation({ ...stay(check_in, check_out, 1), room_code, ...guest, ...extra }, "call-1");
const codes = (result) => result.options.map((o) => o.room_code);

const changes = [];
calls.events.on("event", (e) => e.type === "reservation.changed" && changes.push(e.reservation));

beforeEach(() => hotel.resetRooms());

test("the demo rooms are seeded, cheapest first", () => {
  assert.deepEqual(
    hotel.listRooms().map((r) => [r.code, r.name, r.max_guests, r.nightly_rate_aed, r.inventory]),
    [
      ["DLX", "Deluxe Room", 2, 950, 20],
      ["PRM", "Premier Room", 3, 1250, 12],
      ["STE", "Luxury Suite", 4, 2400, 5],
      ["PRS", "Presidential Suite", 4, 9000, 1],
    ],
  );
  for (const r of hotel.listRooms()) assert.match(r.description, /^Demo/);
});

test("availability lists the rooms that fit, with the price for the stay", () => {
  const result = hotel.checkAvailability(stay("2026-11-01", "2026-11-04", 2));
  assert.deepEqual(result, {
    check_in: "2026-11-01",
    check_out: "2026-11-04",
    nights: 3,
    guests: 2,
    options: [
      { room_code: "DLX", room: "Deluxe Room", max_guests: 2, nightly_rate_aed: 950, total_aed: 2850 },
      { room_code: "PRM", room: "Premier Room", max_guests: 3, nightly_rate_aed: 1250, total_aed: 3750 },
      { room_code: "STE", room: "Luxury Suite", max_guests: 4, nightly_rate_aed: 2400, total_aed: 7200 },
      { room_code: "PRS", room: "Presidential Suite", max_guests: 4, nightly_rate_aed: 9000, total_aed: 27000 },
    ],
  });
  assert.deepEqual(codes(hotel.checkAvailability(stay("2026-11-01", "2026-11-02", 3))), ["PRM", "STE", "PRS"]);
  assert.deepEqual(hotel.checkAvailability(stay("2026-11-01", "2026-11-02", 5)), { error: "too_many_guests", max_guests_per_room: 4 });

  const one = hotel.checkAvailability(stay("2026-11-01", "2026-11-02", "2", { room_code: " ste " }));
  assert.equal(one.requested_room_available, true);
  assert.deepEqual(codes(one), ["STE"]);
  assert.equal(one.guests, 2, "a numeric string is fine");
  assert.deepEqual(hotel.checkAvailability(stay("2026-11-01", "2026-11-02", 3, { room_code: "DLX" })), {
    error: "too_many_guests_for_room",
    max_guests: 2,
  });
  assert.equal(hotel.checkAvailability(stay("2026-11-01", "2026-11-02", 2, { room_code: "NOPE" })).error, "unknown_room_code");
});

test("dates and guests are validated", () => {
  const error = (args) => hotel.checkAvailability(args).error;
  for (const bad of ["2026-02-30", "2026-13-01", "2026/11/01", "1 Nov 2026", "", null, 20261101, undefined]) {
    assert.equal(error(stay(bad, "2026-11-05")), "invalid_check_in", String(bad));
    assert.equal(error(stay("2026-11-01", bad)), "invalid_check_out", String(bad));
  }
  assert.equal(error(stay("2026-11-03", "2026-11-03")), "check_out_not_after_check_in");
  assert.equal(error(stay("2026-11-03", "2026-11-01")), "check_out_not_after_check_in");
  assert.equal(error(stay("2026-11-01", "2026-12-01")), undefined, "30 nights is fine");
  assert.deepEqual(hotel.checkAvailability(stay("2026-11-01", "2026-12-02")), { error: "stay_too_long", max_nights: 30 });
  for (const guests of [0, 11, -1, 1.5, "two", null, undefined]) {
    assert.equal(error({ ...stay("2026-11-01", "2026-11-02"), guests }), "invalid_guests", String(guests));
  }
  assert.equal(error(stay("2028-02-28", "2028-03-01")), undefined, "a leap day is a real date");
  assert.doesNotThrow(() => hotel.checkAvailability());
  assert.equal(hotel.checkAvailability().error, "invalid_check_in");
});

test("past dates are judged in the hotel's timezone", () => {
  // 21:30 UTC on 21 October is already 22 October in Dubai.
  const late = new Date("2026-10-21T21:30:00Z");
  assert.deepEqual(hotel.checkAvailability({ ...stay("2026-10-21", "2026-10-23"), now: late }), {
    error: "check_in_in_past",
    today: "2026-10-22",
  });
  assert.equal(hotel.checkAvailability({ ...stay("2026-10-22", "2026-10-23"), now: late }).error, undefined, "today is fine");
  assert.equal(
    hotel.checkAvailability({ ...stay("2026-10-21", "2026-10-23"), now: late, timezone: "UTC" }).error,
    undefined,
    "still the 21st in UTC",
  );
  assert.equal(hotel.checkAvailability({ ...stay("2026-10-20", "2026-10-23") }).error, "check_in_in_past");
  assert.equal(hotel.createReservation({ ...stay("2026-10-20", "2026-10-23"), room_code: "DLX", ...guest }).error, "check_in_in_past");
});

test("the last room: overlapping stays are refused, back-to-back ones are not, and cancelling frees it", () => {
  const first = book("PRS", "2026-12-10", "2026-12-12");
  assert.ok(first.reservation, JSON.stringify(first));
  const prs = (i, o) => hotel.checkAvailability(stay(i, o, 1, { room_code: "PRS" }));

  for (const [i, o] of [["2026-12-11", "2026-12-13"], ["2026-12-09", "2026-12-11"], ["2026-12-08", "2026-12-15"], ["2026-12-10", "2026-12-12"]]) {
    const result = prs(i, o);
    assert.equal(result.requested_room_available, false, `${i} to ${o}`);
    assert.ok(!codes(result).includes("PRS"));
    assert.ok(codes(result).includes("STE"), "other rooms are offered instead");
  }
  assert.equal(prs("2026-12-12", "2026-12-14").requested_room_available, true, "check-in on the day the last guest leaves");
  assert.equal(prs("2026-12-08", "2026-12-10").requested_room_available, true, "leave on the day the next guest arrives");

  assert.deepEqual(book("PRS", "2026-12-11", "2026-12-13"), { error: "room_not_available" });
  assert.ok(book("PRS", "2026-12-12", "2026-12-13").reservation);

  hotel.cancelReservation(first.reservation.confirmation_number, { by: "test" });
  assert.equal(prs("2026-12-10", "2026-12-12").requested_room_available, true, "a cancelled booking frees the room");
});

test("a room is free only if every night of the stay has one left", () => {
  hotel.replaceRooms([{ code: "TWIN", name: "Twin", max_guests: 2, nightly_rate_aed: 100, inventory: 2 }]);
  const twin = (i, o) => hotel.checkAvailability(stay(i, o, 1)).options.length === 1;
  assert.ok(book("TWIN", "2027-01-01", "2027-01-03").reservation);
  assert.ok(book("TWIN", "2027-01-02", "2027-01-04").reservation);
  // Only the night of the 2nd is full.
  assert.equal(twin("2027-01-01", "2027-01-02"), true);
  assert.equal(twin("2027-01-02", "2027-01-03"), false);
  assert.equal(twin("2026-12-25", "2027-01-10"), false);
  assert.equal(twin("2027-01-03", "2027-01-05"), true);
  // Two bookings overlap this stay, but never on the same night.
  assert.ok(book("TWIN", "2027-02-01", "2027-02-02").reservation);
  assert.ok(book("TWIN", "2027-02-03", "2027-02-04").reservation);
  assert.equal(twin("2027-02-01", "2027-02-04"), true);

  hotel.replaceRooms([{ code: "NONE", name: "Closed", max_guests: 2, nightly_rate_aed: 100, inventory: 0 }]);
  assert.deepEqual(hotel.checkAvailability(stay("2027-03-01", "2027-03-02", 1)).options, []);
});

test("bookings: validation, price, confirmation number and the change event", () => {
  changes.length = 0;
  const ok = { ...stay("2027-04-01", "2027-04-03", 2), room_code: "prm", ...guest };
  assert.equal(hotel.createReservation({ ...ok, guest_name: "A" }).error, "invalid_guest_name");
  assert.equal(hotel.createReservation({ ...ok, guest_name: "12345" }).error, "invalid_guest_name");
  assert.equal(hotel.createReservation({ ...ok, guest_name: "x".repeat(101) }).error, "invalid_guest_name");
  for (const phone of ["abc", "12345", "+971-50-123", "1".repeat(21), undefined]) {
    assert.equal(hotel.createReservation({ ...ok, phone }).error, "invalid_phone", String(phone));
  }
  assert.equal(hotel.createReservation({ ...ok, special_requests: "x".repeat(501) }).error, "special_requests_too_long");
  assert.equal(hotel.createReservation({ ...ok, room_code: undefined }).error, "missing_room_code");
  assert.equal(hotel.createReservation({ ...ok, room_code: "ZZZ" }).error, "unknown_room_code");
  assert.equal(hotel.createReservation({ ...ok, guests: 4 }).error, "too_many_guests_for_room");
  assert.doesNotThrow(() => hotel.createReservation());
  assert.equal(changes.length, 0, "nothing booked yet");

  const { reservation: r } = hotel.createReservation({ ...ok, guest_name: "  Priya   Sharma ", special_requests: " High floor " }, "call-9");
  assert.match(r.confirmation_number, /^TAJ-[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual(
    { ...r, confirmation_number: "x", created_at: "x" },
    {
      confirmation_number: "x",
      guest_name: "Priya Sharma",
      phone: "+971 50 123 4567",
      check_in: "2027-04-01",
      check_out: "2027-04-03",
      nights: 2,
      guests: 2,
      room_code: "PRM",
      room_name: "Premier Room",
      total_aed: 2500,
      special_requests: "High floor",
      status: "booked",
      call_id: "call-9",
      created_at: "x",
      cancelled_at: null,
      cancelled_by: null,
    },
  );
  assert.deepEqual(changes.at(-1), r);

  // Many bookings, all with different numbers.
  hotel.replaceRooms([{ code: "BIG", name: "Big", max_guests: 2, nightly_rate_aed: 10, inventory: 500 }]);
  const numbers = new Set();
  for (let i = 0; i < 200; i++) numbers.add(book("BIG", "2027-05-01", "2027-05-02").reservation.confirmation_number);
  assert.equal(numbers.size, 200);
  for (const n of numbers) assert.doesNotMatch(n.slice(4), /[0O1I]/);
});

test("finding and cancelling need the confirmation number and the name on the booking", () => {
  const { reservation } = book("STE", "2027-06-01", "2027-06-03", { guest_name: "Priya Anand Sharma" });
  const number = reservation.confirmation_number;
  const code = number.slice(4);
  changes.length = 0;

  for (const name of ["Sharma", "sharma", "PRIYA SHARMA", "Priya Anand Sharma", " priya  sharma "]) {
    assert.equal(hotel.findReservation(number, name).reservation?.confirmation_number, number, name);
  }
  for (const n of [number.toLowerCase(), `TAJ ${code.slice(0, 3)} ${code.slice(3)}`, code, `taj${code}`]) {
    assert.ok(hotel.findReservation(n, "Sharma").reservation, n);
  }
  // A wrong name and a wrong number look the same.
  for (const [n, name] of [[number, "Priya"], [number, "Smith"], [number, "Bob Sharma"], ["TAJ-ZZZZZZ", "Sharma"], ["TAJ-1", "Sharma"]]) {
    assert.deepEqual(hotel.findReservation(n, name), { error: "not_found" }, `${n} / ${name}`);
  }
  assert.deepEqual(hotel.findReservation("", "Sharma"), { error: "missing_confirmation_number" });
  assert.deepEqual(hotel.findReservation(number, " "), { error: "missing_guest_name" });
  assert.doesNotThrow(() => hotel.findReservation({}, []));

  assert.deepEqual(hotel.cancelGuestReservation(number, "Smith"), { error: "not_found" });
  assert.equal(hotel.findReservation(number, "Sharma").reservation.status, "booked");
  assert.equal(changes.length, 0);

  const cancelled = hotel.cancelGuestReservation(code, "sharma");
  assert.equal(cancelled.already_cancelled, false);
  assert.equal(cancelled.reservation.status, "cancelled");
  assert.equal(cancelled.reservation.cancelled_by, "bot");
  assert.ok(cancelled.reservation.cancelled_at);
  assert.deepEqual(changes, [cancelled.reservation]);

  const again = hotel.cancelGuestReservation(number, "Sharma");
  assert.equal(again.already_cancelled, true);
  assert.deepEqual(again.reservation, cancelled.reservation);
  assert.deepEqual(hotel.cancelReservation(number, { by: "ui" }), cancelled.reservation, "already cancelled: unchanged");
  assert.equal(changes.length, 1, "no event when nothing changed");
  assert.equal(hotel.cancelReservation("TAJ-ZZZZZZ"), null);
  assert.equal(hotel.cancelReservation(42), null);
});

test("reservations are listed newest first, by status", () => {
  const a = book("DLX", "2027-07-01", "2027-07-02").reservation;
  const b = book("DLX", "2027-07-02", "2027-07-03").reservation;
  hotel.cancelReservation(a.confirmation_number, { by: "ui" });
  const all = hotel.listReservations();
  assert.deepEqual(all.slice(0, 2).map((r) => r.confirmation_number), [b.confirmation_number, a.confirmation_number]);
  assert.ok(hotel.listReservations({ status: "booked" }).every((r) => r.status === "booked"));
  assert.ok(hotel.listReservations({ status: "cancelled" }).some((r) => r.confirmation_number === a.confirmation_number));
  assert.equal(hotel.listReservations({ limit: 1 }).length, 1);
  assert.equal(hotel.listReservations({ status: "bogus" }).length, all.length);
  assert.ok(
    Object.keys(all[0]).join() ===
      "confirmation_number,guest_name,phone,check_in,check_out,nights,guests,room_code,room_name,total_aed,special_requests,status,call_id,created_at,cancelled_at,cancelled_by",
  );
});

test("room types: validation, replacing them keeps reservations, reset brings the demo rooms back", () => {
  for (const bad of [null, "rooms", {}, 5, []]) assert.ok(hotel.validateRooms(bad).length, JSON.stringify(bad));
  const good = { code: "KING_1", name: "King", description: "", max_guests: 2, nightly_rate_aed: 499.5, inventory: 3 };
  assert.deepEqual(hotel.validateRooms([good]), []);
  const cases = [
    { code: "k" },
    { code: "lower" },
    { code: "TOO_LONG_CODE1" },
    { code: 5 },
    { name: " " },
    { name: undefined },
    { description: "x".repeat(501) },
    { description: 5 },
    { max_guests: 0 },
    { max_guests: 11 },
    { max_guests: 2.5 },
    { nightly_rate_aed: 0 },
    { nightly_rate_aed: "950" },
    { nightly_rate_aed: Infinity },
    { inventory: -1 },
    { inventory: 501 },
    { inventory: "3" },
  ];
  for (const change of cases) {
    assert.equal(hotel.validateRooms([{ ...good, ...change }]).length, 1, JSON.stringify(change));
  }
  assert.match(hotel.validateRooms([good, { ...good }]).join(), /more than once/);
  assert.doesNotThrow(() => hotel.validateRooms([null, 5, "x", { code: {} }]));
  assert.throws(() => hotel.replaceRooms([{ ...good, code: "bad" }]));

  const { reservation } = book("DLX", "2027-08-01", "2027-08-03");
  const rooms = hotel.replaceRooms([good, { ...good, code: "QUEEN", name: " Queen ", description: undefined, nightly_rate_aed: 300 }]);
  assert.deepEqual(rooms.map((r) => [r.code, r.name, r.description]), [["QUEEN", "Queen", ""], ["KING_1", "King", ""]]);
  const kept = hotel.findReservation(reservation.confirmation_number, "Sharma").reservation;
  assert.equal(kept.room_name, "Deluxe Room");
  assert.equal(kept.status, "booked");
  assert.ok(hotel.listReservations().some((r) => r.confirmation_number === reservation.confirmation_number));
  assert.equal(hotel.checkAvailability(stay("2027-08-01", "2027-08-02", 1, { room_code: "DLX" })).error, "unknown_room_code");

  assert.deepEqual(hotel.resetRooms().map((r) => r.code), ["DLX", "PRM", "STE", "PRS"]);
  assert.equal(hotel.cancelReservation(reservation.confirmation_number).status, "cancelled", "still cancellable after the reset");
});
