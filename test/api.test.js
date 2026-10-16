'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../src/server');

let ctx;
let base;

before(async () => {
  ctx = createApp({
    dbFile: ':memory:',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gf-test-')),
    brandDir: path.join(__dirname, '..', 'brands', 'maxlan'),
    adminPassword: 'geheim',
  });
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  ctx.io.close();
  await new Promise((resolve) => ctx.server.close(resolve));
});

async function call(method, url, { token, body, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-token'] = token;
  if (admin) headers['x-admin-password'] = admin;
  const res = await fetch(base + '/api' + url, { method, headers, body: body && JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

async function login(nickname, seat = '') {
  const { status, data } = await call('POST', '/login', { body: { nickname, seat } });
  assert.equal(status, 201);
  return data.token;
}

const inOneHour = () => Date.now() + 60 * 60 * 1000;

test('Login: Nickname ist eindeutig (ohne Groß-/Kleinschreibung)', async () => {
  const token = await login('Alice', 'a1');
  const dup = await call('POST', '/login', { body: { nickname: 'alice' } });
  assert.equal(dup.status, 409);

  const again = await call('POST', '/login', { body: { nickname: 'Alice', token } });
  assert.equal(again.status, 200);
  assert.equal(again.data.user.seat, 'A-01');

  const byCode = await call('POST', '/login', { body: { token } });
  assert.equal(byCode.status, 200);
  assert.equal(byCode.data.user.nickname, 'Alice');

  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('POST', '/login', { body: { nickname: 'x' } })).status, 400);
});

test('Runde anlegen, beitreten, Warteliste und Nachrücken', async () => {
  const host = await login('Host');
  const p2 = await login('Player2');
  const p3 = await login('Player3');

  const created = await call('POST', '/rounds', {
    token: host,
    body: { game: 'FlatOut 2', startsAt: inOneHour(), maxPlayers: 2, description: 'Stunt-Modus' },
  });
  assert.equal(created.status, 201);
  const { id } = created.data.round;
  assert.deepEqual(created.data.round.players.map((p) => p.nickname), ['Host']);

  const j2 = await call('POST', `/rounds/${id}/join`, { token: p2 });
  assert.deepEqual(j2.data.round.players.map((p) => p.nickname), ['Host', 'Player2']);

  const j3 = await call('POST', `/rounds/${id}/join`, { token: p3 });
  assert.deepEqual(j3.data.round.waitlist.map((p) => p.nickname), ['Player3']);

  const left = await call('POST', `/rounds/${id}/leave`, { token: p2 });
  assert.deepEqual(left.data.round.players.map((p) => p.nickname), ['Host', 'Player3']);
  assert.equal(left.data.round.waitlist.length, 0);

  const hostLeave = await call('POST', `/rounds/${id}/leave`, { token: host });
  assert.equal(hostLeave.status, 400);

  const foreignEdit = await call('PATCH', `/rounds/${id}`, { token: p3, body: { game: 'X', startsAt: inOneHour() } });
  assert.equal(foreignEdit.status, 403);

  const games = await call('GET', '/games', { token: host });
  assert.ok(games.data.games.includes('FlatOut 2'));

  const del = await call('DELETE', `/rounds/${id}`, { token: host });
  assert.equal(del.status, 204);
  const list = await call('GET', '/rounds', { token: host });
  assert.ok(!list.data.rounds.some((r) => r.id === id));
});

test('Validierung von Runden', async () => {
  const t = await login('Validator');
  const past = await call('POST', '/rounds', { token: t, body: { game: 'Q3', startsAt: Date.now() - 3 * 3600000 } });
  assert.equal(past.status, 400);
  const noGame = await call('POST', '/rounds', { token: t, body: { game: '  ', startsAt: inOneHour() } });
  assert.equal(noGame.status, 400);
  const badMax = await call('POST', '/rounds', { token: t, body: { game: 'Q3', startsAt: inOneHour(), maxPlayers: 1 } });
  assert.equal(badMax.status, 400);
});

test('Chat global und pro Runde, inkl. Live-Event', async () => {
  const a = await login('Chatter');
  const b = await login('Listener');
  const round = (await call('POST', '/rounds', { token: a, body: { game: 'UT2004', startsAt: inOneHour() } })).data.round;

  const socket = ioClient(base, { auth: { token: b }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
  const received = new Promise((resolve) => socket.on('message', resolve));

  const sent = await call('POST', '/messages', { token: a, body: { roundId: round.id, text: 'Server-IP 10.0.0.5' } });
  assert.equal(sent.status, 201);
  const live = await received;
  assert.equal(live.text, 'Server-IP 10.0.0.5');
  assert.equal(live.roundId, round.id);
  socket.close();

  await new Promise((r) => setTimeout(r, 450)); // Spam-Schutz
  await call('POST', '/messages', { token: a, body: { roundId: null, text: 'Hallo zusammen' } });

  const roundMsgs = await call('GET', `/messages?round=${round.id}`, { token: b });
  assert.deepEqual(roundMsgs.data.messages.map((m) => m.text), ['Server-IP 10.0.0.5']);
  const globalMsgs = await call('GET', '/messages?round=global', { token: b });
  assert.ok(globalMsgs.data.messages.some((m) => m.text === 'Hallo zusammen'));

  const spam = await call('POST', '/messages', { token: a, body: { text: 'a' } });
  const spam2 = await call('POST', '/messages', { token: a, body: { text: 'b' } });
  assert.equal(spam.status === 429 || spam2.status === 429, true);
});

test('Admin kann Nutzer löschen und Nickname freigeben', async () => {
  const t = await login('Troll');
  const me = (await call('GET', '/me', { token: t })).data.user;
  assert.equal((await call('DELETE', `/admin/users/${me.id}`, { admin: 'falsch' })).status, 403);
  assert.equal((await call('DELETE', `/admin/users/${me.id}`, { admin: 'geheim' })).status, 204);
  assert.equal((await call('GET', '/me', { token: t })).status, 401);
  await login('Troll');
});

test('Branding: Config, Seiten und Farben', async () => {
  const { data } = await call('GET', '/config');
  assert.equal(data.brand.eventName, 'Maxlan 33');
  assert.equal(data.brand.logo, '/brand/logo.png');
  assert.equal(data.brand.eventStart, '2026-11-06');
  assert.equal(data.brand.title, 'Gamefinder · Maxlan 33');

  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Gamefinder · Maxlan 33<\/title>/);
  assert.ok(!html.includes('%TITLE%'));
  for (const p of ['/beamer', '/aushang']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes('%APP_NAME%'));
  }

  const css = await (await fetch(base + '/brand.css')).text();
  assert.match(css, /--accent: #a2271f;/);
  assert.match(css, /--surface-2: /);
  assert.equal((await fetch(base + '/brand/logo.png')).status, 200);
  assert.equal((await fetch(base + '/brand/brand.json')).status, 200);
});

test('QR-Code und Beamer-Daten sind ohne Login abrufbar', async () => {
  const qr = await fetch(base + '/api/qr.svg?text=' + encodeURIComponent('http://192.168.1.10:3000'));
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.equal((await fetch(base + '/api/qr.svg')).status, 400);

  const t = await login('Beamerfan');
  await call('POST', '/rounds', { token: t, body: { game: 'Worms Armageddon', startsAt: inOneHour(), maxPlayers: 6 } });
  const board = await (await fetch(base + '/api/public/board')).json();
  const r = board.rounds.find((x) => x.game === 'Worms Armageddon');
  assert.deepEqual(r.players, ['Beamerfan']);
  assert.equal(r.host, 'Beamerfan');
  assert.ok(!('token' in r) && !JSON.stringify(board).includes('token'));
});

test('Spieleliste: aus games.json übernommen und per Admin verwaltbar', async () => {
  const t = await login('Katalog');
  const { data } = await call('GET', '/games', { token: t });
  const flatout = data.catalog.find((g) => g.name === 'FlatOut 2');
  assert.equal(flatout.maxPlayers, 8);

  assert.equal((await call('POST', '/admin/games', { body: { name: 'Serious Sam' } })).status, 403);
  const created = await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'Serious Sam', maxPlayers: 16 } });
  assert.equal(created.status, 201);
  const id = created.data.game.id;
  assert.equal((await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'serious sam' } })).status, 409);
  const bad = await call('PATCH', `/admin/games/${id}`, { admin: 'geheim', body: { cover: 'javascript:alert(1)' } });
  assert.equal(bad.status, 400);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const up = await fetch(`${base}/api/admin/games/${id}/cover`, {
    method: 'POST', headers: { 'content-type': 'image/png', 'x-admin-password': 'geheim' }, body: png,
  });
  assert.equal(up.status, 200);
  const { game } = await up.json();
  assert.match(game.cover, /^\/covers\/\d+-[0-9a-f]+\.png$/);
  const img = await fetch(base + game.cover);
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).length, png.length);

  const svg = await fetch(`${base}/api/admin/games/${id}/cover`, {
    method: 'POST', headers: { 'content-type': 'image/svg+xml', 'x-admin-password': 'geheim' }, body: '<svg/>',
  });
  assert.equal(svg.status, 400);

  assert.equal((await call('DELETE', `/admin/games/${id}`, { admin: 'geheim' })).status, 204);
  assert.equal((await fetch(base + game.cover)).status, 404);
});

