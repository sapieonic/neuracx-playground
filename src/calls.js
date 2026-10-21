import { EventEmitter } from "node:events";
import * as db from "./db.js";

// Live calls are kept in memory and mirrored to SQLite; finished calls are read
// back from SQLite. Call events fan out to the UI over server-sent events.
export const events = new EventEmitter();
events.setMaxListeners(0);

const active = new Map();

export function emit(type, data) {
  events.emit("event", { type, ...data });
}

export function add(session) {
  active.set(session.id, session);
  db.insertCall(session.info);
  emit("call.started", { call: session.info });
}

export function update(session) {
  db.updateCall(session.info);
  emit("call.updated", { call: session.info });
}

export function end(session) {
  if (!active.delete(session.id)) return;
  db.updateCall(session.info);
  emit("call.ended", { call: session.info });
}

export function get(id) {
  return active.get(id);
}

// Full call (transcript, log, outcomes), live or finished.
export function details(id) {
  return active.get(id)?.info ?? db.getCall(id);
}

// Live calls in full; finished calls as summaries (fetch details on demand).
export function list() {
  return { active: [...active.values()].map((s) => s.info), recent: db.recentCalls(50) };
}
