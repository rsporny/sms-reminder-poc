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
   create a project, e.g. `salon-test`.
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
5. Copy the service account's e-mail (`salon-worker@salon-test.iam.gserviceaccount.com`).
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
env TZ=Europe/Warsaw date -d '+23 hours' '+%d.%m.%Y, %H:%M'
env TZ=Europe/Warsaw date -d '+25 hours' '+%d.%m.%Y, %H:%M'
```

Put A, B and C inside that printed range, spaced ~15 min apart, with **B latest** so the two
reminders are easy to tell apart on the handset. Note the window slides forward in real time: an
appointment set at the very start of the range falls out of it within minutes, so aim for the
middle. If you get distracted between creating events and triggering the cron, re-run the `date`
commands above and check the window before triggering.

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
also proves that matching is per-message: two pending asks on one number, and each reply must land
on the appointment whose SMS you actually answered.

---

## Step 4 — configure and deploy

Deploying gives you a **stable** callback URL for SMSAPI and the real 15-minute cron. Do this
before touching the SMSAPI callback settings.

Set the two non-secret config values in `wrangler.toml`:

```toml
[vars]
SALON_NAME  = "Salon Test"
SALON_PHONE = "500100200"
```

Log in and push the secrets (fish syntax):

```fish
npx wrangler login

set keyfile ~/Downloads/salon-test-abc123.json   # your downloaded JSON

jq -r '.client_email' $keyfile | npx wrangler secret put GOOGLE_SA_EMAIL
jq -r '.private_key'  $keyfile | npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
echo 'YOUR_SMSAPI_TOKEN'       | npx wrangler secret put SMSAPI_TOKEN

set callback_secret (openssl rand -hex 16)
echo $callback_secret | npx wrangler secret put CALLBACK_SECRET
echo "callback secret: $callback_secret"   # you need this for the SMSAPI panel

echo 'YOUR_CALENDAR_ID' | npx wrangler secret put CALENDAR_ID   # from Settings → Integrate calendar
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
  -d 'sms_from=48500123456' -d 'sms_text=TAK' -d 'MsgId=1460969715572091219'

# wrong secret → 403 forbidden
curl -i -X POST "https://salon-sms-reminder.<sub>.workers.dev/sms-callback?secret=wrong" \
  -d 'sms_from=48500123456' -d 'sms_text=TAK' -d 'MsgId=1460969715572091219'
```

**Then prove `MsgId` actually arrives**, because every confirmation depends on it and nothing else.
With `wrangler tail` running, send yourself any 2way SMS and reply from the handset. The tail must
show a populated `MsgId`; it is documented as empty only for replies to a *dedicated* number, and
this Worker sends from the shared 2Way pool. If it comes through empty, stop — confirmations cannot
work and the no-fallback decision needs revisiting.

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
  echo "CALENDAR_ID = \"YOUR_CALENDAR_ID\""
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

Reply **TAK to A's SMS** from your phone — reply to that specific message, not a fresh one to the
number. Within a few seconds:

```
event <id>: confirmed by 48501***234
```

**Check the calendar:** appointment A is now 🟢 green with `✅` prefixed to the title. B is still
yellow — one reply confirms one appointment.

Now reply **TAK to B's SMS** → B goes green too. Matching runs off `MsgId`, the id of the message
being answered, so it is the message you pick that decides which appointment is confirmed, never
the order they appear in the calendar.

If your handset sends replies as new messages rather than threaded ones, SMSAPI may post an empty
`MsgId`; the tail then logs `without a usable MsgId — fields received: ...` and nothing is
confirmed. That is the expected behaviour, not a bug — use the reply action on the message itself.

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
return nowMs - askedMs >= 4 * HOUR;   // ← change 4 * HOUR to 60_000 for the test
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

## Step 9 — booking and reschedule messages

Exercises the other two message types. Everything is already set up; keep `wrangler tail` running
and re-use the local cron trigger from Step 6.

**Booking.** Create a new one-off appointment with a real phone in the title, dated a few days out
so the reminder window cannot interfere, then trigger the cron.

```fish
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'
```

Expected: `event <id>: booking sms sent to 48500***456`, one SMS reading *"rezerwacja przyjeta
na …"*, `bookingSmsSentAt` / `notifiedStart` / `clientPhone` on the event, and **no color change**.
Trigger again — the tick must report `0 new` and send nothing.

Reply **TAK** to that booking SMS. Expected: `MsgId … answers no pending ask` and the appointment
stays grey. The booking message is informational; only a reminder or a reschedule can be confirmed.

**Reschedule, informational.** Drag the appointment to another hour, trigger the cron. Expected:
one `reschedule sms sent to … (askConfirm=false)`, an SMS reading *"zmiana terminu wizyty na …"*
with no TAK ask, `notifiedStart` updated, color still unchanged.

**Reschedule, with a re-ask.** Move the appointment into the 23–25h window and trigger — it turns
🟡 yellow with `confirmAskedAt` and `confirmAskMsgId` set. Now move it again and trigger: expected
`askConfirm=true`, an SMS that *does* ask for TAK, still yellow, both flags refreshed.

Now reply TAK **to the older reminder** (pick that message on the handset, not the newest one).
Expected: `MsgId … answers no pending ask` — the appointment stays yellow, because that id was
superseded. Reply TAK to the newest message instead → 🟢 green with `✅`.

**Reschedule of a confirmed appointment.** With it green, move it once more and trigger. Expected:
`askConfirm=true`, the appointment back to 🟡 yellow, the `✅` gone from the title and `confirmedAt`
cleared. Reply TAK to the new message → green and `✅` again.

**Recurring series.** Create a weekly repeating appointment and trigger. Expected: no booking SMS
at all — instances are skipped so one creation cannot fan out into a burst of messages. The 24h
reminder still covers each instance.

---

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
