// Audio helpers for 16-bit little-endian mono PCM.
//
// Gemini Live listens at 16 kHz and speaks at 24 kHz, while the NeuraCX leg runs
// at the rate given in the `start` event (8 kHz by default), so audio is
// resampled in both directions.

function lowPassTaps(cutoff, count) {
  // Windowed-sinc FIR. `cutoff` is a fraction of the input sample rate (0..0.5).
  const taps = new Float32Array(count);
  const mid = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const blackman =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
    taps[i] = sinc * blackman;
    sum += taps[i];
  }
  for (let i = 0; i < count; i++) taps[i] /= sum;
  return taps;
}

// Streaming resampler. Keeps filter history and the fractional read position
// across calls, so chunk boundaries don't click the way per-chunk resampling does.
export class PcmResampler {
  constructor(fromRate, toRate) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate;
    // Only downsampling needs an anti-alias filter; cut a little under the new Nyquist.
    this.taps = toRate < fromRate ? lowPassTaps((0.5 * toRate * 0.9) / fromRate, 47) : null;
    this.reset();
  }

  reset() {
    this.history = new Float32Array(this.taps ? this.taps.length - 1 : 0);
    this.pos = 0;
    this.prev = 0;
  }

  process(buf) {
    if (this.fromRate === this.toRate) return buf;
    const n = buf.length >> 1;
    if (n === 0) return Buffer.alloc(0);

    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = buf.readInt16LE(i * 2);

    let filtered = input;
    if (this.taps) {
      const taps = this.taps;
      const h = this.history.length;
      const joined = new Float32Array(h + n);
      joined.set(this.history);
      joined.set(input, h);
      filtered = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k < taps.length; k++) acc += taps[k] * joined[i + k];
        filtered[i] = acc;
      }
      this.history = joined.slice(n);
    }

    // Linear interpolation over the filtered stream. Index -1 is the last
    // sample of the previous chunk (`this.prev`).
    const out = [];
    let pos = this.pos;
    while (pos < n - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? this.prev : filtered[i0];
      const s1 = filtered[i0 + 1];
      out.push(s0 + frac * (s1 - s0));
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = filtered[n - 1];

    const res = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      res.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), i * 2);
    }
    return res;
  }
}

// Cuts a byte stream into fixed-size frames. NeuraCX drops the stream if it
// keeps getting media payloads smaller than the configured chunk size.
export class FrameChunker {
  constructor(frameBytes) {
    this.frameBytes = frameBytes;
    this.pending = Buffer.alloc(0);
  }

  push(buf) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    const frames = [];
    while (this.pending.length >= this.frameBytes) {
      frames.push(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
    return frames;
  }

  // Returns the leftover bytes padded with silence to a full frame, or null.
  flush() {
    if (!this.pending.length) return null;
    const frame = Buffer.alloc(this.frameBytes);
    this.pending.copy(frame);
    this.pending = Buffer.alloc(0);
    return frame;
  }

  reset() {
    this.pending = Buffer.alloc(0);
  }
}
