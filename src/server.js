'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { openDatabase } = require('./db');

const LIMITS = { nickname: 24, seat: 16, game: 60, description: 300, message: 500 };
const ROUND_VISIBLE_AFTER_START_MS = 12 * 60 * 60 * 1000;
const CHAT_MIN_INTERVAL_MS = 400;

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

function parseRoundInput(body, { isNew }) {
  const game = cleanText(body.game, LIMITS.game, { required: true, field: 'Spiel' });
  const description = cleanText(body.description, LIMITS.description, { field: 'Beschreibung' });
  const startsAt = Number(body.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= 0) throw new HttpError(400, 'Ungültige Startzeit.');
  if (isNew && startsAt < Date.now() - 60 * 60 * 1000) {
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

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createApp({ dbFile = ':memory:', adminPassword = '', tls = null } = {}) {
  const store = openDatabase(dbFile);
  const app = express();
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const io = new Server(server);

  /** userId -> number of open sockets */
  const online = new Map();
  /** userId -> timestamp of last chat message */
  const lastChat = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

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
    res.json({ adminEnabled: Boolean(adminPassword), limits: LIMITS });
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

  api.get('/games', auth, (_req, res) => res.json({ games: store.games() }));

  api.get('/rounds', auth, (_req, res) => {
    res.json({ rounds: store.listRounds(Date.now() - ROUND_VISIBLE_AFTER_START_MS) });
  });

  api.post('/rounds', auth, (req, res) => {
    const input = parseRoundInput(req.body, { isNew: true });
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
    const round = store.updateRound(raw.id, parseRoundInput(req.body, { isNew: false }));
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
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
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

  return { app, server, io, store };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const dbFile = process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'gamefinder.db');
  const tls = process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
    : null;

  const { server } = createApp({ dbFile, adminPassword: process.env.ADMIN_PASSWORD || '', tls });
  server.listen(port, host, () => {
    console.log(`MaxLAN Gamefinder läuft auf ${tls ? 'https' : 'http'}://${host}:${port} (DB: ${dbFile})`);
  });
}
