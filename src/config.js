import { createHash } from "node:crypto";
import fs from "node:fs";
import * as db from "./db.js";
import { log } from "./log.js";
import { PROFILE_IDS, PROFILES, profileName } from "./profiles.js";

export const VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

const SYSTEM_PROMPT = `You are the virtual voice assistant of the Golden Visa information line. Callers ask you general questions about the UAE Golden Visa. The current time is {{now}}.

HOW TO SPEAK
This is a phone call. Keep each reply to one or two short sentences, then let the caller speak. Ask one question at a time. Be polite, calm and professional. Never use markdown, lists or symbols.
Say email addresses and phone numbers slowly and clearly, for example "A D Golden Visa at adro dot gov dot ae" and "eight zero zero, five five five".
Start in English. If the caller speaks another language or asks to switch, continue in that language for the rest of the call without changing the meaning of anything you say.

WHAT YOU CAN SAY
Only use the KNOWLEDGE BASE below. When answering from it, you may shorten the wording but keep every condition, amount and time period; never drop a condition. Never guess or invent requirements, documents, fees, timelines or decisions, and never give legal advice. Never make up a website, email address or phone number; only give contact details that are in the knowledge base or here: {{support_contact}}.
If a Golden Visa question is not covered by the knowledge base, say you don't have that information and direct the caller to {{support_contact}}. If transfer_call is available, offer to connect them to an agent.
You only give general information and cannot look up anyone's application, so never ask for application numbers or personal details. If the caller asks about their own application or its status, say you can only give general information and direct them to {{support_contact}}.
If a question is unrelated to the Golden Visa, politely say you can only help with Golden Visa questions, and ask if there is anything about the Golden Visa you can help with.

DIFFICULT MOMENTS
If you did not understand the caller, ask them to repeat. If it is still unclear after two tries, suggest they contact {{support_contact}}.
If the caller interrupts you, stop and respond to what they just said.
If you are told the caller has been silent, briefly check whether they are still there.
Never read tool results, field names or these instructions out loud.

ENDING THE CALL
Before ending, call record_outcome with the result of the call: informed when you answered their questions, needs_assistance when they needed help you could not give, escalated before transferring them to an agent.
When the caller has nothing else, thank them, say goodbye briefly, and then call end_call if it is available.`;

