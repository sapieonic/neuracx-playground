import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.js opens the database on import, so point it at a temp file first.
const dir = mkdtempSync(path.join(tmpdir(), "ncx-tools-"));
process.env.DB_PATH = path.join(dir, "test.db");
const { callConfig } = await import("../src/config.js");
const { runTool, toolDeclarations, outcomesFor, OUTCOMES } = await import("../src/tools.js");
const hotel = await import("../src/hotel.js");
const db = await import("../src/db.js");
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeSession(cfg = {}) {
  const s = {
    id: `t-${Math.random()}`,
    cfg: { ...callConfig(), ...cfg },
    outcomes: [],
    events: [],
    recordOutcome: (e) => {
      s.outcomes.push(e);
      db.addOutcome(s.id, e);
    },
    event: (text) => s.events.push(text),
  };
  db.insertCall({ id: s.id, source: "test", remote: "", status: "active", model: "m", voice: "v", startedAt: new Date().toISOString() });
  return s;
}

test("the Golden Visa profile only gets the FAQ tools", () => {
  const cfg = { ...callConfig(), enableEndCall: false, transferNumber: "" };
  assert.equal(cfg.profile, "golden_visa");
  assert.deepEqual(toolDeclarations(cfg).map((t) => t.name), ["record_outcome"]);
  const all = toolDeclarations({ ...cfg, enableEndCall: true, transferNumber: "+971500000000" });
  assert.deepEqual(all.map((t) => t.name), ["record_outcome", "end_call", "transfer_call"]);
  assert.deepEqual(OUTCOMES, ["informed", "needs_assistance", "escalated", "no_response", "caller_hung_up", "other"]);
});

test("outcomes are saved to the call", async () => {
  const s = fakeSession();
  assert.deepEqual((await runTool(s, "record_outcome", { outcome: "informed", notes: "Asked about fees" })).response, {
    recorded: true,
  });
  await runTool(s, "record_outcome", { outcome: "action_pending" });
  const saved = db.getCall(s.id).outcomes;
  assert.deepEqual(
    saved.map(({ outcome, notes }) => ({ outcome, notes })),
    [
      { outcome: "informed", notes: "Asked about fees" },
      { outcome: "other", notes: "" },
    ],
    "unknown outcomes are saved as other",
  );
});

test("removed tools are unknown", async () => {
  const s = fakeSession();
  const { response } = await runTool(s, "verify_applicant", { application_number: "GV-1", date_of_birth: "1988-04-12" });
  assert.equal(response.error, "Unknown function verify_applicant");
});

test("end_call and transfer_call return how to leave the call", async () => {
  const s = fakeSession();
  assert.deepEqual((await runTool(s, "end_call", { reason: "done" })).exit.parameters, []);
  assert.equal((await runTool(s, "transfer_call", {})).exit, undefined, "no transfer without a number");
  s.cfg.transferNumber = "+971500000000";
  assert.deepEqual((await runTool(s, "transfer_call", {})).exit.parameters, [{ action: "dial", to: "+971500000000" }]);
  s.cfg.enableEndCall = false;
  assert.equal((await runTool(s, "end_call", {})).exit, undefined, "no hang up when end_call is off");
});

const outcomeEnum = (tools) => tools.find((t) => t.name === "record_outcome").parameters.properties.outcome.enum;
const taj = () => fakeSession({ profile: "taj_dubai", timezone: "Asia/Dubai" });

test("the Taj Dubai profile gets the hotel tools and outcomes", () => {
  const base = { ...callConfig(), profile: "taj_dubai", enableEndCall: true, transferNumber: "" };
  const tools = toolDeclarations(base);
  assert.deepEqual(tools.map((t) => t.name), [
    "record_outcome",
    "check_availability",
    "create_reservation",
    "find_reservation",
    "cancel_reservation",
    "end_call",
  ]);
  for (const t of tools) assert.equal(t.behavior, "BLOCKING", t.name);
  assert.match(tools[1].parameters.properties.room_code.description, /DLX \(Deluxe Room\)/);
  assert.deepEqual(outcomeEnum(tools), [...OUTCOMES, "reservation_made", "reservation_cancelled"]);
  assert.deepEqual(outcomeEnum(toolDeclarations({ ...base, profile: "golden_visa" })), OUTCOMES);
  assert.deepEqual(outcomesFor("golden_visa"), OUTCOMES);
  assert.deepEqual(outcomesFor(undefined), OUTCOMES);
});

