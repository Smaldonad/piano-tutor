'use strict';
// Colour themes. UI colours are CSS variables; canvas colours are read from TH at draw time.
// onPrimary / onLh / onRh: text colour on buttons and notes of that colour (white unless set).

const THEMES = {
  classic: {
    name: 'Classic dark',
    css: { bg: '#14161b', panel: '#1b1e25', panel2: '#232731', line: '#2e333e', fg: '#e9eaee', dim: '#9097a3', faint: '#5d6470', primary: '#2f6fe0', primaryLine: '#3d7df0' },
    lh: '#4f8ff7', rh: '#f59e42', accent: '#ffd54a',
    fallBg: '#14161b', fallBlack: '#181b21', fallLine: '#20242b', fallBar: '#30353f', label: '#c4c8d0', labelBg: 'rgba(20,22,27,0.85)',
    paper: '#fbfaf6', ink: '#2a2a2a', inkDim: '#999', darkPaper: false,
  },
  fire: {
    name: 'Fire',
    css: { bg: '#15110f', panel: '#1d1714', panel2: '#271f1a', line: '#3a2e27', fg: '#f7efe9', dim: '#b3a499', faint: '#75675d', primary: '#e8641c', primaryLine: '#ff7a33' },
    lh: '#6fa8ff', rh: '#ff8a2b', accent: '#ffd166',
    fallBg: '#15110f', fallBlack: '#1a1512', fallLine: '#231c18', fallBar: '#3a2e27', label: '#efdfd4', labelBg: 'rgba(21,17,15,0.88)',
    paper: '#1d1714', ink: '#efdfd4', inkDim: '#85766b', darkPaper: true,
  },
  sakura: {
    name: 'Sakura night',
    css: { bg: '#1a1220', panel: '#22182a', panel2: '#2d2036', line: '#3e2d4a', fg: '#f7e8f0', dim: '#b89fb3', faint: '#7a6377', primary: '#d6608e', primaryLine: '#e877a3' },
    lh: '#a99cff', rh: '#ff8fb5', accent: '#ffd6e3',
    fallBg: '#1a1220', fallBlack: '#1f1626', fallLine: '#271c30', fallBar: '#3a2a45', label: '#f2d7e4', labelBg: 'rgba(26,18,32,0.86)',
    paper: '#201726', ink: '#f1d9e5', inkDim: '#8f7690', darkPaper: true, petals: true,
  },
  neonPink: {
    name: 'Neon city pink',
    css: { bg: '#161b41', panel: '#1c2150', panel2: '#3b2f82', line: '#573579', fg: '#f4efff', dim: '#aaa6d8', faint: '#6c69a3', primary: '#e0247c', primaryLine: '#ff3d93' },
    lh: '#3fe0ff', rh: '#ff3d9a', accent: '#c9a2ff', onLh: '#161b41',
    fallBg: '#161b41', fallBlack: '#1b1f4b', fallLine: '#232659', fallBar: '#3b2f82', label: '#f2e2ff', labelBg: 'rgba(22,27,65,0.88)',
    paper: '#1c2150', ink: '#f2e2ff', inkDim: '#8a85bd', darkPaper: true,
  },
  neonPinkDark: {
    name: 'Neon city pink (darker)',
    css: { bg: '#100b20', panel: '#18112e', panel2: '#22183f', line: '#3a2b63', fg: '#f6eaff', dim: '#ab9ccc', faint: '#6c5f8f', primary: '#e0247c', primaryLine: '#ff3d93' },
    lh: '#3fe0ff', rh: '#ff3d9a', accent: '#c9a2ff', onLh: '#100b20',
    fallBg: '#100b20', fallBlack: '#150f29', fallLine: '#1f1738', fallBar: '#3a2b63', label: '#f2e2ff', labelBg: 'rgba(16,11,32,0.88)',
    paper: '#18112e', ink: '#f2e2ff', inkDim: '#8475a8', darkPaper: true,
  },
  neonDeep: {
    name: 'Neon city deep',
    css: { bg: '#05080f', panel: '#0a111d', panel2: '#101b2c', line: '#1d3048', fg: '#e8fbff', dim: '#8aa6b8', faint: '#4d6577', primary: '#f8e602', primaryLine: '#fff35c' },
    lh: '#00f0ff', rh: '#f8e602', accent: '#ff2a7f', onPrimary: '#05080f', onLh: '#05080f', onRh: '#05080f',
    fallBg: '#05080f', fallBlack: '#080d17', fallLine: '#0e1726', fallBar: '#1d3048', label: '#e8fbff', labelBg: 'rgba(5,8,15,0.88)',
    paper: '#0a111d', ink: '#e8fbff', inkDim: '#5f7a8c', darkPaper: true,
  },
};

const TH = { ...THEMES.classic };

function applyTheme(key) {
  const t = THEMES[key] || THEMES.classic;
  Object.assign(TH, { petals: false, onPrimary: '#fff', onLh: '#fff', onRh: '#fff' }, t);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(t.css)) root.setProperty('--' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v);
  root.setProperty('--lh', t.lh);
  root.setProperty('--rh', t.rh);
  root.setProperty('--accent', t.accent);
  root.setProperty('--on-primary', TH.onPrimary);
  root.setProperty('--on-lh', TH.onLh);
  root.setProperty('--on-rh', TH.onRh);
  root.setProperty('--paper', t.paper);
  document.body.classList.toggle('paper-dark', t.darkPaper);
  document.querySelector('meta[name=theme-color]').setAttribute('content', t.css.bg);
}
