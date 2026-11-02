'use strict';
/* global Synth, parseMidiFile, makeTempoMap, pedalSpans, buildDemo, makeSpeller, detectKey, keyScore, keyName,
   analyzeChords, detectChord, chordLabel, LETTERS, mod */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const HAND = { L: TH.lh, R: TH.rh };
let ACCENT = TH.accent;
function setTheme(key) { applyTheme(key); $('#petalsOpt').hidden = !TH.petals; HAND.L = TH.lh; HAND.R = TH.rh; ACCENT = TH.accent; keyState.clear(); lastChordUI = ''; }
const ONSET_EPS = 0.06; // notes starting within this many beats count as "struck together"
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const GLYPH = { gClef: '\uE050', fClef: '\uE062', head: '\uE0A4', '♭': '\uE260', '♮': '\uE261', '♯': '\uE262', '𝄪': '\uE263', '𝄫': '\uE264' };

// ---------------- storage + settings ----------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};
const DEFAULTS = {
  noteNames: 'name', chordRes: 'half', key: 'auto', fallZoom: 1, staffZoom: 1, onsetLines: true,
  pedal: true, countIn: true, metronome: false, volume: 0.8, handL: 'play', handR: 'play', loop: true,
  side: true, tab: 'chords', view: 'both', focus: false, theme: 'classic', petals: true, tlZoom: 1,
};
let S;
try { S = Object.assign({}, DEFAULTS, JSON.parse(store.get('pt.settings') || '{}')); } catch (e) { S = { ...DEFAULTS }; }
const saveSettings = () => store.set('pt.settings', JSON.stringify(S));

// ---------------- state ----------------
let raw = null, source = null;    // parsed file + {title, kind, b64}
let assign = [], splitPoint = 60; // per-track hand assignment
let song = null, range = null, tempoFactor = 1;
const T = { playing: false, anchorSec: 0, anchorTime: 0, pausedBeat: 0, nextIdx: 0, leadEnd: -Infinity, nextTick: Infinity };
let hover = null;                 // {beat, gi, x, y, src, pinned}
let keyEls = new Map(), geom = new Map(), keyState = new Map();
const pressed = new Map();        // pointerId -> {m, voice}

const visible = n => S['hand' + n.h] !== 'hide';
const handMode = h => S['hand' + h];

// ---------------- song building ----------------
function defaultAssign(tracks) {
  if (tracks.length === 1) return ['split'];
  const named = tracks.map(t =>
    /left|links|bass|\bl\.?\s?h\b|lower/i.test(t.name) ? 'L'
      : /right|rechts|treble|\br\.?\s?h\b|upper|melody/i.test(t.name) ? 'R' : null);
  const avg = tracks.map(t => t.notes.reduce((a, n) => a + n.m, 0) / t.notes.length);
  const top = avg.indexOf(Math.max(...avg));
  return tracks.map((t, i) => named[i] || (i === top ? 'R' : 'L'));
}

function chooseKey(notes) {
  if (S.key !== 'auto') { const [sf, mi] = S.key.split(','); return { sf: +sf, minor: mi === '1' }; }
  if (!notes.length) return { sf: 0, minor: false };
  const det = detectKey(notes);
  const ks = raw.keySig;
  if (ks && ks.sf === det.sf) return { sf: ks.sf, minor: ks.minor }; // file's own key marking agrees: trust its major/minor
  if (ks && ks.sf >= -7 && ks.sf <= 7 && keyScore(notes, ks) >= det.score * 0.95) return { sf: ks.sf, minor: ks.minor };
  return { sf: det.sf, minor: det.minor };
}

function buildSong() {
  const notes = [];
  raw.tracks.forEach((tr, i) => {
    const a = assign[i];
    if (a === 'off') return;
    for (const n of tr.notes) notes.push({ m: n.m, s: n.s, d: n.d, v: n.v, tr: i, h: a === 'split' ? (n.m >= splitPoint ? 'R' : 'L') : a });
  });
  notes.sort((a, b) => a.s - b.s || a.m - b.m);
  const bpb = raw.timeSig.num * 4 / raw.timeSig.den;
  const lastEnd = notes.reduce((x, n) => Math.max(x, n.s + n.d), bpb);
  const totalBeats = Math.ceil(lastEnd / bpb - 1e-6) * bpb;
  const key = chooseKey(notes);
  const speller = makeSpeller(key);
  const spans = pedalSpans(raw.pedal || [], totalBeats);
  for (const n of notes) {
    n.sp = speller(n.m);
    const e = n.s + n.d;
    const span = S.pedal ? spans.find(x => x.start <= e && e < x.end) : null;
    n.pe = span ? Math.max(e, span.end) : e;
  }
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.s - g.beat <= ONSET_EPS) g.notes.push(n);
    else groups.push({ beat: n.s, notes: [n] });
    n.g = groups.length - 1;
  }
  const res = S.chordRes === 'bar' ? bpb : S.chordRes === 'beat' ? 1 : (bpb % 2 === 0 ? bpb / 2 : bpb);
  const named = (raw.sections && raw.sections.length ? raw.sections : null) || markerSections(raw.markers, totalBeats, bpb);
  const sections = named || autoSections(totalBeats, bpb);
  song = {
    title: source.title, namedSections: !!named, notes, maxDur: notes.reduce((x, n) => Math.max(x, n.d), 0) + 0.01, groups, sections, bpb, totalBeats, bars: totalBeats / bpb, key, speller,
    tm: makeTempoMap(raw.tempos), chords: analyzeChords(notes, totalBeats, res, speller, key),
  };
}

// Sections from MIDI marker events, snapped to bar lines.
function markerSections(markers, total, bpb) {
  if (!markers || !markers.length) return null;
  const starts = [];
  for (const mk of markers) {
    const start = Math.round(mk.beat / bpb) * bpb;
    if (start >= total) continue;
    if (starts.length && starts[starts.length - 1].start === start) starts[starts.length - 1].name = mk.name || 'Section';
    else starts.push({ name: mk.name || 'Section', start });
  }
  if (!starts.length) return null;
  if (starts[0].start > 0) starts.unshift({ name: 'Start', start: 0 });
  return starts.map((s, i) => ({ name: s.name, start: s.start, end: i + 1 < starts.length ? starts[i + 1].start : total }));
}

function autoSections(total, bpb) {
  const bars = total / bpb, out = [];
  for (let b = 0; b < bars; b += 8) { const e = Math.min(b + 8, bars); out.push({ name: `Bars ${b + 1}–${e}`, start: b * bpb, end: e * bpb }); }
  return out;
}

function loadRaw(r, src) {
  flushNotes();
  saveProgress();
  pause();
  raw = r; source = src;
  let prefs = null;
  try { prefs = JSON.parse(store.get('pt.song.' + (src.id || src.title)) || 'null'); } catch (e) {}
  assign = prefs && prefs.assign && prefs.assign.length === r.tracks.length ? prefs.assign : defaultAssign(r.tracks);
  splitPoint = prefs && prefs.split ? prefs.split : 60;
  setHover(null);
  buildSong();
  range = wholeRange();
  T.pausedBeat = 0;
  buildKeyboard();
  seek(0);
  renderAll();
  loadNotesForSong();
  loadProgress();
  $('#empty').hidden = true;
  document.body.classList.remove('nosong');
  if (src.kind === 'demo') store.set('pt.last', JSON.stringify({ kind: 'demo' }));
  else if (!store.set('pt.last', JSON.stringify(src))) {
    try { localStorage.removeItem('pt.last'); } catch (e) {}
    toast('File too large to reopen automatically next time');
  }
}

function rebuild() {
  const t = now();
  const wasPlaying = T.playing;
  if (wasPlaying) pause();
  const oldRange = range;
  const wasWhole = !oldRange || (oldRange.start === 0 && oldRange.end === song.totalBeats);
  setHover(null);
  buildSong();
  range = !wasWhole && oldRange.end <= song.totalBeats ? oldRange : wholeRange();
  buildKeyboard();
  seek(Math.min(Math.max(t, range.start), range.end));
  renderAll();
  if (wasPlaying) play();
}

function savePrefs() { store.set('pt.song.' + songId(), JSON.stringify({ assign, split: splitPoint })); }

async function openMidiFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const r = parseMidiFile(buf);
    const title = file.name.replace(/\.midi?$/i, '');
    savePiece(file.name, buf);
    loadRaw(r, { kind: 'midi', title, id: title + '#' + fnv1a(buf), b64: toB64(buf) });
    toast(`Opened “${source.title}”: ${song.notes.length} notes, ${song.bars} bars`);
  } catch (e) {
    toast('Could not open that file: ' + e.message);
  }
}
function fnv1a(buf) {
  const b = new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(s) {
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------------- range ----------------
const wholeRange = () => ({ start: 0, end: song.totalBeats, name: 'Whole piece' });
function setRange(r) {
  range = r || wholeRange();
  const t = now();
  if (t < range.start || t >= range.end) seek(range.start);
  renderSectionSelect();
  renderSheetState(true);
  renderProgress();
}
function barRange(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return { start: lo * song.bpb, end: Math.min(hi + 1, song.bars) * song.bpb, name: lo === hi ? `Bar ${lo + 1}` : `Bars ${lo + 1}–${hi + 1}` };
}

// ---------------- transport ----------------
const songSec = () => T.playing ? T.anchorSec + (Synth.now - T.anchorTime) * tempoFactor : song.tm.beatToSec(T.pausedBeat);
const now = () => !song ? 0 : T.playing ? song.tm.secToBeat(songSec()) : T.pausedBeat;
const audioTime = b => T.anchorTime + (song.tm.beatToSec(b) - T.anchorSec) / tempoFactor;

function lowerBound(arr, beat, k = 's') {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][k] < beat - 1e-9) lo = mid + 1; else hi = mid; }
  return lo;
}

function seek(beat, countIn = false) {
  tlManual = false;
  if (!song) return;
  Synth.stopAll();
  beat = Math.max(0, Math.min(beat, song.totalBeats));
  T.leadEnd = -Infinity;
  if (countIn && S.countIn) { T.leadEnd = beat; beat -= song.bpb; }
  if (T.playing) { T.anchorSec = song.tm.beatToSec(beat); T.anchorTime = Synth.now + 0.06; }
  else T.pausedBeat = beat;
  T.nextIdx = lowerBound(song.notes, beat);
  T.nextTick = Math.ceil(beat - 1e-6);
}

function play() {
  if (!song || T.playing) return;
  Synth.init();
  Synth.setVolume(S.volume);
  const t = T.pausedBeat;
  const atStart = t <= range.start + 1e-6 || t >= range.end - 1e-6;
  T.playing = true;
  if (hover && hover.pinned) setHover(null);
  seek(atStart ? range.start : t, atStart);
  updatePlayButton();
  keepAwake(true);
}
function pause() {
  if (!T.playing) return;
  T.pausedBeat = Math.max(now(), range ? range.start : 0);
  T.playing = false;
  Synth.stopAll();
  updatePlayButton();
  keepAwake(false);
  saveProgress();
}

