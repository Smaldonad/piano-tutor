'use strict';
// Music theory helpers: key signatures, note spelling, key and chord detection.
// No DOM access, so this file can be unit-tested in node.

const NAT = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const LETTERS = 'CDEFGAB';
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];  // B E A D G C F
const ACC = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };
const mod = (a, n) => ((a % n) + n) % n;

function keyAlterations(sf) {
  const alt = [0, 0, 0, 0, 0, 0, 0];
  if (sf > 0) SHARP_ORDER.slice(0, sf).forEach(l => { alt[l] = 1; });
  if (sf < 0) FLAT_ORDER.slice(0, -sf).forEach(l => { alt[l] = -1; });
  return alt;
}

function keyTonic(key) {
  const alt = keyAlterations(key.sf);
  let L = mod(key.sf * 4, 7);       // each sharp moves the major tonic up a fifth (4 letters)
  if (key.minor) L = mod(L + 5, 7); // relative minor is the 6th degree
  return { L, a: alt[L], pc: mod(NAT[L] + alt[L], 12) };
}

function keyName(key) {
  const t = keyTonic(key);
  return LETTERS[t.L] + ACC[t.a] + (key.minor ? ' minor' : ' major');
}

// Returns m -> { L, a, oct, step, name, nameOct, acc } spelled for the key.
// `acc` is the accidental to draw on the staff ('' when the key signature covers it).
function makeSpeller(key) {
  const alt = keyAlterations(key.sf);
  const tonic = keyTonic(key);
  const leading = key.minor ? mod(tonic.pc - 1, 12) : -1;
  const table = [];
  for (let pc = 0; pc < 12; pc++) {
    let L = -1, a = 0;
    for (let l = 0; l < 7; l++) if (mod(NAT[l] + alt[l], 12) === pc) { L = l; a = alt[l]; }
    if (L < 0 && pc === leading) {
      L = mod(tonic.L - 1, 7);
      a = pc - NAT[L];
      if (a > 6) a -= 12;
      if (a < -6) a += 12;
    }
    if (L < 0) {
      const nat = NAT.indexOf(pc);
      if (nat >= 0) { L = nat; a = 0; }
      else if (key.sf >= 0) { L = NAT.indexOf(pc - 1); a = 1; }
      else { L = NAT.indexOf(pc + 1); a = -1; }
    }
    table.push({ L, a, show: a !== alt[L] });
  }
  return m => {
    const c = table[mod(m, 12)];
    const oct = Math.round((m - c.a - NAT[c.L]) / 12) - 1;
    const name = LETTERS[c.L] + ACC[c.a];
    return { L: c.L, a: c.a, oct, step: oct * 7 + c.L, name, nameOct: name + oct,
      acc: c.show ? (c.a === 0 ? '♮' : ACC[c.a]) : '' };
  };
}

// ---------- key detection (Krumhansl-Kessler profiles) ----------
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pitchHistogram(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.m % 12] += n.d;
  return h;
}
function correlate(h, profile, tonicPc) {
  const xs = h, ys = h.map((_, i) => profile[mod(i - tonicPc, 12)]);
  const mx = xs.reduce((a, b) => a + b, 0) / 12, my = ys.reduce((a, b) => a + b, 0) / 12;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
function sfForMajorTonic(pc) {
  for (const sf of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, -6, 6]) if (mod(sf * 7, 12) === pc) return sf;
  return 0;
}
function keyScore(notes, key) {
  const t = keyTonic(key);
  return correlate(pitchHistogram(notes), key.minor ? KK_MINOR : KK_MAJOR, t.pc);
}
function detectKey(notes) {
  const h = pitchHistogram(notes);
  let best = { sf: 0, minor: false, score: -Infinity };
  for (let pc = 0; pc < 12; pc++) {
    const sMaj = correlate(h, KK_MAJOR, pc);
    if (sMaj > best.score) best = { sf: sfForMajorTonic(pc), minor: false, score: sMaj };
    const sMin = correlate(h, KK_MINOR, pc);
    if (sMin > best.score) best = { sf: sfForMajorTonic(mod(pc + 3, 12)), minor: true, score: sMin };
  }
  // Relative major/minor share a key signature and are easy to confuse; decide with the bass line,
  // giving extra weight to the first and last bass notes.
  const bass = bassHistogram(notes);
  const majPc = keyTonic({ sf: best.sf, minor: false }).pc, minPc = keyTonic({ sf: best.sf, minor: true }).pc;
  if (bass[majPc] !== bass[minPc]) best.minor = bass[minPc] > bass[majPc];
  return best;
}

function bassHistogram(notes) {
  const h = new Array(12).fill(0);
  let lows = [];
  let i = 0;
  while (i < notes.length) {
    let j = i, low = notes[i];
    while (j < notes.length && notes[j].s - notes[i].s <= 0.06) { if (notes[j].m < low.m) low = notes[j]; j++; }
    lows.push(low);
    i = j;
  }
  if (!lows.length) return h;
  // Single-track files mix hands; lone melody notes would count as "bass". Prefer the low register.
  const low = lows.filter(n => n.m < 60);
  if (low.length >= lows.length * 0.2) lows = low;
  let total = 0;
  for (const n of lows) { h[n.m % 12] += n.d; total += n.d; }
  const avg = total / lows.length;
  h[lows[0].m % 12] += 4 * avg;
  h[lows[lows.length - 1].m % 12] += 2 * avg;
  return h;
}

