# Steady — your personal fasting & craving companion

A web app for your iPhone (no App Store needed) plus a tiny Node server on your own
machine that sends push notifications and keeps a backup.

**Screens:** Fast (timer + stages) · SOS (10-min craving ride, future-self message,
if-then plans) · Patterns (slip log → your danger hours → daily alert) · Wins (levels,
"never miss twice" streak, votes) · Health (weight/waist, unlock cards, lab traffic
lights with Indian cut-offs).

Your data lives on your phone. The server only stores push subscriptions, reminder
times and (optionally) a backup copy.

---

## 1. Run it on your server

Requirements: Node.js 18+ and **HTTPS** (iPhone only allows home-screen apps and push
over HTTPS).

```bash
cd Reset
npm install
APP_TOKEN="pick-a-long-random-string" PORT=8080 node server.js
```

Environment variables:

| Variable | Default | What it does |
|---|---|---|
| `APP_TOKEN` | *(none)* | Password the app sends with every change. **Set this.** |
| `PORT` | `8080` | Port to listen on |
| `TZ_NAME` | `Asia/Kolkata` | Fallback timezone for reminders (the app also sends your phone's timezone) |
| `VAPID_SUBJECT` | `mailto:steady@example.com` | Contact for push services. Put your own email here |
| `DATA_DIR` | `./data` | Where `state.json` (keys, reminders, backup) is stored |

Push keys (VAPID) are generated on first start and saved in `data/state.json`.
Don't delete that file, or you'll need to turn notifications on again from the phone.

### HTTPS (quickest way: Caddy)

If you have a domain pointing to your server:

```
# /etc/caddy/Caddyfile
steady.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Caddy gets the certificate automatically. Nginx + Let's Encrypt works too. No domain?
A Cloudflare Tunnel or Tailscale Funnel gives you an HTTPS URL for free.

### Keep it running (systemd example)

```ini
# /etc/systemd/system/steady.service
[Unit]
Description=Steady
After=network.target

[Service]
WorkingDirectory=/opt/steady
Environment=APP_TOKEN=pick-a-long-random-string
Environment=PORT=8080
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now steady`

---

## 2. Install on your iPhone

1. Open `https://steady.yourdomain.com` in **Safari** (it must be Safari).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Steady from the new icon** (not from Safari).
4. Tap the gear → **Your server** → enter your `APP_TOKEN` → **Turn on notifications** → Allow.
5. Tap **Send a test notification** to confirm.

Notifications need iOS 16.4 or newer and only work from the home-screen icon.

---

## 3. First things to do

- **Settings → Message to your future self.** Write it on a good day. It appears when you
  try to end a fast early and during SOS.
- **Settings → If-then plans.** One for your hardest moment.
- **Health tab:** enter your starting weight and height, plus your latest blood report if you have one.
- When a craving hits, press **SOS**. When you slip, log it on **Patterns** (3 taps).
  After a few entries, tap **Alert me daily** to get a push 15 minutes before your danger hour.

## Notifications you'll get

- Fasting: at 12h / 14h / 16h milestones, 1 hour before your goal, and when you reach it
- Your daily reminders and danger-hour alerts (Settings → Reminders)

## Apple Watch sync (via the iPhone Shortcuts app)

Apple Health has no web API, so an iPhone **Shortcuts** automation reads it and posts it
to your server. In the app: **Settings → Apple Watch → How to set up** shows these steps with
your URL filled in.

1. Shortcuts → **+** → name it "Steady sync".
2. **Find Health Samples** (Type: Steps, Start Date: Today) → **Calculate Statistics** (Sum).
3. **Format Date** (Current Date, Custom: `yyyy-MM-dd`).
4. **Get Contents of URL**: `https://your-server/api/watch`, Method **POST**,
   Header `X-App-Token: <APP_TOKEN>`, Request Body **JSON**: `date` = Formatted Date,
   `steps` = Statistics.
5. Run it once and tap **Always Allow**.
6. Automation → **Time of Day** (e.g. 1 pm, 6 pm, 9:30 pm) → Daily → **Run Immediately**.

Optional JSON fields: `activeEnergy`, `exerciseMinutes`, `restingHR`, `sleepHours`,
`weight` (kg), `distanceKm`. Values like `"8,432"` or `"68 BPM"` are accepted.

Test from a terminal:
```bash
curl -X POST https://your-server/api/watch -H "X-App-Token: $APP_TOKEN" \
  -H "Content-Type: application/json" -d '{"steps": 8432}'
```

## Backups

iPhone can clear website data. Auto-backup to your server is on by default once the token
is set. You can also use **Settings → Backup → Export file** (save it to Files/iCloud).
To move to a new phone: install, enter the token, **Restore from server**.

## API (for reference)

All routes except `/api/health` and `/api/vapid` need the header `X-App-Token`.

- `GET /api/health`, `GET /api/vapid`
- `POST /api/subscribe`, `POST /api/unsubscribe`, `POST /api/test`
- `GET|PUT /api/reminders` — `{ tz, reminders: [{ id, time: "HH:MM", body, tab }] }`
- `POST /api/fast` `{ start, targetHours }` · `DELETE /api/fast`
- `GET|PUT /api/backup` — `{ data }`
- `POST /api/watch` `{ date, steps, ... }` · `GET /api/watch?since=YYYY-MM-DD`

---

*Cut-offs used: ADA 2026 (HbA1c, fasting glucose), Cardiological Society of India
(lipids), IDF South Asian criteria (waist), Indian consensus (BMI). Unlock-card facts come
from the Diabetes Prevention Program, the DiRECT trial, a 25-trial blood-pressure
meta-analysis and Vilar-Gomez 2015 (fatty liver). They are study averages, not personal
predictions. This is a motivation tool, not medical advice. Check your targets with your doctor.*

---

## Hosted build (claude.ai artifact)

`hosted/index.html` is the single-file build published as a Claude artifact
(https://claude.ai/artifact/AGhfZj7oFpoBnJ962Zfp4j). It inlines `public/app.js` and
`public/styles.css` and sets `window.STEADY_HOSTED = true`, which turns off the server features
and saves data in the artifact's own storage instead. If you change `public/app.js` or
`public/styles.css`, rebuild this file too.
