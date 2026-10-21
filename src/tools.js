import { Behavior, Type } from "@google/genai";
import * as hotel from "./hotel.js";

// Outcomes every profile can record, and the extra ones per profile.
export const OUTCOMES = ["informed", "needs_assistance", "escalated", "no_response", "caller_hung_up", "other"];
const PROFILE_OUTCOMES = {
  taj_dubai: ["reservation_made", "reservation_cancelled"],
};

export function outcomesFor(profile) {
  return [...OUTCOMES, ...(PROFILE_OUTCOMES[profile] ?? [])];
}

// The model sometimes fills a required name it hasn't been told yet with a
// stand-in; treat those as missing so it asks the caller instead of reporting
// "not found".
const PLACEHOLDER_NAMES = /^(placeholder|unknown|none|n\/?a|null|guest|caller|name|tbd|test|-+)$/i;
const isPlaceholderName = (v) => typeof v === "string" && PLACEHOLDER_NAMES.test(v.trim());

const HOTEL_TOOLS = ["check_availability", "create_reservation", "find_reservation", "cancel_reservation"];

const str = (description) => ({ type: Type.STRING, description });
const int = (description) => ({ type: Type.INTEGER, description });
const date = (what) => str(`${what} as YYYY-MM-DD`);

function hotelDeclarations() {
  const codes = hotel.listRooms().map((r) => `${r.code} (${r.name})`).join(", ") || "none";
  const roomCode = str(`Room type code, one of: ${codes}`);
  const confirmation = str("Confirmation number as the caller gave it, e.g. TAJ-4K7P2X");
  const name = str("The name on the booking exactly as the caller said it (surname or full name). Never guess or use a placeholder; ask the caller first.");
  return [
    {
      name: "check_availability",
      description:
        "Check which rooms are free for a stay, with the nightly rate and total in AED. Call before quoting any price.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          check_in: date("Check-in date"),
          check_out: date("Check-out date"),
          guests: int("Number of guests"),
          room_code: { ...roomCode, description: `${roomCode.description}. Leave out to see every room.` },
        },
        required: ["check_in", "check_out", "guests"],
      },
    },
    {
      name: "create_reservation",
      description:
        "Book a room. Only call after you have read the full booking summary back and the caller clearly said yes.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          check_in: date("Check-in date"),
          check_out: date("Check-out date"),
          guests: int("Number of guests"),
          room_code: roomCode,
          guest_name: str("Full name for the booking"),
          phone: str("Contact phone number, digits with an optional leading +"),
          special_requests: str("Special requests, if any, in a few words"),
        },
        required: ["check_in", "check_out", "guests", "room_code", "guest_name", "phone"],
      },
    },
    {
      name: "find_reservation",
      description: "Look up a booking by its confirmation number and the name on it.",
      parameters: {
        type: Type.OBJECT,
        properties: { confirmation_number: confirmation, guest_name: name },
        required: ["confirmation_number", "guest_name"],
      },
    },
    {
      name: "cancel_reservation",
      description: "Cancel a booking. Only call after the caller has confirmed they want to cancel it.",
      parameters: {
        type: Type.OBJECT,
        properties: { confirmation_number: confirmation, guest_name: name },
        required: ["confirmation_number", "guest_name"],
      },
    },
  ];
}

// The tools for one call, by its profile (cfg.profile).
export function toolDeclarations(cfg) {
  const tools = [
    {
      name: "record_outcome",
      description: "Record the result of the call. Call once before ending the call, and again if the result changes.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          outcome: { type: Type.STRING, enum: outcomesFor(cfg.profile), description: "What happened on the call" },
          notes: str("One short sentence of detail, e.g. what the caller asked about"),
        },
        required: ["outcome"],
      },
    },
  ];
  if (cfg.profile === "taj_dubai") tools.push(...hotelDeclarations());
  if (cfg.enableEndCall) {
    tools.push({
      name: "end_call",
      description: "Hang up the phone call. Only call this after you have said goodbye to the caller.",
      parameters: { type: Type.OBJECT, properties: { reason: str("Short reason the call is ending") } },
    });
  }
  if (cfg.transferNumber) {
    tools.push({
      name: "transfer_call",
      description:
        "Transfer the caller to a human agent. Tell the caller you are connecting them to an agent before calling this.",
      parameters: { type: Type.OBJECT, properties: { reason: str("Why the caller needs a human agent") } },
    });
  }
  // The model must wait for each result before speaking.
  return tools.map((t) => ({ ...t, behavior: Behavior.BLOCKING }));
}