// Keep the screen on while playing (Screen Wake Lock; needs the https address on the iPad).
let wakeLock = null;
async function keepAwake(on) {
  if (!on) { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } return; }
  if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    if (!T.playing) keepAwake(false);
  } catch (e) { wakeLock = null; }
}
// iOS drops the lock when the app is hidden; take it back on return.
document.addEventListener('visibilitychange', () => { if (T.playing) keepAwake(true); });
function updatePlayButton() {
  for (const id of ['#play', '#fPlay']) { $(id).innerHTML = T.playing ? ICON.pause : ICON.play; $(id).classList.toggle('on', T.playing); }
  document.body.classList.toggle('playing', T.playing);
}

function schedule() {
  let t = now();
  // Wrap slightly before the end so the first notes of the next pass are scheduled ahead of time.
  // Everything before range.end is already scheduled thanks to the look-ahead below.
  const wrapEps = song.tm.secToBeat(songSec() + 0.05 * tempoFactor) - t;
  if (S.loop && t >= range.end - wrapEps && T.leadEnd < range.end) { wrapLoop(); t = now(); }
  else if (!S.loop && t >= range.end) { pause(); T.pausedBeat = range.end; return; }
  const ahead = song.tm.secToBeat(songSec() + 0.25 * tempoFactor);
  const cap = Math.min(ahead, range.end);
  while (T.nextTick < cap) {
    const b = T.nextTick, inLead = b < T.leadEnd;
    if (inLead || (S.metronome && b >= range.start)) {
      Synth.click(Math.max(Synth.now, audioTime(b)), Math.abs(mod(b - (inLead ? T.leadEnd : 0), song.bpb)) < 1e-6);
    }
    T.nextTick++;
  }
  const notes = song.notes;
  while (T.nextIdx < notes.length && notes[T.nextIdx].s < cap) {
    const n = notes[T.nextIdx++];
    if (n.s < t - 0.05 || n.s < range.start - 1e-6) continue;
    if (handMode(n.h) !== 'play') continue;
    const dur = (song.tm.beatToSec(n.pe) - song.tm.beatToSec(n.s)) / tempoFactor;
    Synth.note(n.m, Math.max(Synth.now, audioTime(n.s)), dur, n.v ?? 0.7);
  }
}

// Jump back to the range start without a gap: the start of the range lines up with the exact audio
// time the end was reached, so loops stay in time with the metronome.
function wrapLoop() {
  const wrapAt = audioTime(range.end);
  T.anchorSec = song.tm.beatToSec(range.start);
  T.anchorTime = wrapAt;
  T.leadEnd = -Infinity;
  T.nextIdx = lowerBound(song.notes, range.start);
  T.nextTick = Math.ceil(range.start - 1e-6);
}

// After tempo / hand changes mid-play: restart the clock here and re-sound notes still held.
function resync() {
  if (!T.playing) return;
  const t = now();
  T.anchorSec = song.tm.beatToSec(t);
  T.anchorTime = Synth.now;
  Synth.stopAll();
  for (let i = lowerBound(song.notes, t - song.maxDur); i < song.notes.length; i++) {
    const n = song.notes[i];
    if (n.s >= t) break;
    if (n.pe <= t || n.s < range.start - 1e-6 || handMode(n.h) !== 'play') continue;
    Synth.note(n.m, Synth.now, (song.tm.beatToSec(n.pe) - song.tm.beatToSec(t)) / tempoFactor, (n.v ?? 0.7) * 0.8);
  }
  T.nextIdx = lowerBound(song.notes, t);
  T.nextTick = Math.ceil(t - 1e-6);
}

function setTempo(pct) {
  pct = Math.max(25, Math.min(150, pct));
  if (T.playing) resync(); // anchor at the old tempo first
  tempoFactor = pct / 100;
  if (T.playing) resync();
  $('#tempo').value = pct;
  updateTempoLabel();
}
function updateTempoLabel() {
  const bpm = song ? Math.round(song.tm.bpmAt(Math.max(0, now())) * tempoFactor) : 0;
  $('#tempoLbl').textContent = `${Math.round(tempoFactor * 100)}%` + (song ? ` · ♩${bpm}` : '');
}

// ---------------- keyboard ----------------
function buildKeyboard() {
  const kbd = $('#kbd');
  kbd.innerHTML = '';
  keyEls = new Map(); geom = new Map(); keyState = new Map();
  let lo = 36, hi = 84;
  if (song.notes.length) {
    let mn = 127, mx = 0;
    for (const n of song.notes) { if (n.m < mn) mn = n.m; if (n.m > mx) mx = n.m; }
    lo = Math.max(21, Math.min(lo, Math.floor(mn / 12) * 12));
    hi = Math.min(108, Math.max(hi, Math.ceil((mx + 1) / 12) * 12));
  }
  const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = 1 / whites.length, bw = ww * 0.62;
  let wi = -1;
  for (let m = lo; m <= hi; m++) {
    const black = isBlack(m);
    let x, w;
    if (!black) { wi++; x = wi * ww; w = ww; } else { x = (wi + 1) * ww - bw / 2; w = bw; }
    geom.set(m, { x, w, black });
    const el = document.createElement('div');
    el.className = 'key ' + (black ? 'b' : 'w') + (m === 60 ? ' c4' : '');
    el.style.left = (x * 100) + '%';
    el.style.width = (w * 100) + '%';
    el.dataset.m = m;
    el.innerHTML = (m % 12 === 0 ? `<span class="oct">${m === 60 ? 'mid C' : 'C' + (m / 12 - 1)}</span>` : '') + '<span class="lab"></span>';
    kbd.appendChild(el);
    keyEls.set(m, el);
  }
  keyState = new Map();
}

function keyLabel(m, active) {
  if (S.noteNames === 'off') return '';
  if (geom.get(m).black && !active) return '';
  const sp = song.speller(m);
  return S.noteNames === 'oct' ? sp.nameOct : sp.name;
}

function updateKeys(t) {
  const want = new Map();
  if (t >= range.start - 1e-6) {
    for (let i = lowerBound(song.notes, t - song.maxDur); i < song.notes.length; i++) {
      const n = song.notes[i];
      if (n.s > t) break;
      if (visible(n) && n.s + n.d > t && n.s >= range.start - 1e-6 && n.s < range.end) want.set(n.m, n.h);
    }
  }
  const extra = new Map();
  if (hover) {
    const info = hoverNotes(hover);
    for (const n of info.held) extra.set(n.m, 'hh');
    for (const n of info.struck) extra.set(n.m, 'hs');
  }
  for (const p of pressed.values()) extra.set(p.m, (extra.get(p.m) || '') + ' press');
  for (const [m, el] of keyEls) {
    const h = want.get(m) || '', x = extra.get(m) || '';
    const state = h + '|' + x + '|' + S.noteNames + '|' + S.theme;
    if (keyState.get(m) === state) continue;
    keyState.set(m, state);
    el.className = 'key ' + (geom.get(m).black ? 'b' : 'w') + (m === 60 ? ' c4' : '') + (h ? ' ' + h : '') + (x ? ' ' + x : '');
    el.querySelector('.lab').textContent = keyLabel(m, !!(h || x));
  }
}

function keyFromPoint(x, y) {
  const els = document.elementsFromPoint(x, y).filter(e => e.classList && e.classList.contains('key'));
  const el = els.find(e => e.classList.contains('b')) || els[0];
  return el ? +el.dataset.m : null;
}
function pressKey(id, m) {
  Synth.init();
  Synth.setVolume(S.volume);
  const voice = Synth.note(m, Synth.now, 20, 0.7);
  voice.keep = true;
  pressed.set(id, { m, voice });
}
function releaseKey(id) {
  const p = pressed.get(id);
  if (!p) return;
  Synth.release(p.voice);
  pressed.delete(id);
}

// ---------------- canvas helpers ----------------
function fit(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, r.width, r.height];
}
// Canvas text with accidentals: system fonts fall back to a music font with wide side bearings for
// ♭/♯, which renders "E ♭". Place each accidental by its ink bounds, tight against the letter.
const ACC_CH = /[♭♯♮𝄫𝄪]/u;
const glyphCache = new Map();
function glyphMetrics(g, ch) {
  const key = g.font + ch;
  let m = glyphCache.get(key);
  if (!m) {
    const align = g.textAlign;
    g.textAlign = 'left'; // ink bounds are relative to the alignment point
    const t = g.measureText(ch);
    g.textAlign = align;
    m = { w: t.width, l: t.actualBoundingBoxLeft, r: t.actualBoundingBoxRight };
    glyphCache.set(key, m);
  }
  return m;
}
function musicLayout(g, s) {
  const runs = [];
  let x = 0;
  for (const ch of s) {
    const m = glyphMetrics(g, ch);
    if (ACC_CH.test(ch)) { runs.push([ch, x + 0.5 + m.l]); x += 1.5 + m.l + m.r; }
    else { runs.push([ch, x]); x += m.w; }
  }
  return { runs, width: x };
}
function measureMusic(g, s) { return ACC_CH.test(s) ? musicLayout(g, s).width : g.measureText(s).width; }
function fillMusic(g, s, x, y) {
  if (!ACC_CH.test(s)) { g.fillText(s, x, y); return; }
  const { runs, width } = musicLayout(g, s), align = g.textAlign;
  const x0 = align === 'center' ? x - width / 2 : align === 'right' || align === 'end' ? x - width : x;
  g.textAlign = 'left';
  for (const [ch, dx] of runs) g.fillText(ch, x0 + dx, y);
  g.textAlign = align;
}

function rrect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
const chordHue = root => mod(root * 7, 12) * 30; // neighbours on the circle of fifths get neighbouring colours
function chordAt(t) {
  const cs = song.chords;
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid].start <= t + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && cs[ans].end > t ? ans : -1;
}
function fmtBeat(beat) {
  const bar = Math.floor(beat / song.bpb + 1e-6);
  const inBar = beat - bar * song.bpb + 1;
  const whole = Math.floor(inBar + 1e-6), frac = inBar - whole;
  const f = Math.abs(frac) < 0.04 ? '' : Math.abs(frac - 0.5) < 0.04 ? '½' : Math.abs(frac - 0.25) < 0.04 ? '¼' : Math.abs(frac - 0.75) < 0.04 ? '¾' : '+';
  return { bar: bar + 1, text: `Bar ${bar + 1} · beat ${whole}${f}` };
}

// ---------------- sheet music canvas ----------------
function scoreLayout(W) {
  const GAP = 12, TOP = 76;
  const tBottom = TOP + 4 * GAP, bTop = tBottom + 6 * GAP, bBottom = bTop + 4 * GAP;
  const x0 = 12, ksX = x0 + 50, clipX = ksX + Math.abs(song.key.sf) * 12 + 18;
  return { GAP, TOP, tBottom, bTop, bBottom, x0, ksX, clipX, playX: Math.max(clipX + 100, W * 0.25), ppb: 95 * S.staffZoom };
}
const KS = {
  sharp: { T: ['F5', 'C5', 'G5', 'D5', 'A4', 'E5', 'B4'], B: ['F3', 'C3', 'G3', 'D3', 'A2', 'E3', 'B2'] },
  flat: { T: ['B4', 'E5', 'A4', 'D5', 'G4', 'C5', 'F4'], B: ['B2', 'E3', 'A2', 'D3', 'G2', 'C3', 'F2'] },
};
const stepOf = s => (+s[1]) * 7 + LETTERS.indexOf(s[0]);

