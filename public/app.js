import { BrowserCall } from "./simulator.js";

const $ = (id) => document.getElementById(id);
const form = $("configForm");

const state = {
  calls: new Map(), // id -> call info; finished calls are summaries until opened
  selected: null,
  tab: "transcript",
  info: null,
  sim: null,
  profiles: [], // [{ id, name }]
  loaded: null, // config as last loaded from the server
  drafts: {}, // use case id -> its fields as edited in the form
  editing: null, // use case shown in the form
  loading: new Set(), // call ids whose details are being fetched
  callFilter: "all", // all | live | ended
  callSearch: "",
  panel: "conv", // Bot setup tab: conv | kb | voice
  rooms: [],
  roomsSaved: "[]", // JSON of the rooms as last saved, to spot unsaved edits
};

// Every API call sends X-Requested-With; the server refuses changes without it (CSRF guard).
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", "X-Requested-With": "fetch", ...options.headers };
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
  return body;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

// ── stream URL / key status ────────────────────────────────────────────────

function streamUrl(extra = {}) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(extra);
  if (state.info?.streamToken) params.set("token", state.info.streamToken);
  const qs = params.toString();
  return `${proto}//${location.host}/stream${qs ? `?${qs}` : ""}`;
}

function renderHeader(config) {
  $("streamUrl").textContent = streamUrl();
  $("livePill").textContent = `Live: ${profileName(config.activeProfile)}`;
  $("livePill").title = "Use case for new calls";
  $("simLiveName").textContent = profileName(config.activeProfile);
  const missing = config.apiKeySource === "none";
  const key = $("keyStatus");
  key.textContent = { ui: "Gemini key saved here", env: "Gemini key from .env", none: "Gemini key missing" }[config.apiKeySource];
  key.className = `key-status${missing ? " bad" : ""}`;
  $("keySource").textContent = {
    ui: "Using the key saved here.",
    env: "Using GEMINI_API_KEY from .env.",
    none: "No key set. Paste one below or add GEMINI_API_KEY to .env.",
  }[config.apiKeySource];
  $("keySource").className = `key-box${missing ? " bad" : ""}`;
}

// The clipboard API only works on https or localhost; elsewhere show the URL to copy by hand.
$("copyUrl").addEventListener("click", async () => {
  const label = $("copyUrl").querySelector("span");
  try {
    await navigator.clipboard.writeText(streamUrl());
    label.textContent = "Copied";
    setTimeout(() => (label.textContent = "Copy"), 1200);
  } catch {
    prompt("Copy the stream URL:", streamUrl());
  }
});

// ── pages ──────────────────────────────────────────────────────────────────

// One page at a time, picked by the URL hash so reloads and the back button work.
const VIEWS = ["setup", "calls", "settings", "hotel"];

function showView() {
  const hash = location.hash.slice(1);
  const view = VIEWS.includes(hash) ? hash : "setup";
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  form.hidden = view !== "setup" && view !== "settings"; // the save bar belongs to these two
  for (const a of document.querySelectorAll(".nav")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", showView);
showView();

// Bot setup tabs: Conversation, Knowledge base, Voice & handoff.
function showPanel(name) {
  state.panel = name;
  for (const tab of document.querySelectorAll(".ptab")) {
    const on = tab.dataset.panel === name;
    tab.setAttribute("aria-selected", String(on));
    $(`panel-${tab.dataset.panel}`).hidden = !on;
  }
}

for (const tab of document.querySelectorAll(".ptab")) tab.addEventListener("click", () => showPanel(tab.dataset.panel));
showPanel(state.panel);

// ── config form ────────────────────────────────────────────────────────────

// Settings shared by both use cases, by form field name (= dotted config path).
const SHARED_FIELDS = [
  "model", "temperature", "timezone",
  "vad.startSensitivity", "vad.endSensitivity", "vad.silenceDurationMs", "vad.prefixPaddingMs",
  "silenceTimeoutSec", "silenceReprompts", "botSpeaksFirst", "enableEndCall", "forwardDtmf", "chunkSize",
];
// Settings each use case has its own copy of; their inputs are named "p.<field>".
const PROFILE_FIELDS = ["voice", "transferNumber", "systemPrompt", "greetingInstruction", "knowledgeBase", "supportContact"];
// Placeholders the system prompt can use, offered as buttons that insert them.
const PLACEHOLDERS = [
  ["support_contact", "Support contact for this use case"],
  ["now", "Current time in the configured timezone"],
  ["cli", "Caller number"],
  ["dni", "Dialled number"],
  ["call_id", "NeuraCX call ID"],
  ["room_id", "NeuraCX room ID"],
  ["custom.KEY", "A value from custom_parameters"],
];
const PROFILE_HINTS = {
  golden_visa: {
    kb: "Default: the published Golden Visa FAQ (knowledge/golden-visa-faq.txt). Reset this use case to reload it.",
  },
  taj_dubai: {
    kb: "Default: demo hotel info (knowledge/taj-dubai-demo.txt). Reset this use case to reload it.",
    note:
      "Demo data: the hotel info in the knowledge base and the rooms and rates under Rooms & rates are placeholders, " +
      "to be replaced with the real ones. Bookings the bot makes are listed under Taj Dubai reservations.",
  },
};

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function setPath(obj, path, value) {
  const [head, tail] = path.split(".");
  if (tail) (obj[head] ??= {})[tail] = value;
  else obj[head] = value;
}

function readInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.type === "number") return input.value === "" ? null : Number(input.value);
  return input.value;
}

