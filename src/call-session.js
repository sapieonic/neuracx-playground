import { GoogleGenAI, Modality } from "@google/genai";
import { FrameChunker, PcmResampler } from "./audio.js";
import * as calls from "./calls.js";
import { apiKey, callConfig } from "./config.js";
import * as db from "./db.js";
import { log } from "./log.js";
import { runTool, toolDeclarations } from "./tools.js";

const GEMINI_INPUT_RATE = 16000;
const GEMINI_OUTPUT_RATE = 24000;
// Log caller audio stats every this many media frames (100 frames = 10 s at 1600 bytes / 8 kHz).
const AUDIO_STATS_EVERY = 100;
// How long to wait for the bot's goodbye turn to finish after it asks to hang up.
const EXIT_TURN_TIMEOUT_MS = 8000;
// Extra wait on top of the estimated playout before we stop trusting marks.
const EXIT_PLAYOUT_GRACE_MS = 1500;
// Give up on a Gemini session that hasn't finished its setup by then.
const CONNECT_TIMEOUT_MS = 15000;
// Reconnects in a row without a completed turn before we hang up. The first
// one is immediate, then we back off (doubling from this).
const MAX_RECONNECTS = 3;
const RECONNECT_BACKOFF_MS = 500;
// A session that stayed up this long counts as healthy when it closes.
const STABLE_SESSION_MS = 30000;
// After goAway, start the handover at the latest this long before the cut-off.
const HANDOVER_MARGIN_MS = 3000;
// Caller input held back while a new session opens (about 15 s of audio).
const MAX_QUEUED_INPUT = 150;
// Close codes that mean Gemini rejected the request itself; retrying won't help.
const FATAL_CLOSE_CODES = new Set([1003, 1007, 1008]);
const DTMF_DIGIT = /^[0-9*#A-D]$/i;

let counter = 0;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Ids and numbers from the stream arrive as strings or numbers. Anything else
// becomes null so it never reaches SQLite or the prompt.
function idString(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v ? v.slice(0, 200) : null;
}

// goAway.timeLeft is a protobuf duration, usually a string like "9.5s".
function durationMs(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return v * 1000;
  if (typeof v === "string" && Number.isFinite(parseFloat(v))) return parseFloat(v) * 1000;
  if (isObject(v)) return (Number(v.seconds) || 0) * 1000 + (Number(v.nanos) || 0) / 1e6;
  return fallback;
}

function defaultConnectLive(params) {
  return new GoogleGenAI({ apiKey: apiKey() }).live.connect(params);
}

function buildLiveConfig(cfg, systemInstruction, resumeHandle) {
  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: cfg.vad.startSensitivity,
        endOfSpeechSensitivity: cfg.vad.endSensitivity,
        prefixPaddingMs: cfg.vad.prefixPaddingMs,
        silenceDurationMs: cfg.vad.silenceDurationMs,
      },
    },
    // Without these an audio session is capped at ~15 minutes and a single
    // connection at ~10 minutes.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  if (cfg.temperature !== null) config.temperature = cfg.temperature;
  config.tools = [{ functionDeclarations: toolDeclarations(cfg) }];
  return config;
}

