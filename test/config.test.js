import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.js opens the database on import, so point it at a temp file first.
const dir = mkdtempSync(path.join(tmpdir(), "ncx-config-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.GEMINI_API_KEY = "";
const config = await import("../src/config.js");
const db = await import("../src/db.js");
const { DEFAULTS, PROFILES, callConfig, getConfig, publicConfig, resetConfig, updateConfig, validate } = config;
after(() => rmSync(dir, { recursive: true, force: true }));

const stored = () => db.readSetting("config");

test("validate never throws and reports bad types", () => {
  for (const bad of [null, undefined, "x", 5, []]) assert.ok(validate(bad).length > 0);
  assert.deepEqual(validate(getConfig()), []);
  const errors = validate({ ...getConfig(), model: 5, botSpeaksFirst: "yes", temperature: "0.5", vad: "loud" });
  assert.equal(errors.length, 7, errors.join("\n")); // model, botSpeaksFirst, temperature and the four vad settings
});

test("bad settings are rejected and nothing is saved", () => {
  const before = stored();
  const cases = [
    { vad: { startSensitivity: "BOGUS" } },
    { vad: { endSensitivity: "START_SENSITIVITY_LOW" } },
    { vad: { prefixPaddingMs: -1 } },
    { vad: { silenceDurationMs: 10001 } },
    { vad: { silenceDurationMs: 1.5 } },
    { vad: 5 },
    { model: 5 },
    { model: "  " },
    { profiles: { golden_visa: { systemPrompt: null } } },
    { profiles: { taj_dubai: { systemPrompt: " " } } },
    { profiles: { golden_visa: { greetingInstruction: 5 } } },
    { profiles: { taj_dubai: { knowledgeBase: "x".repeat(100001) } } },
    { profiles: { golden_visa: { supportContact: ["a"] } } },
    { profiles: { taj_dubai: { voice: "Nobody" } } },
    { profiles: { taj_dubai: { transferNumber: "call me" } } },
    { profiles: { taj_dubai: "Puck" } },
    { profiles: [] },
    { activeProfile: "nope" },
    { activeProfile: null },
    { temperature: 3 },
    { temperature: "0.5" },
    { timezone: "Mars/Olympus" },
    { timezone: 5 },
    { forwardDtmf: "true" },
    { enableEndCall: 1 },
    { silenceTimeoutSec: 61 },
    { silenceReprompts: "2" },
    { profiles: { golden_visa: { transferNumber: 971500000000 } } },
    { chunkSize: 1599 },
    { chunkSize: 1700 },
    { chunkSize: 8160 },
    { chunkSize: "1600" },
    { geminiApiKey: 12345 },
    null,
    [],
    "model",
  ];
  for (const patch of cases) {
    const result = updateConfig(patch);
    assert.ok(result.errors?.length, `expected errors for ${JSON.stringify(patch)}`);
    assert.equal(result.config, undefined);
  }
  assert.deepEqual(stored(), before);
});

test("good edge values are accepted", () => {
  for (const patch of [{ chunkSize: 8000 }, { chunkSize: 3200 }, { temperature: null }, { temperature: 0 }, { vad: { prefixPaddingMs: 0 } }]) {
    assert.equal(updateConfig(patch).errors, undefined, JSON.stringify(patch));
  }
  resetConfig();
});

test("only settings that differ from the defaults are stored", () => {
  resetConfig();
  // The UI sends the whole form back, including fields it doesn't own.
  const form = { ...publicConfig(), geminiApiKey: "", clearGeminiApiKey: false, junk: { a: 1 }, reminderDays: 9 };
  const { config } = updateConfig({ ...form, model: "gemini-test", vad: { ...form.vad, silenceDurationMs: 500 } });
  assert.deepEqual(stored(), { model: "gemini-test", vad: { silenceDurationMs: 500 } });
  assert.deepEqual(config.customised, ["model", "vad.silenceDurationMs"]);
  assert.equal(config.activeProfile, "golden_visa");
  assert.deepEqual(Object.keys(config.profiles), ["golden_visa", "taj_dubai"]);
  assert.equal(config.junk, undefined);
  assert.equal(config.geminiApiKey, undefined);

  // Setting a value back to its default drops the override.
  updateConfig({ model: DEFAULTS.model });
  assert.deepEqual(stored(), { vad: { silenceDurationMs: 500 } });
  resetConfig();
});

test("a changed default reaches settings that aren't customised", () => {
  resetConfig();
  updateConfig({ model: "custom-model" });
  const gv = DEFAULTS.profiles.golden_visa;
  const saved = { model: DEFAULTS.model, greeting: gv.greetingInstruction, pad: DEFAULTS.vad.prefixPaddingMs };
  try {
    // Stands in for editing the defaults in code and redeploying.
    DEFAULTS.model = "new-default-model";
    gv.greetingInstruction = "New greeting";
    DEFAULTS.vad.prefixPaddingMs = 40;
    const cfg = getConfig();
    assert.equal(cfg.model, "custom-model", "an override wins");
    assert.equal(cfg.profiles.golden_visa.greetingInstruction, "New greeting");
    assert.equal(cfg.vad.prefixPaddingMs, 40);
  } finally {
    DEFAULTS.model = saved.model;
    gv.greetingInstruction = saved.greeting;
    DEFAULTS.vad.prefixPaddingMs = saved.pad;
  }
  resetConfig();
});

test("reset clears overrides but keeps the Gemini key", () => {
  updateConfig({ geminiApiKey: "key-1", model: "custom-model", botSpeaksFirst: false });
  assert.equal(config.apiKey(), "key-1");
  updateConfig({ geminiApiKey: "" });
  assert.equal(config.apiKey(), "key-1", "an empty key keeps the saved one");
  const cfg = resetConfig();
  assert.deepEqual(stored(), { geminiApiKey: "key-1" });
  assert.equal(cfg.apiKeySource, "ui");
  assert.deepEqual(cfg.customised, []);
  assert.equal(cfg.geminiApiKey, undefined);
  updateConfig({ clearGeminiApiKey: true });
  assert.deepEqual(stored(), {});
  assert.equal(publicConfig().apiKeySource, "none");
});

test("the default Golden Visa prompt is a general FAQ line", () => {
  const { systemPrompt, greetingInstruction } = DEFAULTS.profiles.golden_visa;
  assert.doesNotMatch(systemPrompt, /verify_applicant|get_application_status|reminder_days|portal/);
  assert.match(systemPrompt, /never ask for application numbers/);
  assert.match(systemPrompt, /end_call if it is available/);
  assert.match(greetingInstruction, /Golden Visa information line/);
  assert.equal("reminderDays" in DEFAULTS, false);
});

test("profiles: the list, defaults and a different voice per profile", () => {
  assert.deepEqual(PROFILES, [
    { id: "golden_visa", name: "Golden Visa FAQ" },
    { id: "taj_dubai", name: "Taj Dubai reservations" },
  ]);
  const { golden_visa: gv, taj_dubai: taj } = DEFAULTS.profiles;
  assert.equal(DEFAULTS.activeProfile, "golden_visa");
  assert.notEqual(gv.voice, taj.voice);
  assert.match(taj.systemPrompt, /check_availability/);
  assert.match(taj.systemPrompt, /create_reservation/);
  assert.match(taj.systemPrompt, /\{\{cli\}\}/);
  assert.match(taj.systemPrompt, /end_call if it is available/);
  assert.match(taj.greetingInstruction, /Taj Dubai reservations/);
  assert.match(taj.knowledgeBase, /^DEMO DATA for testing/);
  assert.doesNotMatch(taj.supportContact, /\d|@/, "no made-up contact details");
});

test("profiles: partial patches, switching, customised paths and per-profile reset", () => {
  resetConfig();
  let { config, errors } = updateConfig({ profiles: { taj_dubai: { voice: "Puck", name: "Renamed" } } });
  assert.equal(errors, undefined);
  assert.equal(config.profiles.taj_dubai.voice, "Puck");
  assert.equal(config.profiles.taj_dubai.name, "Taj Dubai reservations", "names can't be changed");
  assert.equal(config.profiles.golden_visa.voice, "Kore");
  assert.equal(config.activeProfile, "golden_visa", "editing a profile doesn't switch to it");
  assert.deepEqual(stored(), { profiles: { taj_dubai: { voice: "Puck" } } });

  ({ config } = updateConfig({ activeProfile: "taj_dubai", model: "m2", profiles: { golden_visa: { supportContact: "Desk" }, nobody: { voice: "Puck" } } }));
  assert.equal(config.activeProfile, "taj_dubai");
  assert.equal(config.profiles.nobody, undefined, "unknown profiles are ignored");
  assert.deepEqual(config.customised, [
    "model",
    "activeProfile",
    "profiles.golden_visa.supportContact",
    "profiles.taj_dubai.voice",
  ]);
  assert.equal(publicConfig().geminiApiKey, undefined);
  assert.equal(publicConfig().profiles.taj_dubai.geminiApiKey, undefined);

  // A rejected patch changes nothing, even its valid parts.
  const before = stored();
  assert.ok(updateConfig({ activeProfile: "golden_visa", profiles: { taj_dubai: { voice: "Nobody" } } }).errors.length);
  assert.deepEqual(stored(), before);

  // Resetting one profile leaves the other and the shared settings alone.
  config = resetConfig("taj_dubai");
  assert.equal(config.profiles.taj_dubai.voice, DEFAULTS.profiles.taj_dubai.voice);
  assert.equal(config.profiles.golden_visa.supportContact, "Desk");
  assert.equal(config.activeProfile, "taj_dubai");
  assert.deepEqual(stored(), { model: "m2", activeProfile: "taj_dubai", profiles: { golden_visa: { supportContact: "Desk" } } });
  resetConfig("golden_visa");
  assert.deepEqual(stored(), { model: "m2", activeProfile: "taj_dubai" });
  resetConfig("no_such_profile");
  assert.deepEqual(stored(), { model: "m2", activeProfile: "taj_dubai" }, "an unknown profile id resets nothing");
  resetConfig();
  assert.deepEqual(stored(), {});
  assert.equal(publicConfig().activeProfile, "golden_visa");
});

test("callConfig flattens the active profile for a call", () => {
  resetConfig();
  updateConfig({ geminiApiKey: "secret", model: "m3", profiles: { taj_dubai: { transferNumber: "+971500000001" } } });
  let cfg = callConfig();
  assert.equal(cfg.profile, "golden_visa");
  assert.equal(cfg.profileName, "Golden Visa FAQ");
  assert.equal(cfg.systemPrompt, DEFAULTS.profiles.golden_visa.systemPrompt);
  assert.equal(cfg.transferNumber, "");
  assert.equal(cfg.model, "m3");
  assert.deepEqual(cfg.vad, DEFAULTS.vad);
  for (const key of ["profiles", "activeProfile", "geminiApiKey", "name"]) assert.equal(key in cfg, false, key);

  updateConfig({ activeProfile: "taj_dubai" });
  cfg = callConfig();
  assert.equal(cfg.profile, "taj_dubai");
  assert.equal(cfg.profileName, "Taj Dubai reservations");
  assert.equal(cfg.voice, DEFAULTS.profiles.taj_dubai.voice);
  assert.equal(cfg.transferNumber, "+971500000001");
  assert.equal(cfg.knowledgeBase, DEFAULTS.profiles.taj_dubai.knowledgeBase);

  // A snapshot: changing it doesn't touch the config, nor the other way round.
  cfg.vad.silenceDurationMs = 1;
  updateConfig({ profiles: { taj_dubai: { voice: "Puck" } } });
  assert.equal(getConfig().vad.silenceDurationMs, DEFAULTS.vad.silenceDurationMs);
  assert.equal(cfg.voice, DEFAULTS.profiles.taj_dubai.voice);
  resetConfig();
  updateConfig({ clearGeminiApiKey: true });
});
