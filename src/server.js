'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { openDatabase } = require('./db');
const { loadBrand } = require('./brand');

const LIMITS = { nickname: 24, seat: 16, game: 60, description: 300, message: 500 };
const ROUND_VISIBLE_AFTER_START_MS = 12 * 60 * 60 * 1000;
const CHAT_MIN_INTERVAL_MS = 400;
const BOARD_PAST_MS = 3 * 60 * 60 * 1000;
/** Wie weit eine Startzeit in der Vergangenheit liegen darf (um eine gerade gestartete Runde nachzutragen). */
const PAST_TOLERANCE_MS = 60 * 60 * 1000;
const COVER_MAX_BYTES = 4 * 1024 * 1024;
const steamHeader = (appId) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
const COVER_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HTML_PAGES = { '/': 'index.html', '/index.html': 'index.html', '/beamer': 'beamer.html', '/aushang': 'aushang.html' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanText(value, max, { required = false, field = 'Feld' } = {}) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (required && !text) throw new HttpError(400, `${field} darf nicht leer sein.`);
  if (text.length > max) throw new HttpError(400, `${field} darf höchstens ${max} Zeichen lang sein.`);
  return text;
}

function parseRoundInput(body, { previousStartsAt = null } = {}) {
  const game = cleanText(body.game, LIMITS.game, { required: true, field: 'Spiel' });
  const description = cleanText(body.description, LIMITS.description, { field: 'Beschreibung' });
  const startsAt = Number(body.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= 0) throw new HttpError(400, 'Ungültige Startzeit.');
  // Beim Bearbeiten darf eine bereits vergangene Startzeit unverändert bleiben
  // (z.B. um die Beschreibung einer laufenden Runde zu ändern), aber nicht neu gesetzt werden.
  const unchanged = previousStartsAt !== null && Math.floor(startsAt / 60000) === Math.floor(previousStartsAt / 60000);
  if (!unchanged && startsAt < Date.now() - PAST_TOLERANCE_MS) {
    throw new HttpError(400, 'Die Startzeit liegt in der Vergangenheit.');
  }
  let maxPlayers = null;
  if (body.maxPlayers !== undefined && body.maxPlayers !== null && body.maxPlayers !== '') {
    maxPlayers = Number(body.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 256) {
      throw new HttpError(400, 'Max. Spieler muss zwischen 2 und 256 liegen.');
    }
  }
  return { game, description, startsAt, maxPlayers };
}

function parseGameInput(body) {
  const name = cleanText(body.name, LIMITS.game, { required: true, field: 'Name' });
  let maxPlayers = null;
  if (body.maxPlayers !== undefined && body.maxPlayers !== null && body.maxPlayers !== '') {
    maxPlayers = Number(body.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 256) {
      throw new HttpError(400, 'Max. Spieler muss zwischen 2 und 256 liegen.');
    }
  }
  const cover = cleanText(body.cover, 500, { field: 'Cover' });
  if (cover && !/^(\/brand\/|\/covers\/|https?:\/\/)/.test(cover)) {
    throw new HttpError(400, 'Cover muss eine http(s)-Adresse oder hochgeladene Datei sein.');
  }
  return { name, maxPlayers, cover };
}

/**
 * Versionskennung der ausgelieferten Oberfläche: Hash über alle Dateien in public/ und das
 * Branding. Ändert sich etwas davon, laden offene Beamer-Ansichten sich selbst neu.
 */
