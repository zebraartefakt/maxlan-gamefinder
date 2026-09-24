'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      seat       TEXT NOT NULL DEFAULT '',
      token      TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game        TEXT NOT NULL,
      starts_at   INTEGER NOT NULL,
      max_players INTEGER,
      description TEXT NOT NULL DEFAULT '',
      host_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      round_id  INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (round_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id   INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_round ON messages(round_id, id);
    CREATE INDEX IF NOT EXISTS idx_rounds_start ON rounds(starts_at);
  `);
  return createStore(db);
}

function createStore(db) {
  const q = {
    userByToken: db.prepare('SELECT id, nickname, seat FROM users WHERE token = ?'),
    userByNick: db.prepare('SELECT id, nickname, seat FROM users WHERE nickname = ?'),
    userById: db.prepare('SELECT id, nickname, seat FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (nickname, seat, token, created_at) VALUES (?, ?, ?, ?)'),
    updateSeat: db.prepare('UPDATE users SET seat = ? WHERE id = ?'),
    listUsers: db.prepare('SELECT id, nickname, seat FROM users ORDER BY nickname COLLATE NOCASE'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

    insertRound: db.prepare(`INSERT INTO rounds (game, starts_at, max_players, description, host_id, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)`),
    updateRound: db.prepare('UPDATE rounds SET game = ?, starts_at = ?, max_players = ?, description = ? WHERE id = ?'),
    deleteRound: db.prepare('DELETE FROM rounds WHERE id = ?'),
    roundById: db.prepare('SELECT * FROM rounds WHERE id = ?'),
    roundsSince: db.prepare('SELECT * FROM rounds WHERE starts_at >= ? ORDER BY starts_at, id'),
    participantsOf: db.prepare(`SELECT u.id, u.nickname, u.seat, p.joined_at
                                FROM participants p JOIN users u ON u.id = p.user_id
                                WHERE p.round_id = ? ORDER BY p.joined_at, p.rowid`),
    join: db.prepare('INSERT OR IGNORE INTO participants (round_id, user_id, joined_at) VALUES (?, ?, ?)'),
    leave: db.prepare('DELETE FROM participants WHERE round_id = ? AND user_id = ?'),
    games: db.prepare(`SELECT game, COUNT(*) AS n FROM rounds GROUP BY game COLLATE NOCASE
                       ORDER BY n DESC, game COLLATE NOCASE LIMIT 200`),

    insertMessage: db.prepare('INSERT INTO messages (round_id, user_id, text, created_at) VALUES (?, ?, ?, ?)'),
    messageById: db.prepare(`SELECT m.id, m.round_id, m.text, m.created_at, u.id AS user_id, u.nickname
                             FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`),
    messagesGlobal: db.prepare(`SELECT * FROM (
                                  SELECT m.id, m.round_id, m.text, m.created_at, u.id AS user_id, u.nickname
                                  FROM messages m JOIN users u ON u.id = m.user_id
                                  WHERE m.round_id IS NULL ORDER BY m.id DESC LIMIT ?)
                                ORDER BY id`),
    messagesRound: db.prepare(`SELECT * FROM (
                                 SELECT m.id, m.round_id, m.text, m.created_at, u.id AS user_id, u.nickname
                                 FROM messages m JOIN users u ON u.id = m.user_id
                                 WHERE m.round_id = ? ORDER BY m.id DESC LIMIT ?)
                               ORDER BY id`),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  };

  function toMessage(row) {
    return {
      id: row.id,
      roundId: row.round_id,
      text: row.text,
      createdAt: row.created_at,
      user: { id: row.user_id, nickname: row.nickname },
    };
  }

  function hydrateRound(row) {
    if (!row) return null;
    const all = q.participantsOf.all(row.id).map((p) => ({ id: p.id, nickname: p.nickname, seat: p.seat }));
    const limit = row.max_players ?? Infinity;
    return {
      id: row.id,
      game: row.game,
      startsAt: row.starts_at,
      maxPlayers: row.max_players,
      description: row.description,
      host: q.userById.get(row.host_id),
      createdAt: row.created_at,
      players: all.slice(0, limit),
      waitlist: all.slice(limit),
    };
  }

  return {
    close: () => db.close(),

    userByToken: (token) => (token ? q.userByToken.get(token) : undefined),
    userByNick: (nick) => q.userByNick.get(nick),
    userById: (id) => q.userById.get(id),
    listUsers: () => q.listUsers.all(),
    createUser(nickname, seat) {
      const token = crypto.randomBytes(24).toString('base64url');
      const { lastInsertRowid } = q.insertUser.run(nickname, seat, token, Date.now());
      return { user: q.userById.get(Number(lastInsertRowid)), token };
    },
    updateSeat(id, seat) {
      q.updateSeat.run(seat, id);
      return q.userById.get(id);
    },
    deleteUser: (id) => q.deleteUser.run(id).changes > 0,

    createRound({ game, startsAt, maxPlayers, description, hostId }) {
      const now = Date.now();
      const { lastInsertRowid } = q.insertRound.run(game, startsAt, maxPlayers, description, hostId, now);
      const id = Number(lastInsertRowid);
      q.join.run(id, hostId, now);
      return hydrateRound(q.roundById.get(id));
    },
    updateRound(id, { game, startsAt, maxPlayers, description }) {
      q.updateRound.run(game, startsAt, maxPlayers, description, id);
      return hydrateRound(q.roundById.get(id));
    },
    deleteRound: (id) => q.deleteRound.run(id).changes > 0,
    rawRound: (id) => q.roundById.get(id),
    getRound: (id) => hydrateRound(q.roundById.get(id)),
    listRounds: (since) => q.roundsSince.all(since).map(hydrateRound),
    join(roundId, userId) {
      return q.join.run(roundId, userId, Date.now()).changes > 0;
    },
    leave(roundId, userId) {
      return q.leave.run(roundId, userId).changes > 0;
    },
    games: () => q.games.all().map((r) => r.game),

    addMessage(roundId, userId, text) {
      const { lastInsertRowid } = q.insertMessage.run(roundId, userId, text, Date.now());
      return toMessage(q.messageById.get(Number(lastInsertRowid)));
    },
    messageById(id) {
      const row = q.messageById.get(id);
      return row ? toMessage(row) : null;
    },
    listMessages(roundId, limit = 200) {
      const rows = roundId == null ? q.messagesGlobal.all(limit) : q.messagesRound.all(roundId, limit);
      return rows.map(toMessage);
    },
    deleteMessage: (id) => q.deleteMessage.run(id).changes > 0,
  };
}

module.exports = { openDatabase };
