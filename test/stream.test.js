import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "ncx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Starts the real server without a Gemini key and plays the NeuraCX side.
// PORT=0 picks a free port; the server logs the one it got.
function spawnServer(t, env = {}) {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
      NODE_ENV: "",
      UI_PASSWORD: "",
      STREAM_TOKEN: "",
      MAX_CALLS: "",
      TRUST_PROXY: "",
      PORT: "0",
      DB_PATH: path.join(tempDir(t), "test.db"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = once(child, "exit");
  t.after(() => child.kill());
  return { child, exited, output: () => output };
}

async function startServer(t, env) {
  const srv = spawnServer(t, env);
  let done = false;
  srv.exited.then(() => (done = true));
  let port;
  while (!(port = srv.output().match(/Listening on http:\/\/localhost:(\d+)/)?.[1])) {
    if (done) throw new Error(`Server exited before listening:\n${srv.output()}`);
    await sleep(50);
  }
  return { ...srv, port, url: (p) => `http://localhost:${port}${p}` };
}

const send = (srv, method, p, body, headers = {}) =>
  fetch(srv.url(p), {
    method,
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function waitFor(check) {
  for (;;) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
}

test("no Gemini key: start is answered with exit, and the call is listed", async (t) => {
  const srv = await startServer(t);

  const ws = new WebSocket(`ws://localhost:${srv.port}/stream`);
  await once(ws, "open");
  const received = [];
  ws.on("message", (m) => received.push(JSON.parse(m)));
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({
    event: "start",
    sequence_number: 1,
    room_id: "1_2_ROOM",
    start: { room_id: "1_2_ROOM", call_id: "2", cli: "+911", dni: "+912", custom_parameters: {}, media_format: { encoding: "raw", sample_rate: "8000", bit_rate: "128000" } },
  }));

  await waitFor(() => received.some((m) => m.event === "exit"));
  assert.deepEqual(received.find((m) => m.event === "exit"), { event: "exit", room_id: "1_2_ROOM", exit: { parameters: [] } });

  const calls = await (await fetch(srv.url("/api/calls"))).json();
  assert.equal(calls.active[0].cli, "+911");
  ws.send(JSON.stringify({ event: "stop", sequence_number: 2, room_id: "1_2_ROOM", stop: { call_id: "2", reason: "exit" } }));
  await once(ws, "close");

  // The finished call is in the database with its event log.
  const { recent } = await (await fetch(srv.url("/api/calls"))).json();
  const { call } = await (await fetch(srv.url(`/api/calls/${recent[0].id}`))).json();
  assert.equal(call.status, "ended");
  assert.ok(call.log.some((e) => e.text.includes("No Gemini API key")));
});

test("stream token and UI password are enforced (production mode)", async (t) => {
  const srv = await startServer(t, { STREAM_TOKEN: "s3cret", UI_PASSWORD: "pw", NODE_ENV: "production" });

  const bad = new WebSocket(`ws://localhost:${srv.port}/stream`);
  const [err] = await once(bad, "error");
  assert.match(err.message, /401/);

  const good = new WebSocket(`ws://localhost:${srv.port}/stream?token=s3cret`);
  await once(good, "open");
  good.close();

  assert.equal((await fetch(srv.url("/api/config"))).status, 401);
  const auth = { Authorization: `basic ${Buffer.from("any:pw").toString("base64")}` };
  const res = await fetch(srv.url("/api/config"), { headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).config.geminiApiKey, undefined);
  assert.equal((await fetch(srv.url("/health"))).status, 200);
});

test("production mode refuses to start without UI_PASSWORD", async (t) => {
  const srv = spawnServer(t, { NODE_ENV: "production" });
  const [code] = await srv.exited;
  assert.notEqual(code, 0);
  assert.match(srv.output(), /UI_PASSWORD must be set/);
  assert.doesNotMatch(srv.output(), /Listening/);
});

test("state-changing API calls need X-Requested-With; bad bodies get a JSON error", async (t) => {
  const srv = await startServer(t);
  const noHeader = (method, p, body) =>
    fetch(srv.url(p), { method, headers: body ? { "Content-Type": "application/json" } : {}, body });

  assert.equal((await noHeader("POST", "/api/config/reset")).status, 403);
  assert.equal((await noHeader("POST", "/api/calls/x/hangup")).status, 403);
  assert.equal((await noHeader("PUT", "/api/config", JSON.stringify({ activeProfile: "taj_dubai" }))).status, 403);
  assert.equal((await noHeader("PUT", "/api/hotel/rooms", JSON.stringify({ rooms: [] }))).status, 403);
  assert.equal((await noHeader("POST", "/api/hotel/rooms/reset")).status, 403);
  assert.equal((await noHeader("POST", "/api/hotel/reservations/TAJ-X/cancel")).status, 403);
  assert.equal((await send(srv, "POST", "/api/config/reset")).status, 200);
  assert.equal((await send(srv, "POST", "/api/calls/x/hangup")).status, 404);

  const badJson = await fetch(srv.url("/api/config"), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: "{not json",
  });
  assert.equal(badJson.status, 400);
  const body = await badJson.json();
  assert.ok(body.error);
  assert.doesNotMatch(JSON.stringify(body), /at .*\.js/);
});

test("MAX_CALLS caps concurrent streams and oversized frames are refused", async (t) => {
  const srv = await startServer(t, { MAX_CALLS: "1" });

  const first = new WebSocket(`ws://localhost:${srv.port}/stream`);
  await once(first, "open");
  const second = new WebSocket(`ws://localhost:${srv.port}/stream`);
  const [err] = await once(second, "error");
  assert.match(err.message, /503/);

  // Frames over 1 MiB close the stream with 1009 (message too big).
  first.send(Buffer.alloc(2 * 1024 * 1024, 0x61));
  const [code] = await once(first, "close");
  assert.equal(code, 1009);

  // The slot is free again once the call has gone.
  const third = await waitFor(async () => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/stream`);
    const [result] = await Promise.race([once(ws, "open").then(() => ["open"]), once(ws, "error")]);
    return result === "open" ? ws : null;
  });
  third.close();
});

test("SIGTERM hangs up live calls and exits cleanly", async (t) => {
  const srv = await startServer(t);
  const ws = new WebSocket(`ws://localhost:${srv.port}/stream`);
  await once(ws, "open");
  const received = [];
  ws.on("message", (m) => received.push(JSON.parse(m)));
  ws.send(JSON.stringify({ event: "connected" }));
  await waitFor(async () => (await (await fetch(srv.url("/api/calls"))).json()).active.length === 1);

  srv.child.kill("SIGTERM");
  const [code] = await srv.exited;
  assert.equal(code, 0);
  assert.ok(received.some((m) => m.event === "exit"), "the live call was sent exit");
  assert.match(srv.output(), /SIGTERM received/);
});

test("config is validated and survives a restart", async (t) => {
  const env = { DB_PATH: path.join(tempDir(t), "persist.db") };
  let srv = await startServer(t, env);
  const put = (url, body) => send(srv, "PUT", url, body);

  assert.equal((await put("/api/config", { chunkSize: 1000 })).status, 400);
  assert.equal((await put("/api/config", { silenceTimeoutSec: -1 })).status, 400);
  const ok = await put("/api/config", { geminiApiKey: "abc", vad: { silenceDurationMs: 500 } });
  const { config } = await ok.json();
  assert.equal(config.apiKeySource, "ui");
  assert.equal(config.vad.silenceDurationMs, 500);
  assert.equal(config.vad.startSensitivity, "START_SENSITIVITY_LOW");

  srv.child.kill();
  await srv.exited;
  srv = await startServer(t, env);
  const after = await (await fetch(srv.url("/api/config"))).json();
  assert.equal(after.config.apiKeySource, "ui");
  assert.equal(after.config.vad.silenceDurationMs, 500);
});

test("use cases: partial patches switch and edit profiles, survive a restart, and reset per profile", async (t) => {
  const env = { DB_PATH: path.join(tempDir(t), "profiles.db") };
  let srv = await startServer(t, env);
  const getConfig = async () => (await fetch(srv.url("/api/config"))).json();

  const first = await getConfig();
  assert.deepEqual(first.profiles.map((p) => p.id), ["golden_visa", "taj_dubai"]);
  assert.equal(first.config.activeProfile, "golden_visa");
  for (const id of ["golden_visa", "taj_dubai"]) {
    const p = first.config.profiles[id];
    for (const f of ["name", "systemPrompt", "greetingInstruction", "knowledgeBase", "supportContact", "transferNumber", "voice"]) {
      assert.ok(f in p, `${id}.${f}`);
    }
  }
  const defaults = first.config.profiles;

  assert.equal((await send(srv, "PUT", "/api/config", { activeProfile: "nope" })).status, 400);
  const res = await send(srv, "PUT", "/api/config", { activeProfile: "taj_dubai", profiles: { taj_dubai: { voice: "Puck" } } });
  assert.equal(res.status, 200);
  const { config } = await res.json();
  assert.equal(config.activeProfile, "taj_dubai");
  assert.equal(config.profiles.taj_dubai.voice, "Puck");
  assert.equal(config.profiles.golden_visa.voice, defaults.golden_visa.voice);
  assert.ok(config.customised.includes("profiles.taj_dubai.voice"));
  assert.ok(!config.customised.includes("profiles.taj_dubai.systemPrompt"));
  assert.equal((await send(srv, "PUT", "/api/config", { profiles: { golden_visa: { supportContact: "help@example.com" } } })).status, 200);

  srv.child.kill();
  await srv.exited;
  srv = await startServer(t, env);
  let after = (await getConfig()).config;
  assert.equal(after.activeProfile, "taj_dubai");
  assert.equal(after.profiles.taj_dubai.voice, "Puck");
  assert.equal(after.profiles.golden_visa.supportContact, "help@example.com");

  // Resetting one use case leaves the other one, and which one is live, alone.
  assert.equal((await send(srv, "POST", "/api/config/reset", { profile: "bogus" })).status, 400);
  after = (await (await send(srv, "POST", "/api/config/reset", { profile: "taj_dubai" })).json()).config;
  assert.equal(after.profiles.taj_dubai.voice, defaults.taj_dubai.voice);
  assert.equal(after.profiles.golden_visa.supportContact, "help@example.com");
  assert.equal(after.activeProfile, "taj_dubai");

  after = (await (await send(srv, "POST", "/api/config/reset")).json()).config;
  assert.equal(after.profiles.golden_visa.supportContact, defaults.golden_visa.supportContact);
  assert.equal(after.activeProfile, "golden_visa");
});

test("hotel rooms can be edited, are validated and reset; reservations list and cancel", async (t) => {
  const dbPath = path.join(tempDir(t), "hotel.db");
  const srv = await startServer(t, { DB_PATH: dbPath });
  const getJson = async (p) => (await fetch(srv.url(p))).json();

  const { rooms: demo } = await getJson("/api/hotel/rooms");
  assert.ok(demo.length > 0);
  for (const f of ["code", "name", "description", "max_guests", "nightly_rate_aed", "inventory"]) assert.ok(f in demo[0], f);

  for (const body of [{ rooms: "x" }, {}, { rooms: [{ code: "", name: "", max_guests: 0, nightly_rate_aed: -5, inventory: -1 }] }]) {
    const bad = await send(srv, "PUT", "/api/hotel/rooms", body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.ok((await bad.json()).errors.length > 0);
  }

  const edited = demo.map((r, i) => (i === 0 ? { ...r, nightly_rate_aed: r.nightly_rate_aed + 100 } : r));
  const put = await send(srv, "PUT", "/api/hotel/rooms", { rooms: edited });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).rooms.find((r) => r.code === demo[0].code).nightly_rate_aed, demo[0].nightly_rate_aed + 100);
  assert.equal((await getJson("/api/hotel/rooms")).rooms.find((r) => r.code === demo[0].code).nightly_rate_aed, demo[0].nightly_rate_aed + 100);

  const reset = await send(srv, "POST", "/api/hotel/rooms/reset");
  assert.deepEqual((await reset.json()).rooms, demo);

  assert.deepEqual(await getJson("/api/hotel/reservations"), { reservations: [] });
  assert.deepEqual(await getJson("/api/hotel/reservations?status=booked"), { reservations: [] });
  assert.equal((await fetch(srv.url("/api/hotel/reservations?status=bogus"))).status, 400);
  assert.equal((await send(srv, "POST", "/api/hotel/reservations/TAJ-NOPE/cancel")).status, 404);

  // Book one the way the bot does (in this process, on the server's database),
  // then cancel it from the API and watch the UI's event stream.
  process.env.DB_PATH = dbPath;
  const hotel = await import("../src/hotel.js");
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const { reservation, error } = hotel.createReservation({
    check_in: day(10), check_out: day(12), guests: 1, room_code: demo[0].code, guest_name: "Asha Rao", phone: "+971500000001",
  });
  assert.equal(error, undefined);
  const { reservations } = await getJson("/api/hotel/reservations?status=booked");
  assert.deepEqual(reservations.map((r) => r.confirmation_number), [reservation.confirmation_number]);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = (await fetch(srv.url("/api/events"), { signal: controller.signal })).body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = await send(srv, "POST", `/api/hotel/reservations/${reservation.confirmation_number}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).reservation.status, "cancelled");
  let stream = "";
  while (!stream.includes('"reservation.changed"')) stream += (await events.read()).value;
  assert.deepEqual(await getJson("/api/hotel/reservations?status=booked"), { reservations: [] });
  assert.equal((await getJson("/api/hotel/reservations")).reservations[0].status, "cancelled");
});
