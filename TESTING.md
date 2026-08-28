# Live test runbook

End-to-end test against a throwaway Google account, a real SMSAPI number and your own mobile.
Budget ~1h of hands-on time plus whatever SMSAPI's 2Way activation takes.

Everything below writes to a **test** calendar only. Nothing touches a real salon's data.

---

## Step 0 — start the long pole first

**2Way sending must be activated by SMSAPI support**, it is not self-serve. Do this before
anything else or you will finish every other step and still be unable to test.

1. Register at [smsapi.pl](https://www.smsapi.pl).
2. Top up the account — SMS are prepaid. 20 PLN is plenty for this test (~0.10 PLN/SMS).
3. Contact support and ask them to enable **2Way** (an inbound number from the shared pool).
4. While waiting, generate an OAuth token: *Panel → API → Tokeny (Tokens)*. Copy it now, it is
   shown once.

> Without 2Way you can still test sending; replies just never arrive, so the green/confirmed
> path stays untested.

---

## Step 1 — throwaway Google account and test calendar

1. Create a fresh account at [accounts.google.com/signup](https://accounts.google.com/signup).
   A personal account is fine — no Workspace needed.
2. Open [Google Calendar](https://calendar.google.com) in that account.
3. Create a **secondary** calendar, do not use the primary one:
   *Other calendars → + → Create new calendar*. Name it `Salon TEST`.
   A secondary calendar is easier to share and you can delete it afterwards in one click.
4. *Settings → Salon TEST → Integrate calendar* → copy the **Calendar ID**.
   It looks like `c_a1b2c3...@group.calendar.google.com`.

---

## Step 2 — service account

1. [Google Cloud Console](https://console.cloud.google.com) (signed in as the test account) →
   create a project, e.g. `salon-sms-test`.
2. *APIs & Services → Library* → search **Google Calendar API** → **Enable**.
   Skipping this gives a confusing 403 later, not a helpful error.
3. *APIs & Services → Credentials → Create credentials → Service account*.
   Name it `salon-worker`. No roles needed — access comes from calendar sharing, not IAM.
4. Open the service account → *Keys → Add key → Create new key → JSON*. It downloads a
   `*.json` file named `<project-id>-<hash>.json`.

   > **Keep this file outside the repo** — e.g. leave it in `~/Downloads` or move it to
   > `~/.config/`. It is an unencrypted private key. `.gitignore` ignores every root-level
   > `.json` except `package.json`/`package-lock.json` as a safety net, but the safest place
   > for a credential is simply not in a git working tree. Note where it lands; `.gitignore` already excludes `service-account*.json`
   and `*-key.json`, but keep it out of the repo anyway.
5. Copy the service account's e-mail (`salon-worker@salon-sms-test.iam.gserviceaccount.com`).
6. Back in Google Calendar → *Settings → Salon TEST → Share with specific people or groups* →
   **Add people** → paste the service account e-mail → permission
   **"Make changes to events"** → Send.

> There is no invitation to accept — service accounts are granted access immediately.
> If the Worker later 404s on the calendar, this share is the first thing to re-check.

---

## Step 3 — sample appointments

Create these in **Salon TEST**. Use **your own mobile** as the client number for A and B so you
actually receive the SMS and can reply.

**Get the exact window from the tool before you create anything — do not compute it in your
head.** The band is only 2h wide and it moves continuously, so "tomorrow morning" is almost
always wrong:

```fish
node diag.mjs
```

```
An appointment must START inside this window to get a reminder:
  28.08.2026, 16:30  ..  28.08.2026, 18:30   (Warsaw local)
```

Put A, B and C inside that printed range, spaced ~15 min apart, with **B latest** so A is the
"nearest" appointment when you reply. Note the window slides forward in real time: an
appointment set at the very start of the range falls out of it within minutes, so aim for the
middle. If you get distracted between creating events and triggering the cron, re-run
`node diag.mjs` and check the events still show `✅ IN WINDOW`.

| # | Title | When | Expected |
|---|---|---|---|
| A | `Anna Kowalska 500 123 456 — strzyzenie` | mid-window (see above) | SMS sent → 🟡 yellow |
| B | `Barbara Nowak +48500123456 — koloryzacja` | mid-window, ~30 min after A | SMS sent → 🟡 yellow |
| C | `Celina Wisniewska — modelowanie` | mid-window, between A and B | skipped, logged "no phone number" |
| D | `Dorota Lis 500123456 — trwala` | in 3 days | untouched (outside the window) |
| E | `Inwentaryzacja` (**all-day**) | tomorrow | untouched (all-day events are ignored) |

> **The single most common mistake in this whole runbook.** Google Calendar's event editor
> defaults to your **primary** calendar. Having `Salon TEST` ticked in the sidebar is *not*
> enough — inside each event you must open the calendar dropdown (the one with a colour dot,
> under the guest/location fields) and switch it to `Salon TEST`, or the Worker will read an
> empty calendar and log `tick: 0 events in window`.
>
> To move an event created in the wrong place: open it → Edit (pencil) → change the calendar
> dropdown → Save.

Replace `500 123 456` and `+48500123456` with your real number — the two different formats are
deliberate, they exercise both branches of the phone parser. Both point at the same phone, which
also tests "nearest appointment wins" when you reply.

---

## Step 4 — configure and deploy

Deploying gives you a **stable** callback URL for SMSAPI and the real 15-minute cron. Do this
before touching the SMSAPI callback settings.

Set the two config values in `wrangler.toml`:

```toml
[vars]
CALENDAR_ID = "c_a1b2c3...@group.calendar.google.com"
SALON_NAME  = "Salon Test"
SALON_PHONE = "500100200"
```

Log in and push the secrets (fish syntax):

```fish
npx wrangler login

set keyfile ~/Downloads/salon-sms-test-abc123.json   # your downloaded JSON

jq -r '.client_email' $keyfile | npx wrangler secret put GOOGLE_SA_EMAIL
jq -r '.private_key'  $keyfile | npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
echo 'YOUR_SMSAPI_TOKEN'       | npx wrangler secret put SMSAPI_TOKEN

set callback_secret (openssl rand -hex 16)
echo $callback_secret | npx wrangler secret put CALLBACK_SECRET
echo "callback secret: $callback_secret"   # you need this for the SMSAPI panel
```

Piping the PEM avoids the multi-line paste problem entirely. Real newlines and literal `\n`
both work — `pemToDer()` normalizes either.

These exact commands were dry-run against a locally generated RSA key: Google accepted the
signed JWT and rejected it only with `invalid_grant: account not found` (a fake e-mail), not a
signature error — so the PEM handling and RS256 signing are known-good.

Deploy:

```fish
npm test          # gate: don't deploy a red suite
npx wrangler deploy
```

Note the printed URL: `https://salon-sms-reminder.<your-subdomain>.workers.dev`.

Confirm it is alive:

```fish
curl https://salon-sms-reminder.<your-subdomain>.workers.dev/health   # → OK
```

---

## Step 5 — point SMSAPI at the Worker

*Panel → Ustawienia → Adresy callback (Callback addresses) → "SMS przychodzące" (Incoming SMS)*:

```
https://salon-sms-reminder.<your-subdomain>.workers.dev/sms-callback?secret=<callback_secret>
```

Verify the secret is enforced, and that the query string survived SMSAPI's URL validation:

```fish
# correct secret → 200 OK
curl -i -X POST "https://salon-sms-reminder.<sub>.workers.dev/sms-callback?secret=$callback_secret" \
  -d 'sms_from=48500123456' -d 'sms_text=TAK'

# wrong secret → 403 forbidden
curl -i -X POST "https://salon-sms-reminder.<sub>.workers.dev/sms-callback?secret=wrong" \
  -d 'sms_from=48500123456' -d 'sms_text=TAK'
```

> If SMSAPI's panel refuses a URL containing `?secret=...`, that is the one design assumption
> here that its UI can break. Fallback: move the secret into the path
> (`/sms-callback/<secret>`) and match on `pathname` instead — a two-line change in
> `handleFetch`.

---

## Step 6 — trigger the send without waiting

The deployed cron fires every 15 minutes, so you *can* just wait. To force it immediately,
run the Worker locally against the same real calendar and SMS gateway.

Create `.dev.vars` (gitignored) with the **real** values this time:

```fish
begin
  echo "GOOGLE_SA_EMAIL = \"$(jq -r '.client_email' $keyfile)\""
  echo "SMSAPI_TOKEN = \"YOUR_SMSAPI_TOKEN\""
  echo "CALLBACK_SECRET = \"$callback_secret\""
end > .dev.vars
```

The private key needs its newlines escaped for the `.dev.vars` format:

```fish
jq -r '"GOOGLE_SA_PRIVATE_KEY = " + (.private_key | @json)' $keyfile >> .dev.vars
```

Then fire the cron by hand:

```fish
npx wrangler dev --test-scheduled
# in another terminal:
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'
```

Expected log:

```
tick: 5 events in window, 3 due, 0 stale
event <id>: reminder sent to 48501***234
event <id>: reminder sent to 48501***234
event <id>: no phone number in title/description — skipped
```

**Check the calendar:** A and B are now 🟡 yellow. C, D, E are unchanged.
**Check your phone:** two SMS, no Polish diacritics, e.g.

```
Salon Test: przypominamy o wizycie pt 28.08 o 15:20. Odpisz TAK aby potwierdzic. Odwolanie: tel 500100200
```

Re-run the same curl. Nothing should send a second time — `reminderSentAt` is already set.
This is the idempotency check and it is the single most important one; a duplicate SMS to a
real client is the worst failure this system can produce.

---

## Step 7 — confirm by SMS

Watch the deployed Worker's logs:

```fish
npx wrangler tail --format pretty
```

Reply **TAK** to the SMS from your phone. Within a few seconds:

```
event <id>: confirmed by 48501***234
```

**Check the calendar:** appointment A (the nearer of the two) is now 🟢 green with `✅` prefixed
to the title. B is still yellow — one reply confirms one appointment.

Reply **TAK** again → B goes green too. This is `pickNearestUnconfirmed` working.

Other replies worth trying:

| Reply | Expected |
|---|---|
| `Tak, będę` | confirms (keyword match, diacritics irrelevant) |
| `ok` | confirms |
| `potwierdzam` | confirms |
| `NIE MOGE` | no change; logged `non-confirmation from 48501***...` |

A non-confirmation is deliberately *not* a cancellation — it is logged for the owner to read,
nothing more.

---

## Step 8 — the red escalation

Escalation fires 4h after the reminder with no reply, which is too long to sit through. Shorten
it temporarily in `src/index.js` (`selectStaleEvents`):

```js
return nowMs - sentMs >= 4 * HOUR;   // ← change 4 * HOUR to 60_000 for the test
```

Then, with one appointment still yellow and unconfirmed, re-run the local cron trigger after a
minute:

```fish
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'
```

Expected: `event <id>: no reply after 4h — marked red`, and the appointment turns 🔴 red.
Trigger it once more — it should *not* log again, because the code skips events already red.

**Revert the constant** and re-run `npm test` before deploying anything further.

---

---

## Debugging: what does the Worker actually see?

`diag.mjs` in the repo root reuses the Worker's real `getAccessToken`, so it proves the same auth
path while showing a much wider time window than the cron does:

```fish
node diag.mjs
```

```
service account : salon-worker@salon-sms-test.iam.gserviceaccount.com
calendar        : 72c13ff...@group.calendar.google.com
now             : 2026-08-27T14:06:07Z  (Warsaw 27.08.2026, 16:06)

An appointment must START inside this window to get a reminder:
  28.08.2026, 15:06  ..  28.08.2026, 17:06   (Warsaw local)

auth            : OK, token acquired

0 event(s) visible in -7d..+30d:
  (none) — the service account can read this calendar but it is empty.
```

Reading the output:

| What you see | What it means |
|---|---|
| `auth : OK` | key, service account and calendar sharing are all correct |
| `EVENTS LIST FAILED: 404` | the calendar was never shared with the service account, or `CALENDAR_ID` is wrong |
| `0 event(s)` in ±30d | calendar is readable but empty — events are in a **different** calendar |
| events listed, none `✅ IN WINDOW` | right calendar, wrong times — move one into the printed window |
| Worker says `N events in window, 0 due` | same thing: they are inside the 26h read window but outside the 23–25h send band |
| `✅ IN WINDOW` but no SMS | a real send problem; check `sms_from` parsing and SMSAPI balance |

`tick: 0 events in window` from the Worker itself is ambiguous between the last three — this
script disambiguates in one run.

It is dev-only: `wrangler` bundles from `main = src/index.js`, so `diag.mjs` is never deployed.
Delete it once the calendar is behaving.


## Teardown

```fish
npx wrangler delete                  # remove the Worker
rm .dev.vars
```

- Delete the `Salon TEST` calendar (Calendar settings → *Remove calendar*).
- Delete the Google Cloud project (it stops all API access, service account included).
- Revoke the SMSAPI token in the panel.
- Shred the downloaded service-account JSON.

---

## If something does not work

Symptom-to-cause is in the README's [Troubleshooting](README.md#troubleshooting) section.
The three that bite first:

1. **404 from the calendar** — the service account was never shared onto `Salon TEST`, or
   `CALENDAR_ID` is the display name rather than the ID from *Integrate calendar*.
2. **`invalid_grant`** — the Calendar API is not enabled on the project, or the private key
   got mangled. Re-pipe it with `jq -r`.
3. **SMS never arrives but the log says sent** — check the SMSAPI panel's message history and
   your account balance. `sendSms` only trusts the gateway's JSON `error` field; a message
   accepted then dropped downstream looks like success from here.