// One NeuraCX stream (one phone call) bridged to one Gemini Live session.
// `connectLive` swaps out the Gemini client (tests use a fake one).
export class CallSession {
  constructor(ws, { source, remote, connectLive = defaultConnectLive } = {}) {
    this.ws = ws;
    this.connectLive = connectLive;
    this.id = `call-${Date.now().toString(36)}-${++counter}`;
    // Snapshot the config (shared settings plus the active profile's) so edits
    // in the UI, including switching profile, only affect the next call.
    this.cfg = callConfig();

    this.info = {
      id: this.id,
      source,
      remote,
      status: "connecting",
      roomId: null,
      callId: null,
      cli: null,
      dni: null,
      customParameters: {},
      sampleRate: 8000,
      model: this.cfg.model,
      voice: this.cfg.voice,
      profile: this.cfg.profile,
      profileName: this.cfg.profileName,
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      transcript: [],
      log: [],
      outcomes: [],
    };

    this.lastTranscriptRow = null;
    this.silenceTimer = null;
    this.silentChecks = 0;
    this.badFrames = 0;

    this.seq = 0;
    this.chunk = 0;
    this.turn = 0;
    this.started = false;
    this.ended = false;

    // Gemini connections ("links"). `link` gets the caller's input; `nextLink`
    // is a session being opened to replace it after a close or a goAway.
    this.link = null;
    this.nextLink = null;
    this.linkCount = 0;
    this.resumeHandle = null;
    this.reconnectFailures = 0;
    this.reconnectTimer = null;
    // While a replacement session opens, caller input waits here (null otherwise).
    this.inputQueue = null;

    this.resampler = new PcmResampler(GEMINI_OUTPUT_RATE, this.info.sampleRate);
    this.inResampler = new PcmResampler(this.info.sampleRate, GEMINI_INPUT_RATE);
    this.audioStats = { frames: 0, bytes: 0, peak: 0, sumSquares: 0, samples: 0, total: 0 };
    this.chunker = new FrameChunker(this.cfg.chunkSize);
    this.playoutEndsAt = 0;
    // Bot audio was sent since its last turnComplete, i.e. it is mid-reply.
    this.botTurnAudio = false;
    // The bot has said something since the caller last spoke.
    this.spokeSinceCaller = false;

    this.pendingExit = null;
    this.exitTimer = null;
    this.exitDeadline = 0;
    this.exitSent = false;

    calls.add(this);
    this.note(`Stream connected from ${remote} (${source})`);

    ws.on("message", (raw) => this.guard("Handling a stream frame", () => this.onTelephony(raw)));
    ws.on("close", (code) => this.guard("Closing the call", () => this.finish(`stream closed (code ${code})`)));
    ws.on("error", (e) => this.guard("Stream error", () => this.note(`Stream socket error: ${e.message}`, "error")));
  }

  // Runs a handler so that nothing it throws, or rejects with, can take the
  // whole server down with it.
  guard(what, fn) {
    try {
      const result = fn();
      if (typeof result?.catch === "function") result.catch((e) => this.failed(what, e));
    } catch (e) {
      this.failed(what, e);
    }
  }

  failed(what, e) {
    try {
      this.note(`${what} failed: ${e?.stack || e}`, "error");
    } catch (e2) {
      log.error(`[${this.id}] ${what} failed: ${e?.stack || e} (and logging it failed: ${e2?.message || e2})`);
    }
  }

  // ── telephony → bot ──────────────────────────────────────────────────────

  onTelephony(raw) {
    if (this.ended) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.badFrame("Ignored a non-JSON frame from the stream");
      return;
    }
    if (!isObject(msg) || typeof msg.event !== "string") {
      this.badFrame("Ignored a frame that is not an event object");
      return;
    }