const SCORE_H = 290;
// In "Sheet" view the staff is enlarged (up to 1.8x) so it can be read from the piano; capped so enough
// of the upcoming music still fits across the screen.
const scoreScale = h => Math.min(1.8, Math.max(1, h / SCORE_H));

function drawScore(t) {
  const [g, W0, H0] = fit($('#score'));
  const k = scoreScale(H0);
  g.fillStyle = TH.paper;
  g.fillRect(0, 0, W0, H0);
  g.translate(0, Math.max(0, (H0 - SCORE_H * k) / 2));
  g.scale(k, k);
  const W = W0 / k, H = Math.min(H0 / k, SCORE_H);
  const L = scoreLayout(W), { GAP, tBottom, bTop, bBottom, x0, clipX, playX, ppb } = L;
  const yT = step => tBottom - (step - 30) * GAP / 2;
  const yB = step => bBottom - (step - 18) * GAP / 2;
  const yOf = n => n.h === 'L' ? yB(n.sp.step) : yT(n.sp.step);
  g.fillStyle = TH.paper;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = TH.ink;
  g.lineWidth = 1;
  for (let i = 0; i < 5; i++) for (const y of [tBottom - i * GAP, bBottom - i * GAP]) {
    g.beginPath(); g.moveTo(x0, y + .5); g.lineTo(W, y + .5); g.stroke();
  }
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(x0, tBottom - 4 * GAP); g.lineTo(x0, bBottom); g.stroke();
  g.lineWidth = 1;
  g.fillStyle = TH.ink;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `${4 * GAP}px Bravura`;
  g.fillText(GLYPH.gClef, x0 + 6, tBottom - GAP);
  g.fillText(GLYPH.fClef, x0 + 6, bTop + GAP);
  const sf = song.key.sf, kind = sf > 0 ? 'sharp' : 'flat';
  for (let i = 0; i < Math.abs(sf); i++) {
    const x = L.ksX + i * 12, glyph = sf > 0 ? GLYPH['♯'] : GLYPH['♭'];
    g.fillText(glyph, x, yT(stepOf(KS[kind].T[i])));
    g.fillText(glyph, x, yB(stepOf(KS[kind].B[i])));
  }
  // playhead
  g.fillStyle = HAND.R + '1f';
  g.fillRect(playX - 14, 40, 28, H - 44);
  g.strokeStyle = HAND.R;
  g.beginPath(); g.moveTo(playX + .5, 40); g.lineTo(playX + .5, H - 4); g.stroke();

  g.save();
  g.beginPath(); g.rect(clipX, 0, W - clipX, H); g.clip();
  const tMin = t - (playX - clipX) / ppb, tMax = t + (W - playX) / ppb;
  const xOf = b => playX + (b - t) * ppb;
  // outside the practice range: shade
  g.fillStyle = TH.darkPaper ? 'rgba(0,0,0,0.3)' : 'rgba(40,40,60,0.07)';
  if (range.start > tMin) g.fillRect(clipX, 0, Math.max(0, xOf(range.start) - clipX), H);
  if (range.end < tMax) g.fillRect(xOf(range.end), 0, W, H);
  // chord lane
  const ci0 = Math.max(0, chordAt(tMin) >= 0 ? chordAt(tMin) : lowerBound(song.chords, tMin, 'start') - 1);
  for (let i = Math.max(0, ci0); i < song.chords.length; i++) {
    const c = song.chords[i];
    if (c.start > tMax) break;
    if (c.end < tMin) continue;
    const x1 = xOf(c.start) + 2, x2 = xOf(c.end) - 2, hue = chordHue(c.root);
    rrect(g, x1, 8, Math.max(x2 - x1, 4), 30, 7);
    g.fillStyle = TH.darkPaper ? `hsl(${hue} 32% 23%)` : `hsl(${hue} 70% 90%)`; g.fill();
    g.strokeStyle = TH.darkPaper ? `hsl(${hue} 45% 45%)` : `hsl(${hue} 45% 62%)`; g.stroke();
    g.save(); g.beginPath(); g.rect(x1, 8, Math.max(x2 - x1, 4), 30); g.clip();
    g.fillStyle = TH.darkPaper ? `hsl(${hue} 75% 86%)` : `hsl(${hue} 50% 25%)`;
    g.font = '700 15px -apple-system, sans-serif';
    const w = measureMusic(g, c.name), lx = Math.max(x1, clipX);
    if (x2 - lx >= w + 12) {
      fillMusic(g, c.name, lx + 7, 28);
      g.font = '600 11px -apple-system, sans-serif';
      g.fillStyle = TH.darkPaper ? `hsl(${hue} 45% 68%)` : `hsl(${hue} 35% 40%)`;
      if (x2 - lx >= w + 20 + g.measureText(c.roman).width) g.fillText(c.roman, lx + 12 + w, 28);
    }
    g.restore();
  }
  // bar lines
  const bpb = song.bpb;
  g.font = '11px -apple-system, sans-serif';
  for (let b = Math.max(0, Math.ceil(tMin / bpb) * bpb); b <= Math.min(tMax, song.totalBeats); b += bpb) {
    const x = xOf(b);
    g.strokeStyle = TH.inkDim;
    g.beginPath(); g.moveTo(x + .5, tBottom - 4 * GAP); g.lineTo(x + .5, bBottom); g.stroke();
    g.fillStyle = TH.inkDim;
    g.fillText(String(b / bpb + 1), x + 3, tBottom - 4 * GAP - 26);
  }
  // hover line
  const hn = hover ? hoverNotes(hover) : null;
  if (hover) {
    const x = xOf(hover.beat);
    g.strokeStyle = TH.darkPaper ? ACCENT : 'rgba(180,140,0,0.8)';
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(x + .5, 42); g.lineTo(x + .5, H - 4); g.stroke();
    g.setLineDash([]);
  }
  const struckSet = hn ? new Set(hn.struck) : null;
  const names = S.noteNames;
  for (let i = lowerBound(song.notes, tMin - song.maxDur); i < song.notes.length; i++) {
    const n = song.notes[i];
    if (n.s > tMax) break;
    if (n.s + n.d < tMin || !visible(n)) continue;
    const x = xOf(n.s), y = yOf(n);
    const outside = n.s < range.start - 1e-6 || n.s >= range.end;
    const past = n.s + n.d < t, sounding = !outside && n.s <= t && !past;
    g.globalAlpha = outside ? 0.25 : past ? 0.35 : 1;
    // ledger lines
    g.strokeStyle = TH.ink;
    const lo = n.h === 'L' ? bBottom : tBottom, hi = n.h === 'L' ? bTop : tBottom - 4 * GAP;
    for (let ly = lo + GAP; ly <= y + 0.1; ly += GAP) { g.beginPath(); g.moveTo(x - 10, ly + .5); g.lineTo(x + 10, ly + .5); g.stroke(); }
    for (let ly = hi - GAP; ly >= y - 0.1; ly -= GAP) { g.beginPath(); g.moveTo(x - 10, ly + .5); g.lineTo(x + 10, ly + .5); g.stroke(); }
    g.fillStyle = HAND[n.h] + '40';
    g.fillRect(x + 6, y - 1, Math.max(n.d * ppb - 12, 0), 2);
    g.fillStyle = HAND[n.h];
    g.font = `${4 * GAP}px Bravura`;
    g.textAlign = 'center';
    g.fillText(GLYPH.head, x, y);
    if (n.sp.acc) { g.fillStyle = TH.ink; g.fillText(GLYPH[n.sp.acc], x - 15, y); }
    g.textAlign = 'left';
    if (sounding || (struckSet && struckSet.has(n))) {
      g.strokeStyle = struckSet && struckSet.has(n) ? (TH.darkPaper ? ACCENT : '#b38600') : TH.ink;
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(x, y, 10, 7.5, 0, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1;
    }
    if (names !== 'off') {
      g.fillStyle = HAND[n.h];
      g.font = '700 10px -apple-system, sans-serif';
      fillMusic(g, names === 'oct' ? n.sp.nameOct : n.sp.name, x + 9, y - 6);
    }
    g.globalAlpha = 1;
  }
  g.restore();
}

// ---------------- falling notes canvas ----------------
function fallLayout(H) { return { ppb: Math.max(H / 6, 30) * S.fallZoom }; }

function drawFall(t) {
  const [g, W, H] = fit($('#fall'));
  const { ppb } = fallLayout(H);
  const span = H / ppb;
  const yOf = b => H - (b - t) * ppb;
  g.fillStyle = TH.fallBg;
  g.fillRect(0, 0, W, H);
  if (TH.petals && S.petals) drawPetals(g, W, H);
  for (const k of geom.values()) if (k.black) { g.fillStyle = TH.fallBlack; g.fillRect(k.x * W, 0, k.w * W, H); }
  g.strokeStyle = TH.fallLine;
  for (const [m, k] of geom) if (m % 12 === 0 || m % 12 === 5) { g.beginPath(); g.moveTo(k.x * W + .5, 0); g.lineTo(k.x * W + .5, H); g.stroke(); }
  // outside range shading
  g.fillStyle = 'rgba(0,0,0,0.45)';
  if (range.end < t + span) g.fillRect(0, 0, W, Math.max(0, yOf(range.end)));
  if (range.start > t) g.fillRect(0, yOf(range.start), W, H);
  // bar lines
  const bpb = song.bpb, labels = [];
  for (let b = Math.max(0, Math.floor(t / bpb) * bpb); b <= Math.min(t + span, song.totalBeats); b += bpb) {
    const y = yOf(b);
    g.strokeStyle = TH.fallBar;
    g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke();
    const ci = chordAt(b);
    labels.push([`Bar ${b / bpb + 1}${ci >= 0 && song.chords[ci].start === b ? ' · ' + song.chords[ci].name : ''}`, y]);
  }
  // bar labels sit under the notes, so a note is never hidden behind one
  g.font = '600 12px -apple-system, sans-serif';
  for (const [label, y] of labels) {
    const w = measureMusic(g, label) + 14;
    g.fillStyle = TH.labelBg;
    rrect(g, 6, y - 22, w, 19, 6); g.fill();
    g.fillStyle = TH.label;
    fillMusic(g, label, 13, y - 8);
  }
  // onset connectors (notes struck together)
  const hn = hover ? hoverNotes(hover) : null;
  const struckSet = hn ? new Set(hn.struck) : new Set();
  const heldSet = hn ? new Set(hn.held) : new Set();
  const g0 = lowerBound(song.groups, t - 0.5, 'beat');
  for (let gi = g0; gi < song.groups.length; gi++) {
    const grp = song.groups[gi];
    if (grp.beat > t + span) break;
    const isHover = hover && hover.gi === gi;
    if (!S.onsetLines && !isHover) continue;
    const vs = grp.notes.filter(n => visible(n) && geom.has(n.m));
    if (vs.length < 2) continue;
    const xs = vs.map(n => { const k = geom.get(n.m); return (k.x + k.w / 2) * W; });
    const y = yOf(grp.beat) - 1;
    g.strokeStyle = isHover ? ACCENT : 'rgba(255,255,255,0.14)';
    g.lineWidth = isHover ? 3 : 1;
    g.beginPath(); g.moveTo(Math.min(...xs), y); g.lineTo(Math.max(...xs), y); g.stroke();
    g.lineWidth = 1;
    g.fillStyle = isHover ? ACCENT : 'rgba(255,255,255,0.32)';
    for (const x of xs) { g.beginPath(); g.arc(x, y, isHover ? 3.5 : 2, 0, Math.PI * 2); g.fill(); }
  }
  // notes
  g.textAlign = 'center';
  g.font = '700 11px -apple-system, sans-serif';
  for (let i = lowerBound(song.notes, t - song.maxDur); i < song.notes.length; i++) {
    const n = song.notes[i];
    if (n.s > t + span) break;
    if (n.s + n.d < t || !visible(n)) continue;
    const k = geom.get(n.m);
    if (!k) continue;
    const outside = n.s < range.start - 1e-6 || n.s >= range.end;
    const y1 = yOf(n.s), y0 = yOf(n.s + n.d);
    const x = k.x * W + 1.5, w = k.w * W - 3, h = Math.max(y1 - y0 - 2, 4);
    const mine = handMode(n.h) === 'mute';
    g.globalAlpha = outside ? 0.25 : 1;
    rrect(g, x, y0, w, h, 5);
    if (mine) {
      g.fillStyle = HAND[n.h] + '33'; g.fill();
      g.strokeStyle = HAND[n.h]; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
    } else {
      const grd = g.createLinearGradient(0, y0, 0, y0 + h);
      grd.addColorStop(0, HAND[n.h] + 'cc'); grd.addColorStop(1, HAND[n.h]);
      g.fillStyle = grd; g.fill();
    }
    if (struckSet.has(n)) { g.strokeStyle = ACCENT; g.lineWidth = 3; g.stroke(); g.lineWidth = 1; }
    else if (heldSet.has(n)) { g.strokeStyle = ACCENT + '80'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1; }
    else if (!outside && n.s <= t) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1; }
    if (S.noteNames !== 'off' && h > 16 && w > 12) {
      g.fillStyle = '#fff';
      fillMusic(g, S.noteNames === 'oct' ? n.sp.nameOct : n.sp.name, x + w / 2, y1 - 7);
    }
    g.globalAlpha = 1;
  }
  g.textAlign = 'left';
  // hover line
  if (hover) {
    const y = yOf(hover.beat);
    g.strokeStyle = ACCENT + '8c';
    g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.setLineDash([]);
  }
  // count-in
  if (t < T.leadEnd) {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '800 72px -apple-system, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(Math.floor(t - (T.leadEnd - bpb)) + 1), W / 2, H / 2);
    g.textAlign = 'left';
  }
  // hit line
  g.fillStyle = HAND.R + '99';
  g.fillRect(0, H - 2, W, 2);
}