test('Logos von einer URL werden lokal gespeichert', async () => {
  const http = require('node:http');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const imgServer = http.createServer((req, res) => {
    if (req.url === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => imgServer.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${imgServer.address().port}`;
  try {
    const ok = (await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'Logo-Test', cover: `${origin}/logo.png` } })).data.game;
    const bad = (await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'Logo-Kaputt', cover: `${origin}/fehlt.png` } })).data.game;

    const { status, data } = await call('POST', '/admin/games/cache-covers', { admin: 'geheim' });
    assert.equal(status, 200);
    assert.ok(data.cached.includes('Logo-Test'));
    assert.ok(data.failed.some((f) => f.name === 'Logo-Kaputt'));

    const t = await login('LogoFan');
    const catalog = (await call('GET', '/games', { token: t })).data.catalog;
    const cover = catalog.find((g) => g.id === ok.id).cover;
    assert.match(cover, /^\/covers\//);
    assert.equal((await fetch(base + cover)).status, 200);
    assert.equal(catalog.find((g) => g.id === bad.id).cover, `${origin}/fehlt.png`);
  } finally {
    imgServer.close();
  }
});

test('Spieleliste: Steam-IDs werden zu Cover-Adressen, neue Spiele werden ergänzt', async () => {
  const t = await login('Steamer');
  const catalog = (await call('GET', '/games', { token: t })).data.catalog;
  const cs2 = catalog.find((g) => g.name === 'Counter-Strike 2');
  // Steam-Adresse aus games.json – oder bereits lokal gespeichert, falls ein vorheriger
  // Test die Logos herunterladen konnte (abhängig vom Netzwerk der Testumgebung)
  assert.match(cs2.cover, /^(https:\/\/cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/730\/header\.jpg|\/covers\/.+)$/);
  assert.equal(catalog.find((g) => g.name === 'Minecraft').cover, '');
  assert.ok(catalog.length >= 30);
});

test('Versionskennung für das automatische Neuladen des Beamers', async () => {
  const config = (await call('GET', '/config')).data;
  const board = await (await fetch(base + '/api/public/board')).json();
  assert.match(config.version, /^[0-9a-f]{12}$/);
  assert.equal(board.version, config.version);

  // Gleiche Dateien → gleiche Version; anderes Branding → andere Version
  const same = createApp({ dbFile: ':memory:', brandDir: path.join(__dirname, '..', 'brands', 'maxlan') });
  const other = createApp({ dbFile: ':memory:', brandDir: path.join(__dirname, '..', 'brands', 'default') });
  const versionOf = async (ctx2) => {
    await new Promise((r) => ctx2.server.listen(0, '127.0.0.1', r));
    const v = (await (await fetch(`http://127.0.0.1:${ctx2.server.address().port}/api/config`)).json()).version;
    ctx2.io.close();
    await new Promise((r) => ctx2.server.close(r));
    return v;
  };
  assert.equal(await versionOf(same), config.version);
  assert.notEqual(await versionOf(other), config.version);
});

test('Startzeit in der Vergangenheit: weder beim Anlegen noch beim Bearbeiten', async () => {
  const t = await login('Zeitreisender');
  const h = 60 * 60 * 1000;
  assert.equal((await call('POST', '/rounds', { token: t, body: { game: 'X', startsAt: Date.now() - 20 * h } })).status, 400);
  assert.equal((await call('POST', '/rounds', { token: t, body: { game: 'X', startsAt: Date.now() - 30 * 60 * 1000 } })).status, 201);

  const { round } = (await call('POST', '/rounds', { token: t, body: { game: 'Y', startsAt: Date.now() + h } })).data;
  const moved = await call('PATCH', `/rounds/${round.id}`, { token: t, body: { game: 'Y', startsAt: Date.now() - 20 * h } });
  assert.equal(moved.status, 400);
  assert.match(moved.data.error, /Vergangenheit/);

  // Eine längst laufende Runde darf weiter bearbeitet werden, solange die Zeit gleich bleibt
  const { store } = ctx;
  const old = store.createRound({ game: 'Alt', startsAt: Date.now() - 5 * h, maxPlayers: null, description: '', hostId: round.host.id });
  const edited = await call('PATCH', `/rounds/${old.id}`, { token: t, body: { game: 'Alt', startsAt: old.startsAt, description: 'läuft noch' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.round.description, 'läuft noch');
});

test('Spielmodus: optional, begrenzt, auf dem Beamer und als Vorschlag', async () => {
  const t = await login('Modder');
  const created = await call('POST', '/rounds', {
    token: t, body: { game: 'Quake III Arena', mode: '  Instagib ', startsAt: inOneHour(), maxPlayers: 8 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.round.mode, 'Instagib');

  const tooLong = await call('POST', '/rounds', { token: t, body: { game: 'Q3', mode: 'x'.repeat(25), startsAt: inOneHour() } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error, /Spielmodus/);

  const noMode = await call('POST', '/rounds', { token: t, body: { game: 'Q3', startsAt: inOneHour() } });
  assert.equal(noMode.data.round.mode, '');

  const edited = await call('PATCH', `/rounds/${created.data.round.id}`, {
    token: t, body: { game: 'Quake III Arena', mode: 'CTF', startsAt: created.data.round.startsAt },
  });
  assert.equal(edited.data.round.mode, 'CTF');

  const board = await (await fetch(base + '/api/public/board')).json();
  assert.equal(board.rounds.find((r) => r.id === created.data.round.id).mode, 'CTF');

  const { modes } = (await call('GET', '/games', { token: t })).data;
  assert.ok(modes.some((m) => m.game === 'Quake III Arena' && m.mode === 'CTF'));
});

test('Migration: alte Datenbank ohne Spielmodus-Spalte', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDatabase } = require('../src/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-mig-')), 'alt.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
      seat TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, starts_at INTEGER NOT NULL,
      max_players INTEGER, description TEXT NOT NULL DEFAULT '', host_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users (nickname, token, created_at) VALUES ('Alt', 'tok', 0);
    INSERT INTO rounds (game, starts_at, host_id, created_at) VALUES ('UT2004', ${Date.now() + 3600000}, 1, 0);
  `);
  old.close();

  const store = openDatabase(file);
  const [round] = store.listRounds(0);
  assert.equal(round.game, 'UT2004');
  assert.equal(round.mode, '');
  const updated = store.updateRound(round.id, { ...round, mode: 'Onslaught' });
  assert.equal(updated.mode, 'Onslaught');
  store.close();
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('Spam-Schutz: Höchstzahl, Wiederholung, Stummschaltung', async () => {
  const t = await login('Spammer');
  const say = (text) => call('POST', '/messages', { token: t, body: { roundId: null, text } });

  // 5 Nachrichten in 10 s sind erlaubt, die 6. nicht
  for (let i = 1; i <= 5; i++) {
    assert.equal((await say(`Nachricht ${i}`)).status, 201);
    await pause(420);
  }
  const sixth = await say('Nachricht 6');
  assert.equal(sixth.status, 429);
  assert.match(sixth.data.error, /Zu viele Nachrichten/);

  // Wiederholung derselben Nachricht (auch in anderer Schreibweise)
  const t2 = await login('Wiederholer');
  assert.equal((await call('POST', '/messages', { token: t2, body: { text: 'Wer zockt CS?' } })).status, 201);
  await pause(420);
  const dup = await call('POST', '/messages', { token: t2, body: { text: '  wer zockt cs?  ' } });
  assert.equal(dup.status, 429);
  assert.match(dup.data.error, /schon geschickt/);

  // Drei Verstöße innerhalb einer Minute → stummgeschaltet, auch für neue Texte
  await pause(420);
  await call('POST', '/messages', { token: t2, body: { text: 'Wer zockt CS?' } });
  await pause(420);
  const muted = await call('POST', '/messages', { token: t2, body: { text: 'Wer zockt CS?' } });
  assert.match(muted.data.error, /stummgeschaltet/);
  await pause(420);
  const still = await call('POST', '/messages', { token: t2, body: { text: 'Etwas ganz Neues' } });
  assert.equal(still.status, 429);
  assert.match(still.data.error, /noch \d+ s stummgeschaltet/);
});

test('Chat: Text wird bereinigt, pro Chat nur die neuesten 50 Nachrichten', async () => {
  const t = await login('Aufräumer');
  const me = (await call('GET', '/me', { token: t })).data.user;
  const { round } = (await call('POST', '/rounds', { token: t, body: { game: 'Chat-Test', startsAt: inOneHour() } })).data;

  const clean = await call('POST', '/messages', { token: t, body: { roundId: round.id, text: '  GG\n\n  neeeeeeeeeeeeeein!!!!!!!!!!!!  ' } });
  assert.equal(clean.data.message.text, 'GG neeeeeeeein!!!!!!!!');

  for (let i = 0; i < 60; i++) ctx.store.addMessage(round.id, me.id, `Alt ${i}`);
  await pause(420);
  await call('POST', '/messages', { token: t, body: { roundId: round.id, text: 'Die neueste' } });
  const { messages } = (await call('GET', `/messages?round=${round.id}`, { token: t })).data;
  assert.equal(messages.length, 50);
  assert.equal(messages.at(-1).text, 'Die neueste');
  assert.equal(messages[0].text, 'Alt 11');

  // Der globale Chat ist davon nicht betroffen
  const global = (await call('GET', '/messages?round=global', { token: t })).data.messages;
  assert.ok(global.length > 0 && global.every((m) => m.roundId === null));
});

test('Admin-Passwort mit Sonderzeichen (URL-kodiert übertragen)', async () => {
  const special = createApp({ dbFile: ':memory:', adminPassword: '  G€heim$2026  ' });
  await new Promise((r) => special.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${special.server.address().port}/api/admin/check`;
  const check = (pw) => fetch(url, { method: 'POST', headers: { 'x-admin-password': pw } }).then((r) => r.status);
  try {
    assert.equal(await check(encodeURIComponent('G€heim$2026')), 200);
    assert.equal(await check(encodeURIComponent(' G€heim$2026 ')), 200); // Leerzeichen am Rand egal
    assert.equal(await check(encodeURIComponent('G€heim')), 403);
    // unkodiert (ältere Clients) klappt weiterhin, solange nur ISO-8859-1-Zeichen vorkommen
    assert.equal(await check('bitte-aendern'), 403);
  } finally {
    special.io.close();
    await new Promise((r) => special.server.close(r));
  }
  assert.equal((await call('POST', '/admin/check', { admin: 'geheim' })).status, 200);
});

test('Admin: Spieler umbenennen und Sitzplatz ändern', async () => {
  const t = await login('Tippfehlr', 'A-01');
  await login('Belegt');
  const u = (await call('GET', '/me', { token: t })).data.user;

  assert.equal((await call('PATCH', `/admin/users/${u.id}`, { body: { nickname: 'Tippfehler' } })).status, 403);
  const renamed = await call('PATCH', `/admin/users/${u.id}`, { admin: 'geheim', body: { nickname: ' Tippfehler ', seat: 'B7' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.user.nickname, 'Tippfehler');
  assert.equal(renamed.data.user.seat, 'B-07');
  // Der Spieler bleibt mit seinem Gerät angemeldet – nur der Name ist neu
  assert.equal((await call('GET', '/me', { token: t })).data.user.nickname, 'Tippfehler');

  assert.equal((await call('PATCH', `/admin/users/${u.id}`, { admin: 'geheim', body: { nickname: 'belegt' } })).status, 409);
  assert.equal((await call('PATCH', `/admin/users/${u.id}`, { admin: 'geheim', body: { nickname: 'x' } })).status, 400);
  // Groß-/Kleinschreibung am eigenen Namen ändern ist erlaubt
  assert.equal((await call('PATCH', `/admin/users/${u.id}`, { admin: 'geheim', body: { nickname: 'TIPPFEHLER' } })).status, 200);
  assert.equal((await call('PATCH', '/admin/users/99999', { admin: 'geheim', body: { nickname: 'Niemand' } })).status, 404);
});

test('Admin: Chat-Sperre löscht Nachrichten sofort und blockiert den Chat', async () => {
  const t = await login('Troll2');
  const other = await login('Unbeteiligt');
  const u = (await call('GET', '/me', { token: t })).data.user;
  const { round } = (await call('POST', '/rounds', { token: other, body: { game: 'Sperr-Test', startsAt: inOneHour() } })).data;
  await call('POST', '/messages', { token: t, body: { text: 'Spam im globalen Chat' } });
  await pause(420);
  await call('POST', '/messages', { token: t, body: { roundId: round.id, text: 'Spam in der Runde' } });
  await call('POST', '/messages', { token: other, body: { roundId: round.id, text: 'Ich bleibe stehen' } });

  const socket = ioClient(base, { auth: { token: other }, transports: ['websocket'] });
  await new Promise((resolve) => socket.on('connect', resolve));
  const purged = new Promise((resolve) => socket.on('messages:purged', resolve));

  assert.equal((await call('POST', `/admin/users/${u.id}/chat-ban`, { body: { duration: '1h' } })).status, 403);
  assert.equal((await call('POST', `/admin/users/${u.id}/chat-ban`, { admin: 'geheim', body: { duration: '2h' } })).status, 400);
  const ban = await call('POST', `/admin/users/${u.id}/chat-ban`, { admin: 'geheim', body: { duration: '1h' } });
  assert.equal(ban.status, 200);
  assert.equal(ban.data.deletedMessages, 2);
  const until = ban.data.user.chatBannedUntil;
  assert.ok(until > Date.now() + 59 * 60 * 1000 && until <= Date.now() + 60 * 60 * 1000);
  assert.deepEqual(await purged, { userId: u.id });
  socket.close();

  const roundMsgs = (await call('GET', `/messages?round=${round.id}`, { token: other })).data.messages;
  assert.deepEqual(roundMsgs.map((m) => m.text), ['Ich bleibe stehen']);
  const globalMsgs = (await call('GET', '/messages?round=global', { token: other })).data.messages;
  assert.ok(!globalMsgs.some((m) => m.user.id === u.id));

  const blocked = await call('POST', '/messages', { token: t, body: { text: 'Hallo?' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /bis .* Uhr vom Chat ausgeschlossen/);
  // Runden ankündigen und beitreten geht weiterhin – gesperrt ist nur der Chat
  assert.equal((await call('POST', `/rounds/${round.id}/join`, { token: t })).status, 200);

  const perm = await call('POST', `/admin/users/${u.id}/chat-ban`, { admin: 'geheim', body: { duration: 'permanent' } });
  assert.equal(perm.data.deletedMessages, 0);
  assert.match((await call('POST', '/messages', { token: t, body: { text: 'Hallo?' } })).data.error, /dauerhaft/);
  assert.equal((await call('GET', '/me', { token: t })).data.user.chatBannedUntil, 8640000000000000);

  const lifted = await call('POST', `/admin/users/${u.id}/chat-ban`, { admin: 'geheim', body: { duration: 'none' } });
  assert.equal(lifted.data.user.chatBannedUntil, null);
  await pause(420); // Mindestabstand des Spam-Schutzes
  assert.equal((await call('POST', '/messages', { token: t, body: { text: 'Bin wieder brav' } })).status, 201);
});

test('Migration: alte Datenbank ohne Chat-Sperre-Spalte', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDatabase } = require('../src/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-mig2-')), 'alt.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
      seat TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    INSERT INTO users (nickname, token, created_at) VALUES ('Alt', 'tok', 0);`);
  old.close();
  const store = openDatabase(file);
  assert.equal(store.userByToken('tok').chatBannedUntil, null);
  assert.equal(store.setChatBan(1, 123).chatBannedUntil, 123);
  store.close();
});

test('Runde beendet: nur gestartete Runden, nur Ersteller/Admin, danach weg', async () => {
  const host = await login('Gastgeber');
  const other = await login('Mitspieler');
  const started = (await call('POST', '/rounds', { token: host, body: { game: 'FlatOut 2', startsAt: Date.now() - 10 * 60 * 1000 } })).data.round;
  const upcoming = (await call('POST', '/rounds', { token: host, body: { game: 'UT2004', startsAt: inOneHour() } })).data.round;
  await call('POST', `/rounds/${started.id}/join`, { token: other });

  assert.equal((await call('POST', `/rounds/${upcoming.id}/end`, { token: host })).status, 400); // noch nicht begonnen
  assert.equal((await call('POST', `/rounds/${started.id}/end`, { token: other })).status, 403);

  const socket = ioClient(base, { auth: { token: other }, transports: ['websocket'] });
  await new Promise((resolve) => socket.on('connect', resolve));
  const ended = new Promise((resolve) => socket.on('round:ended', resolve));
  const res = await call('POST', `/rounds/${started.id}/end`, { token: host });
  assert.equal(res.status, 200);
  assert.equal((await ended).round.id, started.id);
  socket.close();

  const ids = (await call('GET', '/rounds', { token: other })).data.rounds.map((r) => r.id);
  assert.ok(!ids.includes(started.id) && ids.includes(upcoming.id));
  const board = await (await fetch(base + '/api/public/board')).json();
  assert.ok(!board.rounds.some((r) => r.id === started.id));
  assert.equal((await call('POST', `/rounds/${started.id}/join`, { token: await login('Zuspät') })).status, 400);
  assert.equal((await call('POST', '/messages', { token: other, body: { roundId: started.id, text: 'Hallo?' } })).status, 400);

  // Admin darf fremde Runden beenden
  const r2 = (await call('POST', '/rounds', { token: host, body: { game: 'Q3', startsAt: Date.now() - 60 * 1000 } })).data.round;
  assert.equal((await call('POST', `/rounds/${r2.id}/end`, { token: other, admin: 'geheim' })).status, 200);
});

test('Gestartete Runden sind 3 Stunden sichtbar', async () => {
  const t = await login('Zeitfenster');
  const { round } = (await call('POST', '/rounds', { token: t, body: { game: 'Alt-Test', startsAt: Date.now() - 30 * 60 * 1000 } })).data;
  ctx.store.updateRound(round.id, { ...round, startsAt: Date.now() - 3.5 * 60 * 60 * 1000 });
  const ids = (await call('GET', '/rounds', { token: t })).data.rounds.map((r) => r.id);
  assert.ok(!ids.includes(round.id));
  assert.equal((await call('POST', `/rounds/${round.id}/join`, { token: await login('Nachzügler') })).status, 400);
  assert.equal((await call('GET', '/config')).data.roundVisibleMs, 3 * 60 * 60 * 1000);
});

test('Sitzplatz im Format Buchstabe-Ziffer-Ziffer', async () => {
  for (const [input, expected] of [['B-07', 'B-07'], ['b7', 'B-07'], ['C 12', 'C-12'], ['z-3', 'Z-03'], ['', '']]) {
    const nick = `Sitz${Math.random().toString(36).slice(2, 8)}`;
    const res = await call('POST', '/login', { body: { nickname: nick, seat: input } });
    assert.equal(res.status, 201, input);
    assert.equal(res.data.user.seat, expected, input);
  }
  for (const bad of ['Tisch 4', '12', 'AB-12', 'B-123', 'B12x']) {
    const res = await call('POST', '/login', { body: { nickname: `Falsch${Math.random().toString(36).slice(2, 8)}`, seat: bad } });
    assert.equal(res.status, 400, bad);
    assert.match(res.data.error, /Format B-07/);
  }
  const t = await login('Umzug', 'A-01');
  assert.equal((await call('PATCH', '/me', { token: t, body: { seat: 'd 9' } })).data.user.seat, 'D-09');
  assert.equal((await call('PATCH', '/me', { token: t, body: { seat: 'Fenster' } })).status, 400);
  const me = (await call('GET', '/me', { token: t })).data.user;
  assert.equal((await call('PATCH', `/admin/users/${me.id}`, { admin: 'geheim', body: { seat: 'xx' } })).status, 400);
  // Admin ändert nur den Namen → bestehender Sitzplatz bleibt unangetastet
  assert.equal((await call('PATCH', `/admin/users/${me.id}`, { admin: 'geheim', body: { nickname: 'Umzug2' } })).data.user.seat, 'D-09');
});