// ---------- chords ----------
const CHORD_TYPES = [
  { s: '', iv: [0, 4, 7], q: 'maj' },
  { s: 'm', iv: [0, 3, 7], q: 'min' },
  { s: 'dim', iv: [0, 3, 6], q: 'dim' },
  { s: 'aug', iv: [0, 4, 8], q: 'aug' },
  { s: 'sus4', iv: [0, 5, 7], q: 'sus' },
  { s: 'sus2', iv: [0, 2, 7], q: 'sus' },
  { s: '7', iv: [0, 4, 7, 10], q: 'maj' },
  { s: 'maj7', iv: [0, 4, 7, 11], q: 'maj' },
  { s: 'm7', iv: [0, 3, 7, 10], q: 'min' },
];

// w: duration-weighted pitch-class histogram; bassPc: lowest sounding pitch class (or null)
function detectChord(w, bassPc) {
  const tot = w.reduce((a, b) => a + b, 0);
  if (!tot) return null;
  let best = null, bestScore = -Infinity;
  for (let r = 0; r < 12; r++) {
    if (!w[r]) continue;
    for (const type of CHORD_TYPES) {
      let inn = 0, missing = 0;
      for (const i of type.iv) { const x = w[(r + i) % 12]; inn += x; if (!x) missing++; }
      if (missing > 1 || (type.iv.length > 3 && !w[(r + type.iv[3]) % 12])) continue;
      const score = inn - 0.7 * (tot - inn) + 0.25 * w[r]
        + (bassPc === r ? 0.2 * tot : 0)
        - 0.12 * tot * missing
        - (type.iv.length > 3 ? 0.08 * tot : 0)
        - (type.q === 'aug' || type.q === 'sus' ? 0.05 * tot : 0);
      if (score > bestScore) { bestScore = score; best = { root: r, type, inn }; }
    }
  }
  if (!best || best.inn / tot < 0.6) return null;
  const pcs = best.type.iv.map(i => (best.root + i) % 12);
  const bass = bassPc !== null && bassPc !== best.root && pcs.includes(bassPc) ? bassPc : null;
  return { root: best.root, type: best.type, bass, pcs };
}

function chordLabel(ch, speller, key) {
  const root = speller(ch.root + 60);
  let name = root.name + ch.type.s;
  if (ch.bass !== null) name += '/' + speller(ch.bass + 60).name;
  const t = keyTonic(key), alt = keyAlterations(key.sf);
  const deg = mod(root.L - t.L, 7);
  let rn = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][deg];
  if (ch.type.q === 'min' || ch.type.q === 'dim') rn = rn.toLowerCase();
  const prefix = root.a < alt[root.L] ? '♭' : root.a > alt[root.L] ? '♯' : '';
  const suffix = ch.type.q === 'dim' ? '°' : ch.type.q === 'aug' ? '+' : ch.type.s === '7' || ch.type.s === 'm7' ? '7'
    : ch.type.s === 'maj7' ? 'maj7' : ch.type.q === 'sus' ? ch.type.s : '';
  return { name, roman: prefix + rn + suffix };
}

function weightsBetween(notes, a, b, from = 0) {
  const w = new Array(12).fill(0);
  let lowest = null;
  for (let i = from; i < notes.length; i++) {
    const n = notes[i];
    if (n.s >= b) break;
    const s = Math.max(n.s, a), e = Math.min(n.s + n.d, b);
    if (e <= s) continue;
    w[n.m % 12] += e - s;
    if (lowest === null || n.m < lowest) lowest = n.m;
  }
  return { w, bassPc: lowest === null ? null : lowest % 12 };
}

// Segment the song into chord spans. `res` = window size in beats.
function analyzeChords(notes, totalBeats, res, speller, key) {
  const out = [];
  const maxDur = notes.reduce((x, n) => Math.max(x, n.d), 0);
  let from = 0;
  for (let a = 0; a < totalBeats; a += res) {
    while (from < notes.length && notes[from].s < a - maxDur) from++;
    const { w, bassPc } = weightsBetween(notes, a, a + res, from);
    const ch = detectChord(w, bassPc);
    if (!ch) continue;
    const label = chordLabel(ch, speller, key);
    const prev = out[out.length - 1];
    // same chord with only a different bass note (e.g. an arpeggio) continues the previous span
    if (prev && prev.root === ch.root && prev.type === ch.type.s && Math.abs(prev.end - a) < 1e-6) { prev.end = a + res; continue; }
    out.push({ start: a, end: a + res, ...label, root: ch.root, type: ch.type.s, pcs: ch.pcs, bass: ch.bass });
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { NAT, LETTERS, ACC, mod, keyAlterations, keyTonic, keyName, makeSpeller, detectKey, keyScore,
    detectChord, chordLabel, analyzeChords, weightsBetween, CHORD_TYPES };
}