// Sakura theme: a few cherry-blossom petals drifting slowly behind the falling notes.
function petalPath(g, L, w) {
  // Rounded petal with the notch at its tip that cherry blossoms have; base at +L/2.
  g.beginPath();
  g.moveTo(0, L * 0.5);
  g.bezierCurveTo(w * 0.9, L * 0.35, w * 1.05, -L * 0.25, w * 0.4, -L * 0.5);
  g.quadraticCurveTo(w * 0.15, -L * 0.42, 0, -L * 0.32);
  g.quadraticCurveTo(-w * 0.15, -L * 0.42, -w * 0.4, -L * 0.5);
  g.bezierCurveTo(-w * 1.05, -L * 0.25, -w * 0.9, L * 0.35, 0, L * 0.5);
  g.closePath();
}
function drawPetals(g, W, H) {
  const t = performance.now() / 1000;
  for (let i = 0; i < 16; i++) {
    const seed = (i * 0.618034) % 1, speed = 10 + seed * 14;
    const y = ((t * speed + seed * (H + 40)) % (H + 40)) - 20;
    const x = ((seed * 1.7 % 1) * W + Math.sin(t * 0.4 + i) * 30 + W) % W;
    const L = 13 + seed * 7, w = L * 0.55, a = 0.12 + seed * 0.12;
    g.save();
    g.translate(x, y);
    g.rotate(Math.sin(t * (0.5 + seed * 0.4) + i) * 1.2 + i);
    g.scale(0.35 + 0.65 * Math.abs(Math.cos(t * (0.7 + seed * 0.6) + i * 2)), 1); // tumbling
    const grad = g.createLinearGradient(0, L * 0.5, 0, -L * 0.5);
    grad.addColorStop(0, `rgba(236, 120, 160, ${a})`);
    grad.addColorStop(1, `rgba(255, 214, 228, ${a})`);
    g.fillStyle = grad;
    petalPath(g, L, w);
    g.fill();
    g.restore();
  }
}