function writeInput(input, value) {
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = value ?? "";
}

// Textareas turn \r\n into \n, so compare text with line endings normalised.
function same(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
  return a === b;
}

const profileName = (id) => state.profiles.find((p) => p.id === id)?.name ?? id;

// Shared fields this server actually has (older/newer servers may differ).
const sharedFields = () => SHARED_FIELDS.filter((f) => getPath(state.loaded, f) !== undefined);

// state.loaded is the config as last loaded from the server; state.drafts holds
// the per-use-case form values, so switching the "Editing" tab keeps edits.
function fillForm(config) {
  state.loaded = config;
  state.drafts = Object.fromEntries(
    Object.entries(config.profiles).map(([id, p]) => [id, Object.fromEntries(PROFILE_FIELDS.map((f) => [f, p[f]]))]),
  );
  for (const name of SHARED_FIELDS) {
    const input = form.elements[name];
    const value = getPath(config, name);
    input.closest("label").hidden = value === undefined;
    writeInput(input, value);
  }
  form.elements.geminiApiKey.value = "";
  form.elements.clearGeminiApiKey.checked = false;
  if (!config.profiles[state.editing]) state.editing = config.activeProfile;
  renderProfiles();
  renderHeader(config);
}

function fillProfileFields() {
  const draft = state.drafts[state.editing];
  for (const f of PROFILE_FIELDS) writeInput(form.elements[`p.${f}`], draft[f]);
  const hints = PROFILE_HINTS[state.editing] ?? {};
  $("kbHint").textContent = hints.kb ?? "Reset this use case to reload the default knowledge base.";
  $("profileNote").textContent = hints.note ?? "";
  $("profileNote").hidden = !hints.note;
  renderProfileSummary();
}

// The line under the use case name and the prompt length; both follow the form as you type.
function renderProfileSummary() {
  const draft = state.drafts[state.editing];
  const transfer = draft.transferNumber ? `to ${draft.transferNumber}` : "off";
  $("ucMeta").textContent = `Voice ${draft.voice} · Transfers ${transfer}`;
  $("promptCount").textContent = `${(draft.systemPrompt ?? "").length.toLocaleString()} characters`;
}

// The use case list, the page heading, the live state and the "changed" markers.
function renderProfiles() {
  const live = state.loaded.activeProfile;
  for (const button of $("editProfiles").querySelectorAll(".usecase")) {
    button.setAttribute("aria-pressed", String(button.dataset.profile === state.editing));
  }
  for (const badge of $("editProfiles").querySelectorAll("[data-live-badge]")) badge.hidden = badge.dataset.liveBadge !== live;
  const name = profileName(state.editing);
  $("ucTitle").textContent = name;
  $("liveBadge").hidden = state.editing !== live;
  $("notLive").hidden = state.editing === live;
  $("makeLive").hidden = state.editing === live;
  $("resetProfile").setAttribute("aria-label", `Reset ${name} to defaults`);
  fillProfileFields();
  renderMarks();
}

