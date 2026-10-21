// Downsamples the mic to 8 kHz PCM16 and posts 100 ms frames (800 samples,
// 1600 bytes), the same shape NeuraCX streams by default.
const OUT_RATE = 8000;
const FRAME_SAMPLES = 800;

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const s of channel) {
      // Averaging each window doubles as a crude anti-alias filter.
      this.sum += s;
      this.count++;
      if (++this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.frame[this.filled++] = v * 32767;
        if (this.filled === FRAME_SAMPLES) {
          this.port.postMessage(this.frame.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