// ---------------- timeline ----------------
// Zoomed in, the timeline shows part of the piece and scrolls to keep the playhead in view.
// Scrolling it by hand stops the following until playback starts or the playhead is moved.
var tlView = 0, tlManual = false;
const tlSpan = () => song.totalBeats / Math.max(1, +S.tlZoom || 1);
function updateTlView(t) {
  const span = tlSpan(), tot = song.totalBeats;
  if (span >= tot) { tlView = 0; return; }
  if (T.playing) tlManual = false;
  if (timelineDrag || tlManual) { tlView = Math.max(0, Math.min(tot - span, tlView)); return; }
  const p = Math.max(0, t);
  if (p < tlView || p > tlView + span * 0.85) tlView = p - span * 0.15;
  tlView = Math.max(0, Math.min(tot - span, tlView));
}
function drawTimeline(t) {
  const [g, W, H] = fit($('#timeline'));
  g.fillStyle = TH.css.panel;
  g.fillRect(0, 0, W, H);
  if (!song) return;
  const tot = song.totalBeats, bpb = song.bpb, bars = song.bars;
  if (!song.density) {
    song.density = new Array(bars).fill(0);
    for (const n of song.notes) song.density[Math.min(bars - 1, Math.floor(n.s / bpb))]++;
    song.densMax = Math.max(1, ...song.density);
  }
  updateTlView(t);
  const span = tlSpan(), X = b => (b - tlView) / span * W, bw = bpb / span * W;
  const first = Math.max(0, Math.floor(tlView / bpb)), last = Math.min(bars - 1, Math.ceil((tlView + span) / bpb));
  g.fillStyle = TH.fallBar;
  for (let i = first; i <= last; i++) { const h = (song.density[i] / song.densMax) * (H - 10); g.fillRect(X(i * bpb), H - h, Math.max(bw - 1, 1), h); }
  const r = timelineDrag && timelineDrag.range ? timelineDrag.range : range;
  if (r.start > 0 || r.end < tot) {
    g.fillStyle = HAND.L + '47';
    g.fillRect(X(r.start), 0, X(r.end) - X(r.start), H);
    g.fillStyle = HAND.L;
    g.fillRect(X(r.start), 0, 2, H);
    g.fillRect(X(r.end) - 2, 0, 2, H);
  }
  // bar numbers once bars are wide enough to aim at
  if (span < tot && bw >= 10) {
    const step = [1, 2, 4, 5, 10, 20].find(k => k * bw >= 26) || 50;
    g.font = '500 9px -apple-system, sans-serif';
    for (let i = first; i <= last; i++) {
      if (i % step) continue;
      g.fillStyle = TH.css.line; g.fillRect(X(i * bpb), 15, 1, H - 15);
      g.fillStyle = TH.css.dim; g.fillText(String(i + 1), X(i * bpb) + 3, 25);
    }
  }
  // sections: full name when it fits, else just the number; the section being played is highlighted
  const curSec = song.sections.find(s => t >= s.start && t < s.end);
  for (const s of song.sections) {
    if (X(s.end) < 0 || X(s.start) > W) continue;
    const x = Math.max(0, X(s.start)), w = X(s.end) - x - 6;
    const col = { learning: TH.accent, learned: TH.css.primary }[statusOf(s.name)];
    if (col) { g.fillStyle = col; g.fillRect(x + 1, H - 3, w + 5, 3); }
    const cur = s === curSec;
    g.fillStyle = TH.css.line;
    g.fillRect(X(s.start), 0, 1, H);
    g.font = (cur ? '700 ' : '500 ') + '10px -apple-system, sans-serif';
    g.fillStyle = cur ? TH.css.fg : TH.css.dim;
    const num = (/^(\d+)\s*·/.exec(s.name) || [])[1];
    let label = cur ? s.name : num || s.name;
    if (cur && measureMusic(g, label) > w) label = s.name.replace(/\s*\(.*\)\s*$/, '');
    while (label.length > 1 && measureMusic(g, label) > w) label = label.slice(0, -2) + '…';
    if (label && measureMusic(g, label) <= w) fillMusic(g, label, x + 4, 11);
  }
  g.fillStyle = ACCENT;
  for (const tag of notesTags) { const x = X((tag.from - 1) * bpb + bpb / 2); g.beginPath(); g.arc(x, H - 5, 3, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = HAND.R;
  g.fillRect(X(Math.max(0, t)) - 1, 0, 3, H);
  const zoomed = span < tot, sb = $('#tlScroll');
  if (sb.hidden === zoomed) sb.hidden = !zoomed;
  if (zoomed) {
    const th = $('#tlThumb'), l = (tlView / tot * 100).toFixed(2) + '%', w = (span / tot * 100).toFixed(2) + '%';
    if (th.style.left !== l) th.style.left = l;
    if (th.style.width !== w) th.style.width = w;
  }
}

// ---------------- hover / inspect ----------------
function hoverNotes(h) {
  if (h._cache && h._cache.key === h.gi + ':' + h.beat + ':' + S.handL + S.handR) return h._cache;
  const struck = h.gi != null ? song.groups[h.gi].notes.filter(visible) : [];
  const ss = new Set(struck), held = [];
  for (let i = lowerBound(song.notes, h.beat - song.maxDur); i < song.notes.length; i++) {
    const n = song.notes[i];
    if (n.s > h.beat + 1e-6) break;
    if (!ss.has(n) && visible(n) && n.s + n.d > h.beat + 1e-6) held.push(n);
  }
  h._cache = { key: h.gi + ':' + h.beat + ':' + S.handL + S.handR, struck, held };
  return h._cache;
}

function hitGroup(beat, tolBeats) {
  const gs = song.groups;
  const i = lowerBound(gs, beat, 'beat');
  let best = null, bd = Infinity;
  for (const j of [i - 2, i - 1, i, i + 1]) {
    const grp = gs[j];
    if (!grp || !grp.notes.some(visible)) continue;
    const d = Math.abs(grp.beat - beat);
    if (d < bd) { bd = d; best = j; }
  }
  return bd <= tolBeats ? best : null;
}

function inspectAt(src, clientX, clientY, pinned) {
  const stage = $('#stage').getBoundingClientRect();
  const cv = $(src === 'fall' ? '#fall' : '#score').getBoundingClientRect();
  const t = now();
  let beat, tol;
  if (src === 'fall') {
    const { ppb } = fallLayout(cv.height);
    beat = t + (cv.height - (clientY - cv.top)) / ppb;
    tol = (IS_TOUCH ? 22 : 12) / ppb;
  } else {
    const k = scoreScale(cv.height), L = scoreLayout(cv.width / k);
    const x = (clientX - cv.left) / k;
    if (x < L.clipX) return setHover(null);
    beat = t + (x - L.playX) / L.ppb;
    tol = (IS_TOUCH ? 18 : 10) / (L.ppb * k);
  }
  const gi = hitGroup(beat, tol);
  setHover({ beat: gi != null ? song.groups[gi].beat : beat, gi, x: clientX - stage.left, y: clientY - stage.top, src, pinned });
}

function setHover(h) {
  const prevKey = hover ? hover.gi + ':' + hover.beat.toFixed(3) + hover.pinned : '';
  hover = h;
  const tip = $('#tip');
  if (!h) { tip.hidden = true; return; }
  const key = h.gi + ':' + h.beat.toFixed(3) + h.pinned;
  if (key !== prevKey) tip.innerHTML = tipHtml(h);
  tip.hidden = false;
  const stage = $('#stage').getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = h.x + 16, y = h.y + 16;
  if (x + tw > stage.width - 8) x = h.x - tw - 16;
  if (y + th > stage.height - 150) y = h.y - th - 16;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function tipHtml(h) {
  const info = hoverNotes(h);
  const chip = (n, cls = '') => `<span class="chip ${cls || n.h}">${S.noteNames === 'name' ? n.sp.name : n.sp.nameOct}</span>`;
  const byPitch = arr => [...arr].sort((a, b) => a.m - b.m);
  let html = `<b>${fmtBeat(h.beat).text}</b>`;
  if (info.struck.length) {
    html += `<div class="row">${info.struck.length > 1 ? `<b>${info.struck.length} notes struck together</b>` : '<b>1 note struck</b>'}</div>
      <div class="chips">${byPitch(info.struck).map(n => chip(n)).join('')}</div>`;
  } else html += '<div class="row hint">No note starts exactly here.</div>';
  if (info.held.length) html += `<div class="row hint">Still held from before:</div><div class="chips">${byPitch(info.held).map(n => chip(n, 'held')).join('')}</div>`;
  const all = info.struck.concat(info.held);
  if (all.length >= 2) {
    const w = new Array(12).fill(0);
    all.forEach(n => { w[n.m % 12] += 1; });
    const lowest = all.reduce((a, n) => (n.m < a.m ? n : a));
    const ch = detectChord(w, lowest.m % 12);
    if (ch) { const lab = chordLabel(ch, song.speller, song.key); html += `<div class="row">Sounds like <b>${lab.name}</b> <span class="roman">${lab.roman}</span></div>`; }
  }
  if (h.pinned) html += `<div><button data-act="jump">Jump here</button> <button data-act="closetip" class="ghost">Close</button></div>`;
  else html += `<div class="row hint">Click to jump here</div>`;
  return html;
}

function bindInspect(sel, src) {
  const cv = $(sel);
  let down = null;
  cv.addEventListener('pointermove', e => {
    if (!song) return;
    if (e.pointerType === 'mouse' && !down) { inspectAt(src, e.clientX, e.clientY, false); return; }
    if (down && down.id === e.pointerId) inspectAt(src, e.clientX, e.clientY, true);
  });
  cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && hover && !hover.pinned) setHover(null); });
  cv.addEventListener('pointerdown', e => {
    if (!song) return;
    if (e.pointerType === 'mouse') {
      inspectAt(src, e.clientX, e.clientY, false);
      if (hover) { seek(hover.beat, false); }
      return;
    }
    down = { id: e.pointerId };
    cv.setPointerCapture(e.pointerId);
    inspectAt(src, e.clientX, e.clientY, true);
  });
  const end = e => { if (down && down.id === e.pointerId) down = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

// ---------------- side panel: chords ----------------
function miniKbdSvg(pcs, root) {
  if (!pcs) return '';
  // root-position voicing starting in the lower octave
  const tones = [];
  let prev = -1;
  for (const pc of pcs) { let m = pc; while (m <= prev) m += 12; tones.push(m); prev = m; }
  const start = 0, n = 24 + (tones[tones.length - 1] >= 24 ? 12 : 0);
  const whites = [], blacks = [];
  for (let m = start; m < start + n; m++) ([1, 3, 6, 8, 10].includes(m % 12) ? blacks : whites).push(m);
  const ww = 300 / whites.length, H = 70;
  const label = m => song.speller(m + 60).name;
  let svg = `<svg viewBox="0 0 300 ${H + 2}" xmlns="http://www.w3.org/2000/svg">`;
  const fillFor = m => tones.includes(m) ? (m % 12 === root ? TH.css.primary : HAND.R) : null;
  whites.forEach((m, i) => {
    const f = fillFor(m);
    svg += `<rect x="${i * ww}" y="0" width="${ww}" height="${H}" rx="3" fill="${f || '#f4f4f2'}" stroke="#222"/>`;
    if (f) svg += `<text x="${i * ww + ww / 2}" y="${H - 7}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${label(m)}</text>`;
  });
  blacks.forEach(m => {
    const wi = whites.filter(w => w < m).length;
    const x = wi * ww - ww * 0.31, f = fillFor(m);
    svg += `<rect x="${x}" y="0" width="${ww * 0.62}" height="${H * 0.6}" rx="2" fill="${f || '#1a1a1a'}" stroke="#000"/>`;
    if (f) svg += `<text x="${x + ww * 0.31}" y="${H * 0.6 - 5}" font-size="8" font-weight="700" fill="#fff" text-anchor="middle">${label(m)}</text>`;
  });
  return svg + '</svg>';
}

let lastChordUI = '';
function updateChordCards(t) {
  const ci = chordAt(t);
  let ni = ci >= 0 ? ci + 1 : lowerBound(song.chords, t, 'start');
  const key = ci + ':' + ni + ':' + S.noteNames;
  if (key === lastChordUI) return updateNextWhen(t, ni);
  lastChordUI = key;
  const c = song.chords[ci], nx = song.chords[ni];
  $('#cNowName').textContent = c ? c.name : '–';
  $('#cNowRoman').textContent = c ? c.roman : '';
  $('#cNowNotes').innerHTML = c ? c.pcs.map(pc => `<span class="chip ${pc === c.root ? 'root' : ''}">${song.speller(pc + 60).name}</span>`).join('') : '';
  $('#cNowKbd').innerHTML = c ? miniKbdSvg(c.pcs, c.root) : '';
  $('#cNextName').textContent = nx ? nx.name : '–';
  $('#cNextRoman').textContent = nx ? nx.roman : '';
  $('#cNextKbd').innerHTML = nx ? miniKbdSvg(nx.pcs, nx.root) : '';
  $('#nowChord').textContent = c ? c.name : '';
  updateNextWhen(t, ni);
}
function updateNextWhen(t, ni) {
  const nx = song.chords[ni];
  const el = $('#cNextWhen');
  const txt = nx ? `in ${Math.max(0, Math.ceil(nx.start - t - 1e-6))} beat${Math.ceil(nx.start - t - 1e-6) === 1 ? '' : 's'} · bar ${Math.floor(nx.start / song.bpb) + 1}` : '';
  if (el.textContent !== txt) el.textContent = txt;
}

function renderSheet() {
  const sheet = $('#sheet');
  const bpb = song.bpb;
  let html = '';
  const secStarts = new Map(song.sections.map(s => [Math.round(s.start / bpb), s.name]));
  let last = null;
  for (let b = 0; b < song.bars; b++) {
    if (secStarts.has(b) && song.namedSections) html += `<div class="sec">${escapeHtml(secStarts.get(b))}</div>`;
    const inBar = song.chords.filter(c => c.start >= b * bpb - 1e-6 && c.start < (b + 1) * bpb - 1e-6);
    let content;
    if (inBar.length) { content = inBar.map(c => c.name).join(' '); last = inBar[inBar.length - 1]; }
    else {
      const ci = chordAt(b * bpb);
      content = ci >= 0 ? `<span class="cont">${song.chords[ci].name}</span>` : '<span class="cont">·</span>';
    }
    html += `<div class="cell" data-bar="${b}"><span class="n">${b + 1}</span>${content}</div>`;
  }
  sheet.innerHTML = html;
  renderSheetState(true);
}
let lastSheetBar = -1;
function renderSheetState(force) {
  if (!song) return;
  const bar = Math.max(0, Math.floor(now() / song.bpb));
  if (!force && bar === lastSheetBar) return;
  const tagged = new Set();
  for (const tg of notesTags) for (let b = tg.from; b <= tg.to; b++) tagged.add(b - 1);
  $$('#sheet .cell').forEach(el => {
    const b = +el.dataset.bar;
    el.classList.toggle('cur', b === bar);
    el.classList.toggle('inrange', (range.start > 0 || range.end < song.totalBeats) && b * song.bpb >= range.start - 1e-6 && b * song.bpb < range.end - 1e-6);
    el.classList.toggle('tagged', tagged.has(b));
  });
  if (bar !== lastSheetBar && T.playing && S.tab === 'chords') {
    const cur = $(`#sheet .cell[data-bar="${bar}"]`);
    if (cur) {
      const box = $('#tab-chords').getBoundingClientRect(), r = cur.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  lastSheetBar = bar;
}

// ---------------- side panel: notes ----------------
let notesTags = [];
let notesSavedText = '';
const songId = () => (source ? source.id || source.title : '_');
const notesKey = () => 'pt.notes.' + songId();
const exportedKey = () => 'pt.notesx.' + songId();
let notesStoreOk = true;

// Notes live on this device (localStorage) and, when the local server is reachable, in a .txt file on the Mac.
let notesSync = { state: '', file: '', timer: null, title: '' };
const serverMode = location.protocol.startsWith('http');

function loadNotesForSong() {
  const local = store.get(notesKey()) || '';
  $('#notesText').value = local;
  notesSavedText = store.get(exportedKey()) ?? '';
  notesSync = { state: '', file: '', timer: null, title: song.title };
  onNotesChanged(false);
  if (serverMode) pullNotes(song.title, local);
}
async function pullNotes(title, local) {
  try {
    const r = await fetch('api/notes?song=' + encodeURIComponent(title), { cache: 'no-store' });
    if (!song || song.title !== title) return;
    if (r.status === 404) { if (local) pushNotes(title, local); else { notesSync.state = 'ready'; onNotesChanged(false); } return; }
    if (!r.ok) return;
    const txt = await r.text();
    if (txt !== $('#notesText').value) { $('#notesText').value = txt; store.set(notesKey(), txt); }
    notesSync.state = 'saved';
    notesSync.file = `notes/${title}.txt`;
    onNotesChanged(false);
  } catch (e) { /* server without notes support, or offline */ }
}
function scheduleNotesPush() {
  if (!notesSync.state) return; // server never answered: device-only mode
  clearTimeout(notesSync.timer);
  notesSync.state = 'pending';
  const title = notesSync.title;
  notesSync.timer = setTimeout(() => { notesSync.timer = null; pushNotes(title, $('#notesText').value); }, 700);
}
function flushNotes() {
  if (!notesSync.timer) return;
  clearTimeout(notesSync.timer);
  notesSync.timer = null;
  pushNotes(notesSync.title, $('#notesText').value);
}
async function pushNotes(title, txt) {
  let state;
  try {
    const r = await fetch('api/notes?song=' + encodeURIComponent(title), { method: 'PUT', body: txt });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (notesSync.title === title) notesSync.file = j.file;
    state = 'saved';
  } catch (e) { state = 'offline'; }
  if (notesSync.title === title && !notesSync.timer) { notesSync.state = state; onNotesChanged(false); }
}
function onNotesChanged(persist = true) {
  const txt = $('#notesText').value;
  if (persist) { notesStoreOk = store.set(notesKey(), txt); scheduleNotesPush(); }
  notesTags = [];
  const re = /\[\s*bars?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*\]/gi;
  for (const line of txt.split('\n')) {
    const rest = line.replace(re, '').trim();
    for (const m of line.matchAll(re)) {
      const from = +m[1], to = m[2] ? +m[2] : from;
      notesTags.push({ from: Math.min(from, to), to: Math.max(from, to), text: rest });
    }
  }
  const max = song ? song.bars : Infinity;
  notesTags = notesTags.filter(tg => tg.from >= 1 && tg.from <= max).map(tg => ({ ...tg, to: Math.min(tg.to, max) }));
  $('#tagList').innerHTML = notesTags.map((tg, i) =>
    `<button class="tagbtn" data-tag="${i}"><b>${tg.from === tg.to ? 'Bar ' + tg.from : `Bars ${tg.from}–${tg.to}`}</b>${escapeHtml(tg.text.slice(0, 90)) || '<span class="hint">(no text)</span>'}</button>`).join('');
  const sync = { saved: `Saved on your Mac: ${notesSync.file}`, pending: 'Saving to your Mac…', ready: 'Notes will be saved on your Mac as you type',
    offline: '⚠ Mac not reachable: kept on this device, will save to the Mac on your next edit' }[notesSync.state];
  if (sync && notesStoreOk) { $('#nStatus').textContent = sync; renderSheetState(true); return; }
  $('#nStatus').textContent = !notesStoreOk ? '⚠ NOT saved: storage on this device is full. Use Save / Share to keep a copy.'
    : !txt ? 'Kept on this device'
    : !notesSavedText ? 'Kept on this device · not exported yet'
    : txt === notesSavedText ? 'Kept on this device · exported copy is up to date'
    : 'Kept on this device · changes since last export';
  renderSheetState(true);
}
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function exportNotes() {
  const txt = $('#notesText').value;
  const name = `${song ? song.title : 'Piano'} - notes.txt`;
  const file = new File([txt], name, { type: 'text/plain' });
  const markSaved = () => { notesSavedText = txt; store.set(exportedKey(), txt); onNotesChanged(false); };
  if (IS_TOUCH && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); markSaved(); }
    catch (e) { if (e.name !== 'AbortError') toast('Sharing failed: ' + e.message); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  markSaved();
}
function insertTag() {
  const ta = $('#notesText');
  const bar = Math.max(1, Math.floor(now() / song.bpb) + 1);
  const custom = range.start > 0 || range.end < song.totalBeats;
  const a = Math.floor(range.start / song.bpb) + 1, b = Math.ceil(range.end / song.bpb);
  let tag = custom ? (a === b ? `[Bar ${a}] ` : `[Bars ${a}-${b}] `) : `[Bar ${bar}] `;
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  if (before && !before.endsWith('\n')) tag = '\n' + tag;
  ta.value = before + tag + ta.value.slice(ta.selectionEnd ?? pos);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = before.length + tag.length;
  onNotesChanged();
}

// ---------------- side panel: tracks + settings ----------------
function renderTracks() {
  const speller = song.speller;
  const opts = (v) => [['R', 'Right hand'], ['L', 'Left hand'], ['split', 'Split by pitch'], ['off', 'Ignore']]
    .map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  let html = raw.tracks.map((tr, i) => {
    let lo = 127, hi = 0;
    tr.notes.forEach(n => { lo = Math.min(lo, n.m); hi = Math.max(hi, n.m); });
    const a = assign[i];
    const col = a === 'L' ? HAND.L : a === 'R' ? HAND.R : a === 'split' ? `linear-gradient(${HAND.R}, ${HAND.L})` : '#444';
    return `<div class="track"><span class="sw" style="background:${col}"></span>
      <div><div class="name">${escapeHtml(tr.name)}</div><div class="meta">${tr.notes.length} notes · ${speller(lo).nameOct}–${speller(hi).nameOct}</div></div>
      <select data-track="${i}">${opts(a)}</select></div>`;
  }).join('');
  if (assign.includes('split')) {
    let o = '';
    for (let m = 48; m <= 72; m++) o += `<option value="${m}" ${m === splitPoint ? 'selected' : ''}>${speller(m).nameOct}${m === 60 ? ' (middle C)' : ''}</option>`;
    html += `<div class="form"><label>Split point: notes at or above go to the right hand <select id="splitSel">${o}</select></label></div>`;
  }
  $('#tracksBody').innerHTML = html;
}

function renderKeySelect() {
  const sel = $('#keySelect');
  let html = '<option value="auto">Automatic</option>';
  for (let sf = -7; sf <= 7; sf++) for (const mi of [0, 1]) html += `<option value="${sf},${mi}">${keyName({ sf, minor: !!mi })}</option>`;
  sel.innerHTML = html;
}

function renderSectionSelect() {
  const sel = $('#section');
  const opts = [wholeRange(), ...song.sections];
  const matches = s => Math.abs(s.start - range.start) < 1e-6 && Math.abs(s.end - range.end) < 1e-6;
  const mark = s => ({ learned: '✓ ', learning: '◐ ' }[statusOf(s.name)] || '');
  let html = opts.map((s, i) => `<option value="${i}">${i ? mark(s) : ''}${escapeHtml(s.name)}</option>`).join('');
  let idx = opts.findIndex(matches);
  if (idx < 0) { html += `<option value="custom">${escapeHtml(range.name || 'Custom range')}</option>`; idx = 'custom'; }
  sel.innerHTML = html;
  sel.value = idx;
}

// "Artist - Title (arrangement)" -> title "Title", artist "Artist".
function displayTitle(full) {
  let t = full.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim() || full;
  let artist = '';
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(t);
  if (m) { artist = m[1]; t = m[2]; }
  return { title: t, artist };
}

function renderHeader() {
  const d = song ? displayTitle(song.title) : null;
  $('#songTitle').textContent = d ? d.title : 'Piano Tutor';
  $('#songTitle').title = song ? song.title : '';
  $('#songMeta').textContent = song ? [d.artist, keyName(song.key), `${song.bars} bars`].filter(Boolean).join(' · ') : '';
  $$('.seg.hand').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', S['hand' + seg.dataset.hand] === b.dataset.v)));
  $('#loopBtn').classList.toggle('on', S.loop);
  updateTempoLabel();
}

function renderAll() {
  renderHeader();
  renderSectionSelect();
  renderSheet();
  renderTracks();
  lastChordUI = '';
  song.density = null;
}

function syncSettingsForm() {
  $$('[data-setting]').forEach(el => {
    const v = S[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
  showSettingValues();
}
function showSettingValues() {
  $$('[data-val]').forEach(el => {
    const k = el.dataset.val, v = +S[k];
    el.textContent = k === 'tlZoom' ? (v <= 1 ? 'Whole piece' : +v.toFixed(1) + '×') : Math.round(v * 100) + '%';
  });
}

function showTab(tab) {
  S.tab = tab; saveSettings();
  $$('.tabs button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tab').forEach(el => { el.hidden = el.id !== 'tab-' + tab; });
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------- events ----------------
const midiInput = $('#midiFile');
if (IS_IOS) midiInput.removeAttribute('accept'); // iOS greys out .mid files when filtering by type
$('#openMidi').addEventListener('click', () => midiInput.click());
midiInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) openMidiFile(f); e.target.value = ''; });
// MIDI library: files served from the app's midi/ folder, listed in midi/library.json
// Pieces opened on this device are kept in the browser cache, so they open without the Mac.
const PIECES = 'pt-pieces';
const pieceUrl = name => new URL('__pieces/' + encodeURIComponent(name), location.href).href;
async function savePiece(name, buf) {
  try { await (await caches.open(PIECES)).put(pieceUrl(name), new Response(buf, { headers: { 'Content-Type': 'audio/midi' } })); } catch (e) { /* no cache (plain http) */ }
}
async function localPieces() {
  try { return (await (await caches.open(PIECES)).keys()).map(r => decodeURIComponent(r.url.split('/__pieces/')[1])); } catch (e) { return []; }
}
const withTimeout = ms => (AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});

async function loadLibrary() {
  const [mac, local] = await Promise.all([
    fetch('midi/library.json', { cache: 'no-store', ...withTimeout(4000) }).then(r => (r.ok ? r.json() : null)).catch(() => null),
    localPieces(),
  ]);
  const byName = new Map(local.map(n => [n, { name: n, ipad: true }]));
  for (const f of Array.isArray(mac) ? mac : []) byName.set(f.name, { ...byName.get(f.name), name: f.name, mac: true });
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('#libBtn').hidden = $('#libBtn2').hidden = !list.length;
  $('#libHint').textContent = mac ? 'Pieces on your Mac and on this device' : 'Mac not reachable: pieces saved on this device';
  $('#libList').innerHTML = list.map((f, i) =>
    `<button class="libitem" data-i="${i}"><b>${escapeHtml(f.name.replace(/\.midi?$/i, ''))}</b><span class="badge${f.ipad ? ' on' : ''}">${f.ipad ? 'On this device' : 'On your Mac'}</span></button>`).join('');
  $('#libList').onclick = async e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const f = list[+b.dataset.i];
    $('#library').hidden = true;
    try {
      let r = null;
      if (f.mac) r = await fetch('midi/' + encodeURIComponent(f.name), withTimeout(6000)).catch(() => null);
      if ((!r || !r.ok) && f.ipad) r = await (await caches.open(PIECES)).match(pieceUrl(f.name));
      if (!r || !r.ok) throw new Error('Mac not reachable');
      await openMidiFile(new File([await r.blob()], f.name));
    } catch (err) { toast('Could not load ' + f.name + ': ' + err.message); }
  };
}
$('#libBtn').addEventListener('click', () => { $('#library').hidden = false; loadLibrary(); });
$('#library').addEventListener('click', e => { if (e.target.id === 'library' || e.target.dataset.act === 'closelib') $('#library').hidden = true; });
loadLibrary();
$('#demoBtn').addEventListener('click', () => { loadRaw(buildDemo(), { kind: 'demo', id: 'demo', title: 'J. S. Bach - Prelude in C major, BWV 846' }); });
$('#empty').addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'open') midiInput.click();
  if (act === 'demo') $('#demoBtn').click();
  if (act === 'lib') { $('#library').hidden = false; loadLibrary(); }
});
$('#play').addEventListener('click', () => (T.playing ? pause() : play()));
$('#restart').addEventListener('click', () => song && seek(range.start));
$('#tempo').addEventListener('input', e => setTempo(+e.target.value));
$('#slower').addEventListener('click', () => setTempo(Math.round(tempoFactor * 100) - 5));
$('#faster').addEventListener('click', () => setTempo(Math.round(tempoFactor * 100) + 5));
$('#loopBtn').addEventListener('click', () => { S.loop = !S.loop; saveSettings(); renderHeader(); });
$('#section').addEventListener('change', e => {
  if (e.target.value === 'custom') return;
  const i = +e.target.value;
  setRange(i === 0 ? null : song.sections[i - 1]);
  seek(range.start);
});
$$('.seg.hand').forEach(seg => seg.addEventListener('click', e => {
  const v = e.target.dataset.v;
  if (!v) return;
  setHandMode(seg.dataset.hand, v);
}));
function setHandMode(h, v) {
  S['hand' + h] = v; saveSettings(); renderHeader();
  if (hover) { hover._cache = null; setHover({ ...hover }); }
  keyState.clear();
  resync();
}
function applyView() {
  for (const v of ['both', 'sheet', 'keys']) document.body.classList.toggle('view-' + v, S.view === v);
  document.body.classList.toggle('focus', !!S.focus);
  $$('.seg.view button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  setHover(null);
  keyState.clear();
}
function setView(v) { S.view = v; saveSettings(); applyView(); }
function toggleFocus() { S.focus = !S.focus; saveSettings(); applyView(); }
$$('.seg.view').forEach(seg => seg.addEventListener('click', e => { if (e.target.dataset.view) setView(e.target.dataset.view); }));
$('#focusBtn').addEventListener('click', toggleFocus);
$('#fExit').addEventListener('click', toggleFocus);
$('#fPlay').addEventListener('click', () => (T.playing ? pause() : play()));
$('#sideBtn').addEventListener('click', () => {
  if (matchMedia('(max-width: 1100px)').matches) document.body.classList.toggle('sideopen');
  else { S.side = !S.side; saveSettings(); document.body.classList.toggle('noside', !S.side);
applyView(); }
});
$$('.tabs button[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#sideClose').addEventListener('click', () => document.body.classList.remove('sideopen'));
$('#stage').addEventListener('pointerdown', () => document.body.classList.remove('sideopen'), true);

$('#tip').addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'jump' && hover) { const b = hover.beat; setHover(null); seek(b, false); }
  if (act === 'closetip') setHover(null);
});
bindInspect('#fall', 'fall');
bindInspect('#score', 'score');