function buildSwitches() {
  $("editProfiles").replaceChildren(
    ...state.profiles.map((p) =>
      el(
        "button",
        {
          type: "button",
          class: "usecase",
          "data-profile": p.id,
          "aria-pressed": "false",
          onclick: () => {
            state.editing = p.id;
            $("liveStatus").textContent = "";
            renderProfiles();
            location.hash = "setup";
          },
        },
        el("span", { class: "grow" }, p.name),
        el("span", { class: "live-tag", "data-live-badge": p.id, hidden: "" }, "LIVE"),
      ),
    ),
  );
  $("placeholderChips").append(
    ...PLACEHOLDERS.map(([key, title]) => {
      const code = `{{${key}}}`;
      return el("button", { type: "button", class: "chip", title, onclick: () => insertPlaceholder(code) }, code);
    }),
  );
}

// Inserts at the cursor and fires "input" so the draft and save bar update as if typed.
function insertPlaceholder(code) {
  const prompt = form.elements["p.systemPrompt"];
  prompt.setRangeText(code, prompt.selectionStart, prompt.selectionEnd, "end");
  prompt.focus();
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

// A small "changed" marker next to each label whose setting differs from the default.
function renderMarks() {
  const customised = new Set(state.loaded.customised ?? []);
  const mark = (input, on) => {
    const label = input.closest("label");
    const host = label.querySelector(".lt") ?? label;
    let m = host.querySelector(":scope > .changed-mark");
    if (!m) host.append((m = el("span", { class: "changed-mark", title: "Differs from the default" }, "changed")));
    m.hidden = !on;
  };
  for (const f of sharedFields()) mark(form.elements[f], customised.has(f));
  for (const f of PROFILE_FIELDS) mark(form.elements[`p.${f}`], customised.has(`profiles.${state.editing}.${f}`));
  const n = [...customised].filter((c) => c !== "activeProfile").length;
  $("customised").textContent = n ? `${n} setting${n === 1 ? "" : "s"} differ from the defaults (marked “changed”).` : "";
}

// Only what the user changed since the form was loaded, so stale values in a
// page left open across a redeploy don't become customisations.
function buildPatch() {
  const patch = {};
  for (const f of sharedFields()) {
    const value = readInput(form.elements[f]);
    if (!same(value, getPath(state.loaded, f))) setPath(patch, f, value);
  }
  for (const [id, draft] of Object.entries(state.drafts)) {
    for (const f of PROFILE_FIELDS) {
      if (!same(draft[f], state.loaded.profiles[id][f])) ((patch.profiles ??= {})[id] ??= {})[f] = draft[f];
    }
  }
  if (form.elements.geminiApiKey.value) patch.geminiApiKey = form.elements.geminiApiKey.value;
  if (form.elements.clearGeminiApiKey.checked) patch.clearGeminiApiKey = true;
  return patch;
}

function showErrors(errors) {
  $("formErrors").replaceChildren(...errors.map((m) => el("li", {}, m)));
}

// The save bar: a dot (green saved, amber unsaved, red error) and one line of status.
function setSaveState(text, kind = "") {
  const dirty = Object.keys(buildPatch()).length > 0;
  $("saveStatus").textContent = text ?? (dirty ? "Unsaved changes" : "All changes saved. They apply from the next call.");
  $("saveBar").className = `savebar${kind === "error" ? " error" : dirty ? " dirty" : ""}`;
  $("discardChanges").hidden = !dirty;
}

form.addEventListener("input", (e) => {
  const name = e.target.name;
  if (!name) return; // the test call fields
  if (name.startsWith("p.")) {
    state.drafts[state.editing][name.slice(2)] = readInput(e.target);
    renderProfileSummary();
  }
  setSaveState();
});

// Enter in a field would submit the whole form; only the Save button saves.
form.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") e.preventDefault();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showErrors([]);
  const patch = buildPatch();
  if (!Object.keys(patch).length) {
    setSaveState("Nothing to save.");
    return;
  }
  setSaveState("Saving…");
  try {
    const { config } = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
    fillForm(config);
    setSaveState(`Saved at ${new Date().toLocaleTimeString()}. Applies from the next call.`);
  } catch (err) {
    setSaveState("Could not save. Fix the problems below and try again.", "error");
    showErrors(err.body?.errors || [err.message]);
  }
});

$("discardChanges").addEventListener("click", () => {
  showErrors([]);
  fillForm(state.loaded);
  setSaveState();
});

