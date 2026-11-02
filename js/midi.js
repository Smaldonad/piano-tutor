'use strict';
// Standard MIDI File parsing, tempo map and the built-in demo. No DOM access.

function parseMidiFile(buf) {
  const d = new DataView(buf);
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); return s; };
  const utf8 = n => { try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buf, p, n)); } catch (e) { return str(n); } };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (d.byteLength < 14 || str(4) !== 'MThd') throw new Error('This is not a MIDI file');
  const hlen = d.getUint32(4), ntrk = d.getUint16(10), ppq = d.getUint16(12);
  if (ppq & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  if (!ppq) throw new Error('This MIDI file is damaged (no timing information)');
  p = 8 + hlen;
  const tempos = [], timeSigs = [], keySigs = [], pedal = [], markers = [];
  const groups = new Map();
  const trackNames = [];
  for (let t = 0; t < ntrk && p + 8 <= d.byteLength; t++) {
    const id = str(4), len = d.getUint32(p + 4);
    p += 8;
    const end = Math.min(p + len, d.byteLength);
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, run = 0;
    const open = new Map();
    const close = (ch, m, offTick) => {
      const q = open.get(ch * 128 + m);
      if (!q || !q.length) return;
      const o = q.shift(), key = t + ':' + ch;
      if (!groups.has(key)) groups.set(key, { t, ch, notes: [] });
      groups.get(key).notes.push({ m, s: o.tick / ppq, d: Math.max((offTick - o.tick) / ppq, 0.03), v: o.vel / 127 });
    };
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st & 0x80) { p++; if (st < 0xF0) run = st; } else st = run;
      if (st === 0xFF) {
        const type = d.getUint8(p++), l = vlq();
        if (type === 0x51 && l >= 3) {
          const us = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2);
          if (us > 0) tempos.push({ beat: tick / ppq, bpm: 60e6 / us });
        } else if (type === 0x58 && l >= 2) timeSigs.push({ beat: tick / ppq, num: d.getUint8(p), den: 2 ** d.getUint8(p + 1) });
        else if (type === 0x59 && l >= 2) keySigs.push({ sf: d.getInt8(p), minor: d.getUint8(p + 1) === 1 });
        else if (type === 0x03 && !trackNames[t]) trackNames[t] = utf8(l).trim();
        else if (type === 0x06) markers.push({ beat: tick / ppq, name: utf8(l).trim() });
        p += l;
      } else if (st === 0xF0 || st === 0xF7) {
        p += vlq();
      } else {
        const hi = st & 0xF0, ch = st & 0x0F;
        const a = d.getUint8(p++);
        const b = (hi === 0xC0 || hi === 0xD0) ? 0 : d.getUint8(p++);
        if (ch === 9) continue; // percussion channel
        if (hi === 0x90 && b > 0) {
          const key = ch * 128 + a;
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ tick, vel: b });
        } else if (hi === 0x80 || hi === 0x90) {
          close(ch, a, tick);
        } else if (hi === 0xB0 && a === 64) {
          pedal.push({ beat: tick / ppq, down: b >= 64 });
        }
      }
    }
    for (const [key, q] of open) for (const _ of [...q]) close(Math.floor(key / 128), key % 128, tick); // unterminated notes
    p = end;
  }
  const tracks = [...groups.values()]
    .filter(g => g.notes.length)
    .sort((x, y) => x.t - y.t || x.ch - y.ch)
    .map(g => {
      const base = trackNames[g.t] || `Track ${g.t + 1}`;
      const multiCh = [...groups.values()].filter(o => o.t === g.t && o.notes.length).length > 1;
      g.notes.sort((x, y) => x.s - y.s || x.m - y.m);
      return { name: multiCh ? `${base} (ch ${g.ch + 1})` : base, notes: g.notes };
    });
  if (!tracks.length) throw new Error('No notes found in this MIDI file');
  const lastBeat = Math.max(...tracks.map(t => t.notes[t.notes.length - 1].s));
  if (!(lastBeat < 20000)) throw new Error('This MIDI file is too long to open');
  pedal.sort((x, y) => x.beat - y.beat);
  const ts = timeSigs.sort((x, y) => x.beat - y.beat)[0];
  return {
    tracks, tempos, pedal, markers: markers.sort((x, y) => x.beat - y.beat),
    timeSig: ts && ts.num >= 1 && ts.num <= 32 && ts.den >= 1 && ts.den <= 64 ? { num: ts.num, den: ts.den } : { num: 4, den: 4 },
    keySig: keySigs[0] || null,
  };
}

// Piecewise-constant tempo: beat <-> seconds.
function makeTempoMap(tempos) {
  const sorted = [...tempos].sort((a, b) => a.beat - b.beat);
  const segs = [];
  if (!sorted.length || sorted[0].beat > 0) segs.push({ beat: 0, bpm: 120 });
  for (const t of sorted) {
    if (segs.length && Math.abs(segs[segs.length - 1].beat - t.beat) < 1e-9) segs[segs.length - 1].bpm = t.bpm;
    else segs.push({ beat: t.beat, bpm: t.bpm });
  }
  segs[0].sec = 0;
  for (let i = 1; i < segs.length; i++) segs[i].sec = segs[i - 1].sec + (segs[i].beat - segs[i - 1].beat) * 60 / segs[i - 1].bpm;
  const segForBeat = b => { let i = segs.length - 1; while (i > 0 && segs[i].beat > b) i--; return segs[i]; };
  const segForSec = s => { let i = segs.length - 1; while (i > 0 && segs[i].sec > s) i--; return segs[i]; };
  return {
    segs,
    beatToSec: b => { const g = segForBeat(b); return g.sec + (b - g.beat) * 60 / g.bpm; },
    secToBeat: s => { const g = segForSec(s); return g.beat + (s - g.sec) * g.bpm / 60; },
    bpmAt: b => segForBeat(b).bpm,
  };
}