// on-screen keyboard (multi-touch)
const kbd = $('#kbd');
kbd.addEventListener('pointerdown', e => {
  const m = keyFromPoint(e.clientX, e.clientY);
  if (m === null) return;
  e.preventDefault();
  kbd.setPointerCapture(e.pointerId);
  pressKey(e.pointerId, m);
});
kbd.addEventListener('pointermove', e => {
  if (!pressed.has(e.pointerId)) return;
  const m = keyFromPoint(e.clientX, e.clientY);
  if (m !== null && m !== pressed.get(e.pointerId).m) { releaseKey(e.pointerId); pressKey(e.pointerId, m); }
});
['pointerup', 'pointercancel'].forEach(ev => kbd.addEventListener(ev, e => releaseKey(e.pointerId)));

// two-finger double tap anywhere = back to the start of the loop
let lastTwoFinger = 0;
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 2 || !song) return;
  const t = performance.now();
  if (t - lastTwoFinger < 450) {
    lastTwoFinger = 0;
    if (hover && hover.pinned) setHover(null);
    seek(range.start);
    toast('Back to the start of the loop');
  } else lastTwoFinger = t;
}, { capture: true, passive: true });

// timeline: tap = jump, drag = loop range, double tap = reset
let timelineDrag = null, lastTap = 0;
const tl = $('#timeline');
const tlBar = e => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(song.bars - 1, Math.floor((tlView + (e.clientX - r.left) / r.width * tlSpan()) / song.bpb))); };
tl.addEventListener('pointerdown', e => {
  if (!song) return;
  tl.setPointerCapture(e.pointerId);
  timelineDrag = { x: e.clientX, bar: tlBar(e), moved: false, range: null };
});
tl.addEventListener('pointermove', e => {
  if (!timelineDrag) return;
  if (Math.abs(e.clientX - timelineDrag.x) > 6) timelineDrag.moved = true;
  if (timelineDrag.moved) timelineDrag.range = barRange(timelineDrag.bar, tlBar(e));
});
tl.addEventListener('pointercancel', () => { timelineDrag = null; });
tl.addEventListener('pointerup', e => {
  if (!timelineDrag) return;
  const d = timelineDrag;
  timelineDrag = null;
  if (d.moved && d.range) { setRange(d.range); seek(range.start); return; }
  const tnow = Date.now();
  if (tnow - lastTap < 320) { setRange(null); lastTap = 0; return; }
  lastTap = tnow;
  const beat = d.bar * song.bpb;
  if (beat < range.start || beat >= range.end) setRange(null);
  seek(beat);
});