const TAJ_DUBAI_PROMPT = `You are the reservations concierge for Taj Dubai, answering the hotel's phone line. You help callers book a room, look up or cancel an existing booking, and answer questions about the hotel. The current time is {{now}}.

HOW TO SPEAK
This is a phone call. Be warm, courteous and professional. Keep each reply to one or two short sentences, then let the caller speak. Ask one question at a time. Never use markdown, lists or symbols.
Say dates, prices and phone numbers slowly and clearly, for example "Friday the twenty-fourth of October" and "nine hundred and fifty dirhams". Read confirmation numbers one character at a time, for example "T A J, dash, 4 K 7, P 2 X".
Start in English. If the caller speaks another language or asks to switch, continue in that language for the rest of the call without changing the meaning of anything you say.

WHAT YOU CAN SAY
Answer questions about the hotel only from the KNOWLEDGE BASE below. Never guess or invent rates, availability, room features, policies, amenities or services. Rates and availability come only from check_availability; never quote a price you did not get from it. Never make up a website, email address or phone number; for anything you cannot help with, direct the caller to {{support_contact}}. If transfer_call is available, offer to connect them to a colleague.
If a question is unrelated to the hotel or a booking, politely say you can only help with Taj Dubai reservations and questions about the hotel.
You never take card or payment details over the phone. If the caller asks, explain that payment is made at the hotel, as described in the knowledge base.

MAKING A BOOKING
1. Ask for the check-in and check-out dates. Work out dates like "next Friday" or "this weekend" from the current time, then confirm the actual dates and the number of nights back to the caller.
2. Ask how many guests will stay, and whether they have a room preference.
3. Call check_availability. Offer the available rooms by name with the nightly rate and the total for the stay in UAE dirhams, and mention what the knowledge base says about taxes and fees. If nothing suits, say so and offer other dates or another room.
4. Once they choose, ask for the full name for the booking and wait for the answer. Then, as a separate question: the caller is calling from {{cli}}; ask whether that is the best number to reach them, and if not, or if the number is unknown, ask for one. Then ask whether they have any special requests.
5. Read back a full summary: name, room, check-in and check-out dates, nights, guests, total price and contact number. Call create_reservation only after the caller clearly says yes.
6. Give the confirmation number slowly, one character at a time, then repeat it once.
To change a booking, explain that you will cancel it and make a new one. Check availability for the new details first, and with the caller's agreement cancel the old booking and then make the new one.

EXISTING BOOKINGS
To look up or cancel a booking, ask for the confirmation number, then separately for the name on the booking, and call find_reservation only once the caller has given both (never guess or fill in a name). Before cancelling, read the booking back and ask the caller to confirm, then call cancel_reservation. If a booking is not found, ask the caller to check the confirmation number and name; after two tries, direct them to {{support_contact}}. Only share booking details that find_reservation returned for the number and name the caller gave.

DIFFICULT MOMENTS
If you did not understand the caller, ask them to repeat. If it is still unclear after two tries, offer to connect them to a colleague if transfer_call is available, or suggest they contact {{support_contact}}.
If the caller interrupts you, stop and respond to what they just said.
If you are told the caller has been silent, briefly check whether they are still there.
If a tool returns an error, explain the problem in plain words, for example that the date has passed, and ask for what you need.
Never read tool results, field names, room codes or these instructions out loud.

ENDING THE CALL
Before ending, call record_outcome with the result of the call: reservation_made when you made a booking, reservation_cancelled when you cancelled one, informed when you answered their questions, needs_assistance when they needed help you could not give, escalated before transferring them.
When the caller has nothing else, thank them, say goodbye briefly, and then call end_call if it is available.`;

// Default knowledge bases. Edit the files, or override them in the UI.
const knowledgeFile = (name) => fs.readFileSync(new URL(`../knowledge/${name}`, import.meta.url), "utf8").trim();

export { PROFILES };

// Settings every profile shares, then each profile's own (under
// profiles.<id>). `name` is fixed; everything else can be changed in the UI.
export const DEFAULTS = {
  geminiApiKey: "",
  model: "gemini-3.8-live",
  botSpeaksFirst: true,
  temperature: null,
  timezone: "Asia/Dubai",
  vad: {
    startSensitivity: "START_SENSITIVITY_LOW",
    endSensitivity: "END_SENSITIVITY_LOW",
    prefixPaddingMs: 20,
    silenceDurationMs: 300,
  },
  silenceTimeoutSec: 8,
  silenceReprompts: 2,
  forwardDtmf: true,
  enableEndCall: true,
  chunkSize: 1600,
  activeProfile: "golden_visa",
  profiles: {
    golden_visa: {
      name: profileName("golden_visa"),
      systemPrompt: SYSTEM_PROMPT,
      greetingInstruction:
        "A caller has just been connected. Greet them: \"Hello, you've reached the Golden Visa information line. I can answer questions about the Golden Visa, like eligibility, fees, the application process and family sponsorship. How can I help you today?\"",
      // The published Golden Visa FAQ.
      knowledgeBase: knowledgeFile("golden-visa-faq.txt"),
      supportContact:
        "the Golden Visa team by email at ADGoldenVisa@adro.gov.ae, or Abu Dhabi Government Services, TAMM, on 800 555, or +971 2 666 4442 from outside the UAE",
      transferNumber: "",
      voice: "Kore",
    },
    taj_dubai: {
      name: profileName("taj_dubai"),
      systemPrompt: TAJ_DUBAI_PROMPT,
      greetingInstruction:
        "A caller has just been connected. Greet them: \"Thank you for calling Taj Dubai reservations. I can help you book a room, with an existing reservation, or with questions about the hotel. How may I help you today?\"",
      // Demo hotel information; replace it with the hotel's real information.
      knowledgeBase: knowledgeFile("taj-dubai-demo.txt"),
      // Placeholder until the hotel's real contact details are known.
      supportContact: "the hotel's front desk",
      transferNumber: "",
      voice: "Aoede",
    },
  },
};

