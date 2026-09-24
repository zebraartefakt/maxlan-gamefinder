'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BRAND = {
  appName: 'LAN Gamefinder',
  eventName: '',
  tagline: 'Finde Mitspieler für deine nächste Runde.',
  websiteUrl: '',
  publicUrl: '',
  logo: '',
  favicon: '',
  eventStart: '',
  eventEnd: '',
  seatHint: 'z.B. B12',
  colors: {
    bg: '#0b0d12',
    surface: '#151923',
    surface2: '#1c2130',
    border: '#2a3042',
    text: '#e8eaf2',
    muted: '#8b93a8',
    accent: '#7c5cff',
    accent2: '#9b85ff',
    accentText: '#ffffff',
    ok: '#35d49a',
    warn: '#ffb547',
    danger: '#ff5c7a',
  },
};

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Lädt das Branding aus einem Ordner mit `brand.json` (und optional `games.json`
 * sowie Bilddateien). Fehlende Werte werden mit Standardwerten aufgefüllt.
 */
function loadBrand(dir) {
  const brand = structuredClone(DEFAULT_BRAND);
  let games = [];
  if (dir) {
    const file = path.join(dir, 'brand.json');
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of Object.keys(DEFAULT_BRAND)) {
        if (key === 'colors' || raw[key] === undefined) continue;
        brand[key] = String(raw[key]);
      }
      for (const [key, value] of Object.entries(raw.colors || {})) {
        if (!(key in brand.colors)) continue;
        if (!COLOR_RE.test(value)) throw new Error(`brand.json: ungültige Farbe für "${key}": ${value}`);
        brand.colors[key] = value;
      }
    }
    for (const key of ['eventStart', 'eventEnd']) {
      if (brand[key] && !DATE_RE.test(brand[key])) throw new Error(`brand.json: ${key} muss JJJJ-MM-TT sein.`);
    }
    for (const key of ['logo', 'favicon']) {
      if (brand[key] && !fs.existsSync(path.join(dir, brand[key]))) {
        console.warn(`Branding: Datei für "${key}" nicht gefunden: ${brand[key]}`);
        brand[key] = '';
      }
    }
    const gamesFile = path.join(dir, 'games.json');
    if (fs.existsSync(gamesFile)) games = JSON.parse(fs.readFileSync(gamesFile, 'utf8'));
  }
  if (process.env.PUBLIC_URL) brand.publicUrl = process.env.PUBLIC_URL;

  const asset = (f) => (f ? `/brand/${f.split('/').map(encodeURIComponent).join('/')}` : '');
  const publicBrand = {
    ...brand,
    logo: asset(brand.logo),
    favicon: asset(brand.favicon) || '/icon.svg',
    title: brand.eventName ? `${brand.appName} · ${brand.eventName}` : brand.appName,
  };

  const css = `:root {\n${Object.entries(brand.colors)
    .map(([k, v]) => `  --${k.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`)}: ${v};`)
    .join('\n')}\n}\n`;

  /** Ersetzt Platzhalter in den HTML-Seiten, damit Titel/Icon ohne Flackern stimmen. */
  function renderHtml(html) {
    return html
      .replaceAll('%TITLE%', escapeHtml(publicBrand.title))
      .replaceAll('%APP_NAME%', escapeHtml(brand.appName))
      .replaceAll('%FAVICON%', escapeHtml(publicBrand.favicon))
      .replaceAll('%THEME_COLOR%', escapeHtml(brand.colors.bg));
  }

  return { dir, brand: publicBrand, games, css, renderHtml };
}

module.exports = { loadBrand, DEFAULT_BRAND };