// navigation bar scrollbar: drag the thumb, or tap the track to jump there
const tlScroll = $('#tlScroll');
let scrollDrag = null;
function scrollTo(e) {
  const r = tlScroll.getBoundingClientRect(), tot = song.totalBeats, span = tlSpan();
  tlView = Math.max(0, Math.min(tot - span, (e.clientX - r.left - scrollDrag.grab) / r.width * tot));
  tlManual = true;
}
tlScroll.addEventListener('pointerdown', e => {
  if (!song) return;
  tlScroll.setPointerCapture(e.pointerId);
  const r = tlScroll.getBoundingClientRect(), tx = r.left + tlView / song.totalBeats * r.width, tw = tlSpan() / song.totalBeats * r.width;
  // grabbing the thumb keeps the grab point; tapping the track centres the thumb there
  scrollDrag = { grab: e.clientX >= tx && e.clientX <= tx + tw ? e.clientX - tx : tw / 2 };
  tlScroll.classList.add('drag');
  scrollTo(e);
});
tlScroll.addEventListener('pointermove', e => { if (scrollDrag) scrollTo(e); });
for (const ev of ['pointerup', 'pointercancel']) tlScroll.addEventListener(ev, () => { scrollDrag = null; tlScroll.classList.remove('drag'); });

// chord sheet: tap = jump, shift-click / long-press = loop from current range start (or current bar) to here
let sheetPress = null;
$('#sheet').addEventListener('pointerdown', e => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const bar = +cell.dataset.bar;
  if (sheetPress) clearTimeout(sheetPress.timer);
  sheetPress = { bar, long: false, timer: setTimeout(() => { sheetPress.long = true; loopTo(bar); }, 500) };
});
$('#sheet').addEventListener('pointerup', e => {
  if (!sheetPress) return;
  clearTimeout(sheetPress.timer);
  const { bar, long } = sheetPress;
  sheetPress = null;
  if (long) return;
  if (e.shiftKey) return loopTo(bar);
  const beat = bar * song.bpb;
  if (beat < range.start || beat >= range.end) setRange(null);
  seek(beat);
});
$('#sheet').addEventListener('pointercancel', () => { if (sheetPress) clearTimeout(sheetPress.timer); sheetPress = null; });
$('#sheet').addEventListener('contextmenu', e => e.preventDefault());
function loopTo(bar) {
  const custom = range.start > 0 || range.end < song.totalBeats;
  const anchor = custom ? Math.floor(range.start / song.bpb) : Math.max(0, Math.floor(now() / song.bpb));
  setRange(barRange(anchor, bar));
  seek(range.start);
  toast(`Looping ${range.name}`);
}

// notes
$('#notesText').addEventListener('input', () => onNotesChanged());
$('#nTag').addEventListener('click', () => song && insertTag());
$('#nSave').addEventListener('click', exportNotes);
$('#nNew').addEventListener('click', () => {
  if ($('#notesText').value && !confirm('Clear the notes for this piece?')) return;
  $('#notesText').value = ''; onNotesChanged();
});
$('#nOpen').addEventListener('click', () => $('#notesFile').click());
$('#notesFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const txt = await f.text();
  const cur = $('#notesText').value;
  if (cur && cur !== txt && !confirm(`Replace the current notes with “${f.name}”?`)) return;
  $('#notesText').value = txt;
  notesSavedText = txt;
  store.set(exportedKey(), txt);
  onNotesChanged();
  toast(`Opened ${f.name}`);
});
$('#tagList').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]');
  if (!b || !song) return;
  const tg = notesTags[+b.dataset.tag];
  if (tg.from === tg.to) { const beat = (tg.from - 1) * song.bpb; if (beat < range.start || beat >= range.end) setRange(null); seek(beat); }
  else { setRange(barRange(tg.from - 1, tg.to - 1)); seek(range.start); }
});

// tracks
$('#tracksBody').addEventListener('change', e => {
  if (e.target.dataset.track !== undefined) assign[+e.target.dataset.track] = e.target.value;
  else if (e.target.id === 'splitSel') splitPoint = +e.target.value;
  else return;
  savePrefs();
  rebuild();
});

// settings
$$('[data-setting]').forEach(el => el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
  const k = el.dataset.setting;
  S[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
  saveSettings();
  showSettingValues();
  if (k === 'volume') Synth.setVolume(S.volume);
  if (k === 'theme') setTheme(S.theme);
  if (song && (k === 'key' || k === 'chordRes' || k === 'pedal')) rebuild();
  if (k === 'noteNames') { keyState.clear(); lastChordUI = ''; }
}));

// keyboard shortcuts
window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || !song || e.metaKey || e.ctrlKey || e.altKey) return;
  const bpb = song.bpb;
  if (e.code === 'Space') { e.preventDefault(); T.playing ? pause() : play(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seek(Math.min(range.end - bpb, Math.floor(now() / bpb + 1e-6) * bpb + bpb), false); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(Math.max(range.start, Math.ceil(now() / bpb - 0.25) * bpb - bpb), false); }
  else if (e.code === 'Home') { e.preventDefault(); seek(range.start); }
  else if (e.key === '[') setTempo(Math.round(tempoFactor * 100) - 5);
  else if (e.key === ']') setTempo(Math.round(tempoFactor * 100) + 5);
  else if (e.key === 'l' || e.key === 'r') {
    const h = e.key.toUpperCase(), order = ['play', 'mute', 'hide'];
    setHandMode(h, order[(order.indexOf(S['hand' + h]) + 1) % 3]);
  } else if (e.key === 'v') {
    const order = ['both', 'sheet', 'keys'];
    setView(order[(order.indexOf(S.view) + 1) % 3]);
  } else if (e.key === 'f') toggleFocus();
  else if (e.key === 'Escape') { if (S.focus) toggleFocus(); else setHover(null); }
});

