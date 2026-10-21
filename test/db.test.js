import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each scenario needs a fresh process, since db.js opens and migrates the
// database when it is first imported.
const dir = mkdtempSync(path.join(tmpdir(), "ncx-db-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const configUrl = new URL("../src/config.js", import.meta.url).href;

function boot(dbPath) {
  const script = `const c = await import(${JSON.stringify(configUrl)});
    console.log(JSON.stringify({ cfg: c.getConfig(), customised: c.publicConfig().customised }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DB_PATH: dbPath, GEMINI_API_KEY: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.trim().split("\n").at(-1));
}

function inspect(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      tables,
      outcomeColumns: db.prepare("PRAGMA table_info(outcomes)").all().map((c) => c.name),
      calls: tables.includes("calls") ? db.prepare("SELECT * FROM calls ORDER BY id").all().map((r) => ({ ...r })) : [],
      rooms: tables.includes("room_types")
        ? db.prepare("SELECT * FROM room_types ORDER BY nightly_rate_aed").all().map((r) => ({ ...r }))
        : [],
      outcomes: db.prepare("SELECT call_id, outcome, notes FROM outcomes").all().map((r) => ({ ...r })),
      settings: Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, JSON.parse(r.value)])),
    };
  } finally {
    db.close();
  }
}

// What earlier versions wrote: the whole config, with the defaults of the time.
const kbFile = readFileSync(new URL("../knowledge/golden-visa-faq.txt", import.meta.url), "utf8");
const OLD_KB = `Source: Golden Visa FAQs (imkan.ae/node/20). Questions and answers below are as published.\n${kbFile.slice(kbFile.indexOf("\n") + 1)}`.trim();
const OLD_GREETING =
  "A caller has just been connected. Greet them: \"Hello, you've reached the Golden Visa nomination service. I can help with your application status, any action needed on your application, or general questions. How can I help you today?\"";
const OLD_CONFIG = {
  geminiApiKey: "old-key",
  model: "custom-model",
  systemPrompt: "Custom prompt",
  botSpeaksFirst: true,
  greetingInstruction: OLD_GREETING,
  knowledgeBase: OLD_KB,
  supportContact:
    "the Golden Visa team by email at ADGoldenVisa@adro.gov.ae, or Abu Dhabi Government Services, TAMM, on 800 555, or +971 2 666 4442 from outside the UAE",
  reminderDays: 7,
  voice: "Kore",
  temperature: 0.7,
  timezone: "Asia/Dubai",
  vad: { startSensitivity: "BOGUS", endSensitivity: "END_SENSITIVITY_LOW", prefixPaddingMs: 20, silenceDurationMs: 300 },
  silenceTimeoutSec: 8,
  silenceReprompts: 2,
  forwardDtmf: true,
  enableEndCall: true,
  transferNumber: "",
  chunkSize: 1600,
};

function makeOldDb(name, { withStatusDate }) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE applicants (
      application_number TEXT PRIMARY KEY,
      applicant_name     TEXT NOT NULL DEFAULT '',
      date_of_birth      TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT '',
      ${withStatusDate ? "status_date TEXT NOT NULL DEFAULT ''," : ""}
      status_detail      TEXT NOT NULL DEFAULT '',
      action_message     TEXT NOT NULL DEFAULT '',
      simulate_api_error INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE calls (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, remote TEXT, status TEXT NOT NULL, room_id TEXT, call_id TEXT,
      cli TEXT, dni TEXT, custom_parameters TEXT NOT NULL DEFAULT '{}', model TEXT, voice TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT
    );
    CREATE TABLE transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      level TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      application_number TEXT, outcome TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', follow_up_date TEXT, at TEXT NOT NULL);
    CREATE INDEX outcomes_call ON outcomes(call_id, id);
    INSERT INTO applicants (application_number, date_of_birth, status) VALUES ('GV-2026-000123', '1988-04-12', 'approved');
    INSERT INTO calls (id, source, status, started_at) VALUES ('c1', 'telephony', 'ended', '2026-10-01T10:00:00Z');
    INSERT INTO outcomes (call_id, application_number, outcome, notes, follow_up_date, at)
      VALUES ('c1', 'GV-2026-000123', 'informed', 'Asked about fees', '2026-10-05', '2026-10-01T10:05:00Z');
  `);
  const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  put.run("config", JSON.stringify(OLD_CONFIG));
  put.run("applicantsSeeded", "true");
  db.close();
  return file;
}

for (const withStatusDate of [false, true]) {
  test(`an old database ${withStatusDate ? "with" : "without"} status_date migrates cleanly`, () => {
    const file = makeOldDb(`old-${withStatusDate}.db`, { withStatusDate });

    const { cfg, customised } = boot(file);
    assert.deepEqual(customised, ["model", "temperature", "profiles.golden_visa.systemPrompt"]);
    const gv = cfg.profiles.golden_visa;
    assert.equal(gv.systemPrompt, "Custom prompt");
    assert.equal(gv.knowledgeBase, kbFile.trim(), "a stale copy of the old knowledge base follows the file");
    assert.match(gv.greetingInstruction, /information line/, "a stale copy of the old greeting follows the new default");
    assert.equal(cfg.activeProfile, "golden_visa");
    assert.equal(cfg.vad.startSensitivity, "START_SENSITIVITY_LOW", "an invalid saved value is dropped");
    assert.equal(cfg.reminderDays, undefined);

    const after = inspect(file);
    assert.equal(after.version, 3);
    assert.ok(!after.tables.includes("applicants"));
    assert.equal(after.calls[0].profile, "golden_visa");
    assert.equal(after.rooms.length, 4);
    assert.deepEqual(after.outcomeColumns, ["id", "call_id", "outcome", "notes", "at"]);
    assert.deepEqual(after.outcomes, [{ call_id: "c1", outcome: "informed", notes: "Asked about fees" }]);
    assert.deepEqual(after.settings, {
      config: {
        geminiApiKey: "old-key",
        model: "custom-model",
        temperature: 0.7,
        profiles: { golden_visa: { systemPrompt: "Custom prompt" } },
      },
    });

    // Starting again changes nothing.
    boot(file);
    assert.deepEqual(inspect(file), after);
  });
}

test("a new database gets the current schema", () => {
  const file = path.join(dir, "new.db");
  const { customised } = boot(file);
  assert.deepEqual(customised, []);
  const db = inspect(file);
  assert.equal(db.version, 3);
  assert.deepEqual(db.tables.filter((t) => t !== "sqlite_sequence").sort(), [
    "call_events",
    "calls",
    "outcomes",
    "reservations",
    "room_types",
    "settings",
    "transcript",
  ]);
  assert.deepEqual(
    db.rooms.map((r) => [r.code, r.max_guests, r.nightly_rate_aed, r.inventory]),
    [
      ["DLX", 2, 950, 20],
      ["PRM", 3, 1250, 12],
      ["STE", 4, 2400, 5],
      ["PRS", 4, 9000, 1],
    ],
  );
  assert.deepEqual(db.outcomeColumns, ["id", "call_id", "outcome", "notes", "at"]);
  assert.deepEqual(db.settings, { config: {} });
});

// A database as the previous version (schema 2) left it, with settings saved
// before profiles existed: the Golden Visa settings at the top level.
function makeV2Db(name, config) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE calls (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, remote TEXT, status TEXT NOT NULL, room_id TEXT, call_id TEXT,
      cli TEXT, dni TEXT, custom_parameters TEXT NOT NULL DEFAULT '{}', model TEXT, voice TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT
    );
    CREATE TABLE transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      level TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
    INSERT INTO calls (id, source, status, model, voice, started_at) VALUES ('c1', 'telephony', 'ended', 'm', 'Kore', '2026-10-01T10:00:00Z');
    PRAGMA user_version = 2;
  `);
  db.prepare("INSERT INTO settings (key, value) VALUES ('config', ?)").run(JSON.stringify(config));
  db.close();
  return file;
}

test("migration 3: a schema 2 database gets profiles and the hotel tables", () => {
  const file = makeV2Db("v2.db", {
    model: "custom-model",
    voice: "Puck",
    transferNumber: "+971500000000",
    supportContact: "Custom desk",
    vad: { silenceDurationMs: 500 },
  });

  const { cfg, customised } = boot(file);
  assert.deepEqual(customised, [
    "model",
    "vad.silenceDurationMs",
    "profiles.golden_visa.supportContact",
    "profiles.golden_visa.transferNumber",
    "profiles.golden_visa.voice",
  ]);
  assert.equal(cfg.profiles.golden_visa.voice, "Puck");
  assert.equal(cfg.profiles.taj_dubai.voice, "Aoede", "the new profile gets its defaults");
  assert.equal(cfg.voice, undefined, "no top-level profile settings left");

  const after = inspect(file);
  assert.equal(after.version, 3);
  assert.ok(after.tables.includes("room_types") && after.tables.includes("reservations"));
  assert.equal(after.calls[0].profile, "golden_visa", "earlier calls were Golden Visa calls");
  assert.deepEqual(after.rooms.map((r) => r.code), ["DLX", "PRM", "STE", "PRS"]);
  assert.deepEqual(after.settings.config, {
    model: "custom-model",
    vad: { silenceDurationMs: 500 },
    profiles: { golden_visa: { supportContact: "Custom desk", transferNumber: "+971500000000", voice: "Puck" } },
  });

  // Starting again changes nothing, and edited rooms are not re-seeded.
  const db = new DatabaseSync(file);
  db.exec("DELETE FROM room_types WHERE code != 'DLX'");
  db.close();
  boot(file);
  const again = inspect(file);
  assert.deepEqual(again.rooms.map((r) => r.code), ["DLX"]);
  assert.deepEqual({ ...again, rooms: after.rooms }, after);
});

test("calls record their profile", () => {
  const file = path.join(dir, "calls.db");
  const script = `const db = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
    const info = { id: "a", source: "test", remote: "", status: "active", model: "m", voice: "Aoede", profile: "taj_dubai",
      startedAt: "2026-10-21T10:00:00Z", roomId: null, callId: null, cli: null, dni: null, endedAt: null, endReason: null };
    db.insertCall(info);
    db.updateCall({ ...info, status: "ended", endedAt: "2026-10-21T10:05:00Z", endReason: "done" });
    db.insertCall({ ...info, id: "b", profile: undefined, startedAt: "2026-10-21T09:00:00Z" });
    db.updateCall({ ...info, id: "b", profile: undefined, status: "ended" });
    const pick = (c) => ({ id: c.id, profile: c.profile, profileName: c.profileName });
    console.log(JSON.stringify({ recent: db.recentCalls().map(pick), one: pick(db.getCall("a")) }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DB_PATH: file },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const { recent, one } = JSON.parse(out.trim().split("\n").at(-1));
  assert.deepEqual(recent, [
    { id: "a", profile: "taj_dubai", profileName: "Taj Dubai reservations" },
    { id: "b", profile: "golden_visa", profileName: "Golden Visa FAQ" },
  ]);
  assert.deepEqual(one, { id: "a", profile: "taj_dubai", profileName: "Taj Dubai reservations" });
});
