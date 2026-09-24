# Gamefinder für LAN-Partys

Webapp, mit der Teilnehmer einer LAN-Party Spielrunden ankündigen, beitreten und im Chat abstimmen. Erster Einsatz: Maxlan (`brands/maxlan/`).

## Workflow

- Änderungen per Pull Request nach `main` und den PR **nach erfolgreichen Tests direkt mergen**. Das hat der Projektinhaber ausdrücklich so festgelegt.
- Vor jedem Push `npm test` ausführen. UI-Änderungen zusätzlich im Browser prüfen (Playwright ist vorinstalliert).
- Sprache der App, Texte, Commit-Nachrichten und README: Deutsch.

## Aufbau

- `src/server.js`: Express-API, Socket.IO-Events, Validierung, Auslieferung der Seiten (HTML-Platzhalter wie `%TITLE%` werden serverseitig ersetzt)
- `src/brand.js`: lädt `brands/<name>/brand.json` und erzeugt `/brand.css` aus den Farben
- `src/db.js`: SQLite über das eingebaute `node:sqlite` (Node ≥ 22.13), keine nativen Abhängigkeiten
- `public/`: Frontend ohne Build-Schritt. `index.html`/`app.js` ist die App, dazu `beamer.html` und `aushang.html`
- `brands/`: Branding-Profile (Logo, Farben, Event-Tage, `games.json` mit `steamAppId`)
- `test/api.test.js`: API-Tests mit `node --test`

## Hinweise

- Spiele-Logos (Steam-Headerbilder) werden nicht ins Repo eingecheckt. Der Server lädt sie zur Laufzeit und speichert sie in `DATA_DIR/covers`.
- Neue Farben immer über CSS-Variablen (`--accent`, `--accent-2` …) verwenden, damit das Branding greift. `--accent-2` ist für Text und Links auf dunklem Grund gedacht.