// The live use case is saved straight away, on its own; unsaved edits in the
// form stay as they are.
async function setLiveProfile(id) {
  $("makeLive").disabled = true;
  $("liveStatus").textContent = "Switching…";
  $("liveStatus").className = "muted small status-line";
  try {
    const { config } = await api("/api/config", { method: "PUT", body: JSON.stringify({ activeProfile: id }) });
    state.loaded.activeProfile = config.activeProfile;
    state.loaded.customised = config.customised;
    state.editing = config.activeProfile;
    renderProfiles();
    renderHeader(state.loaded);
    $("liveStatus").textContent = `${profileName(config.activeProfile)} is now live. It applies from the next call.`;
    $("liveStatus").className = "ok-text small status-line";
  } catch (err) {
    $("liveStatus").textContent = `Could not switch: ${err.body?.errors?.join(" ") || err.message}`;
    $("liveStatus").className = "error-text small status-line";
  } finally {
    $("makeLive").disabled = false;
  }
}

$("makeLive").addEventListener("click", () => setLiveProfile(state.editing));

async function reset(body, question, done) {
  if (!confirm(question)) return;
  showErrors([]);
  try {
    const { config } = await api("/api/config/reset", { method: "POST", body: body && JSON.stringify(body) });
    fillForm(config);
    setSaveState(done);
  } catch (err) {
    setSaveState("Reset failed.", "error");
    showErrors([`Reset failed: ${err.message}`]);
  }
}

$("resetProfile").addEventListener("click", () => {
  const name = profileName(state.editing);
  reset(
    { profile: state.editing },
    `Reset the ${name} settings (voice, transfer number, prompt, opening, knowledge base, support contact) to the defaults? Unsaved changes in the form are lost.`,
    `${name} reset to defaults`,
  );
});

$("resetConfig").addEventListener("click", () =>
  reset(
    undefined,
    "Reset all settings, for both use cases and the shared ones, to the defaults? The live use case goes back to the default too. The Gemini API key is kept.",
    "Everything reset to defaults",
  ),
);

// ── calls ──────────────────────────────────────────────────────────────────

function fmtDuration(call) {
  const end = call.endedAt ? new Date(call.endedAt) : new Date();
  const s = Math.max(0, Math.round((end - new Date(call.startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function lastOutcome(call) {
  return call.outcomes?.at(-1)?.outcome ?? call.lastOutcome ?? null;
}

const who = (call) => `${call.cli || "unknown"} → ${call.dni || "unknown"}`;
const sortedCalls = () => [...state.calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

function matchesFilter(call) {
  if (state.callFilter === "live" && call.status === "ended") return false;
  if (state.callFilter === "ended" && call.status !== "ended") return false;
  const q = state.callSearch.trim().toLowerCase();
  return !q || [call.cli, call.dni, call.callId, call.roomId].some((v) => String(v ?? "").toLowerCase().includes(q));
}

// Rebuilt only when a call starts, changes or ends; durations tick in place (tickDurations).
function renderCallList() {
  const calls = sortedCalls();
  const live = calls.filter((c) => c.status !== "ended").length;
  $("callCount").textContent = calls.length ? `${live} live · ${calls.length - live} finished` : "";
  $("navCallCount").textContent = live ? `${live} live` : calls.length || "";
  $("navCallCount").className = `nav-count${live ? " live" : ""}`;
  const shown = calls.filter(matchesFilter);
  $("noCalls").hidden = calls.length > 0;
  $("noMatches").hidden = !calls.length || shown.length > 0;
  const focusedId = document.activeElement?.closest?.("#callList .call-item")?.dataset.id;
  $("callList").replaceChildren(
    ...shown.map((c) =>
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            class: c.id === state.selected ? "call-item selected" : "call-item",
            "data-id": c.id,
            "aria-current": c.id === state.selected ? "true" : "false",
            onclick: () => select(c.id),
          },
          el(
            "span",
            { class: "line" },
            el("span", { class: `dot ${c.status}` }),
            el("span", { class: "who" }, who(c)),
            el("span", { class: "muted small", "data-duration": c.id }, fmtDuration(c)),
          ),
          el(
            "span",
            { class: "sub" },
            ...[c.profileName, c.source, lastOutcome(c)].filter(Boolean).map((t) => el("span", {}, t)),
          ),
        ),
      ),
    ),
  );
  if (focusedId) $("callList").querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
}

for (const button of $("callFilter").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    state.callFilter = button.dataset.filter;
    for (const b of $("callFilter").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === button));
    renderCallList();
  });
}

$("callSearch").addEventListener("input", (e) => {
  state.callSearch = e.target.value;
  renderCallList();
});