// Pedal-down spans as [{start, end}] in beats.
function pedalSpans(events, songEnd) {
  const spans = [];
  let downAt = null;
  for (const e of events) {
    if (e.down && downAt === null) downAt = e.beat;
    else if (!e.down && downAt !== null) { spans.push({ start: downAt, end: e.beat }); downAt = null; }
  }
  if (downAt !== null) spans.push({ start: downAt, end: songEnd });
  return spans;
}

// Built-in demo: J. S. Bach, Prelude in C major, BWV 846 (public domain), entered note by note.
// Bars 1-32 share one figure: two low notes held, then the upper three broken twice, each half bar.
const PRELUDE_BARS = [
  'C4 E4 G4 C5 E5', 'C4 D4 A4 D5 F5', 'B3 D4 G4 D5 F5', 'C4 E4 G4 C5 E5',
  'C4 E4 A4 E5 A5', 'C4 D4 F#4 A4 D5', 'B3 D4 G4 D5 G5', 'B3 C4 E4 G4 C5',
  'A3 C4 E4 G4 C5', 'D3 A3 D4 F#4 C5', 'G3 B3 D4 G4 B4', 'G3 Bb3 E4 G4 C#5',
  'F3 A3 D4 A4 D5', 'F3 Ab3 D4 F4 B4', 'E3 G3 C4 G4 C5', 'E3 F3 A3 C4 F4',
  'D3 F3 A3 C4 F4', 'G2 D3 G3 B3 F4', 'C3 E3 G3 C4 E4', 'C3 G3 Bb3 C4 E4',
  'F2 F3 A3 C4 E4', 'F#2 C3 A3 C4 Eb4', 'Ab2 F3 B3 C4 D4', 'G2 F3 G3 B3 D4',
  'G2 E3 G3 C4 E4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'G2 Eb3 A3 C4 F#4',
  'G2 E3 G3 C4 G4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'C2 C3 G3 Bb3 E4',
];
// Bars 33-34 break the pattern: a held bass pair, then a single run of fourteen sixteenths.
const PRELUDE_CODA = [
  ['C2', 'C3', 'F3 A3 C4 F4 C4 A3 C4 A3 F3 A3 F3 D3 F3 D3'],
  ['C2', 'B2', 'G4 B4 D5 F5 D5 B4 D5 B4 G4 B4 D4 F4 E4 D4'],
];

function noteNum(name) {
  const [, l, acc, oct] = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  return 12 * (+oct + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[l] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
}

function buildDemo() {
  const L = [], R = [];
  const N = (arr, name, s, d, v) => arr.push({ m: noteNum(name), s, d, v });
  PRELUDE_BARS.forEach((bar, i) => {
    const [a, b, ...up] = bar.split(' ');
    for (const h of [0, 2]) {
      const t = i * 4 + h;
      N(L, a, t, 2, 0.5);
      N(L, b, t + 0.25, 1.75, 0.45);
      [...up, ...up].forEach((n, k) => N(R, n, t + 0.5 + k * 0.25, 0.25, k % 3 === 0 ? 0.58 : 0.5));
    }
  });
  PRELUDE_CODA.forEach(([a, b, run], j) => {
    const t = (PRELUDE_BARS.length + j) * 4;
    N(L, a, t, 4, 0.5);
    N(L, b, t + 0.25, 3.75, 0.45);
    run.split(' ').forEach((n, k) => N(R, n, t + 0.5 + k * 0.25, 0.25, 0.5));
  });
  const end = (PRELUDE_BARS.length + PRELUDE_CODA.length) * 4;
  N(L, 'C2', end, 4, 0.5); N(L, 'C3', end, 4, 0.45);
  ['E4', 'G4', 'C5'].forEach(n => N(R, n, end, 4, 0.55));
  const sec = (name, a, b) => ({ name, start: (a - 1) * 4, end: b * 4 });
  return {
    tracks: [{ name: 'Right hand', notes: R }, { name: 'Left hand', notes: L }],
    tempos: [{ beat: 0, bpm: 66 }], pedal: [], timeSig: { num: 4, den: 4 },
    keySig: { sf: 0, minor: false },
    sections: [
      sec('1 · Opening in C (bars 1-4)', 1, 4),
      sec('2 · Moving to G (bars 5-11)', 5, 11),
      sec('3 · Chromatic descent (bars 12-19)', 12, 19),
      sec('4 · Over the G pedal (bars 20-31)', 20, 31),
      sec('5 · Coda (bars 32-35)', 32, 35),
    ],
  };
}

if (typeof module !== 'undefined') module.exports = { parseMidiFile, makeTempoMap, pedalSpans, buildDemo };
