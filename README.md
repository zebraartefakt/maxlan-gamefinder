# 🎮 Gamefinder für LAN-Partys

Mitspieler finden auf der LAN-Party: Teilnehmer kündigen Spielrunden an (z.B. „Samstag 14:00 FlatOut 2, max. 8 Spieler“), andere treten mit einem Klick bei und alle stimmen sich im Chat ab. Die App lässt sich pro Veranstaltung **branden**. Mitgeliefert ist ein Profil für die [Maxlan](https://www.maxlan.de).

## Funktionen

- **Anmeldung nur mit Nickname**, optional mit Sitzplatz, ohne Passwort. Auf dem Handy meldet man sich mit demselben Nickname per **QR-Code** an (unter *Profil & Einstellungen → Auf dem Handy anmelden*), ohne etwas einzutippen.
- **Runden ankündigen**:
  - Spiel aus der **Spieleliste mit Logos** wählen oder frei eintippen. Die Auswahlliste filtert beim Tippen, lässt sich per Pfeiltasten bedienen und füllt die Spielerzahl vor. Mitgeliefert sind 36 typische LAN-Spiele
  - Tag (die **Event-Tage** aus dem Branding) und Uhrzeit, mit Schnellwahl „jetzt / in 15 min / …“
  - optional ein **Spielmodus** (z.B. „Instagib“, max. 24 Zeichen; früher genutzte Modi werden vorgeschlagen), **Max. Spieler** und eine Beschreibung
- **Beitreten und Verlassen.** Ist die Runde voll, kommt man auf die **Warteliste** und rückt automatisch nach, sobald ein Platz frei wird.
- **Chat**: ein globaler Chat und ein eigener Chat pro Runde, mit `@Nickname`-Erwähnungen.
- **Spielerliste** mit Sitzplätzen und Online-Status.
- **Benachrichtigungen**, einzeln abschaltbar:
  - neue Runde angekündigt
  - jemand tritt deiner Runde bei oder verlässt sie
  - du bist von der Warteliste nachgerückt
  - Runde verschoben oder abgesagt
  - neue Chat-Nachrichten
  - Erinnerung 10 Minuten vor Start

  Die Hinweise erscheinen in der Seite (mit Ton und Zähler im Tab-Titel). Über HTTPS gibt es zusätzlich System-Benachrichtigungen.
- **QR-Code zum Teilen** unter *Profil & Einstellungen*.
- **Aushang** (`/aushang`): eine druckfertige A4-Seite mit Logo, großem QR-Code und kurzer Anleitung zum Auslegen auf den Tischen.
- **Beamer-Ansicht** (`/beamer`): eine Vollbild-Übersicht der nächsten Runden mit Spielmodus, freien Plätzen, Uhrzeit, QR-Code und Anzahl der Spieler online.
  - Sie aktualisiert sich alle 10 Sekunden und lädt sich nach einem Server-Update selbst neu.
  - Pro Seite zeigt sie so viele Runden, wie auf den Bildschirm passen. Bei mehr Runden gibt es höchstens eine zweite Seite: Seite 1 steht 30 Sekunden, Seite 2 zehn Sekunden. Was auch dort nicht mehr passt, wird als „X weitere Runden in der App“ angezeigt. Ein Klick schaltet den Vollbildmodus um. Die Ansicht braucht keinen Login.
- **Admin-Modus** (per Passwort):
  - Spieleliste pflegen: Spiele anlegen, Max. Spieler festlegen, Cover hochladen oder als URL eintragen
  - Runden, Nachrichten und Nutzer löschen. Das Löschen eines Nutzers gibt auch dessen Nickname wieder frei.

## Starten

### Mit Docker (empfohlen)

```bash
docker compose up -d --build
```

Passe vorher in `docker-compose.yml` die Werte `PUBLIC_URL` (die Adresse, unter der Teilnehmer die App erreichen) und `ADMIN_PASSWORD` an. Die Daten liegen in `./data`.

### Ohne Docker

Voraussetzung: Node.js ≥ 22.13 (nutzt das eingebaute SQLite, keine nativen Abhängigkeiten).

```bash
npm install
ADMIN_PASSWORD=geheim PUBLIC_URL=http://192.168.1.10:3000 npm run start:maxlan
# oder neutral ohne Veranstaltungs-Branding:
npm start
```

### Konfiguration (Umgebungsvariablen)

| Variable              | Standard                  | Bedeutung                                                          |
|-----------------------|---------------------------|--------------------------------------------------------------------|
| `BRAND_DIR`           | `brands/default`          | Branding-Ordner (siehe unten)                                      |
| `PUBLIC_URL`          | *(Adresse im Browser)*    | Adresse für QR-Codes, Aushang und Beamer. Überschreibt `publicUrl` |
| `ADMIN_PASSWORD`      | *(leer)*                  | Passwort für den Admin-Modus. Leer = deaktiviert                   |
| `PUBLIC_BOARD`        | `true`                    | `false` deaktiviert die Beamer-Ansicht ohne Login                  |
| `CACHE_COVERS`        | `true`                    | Logos mit http(s)-Adresse beim Start lokal speichern               |
| `PORT` / `HOST`       | `3000` / `0.0.0.0`        | Port und Bind-Adresse                                              |
| `DATA_DIR`            | `./data`                  | Ordner für Datenbank und hochgeladene Cover                        |
| `DB_FILE`             | `$DATA_DIR/gamefinder.db` | Pfad zur Datenbank                                                 |
| `TLS_CERT`, `TLS_KEY` | *(leer)*                  | Zertifikat und Key, um direkt HTTPS anzubieten                     |

## Branding

Ein Branding ist ein Ordner unter `brands/`, z.B. `brands/maxlan/`:

```
brands/maxlan/
├── brand.json    # Name, Texte, Farben, Event-Tage
├── logo.png      # Logo (SVG oder PNG, idealerweise mit transparentem Hintergrund)
├── favicon.png   # Browser-Icon
├── games.json    # Spieleliste, wird beim ersten Start übernommen
└── covers/       # optional: Cover-Bilder für games.json
```

`brand.json` (alle Felder optional):

```json
{
  "appName": "Gamefinder",
  "eventName": "Maxlan 33",
  "tagline": "Mitspieler gesucht? Hier findest du deine nächste Runde.",
  "websiteUrl": "https://www.maxlan.de",
  "publicUrl": "http://192.168.1.10:3000",
  "logo": "logo.png",
  "favicon": "favicon.png",
  "eventStart": "2026-11-06",
  "eventEnd": "2026-11-08",
  "seatHint": "z.B. Tisch 4",
  "colors": {
    "bg": "#000000", "surface": "#121318", "surface2": "#1c1e26", "border": "#2c2f3a",
    "text": "#eeeeee", "muted": "#9a9cab",
    "accent": "#a2271f", "accent2": "#e25a4e", "accentText": "#ffffff",
    "ok": "#35d49a", "warn": "#ffb547", "danger": "#ff5c7a"
  }
}
```

- **Logo**: Es erscheint auf der Anmeldeseite, in der Kopfzeile, auf dem Aushang und in der Beamer-Ansicht, immer auf dunklem Hintergrund (`bg`).
- **Event-Tage** (`eventStart`/`eventEnd`): Beim Ankündigen stehen nur diese Tage zur Auswahl. Ohne Angabe sind es die nächsten 5 Tage.
- **Farben**: `accent` ist die Markenfarbe für Buttons, Hervorhebungen und den Beamer-Glow. `accent2` ist eine hellere Variante für Text und Links, damit sie auf dunklem Grund lesbar bleiben.
- **games.json**: Eine Liste von `{ "name": "...", "maxPlayers": 8, "steamAppId": 730 }`.
  - Statt `steamAppId` geht auch `"cover": "/brand/covers/datei.jpg"` oder eine `https://…`-Adresse.
  - Ändert sich die Datei, ergänzt der Server beim nächsten Start fehlende Spiele und fehlende Logos. Was im Admin-Modus geändert wurde, bleibt erhalten.

### Spiele-Logos

Bei Spielen mit `steamAppId` wird das Steam-Headerbild als Logo verwendet. Für Spiele ohne Steam-Seite (z.B. Warcraft III, StarCraft, Diablo II) steht in `games.json` eine `cover`-Adresse, meist ein Bild von Wikimedia. Hochformat-Cover und sehr breite Logos werden vollständig angezeigt statt beschnitten. Der Server lädt alle Logos, die als Internet-Adresse hinterlegt sind, **beim Start herunter und speichert sie lokal** (`DATA_DIR/covers`). So funktionieren sie auf der LAN auch ohne Internet.

Den Server also einmal **vor** der Veranstaltung mit Internetzugang starten, oder im Admin-Modus unter *Spiele verwalten → Logos herunterladen* nachholen. Muss der Server über einen HTTP-Proxy ins Internet, zusätzlich `NODE_USE_ENV_PROXY=1` setzen. Spiele ohne Logo zeigen ihre Initialen. Eigene Logos lassen sich im Admin-Modus hochladen.

Für eine neue Veranstaltung den Ordner kopieren, anpassen und `BRAND_DIR` darauf zeigen lassen.

> **Maxlan-Profil:** Logo (aus dem Seitenbanner freigestellt), Favicon und Farben (Rot `#a2271f` auf Schwarz) stammen von [maxlan.de](https://www.maxlan.de). Eingetragen ist die **Maxlan 33** (6.–8. November 2026, Stadthalle Haselünne). Für die nächste Maxlan in `brands/maxlan/brand.json` nur `eventName`, `eventStart` und `eventEnd` anpassen. Da es keine Sitzplatzreservierung gibt, lautet der Sitzplatz-Hinweis „z.B. Tisch 4“.

## Betrieb im LAN vs. im Internet

- **Nur im LAN:** starten, `PUBLIC_URL` auf die LAN-Adresse setzen, `/aushang` ausdrucken und `/beamer` auf dem Beamer öffnen. Die App braucht kein Internet.
- **Im Internet:** hinter einen Reverse-Proxy mit HTTPS stellen (z.B. Caddy: `gamefinder.example.de { reverse_proxy localhost:3000 }`). WebSockets müssen durchgereicht werden. Wenn die Spielerliste nicht öffentlich sichtbar sein soll, `PUBLIC_BOARD=false` setzen.

### Browser-Benachrichtigungen im LAN

Browser erlauben System-Benachrichtigungen nur über HTTPS. Über `http://192.168.x.x` gibt es daher nur die Hinweise innerhalb der Seite. Für echte System-Benachrichtigungen im LAN:

1. Ein Zertifikat erzeugen, z.B. mit [mkcert](https://github.com/FiloSottile/mkcert): `mkcert 192.168.1.10 gamefinder.lan`
2. `TLS_CERT`/`TLS_KEY` setzen (siehe `docker-compose.yml`).
3. Die Teilnehmer müssen dem Zertifikat einmal vertrauen: entweder die mkcert-CA installieren oder die Browser-Warnung bestätigen.

## Entwicklung

```bash
npm run dev    # Server mit Auto-Reload
npm test       # API-Tests
```

Aufbau:

- `src/server.js`: Express-API, Socket.IO-Events, Validierung, Seiten-Auslieferung
- `src/brand.js`: Laden des Brandings (`brand.json`, Farben → `/brand.css`)
- `src/db.js`: SQLite-Schema und Datenzugriff
- `public/`: Frontend in reinem HTML/CSS/JS ohne Build-Schritt. `index.html` ist die App, dazu `beamer.html` und `aushang.html`
