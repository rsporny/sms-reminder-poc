# CLAUDE.md — Salon SMS Reminder

Project context and hard requirements. Read this in full before implementing. Product description and architecture: see `README.md`.

## Goal

A single Cloudflare Worker that: (a) every 15 minutes checks Google Calendar and, ~24h before an appointment, sends the client an SMS asking them to reply "TAK" (Polish for "yes"), (b) receives a webhook from SMSAPI with the client's reply and marks the appointment as confirmed, (c) colors calendar events so the owner can see at a glance who to call. No other interfaces — the owner only ever uses Google Calendar.

## Hard requirements (non-negotiable)

1. **One Worker, one entry file** (`src/index.js` or `.ts`) exporting `{ scheduled, fetch }`. Zero runtime dependencies in `package.json` — devDependencies only (wrangler, optionally vitest).
2. **Do NOT use the `googleapis` SDK** — it doesn't run on Workers. Call Google Calendar API v3 with plain `fetch()`.
3. **Google auth:** service account. Build the JWT (RS256) manually and sign it with `crypto.subtle.importKey("pkcs8", ...)` + `crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)`, then exchange it for an access token at `https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, scope `https://www.googleapis.com/auth/calendar.events`). The private key arrives in the secret with literal `\n` sequences — normalize them. Cache the access token in a module-level variable with a time margin (token lives 1h; the isolate may live shorter — the code must also work on cold starts).
4. **No database.** Keep all state on the Google Calendar event itself:
   - `extendedProperties.private.reminderSentAt` — ISO timestamp of the SMS send
   - `extendedProperties.private.confirmedAt` — ISO timestamp of the confirmation
   - `extendedProperties.private.clientPhone` — normalized number (`48XXXXXXXXX`), written at SMS-send time — the webhook matches the appointment via this field (using the `privateExtendedProperty` query param of the API), NOT by re-parsing event titles
   - `colorId`: `5` (yellow, sent), `10` (green, confirmed), `11` (red, no reply)
5. **Cron idempotency:** check `reminderSentAt` before sending. The cron may crash and re-run — a client must NEVER receive two SMS for the same appointment. Cron Triggers have no retries — the logic must self-heal on the next tick.
6. **SMSAPI webhook** (`POST /sms-callback?secret=...`):
   - the response must be **body exactly `OK`** (text/plain). HTTP 200 alone is NOT enough — SMSAPI keeps redelivering without it.
   - validate the `secret` query param against the `CALLBACK_SECRET` secret; wrong/missing → 403.
   - SMSAPI posts data as `application/x-www-form-urlencoded`; you need the sender-number and message-body fields (check the current SMSAPI docs for exact field names, typically `sms_from` / `sms_text` — verify, don't guess).
   - parsing the client's reply: case-insensitive, trimmed; accept `TAK`, `TAK.`, `Tak, będę`, `ok`, `potwierdzam` (contains a confirmation keyword). Anything else is NOT a confirmation, but log it (`console.log`) — it may be a cancellation.
   - appointment matching: by `clientPhone`, pick the **nearest future** unconfirmed appointment for that number. No match → log it and still respond `OK` (never 500 — SMSAPI would retry forever).
7. **Parsing the phone number from the event title/description:** regex for 9 digits (spaces/dashes between digits allowed, optional `+48`/`48` prefix). Normalize to `48XXXXXXXXX`. Event without a number → skip it and log; never abort the whole run.
8. **Send window:** events starting 23–25h from "now" (buffer for the 15-min cron), without a `reminderSentAt` flag, non-all-day. Escalation to red: `reminderSentAt` older than 4h, no `confirmedAt`, event still in the future.
9. **Time:** the Worker runs in UTC. Do all comparisons on timestamps (`event.start.dateTime` includes an offset — parse with `Date`). The appointment date/time in the SMS body MUST be in Polish local time — format with `Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", ... })`. Never hardcode a +1/+2 offset.
10. **SMS body without Polish diacritics** (ż→z, ą→a, etc.) — diacritics force Unicode encoding, which cuts the per-SMS limit to 70 chars and raises cost. Keep the template ≤ 160 GSM-7 chars. Template:
    `"{SALON_NAME}: przypominamy o wizycie {date} o {time}. Odpisz TAK aby potwierdzic. Odwolanie: tel {SALON_PHONE}"`
    (The message stays in Polish — the clients are Polish; only the encoding must be diacritic-free.)
11. **SMSAPI sending:** `POST https://api.smsapi.pl/sms.do` with `Authorization: Bearer {SMSAPI_TOKEN}`, params incl. `to`, `message`, `from=2way`, `format=json`, `encoding=utf-8`. Check the response for errors (JSON with an `error` field) — a failed send must NOT set `reminderSentAt` (we'll retry on the next tick).
12. **Secrets exclusively via Worker Secrets** (`GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `SMSAPI_TOKEN`, `CALLBACK_SECRET`). Non-secret config in `wrangler.toml [vars]`: `CALENDAR_ID`, `SALON_NAME`, `SALON_PHONE`. None of it in code or in the repo.

## Code conventions

- Vanilla JS with JSDoc or TypeScript — pick one and stick to it.
- Small pure functions: `parsePhone(title)`, `gsmSanitize(text)`, `getAccessToken(env)`, `listUpcomingEvents(...)`, `patchEvent(...)`, `sendSms(...)`, `handleCallback(...)`. Keep time-window and parsing logic separate from I/O so it's testable without the network.
- Unit tests (vitest) at minimum for: phone parsing, diacritic sanitization, "TAK" detection, the 23–25h window math, nearest-appointment selection. Don't mock the whole Workers runtime — test the pure functions.
- `console.log` at key points (SMS sent to X, Y confirmed, no match for number Z) — this is the only observability (`wrangler tail`).
- Per-event error handling: an exception on one event must not break the loop over the rest.

## Deliverables

1. `src/index.js` (or `.ts`) — the complete Worker
2. `wrangler.toml` — cron `*/15 * * * *`, `[vars]`, current `compatibility_date`
3. `.github/workflows/deploy.yml` — deploy on push to `main` via `cloudflare/wrangler-action`, using the `CLOUDFLARE_API_TOKEN` repo secret
4. Tests + `npm test` in CI before deploy
5. A short "Troubleshooting" section appended to the README (how to watch logs with `wrangler tail`, how to test the callback with curl)

## What NOT to do

- Don't add KV/D1/Durable Objects — state lives in the calendar.
- Don't add frameworks (Hono etc.) — routing is a single `if` on the pathname.
- Don't build an admin panel, UI, or any endpoints beyond `/sms-callback` and an optional `/health`.
- Don't send marketing SMS or anything beyond the reminder — this is a transactional system.
- Don't log full phone numbers in plain text — mask the middle (`48500***456`).