    switch (msg.event) {
      case "connected":
        this.note("Received connected");
        break;
      case "start":
        this.onStart(msg);
        break;
      case "media":
        this.onCallerAudio(isObject(msg.media) ? msg.media.payload : undefined);
        break;
      case "dtmf":
        this.onDtmf(isObject(msg.dtmf) ? msg.dtmf : {});
        break;
      case "mark":
        this.onMark(isObject(msg.mark) ? idString(msg.mark.name) : null);
        break;
      case "stop": {
        const reason = (isObject(msg.stop) && idString(msg.stop.reason)) || null;
        this.note(`Received stop: ${reason || "no reason given"}`);
        this.finish(reason || "stop received");
        break;
      }
      default:
        this.badFrame(`Ignored unknown event "${msg.event.slice(0, 40)}"`);
    }
  }

  // Logs the first bad frame and then every 100th, so junk can't flood the log.
  badFrame(text) {
    this.badFrames++;
    if (this.badFrames === 1 || this.badFrames % 100 === 0) {
      this.note(`${text}${this.badFrames > 1 ? ` (${this.badFrames} bad frames so far)` : ""}`, "warn");
    }
  }

  onStart(msg) {
    if (this.started) {
      this.note("Ignored a second start event", "warn");
      return;
    }
    this.started = true;
    const start = isObject(msg.start) ? msg.start : {};
    const format = isObject(start.media_format) ? start.media_format : {};
    const asked = parseInt(format.sample_rate, 10);
    const rate = asked >= 8000 && asked <= 48000 ? asked : 8000;
    if (format.sample_rate != null && rate !== asked) this.note(`Unusable sample rate, assuming ${rate} Hz`, "warn");
    Object.assign(this.info, {
      status: "active",
      roomId: idString(msg.room_id) ?? idString(start.room_id),
      callId: idString(start.call_id),
      cli: idString(start.cli),
      dni: idString(start.dni),
      customParameters: isObject(start.custom_parameters) ? start.custom_parameters : {},
      sampleRate: rate,
    });
    this.resampler = new PcmResampler(GEMINI_OUTPUT_RATE, rate);
    this.inResampler = new PcmResampler(rate, GEMINI_INPUT_RATE);
    calls.update(this);
    const encoding = typeof format.encoding === "string" ? format.encoding.slice(0, 20) : "raw";
    this.note(
      `Received start: room ${this.info.roomId}, call ${this.info.callId}, ${this.info.cli} → ${this.info.dni}, ` +
        `${encoding} @ ${rate} Hz`,
    );

    if (!apiKey()) {
      this.note("No Gemini API key configured, ending the call", "error");
      this.hangup("no Gemini API key");
      return;
    }
    this.guard("Opening Gemini", () => this.connectFirst());
  }

  onCallerAudio(payload) {
    if (this.ended) return;
    if (typeof payload !== "string") {
      this.badFrame("Ignored a media frame without a base64 payload");
      return;
    }
    if (!payload) return;
    const pcm = Buffer.from(payload, "base64");
    this.trackCallerAudio(pcm);
    if (!this.link && !this.inputQueue) return;
    // Gemini listens natively at 16 kHz. It claims to resample other rates
    // itself, but upsampling here is what NeuraCX's own starter kit does.
    const audio = {
      data: this.inResampler.process(pcm).toString("base64"),
      mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
    };
    this.sendInput((link) => link.session.sendRealtimeInput({ audio }));
  }

  // Periodically logs how much caller audio arrives and how loud it is, to
  // tell "no audio", "silence" and "wrong format" apart when the bot can't hear.
  trackCallerAudio(pcm) {
    const st = this.audioStats;
    st.frames++;
    st.total++;
    st.bytes += pcm.length;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i);
      st.peak = Math.max(st.peak, Math.abs(v));
      st.sumSquares += v * v;
      st.samples++;
    }
    if (st.total === 1) this.note(`First caller audio frame: ${pcm.length} bytes${this.link ? "" : " (Gemini not ready yet)"}`);
    if (st.frames < AUDIO_STATS_EVERY) return;

    const dbfs = (v) => (v > 0 ? `${(20 * Math.log10(v / 32768)).toFixed(1)} dBFS` : "silent");
    const rms = Math.sqrt(st.sumSquares / Math.max(1, st.samples));
    this.note(
      `Caller audio: ${st.frames} frames, avg ${Math.round(st.bytes / st.frames)} bytes, ` +
        `peak ${dbfs(st.peak)}, rms ${dbfs(rms)}${this.link ? "" : ", Gemini not connected"}`,
    );
    Object.assign(st, { frames: 0, bytes: 0, peak: 0, sumSquares: 0, samples: 0 });
  }

  onDtmf(dtmf) {
    const digit = typeof dtmf.digit === "number" ? String(dtmf.digit) : dtmf.digit;
    // Only real keypad digits: the text goes into the conversation.
    if (typeof digit !== "string" || !DTMF_DIGIT.test(digit)) {
      this.badFrame("Ignored a dtmf event without a valid digit");
      return;
    }
    const duration = Number(dtmf.duration);
    this.callerActive();
    this.note(`Caller pressed ${digit} (${Number.isFinite(duration) ? duration : "?"} ms)`);
    this.addTranscript("dtmf", digit);
    if (!this.cfg.forwardDtmf) return;
    this.sendClientText(`[The caller pressed ${digit} on their phone keypad]`);
  }

  onMark(name) {
    this.note(`Playback reached mark ${name}`);
    if (!this.pendingExit || !name || name !== this.pendingExit.mark) return;
    // Some platforms echo a mark when they receive it rather than after
    // playing it, so also wait for our own playout estimate. The fallback
    // timer armed at turnComplete stays the upper bound.
    const wait = this.playoutRemaining();
    if (wait <= 0) {
      this.sendExit();
      return;
    }
    this.note(`Goodbye may still be playing, sending exit in ${wait} ms`);
    this.armExitTimer(Math.min(wait, Math.max(0, this.exitDeadline - Date.now())));
  }

  // ── Gemini session ───────────────────────────────────────────────────────

  vars() {
    const now = new Intl.DateTimeFormat("en-IN", {
      timeZone: this.cfg.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());
    const vars = {
      cli: this.info.cli,
      dni: this.info.dni,
      call_id: this.info.callId,
      room_id: this.info.roomId,
      now,
      support_contact: this.cfg.supportContact,
    };
    for (const [k, v] of Object.entries(this.info.customParameters)) vars[`custom.${k}`] = v;
    return vars;
  }

  systemInstruction() {
    return [
      this.render(this.cfg.systemPrompt),
      `KNOWLEDGE BASE (approved information, the only facts you may give)\n${this.render(this.cfg.knowledgeBase)}`,
      `THIS CALL\nInbound call from ${this.info.cli || "an unknown number"}.`,
    ].join("\n\n");
  }

  render(template) {
    const vars = this.vars();
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => String(vars[key] ?? "unknown"));
  }

  // Opens one Gemini session. Resolves once its setup is complete; rejects if
  // it closes or stalls first (the SDK would otherwise wait forever).
  async openLink(handle) {
    const link = {
      n: ++this.linkCount,
      session: null,
      openedWith: handle,
      openedAt: 0,
      setupMs: 0,
      handle: null,
      // A resume handle arrived after the last thing this session did.
      handleFresh: false,
      // The model is generating, or was asked something it hasn't answered yet.
      midTurn: false,
      calls: new Set(),
      cancelled: new Set(),
      goingAway: false,
      pastDeadline: false,
      deadlineTimer: null,
      reopened: false,
      closed: false,
      fail: null,
    };
    const failed = new Promise((_, reject) => (link.fail = reject));
    failed.catch(() => {});
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no setup after ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS);
    });

    const started = Date.now();
    const connecting = Promise.resolve().then(() =>
      this.connectLive({
        model: this.cfg.model,
        config: buildLiveConfig(this.cfg, this.systemInstruction(), handle),
        callbacks: {
          onmessage: (m) => this.guard("Handling a Gemini message", () => this.onGemini(link, m)),
          onerror: (e) => this.guard("Gemini error", () => this.onGeminiError(link, e)),
          onclose: (e) => this.guard("Gemini close", () => this.onGeminiClose(link, e)),
        },
      }),
    );
    try {
      link.session = await Promise.race([connecting, failed, stalled]);
      if (link.closed) throw new Error("closed during setup");
    } catch (e) {
      link.closed = true;
      connecting.then((s) => s?.close(), () => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
    link.openedAt = Date.now();
    link.setupMs = link.openedAt - started;
    return link;
  }

  async connectFirst() {
    let link;
    try {
      link = await this.openLink(null);
    } catch (e) {
      this.note(`Could not open Gemini session: ${e.message || e}`, "error");
      this.hangup("Gemini session failed");
      return;
    }
    if (this.ended || this.exitSent) {
      this.closeLink(link);
      return;
    }
    this.useLink(link);
    if (this.cfg.botSpeaksFirst) this.sendClientText(this.render(this.cfg.greetingInstruction));
  }

  useLink(link) {
    this.link = link;
    if (link.handle) this.resumeHandle = link.handle;
    this.note(
      `Gemini session ${link.openedWith ? "resumed" : "opened"} in ${link.setupMs} ms (${this.cfg.model})`,
    );
    this.flushInput(link);
  }

  closeLink(link) {
    if (!link) return;
    link.closed = true;
    clearTimeout(link.deadlineTimer);
    try {
      link.session?.close();
    } catch {
      /* already closed */
    }
  }

  // Sends caller input to the current session, or holds it while a new one opens.
  sendInput(send) {
    if (this.inputQueue) {
      this.inputQueue.push(send);
      if (this.inputQueue.length > MAX_QUEUED_INPUT) this.inputQueue.shift();
      return;
    }
    if (this.link) this.sendTo(this.link, send);
  }

  sendTo(link, send) {
    if (link.closed) return;
    try {
      send(link);
    } catch (e) {
      this.note(`Could not send to Gemini: ${e.message || e}`, "warn");
    }
  }

  flushInput(link) {
    const queue = this.inputQueue;
    this.inputQueue = null;
    if (!queue?.length || !link) return;
    this.note(`Passing ${queue.length} held input message(s) to Gemini`);
    for (const send of queue) this.sendTo(link, send);
  }

  // Text from "the user" side. With turnComplete it interrupts whatever the
  // bot is generating, so cut the bot's queued audio the way a barge-in does.
  sendClientText(text) {
    this.sendInput((link) => {
      if (this.botTurnAudio) this.cutBotAudio("Cut the bot off for new input, sent clear");
      link.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
      link.midTurn = true;
      link.handleFresh = false;
    });
  }

  onGeminiError(link, e) {
    if (link.closed || this.ended) return;
    this.note(`Gemini error: ${e?.message || e?.error || e}`, "error");
  }

  onGeminiClose(link, e) {
    // We closed it ourselves, or already gave up on it.
    if (link.closed || this.ended) return;
    link.closed = true;
    clearTimeout(link.deadlineTimer);
    const detail = e?.reason ? `${e.code}: ${e.reason}` : `code ${e?.code}`;
    if (!link.session) {
      link.fail(new Error(`closed during setup (${detail})`));
      return;
    }
    this.note(`Gemini session closed (${detail})`, "warn");
    if (link.calls.size) this.note(`${link.calls.size} tool call(s) from that session can't be answered now`, "warn");
    if (link === this.nextLink) {
      this.nextLink = null;
      this.nextFailed(`New Gemini session closed (${detail})`);
      return;
    }
    if (link !== this.link) return;
    this.link = null;
    if (this.nextLink) {
      // A replacement is already opening (or ready); hold input for it.
      this.inputQueue ??= [];
      this.maybeSwitch();
      return;
    }
    this.reconnect(detail, e?.code, link);
  }

  reconnect(detail, code, link) {
    if (this.ended || this.exitSent) return;
    if (this.pendingExit) {
      this.note("Not reconnecting Gemini, the call is already ending");
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      this.note(`Gemini rejected the session (${detail}), not retrying`, "error");
      this.hangup("Gemini session failed");
      return;
    }
    if (!this.resumeHandle) {
      this.note(`Gemini session ended (${detail}) and cannot be resumed`, "error");
      this.hangup("Gemini session ended");
      return;
    }
    if (Date.now() - link.openedAt >= STABLE_SESSION_MS) this.reconnectFailures = 0;
    this.retryGemini(`Gemini closed with ${detail}`);
  }

  // Counts a failure and schedules the next attempt with backoff, or gives up.
  // The count resets once a session completes a turn or stays up a while.
  retryGemini(why) {
    const attempt = ++this.reconnectFailures;
    if (attempt > MAX_RECONNECTS) {
      if (this.link) {
        // The current session carries on; the call ends when it closes.
        this.note(`${why}; giving up on a new Gemini session after ${MAX_RECONNECTS} tries`, "error");
        return;
      }
      this.note(`${why}; Gemini failed ${MAX_RECONNECTS} times in a row, ending the call`, "error");
      this.hangup("Gemini kept disconnecting");
      return;
    }
    const delay = attempt === 1 ? 0 : RECONNECT_BACKOFF_MS * 2 ** (attempt - 2);
    this.note(`${why}; reconnecting in ${delay} ms (attempt ${attempt} of ${MAX_RECONNECTS})`, "warn");
    this.startNext(delay);
  }

  startNext(delay) {
    const old = this.link;
    // Hold input back from an idle old session, so the new one (resumed from
    // the old one's latest handle) hears everything the caller says.
    if (!old || this.isIdle(old)) this.inputQueue ??= [];
    this.nextLink = { pending: true };
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.guard("Reconnecting Gemini", () => this.openNext(false)), delay);
  }

  async openNext(reopened) {
    if (this.ended || this.exitSent) {
      this.nextLink = null;
      return;
    }
    let link;
    try {
      link = await this.openLink(this.resumeHandle);
    } catch (e) {
      this.nextLink = null;
      this.nextFailed(`Gemini reconnect failed: ${e.message || e}`);
      return;
    }
    if (this.ended || this.exitSent) {
      this.nextLink = null;
      this.closeLink(link);
      return;
    }
    link.reopened = reopened;
    this.nextLink = link;
    this.maybeSwitch();
  }

  nextFailed(why) {
    if (this.ended || this.exitSent) return;
    // If the old session is still up, it gets back the input held for the new one.
    if (this.link) this.flushInput(this.link);
    this.retryGemini(why);
  }

  isIdle(link) {
    return !link.midTurn && link.calls.size === 0;
  }

  // Swaps in the new session once the old one has finished its turn and
  // answered its tool calls (or has closed), then closes the old one.
  maybeSwitch() {
    const next = this.nextLink;
    if (!next?.session || this.ended) return;
    const old = this.link;
    if (old && !this.isIdle(old)) return;
    if (old && this.resumeHandle !== next.openedWith && !next.reopened) {
      // The old session moved on after we resumed from its handle. Start
      // again from the newer one (once), so nothing said in between is lost.
      this.note("Gemini moved on while the new session opened, opening it again from the latest point");
      this.closeLink(next);
      this.nextLink = { pending: true };
      this.inputQueue ??= [];
      this.guard("Reconnecting Gemini", () => this.openNext(true));
      return;
    }
    this.nextLink = null;
    this.useLink(next);
    if (old) {
      this.note("Handed the call over to the new Gemini session");
      this.closeLink(old);
    }
  }

  onGoAway(link, goAway) {
    if (link.goingAway) return;
    link.goingAway = true;
    const left = durationMs(goAway.timeLeft, 10000);
    this.note(`Gemini will close this session in ${Math.round(left)} ms, preparing a new one`, "warn");
    link.deadlineTimer = setTimeout(
      () =>
        this.guard("Gemini handover", () => {
          link.pastDeadline = true;
          this.maybeHandover();
        }),
      Math.max(0, left - HANDOVER_MARGIN_MS),
    );
  }

  // After goAway, opens the new session once the old one is idle and has
  // handed us a handle for that point (or time is nearly up).
  maybeHandover() {
    const link = this.link;
    if (!link?.goingAway || link.closed || this.nextLink || !this.resumeHandle) return;
    if (this.ended || this.exitSent || this.pendingExit) return;
    if (!this.isIdle(link) || (!link.handleFresh && !link.pastDeadline)) return;
    this.note("Opening a new Gemini session to take over");
    this.startNext(0);
  }

  onGemini(link, m) {
    if (this.ended || link.closed || !isObject(m)) return;
    const resume = m.sessionResumptionUpdate;
    if (resume) {
      if (resume.resumable && resume.newHandle) {
        link.handle = resume.newHandle;
        link.handleFresh = true;
        if (link === this.link) this.resumeHandle = resume.newHandle;
      } else {
        link.handleFresh = false;
      }
    }
    // Only the current session talks to the caller. One still being opened
    // has had no input yet, so it has nothing to say.
    if (link !== this.link) return;

    if (m.goAway) this.onGoAway(link, m.goAway);
    if (m.toolCallCancellation) this.onToolCallCancellation(link, m.toolCallCancellation.ids);
    if (m.toolCall) {
      link.midTurn = true;
      link.handleFresh = false;
      const functionCalls = Array.isArray(m.toolCall.functionCalls) ? m.toolCall.functionCalls : [];
      this.guard("Tool handling", () => this.onToolCall(link, functionCalls));
    }

    const sc = m.serverContent;
    if (sc) {
      link.handleFresh = false;
      if (sc.interrupted) {
        link.midTurn = false;
        this.onInterrupted();
      }
      if (sc.inputTranscription?.text) {
        this.callerActive();
        this.addTranscript("caller", sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        link.midTurn = true;
        this.addTranscript("bot", sc.outputTranscription.text);
      }
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) {
          link.midTurn = true;
          this.sendBotAudio(Buffer.from(part.inlineData.data, "base64"));
        }
      }
      if (sc.turnComplete) {
        link.midTurn = false;
        this.reconnectFailures = 0;
        this.onTurnComplete();
      }
    }
    this.maybeSwitch();
    this.maybeHandover();
  }

  // Tool results always go back to the session that asked, even if a newer
  // one is being opened meanwhile.
  async onToolCall(link, functionCalls) {
    const functionResponses = [];
    let setExit = false;
    for (const fc of functionCalls) link.calls.add(fc?.id);
    try {
      for (const fc of functionCalls) {
        if (!isObject(fc)) continue;
        const args = isObject(fc.args) ? fc.args : {};
        this.note(`Bot called ${fc.name}(${JSON.stringify(args)})`);
        let result;
        try {
          result = await runTool(this, fc.name, args);
        } catch (e) {
          this.note(`${fc.name} failed: ${e.message}`, "error");
          result = { response: { error: "internal_error" } };
        }
        if (link.cancelled.has(fc.id)) {
          this.note(`Dropped the result of ${fc.name}, Gemini cancelled the call`);
          continue;
        }
        if (result.exit) {
          this.pendingExit = { ...result.exit, toolCallId: fc.id };
          setExit = true;
        }
        functionResponses.push({ id: fc.id, name: fc.name, response: result.response });
      }
    } finally {
      for (const fc of functionCalls) link.calls.delete(fc?.id);
    }
    if (this.ended) return;
    if (functionResponses.length) {
      if (link.closed) {
        this.note("Gemini session closed before the tool results could be sent", "warn");
      } else {
        this.sendTo(link, (l) => l.session.sendToolResponse({ functionResponses }));
        link.midTurn = true;
        link.handleFresh = false;
      }
    }
    // If the goodbye turn never completes, don't leave the caller hanging.
    if (setExit && this.pendingExit) this.armExitTimer(this.playoutRemaining() + EXIT_TURN_TIMEOUT_MS);
    this.maybeSwitch();
    this.maybeHandover();
  }

  onToolCallCancellation(link, ids) {
    const list = Array.isArray(ids) ? ids : [];
    this.note(`Gemini cancelled tool call(s) ${list.join(", ") || "(none given)"}`);
    for (const id of list) link.cancelled.add(id);
    if (this.pendingExit && !this.exitSent && list.includes(this.pendingExit.toolCallId)) {
      this.note(`Not ending the call after all (${this.pendingExit.reason} was cancelled)`, "warn");
      this.pendingExit = null;
      clearTimeout(this.exitTimer);
      this.armSilenceTimer();
    }
  }

  recordOutcome(entry) {
    this.info.outcomes.push(entry);
    db.addOutcome(this.id, entry);
    this.event(`Outcome: ${entry.outcome}${entry.notes ? ` (${entry.notes})` : ""}`);
    calls.update(this);
  }

  // ── silence handling ─────────────────────────────────────────────────────

  // Started when the bot finishes a turn and restarted whenever the caller
  // does something; bot audio stops it.
  armSilenceTimer() {
    clearTimeout(this.silenceTimer);
    if (!this.cfg.silenceTimeoutSec || this.pendingExit || this.exitSent || this.ended) return;
    this.silenceTimer = setTimeout(
      () => this.guard("Silence check", () => this.onSilence()),
      this.playoutRemaining() + this.cfg.silenceTimeoutSec * 1000,
    );
  }

  // Restarting the countdown here means silence after the caller's last words
  // is noticed too, even if the bot never answers them (e.g. transcribed noise).
  callerActive() {
    this.silentChecks = 0;
    this.spokeSinceCaller = false;
    this.armSilenceTimer();
  }

  onSilence() {
    if (this.ended || this.pendingExit || this.exitSent) return;
    // Not silence yet: the bot is still talking, waiting on a tool, or Gemini
    // is reconnecting. Look again later.
    if (!this.link || this.playoutRemaining() > 0 || this.link.calls.size) {
      this.armSilenceTimer();
      return;
    }
    const secs = this.cfg.silenceTimeoutSec;
    this.silentChecks++;
    let instruction;
    if (this.silentChecks <= this.cfg.silenceReprompts) {
      this.note(`Caller silent for ${secs}s, checking they are there (${this.silentChecks}/${this.cfg.silenceReprompts})`);
      instruction = `[The caller has been silent for ${secs} seconds. Briefly check whether they are still on the line.]`;
    } else {
      this.note("No response from the caller, ending the call");
      this.pendingExit = { parameters: [], reason: "no response from caller" };
      if (!this.info.outcomes.length) {
        this.recordOutcome({ outcome: "no_response", notes: "", at: new Date().toISOString() });
      }
      instruction =
        "[There has been no response after several checks. Say a short, polite goodbye and mention they can call back any time. Do not call any tools.]";
      this.armExitTimer(EXIT_TURN_TIMEOUT_MS);
    }
    this.sendClientText(instruction);
  }

  // ── bot → telephony ──────────────────────────────────────────────────────

  sendBotAudio(pcm24k) {
    clearTimeout(this.silenceTimer);
    this.botTurnAudio = true;
    this.spokeSinceCaller = true;
    const pcm = this.resampler.process(pcm24k);
    for (const frame of this.chunker.push(pcm)) this.sendMedia(frame);
  }

  sendMedia(frame) {
    const frameMs = (frame.length / 2 / this.info.sampleRate) * 1000;
    this.playoutEndsAt = Math.max(Date.now(), this.playoutEndsAt) + frameMs;
    this.send({
      event: "media",
      sequence_number: ++this.seq,
      room_id: this.info.roomId,
      media: { chunk: ++this.chunk, timestamp: Date.now(), payload: frame.toString("base64") },
    });
  }

  playoutRemaining() {
    return Math.max(0, this.playoutEndsAt - Date.now());
  }

  onTurnComplete() {
    const tail = this.chunker.flush();
    if (tail) this.sendMedia(tail);
    this.resampler.reset();
    this.botTurnAudio = false;

    // The platform echoes a mark back once everything sent before it has played.
    const name = `turn-${++this.turn}`;
    this.send({ event: "mark", sequence_number: ++this.seq, room_id: this.info.roomId, mark: { name } });

    if (this.pendingExit?.toolCallId && !this.spokeSinceCaller && !this.pendingExit.goodbyeAsked) {
      // The model sometimes hangs up without a word after the caller's last
      // line. Ask once for a goodbye; the exit timer still bounds the wait.
      this.pendingExit.goodbyeAsked = true;
      this.note("Bot ended the call without a goodbye, asking for one");
      this.sendClientText("[Before the call ends, say a short goodbye to the caller. Do not call any tools.]");
      this.armExitTimer(EXIT_TURN_TIMEOUT_MS);
    } else if (this.pendingExit) {
      this.pendingExit.mark = name;
      this.armExitTimer(this.playoutRemaining() + EXIT_PLAYOUT_GRACE_MS);
    } else {
      this.armSilenceTimer();
    }
  }

  onInterrupted() {
    this.cutBotAudio("Caller barged in, sent clear");
    this.callerActive();
  }

  // Drops the bot's half-sent reply: the platform flushes what it has queued
  // and the partial frame we hold doesn't leak into the next turn.
  cutBotAudio(why) {
    this.chunker.reset();
    this.resampler.reset();
    this.playoutEndsAt = 0;
    this.botTurnAudio = false;
    this.send({ event: "clear", room_id: this.info.roomId });
    this.note(why);
  }

  armExitTimer(ms) {
    clearTimeout(this.exitTimer);
    this.exitDeadline = Date.now() + ms;
    this.exitTimer = setTimeout(() => this.guard("Sending exit", () => this.sendExit()), ms);
  }

  // Ends the call right away, e.g. from the UI's hang-up button.
  hangup(reason) {
    this.pendingExit = { parameters: [], reason };
    this.sendExit();
  }

  sendExit() {
    if (this.exitSent || this.ended) return;
    this.exitSent = true;
    clearTimeout(this.exitTimer);
    clearTimeout(this.silenceTimer);
    const { parameters, reason } = this.pendingExit || { parameters: [], reason: "exit" };
    this.send({ event: "exit", room_id: this.info.roomId, exit: { parameters } });
    this.note(`Sent exit (${reason})${parameters.length ? ` with ${JSON.stringify(parameters)}` : ""}`);
    this.info.endReason = reason;
    // The platform should answer with stop and close; don't wait forever.
    setTimeout(() => this.guard("Closing the call", () => this.finish(reason)), 5000).unref();
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────

  // Never throws: a failing database write must not end the call.
  note(text, level = "info") {
    log[level](`[${this.id}] ${text}`);
    const entry = { at: new Date().toISOString(), level, text };
    this.info.log.push(entry);
    try {
      db.addCallEvent(this.id, entry);
    } catch (e) {
      log.error(`[${this.id}] Could not save call event: ${e.message}`);
    }
    calls.emit("call.log", { id: this.id, entry });
  }

  // A line in the transcript for things like outcomes.
  event(text) {
    this.note(text);
    this.addTranscript("event", text);
  }

  addTranscript(role, text) {
    const last = this.info.transcript.at(-1);
    if (last && last.role === role && role !== "dtmf" && role !== "event") {
      last.text += text;
      db.updateTranscriptText(this.lastTranscriptRow, last.text);
    } else {
      const entry = { role, text, at: new Date().toISOString() };
      this.info.transcript.push(entry);
      this.lastTranscriptRow = db.addTranscript(this.id, entry);
    }
    calls.emit("call.transcript", { id: this.id, role, text });
  }

  finish(reason) {
    if (this.ended) return;
    clearTimeout(this.exitTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.reconnectTimer);
    // The caller hung up before the bot recorded anything.
    if (!this.info.outcomes.length && !this.exitSent && this.info.roomId) {
      this.guard("Recording the outcome", () =>
        this.recordOutcome({
          outcome: "caller_hung_up",
          notes: "Call ended before an outcome was recorded",
          at: new Date().toISOString(),
        }),
      );
    }
    this.ended = true;
    this.closeLink(this.link);
    if (this.nextLink?.session) this.closeLink(this.nextLink);
    this.link = null;
    this.nextLink = null;
    this.inputQueue = null;
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000);

    this.info.status = "ended";
    this.info.endedAt = new Date().toISOString();
    this.info.endReason ??= reason;
    this.note(`Call finished: ${this.info.endReason}`);
    calls.end(this);
  }
}
