# CLAUDE.md — Salon SMS Reminder

Project context and hard requirements. Read this in full before implementing. Product description and architecture: see `README.md`.

## Goal

A single Cloudflare Worker that: (a) every 15 minutes checks Google Calendar and, ~24h before an appointment, sends the client an SMS asking them to reply "TAK" (Polish for "yes"), (b) acknowledges a newly booked appointment and notifies the client when one is moved, (c) receives a webhook from SMSAPI with the client's reply and marks the appointment as confirmed, (d) colors calendar events so the owner can see at a glance who to call. No other interfaces — the owner only ever uses Google Calendar.

Three message types, all transactional: **reminder** (asks for TAK), **booking acknowledgement** (informational), **reschedule notice** (asks for TAK again only if the client had already been asked to confirm the old time).

## Hard requirements (non-negotiable)

1. **One Worker, one entry file** (`src/index.js` or `.ts`) exporting `{ scheduled, fetch }`. Zero runtime dependencies in `package.json` — devDependencies only (wrangler, optionally vitest).
2. **Do NOT use the `googleapis` SDK** — it doesn't run on Workers. Call Google Calendar API v3 with plain `fetch()`.
3. **Google auth:** service account. Build the JWT (RS256) manually and sign it with `crypto.subtle.importKey("pkcs8", ...)` + `crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)`, then exchange it for an access token at `https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, scope `https://www.googleapis.com/auth/calendar.events`). The private key arrives in the secret with literal `\n` sequences — normalize them. Cache the access token in a module-level variable with a time margin (token lives 1h; the isolate may live shorter — the code must also work on cold starts).
4. **No database.** Keep all state on the Google Calendar event itself, under `extendedProperties.private`:
   - `reminderSentAt` — ISO timestamp of the 24h reminder send. Its only job is "never remind twice"
   - `confirmedAt` — ISO timestamp of the confirmation. Cleared (set to `null`, which deletes the key) when a confirmed appointment is rescheduled
   - `clientPhone` — normalized number (`48XXXXXXXXX`), written at send time. Used to send a reschedule without re-parsing the title, and for masked logging
   - `bookingSmsSentAt` — ISO timestamp of the booking acknowledgement; the idempotency gate for that pass
   - `notifiedStart` — the `start.dateTime` last communicated to the client; a mismatch against the current start is what defines a reschedule
   - `confirmAskedAt` — when we last asked for TAK. The 4h red clock runs from this, so a reschedule restarts it. Falls back to `reminderSentAt` for events written before this key existed
   - `confirmAskMsgId` — SMSAPI id of the last message that asked for TAK; the webhook matches replies on it (see §6)
   - `colorId`: `5` (yellow, confirmation asked), `10` (green, confirmed), `11` (red, no reply). The booking acknowledgement deliberately sets no color — default still means "no reminder sent yet"
