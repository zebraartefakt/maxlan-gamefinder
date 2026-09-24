# 🎮 MaxLAN Gamefinder

Mitspieler finden auf der LAN-Party: Teilnehmer kündigen Spielrunden an (z.B. „Samstag 14:00 FlatOut 2, max. 8 Spieler“), andere treten mit einem Klick bei und alle stimmen sich im Chat ab.

## Funktionen

- **Anmeldung nur mit Nickname**, optional mit Sitzplatz, ohne Passwort. Der Nickname ist an den Browser gebunden. Über den **Geräte-Code** (unter *Profil & Einstellungen*) kann man sich zusätzlich z.B. am Handy anmelden.
- **Runden ankündigen** mit Spiel (mit Vorschlägen aus bisherigen Runden), Tag und Uhrzeit (Schnellwahl „jetzt / in 15 min / …“), optionaler **Max. Spielerzahl** und Beschreibung.
- **Beitreten und Verlassen.** Ist die Runde voll, kommt man auf die **Warteliste** und rückt automatisch nach, sobald ein Platz frei wird.
- Der Ersteller kann die Runde **bearbeiten oder absagen**.
- **Chat**: ein globaler Chat für alle und ein eigener Chat pro Runde, z.B. um die Server-IP abzusprechen. Mit `@Nickname` erwähnt man jemanden gezielt.
- **Spielerliste** mit Sitzplätzen, Online-Status und den Runden, in denen jemand ist.
- **Benachrichtigungen**, einzeln abschaltbar:
  - neue Runde angekündigt
  - jemand tritt deiner Runde bei oder verlässt sie
  - du bist von der Warteliste nachgerückt
  - Runde verschoben oder abgesagt
  - neue Chat-Nachrichten
  - Erinnerung 10 Minuten vor Start

  Die Hinweise erscheinen immer in der Seite (mit Ton und Zähler im Tab-Titel). **System-Benachrichtigungen** des Browsers gibt es zusätzlich, wenn die Seite über HTTPS (oder `localhost`) aufgerufen wird (siehe unten).
- **Live-Updates** über WebSockets, ohne Neuladen.
- **Admin-Modus** (optional, per Passwort): Runden, Nachrichten und Nutzer löschen. Das Löschen eines Nutzers gibt auch dessen Nickname wieder frei, falls jemand seinen Browser-Speicher verloren hat.

## Starten

### Mit Docker (empfohlen)

```bash
docker compose up -d --build
```

Danach ist die App unter `http://<IP-des-Servers>:3000` erreichbar. Die Daten liegen in `./data`. Setze in `docker-compose.yml` das `ADMIN_PASSWORD`.

### Ohne Docker

Voraussetzung: Node.js ≥ 22.13 (nutzt das eingebaute SQLite, keine nativen Abhängigkeiten).

```bash
npm install
ADMIN_PASSWORD=geheim npm start
```

### Konfiguration (Umgebungsvariablen)

| Variable         | Standard           | Bedeutung                                              |
|------------------|--------------------|--------------------------------------------------------|
| `PORT`           | `3000`             | HTTP(S)-Port                                           |
| `HOST`           | `0.0.0.0`          | Bind-Adresse                                           |
| `DATA_DIR`       | `./data`           | Ordner für die SQLite-Datenbank                        |
| `DB_FILE`        | `$DATA_DIR/gamefinder.db` | Pfad zur Datenbank (überschreibt `DATA_DIR`)    |
| `ADMIN_PASSWORD` | *(leer)*           | Passwort für den Admin-Modus. Leer = deaktiviert       |
| `TLS_CERT`, `TLS_KEY` | *(leer)*      | Pfade zu Zertifikat/Key, um direkt HTTPS anzubieten    |

## Betrieb im LAN vs. im Internet

- **Nur im LAN:** einfach starten und die Adresse (z.B. `http://192.168.1.10:3000`) aushängen oder als QR-Code auf die Tische legen. Die App braucht kein Internet.
- **Im Internet:** hinter einen Reverse-Proxy mit HTTPS stellen (z.B. Caddy: `gamefinder.example.de { reverse_proxy localhost:3000 }`). WebSockets müssen durchgereicht werden, was Caddy automatisch erledigt.

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

- `src/server.js`: Express-API, Socket.IO-Events, Validierung
- `src/db.js`: SQLite-Schema und Datenzugriff
- `public/`: Frontend in reinem HTML/CSS/JS, kein Build-Schritt
