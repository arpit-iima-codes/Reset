# Steady

Personal fasting & craving companion — a single-file mobile web app (`index.html`).

Tabs: **Fast** (fasting timer + streaks), **SOS** (10-minute craving "wave" timer), **Patterns** (slip log & danger hours), **Wins** (daily checklist & levels), **Health** (weight, waist, labs).

## Source

Synced from the Claude artifact: https://claude.ai/artifact/AGhfZj7oFpoBnJ962Zfp4j

## Running

- **Hosted build (current):** `index.html` sets `window.STEADY_HOSTED = true`, so it saves data with the claude.ai artifact database. Outside claude.ai it falls back to `localStorage`.
- **Self-hosted build:** set `STEADY_HOSTED` to `false` and serve it from your own server. That mode expects `sw.js` (service worker) and a backend with `/api/fast`, `/api/reminders`, `/api/backup`, `/api/watch`, `/api/vapid`, `/api/subscribe` and `/api/auth-check`. Those files are not in this repo yet.

Quick local preview:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
