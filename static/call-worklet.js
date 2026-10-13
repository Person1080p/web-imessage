// Audio worklets for calls. The AudioContext runs at 24 kHz to match the Mac helper.

const FRAME = 480; // 20 ms

// Microphone -> 16-bit PCM frames posted to the page (which sends them over the WebSocket).
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const v = Math.max(-1, Math.min(1, ch[i]));
        this.peak = Math.max(this.peak, Math.abs(v));
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === FRAME) {
          this.port.postMessage({ pcm: this.buf.buffer, level: this.peak }, [this.buf.buffer]);
          this.buf = new Int16Array(FRAME);
          this.n = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}

// Network PCM -> speakers, with a small jitter buffer that never lets latency grow past ~350 ms.
class NetPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    this.queued = 0;
    this.primed = false;
    this.peak = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const a = new Int16Array(e.data);
      this.queue.push(a);
      this.queued += a.length;
      while (this.queued > sampleRate * 0.35 && this.queue.length > 1) {
        this.queued -= this.queue.shift().length;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed && this.queued >= sampleRate * 0.06) this.primed = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.primed) { out[i] = 0; continue; }
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.queue.shift();
        this.pos = 0;
        if (!this.cur) { this.primed = false; out[i] = 0; continue; }
      }
      const v = this.cur[this.pos++] / 32768;
      this.queued--;
      this.peak = Math.max(this.peak, Math.abs(v));
      out[i] = v;
    }
    if (++this.frames % 8 === 0) { this.port.postMessage({ level: this.peak }); this.peak = 0; }
    return true;
  }
}

registerProcessor('mic-capture', MicCapture);
registerProcessor('net-player', NetPlayer);