function computeVersion(brand) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(entry.name).update(fs.readFileSync(full));
    }
  };
  walk(PUBLIC_DIR);
  hash.update(JSON.stringify(brand.brand)).update(brand.css);
  return hash.digest('hex').slice(0, 12);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createApp({
  dbFile = ':memory:',
  dataDir = null,
  brandDir = null,
  adminPassword = '',
  publicBoard = true,
  autoCacheCovers = false,
  tls = null,
} = {}) {
  const store = openDatabase(dbFile);
  const brand = loadBrand(brandDir);
  const coverDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gamefinder-')), 'covers');
  fs.mkdirSync(coverDir, { recursive: true });

  // Spieleliste aus dem Branding übernehmen: bei jeder Änderung von games.json werden
  // fehlende Spiele ergänzt und fehlende Cover nachgetragen, bestehende Einträge bleiben.
  const seedHash = crypto.createHash('sha256').update(JSON.stringify(brand.games)).digest('hex');
  if (store.getMeta('games_seed_hash') !== seedHash) {
    const existing = new Map(store.listGames().map((g) => [g.name.toLowerCase(), g]));
    for (const g of brand.games) {
      try {
        const input = parseGameInput({ ...g, cover: g.cover || (g.steamAppId ? steamHeader(Number(g.steamAppId)) : '') });
        const old = existing.get(input.name.toLowerCase());
        if (!old) store.createGame(input);
        else if (!old.cover && input.cover) store.updateGame(old.id, { ...old, cover: input.cover });
      } catch (e) {
        console.warn(`games.json: ${g && g.name}: ${e.message}`);
      }
    }
    store.setMeta('games_seed_hash', seedHash);
  }

  const version = computeVersion(brand);

  const pages = {};
  function page(file) {
    if (!pages[file]) pages[file] = brand.renderHtml(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
    return pages[file];
  }

  const app = express();
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const io = new Server(server);

  /** userId -> number of open sockets */
  const online = new Map();
  /** userId -> timestamp of last chat message */
  const lastChat = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  for (const [route, file] of Object.entries(HTML_PAGES)) {
    app.get(route, (_req, res) => res.type('html').set('cache-control', 'no-cache').send(page(file)));
  }
  app.get('/brand.css', (_req, res) => res.type('css').set('cache-control', 'no-cache').send(brand.css));
  if (brandDir) app.use('/brand', express.static(brandDir, { dotfiles: 'ignore', index: false }));
  app.use('/covers', express.static(coverDir, {
    index: false,
    setHeaders: (res) => res.set('content-security-policy', "default-src 'none'"),
  }));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  const api = express.Router();

  function auth(req, _res, next) {
    const user = store.userByToken(req.get('x-token'));
    if (!user) return next(new HttpError(401, 'Nicht angemeldet.'));
    req.user = user;
    next();
  }

  function admin(req, _res, next) {
    if (!adminPassword) return next(new HttpError(403, 'Admin-Funktionen sind deaktiviert.'));
    if (!safeEqual(req.get('x-admin-password') || '', adminPassword)) {
      return next(new HttpError(403, 'Falsches Admin-Passwort.'));
    }
    next();
  }

  function isAdmin(req) {
    const pw = req.get('x-admin-password');
    return Boolean(adminPassword && pw && safeEqual(pw, adminPassword));
  }

  function loadRound(req) {
    const round = store.rawRound(Number(req.params.id));
    if (!round) throw new HttpError(404, 'Runde nicht gefunden.');
    return round;
  }

  function broadcastRound(round, change) {
    io.emit('round', { round, change });
  }

  function promotedBetween(before, after) {
    const wasWaiting = new Set(before.waitlist.map((p) => p.id));
    return after.players.filter((p) => wasWaiting.has(p.id)).map((p) => p.id);
  }

  // ---- Session ------------------------------------------------------------

  api.get('/config', (_req, res) => {
    res.json({
      version, adminEnabled: Boolean(adminPassword), publicBoard, limits: LIMITS, pastToleranceMs: PAST_TOLERANCE_MS, brand: brand.brand,
    });
  });

  api.get('/qr.svg', (req, res, next) => {
    const text = String(req.query.text || '');
    if (!text || text.length > 1000) throw new HttpError(400, 'Ungültiger Text.');
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => res.type('image/svg+xml').set('cache-control', 'public, max-age=86400').send(svg))
      .catch(next);
  });

  api.get('/public/board', (_req, res) => {
    if (!publicBoard) throw new HttpError(403, 'Die Beamer-Ansicht ist deaktiviert.');
    const rounds = store.listRounds(Date.now() - BOARD_PAST_MS).map((r) => ({
      id: r.id,
      game: r.game,
      startsAt: r.startsAt,
      maxPlayers: r.maxPlayers,
      description: r.description,
      host: r.host.nickname,
      players: r.players.map((p) => p.nickname),
      waitlist: r.waitlist.length,
    }));
    res.json({ version, now: Date.now(), rounds, catalog: store.listGames(), online: online.size });
  });

  api.post('/login', (req, res) => {
    // Login mit Geräte-Code (z.B. um den gleichen Nickname am Handy zu nutzen)
    if (!req.body.nickname && req.body.token) {
      const user = store.userByToken(String(req.body.token).trim());
      if (!user) throw new HttpError(401, 'Unbekannter Code.');
      return res.json({ user, token: String(req.body.token).trim() });
    }
    const nickname = cleanText(req.body.nickname, LIMITS.nickname, { required: true, field: 'Nickname' });
    if (nickname.length < 2) throw new HttpError(400, 'Nickname muss mindestens 2 Zeichen haben.');
    const seat = cleanText(req.body.seat, LIMITS.seat, { field: 'Sitzplatz' });

    const existing = store.userByNick(nickname);
    if (existing) {
      const own = store.userByToken(req.body.token);
      if (own && own.id === existing.id) return res.json({ user: own, token: req.body.token });
      throw new HttpError(409, 'Dieser Nickname ist schon vergeben.');
    }
    const { user, token } = store.createUser(nickname, seat);
    io.emit('user', user);
    res.status(201).json({ user, token });
  });

  api.get('/me', auth, (req, res) => res.json({ user: req.user }));

  api.patch('/me', auth, (req, res) => {
    const seat = cleanText(req.body.seat, LIMITS.seat, { field: 'Sitzplatz' });
    const user = store.updateSeat(req.user.id, seat);
    io.emit('user', user);
    res.json({ user });
  });

  api.get('/users', auth, (_req, res) => {
    res.json({ users: store.listUsers(), online: [...online.keys()] });
  });

  // ---- Rounds -------------------------------------------------------------

  api.get('/games', auth, (_req, res) => res.json({ games: store.games(), catalog: store.listGames() }));

  api.get('/rounds', auth, (_req, res) => {
    res.json({ rounds: store.listRounds(Date.now() - ROUND_VISIBLE_AFTER_START_MS) });
  });

  api.post('/rounds', auth, (req, res) => {
    const input = parseRoundInput(req.body);
    const round = store.createRound({ ...input, hostId: req.user.id });
    broadcastRound(round, { type: 'create', user: req.user });
    res.status(201).json({ round });
  });

  api.patch('/rounds/:id', auth, (req, res) => {
    const raw = loadRound(req);
    if (raw.host_id !== req.user.id && !isAdmin(req)) {
      throw new HttpError(403, 'Nur der Ersteller kann die Runde bearbeiten.');
    }
    const before = store.getRound(raw.id);
    const round = store.updateRound(raw.id, parseRoundInput(req.body, { previousStartsAt: raw.starts_at }));
    broadcastRound(round, { type: 'update', user: req.user, promoted: promotedBetween(before, round) });
    res.json({ round });
  });

  api.delete('/rounds/:id', auth, (req, res) => {
    const raw = loadRound(req);
    if (raw.host_id !== req.user.id && !isAdmin(req)) {
      throw new HttpError(403, 'Nur der Ersteller kann die Runde absagen.');
    }
    const round = store.getRound(raw.id);
    store.deleteRound(raw.id);
    io.emit('round:deleted', { round, user: req.user });
    res.status(204).end();
  });

  api.post('/rounds/:id/join', auth, (req, res) => {
    const raw = loadRound(req);
    if (raw.starts_at < Date.now() - ROUND_VISIBLE_AFTER_START_MS) {
      throw new HttpError(400, 'Diese Runde ist schon vorbei.');
    }
    const changed = store.join(raw.id, req.user.id);
    const round = store.getRound(raw.id);
    if (changed) {
      const waiting = round.waitlist.some((p) => p.id === req.user.id);
      broadcastRound(round, { type: waiting ? 'waitlist' : 'join', user: req.user });
    }
    res.json({ round });
  });

  api.post('/rounds/:id/leave', auth, (req, res) => {
    const raw = loadRound(req);
    if (raw.host_id === req.user.id) {
      throw new HttpError(400, 'Als Ersteller kannst du die Runde nicht verlassen – sag sie stattdessen ab.');
    }
    const before = store.getRound(raw.id);
    const changed = store.leave(raw.id, req.user.id);
    const round = store.getRound(raw.id);
    if (changed) {
      broadcastRound(round, { type: 'leave', user: req.user, promoted: promotedBetween(before, round) });
    }
    res.json({ round });
  });

  // ---- Chat ---------------------------------------------------------------

  function parseRoundParam(value) {
    if (value === undefined || value === null || value === '' || value === 'global') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !store.rawRound(id)) throw new HttpError(404, 'Runde nicht gefunden.');
    return id;
  }

  api.get('/messages', auth, (req, res) => {
    res.json({ messages: store.listMessages(parseRoundParam(req.query.round)) });
  });

  api.post('/messages', auth, (req, res) => {
    const roundId = parseRoundParam(req.body.roundId);
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) throw new HttpError(400, 'Nachricht ist leer.');
    if (text.length > LIMITS.message) throw new HttpError(400, `Nachricht ist zu lang (max. ${LIMITS.message}).`);
    const now = Date.now();
    if (now - (lastChat.get(req.user.id) || 0) < CHAT_MIN_INTERVAL_MS) {
      throw new HttpError(429, 'Nicht so schnell!');
    }
    lastChat.set(req.user.id, now);
    const message = store.addMessage(roundId, req.user.id, text);
    io.emit('message', message);
    res.status(201).json({ message });
  });

  // ---- Admin --------------------------------------------------------------

  api.post('/admin/check', admin, (_req, res) => res.json({ ok: true }));

  api.delete('/admin/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    if (!store.deleteUser(id)) throw new HttpError(404, 'Nutzer nicht gefunden.');
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === id) s.disconnect(true);
    }
    online.delete(id);
    io.emit('user:deleted', { id });
    res.status(204).end();
  });

  function loadGame(req) {
    const game = store.getGame(Number(req.params.id));
    if (!game) throw new HttpError(404, 'Spiel nicht gefunden.');
    return game;
  }

  function removeCoverFile(cover) {
    if (!cover || !cover.startsWith('/covers/')) return;
    fs.rmSync(path.join(coverDir, path.basename(cover)), { force: true });
  }

  function saveGame(fn) {
    try {
      return fn();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Dieses Spiel gibt es schon.');
      throw e;
    }
  }

  const emitCatalog = () => io.emit('catalog', store.listGames());

  function writeCover(gameId, ext, buffer) {
    const file = `${gameId}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(coverDir, file), buffer);
    return `/covers/${file}`;
  }

  /**
   * Lädt Cover, die als http(s)-URL eingetragen sind (z.B. Steam-Logos), herunter und
   * speichert sie lokal – damit sie auf der LAN auch ohne Internet angezeigt werden.
   */
  let caching = null;
  function cacheRemoteCovers() {
    if (caching) return caching;
    caching = (async () => {
      const result = { cached: [], failed: [] };
      for (const game of store.listGames().filter((g) => /^https?:\/\//.test(g.cover))) {
        try {
          const res = await fetch(game.cover, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ext = COVER_TYPES[(res.headers.get('content-type') || '').split(';')[0].trim()];
          if (!ext) throw new Error('kein unterstütztes Bildformat');
          const buffer = Buffer.from(await res.arrayBuffer());
          if (!buffer.length || buffer.length > COVER_MAX_BYTES) throw new Error('Bild leer oder zu groß');
          const current = store.getGame(game.id);
          if (!current || current.cover !== game.cover) continue; // zwischenzeitlich geändert
          store.updateGame(game.id, { ...current, cover: writeCover(game.id, ext, buffer) });
          result.cached.push(game.name);
        } catch (e) {
          result.failed.push({ name: game.name, error: e.cause?.code || e.message });
        }
      }
      if (result.cached.length) emitCatalog();
      return result;
    })().finally(() => { caching = null; });
    return caching;
  }

  api.post('/admin/games/cache-covers', admin, (_req, res, next) => {
    cacheRemoteCovers().then((result) => res.json(result)).catch(next);
  });

  api.post('/admin/games', admin, (req, res) => {
    const game = saveGame(() => store.createGame(parseGameInput(req.body)));
    emitCatalog();
    res.status(201).json({ game });
  });

  api.patch('/admin/games/:id', admin, (req, res) => {
    const old = loadGame(req);
    const input = parseGameInput({ ...old, ...req.body });
    const game = saveGame(() => store.updateGame(old.id, input));
    if (old.cover !== game.cover) removeCoverFile(old.cover);
    emitCatalog();
    res.json({ game });
  });

  api.delete('/admin/games/:id', admin, (req, res) => {
    const game = loadGame(req);
    store.deleteGame(game.id);
    removeCoverFile(game.cover);
    emitCatalog();
    res.status(204).end();
  });

  api.post('/admin/games/:id/cover', admin, express.raw({ type: 'image/*', limit: COVER_MAX_BYTES }), (req, res) => {
    const game = loadGame(req);
    const ext = COVER_TYPES[req.get('content-type')];
    if (!ext) throw new HttpError(400, 'Bitte ein PNG-, JPG-, WebP- oder GIF-Bild hochladen.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Leere Datei.');
    const updated = store.updateGame(game.id, { ...game, cover: writeCover(game.id, ext, req.body) });
    removeCoverFile(game.cover);
    emitCatalog();
    res.json({ game: updated });
  });

  api.delete('/admin/messages/:id', admin, (req, res) => {
    const message = store.messageById(Number(req.params.id));
    if (!message) throw new HttpError(404, 'Nachricht nicht gefunden.');
    store.deleteMessage(message.id);
    io.emit('message:deleted', { id: message.id, roundId: message.roundId });
    res.status(204).end();
  });

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Nicht gefunden.')));

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (err.type === 'entity.too.large') err.message = 'Datei bzw. Anfrage ist zu groß.';
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Fehler.' : err.message });
  });

  // ---- Realtime -----------------------------------------------------------

  io.use((socket, next) => {
    const user = store.userByToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const id = socket.data.userId;
    online.set(id, (online.get(id) || 0) + 1);
    if (online.get(id) === 1) io.emit('presence', { id, online: true });
    socket.emit('presence:all', [...online.keys()]);

    socket.on('disconnect', () => {
      const left = (online.get(id) || 1) - 1;
      if (left > 0) return online.set(id, left);
      online.delete(id);
      io.emit('presence', { id, online: false });
    });
  });

  if (autoCacheCovers) {
    setImmediate(() => cacheRemoteCovers().then(({ cached, failed }) => {
      if (cached.length || failed.length) {
        console.log(`Cover lokal gespeichert: ${cached.length}, nicht erreichbar: ${failed.length}`);
      }
    }));
  }

  return { app, server, io, store, cacheRemoteCovers };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const dbFile = process.env.DB_FILE || path.join(dataDir, 'gamefinder.db');
  const brandDir = process.env.BRAND_DIR ? path.resolve(process.env.BRAND_DIR) : path.join(__dirname, '..', 'brands', 'default');
  const tls = process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
    : null;

  const { server } = createApp({
    dbFile,
    dataDir,
    brandDir,
    adminPassword: process.env.ADMIN_PASSWORD || '',
    publicBoard: process.env.PUBLIC_BOARD !== 'false',
    autoCacheCovers: process.env.CACHE_COVERS !== 'false',
    tls,
  });
  server.listen(port, host, () => {
    console.log(`Gamefinder läuft auf ${tls ? 'https' : 'http'}://${host}:${port} (DB: ${dbFile}, Branding: ${brandDir})`);
  });
}