function tickDurations() {
  for (const span of document.querySelectorAll("[data-duration]")) {
    const call = state.calls.get(span.dataset.duration);
    if (call && !call.endedAt) span.textContent = fmtDuration(call);
  }
}

const ROLE_NAMES = { bot: "Bot", caller: "Caller", dtmf: "Keypad", event: "" };

function bubbles(transcript) {
  if (!transcript.length) return [el("p", { class: "muted small" }, "Nothing said yet.")];
  return transcript.map((t) =>
    el("div", { class: `bubble ${t.role}` }, el("span", { class: "role" }, ROLE_NAMES[t.role]), t.text.trim()),
  );
}

// Re-renders a scrolling transcript, staying pinned to the bottom if it was there.
function fillTranscript(box, transcript) {
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...bubbles(transcript));
  if (stick) box.scrollTop = box.scrollHeight;
}

function showDetailMessage(title, text) {
  $("detailTitle").textContent = title;
  $("detailStatus").replaceChildren();
  $("detailMeta").replaceChildren();
  $("hangupBtn").hidden = true;
  $("transcript").replaceChildren(el("p", { class: "muted" }, text));
  $("eventLog").replaceChildren();
}

function renderDetail() {
  const call = state.calls.get(state.selected);
  $("callDetail").hidden = !call;
  $("detailEmpty").hidden = Boolean(call);
  if (!call) return;
  if (!call.transcript) {
    // A finished call from the list is only a summary; fetch the rest first.
    if (call.loadError) return showDetailMessage(who(call), `Could not load this call: ${call.loadError}`);
    showDetailMessage(who(call), "Loading…");
    loadCallDetails(call.id);
    return;
  }
  $("detailTitle").textContent = who(call);
  const ended = call.status === "ended";
  $("detailStatus").replaceChildren(
    el("span", { class: `dot ${call.status}` }),
    ended ? `Ended · ${call.endReason}` : call.status === "active" ? "Live" : call.status,
  );
  const meta = [
    ["Use case", call.profileName],
    ["Duration", el("span", { "data-duration": call.id }, fmtDuration(call))],
    ["Outcome", lastOutcome(call)],
    ["Channel", call.source],
    ["Model · voice", [call.model, call.voice].filter(Boolean).join(" · ")],
    ["Call ID", call.callId && el("span", { class: "mono" }, call.callId)],
    ["Room", call.roomId && el("span", { class: "mono" }, call.roomId)],
  ];
  $("detailMeta").replaceChildren(
    ...meta.filter(([, v]) => v).map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))),
  );
  $("hangupBtn").hidden = ended;

  fillTranscript($("transcript"), call.transcript);

  const logEl = $("eventLog");
  logEl.replaceChildren(
    ...call.log.map((e) =>
      el("li", { class: e.level }, el("time", {}, new Date(e.at).toLocaleTimeString()), e.text),
    ),
  );
  logEl.scrollTop = logEl.scrollHeight;
  $("transcript").hidden = state.tab !== "transcript";
  logEl.hidden = state.tab !== "log";
}

// The transcript beside the editor follows the newest call, live or finished.
function renderRail() {
  const call = sortedCalls()[0];
  const box = $("railTranscript");
  $("railOpen").hidden = !call;
  if (!call) {
    $("railMeta").textContent = "No calls yet. Start a test call to see the conversation here.";
    box.replaceChildren();
    return;
  }
  const label = call.status === "ended" ? "Last call" : "Current call";
  $("railMeta").textContent = [label, who(call), call.profileName].filter(Boolean).join(" · ");
  if (!call.transcript) {
    if (call.loadError) return box.replaceChildren(el("p", { class: "muted small" }, `Could not load this call: ${call.loadError}`));
    box.replaceChildren(el("p", { class: "muted small" }, "Loading…"));
    loadCallDetails(call.id);
    return;
  }
  fillTranscript(box, call.transcript);
}

$("railOpen").addEventListener("click", () => {
  const call = sortedCalls()[0];
  if (call) select(call.id);
});

async function loadCallDetails(id) {
  if (state.loading.has(id)) return;
  state.loading.add(id);
  try {
    const { call } = await api(`/api/calls/${encodeURIComponent(id)}`);
    state.calls.set(id, call);
  } catch (err) {
    const call = state.calls.get(id);
    if (call) call.loadError = err.message;
  } finally {
    state.loading.delete(id);
  }
  if (state.selected === id) renderDetail();
  if (sortedCalls()[0]?.id === id) renderRail();
}