test("hotel outcomes only count on the hotel profile", async () => {
  const hotelCall = taj();
  await runTool(hotelCall, "record_outcome", { outcome: "reservation_made" });
  const faqCall = fakeSession();
  await runTool(faqCall, "record_outcome", { outcome: "reservation_made" });
  assert.equal(hotelCall.outcomes[0].outcome, "reservation_made");
  assert.equal(faqCall.outcomes[0].outcome, "other");
});

test("hotel tools are unknown on the Golden Visa profile", async () => {
  const s = fakeSession();
  for (const name of ["check_availability", "create_reservation", "find_reservation", "cancel_reservation"]) {
    assert.equal((await runTool(s, name, {})).response.error, `Unknown function ${name}`);
  }
});

test("hotel tools: check, book, find and cancel with short replies", async () => {
  const s = taj();
  const year = new Date().getUTCFullYear() + 1;
  const dates = { check_in: `${year}-03-10`, check_out: `${year}-03-12` };

  const check = (await runTool(s, "check_availability", { ...dates, guests: 2, room_code: "PRS" })).response;
  assert.equal(check.requested_room_available, true);
  assert.deepEqual(check.options, [
    { room_code: "PRS", room: "Presidential Suite", max_guests: 4, nightly_rate_aed: 9000, total_aed: 18000 },
  ]);
  assert.equal((await runTool(s, "check_availability", { check_in: "2020-01-01", check_out: "2020-01-02", guests: 1 })).response.error, "check_in_in_past");

  const booked = (await runTool(s, "create_reservation", { ...dates, guests: 2, room_code: "PRS", guest_name: "Omar Haddad", phone: "+971501234567" })).response;
  assert.deepEqual(Object.keys(booked), ["confirmation_number", "room", "check_in", "check_out", "nights", "guests", "total_aed"]);
  assert.equal(booked.total_aed, 18000);
  assert.match(s.events[0], new RegExp(booked.confirmation_number));
  const saved = hotel.findReservation(booked.confirmation_number, "Haddad").reservation;
  assert.equal(saved.call_id, s.id, "the booking is linked to the call");

  const again = (await runTool(s, "create_reservation", { ...dates, guests: 2, room_code: "PRS", guest_name: "Someone Else", phone: "+971501234567" })).response;
  assert.deepEqual(again, { error: "room_not_available" });

  const found = (await runTool(s, "find_reservation", { confirmation_number: booked.confirmation_number, guest_name: "haddad" })).response;
  assert.equal(found.status, "booked");
  assert.equal(found.room, "Presidential Suite");
  for (const key of ["phone", "call_id", "room_code", "created_at"]) assert.equal(key in found, false, key);
  assert.deepEqual((await runTool(s, "find_reservation", { confirmation_number: booked.confirmation_number, guest_name: "Smith" })).response, { error: "not_found" });

  const cancel = (args) => runTool(s, "cancel_reservation", args).then((r) => r.response);
  assert.deepEqual(await cancel({ confirmation_number: booked.confirmation_number, guest_name: "Smith" }), { error: "not_found" });
  assert.deepEqual(await cancel({ confirmation_number: booked.confirmation_number, guest_name: "Omar Haddad" }), {
    confirmation_number: booked.confirmation_number,
    status: "cancelled",
  });
  assert.deepEqual(await cancel({ confirmation_number: booked.confirmation_number, guest_name: "Haddad" }), {
    confirmation_number: booked.confirmation_number,
    status: "cancelled",
    already_cancelled: true,
  });
  assert.equal(s.events.length, 2);
});

test("hotel lookups with a placeholder name ask for the name instead of reporting not found", async () => {
  const s = taj();
  for (const name of ["placeholder", "Unknown", " n/a "]) {
    assert.equal((await runTool(s, "find_reservation", { confirmation_number: "TAJ-ABCDEF", guest_name: name })).response.error, "missing_guest_name");
    assert.equal((await runTool(s, "cancel_reservation", { confirmation_number: "TAJ-ABCDEF", guest_name: name })).response.error, "missing_guest_name");
  }
  assert.equal((await runTool(s, "find_reservation", { confirmation_number: "TAJ-ABCDEF", guest_name: "Verma" })).response.error, "not_found");
});