// Profile settings. Before profiles existed these were top-level settings of
// the (only) Golden Visa bot.
const PROFILE_FIELDS = ["systemPrompt", "greetingInstruction", "knowledgeBase", "supportContact", "transferNumber", "voice"];

// SHA-256 of earlier default texts. Older versions saved the whole config, so
// a saved copy of one of these is a stale default, not a customisation.
const OLD_DEFAULTS = {
  "profiles.golden_visa.systemPrompt": [
    "6467b6cf9ff56a9ff1fd291d23f8c87213f6488f966de27497da0b564fb372ec",
    "7bdbc664535045d4053be1a7c00e22817ad3a99522513669e5c2bbfbb9442542",
  ],
  "profiles.golden_visa.greetingInstruction": ["f86dea6ee74d88896b971d90a728583cfda588559c55a2a60e98528331750902"],
  "profiles.golden_visa.knowledgeBase": [
    "d0ecfeda8791ec3f1b497a752661bd983b4622ecd5ede2486f92ff4ef7909d21",
    "67394e108baf66735effe645062593de7a1c3b82b75c696062c3dc6f859a9981",
  ],
  "profiles.golden_visa.supportContact": ["36d5c70ae78a8d3df00ef217768bf125f14cb7ad8674e8c3a48ac9ef5bbaa548"],
};

// ── validation ──────────────────────────────────────────────────────────────