function select(id) {
  state.selected = id;
  const call = state.calls.get(id);
  if (call?.loadError) delete call.loadError; // try again
  for (const item of $("callList").querySelectorAll(".call-item")) {
    item.classList.toggle("selected", item.dataset.id === id);
    item.setAttribute("aria-current", item.dataset.id === id ? "true" : "false");
  }
  renderDetail();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    });
    renderDetail();
  });
}

$("hangupBtn").addEventListener("click", () => {
  if (!state.selected) return;
  api(`/api/calls/${encodeURIComponent(state.selected)}/hangup`, { method: "POST" }).catch((err) =>
    alert(`Hang up failed: ${err.message}`),
  );
});

function onEvent(evt) {
  if (evt.type === "reservation.changed") return reservationsChanged();
  if (evt.call) {
    state.calls.set(evt.call.id, evt.call);
    if (evt.type === "call.started") state.selected = evt.call.id;
    renderCallList();
  } else {
    const call = state.calls.get(evt.id);
    if (!call) return;
    if (evt.type === "call.log") call.log.push(evt.entry);
    if (evt.type === "call.transcript") {
      const last = call.transcript.at(-1);
      if (last && last.role === evt.role && !["dtmf", "event"].includes(evt.role)) last.text += evt.text;
      else call.transcript.push({ role: evt.role, text: evt.text });
    }
  }
  if (!evt.id || evt.id === state.selected || evt.call?.id === state.selected) renderDetail();
  const railId = sortedCalls()[0]?.id;
  if (evt.call || evt.id === railId) renderRail();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
  // Resync after a reconnect so nothing is missed while we were away.
  source.onopen = () => {
    loadCalls().catch((err) => ($("callCount").textContent = `Could not load calls: ${err.message}`));
    loadReservations();
  };
}

async function loadCalls() {
  const { active, recent } = await api("/api/calls");
  state.calls = new Map([...recent, ...active].map((c) => [c.id, c]));
  renderCallList();
  renderDetail();
  renderRail();
}

setInterval(tickDurations, 1000);

// ── browser test call ──────────────────────────────────────────────────────

let simClock = null;

// Idle: number fields and Start. Running: mic meter, timer, keypad and End call.
function setSimStatus(text, kind = "") {
  $("simStatus").textContent = text;
  $("simStatus").className = `sim-status${kind === "live" ? " live" : kind === "bad" ? " bad" : ""}`;
  const running = kind === "live" || text === "Starting…";
  const hadFocus = $("simStart").contains(document.activeElement) || $("simLive").contains(document.activeElement);
  $("simStart").hidden = running;
  $("simFields").hidden = running;
  $("simLive").hidden = !running;
  $("simStop").disabled = !running;
  $("keypad").querySelectorAll("button").forEach((b) => (b.disabled = kind !== "live"));
  if (kind === "live" && !simClock) {
    const started = Date.now();
    simClock = setInterval(() => ($("simTimer").textContent = fmtDuration({ startedAt: started })), 1000);
  }
  if (!running) {
    clearInterval(simClock);
    simClock = null;
    $("simTimer").textContent = "0:00";
    $("keypad").hidden = true;
    $("keypadToggle").setAttribute("aria-expanded", "false");
  }
  // Keep keyboard focus on the control that replaced the one just hidden.
  if (hadFocus) (running ? $("simStop") : $("simStart")).focus();
}

$("simStart").addEventListener("click", async () => {
  state.sim = new BrowserCall({
    url: streamUrl({ source: "browser" }),
    cli: $("simCli").value,
    dni: $("simDni").value,
    customParameters: {},
    onStatus: setSimStatus,
    onLevel: (v) => ($("simLevel").style.width = `${Math.min(100, v * 160)}%`),
  });
  try {
    await state.sim.start();
  } catch (err) {
    state.sim.cleanup(`Could not start: ${err.message}`);
    setSimStatus(`Could not start: ${err.message}`, "bad");
  }
});

$("simStop").addEventListener("click", () => state.sim?.end());

$("keypad").append(
  ..."123456789*0#".split("").map((d) =>
    el("button", { type: "button", disabled: "", "aria-label": `Press ${d}`, onclick: () => state.sim?.sendDtmf(d) }, d),
  ),
);

$("keypadToggle").addEventListener("click", () => {
  const open = $("keypad").hidden;
  $("keypad").hidden = !open;
  $("keypadToggle").setAttribute("aria-expanded", String(open));
});

