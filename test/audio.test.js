import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameChunker, PcmResampler } from "../src/audio.js";

function tone(freq, rate, ms) {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16000), i * 2);
  return buf;
}

function rms(buf, skip = 0) {
  let sum = 0;
  const n = buf.length / 2;
  for (let i = skip; i < n; i++) sum += buf.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / (n - skip));
}

test("24k -> 8k keeps duration across arbitrary chunk splits", () => {
  const input = tone(440, 24000, 1000);
  const r = new PcmResampler(24000, 8000);
  const out = [];
  for (let off = 0; off < input.length; off += 2 * 1234) out.push(r.process(input.subarray(off, off + 2 * 1234)));
  const samples = Buffer.concat(out).length / 2;
  assert.ok(Math.abs(samples - 8000) <= 2, `got ${samples} samples`);
});

test("speech-band tone passes, tone above the new Nyquist is filtered out", () => {
  const pass = new PcmResampler(24000, 8000).process(tone(1000, 24000, 500));
  const stop = new PcmResampler(24000, 8000).process(tone(6000, 24000, 500));
  assert.ok(rms(pass, 100) > 10000, `1 kHz rms ${rms(pass, 100)}`);
  assert.ok(rms(stop, 100) < 300, `6 kHz rms ${rms(stop, 100)} should alias away`);
});

test("chunked output matches one-shot output", () => {
  const input = tone(700, 24000, 300);
  const whole = new PcmResampler(24000, 8000).process(input);
  const r = new PcmResampler(24000, 8000);
  const parts = Buffer.concat([r.process(input.subarray(0, 962)), r.process(input.subarray(962))]);
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length / 2; i++) assert.ok(Math.abs(parts.readInt16LE(i * 2) - whole.readInt16LE(i * 2)) <= 1);
});

test("FrameChunker emits exact frames and pads the tail", () => {
  const c = new FrameChunker(1600);
  assert.equal(c.push(Buffer.alloc(1000, 1)).length, 0);
  const frames = c.push(Buffer.alloc(2500, 1));
  assert.deepEqual(frames.map((f) => f.length), [1600, 1600]);
  const tail = c.flush();
  assert.equal(tail.length, 1600);
  assert.equal(tail[299], 1);
  assert.equal(tail[300], 0);
  assert.equal(c.flush(), null);
});