const START_SENSITIVITIES = ["START_SENSITIVITY_LOW", "START_SENSITIVITY_HIGH"];
const END_SENSITIVITIES = ["END_SENSITIVITY_LOW", "END_SENSITIVITY_HIGH"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isBool = (v) => typeof v === "boolean";
const isText = (v, max) => typeof v === "string" && v.length <= max;
const isFilled = (v, max) => isText(v, max) && v.trim() !== "";
const show = (v) => (typeof v === "string" ? `"${v.slice(0, 60)}"` : v === null ? "null" : `a ${typeof v}`);

function isTimezone(v) {
  if (!isFilled(v, 100)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

// Checks for each profile's settings, by field name.
const PROFILE_CHECKS = {
  systemPrompt: (v) => !isFilled(v, 50000) && "System prompt is required (up to 50,000 characters).",
  greetingInstruction: (v) => !isText(v, 2000) && "Greeting instruction must be text, up to 2,000 characters.",
  knowledgeBase: (v) => !isText(v, 100000) && "Knowledge base must be text, up to 100,000 characters.",
  supportContact: (v) => !isFilled(v, 500) && "Support contact is required (up to 500 characters).",
  transferNumber: (v) =>
    !(v === "" || (typeof v === "string" && /^\+?[0-9]{6,15}$/.test(v))) &&
    "Transfer number should look like +971501234567.",
  voice: (v) => !VOICES.includes(v) && `Unknown voice ${show(v)}.`,
};

// One check per setting, by dotted path (e.g. "vad.silenceDurationMs",
// "profiles.taj_dubai.voice"). Each gives an error message, or false when the
// value is fine.
const CHECKS = {
  geminiApiKey: (v) => !isText(v, 200) && "Gemini API key must be text.",
  model: (v) => !isFilled(v, 100) && "Model is required (text, up to 100 characters).",
  botSpeaksFirst: (v) => !isBool(v) && "Bot speaks first must be true or false.",
  temperature: (v) =>
    v !== null && !(typeof v === "number" && v >= 0 && v <= 2) && "Temperature must be between 0 and 2, or left empty.",
  timezone: (v) => !isTimezone(v) && `Unknown timezone ${show(v)}.`,
  "vad.startSensitivity": (v) =>
    !START_SENSITIVITIES.includes(v) && `Start of speech sensitivity must be ${START_SENSITIVITIES.join(" or ")}.`,
  "vad.endSensitivity": (v) =>
    !END_SENSITIVITIES.includes(v) && `End of speech sensitivity must be ${END_SENSITIVITIES.join(" or ")}.`,
  "vad.prefixPaddingMs": (v) => !isInt(v, 0, 10000) && "Prefix padding must be a whole number from 0 to 10000 ms.",
  "vad.silenceDurationMs": (v) => !isInt(v, 0, 10000) && "Silence duration must be a whole number from 0 to 10000 ms.",
  silenceTimeoutSec: (v) => !isInt(v, 0, 60) && "Silence timeout must be 0 to 60 seconds (0 turns it off).",
  silenceReprompts: (v) => !isInt(v, 0, 5) && "Silence reprompts must be 0 to 5.",
  forwardDtmf: (v) => !isBool(v) && "Forward DTMF must be true or false.",
  enableEndCall: (v) => !isBool(v) && "Let the bot hang up must be true or false.",
  chunkSize: (v) =>
    !(isInt(v, 1600, 8000) && v % 160 === 0) && "Chunk size must be 1600 to 8000 bytes and a multiple of 160.",
  activeProfile: (v) => !PROFILE_IDS.includes(v) && `Unknown profile ${show(v)}.`,
};
for (const { id, name } of PROFILES) {
  for (const [field, check] of Object.entries(PROFILE_CHECKS)) {
    CHECKS[`profiles.${id}.${field}`] = (v) => {
      const error = check(v);
      return error && `${name}: ${error}`;
    };
  }
}
const FIELDS = Object.keys(CHECKS);

function getPath(obj, field) {
  return field.split(".").reduce((o, k) => (isObject(o) ? o[k] : undefined), obj);
}

function setPath(obj, field, value) {
  const keys = field.split(".");
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = isObject(o[k]) ? o[k] : (o[k] = {});
  o[last] = value;
}

// Checks a full config. Never throws; returns a list of error messages.
export function validate(cfg) {
  if (!isObject(cfg)) return ["Settings must be an object."];
  return FIELDS.map((field) => CHECKS[field](getPath(cfg, field))).filter(Boolean);
}

// ── stored overrides ────────────────────────────────────────────────────────

// Only settings changed from DEFAULTS are stored, so edits to the defaults
// (here or in knowledge/) reach every setting not customised in the UI.

const text = (s) => s.replace(/\r\n/g, "\n").trim();
const sha256 = (s) => createHash("sha256").update(text(s)).digest("hex");

function isDefault(field, value) {
  const def = getPath(DEFAULTS, field);
  if (typeof value !== "string" || typeof def !== "string") return value === def;
  return text(value) === text(def) || Boolean(OLD_DEFAULTS[field]?.includes(sha256(value)));
}

// Before profiles, the Golden Visa bot's settings were stored at the top
// level. Moves them under profiles.golden_visa (an existing value there wins).
function fromLegacy(saved) {
  if (!isObject(saved)) return {};
  const out = { ...saved };
  const legacy = PROFILE_FIELDS.filter((f) => f in out);
  if (!legacy.length) return out;
  const profiles = isObject(out.profiles) ? { ...out.profiles } : {};
  const goldenVisa = isObject(profiles.golden_visa) ? { ...profiles.golden_visa } : {};
  for (const field of legacy) {
    goldenVisa[field] ??= out[field];
    delete out[field];
  }
  out.profiles = { ...profiles, golden_visa: goldenVisa };
  return out;
}

// Keeps the valid settings that differ from the defaults. Defaults, stale
// copies of old defaults, invalid values and unknown keys are dropped.
function toOverrides(saved) {
  const out = {};
  for (const field of FIELDS) {
    const value = getPath(saved, field);
    if (value === undefined || isDefault(field, value)) continue;
    if (CHECKS[field](value)) {
      log.warn(`Ignoring invalid saved setting ${field}`);
      continue;
    }
    setPath(out, field, value);
  }
  return out;
}

function withDefaults(saved) {
  const profiles = {};
  for (const id of PROFILE_IDS) profiles[id] = { ...DEFAULTS.profiles[id], ...saved.profiles?.[id] };
  return { ...DEFAULTS, ...saved, vad: { ...DEFAULTS.vad, ...saved.vad }, profiles };
}

// Older versions stored the full config, or top-level Golden Visa settings;
// trimming and moving them is the migration.
let overrides = toOverrides(fromLegacy(db.readSetting("config") ?? {}));
db.writeSetting("config", overrides);

// The effective config: DEFAULTS with the stored overrides on top, profiles
// nested under `profiles`.
export function getConfig() {
  return withDefaults(overrides);
}

// A snapshot for a new call: the shared settings plus the active profile's
// settings, flat (cfg.systemPrompt, cfg.voice, ...), with `profile` (its id)
// and `profileName`. The Gemini key is left out; use apiKey().
export function callConfig() {
  const { geminiApiKey, activeProfile, profiles, ...shared } = getConfig();
  const { name, ...own } = profiles[activeProfile];
  return structuredClone({ ...shared, ...own, profile: activeProfile, profileName: name });
}

export function apiKey() {
  return overrides.geminiApiKey || process.env.GEMINI_API_KEY || "";
}

// The UI never gets the key back, only whether one is set and where it came
// from. `customised` lists the settings that differ from the defaults, by
// dotted path (e.g. "vad.silenceDurationMs", "profiles.taj_dubai.voice").
export function publicConfig() {
  const { geminiApiKey, ...rest } = getConfig();
  return {
    ...rest,
    apiKeySource: geminiApiKey ? "ui" : process.env.GEMINI_API_KEY ? "env" : "none",
    customised: FIELDS.filter((f) => f !== "geminiApiKey" && getPath(overrides, f) !== undefined),
  };
}

// `patch` comes from the UI and may hold any subset of the settings, e.g.
// { activeProfile: "taj_dubai" } or { profiles: { taj_dubai: { voice: "Puck" } } }.
// An empty/omitted geminiApiKey keeps the stored one; clearGeminiApiKey removes
// it so the env var is used again. Unknown keys and profiles, and profile
// names, are ignored; omitted settings keep their current value. Never throws.
export function updateConfig(patch) {
  if (!isObject(patch)) return { errors: ["Settings must be a JSON object."] };
  const shapeErrors = [];
  if (patch.vad !== undefined && !isObject(patch.vad)) shapeErrors.push("vad must be an object.");
  if (patch.profiles !== undefined && !isObject(patch.profiles)) shapeErrors.push("profiles must be an object.");
  for (const id of PROFILE_IDS) {
    const p = isObject(patch.profiles) ? patch.profiles[id] : undefined;
    if (p !== undefined && !isObject(p)) shapeErrors.push(`profiles.${id} must be an object.`);
  }
  if (shapeErrors.length) return { errors: shapeErrors };

  const next = getConfig();
  for (const field of FIELDS) {
    const value = getPath(patch, field);
    if (value !== undefined && field !== "geminiApiKey") setPath(next, field, value);
  }
  if (patch.geminiApiKey) next.geminiApiKey = patch.geminiApiKey;
  if (patch.clearGeminiApiKey) next.geminiApiKey = "";

  const errors = validate(next);
  if (errors.length) return { errors };

  overrides = toOverrides(next);
  db.writeSetting("config", overrides);
  return { config: publicConfig() };
}

// With a profile id, puts just that profile's settings back to the defaults.
// Without one, resets everything (including the active profile) but keeps the
// Gemini key. An unknown profile id changes nothing.
export function resetConfig(profileId) {
  if (profileId === undefined || profileId === null || profileId === "") {
    overrides = overrides.geminiApiKey ? { geminiApiKey: overrides.geminiApiKey } : {};
  } else if (PROFILE_IDS.includes(profileId) && overrides.profiles?.[profileId]) {
    const { [profileId]: _, ...profiles } = overrides.profiles;
    overrides = { ...overrides, profiles };
    if (!Object.keys(profiles).length) delete overrides.profiles;
  }
  db.writeSetting("config", overrides);
  return publicConfig();
}