// ── hotel: reservations and rooms (Taj Dubai demo) ─────────────────────────

// Dates are plain YYYY-MM-DD hotel dates; show them without timezone shifts.
// The year is shown only when it isn't this year.
function fmtDate(d) {
  const date = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return d ?? "";
  const year = date.getUTCFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return date.toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year });
}

const fmtStamp = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const fmtAed = (n) => (typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n ?? "");

// Today in the bot's timezone, as YYYY-MM-DD.
function hotelToday() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: state.loaded?.timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

let reservationsSeq = 0;

async function loadReservations() {
  const seq = ++reservationsSeq;
  const upcoming = $("resFilter").value === "upcoming";
  try {
    const { reservations } = await api(`/api/hotel/reservations?status=${upcoming ? "booked" : "all"}`);
    if (seq !== reservationsSeq) return; // a newer load is on its way
    const today = hotelToday();
    const list = upcoming
      ? reservations.filter((r) => r.check_out >= today).sort((a, b) => a.check_in.localeCompare(b.check_in))
      : reservations;
    $("resErrors").replaceChildren();
    renderReservations(list, upcoming);
  } catch (err) {
    if (seq !== reservationsSeq) return;
    $("resErrors").replaceChildren(el("li", {}, `Could not load reservations: ${err.message}`));
  }
}

let reservationsTimer = null;
function reservationsChanged() {
  clearTimeout(reservationsTimer);
  reservationsTimer = setTimeout(loadReservations, 250);
}

function renderReservations(list, upcoming) {
  $("resCount").textContent = `${list.length} ${upcoming ? "upcoming" : "in total"}`;
  $("resWrap").hidden = !list.length;
  $("resEmpty").hidden = list.length > 0;
  $("resEmpty").textContent = upcoming
    ? "No upcoming bookings. Make Taj Dubai reservations the live use case and book one on a test call."
    : "No reservations yet.";
  $("resBody").replaceChildren(
    ...list.map((r) =>
      el(
        "tr",
        { class: r.status },
        el(
          "td",
          {},
          el("code", {}, r.confirmation_number),
          el("div", { class: "muted small" }, `made ${fmtStamp(r.created_at)}`),
        ),
        el(
          "td",
          {},
          el("div", {}, r.guest_name),
          r.phone && el("div", { class: "muted small" }, r.phone),
          r.special_requests && el("div", { class: "muted small" }, `Requests: ${r.special_requests}`),
        ),
        el(
          "td",
          {},
          el("div", { class: "nowrap" }, `${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}`),
          el("div", { class: "muted small" }, `${r.nights} night${r.nights === 1 ? "" : "s"}`),
        ),
        el(
          "td",
          {},
          el("div", {}, r.room_name || r.room_code),
          el("div", { class: "muted small" }, `${r.guests} guest${r.guests === 1 ? "" : "s"}`),
        ),
        el("td", { class: "num" }, fmtAed(r.total_aed)),
        el(
          "td",
          {},
          el("span", { class: `tag ${r.status}` }, r.status),
          r.cancelled_at && el("div", { class: "muted small nowrap" }, fmtStamp(r.cancelled_at)),
          r.status === "booked" &&
            el(
              "div",
              {},
              el(
                "button",
                {
                  type: "button",
                  class: "btn danger small",
                  "aria-label": `Cancel reservation ${r.confirmation_number}`,
                  onclick: (e) => cancelReservation(r, e.currentTarget),
                },
                "Cancel",
              ),
            ),
        ),
      ),
    ),
  );
}

async function cancelReservation(r, button) {
  const what = `${r.confirmation_number} for ${r.guest_name}, ${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}`;
  if (!confirm(`Cancel reservation ${what}?`)) return;
  button.disabled = true;
  try {
    await api(`/api/hotel/reservations/${encodeURIComponent(r.confirmation_number)}/cancel`, { method: "POST" });
  } catch (err) {
    $("resErrors").replaceChildren(el("li", {}, `Could not cancel ${r.confirmation_number}: ${err.message}`));
    button.disabled = false;
  }
  loadReservations();
}

$("resFilter").addEventListener("change", loadReservations);
$("resRefresh").addEventListener("click", loadReservations);

