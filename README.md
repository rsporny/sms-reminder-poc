# Salon SMS Reminder

A zero-maintenance SMS appointment reminder system for a hair salon, built on **Google Calendar** (the only tool the salon owner touches) and **Cloudflare Workers** (all the logic, $0 infrastructure).

## How it works

1. The salon owner adds an appointment to their Google Calendar in this format:
   ```
   Anna Kowalska 500123456 — haircut + coloring
   ```
   (client's name, 9-digit phone number, optionally a service description)

2. **Within 15 minutes of saving it** the client gets a booking acknowledgement via the [SMSAPI](https://www.smsapi.pl) gateway (a 2Way message, sent from a reply-capable number). Informational only — it does not ask for anything:
   > Salon [NAME]: rezerwacja przyjeta na czw 28.08 o 14:00. Przypomnimy dzien wczesniej. Odwolanie: tel [SALON PHONE]

3. **~24h before the appointment** the reminder goes out, and this one does ask:
   > Salon [NAME]: przypominamy o wizycie czw 28.08 o 14:00. Odpisz TAK aby potwierdzic. Odwolanie: tel [SALON PHONE]

4. The client replies **TAK** ("yes") → SMSAPI calls our webhook → the system marks the appointment as confirmed.

5. **If the owner moves the appointment**, the client is told the new time. If they had already been asked to confirm the old one, the notice asks again and the appointment drops back to yellow — a green appointment the client agreed to at a different hour is worse than no confirmation at all.
   > Salon [NAME]: zmiana terminu wizyty na pt 29.08 o 16:00. Odpisz TAK aby potwierdzic. Odwolanie: tel [SALON PHONE]

6. In the morning, the owner glances at the calendar and sees a traffic-light system:

   | Event color | Meaning |
   |---|---|
   | default | future appointment, no reminder sent yet (a booking SMS leaves the color alone) |
   | 🟡 yellow (`colorId: 5`) | confirmation asked, waiting for the reply |
   | 🟢 green (`colorId: 10`) + `✅` in title | client confirmed |
   | 🔴 red (`colorId: 11`) | no reply 4h after the last ask → **call this client** |

   Moving a green or yellow appointment resets it to yellow (clearing the `✅`) and restarts the 4h
   clock, because the client is being asked about a different time.

The owner never operates any application other than their calendar.

## Architecture

```
┌─────────────────┐
│ Google Calendar │ ◄── salon owner (adds/edits appointments)
└───────┬─────────┘
        │ REST API (service account, JWT RS256 via WebCrypto)
┌───────▼──────────────────────────────────────┐
│ Cloudflare Worker (single file, Free plan)   │
│                                              │
│  scheduled()  – Cron Trigger every 15 min    │
│   • created < 1h ago → booking SMS           │
│   • start ≠ notifiedStart → reschedule SMS   │
│   • events in the 23–25h window → send SMS   │
│   • mark yellow + set reminderSent flag      │
│   • yellow > 4h with no reply → red          │
│                                              │
│  fetch() – POST /sms-callback (from SMSAPI)  │
│   • body ≈ "TAK" → match on MsgId            │
│   • ✅ + green + confirmed flag              │
│   • respond with body "OK" (SMSAPI requires) │
└───────┬──────────────────────────────────────┘
        │ REST API
┌───────▼──────┐
│ SMSAPI 2Way  │ ◄──► client's phone
└──────────────┘
```

**No database.** All state (SMS sent / confirmed) lives in the Google Calendar event's `extendedProperties.private` plus its `colorId`. The calendar is the single source of truth and the cron job is fully idempotent.

## Stack

- **Runtime:** Cloudflare Workers (Free plan), 1 Cron Trigger `*/15 * * * *`
- **Calendar:** Google Calendar API v3 via plain `fetch()` — no `googleapis` SDK (doesn't run on Workers); auth: service account + RS256 JWT signed with `crypto.subtle`
- **SMS:** SMSAPI.pl — 2Way sending (shared inbound number), replies received via callback URL
- **Deploy:** GitHub Actions → `cloudflare/wrangler-action` → `wrangler deploy` on push to `main`
- **Language:** JavaScript/TypeScript, zero runtime dependencies

## One-time setup

### 1. Google Cloud
1. Create a project in the [Google Cloud Console](https://console.cloud.google.com) and enable the **Google Calendar API**.
2. Create a **service account** and download its JSON key.
3. In the owner's Google Calendar: *Settings → Share with specific people* → add the service account's e-mail with the **"Make changes to events"** permission.
4. Note the **Calendar ID** (Settings → Integrate calendar).

### 2. SMSAPI
1. Register at [smsapi.pl](https://www.smsapi.pl) and generate an **OAuth token** (Panel → API → Tokens).
2. Activate **2Way** sending (an inbound number from the shared pool).
3. Panel → **Callback addresses** → "Incoming SMS" → enter the Worker URL: `https://<worker>.workers.dev/sms-callback`.

### 3. Cloudflare + GitHub
```bash
wrangler secret put GOOGLE_SA_EMAIL        # service account e-mail
wrangler secret put GOOGLE_SA_PRIVATE_KEY  # private_key from the JSON (with \n)
wrangler secret put SMSAPI_TOKEN
wrangler secret put CALLBACK_SECRET        # random string appended to the callback URL
wrangler secret put CALENDAR_ID            # Calendar ID from step 1.4
```
Non-secret config goes in `wrangler.toml` (`[vars]`): `SALON_NAME`, `SALON_PHONE`.

In the GitHub repo, add the `CLOUDFLARE_API_TOKEN` secret (used by the deploy workflow).

## Costs

| Item | Cost |
|---|---|
| Cloudflare Workers | 0 PLN (Free plan) |
| Google Calendar API | 0 PLN |
| SMS (SMSAPI, 2Way) | ~0.08–0.12 PLN net / SMS. Budget ~2 per appointment (booking + reminder), plus one per reschedule → at ~200 appointments/month **40–60 PLN/month** |
| Receiving "TAK" replies | 0 PLN |

## Repo structure

```
.
├── src/
│   └── index.js          # the entire Worker: scheduled() + fetch()
├── test/
│   └── index.test.js     # vitest over the pure functions
├── wrangler.toml
├── package.json
├── .github/workflows/
│   └── deploy.yml
├── README.md
├── TESTING.md            # live end-to-end runbook
└── CLAUDE.md             # instructions for Claude Code
```

## Development

```bash
npm install
npm test                      # vitest over the pure functions
npx wrangler deploy --dry-run # validate wrangler.toml + build, without deploying
npx wrangler dev              # local server on :8787
```

For `wrangler dev`, put dummy values in a `.dev.vars` file (gitignored) so the Worker has
something to read for the five secrets:

```
GOOGLE_SA_EMAIL = "dev@example.iam.gserviceaccount.com"
GOOGLE_SA_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n"
SMSAPI_TOKEN = "dev-token"
CALLBACK_SECRET = "test"
CALENDAR_ID = "c_a1b2c3...@group.calendar.google.com"
```

Calls to Google will fail with dummy credentials — that is expected, and the routing, secret
check, phone parsing and reply parsing are all still exercised.

## Troubleshooting

### Watching logs

`console.log` is the only observability. Stream it from the deployed Worker:

```bash
wrangler tail                       # everything, live
wrangler tail --format pretty
```

Expected lines per cron tick — one summary, then one per event:

```
tick: 12 events in window, 2 due, 1 stale, 1 new, 1 moved
event abc123: booking sms sent to 48500***456
event def456: reschedule sms sent to 48500***789 (askConfirm=true)
event ghi789: reminder sent to 48500***456
event jkl012: no reply after 4h — marked red
```

Numbers are always masked in logs; a full client number should never appear.

To trigger the cron by hand instead of waiting up to 15 minutes, run `wrangler dev` and hit its
scheduled endpoint (the flag is required — it is off by default):

```bash
npx wrangler dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'
```

With dummy credentials this returns 500 — `getAccessToken` cannot parse the fake key. That is
the expected local result; it still proves the cron path runs. Note the asymmetry with the
callback: `scheduled()` lets a total auth failure surface (nothing is waiting on the response,
and the next tick retries), while per-event errors inside the loop are caught so one bad event
cannot abort the rest of the run.

### Testing the callback with curl

Against a local `wrangler dev`:

```bash
curl -X POST 'http://localhost:8787/sms-callback?secret=test' \
  -d 'sms_from=48500123456' -d 'sms_text=TAK' -d 'MsgId=1460969715572091219'
```

`MsgId` is what identifies the appointment — it is the id of the 2way message being replied to, and
the Worker stores the id of the last message that *asked* for confirmation. Omit it and the reply is
acknowledged but matches nothing, which is also what happens when a client replies to the
informational booking SMS.

Expected responses:

| Request | Status | Body |
|---|---|---|
| correct `secret` | 200 | `OK` |
| wrong or missing `secret` | 403 | `forbidden` |
| reply that isn't a confirmation | 200 | `OK` (logged as non-confirmation) |
| `TAK` with no usable `MsgId` | 200 | `OK` (logged with the field names received) |
| `MsgId` matching no pending ask | 200 | `OK` (logged as superseded or informational) |

The body is `OK` on every 200 path including internal errors — that is deliberate, see below.

### Common failures

**SMSAPI keeps redelivering the same reply.** The response body wasn't exactly `OK`. A bare
HTTP 200 is not enough. This is why the callback swallows its own errors and still answers `OK`:
a 500 would put SMSAPI into a permanent retry loop.

**Google returns 404 for the calendar.** The service account hasn't been given access. Share the
calendar with the service account's e-mail with *"Make changes to events"* (see One-time setup),
and check the `CALENDAR_ID` secret — it is the ID from *Settings → Integrate calendar*,
not the calendar's display name.

**Google returns 401 `invalid_grant`.** Usually the private key. `GOOGLE_SA_PRIVATE_KEY` must be
the full PEM including the `-----BEGIN PRIVATE KEY-----` header; literal `\n` sequences are fine
(the Worker normalizes them). Also check the server clock skew if you're replaying old JWTs.

**No SMS goes out and nothing is logged for an appointment.** Most likely no phone number was
parsed from the event — look for `no phone number in title/description`. The parser wants 9 digits
(spaces, dots and dashes between them are fine, `+48`/`48` prefix optional) and deliberately
ignores longer digit runs so an invoice number in the title isn't mistaken for a phone.

**An appointment never turns yellow.** The send window is 23–25h before the start, so an
appointment created less than 23h ahead never gets a reminder. This is by design — a reminder
sent 3h before the slot has little value and risks annoying the client. Such an appointment still
gets its booking acknowledgement, which carries the date and time.

**Confirmations stopped working entirely — every reply logs "without a usable MsgId".** Replies are
matched only on `MsgId`, the id of the 2way message being answered
([docs](https://www.smsapi.pl/docs/#10-odbiory-wiadomosci)). It is documented as empty for replies
to a *dedicated* number, so this is what a switch away from the shared 2Way pool looks like. The log
line lists the fields SMSAPI actually posted — check it before assuming anything else.

**A newly created appointment got no booking SMS.** Three by-design reasons, in order of likelihood:
it is an instance of a recurring series (one creation, many instances — they are skipped, and the
24h reminder still covers them); it already existed before this feature was deployed (the pass only
looks at events created in the last hour, which is what stops a whole calendar being blasted
retroactively); or the Worker was down for more than an hour after the booking. Reminders are never
affected by any of the three.

**An appointment was moved but the client wasn't told.** The reschedule pass sees events touched in
the last hour, so a move made during a longer outage is missed permanently. The client still has the
correct time if the appointment has not yet been reminded, and the reminder itself always quotes the
current start.