// drag & drop (desktop)
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openMidiFile(f);
});

// iOS unlocks audio on touchend/click rather than pointerdown
['touchend', 'click'].forEach(ev => document.addEventListener(ev, () => { if (Synth.ctx) Synth.init(); }, { passive: true }));
kbd.addEventListener('pointerup', () => Synth.init());

// pause when the app goes to the background (iPad home button / app switcher)
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ---------------- main loop ----------------
let lastStatus = '';
function frame() {
  requestAnimationFrame(frame);
  try { drawFrame(); } catch (e) { console.error(e); }
}
function drawFrame() {
  if (song) {
    if (T.playing) schedule();
    const t = now();
    tickPractice(t);
    if (S.view !== 'keys') drawScore(t);
    if (S.view !== 'sheet') { drawFall(t); updateKeys(t); }
    updateChordCards(t);
    renderSheetState(false);
    const st = t < 0 ? 'Count-in' : `${fmtBeat(Math.min(t, song.totalBeats - 1e-6)).text} / ${song.bars}`;
    if (st !== lastStatus) {
      $('#nowBar').textContent = st; lastStatus = st; updateTempoLabel();
      $('#fBar').textContent = t < 0 ? 'Count-in' : `Bar ${fmtBeat(Math.min(t, song.totalBeats - 1e-6)).bar}`;
    }
    const fc = $('#nowChord').textContent;
    if ($('#fChord').textContent !== fc) $('#fChord').textContent = fc;
    if (hover && hover.pinned === false && T.playing) setHover(null);
  }
  drawTimeline(now());
}

// ---------------- progress: section status + practice time ----------------
// Stored per piece on this device and, via the server, in progress/<title>.json on the Mac.
const STATUS_ORDER = ['new', 'learning', 'learned'];
const STATUS_LABEL = { new: 'New', learning: 'Learning', learned: 'Learned' };
const emptyProgress = () => ({ status: {}, log: {} });
let prog = emptyProgress(), progTitle = '', progDirty = false, progState = '', lastTick = 0;
const progKey = () => 'pt.progress.' + songId();
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const statusOf = name => { const s = prog.status[name] && prog.status[name].s; return STATUS_ORDER.includes(s) ? s : 'new'; };
const sectionAt = t => { const s = song.sections.find(x => t >= x.start && t < x.end); return s ? s.name : 'Outside sections'; };
function fmtMin(sec) {
  const m = Math.round(sec / 60);
  if (sec > 0 && m < 1) return '<1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function loadProgress() {
  saveProgress();
  progTitle = song.title;
  try { prog = { ...emptyProgress(), ...JSON.parse(store.get(progKey()) || '{}') }; } catch (e) { prog = emptyProgress(); }
  progState = '';
  renderProgress();
  if (serverMode) pullProgress(progTitle);
}
// Both copies only ever grow (time) or carry a timestamp (status), so merging is safe in any order.
function mergeProgress(a, b) {
  // b may come from the server, which anything on the network can write: copy only plain data.
  const own = o => (o && typeof o === 'object' ? Object.entries(o).filter(([k]) => k !== '__proto__') : []);
  const out = { status: Object.create(null), log: Object.create(null) };
  for (const src of [a.status, b.status]) for (const [k, v] of own(src)) {
    if (v && STATUS_ORDER.includes(v.s) && typeof v.at === 'number' && (!out.status[k] || v.at > out.status[k].at)) out.status[k] = { s: v.s, at: v.at };
  }
  for (const src of [a.log, b.log]) for (const [d, secs] of own(src)) {
    const o = out.log[d] || (out.log[d] = Object.create(null));
    for (const [k, v] of own(secs)) if (typeof v === 'number' && v >= 0) o[k] = Math.max(o[k] || 0, v);
  }
  return out;
}
async function pullProgress(title) {
  try {
    const r = await fetch('api/progress?song=' + encodeURIComponent(title), { cache: 'no-store' });
    if (progTitle !== title) return;
    if (r.ok) prog = mergeProgress(await r.json(), prog);
    else if (r.status !== 404) return;
    progState = 'ready';
    store.set(progKey(), JSON.stringify(prog));
    pushProgress(title);
    renderProgress();
  } catch (e) { /* offline: device only */ }
}
async function pushProgress(title) {
  try {
    const r = await fetch('api/progress?song=' + encodeURIComponent(title), { method: 'PUT', body: JSON.stringify(prog) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (progTitle === title) progState = 'saved';
  } catch (e) { if (progTitle === title) progState = 'offline'; }
  renderProgressStatus();
}
function saveProgress() {
  if (!progDirty || !song) return;
  progDirty = false;
  store.set(progKey(), JSON.stringify(prog));
  if (progState) pushProgress(progTitle);
  renderProgress();
}
setInterval(saveProgress, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(); });

// Called every frame: while playing, add the elapsed time to today's total for the current section.
function tickPractice(t) {
  const ms = performance.now(), dt = (ms - lastTick) / 1000;
  lastTick = ms;
  if (!T.playing || t < 0 || dt > 1) return; // dt > 1: the app was in the background
  const day = prog.log[dayKey(new Date())] || (prog.log[dayKey(new Date())] = {});
  const name = sectionAt(Math.max(t, range.start)); // playback starts a hair before the range
  day[name] = (day[name] || 0) + dt;
  progDirty = true;
}

function setStatus(name, s) {
  prog.status[name] = { s, at: Date.now() };
  progDirty = true;
  saveProgress();
  renderSectionSelect();
}

function renderProgressStatus() {
  $('#pStatus').textContent = { saved: `Saved on your Mac: progress/${progTitle}.json`, offline: 'Mac not reachable: saved on this device for now', ready: 'Saved on your Mac as you practise' }[progState] || 'Saved on this device';
}
function renderProgress() {
  if (!song) return;
  const days = [], today = new Date();
  for (let i = 13; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(d); }
  const total = d => Object.values(prog.log[dayKey(d)] || {}).reduce((a, b) => a + b, 0);
  const secs = days.map(total), max = Math.max(60, ...secs);
  $('#pDays').innerHTML = days.map((d, i) =>
    `<div class="pday${i === 13 ? ' today' : ''}" title="${d.toDateString()}: ${fmtMin(secs[i])}">
      <div class="bar${secs[i] ? '' : ' zero'}" style="height:${Math.max(2, secs[i] / max * 70)}px"></div>
      <span class="d">${'SMTWTFS'[d.getDay()]}</span></div>`).join('');
  const perSection = {}; let all = 0;
  for (const secsByName of Object.values(prog.log)) for (const [k, v] of Object.entries(secsByName)) { perSection[k] = (perSection[k] || 0) + v; all += v; }
  const week = secs.slice(7).reduce((a, b) => a + b, 0);
  const learned = song.sections.filter(s => statusOf(s.name) === 'learned').length;
  $('#pSummary').textContent = `today ${fmtMin(secs[13])} · last 7 days ${fmtMin(week)} · total ${fmtMin(all)} · ${learned}/${song.sections.length} sections learned`;
  const lastDay = name => { const ds = Object.keys(prog.log).filter(d => prog.log[d][name] >= 30).sort(); return ds.length ? ds[ds.length - 1] : null; };
  const cur = song.sections.find(s => Math.abs(s.start - range.start) < 1e-6 && Math.abs(s.end - range.end) < 1e-6);
  $('#pSections').innerHTML = song.sections.map((s, i) => {
    const st = statusOf(s.name), ld = lastDay(s.name);
    const meta = perSection[s.name] ? `${fmtMin(perSection[s.name])} practised${ld ? ' · last ' + new Date(ld + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}` : 'not practised yet';
    return `<div class="prow${s === cur ? ' cur' : ''}"><button class="pname" data-sec="${i}">${escapeHtml(s.name)}<span class="hint">${meta}</span></button>
      <button class="pstat s-${st}" data-stat="${i}">${STATUS_LABEL[st]}</button></div>`;
  }).join('');
  renderProgressStatus();
}
$('#pSections').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !song) return;
  if (b.dataset.stat) {
    const s = song.sections[+b.dataset.stat], st = statusOf(s.name);
    setStatus(s.name, STATUS_ORDER[(STATUS_ORDER.indexOf(st) + 1) % 3]);
  } else if (b.dataset.sec) {
    setRange(song.sections[+b.dataset.sec]);
    seek(range.start);
    renderProgress();
  }
});

// ---------------- icons ----------------
const svg = body => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  play: svg('<path class="f" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: svg('<rect class="f" x="6" y="5" width="4.5" height="14" rx="1.2"/><rect class="f" x="13.5" y="5" width="4.5" height="14" rx="1.2"/>'),
  restart: svg('<path d="M6 5v14"/><path class="f" d="M19 6.2v11.6a.8.8 0 0 1-1.25.66L9.6 12.66a.8.8 0 0 1 0-1.32l8.15-5.8A.8.8 0 0 1 19 6.2z"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  sidebar: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  loop: svg('<path d="M17 3l3 3-3 3"/><path d="M4 11.5V10a4 4 0 0 1 4-4h12"/><path d="M7 21l-3-3 3-3"/><path d="M20 12.5V14a4 4 0 0 1-4 4H4"/>'),
  chevron: svg('<path d="M7 10l5 5 5-5"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  library: svg('<path d="M4 19V5M9 19V5M14 19l-2-14M17 5l3 14"/>'),
  music: svg('<circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="15" r="2.5"/><path d="M9.5 17V6l10-2v11"/>'),
};
$$('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', ICON[el.dataset.icon]));

// Pieces menu (open a file, library, demo)
const piecesMenu = $('#piecesMenu');
$('#piecesBtn').addEventListener('click', e => { e.stopPropagation(); piecesMenu.hidden = !piecesMenu.hidden; if (!piecesMenu.hidden) loadLibrary(); });
document.addEventListener('pointerdown', e => { if (!piecesMenu.hidden && !e.target.closest('.pieces')) piecesMenu.hidden = true; });
piecesMenu.addEventListener('click', e => { if (e.target.closest('button')) piecesMenu.hidden = true; });

// ---------------- boot ----------------
$('#themeSelect').innerHTML = Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
setTheme(S.theme);
renderKeySelect();
syncSettingsForm();
showTab(S.tab);
document.body.classList.toggle('noside', !S.side);
setTempo(100);
updatePlayButton();
try {
  const last = JSON.parse(store.get('pt.last') || 'null');
  if (last && last.kind === 'demo') loadRaw(buildDemo(), { kind: 'demo', id: 'demo', title: 'J. S. Bach - Prelude in C major, BWV 846' });
  else if (last && last.b64) loadRaw(parseMidiFile(fromB64(last.b64)), last);
} catch (e) { console.warn('Could not restore last song', e); }
document.fonts && document.fonts.load('48px Bravura');
// Offline copy of the app (sw.js). Needs the https address; on plain http the app simply runs live.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline mode unavailable', e));
  navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'updated') toast('Piano Tutor was updated: close and reopen it to use the new version'); });
}
requestAnimationFrame(frame);