5. **Cron idempotency:** check `reminderSentAt` before sending. The cron may crash and re-run — a client must NEVER receive two SMS for the same appointment. Cron Triggers have no retries — the logic must self-heal on the next tick.
6. **SMSAPI webhook** (`POST /sms-callback?secret=...`):
   - the response must be **body exactly `OK`** (text/plain). HTTP 200 alone is NOT enough — SMSAPI keeps redelivering without it.
   - validate the `secret` query param against the `CALLBACK_SECRET` secret; wrong/missing → 403.
   - SMSAPI posts data as `application/x-www-form-urlencoded`. The fields are `sms_to`, `sms_from`, `sms_text`, `sms_date`, `username` and `MsgId` (https://www.smsapi.pl/docs/#10-odbiory-wiadomosci). The payload carries only the client's reply, never the original outgoing text.
   - parsing the client's reply: case-insensitive, trimmed; accept `TAK`, `TAK.`, `Tak, będę`, `ok`, `potwierdzam` (contains a confirmation keyword). Anything else is NOT a confirmation, but log it (`console.log`) — it may be a cancellation.
   - **appointment matching: by `MsgId` only.** `MsgId` is documented as *"id wiadomości 2way na którą jest to odpowiedź"*, max 32 characters, empty only for replies to a dedicated number. Look the appointment up with `privateExtendedProperty=confirmAskMsgId=<MsgId>`. Because that property holds the id of the *last* ask and is overwritten on every new one, a TAK answering a superseded reminder — or answering the informational booking SMS — matches nothing and is correctly ignored. No phone-number fallback: a reply with no usable `MsgId` is logged (with the list of field names received, so the failure is diagnosable from `wrangler tail`) and ignored.
   - no match → log it and still respond `OK` (never 500 — SMSAPI would retry forever).
7. **Parsing the phone number from the event title/description:** regex for 9 digits (spaces/dashes between digits allowed, optional `+48`/`48` prefix). Normalize to `48XXXXXXXXX`. Event without a number → skip it and log; never abort the whole run.
8. **Send window:** events starting 23–25h from "now" (buffer for the 15-min cron), without a `reminderSentAt` flag, non-all-day. Escalation to red: last ask (`confirmAskedAt ?? reminderSentAt`) older than 4h, no `confirmedAt`, event still in the future, not already red.
9. **Time:** the Worker runs in UTC. Do all comparisons on timestamps (`event.start.dateTime` includes an offset — parse with `Date`). The appointment date/time in the SMS body MUST be in Polish local time — format with `Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", ... })`. Never hardcode a +1/+2 offset.
10. **SMS body without Polish diacritics** (ż→z, ą→a, etc.) — diacritics force Unicode encoding, which cuts the per-SMS limit to 70 chars and raises cost. Keep the template ≤ 160 GSM-7 chars. Template:
    `"{SALON_NAME}: przypominamy o wizycie {date} o {time}. Odpisz TAK aby potwierdzic. Odwolanie: tel {SALON_PHONE}"`
    Booking acknowledgement — never asks for TAK, so a reply to it can confirm nothing:
    `"{SALON_NAME}: rezerwacja przyjeta na {date} o {time}. Przypomnimy dzien wczesniej. Odwolanie: tel {SALON_PHONE}"`
    Reschedule notice, with the middle sentence present only when the client had already been asked to confirm:
    `"{SALON_NAME}: zmiana terminu wizyty na {date} o {time}. [Odpisz TAK aby potwierdzic. ]Odwolanie: tel {SALON_PHONE}"`
    (The messages stay in Polish — the clients are Polish; only the encoding must be diacritic-free.)
11. **SMSAPI sending:** `POST https://api.smsapi.pl/sms.do` with `Authorization: Bearer {SMSAPI_TOKEN}`, params incl. `to`, `message`, `from=2way`, `format=json`, `encoding=utf-8`. Check the response for errors (JSON with an `error` field) — a failed send must NOT set `reminderSentAt` (we'll retry on the next tick). On success the body is `{count, list:[{id, ...}]}`; **store `list[0].id` as `confirmAskMsgId`** whenever the message asked for TAK — without it the reply cannot be matched (§6). If the id is missing, log it and write the other flags anyway: the ask went out, and the appointment simply escalates to red at 4h so the owner calls.
12. **Secrets exclusively via Worker Secrets** (`GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `SMSAPI_TOKEN`, `CALLBACK_SECRET`). Non-secret config in `wrangler.toml [vars]`: `CALENDAR_ID`, `SALON_NAME`, `SALON_PHONE`. None of it in code or in the repo.
13. **Booking and reschedule detection — same cron, one extra read.** No push channels (`events.watch` would need channel renewal and somewhere to keep the channel id). Each tick also lists `timeMin=now` + `updatedMin=now-1h`; `created` and `notifiedStart` then tell creations and moves apart:
    - **New:** `now - created <= 1h`, no `bookingSmsSentAt`, no `reminderSentAt`, future, non-all-day, **no `recurringEventId`** (one creation yields many instances — the reminder still covers them). `created` is immutable, so our own patches (which bump `updated`) cannot re-trigger it, and an existing calendar is never blasted on first deploy. The 1h lookback self-heals across ~4 missed ticks; a longer outage loses the acknowledgement, never the reminder.
    - **Moved:** `notifiedStart` present and `Date.parse(start.dateTime) !== Date.parse(notifiedStart)`. **Compare instants, not strings** — Google may re-serialize `+02:00` as `Z` for the same moment.
    - Reschedule behaviour is state-dependent: if the client had already been asked to confirm (`confirmedAt` or `reminderSentAt` present) the notice asks for TAK again, sets yellow, clears `confirmedAt`, strips the `✅` from the title and refreshes `confirmAskedAt`/`confirmAskMsgId`. Otherwise it is informational and changes no color. A reschedule never re-sends the 24h reminder.
    - Order the tick booking → reschedule → reminders → escalation, and skip the reminder for any event messaged earlier in the same tick (an appointment booked ~24h out is in both passes; two SMS seconds apart is spam). The 23–25h window is 2h wide, so the reminder simply goes out on the next tick.

## Code conventions

- Vanilla JS with JSDoc or TypeScript — pick one and stick to it.
- Small pure functions: `parsePhone(title)`, `gsmSanitize(text)`, `buildMessage(...)`, `buildBookingMessage(...)`, `buildRescheduleMessage(...)`, `selectDueEvents(...)`, `selectNewEvents(...)`, `selectRescheduledEvents(...)`, `selectStaleEvents(...)`, `needsReconfirmation(ev)`, `extractMsgId(res)`, `withCheck`/`withoutCheck`, alongside the I/O helpers `getAccessToken(env)`, `listEvents(...)`, `patchEvent(...)`, `sendSms(...)`, `handleCallback(...)`. Keep time-window and parsing logic separate from I/O so it's testable without the network.
- Unit tests (vitest) at minimum for: phone parsing, diacritic sanitization, "TAK" detection, every message template (≤160 chars and GSM-7 only), the 23–25h window math, the `created` lookback, reschedule detection, the reconfirmation branch, and the 4h escalation clock. Don't mock the whole Workers runtime — test the pure functions.
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
- Don't send marketing SMS. The three transactional messages in the Goal section are the whole set — nothing beyond reminder, booking acknowledgement and reschedule notice.
- Don't log full phone numbers in plain text — mask the middle (`48500***456`).
