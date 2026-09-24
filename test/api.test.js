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
  const token = await login('Alice', 'A1');
  const dup = await call('POST', '/login', { body: { nickname: 'alice' } });
  assert.equal(dup.status, 409);

  const again = await call('POST', '/login', { body: { nickname: 'Alice', token } });
  assert.equal(again.status, 200);
  assert.equal(again.data.user.seat, 'A1');

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
  assert.equal(data.brand.eventName, 'Maxlan');
  assert.equal(data.brand.logo, '/brand/logo.svg');
  assert.equal(data.brand.title, 'Gamefinder · Maxlan');

  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Gamefinder · Maxlan<\/title>/);
  assert.ok(!html.includes('%TITLE%'));
  for (const p of ['/beamer', '/aushang']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes('%APP_NAME%'));
  }

  const css = await (await fetch(base + '/brand.css')).text();
  assert.match(css, /--accent: #ff6a13;/);
  assert.match(css, /--surface-2: /);
  assert.equal((await fetch(base + '/brand/logo.svg')).status, 200);
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

  assert.equal((await call('POST', '/admin/games', { body: { name: 'Quake III Arena' } })).status, 403);
  const created = await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'Quake III Arena', maxPlayers: 16 } });
  assert.equal(created.status, 201);
  const id = created.data.game.id;
  assert.equal((await call('POST', '/admin/games', { admin: 'geheim', body: { name: 'quake iii arena' } })).status, 409);
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
