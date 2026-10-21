// Plays the NeuraCX side of a call from the browser: sends connected/start/
// media/dtmf/stop, plays back the bot's media, honours clear, and echoes marks
// once the audio queued before them has finished playing.

const RATE = 8000;

function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export class BrowserCall {
  constructor({ url, cli, dni, customParameters, onStatus, onLevel }) {
    Object.assign(this, { url, cli, dni, customParameters, onStatus, onLevel });
    this.seq = 0;
    this.chunk = 0;
    this.sources = new Set();
    this.pendingMarks = [];
    this.playHead = 0;
    this.callId = String(Math.floor(100000 + Math.random() * 900000));
    this.roomId = `SIM_${this.callId}_ROOM`;
    this.startedAt = performance.now();
  }

  async start() {
    this.onStatus("Starting…");
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("mic-worklet.js");
    this.worklet = new AudioWorkletNode(this.ctx, "mic-capture");
    this.ctx.createMediaStreamSource(this.mic).connect(this.worklet);
    this.worklet.port.onmessage = (e) => this.onMicFrame(e.data);

    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.send({ event: "connected" });
      this.send({
        event: "start",
        sequence_number: ++this.seq,
        room_id: this.roomId,
        start: {
          room_id: this.roomId,
          call_id: this.callId,
          cli: this.cli,
          dni: this.dni,
          custom_parameters: this.customParameters,
          media_format: { encoding: "raw", sample_rate: String(RATE), bit_rate: "128000" },
        },
      });
      this.onStatus("In call", "live");
    };
    this.ws.onmessage = (e) => this.onServerMessage(JSON.parse(e.data));
    this.ws.onclose = () => this.cleanup("Call ended");
    this.ws.onerror = () => this.onStatus("Socket error", "bad");
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onMicFrame(samples) {
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    this.onLevel(peak / 32768);
    this.send({
      event: "media",
      sequence_number: ++this.seq,
      room_id: this.roomId,
      media: {
        chunk: ++this.chunk,
        timestamp: String(Math.round(performance.now() - this.startedAt)),
        payload: toBase64(samples),
      },
    });
  }

  sendDtmf(digit) {
    this.send({ event: "dtmf", sequence_number: ++this.seq, room_id: this.roomId, dtmf: { duration: "200", digit } });
  }

  onServerMessage(msg) {
    switch (msg.event) {
      case "media":
        if (msg.media?.payload) this.play(fromBase64(msg.media.payload));
        break;
      case "clear":
        for (const src of this.sources) src.stop();
        this.sources.clear();
        this.playHead = this.ctx.currentTime;
        this.flushMarks(true);
        break;
      case "mark":
        this.pendingMarks.push({ name: msg.mark?.name, at: this.playHead });
        this.flushMarks();
        break;
      case "exit": {
        const params = msg.exit?.parameters || [];
        const dial = params.find((p) => p.action === "dial");
        this.end(dial ? `Bot transferred the call to ${dial.to}` : "Bot hung up");
        break;
      }
      default:
        console.warn("Unexpected message from server", msg);
    }
  }

  play(int16) {
    const buffer = this.ctx.createBuffer(1, int16.length, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.05, this.playHead);
    src.start(at);
    this.playHead = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.flushMarks();
    };
  }

  // Echo marks whose audio has finished playing (or all of them after a clear).
  flushMarks(all = false) {
    const now = this.ctx.currentTime;
    const due = this.pendingMarks.filter((m) => all || m.at <= now + 0.01);
    this.pendingMarks = this.pendingMarks.filter((m) => !due.includes(m));
    for (const m of due) this.send({ event: "mark", sequence_number: ++this.seq, room_id: this.roomId, mark: { name: m.name } });
    clearTimeout(this.markTimer);
    if (this.pendingMarks.length) {
      const wait = Math.max(0, this.pendingMarks[0].at - now) * 1000;
      this.markTimer = setTimeout(() => this.flushMarks(), wait + 20);
    }
  }

  end(reason = "You ended the call") {
    this.send({
      event: "stop",
      sequence_number: ++this.seq,
      room_id: this.roomId,
      stop: { call_id: this.callId, reason },
    });
    this.ws?.close();
    this.cleanup(reason);
  }

  cleanup(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.markTimer);
    this.mic?.getTracks().forEach((t) => t.stop());
    // Cut audio straight away like the real platform would, so a goodbye that
    // gets clipped here would also get clipped on a phone.
    this.ctx?.close();
    this.onLevel(0);
    this.onStatus(reason, "done");
  }
}
