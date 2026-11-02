'use strict';
// Web Audio piano: recorded piano samples (samples/, see samples/README.md) with a small
// built-in synth as a fallback for any note whose sample hasn't loaded yet.

// Samples: one recording every 3 keys (A0, C1, D#1 ... C8) at a few loudness layers. Other keys
// play the nearest recording shifted by at most one semitone. Only the recordings a piece needs
// are loaded, because decoded audio takes about 10x its file size in memory.
const Samples = {
  set: null, light: false, index: null, bufs: new Map(), loading: new Map(),
  decoder: null,
  LIGHT: [5, 9, 12, 15], // the layers used by the lighter piano, for pieces that would need too many recordings
  MAX: 160, // recordings kept in memory (~350 MB decoded); beyond that, notes borrow the nearest loaded layer

  async use(set, light = false) {
    if (set === this.set && light === this.light) return !!this.index;
    if (set !== this.set) {
      this.index = null;
      if (set) try {
        const r = await fetch(set + '/index.json');
        if (r.ok) this.index = await r.json();
      } catch (e) { /* not available: the synth plays */ }
    }
    this.set = set; this.light = light; this.bufs.clear(); this.loading.clear();
    return !!(set && this.index);
  },

  pitchFor(m) { const ix = this.index; return Math.max(ix.lo, Math.min(ix.hi, ix.lo + Math.round((m - ix.lo) / ix.step) * ix.step)); },
  layerFor(vel, light = this.light) {
    const v = vel * 127, L = this.index.layers;
    let i = 0;
    while (i < L.length - 1 && v > L[i].hi) i++;
    if (!light) return i;
    const ok = L.map((l, j) => j).filter(j => this.LIGHT.includes(L[j].v));
    return ok.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));
  },
  // How many recordings these notes need.
  count(notes, light = this.light) { return new Set(notes.map(n => this.key(this.pitchFor(n.m), this.layerFor(n.v ?? 0.7, light)))).size; },
  key(p, li) { return p + 'v' + this.index.layers[li].v; },

  load(key) {
    if (this.bufs.has(key) || this.loading.has(key)) return this.loading.get(key);
    if (this.bufs.size + this.loading.size >= this.MAX) return null;
    const set = this.set;
    this.decoder = this.decoder || new OfflineAudioContext(2, 1, 44100);
    const job = fetch(set + '/' + key + '.m4a').then(r => r.arrayBuffer())
      .then(ab => new Promise((ok, bad) => this.decoder.decodeAudioData(ab, ok, bad)))
      .then(buf => {
        if (this.set !== set) return;
        // compressed audio starts with a few ms of silence: skip to the attack so notes stay in time
        const d = buf.getChannelData(0);
        let i = 0;
        while (i < d.length && Math.abs(d[i]) < 0.003) i++;
        this.bufs.set(key, { buf, off: Math.max(0, i - 32) / buf.sampleRate });
      })
      .catch(() => {})
      .finally(() => this.loading.delete(key));
    this.loading.set(key, job);
    return job;
  },

  // Load what these notes need, a few at a time.
  async prepare(notes) {
    if (!this.index) return;
    // most used first, so a piece needing more than MAX recordings gets the ones that matter
    const count = new Map();
    for (const n of notes) { const k = this.key(this.pitchFor(n.m), this.layerFor(n.v ?? 0.7)); count.set(k, (count.get(k) || 0) + 1); }
    const queue = [...count.keys()].filter(k => !this.bufs.has(k)).sort((a, b) => count.get(b) - count.get(a));
    const worker = async () => { while (queue.length) await this.load(queue.shift()); };
    await Promise.all(Array.from({ length: 6 }, worker));
  },

  // The recording for this note, or the closest loaded layer of the same pitch.
  get(m, vel) {
    if (!this.index) return null;
    const p = this.pitchFor(m), li = this.layerFor(vel), want = this.key(p, li);
    if (this.bufs.has(want)) return { p, ...this.bufs.get(want) };
    this.load(want);
    for (let d = 1; d < this.index.layers.length; d++) {
      for (const j of [li - d, li + d]) {
        const k = j >= 0 && j < this.index.layers.length && this.key(p, j);
        if (k && this.bufs.has(k)) return { p, ...this.bufs.get(k) };
      }
    }
    return null;
  },
};

const Synth = {
  ctx: null, master: null, wave: null, voices: [],

  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    const imag = new Float32Array([0, 1, 0.45, 0.25, 0.12, 0.08, 0.05, 0.03]);
    this.wave = ctx.createPeriodicWave(new Float32Array(imag.length), imag);
    this.ctx = ctx;
  },

  get now() { return this.ctx ? this.ctx.currentTime : 0; },

  setVolume(v) { if (this.master) this.master.gain.value = v; },

  note(m, when, dur, vel = 0.7) {
    const smp = Samples.get(m, vel);
    return smp ? this.sampleNote(smp, m, when, dur, vel) : this.synthNote(m, when, dur, vel);
  },

  sampleNote(smp, m, when, dur, vel) {
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = smp.buf;
    src.playbackRate.value = 2 ** ((m - smp.p) / 12);
    // loudness comes mostly from the layer; this smooths the steps between layers
    g.gain.setValueAtTime(Samples.index.gain * (0.7 + 0.3 * vel), when);
    g.gain.setTargetAtTime(0, when + dur, 0.1); // damper
    src.connect(g).connect(this.master);
    src.start(when, smp.off);
    src.stop(when + dur + 1);
    const v = { o: src, g, m };
    this.voices.push(v);
    src.onended = () => { this.voices = this.voices.filter(x => x !== v); };
    return v;
  },

  synthNote(m, when, dur, vel) {
    const ctx = this.ctx;
    const f = 440 * 2 ** ((m - 69) / 12);
    const o = ctx.createOscillator(), g = ctx.createGain(), flt = ctx.createBiquadFilter();
    o.setPeriodicWave(this.wave);
    o.frequency.value = f;
    flt.type = 'lowpass';
    flt.frequency.value = Math.min(f * 5 + 700 * vel, 12000);
    const peak = 0.2 * vel, decay = Math.max(0.35, 2.2 * Math.sqrt(220 / f));
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.setTargetAtTime(0, when + 0.006, decay);
    g.gain.setTargetAtTime(0, when + dur, 0.09);
    o.connect(flt).connect(g).connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.8);
    const v = { o, g, m };
    this.voices.push(v);
    o.onended = () => { this.voices = this.voices.filter(x => x !== v); };
    return v;
  },

  release(v) {
    try { const t = this.ctx.currentTime; v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.08); v.o.stop(t + 0.5); } catch (e) {}
  },

  click(when, strong) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = strong ? 1600 : 1050;
    g.gain.setValueAtTime(0.22, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g).connect(this.master);
    o.start(when);
    o.stop(when + 0.06);
    const v = { o, g };
    this.voices.push(v);
    o.onended = () => { this.voices = this.voices.filter(x => x !== v); };
  },

  stopAll() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.keep) continue;
      try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.02); v.o.stop(t + 0.15); } catch (e) {}
    }
    this.voices = this.voices.filter(v => v.keep);
  },
};