// Rooms are edited in place in state.rooms and saved as a whole list.
const ROOM_COLUMNS = [
  { key: "code", label: "Code", attrs: { class: "code-input", maxlength: "12", autocapitalize: "characters" } },
  { key: "name", label: "Name", attrs: {} },
  { key: "max_guests", label: "Max guests", attrs: { type: "number", min: "1", step: "1" } },
  { key: "nightly_rate_aed", label: "Nightly rate AED", attrs: { type: "number", min: "0", step: "1" } },
  { key: "inventory", label: "Inventory", attrs: { type: "number", min: "0", step: "1" } },
];

function setRooms(rooms) {
  state.rooms = rooms.map(({ code, name, description, max_guests, nightly_rate_aed, inventory }) => ({
    code, name, max_guests, nightly_rate_aed, inventory, description,
  }));
  state.roomsSaved = JSON.stringify(state.rooms);
  renderRooms();
}

function roomsEdited() {
  $("roomsStatus").textContent = JSON.stringify(state.rooms) === state.roomsSaved ? "" : "Unsaved changes";
}

function renderRooms() {
  $("roomsBody").replaceChildren(
    ...state.rooms.map((room, i) => {
      const row = `row ${i + 1}`;
      const cells = ROOM_COLUMNS.map(({ key, label, attrs }) =>
        el(
          "td",
          { class: attrs.type === "number" ? "num" : "" },
          el("input", {
            ...attrs,
            "aria-label": `${label}, ${row}`,
            value: room[key] ?? "",
            oninput: (e) => {
              let v = e.target.value;
              if (key === "code" && v !== v.toUpperCase()) e.target.value = v = v.toUpperCase();
              room[key] = attrs.type === "number" ? (v === "" ? null : Number(v)) : v;
              roomsEdited();
            },
          }),
        ),
      );
      return el(
        "tr",
        {},
        ...cells,
        el(
          "td",
          {},
          el("textarea", {
            rows: "2",
            "aria-label": `Description, ${row}`,
            oninput: (e) => {
              room.description = e.target.value;
              roomsEdited();
            },
          }, room.description ?? ""),
        ),
        el(
          "td",
          {},
          el(
            "button",
            {
              type: "button",
              class: "btn quiet small",
              "aria-label": `Remove room ${room.code || i + 1}`,
              onclick: () => {
                state.rooms.splice(i, 1);
                renderRooms();
                roomsEdited();
                $("addRoom").focus();
              },
            },
            "Remove",
          ),
        ),
      );
    }),
  );
}

async function loadRooms() {
  try {
    setRooms((await api("/api/hotel/rooms")).rooms);
  } catch (err) {
    $("roomsErrors").replaceChildren(el("li", {}, `Could not load rooms: ${err.message}`));
  }
}

$("addRoom").addEventListener("click", () => {
  state.rooms.push({ code: "", name: "", max_guests: 2, nightly_rate_aed: null, inventory: 1, description: "" });
  renderRooms();
  roomsEdited();
  $("roomsBody").lastElementChild.querySelector("input").focus();
});

$("saveRooms").addEventListener("click", async () => {
  $("roomsErrors").replaceChildren();
  $("roomsStatus").textContent = "Saving…";
  try {
    const { rooms } = await api("/api/hotel/rooms", { method: "PUT", body: JSON.stringify({ rooms: state.rooms }) });
    setRooms(rooms);
    $("roomsStatus").textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    roomsEdited();
    $("roomsErrors").replaceChildren(...(err.body?.errors || [err.message]).map((m) => el("li", {}, m)));
  }
});

$("resetRooms").addEventListener("click", async () => {
  if (!confirm("Replace the room list with the original demo rooms and rates? Your edits to the rooms are lost.")) return;
  $("roomsErrors").replaceChildren();
  try {
    setRooms((await api("/api/hotel/rooms/reset", { method: "POST" })).rooms);
    $("roomsStatus").textContent = "Demo rooms restored";
  } catch (err) {
    $("roomsErrors").replaceChildren(el("li", {}, `Reset failed: ${err.message}`));
  }
});

// ── boot ───────────────────────────────────────────────────────────────────

const [{ config, voices, profiles }, info] = await Promise.all([api("/api/config"), api("/api/info")]);
state.info = info;
state.profiles = profiles ?? Object.entries(config.profiles).map(([id, p]) => ({ id, name: p.name }));
form.elements["p.voice"].append(...voices.map((v) => el("option", { value: v }, v)));
buildSwitches();
fillForm(config);
setSaveState();
loadRooms();
connectEvents(); // loads calls and reservations once connected
