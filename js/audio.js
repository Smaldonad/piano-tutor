'use strict';
// Small Web Audio piano-ish synth. No samples, no dependencies.

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
