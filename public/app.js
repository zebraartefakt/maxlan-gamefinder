/* Gamefinder – Client */
'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const REMINDER_MINUTES = 10;
  const DEFAULT_SETTINGS = {
    n_newRound: true, n_join: true, n_chat: true, n_global: false, n_reminder: true, n_sound: true,
  };

  // ---- Storage (kann in privaten Fenstern fehlschlagen) -------------------

  const storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignorieren */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignorieren */ }
    },
  };

  // ---- State --------------------------------------------------------------

  const state = {
    token: storage.get('gf.token', null),
    me: null,
    config: { adminEnabled: false, publicBoard: true, brand: { title: document.title } },
    catalog: [],
    gameHistory: [],
    combo: { items: [], index: -1 },
    rounds: new Map(),
    users: new Map(),
    online: new Set(),
    messages: new Map(), // key: 'global' | roundId
    unread: new Map(), // key: 'global' | roundId -> count
    tab: 'rounds',
    openRoundId: null,
    editingRoundId: null,
    settings: { ...DEFAULT_SETTINGS, ...storage.get('gf.settings', {}) },
    adminPassword: sessionStorage.getItem('gf.admin') || '',
    reminded: new Set(storage.get('gf.reminded', [])),
    socket: null,
  };

  // ---- API ----------------------------------------------------------------

  async function api(method, url, body) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers['x-token'] = state.token;
    if (state.adminPassword) headers['x-admin-password'] = state.adminPassword;
    const res = await fetch(`/api${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- Formatierung -------------------------------------------------------

  const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const fmtShortDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayLabel(ts) {
    const today = dayKey(Date.now());
    const tomorrow = dayKey(Date.now() + 86400000);
    const k = dayKey(ts);
    const base = fmtDay.format(ts);
    if (k === today) return `Heute · ${base}`;
    if (k === tomorrow) return `Morgen · ${base}`;
    return base;
  }

  const fmtOptionDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

  function dayOptionLabel(ts) {
    const k = dayKey(ts);
    const prefix = k === dayKey(Date.now()) ? 'Heute · ' : k === dayKey(Date.now() + 86400000) ? 'Morgen · ' : '';
    return prefix + fmtOptionDay.format(ts);
  }

  function whenLabel(ts) {
    const same = dayKey(ts) === dayKey(Date.now());
    return `${same ? 'Heute' : fmtShortDay.format(ts)} ${fmtTime.format(ts)} Uhr`;
  }

  function relative(ts) {
    const min = Math.round((ts - Date.now()) / 60000);
    if (min === 0) return 'jetzt';
    const abs = Math.abs(min);
    const txt = abs < 60 ? `${abs} min` : abs < 60 * 24 ? `${Math.floor(abs / 60)} h ${abs % 60 ? `${abs % 60} min` : ''}`.trim() : `${Math.round(abs / 1440)} ${Math.round(abs / 1440) === 1 ? 'Tag' : 'Tagen'}`;
    return min > 0 ? `in ${txt}` : `seit ${txt}`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function colorFor(name) {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 65% 60%)`;
  }

  function catalogEntry(name) {
    const n = String(name).trim().toLowerCase();
    return state.catalog.find((g) => g.name.toLowerCase() === n) || null;
  }

  /** "Age of Empires II" → "AE", "Counter-Strike 2" → "CS": Anfangsbuchstaben der großgeschriebenen Wörter */
  function initials(name) {
    const words = name.split(/[\s\-:–]+/).filter((w) => /^\p{Lu}/u.test(w));
    return (words.length >= 2 ? words.slice(0, 2).map((w) => w[0]).join('') : name.replace(/\s+/g, '').slice(0, 2)).toUpperCase();
  }

  /** Cover-Bild; fällt auf Initialen zurück, wenn kein Cover da ist oder es nicht lädt. */
  function gameIcon(game, cls) {
    const fallback = () => el('span', { class: `${cls} initials` }, initials(game.name));
    if (!game.cover) return fallback();
    const img = el('img', { class: cls, src: game.cover, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }

  function coverImg(name, cls = 'cover thumb') {
    const g = catalogEntry(name);
    return g && g.cover ? gameIcon(g, cls) : null;
  }

  function nick(user, { seat = false } = {}) {
    const u = state.users.get(user.id) || user;
    return el('span', { class: `nick${state.online.has(u.id) ? ' online' : ''}`, style: `--c:${colorFor(u.nickname)}` },
      u.nickname, seat && u.seat ? el('span', { class: 'seat' }, u.seat) : null);
  }

  // ---- Runden-Helfer ------------------------------------------------------

  function myStatus(round) {
    if (!state.me) return null;
    if (round.players.some((p) => p.id === state.me.id)) return 'in';
    const idx = round.waitlist.findIndex((p) => p.id === state.me.id);
    return idx >= 0 ? `wait:${idx + 1}` : null;
  }

  const isMine = (round) => myStatus(round) !== null;
  const isFull = (round) => round.maxPlayers !== null && round.players.length >= round.maxPlayers;

  async function joinRound(id) {
    try {
      const { round } = await api('POST', `/rounds/${id}/join`);
      upsertRound(round);
      const st = myStatus(round);
      toast(st && st.startsWith('wait') ? `Runde voll – du stehst auf der Warteliste (Platz ${st.slice(5)}).` : `Du bist bei ${round.game} dabei!`);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function leaveRound(id) {
    try {
      const { round } = await api('POST', `/rounds/${id}/leave`);
      upsertRound(round);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteRound(id) {
    const round = state.rounds.get(id);
    if (!round || !confirm(`Runde „${round.game}“ wirklich absagen?`)) return;
    try {
      await api('DELETE', `/rounds/${id}`);
      removeRound(id);
    } catch (e) { toast(e.message, 'error'); }
  }

  function upsertRound(round) {
    state.rounds.set(round.id, round);
    renderRounds();
    if (state.openRoundId === round.id) renderRoundDialog();
  }

  function removeRound(id) {
    state.rounds.delete(id);
    state.messages.delete(id);
    state.unread.delete(id);
    renderRounds();
    updateTitle();
    if (state.openRoundId === id) $('#round-dialog').close();
  }

  function roundActions(round, { compact = false } = {}) {
    const st = myStatus(round);
    const isHost = round.host.id === state.me.id;
    const admin = Boolean(state.adminPassword);
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const btns = [];
    if (!st) {
      btns.push(el('button', { class: 'btn primary', onclick: stop(() => joinRound(round.id)) },
        isFull(round) ? 'Auf Warteliste' : 'Mitmachen'));
    } else if (!isHost) {
      btns.push(el('button', { class: 'btn', onclick: stop(() => leaveRound(round.id)) }, 'Verlassen'));
    }
    if (!compact && (isHost || admin)) {
      btns.push(el('button', { class: 'btn', onclick: stop(() => openEditDialog(round)) }, 'Bearbeiten'));
      btns.push(el('button', { class: 'btn danger', onclick: stop(() => deleteRound(round.id)) }, 'Absagen'));
    }
    return btns;
  }

  // ---- Rundenliste --------------------------------------------------------

  function renderRounds() {
    const list = $('#round-list');
    const filter = $('#round-filter').value.trim().toLowerCase();
    const onlyMine = $('#only-mine').checked;
    const now = Date.now();

    const rounds = [...state.rounds.values()]
      .filter((r) => !filter || r.game.toLowerCase().includes(filter) || r.host.nickname.toLowerCase().includes(filter))
      .filter((r) => !onlyMine || isMine(r))
      .sort((a, b) => a.startsAt - b.startsAt || a.id - b.id);

    const started = rounds.filter((r) => r.startsAt <= now).reverse();
    const upcoming = rounds.filter((r) => r.startsAt > now);

    list.replaceChildren();
    if (!rounds.length) {
      list.append(el('div', { class: 'empty card' },
        el('p', {}, state.rounds.size ? 'Keine passenden Runden gefunden.' : 'Noch keine Runden angekündigt.'),
        el('p', { class: 'muted' }, 'Sei der Erste und kündige eine Runde an!')));
      return;
    }

    let lastDay = null;
    for (const r of upcoming) {
      const k = dayKey(r.startsAt);
      if (k !== lastDay) {
        list.append(el('h2', { class: 'day' }, dayLabel(r.startsAt)));
        lastDay = k;
      }
      list.append(roundCard(r));
    }
    if (started.length) {
      list.append(el('h2', { class: 'day' }, 'Bereits gestartet'));
      for (const r of started) list.append(roundCard(r, { started: true }));
    }
  }

  function roundCard(r, { started = false } = {}) {
    const st = myStatus(r);
    const unread = state.unread.get(r.id) || 0;
    const soon = !started && r.startsAt - Date.now() < 30 * 60000;
    const cap = r.maxPlayers ? `${r.players.length}/${r.maxPlayers}` : `${r.players.length}`;
    const tags = [];
    if (st === 'in') tags.push(el('span', { class: 'tag ok' }, r.host.id === state.me.id ? 'Deine Runde' : 'Du bist dabei'));
    if (st && st.startsWith('wait')) tags.push(el('span', { class: 'tag warn' }, `Warteliste #${st.slice(5)}`));
    if (isFull(r)) tags.push(el('span', { class: 'tag' }, 'Voll'));
    if (soon) tags.push(el('span', { class: 'tag hot' }, 'Gleich'));
    if (unread) tags.push(el('span', { class: 'badge' }, unread));

    const shown = r.players.slice(0, 8);
    return el('article', {
      class: `round card${started ? ' started' : ''}${st ? ' mine' : ''}`,
      tabindex: 0,
      onclick: () => openRoundDialog(r.id),
      onkeydown: (e) => { if (e.key === 'Enter') openRoundDialog(r.id); },
    },
    el('div', { class: 'round-time' },
      el('strong', {}, fmtTime.format(r.startsAt)),
      el('span', { class: 'muted small' }, relative(r.startsAt))),
    el('div', { class: 'round-main' },
      el('div', { class: 'round-title' }, coverImg(r.game), el('h3', {}, r.game), ...tags),
      r.description ? el('p', { class: 'muted small clamp' }, r.description) : null,
      el('div', { class: 'round-people' },
        el('span', { class: 'count', title: 'Spieler' }, '👥 ', cap),
        ...shown.map((p) => nick(p)),
        r.players.length > shown.length ? el('span', { class: 'muted small' }, `+${r.players.length - shown.length}`) : null,
        r.waitlist.length ? el('span', { class: 'muted small' }, `· ${r.waitlist.length} wartend`) : null)),
    el('div', { class: 'round-actions' }, roundActions(r, { compact: true })));
  }

  // ---- Runden-Dialog ------------------------------------------------------

  async function openRoundDialog(id) {
    state.openRoundId = id;
    renderRoundDialog();
    const dlg = $('#round-dialog');
    if (!dlg.open) dlg.showModal();
    await loadMessages(id);
    markRead(id);
  }

  function renderRoundDialog() {
    const r = state.rounds.get(state.openRoundId);
    if (!r) return;
    $('#rd-title').textContent = r.game;
    const cover = catalogEntry(r.game)?.cover;
    $('#rd-cover').hidden = !cover;
    if (cover) $('#rd-cover').src = cover;
    $('#rd-meta').replaceChildren(
      el('span', {}, '🕑 ', whenLabel(r.startsAt), el('span', { class: 'muted' }, ` (${relative(r.startsAt)})`)),
      el('span', {}, '👑 ', nick(r.host, { seat: true })));
    $('#rd-desc').textContent = r.description;
    $('#rd-desc').hidden = !r.description;
    $('#rd-actions').replaceChildren(...roundActions(r));
    $('#rd-count').textContent = r.maxPlayers ? `(${r.players.length}/${r.maxPlayers})` : `(${r.players.length})`;
    $('#rd-players').replaceChildren(...r.players.map((p) => el('li', {}, nick(p, { seat: true }))));
    $('#rd-waitlist').replaceChildren(...r.waitlist.map((p, i) => el('li', {}, `${i + 1}. `, nick(p, { seat: true }))));
    $('#rd-wait-wrap').hidden = !r.waitlist.length;

    $('#rd-chat').dataset.chat = r.id;
    renderChat(r.id);
  }

  // ---- Runde anlegen / bearbeiten ----------------------------------------

  /**
   * Tage zur Auswahl: die noch anstehenden Event-Tage aus dem Branding, sonst (kein Event
   * eingetragen oder Event vorbei) die nächsten 5 Tage – jeweils 12 Uhr.
   */
  function selectableDays() {
    const today = dayKey(Date.now());
    const days = eventDays().filter((ts) => dayKey(ts) >= today);
    if (days.length) return days;
    const noon = (d) => { d.setHours(12, 0, 0, 0); return d.getTime(); };
    return Array.from({ length: 5 }, (_, i) => noon(new Date(Date.now() + i * 86400000)));
  }

  function eventDays() {
    const { eventStart, eventEnd } = state.config.brand;
    const noon = (d) => { d.setHours(12, 0, 0, 0); return d.getTime(); };
    if (eventStart) {
      const [y, m, d] = eventStart.split('-').map(Number);
      const first = noon(new Date(y, m - 1, d));
      let last = first;
      if (eventEnd) {
        const [y2, m2, d2] = eventEnd.split('-').map(Number);
        last = Math.max(first, noon(new Date(y2, m2 - 1, d2)));
      }
      const days = [];
      for (let ts = first; ts <= last && days.length < 14; ts += 86400000) days.push(noon(new Date(ts)));
      return days;
    }
    return [];
  }

  function fillDayOptions(selectedTs) {
    const sel = $('#edit-day');
    sel.replaceChildren();
    const keys = new Set();
    for (const ts of selectableDays()) {
      keys.add(dayKey(ts));
      sel.append(el('option', { value: dayKey(ts) }, dayOptionLabel(ts)));
    }
    if (selectedTs && !keys.has(dayKey(selectedTs))) {
      sel.prepend(el('option', { value: dayKey(selectedTs) }, dayOptionLabel(selectedTs)));
    }
    sel.value = dayKey(selectedTs || Date.now());
  }

  function setFormTime(ts) {
    const d = new Date(ts);
    fillDayOptions(ts);
    $('#edit-form').time.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    checkPastTime();
  }

  /** Startzeit aus Tag + Uhrzeit im Formular (oder null, wenn unvollständig). */
  function formStartsAt() {
    const form = $('#edit-form');
    if (!form.day.value || !form.time.value) return null;
    const [y, m, d] = form.day.value.split('-').map(Number);
    const [hh, mm] = form.time.value.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }

  /**
   * Wie der Server: Neue Startzeiten dürfen höchstens pastToleranceMs zurückliegen. Beim
   * Bearbeiten darf eine bereits vergangene Startzeit unverändert bleiben.
   */
  function isPastTime(ts) {
    const tolerance = state.config.pastToleranceMs ?? 3600000;
    const unchanged = state.editingStartsAt != null && Math.floor(ts / 60000) === Math.floor(state.editingStartsAt / 60000);
    return ts !== null && !unchanged && ts < Date.now() - tolerance;
  }

  function checkPastTime() {
    const past = isPastTime(formStartsAt());
    $('#time-hint').hidden = !past;
    $('#edit-submit').disabled = past;
    return past;
  }

  async function openEditDialog(round = null) {
    state.editingRoundId = round ? round.id : null;
    state.editingStartsAt = round ? round.startsAt : null;
    const form = $('#edit-form');
    form.reset();
    $('#edit-error').hidden = true;
    $('#edit-title').textContent = round ? 'Runde bearbeiten' : 'Runde ankündigen';
    $('#edit-submit').textContent = round ? 'Speichern' : 'Ankündigen';
    $('#quick-times').hidden = Boolean(round) || !selectableDays().some((ts) => dayKey(ts) === dayKey(Date.now()));
    if (round) {
      form.game.value = round.game;
      form.maxPlayers.value = round.maxPlayers ?? '';
      form.description.value = round.description;
      setFormTime(round.startsAt);
    } else {
      // nächste volle halbe Stunde – bzw. erster Event-Tag, wenn heute kein Event-Tag ist
      const next = new Date();
      next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);
      const days = selectableDays();
      if (!days.some((ts) => dayKey(ts) === dayKey(next.getTime())) && days[0] > Date.now()) {
        const first = new Date(days[0]);
        next.setFullYear(first.getFullYear(), first.getMonth(), first.getDate());
        next.setHours(14, 0, 0, 0);
      }
      setFormTime(next.getTime());
    }
    closeCombo();
    updateGameCover();
    $('#edit-dialog').showModal();
    api('GET', '/games').then(({ games, catalog }) => {
      state.catalog = catalog;
      state.gameHistory = games;
      updateGameCover();
    }).catch(() => {});
  }

  // ---- Spielauswahl (Combobox) --------------------------------------------

  const gameInput = () => $('#game-input');
  const comboOpen = () => !$('#game-list').hidden;

  /** Spieleliste + frei eingetippte Spiele aus früheren Runden, gefiltert nach Eingabe. */
  function comboOptions(query) {
    const q = query.trim().toLowerCase();
    const known = new Set(state.catalog.map((g) => g.name.toLowerCase()));
    const all = [
      ...state.catalog,
      ...state.gameHistory.filter((n) => !known.has(n.toLowerCase())).map((name) => ({ name, maxPlayers: null, cover: '' })),
    ];
    if (!q) return all;
    const hits = all.filter((g) => g.name.toLowerCase().includes(q));
    return [...hits.filter((g) => g.name.toLowerCase().startsWith(q)), ...hits.filter((g) => !g.name.toLowerCase().startsWith(q))];
  }

  function renderCombo() {
    const list = $('#game-list');
    const items = comboOptions(gameInput().value);
    state.combo.items = items;
    state.combo.index = Math.min(state.combo.index, items.length - 1);
    if (!items.length) return closeCombo();
    list.replaceChildren(...items.map((g, i) => el('li', {
      role: 'option',
      id: `game-opt-${i}`,
      class: i === state.combo.index ? 'active' : null,
      'aria-selected': i === state.combo.index ? 'true' : 'false',
      onmousedown: (e) => { e.preventDefault(); selectGame(g); },
    },
    gameIcon(g, 'combo-icon'),
    el('span', { class: 'combo-name' }, g.name),
    g.maxPlayers ? el('span', { class: 'combo-max' }, `max. ${g.maxPlayers}`) : null)));
    list.hidden = false;
    gameInput().setAttribute('aria-expanded', 'true');
    const active = state.combo.index >= 0 ? list.children[state.combo.index] : null;
    gameInput().setAttribute('aria-activedescendant', active ? active.id : '');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function closeCombo() {
    $('#game-list').hidden = true;
    state.combo.index = -1;
    gameInput().setAttribute('aria-expanded', 'false');
    gameInput().removeAttribute('aria-activedescendant');
  }

  function selectGame(g) {
    const form = $('#edit-form');
    gameInput().value = g.name;
    if (g.maxPlayers) form.maxPlayers.value = g.maxPlayers;
    closeCombo();
    updateGameCover();
  }

  /** Zeigt das Cover des gewählten Spiels klein im Eingabefeld. */
  function updateGameCover() {
    const g = catalogEntry(gameInput().value);
    const img = $('#game-cover');
    const show = Boolean(g && g.cover);
    img.hidden = !show;
    $('#game-combo').classList.toggle('has-cover', show);
    if (show && img.getAttribute('src') !== g.cover) img.src = g.cover;
  }

  function onComboKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!comboOpen()) { state.combo.index = -1; renderCombo(); }
      if (!state.combo.items.length) return;
      const n = state.combo.items.length;
      const i = state.combo.index;
      if (e.key === 'ArrowDown') state.combo.index = i < 0 ? 0 : (i + 1) % n;
      else state.combo.index = i < 0 ? n - 1 : (i - 1 + n) % n;
      renderCombo();
    } else if (e.key === 'Enter' && comboOpen() && state.combo.index >= 0) {
      e.preventDefault();
      selectGame(state.combo.items[state.combo.index]);
    } else if (e.key === 'Escape' && comboOpen()) {
      e.preventDefault();
      e.stopPropagation();
      closeCombo();
    }
  }

  async function submitEdit(e) {
    e.preventDefault();
    const form = e.target;
    if (checkPastTime()) return;
    const startsAt = formStartsAt();
    const body = {
      game: form.game.value,
      startsAt,
      maxPlayers: form.maxPlayers.value === '' ? null : Number(form.maxPlayers.value),
      description: form.description.value,
    };
    try {
      const { round } = state.editingRoundId
        ? await api('PATCH', `/rounds/${state.editingRoundId}`, body)
        : await api('POST', '/rounds', body);
      upsertRound(round);
      $('#edit-dialog').close();
      if (!state.editingRoundId) toast(`Runde „${round.game}“ angekündigt!`);
    } catch (err) {
      $('#edit-error').textContent = err.message;
      $('#edit-error').hidden = false;
    }
  }

  // ---- Chat ---------------------------------------------------------------

  const chatKey = (roundId) => (roundId === null || roundId === undefined ? 'global' : Number(roundId));

  async function loadMessages(key) {
    if (state.messages.has(key)) return;
    try {
      const { messages } = await api('GET', `/messages?round=${key}`);
      state.messages.set(key, messages);
      renderChat(key);
    } catch (e) { toast(e.message, 'error'); }
  }

  function chatContainer(key) {
    if (key === 'global') return $('[data-chat="global"]');
    const c = $('#rd-chat');
    return state.openRoundId === key ? c : null;
  }

  function messageNode(m) {
    const mine = state.me && m.user.id === state.me.id;
    const mention = state.me && !mine && m.text.toLowerCase().includes(`@${state.me.nickname.toLowerCase()}`);
    return el('div', { class: `msg${mine ? ' mine' : ''}${mention ? ' mention' : ''}`, dataset: { id: m.id } },
      el('div', { class: 'msg-head' },
        nick(m.user),
        el('time', { class: 'muted small', title: new Date(m.createdAt).toLocaleString('de-DE') }, fmtTime.format(m.createdAt)),
        state.adminPassword
          ? el('button', { class: 'icon-btn small', title: 'Nachricht löschen', onclick: () => adminDeleteMessage(m.id) }, '🗑')
          : null),
      el('div', { class: 'msg-text' }, m.text));
  }

  function renderChat(key) {
    const box = chatContainer(key);
    if (!box) return;
    const log = $('.chat-log', box);
    const msgs = state.messages.get(key);
    if (!msgs) {
      log.replaceChildren(el('p', { class: 'muted center' }, 'Lade …'));
      return;
    }
    log.replaceChildren(...(msgs.length ? msgs.map(messageNode) : [el('p', { class: 'muted center' }, 'Noch keine Nachrichten.')]));
    log.scrollTop = log.scrollHeight;
  }

  function appendMessage(m) {
    const key = chatKey(m.roundId);
    const list = state.messages.get(key);
    if (!list) return;
    list.push(m);
    if (list.length > 500) list.splice(0, list.length - 500);
    const box = chatContainer(key);
    if (!box) return;
    const log = $('.chat-log', box);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (list.length === 1) log.replaceChildren();
    log.append(messageNode(m));
    if (atBottom || m.user.id === state.me.id) log.scrollTop = log.scrollHeight;
  }

  async function sendMessage(e) {
    e.preventDefault();
    const form = e.target;
    const box = form.closest('.chat');
    const key = box.dataset.chat;
    const text = form.text.value.trim();
    if (!text) return;
    try {
      await api('POST', '/messages', { roundId: key === 'global' ? null : Number(key), text });
      form.text.value = '';
    } catch (err) { toast(err.message, 'error'); }
  }

  function chatVisible(key) {
    if (document.hidden) return false;
    if (key === 'global') return state.tab === 'chat';
    return state.openRoundId === key && $('#round-dialog').open;
  }

  function markRead(key) {
    state.unread.delete(key);
    updateBadges();
  }

  function updateBadges() {
    const g = state.unread.get('global') || 0;
    $('#global-unread').textContent = g;
    $('#global-unread').hidden = !g;
    renderRounds();
    updateTitle();
  }

  function updateTitle() {
    let total = 0;
    for (const n of state.unread.values()) total += n;
    document.title = `${total ? `(${total}) ` : ''}${state.config.brand.title}`;
  }

  async function adminDeleteMessage(id) {
    if (!confirm('Nachricht löschen?')) return;
    try { await api('DELETE', `/admin/messages/${id}`); } catch (e) { toast(e.message, 'error'); }
  }

  // ---- Spielerliste -------------------------------------------------------

  function renderPlayers() {
    const filter = $('#player-filter').value.trim().toLowerCase();
    const users = [...state.users.values()]
      .filter((u) => !filter || u.nickname.toLowerCase().includes(filter) || u.seat.toLowerCase().includes(filter))
      .sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.nickname.localeCompare(b.nickname, 'de'));
    $('#player-count').textContent = `${state.online.size} online · ${state.users.size} gesamt`;
    $('#player-list').replaceChildren(...users.map((u) => {
      const rounds = [...state.rounds.values()].filter((r) => r.startsAt > Date.now() - 3 * 3600000 && r.players.some((p) => p.id === u.id));
      return el('li', { class: 'card player' },
        el('div', {}, nick(u), rounds.length ? el('div', { class: 'muted small' }, rounds.map((r) => r.game).join(', ')) : null),
        el('div', { class: 'player-right' },
          u.seat ? el('span', { class: 'seat big', title: 'Sitzplatz' }, `💺 ${u.seat}`) : el('span', { class: 'muted small' }, 'kein Platz'),
          state.adminPassword && u.id !== state.me.id
            ? el('button', { class: 'icon-btn', title: 'Nutzer löschen (gibt Nickname frei)', onclick: () => adminDeleteUser(u) }, '🗑')
            : null));
    }));
  }

  async function adminDeleteUser(u) {
    if (!confirm(`Nutzer „${u.nickname}“ löschen? Seine Runden und Nachrichten werden ebenfalls gelöscht, der Nickname wird frei.`)) return;
    try { await api('DELETE', `/admin/users/${u.id}`); } catch (e) { toast(e.message, 'error'); }
  }

  // ---- Benachrichtigungen -------------------------------------------------

  let audioCtx = null;
  function beep() {
    if (!state.settings.n_sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      for (const [i, f] of [[0, 880], [1, 1320]]) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.11);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + i * 0.12);
        o.stop(t + i * 0.12 + 0.12);
      }
    } catch { /* kein Audio */ }
  }

  const canSystemNotify = () => 'Notification' in window && window.isSecureContext;

  function notify(title, body, { roundId = null, tag } = {}) {
    toast(`${title}${body ? ` – ${body}` : ''}`, 'info', roundId !== null ? () => openRoundDialog(roundId) : null);
    beep();
    if (canSystemNotify() && Notification.permission === 'granted' && document.hidden) {
      try {
        const n = new Notification(title, { body, tag, icon: '/icon.svg' });
        n.onclick = () => {
          window.focus();
          if (roundId !== null) openRoundDialog(roundId);
          n.close();
        };
      } catch { /* z.B. Android Chrome ohne Service Worker */ }
    }
  }

  function renderNotifyStatus() {
    const status = $('#notify-status');
    const btn = $('#notify-enable');
    btn.hidden = true;
    if (!('Notification' in window)) {
      status.textContent = 'Dein Browser unterstützt keine System-Benachrichtigungen. Du bekommst Hinweise innerhalb der Seite.';
    } else if (!window.isSecureContext) {
      status.textContent = 'System-Benachrichtigungen gehen nur über HTTPS. Du bekommst Hinweise (mit Ton) innerhalb der Seite und im Tab-Titel.';
    } else if (Notification.permission === 'granted') {
      status.textContent = 'System-Benachrichtigungen sind aktiv, wenn der Tab im Hintergrund ist.';
    } else if (Notification.permission === 'denied') {
      status.textContent = 'System-Benachrichtigungen wurden im Browser blockiert. Hinweise erscheinen innerhalb der Seite.';
    } else {
      status.textContent = 'Erlaube Benachrichtigungen, um auch bei Tab im Hintergrund informiert zu werden.';
      btn.hidden = false;
    }
  }

  function checkReminders() {
    if (!state.me) return;
    const now = Date.now();
    for (const r of state.rounds.values()) {
      const key = `${r.id}@${r.startsAt}`;
      const diff = r.startsAt - now;
      if (diff <= 0 || diff > REMINDER_MINUTES * 60000 || state.reminded.has(key)) continue;
      if (!r.players.some((p) => p.id === state.me.id)) continue;
      state.reminded.add(key);
      storage.set('gf.reminded', [...state.reminded].slice(-200));
      if (state.settings.n_reminder) {
        notify(`${r.game} startet gleich`, `${relative(r.startsAt)} · ${r.players.length} Spieler`, { roundId: r.id, tag: `rem-${r.id}` });
      }
    }
  }

  // ---- Socket -------------------------------------------------------------

  function wasInvolved(round) {
    return isMine(round) || round.host.id === state.me.id;
  }

  function onRoundEvent({ round, change }) {
    const prev = state.rounds.get(round.id);
    upsertRound(round);
    if (!state.me) return;
    const me = state.me.id;
    const actor = change.user;

    if (change.promoted && change.promoted.includes(me)) {
      notify(`Du bist nachgerückt: ${round.game}`, `Du bist jetzt bei der Runde um ${whenLabel(round.startsAt)} dabei.`, { roundId: round.id });
      return;
    }
    if (!actor || actor.id === me) return;
    const s = state.settings;
    switch (change.type) {
      case 'create':
        if (s.n_newRound) notify(`Neue Runde: ${round.game}`, `${actor.nickname} · ${whenLabel(round.startsAt)}`, { roundId: round.id });
        break;
      case 'join':
      case 'waitlist':
        if (s.n_join && wasInvolved(round)) {
          const txt = change.type === 'join' ? 'ist dabei' : 'steht auf der Warteliste';
          const cap = round.maxPlayers ? ` (${round.players.length}/${round.maxPlayers})` : '';
          notify(`${round.game}: ${actor.nickname} ${txt}${cap}`, '', { roundId: round.id });
        }
        break;
      case 'leave':
        if (s.n_join && wasInvolved(round)) notify(`${round.game}: ${actor.nickname} ist raus`, '', { roundId: round.id });
        break;
      case 'update':
        if (wasInvolved(round) && prev && prev.startsAt !== round.startsAt) {
          notify(`${round.game} wurde verschoben`, `Neue Zeit: ${whenLabel(round.startsAt)}`, { roundId: round.id });
        }
        break;
      default:
    }
  }

  function onRoundDeleted({ round, user }) {
    const involved = state.rounds.has(round.id) && wasInvolved(state.rounds.get(round.id));
    removeRound(round.id);
    if (involved && user && user.id !== state.me.id) {
      notify(`${round.game} wurde abgesagt`, `von ${user.nickname}`);
    }
  }

  function onMessage(m) {
    const key = chatKey(m.roundId);
    appendMessage(m);
    if (!state.me || m.user.id === state.me.id) return;
    if (chatVisible(key)) return;

    const mention = m.text.toLowerCase().includes(`@${state.me.nickname.toLowerCase()}`);
    if (key === 'global') {
      state.unread.set(key, (state.unread.get(key) || 0) + 1);
      updateBadges();
      if (state.settings.n_global || mention) notify(`${m.user.nickname} (Chat)`, m.text.slice(0, 120));
      return;
    }
    const round = state.rounds.get(key);
    if (!round || !(wasInvolved(round) || mention)) return;
    state.unread.set(key, (state.unread.get(key) || 0) + 1);
    updateBadges();
    if (state.settings.n_chat || mention) notify(`${m.user.nickname} in ${round.game}`, m.text.slice(0, 120), { roundId: key });
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;
    let everConnected = false;

    socket.on('connect', () => {
      $('#conn-banner').hidden = true;
      if (everConnected) resync();
      everConnected = true;
    });
    socket.on('disconnect', () => { $('#conn-banner').hidden = false; });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') logout(false);
      else $('#conn-banner').hidden = false;
    });
    socket.on('round', onRoundEvent);
    socket.on('round:deleted', onRoundDeleted);
    socket.on('message', onMessage);
    socket.on('message:deleted', ({ id, roundId }) => {
      const key = chatKey(roundId);
      const list = state.messages.get(key);
      if (!list) return;
      state.messages.set(key, list.filter((m) => m.id !== id));
      renderChat(key);
    });
    socket.on('presence:all', (ids) => {
      state.online = new Set(ids);
      renderRounds();
      if (state.tab === 'players') renderPlayers();
    });
    socket.on('presence', ({ id, online }) => {
      if (online) state.online.add(id); else state.online.delete(id);
      if (state.tab === 'players') renderPlayers();
    });
    socket.on('user', (u) => {
      state.users.set(u.id, u);
      if (state.me && u.id === state.me.id) setMe(u);
      if (state.tab === 'players') renderPlayers();
    });
    socket.on('catalog', (catalog) => {
      state.catalog = catalog;
      renderRounds();
      if ($('#games-dialog').open) renderGamesAdmin();
      if (state.openRoundId !== null && $('#round-dialog').open) renderRoundDialog();
    });
    socket.on('user:deleted', ({ id }) => {
      state.users.delete(id);
      state.online.delete(id);
      if (state.tab === 'players') renderPlayers();
    });
  }

  async function resync() {
    const [{ rounds }, { users, online }, { catalog }] = await Promise.all([
      api('GET', '/rounds'), api('GET', '/users'), api('GET', '/games'),
    ]);
    state.catalog = catalog;
    state.rounds = new Map(rounds.map((r) => [r.id, r]));
    state.users = new Map(users.map((u) => [u.id, u]));
    // Online-Status kommt bei bestehender Verbindung aktuell per 'presence:all'
    if (!state.socket || !state.socket.connected) state.online = new Set(online);
    // Chat-Verläufe neu laden
    const keys = [...state.messages.keys()];
    state.messages.clear();
    renderRounds();
    renderPlayers();
    for (const k of keys) if (k === 'global' || state.rounds.has(k)) loadMessages(k);
    if (state.openRoundId !== null) {
      if (state.rounds.has(state.openRoundId)) renderRoundDialog();
      else $('#round-dialog').close();
    }
  }

  // ---- Toasts -------------------------------------------------------------

  function toast(text, type = 'info', onclick = null) {
    const t = el('div', { class: `toast ${type}${onclick ? ' clickable' : ''}`, role: 'status' }, text);
    t.addEventListener('click', () => { if (onclick) onclick(); t.remove(); });
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), 5500);
    setTimeout(() => t.remove(), 6000);
  }

  // ---- Session ------------------------------------------------------------

  function setMe(user) {
    state.me = user;
    $('#me-nick').textContent = user.nickname;
    $('#me-seat').textContent = user.seat || '';
    $('#me-seat').hidden = !user.seat;
  }

  function applyBrand(brand) {
    const logos = [$('#login-logo'), $('#top-logo')];
    for (const img of logos) {
      img.hidden = !brand.logo;
      if (brand.logo) { img.src = brand.logo; img.alt = brand.eventName || brand.appName; }
    }
    $('#top-icon').hidden = Boolean(brand.logo);
    $('#login-title').textContent = brand.appName;
    $('#top-title').textContent = brand.appName;
    $('#login-event').textContent = [brand.eventName, eventDates(brand)].filter(Boolean).join(' · ');
    $('#login-event').hidden = !brand.eventName;
    $('#login-tagline').textContent = brand.tagline;
    const site = $('#login-website');
    site.hidden = !brand.websiteUrl;
    if (brand.websiteUrl) {
      site.href = brand.websiteUrl;
      site.textContent = brand.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    for (const input of $$('.seat-input')) input.placeholder = brand.seatHint;
    updateTitle();
  }

  /** "6.–8. November 2026" aus eventStart/eventEnd */
  function eventDates({ eventStart, eventEnd }) {
    if (!eventStart) return '';
    const [a, b] = [eventStart, eventEnd || eventStart].map((d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); });
    const full = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
    if (a.getTime() === b.getTime()) return full.format(a);
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()}.–${full.format(b)}`;
    return `${new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' }).format(a)} – ${full.format(b)}`;
  }

  const shareUrl = () => state.config.brand.publicUrl || location.origin;

  async function loadConfig() {
    try {
      state.config = await api('GET', '/config');
      applyBrand(state.config.brand);
    } catch { /* Standardwerte behalten */ }
  }

  async function startApp() {
    try {
      const [{ user }] = await Promise.all([api('GET', '/me'), loadConfig()]);
      setMe(user);
    } catch (e) {
      if (e.status === 401) return showLogin();
      toast(e.message, 'error');
      setTimeout(startApp, 3000);
      return;
    }
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    connectSocket();
    await resync();
    await loadMessages('global');
    renderAdmin();
    checkReminders();
  }

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
  }

  function logout(ask = true) {
    if (ask && !confirm('Wirklich abmelden? Ohne deinen Geräte-Code kannst du diesen Nickname danach nicht mehr verwenden (nur ein Admin kann ihn freigeben).')) return;
    storage.remove('gf.token');
    state.token = null;
    location.reload();
  }

  async function login(body, errorEl) {
    errorEl.hidden = true;
    try {
      const { user, token } = await api('POST', '/login', body);
      state.token = token;
      storage.set('gf.token', token);
      setMe(user);
      startApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  // ---- Einstellungen ------------------------------------------------------

  function openSettings() {
    const form = $('#settings-form');
    form.seat.value = state.me.seat;
    for (const k of Object.keys(DEFAULT_SETTINGS)) form[k].checked = state.settings[k];
    $('#device-code').value = state.token;
    $('#share-url').textContent = shareUrl();
    $('#share-qr').src = `/api/qr.svg?text=${encodeURIComponent(shareUrl())}`;
    $('#beamer-link').hidden = !state.config.publicBoard;
    renderNotifyStatus();
    renderAdmin();
    $('#settings-dialog').showModal();
  }

  function renderAdmin() {
    $('#admin-section').hidden = !state.config.adminEnabled;
    $('#admin-status').textContent = state.adminPassword ? 'Du bist als Admin angemeldet.' : 'Admins können Runden, Nachrichten und Nutzer löschen.';
    $('#admin-password').hidden = Boolean(state.adminPassword);
    $('#admin-toggle').textContent = state.adminPassword ? 'Admin abmelden' : 'Anmelden';
    $('#manage-games').hidden = !state.adminPassword;
  }

  // ---- Spiele verwalten (Admin) --------------------------------------------

  let coverTarget = null;

  async function adminGame(method, url, body) {
    try {
      await api(method, url, body);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  function renderGamesAdmin() {
    $('#game-admin-list').replaceChildren(...state.catalog.map((g) => {
      const save = (field) => (e) => {
        const value = field === 'maxPlayers' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
        adminGame('PATCH', `/admin/games/${g.id}`, { [field]: value });
      };
      return el('li', { class: 'game-admin' },
        el('button', {
          type: 'button',
          class: 'cover-slot',
          title: 'Cover hochladen',
          onclick: () => { coverTarget = g.id; $('#cover-file').click(); },
        }, g.cover ? gameIcon(g, 'slot-img') : el('span', {}, '＋ Cover')),
        el('div', { class: 'game-admin-fields' },
          el('input', { value: g.name, maxlength: 60, 'aria-label': 'Name', onchange: save('name') }),
          el('div', { class: 'row' },
            el('input', { type: 'number', min: 2, max: 256, value: g.maxPlayers ?? '', placeholder: 'Max.', 'aria-label': 'Max. Spieler', onchange: save('maxPlayers') }),
            el('input', { value: g.cover.startsWith('/covers/') ? '' : g.cover, placeholder: 'oder Bild-URL', 'aria-label': 'Cover-URL', onchange: save('cover') }))),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Spiel entfernen',
          onclick: () => confirm(`„${g.name}“ aus der Liste entfernen?`) && adminGame('DELETE', `/admin/games/${g.id}`),
        }, '🗑'));
    }));
  }

  async function cacheCovers() {
    const btn = $('#cache-covers');
    btn.disabled = true;
    btn.textContent = 'Lade Logos …';
    try {
      const { cached, failed } = await api('POST', '/admin/games/cache-covers');
      if (!cached.length && !failed.length) toast('Alle Logos sind bereits lokal gespeichert.');
      else toast(`${cached.length} Logos gespeichert${failed.length ? `, ${failed.length} nicht erreichbar (kein Internet?)` : ''}.`, failed.length ? 'error' : 'info');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Logos herunterladen';
    }
  }

  async function openGamesAdmin() {
    try { state.catalog = (await api('GET', '/games')).catalog; } catch { /* alte Liste */ }
    renderGamesAdmin();
    $('#games-dialog').showModal();
  }

  async function uploadCover(file) {
    try {
      const res = await fetch(`/api/admin/games/${coverTarget}/cover`, {
        method: 'POST',
        headers: { 'content-type': file.type, 'x-token': state.token, 'x-admin-password': state.adminPassword },
        body: file,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload fehlgeschlagen.');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function toggleAdmin() {
    if (state.adminPassword) {
      state.adminPassword = '';
      sessionStorage.removeItem('gf.admin');
    } else {
      const pw = $('#admin-password').value;
      state.adminPassword = pw;
      try {
        await api('POST', '/admin/check');
        sessionStorage.setItem('gf.admin', pw);
        $('#admin-password').value = '';
      } catch (e) {
        state.adminPassword = '';
        toast(e.message, 'error');
      }
    }
    renderAdmin();
    renderRounds();
    renderPlayers();
    for (const k of state.messages.keys()) renderChat(k);
    if (state.openRoundId !== null && $('#round-dialog').open) renderRoundDialog();
  }

  async function saveSettings(e) {
    e.preventDefault();
    const form = e.target;
    for (const k of Object.keys(DEFAULT_SETTINGS)) state.settings[k] = form[k].checked;
    storage.set('gf.settings', state.settings);
    const seat = form.seat.value.trim();
    if (seat !== state.me.seat) {
      try {
        const { user } = await api('PATCH', '/me', { seat });
        setMe(user);
      } catch (err) { toast(err.message, 'error'); return; }
    }
    $('#settings-dialog').close();
  }

  // ---- Tabs ---------------------------------------------------------------

  function switchTab(tab) {
    state.tab = tab;
    for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of $$('.tab-panel')) p.hidden = p.id !== `tab-${tab}`;
    if (tab === 'chat') {
      markRead('global');
      const log = $('[data-chat="global"] .chat-log');
      log.scrollTop = log.scrollHeight;
      $('[data-chat="global"] input').focus();
    }
    if (tab === 'players') renderPlayers();
  }

  // ---- Events -------------------------------------------------------------

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    login({ nickname: f.nickname.value, seat: f.seat.value, token: state.token }, $('#login-error'));
  });
  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    login({ token: e.target.token.value }, $('#code-error'));
  });
  $('#toggle-code').addEventListener('click', () => {
    const showCode = $('#code-form').hidden;
    $('#code-form').hidden = !showCode;
    $('#login-form').hidden = showCode;
    $('#toggle-code').textContent = showCode ? 'Zurück: neuen Nickname wählen' : 'Ich habe schon einen Nickname auf einem anderen Gerät';
  });

  for (const b of $$('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#new-round').addEventListener('click', () => openEditDialog());
  $('#manage-games').addEventListener('click', openGamesAdmin);
  $('#cache-covers').addEventListener('click', cacheCovers);
  $('#rd-cover').addEventListener('error', () => { $('#rd-cover').hidden = true; });
  $('#game-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ok = await adminGame('POST', '/admin/games', {
      name: f.elements.namedItem('name').value, maxPlayers: f.maxPlayers.value === '' ? null : Number(f.maxPlayers.value),
    });
    if (ok) f.reset();
  });
  $('#cover-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && coverTarget !== null) uploadCover(file);
  });
  gameInput().addEventListener('input', (e) => {
    const g = catalogEntry(e.target.value);
    const form = $('#edit-form');
    if (g && g.maxPlayers && !form.maxPlayers.value) form.maxPlayers.value = g.maxPlayers;
    state.combo.index = -1;
    renderCombo();
    updateGameCover();
  });
  gameInput().addEventListener('focus', () => renderCombo());
  gameInput().addEventListener('click', () => { if (!comboOpen()) renderCombo(); });
  gameInput().addEventListener('blur', () => closeCombo());
  gameInput().addEventListener('keydown', onComboKey);
  $('#game-cover').addEventListener('error', () => {
    $('#game-cover').hidden = true;
    $('#game-combo').classList.remove('has-cover');
  });
  $('#edit-dialog').addEventListener('cancel', (e) => {
    if (comboOpen()) { e.preventDefault(); closeCombo(); }
  });
  $('#round-filter').addEventListener('input', renderRounds);
  $('#only-mine').addEventListener('change', renderRounds);
  $('#player-filter').addEventListener('input', renderPlayers);
  $('#me-button').addEventListener('click', openSettings);
  $('#edit-form').addEventListener('submit', submitEdit);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#logout').addEventListener('click', () => logout());
  $('#admin-toggle').addEventListener('click', toggleAdmin);
  $('#copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.token);
      toast('Code kopiert.');
    } catch {
      $('#device-code').select();
    }
  });
  $('#notify-enable').addEventListener('click', async () => {
    await Notification.requestPermission();
    renderNotifyStatus();
  });

  $('#edit-day').addEventListener('change', checkPastTime);
  $('#edit-form').time.addEventListener('input', checkPastTime);

  for (const b of $$('#quick-times .chip')) {
    b.addEventListener('click', () => {
      const ts = Date.now() + Number(b.dataset.in) * 60000;
      setFormTime(Math.ceil(ts / 300000) * 300000);
    });
  }

  for (const f of $$('.chat-form')) f.addEventListener('submit', sendMessage);

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }
  $('#round-dialog').addEventListener('close', () => { state.openRoundId = null; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.tab === 'chat') markRead('global');
    if (state.openRoundId !== null && $('#round-dialog').open) markRead(state.openRoundId);
  });

  // Zeiten ("in 5 min") aktuell halten + Erinnerungen
  setInterval(() => {
    if (!state.me) return;
    renderRounds();
    if (state.openRoundId !== null && $('#round-dialog').open) {
      $('#rd-meta').firstChild.lastChild.textContent = ` (${relative(state.rounds.get(state.openRoundId).startsAt)})`;
    }
    checkReminders();
  }, 30000);

  if (state.token) startApp();
  else loadConfig().then(showLogin);
})();