// Tool replies are kept short (the model tends to read long ones out loud)
// and carry no ids other than the confirmation number.
function bookingSummary(r) {
  const out = {
    confirmation_number: r.confirmation_number,
    status: r.status,
    guest_name: r.guest_name,
    room: r.room_name,
    check_in: r.check_in,
    check_out: r.check_out,
    nights: r.nights,
    guests: r.guests,
    total_aed: r.total_aed,
  };
  if (r.special_requests) out.special_requests = r.special_requests;
  return out;
}

function runHotelTool(session, name, args) {
  const { cfg } = session;
  switch (name) {
    case "check_availability":
      return hotel.checkAvailability({ ...args, now: new Date(), timezone: cfg.timezone });

    case "create_reservation": {
      const result = hotel.createReservation({ ...args, now: new Date(), timezone: cfg.timezone }, session.id);
      if (result.error) return result;
      const r = result.reservation;
      session.event?.(`Reservation ${r.confirmation_number}: ${r.room_name}, ${r.check_in} to ${r.check_out}, ${r.guest_name}`);
      return {
        confirmation_number: r.confirmation_number,
        room: r.room_name,
        check_in: r.check_in,
        check_out: r.check_out,
        nights: r.nights,
        guests: r.guests,
        total_aed: r.total_aed,
      };
    }

    case "find_reservation": {
      if (isPlaceholderName(args.guest_name)) return { error: "missing_guest_name" };
      const result = hotel.findReservation(args.confirmation_number, args.guest_name);
      return result.error ? result : bookingSummary(result.reservation);
    }

    case "cancel_reservation": {
      if (isPlaceholderName(args.guest_name)) return { error: "missing_guest_name" };
      const result = hotel.cancelGuestReservation(args.confirmation_number, args.guest_name, { by: "bot" });
      if (result.error) return result;
      const { confirmation_number, status } = result.reservation;
      if (!result.already_cancelled) session.event?.(`Reservation ${confirmation_number} cancelled`);
      return result.already_cancelled ? { confirmation_number, status, already_cancelled: true } : { confirmation_number, status };
    }
  }
  return null;
}

// Runs one tool call for a CallSession. Returns { response } for Gemini and,
// for end/transfer, { exit } describing how to leave the call.
export async function runTool(session, name, args = {}) {
  const { cfg } = session;
  switch (name) {
    case "record_outcome": {
      const entry = {
        outcome: outcomesFor(cfg.profile).includes(args.outcome) ? args.outcome : "other",
        notes: typeof args.notes === "string" ? args.notes : "",
        at: new Date().toISOString(),
      };
      session.recordOutcome(entry);
      return { response: { recorded: true } };
    }

    case "end_call":
      if (!cfg.enableEndCall) break;
      return {
        // Kept bare: the model tends to read longer tool replies out loud.
        response: { result: "ok" },
        exit: { parameters: [], reason: `bot ended the call: ${args.reason || "not given"}` },
      };

    case "transfer_call":
      if (!cfg.transferNumber) break;
      return {
        response: { result: "ok" },
        exit: {
          parameters: [{ action: "dial", to: cfg.transferNumber }],
          reason: `bot transferred to ${cfg.transferNumber}: ${args.reason || "not given"}`,
        },
      };

    default:
      if (cfg.profile === "taj_dubai" && HOTEL_TOOLS.includes(name)) {
        return { response: runHotelTool(session, name, args) };
      }
  }
  return { response: { error: `Unknown function ${name}` } };
}
