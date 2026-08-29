/**
 * Salon SMS Reminder — the entire Worker.
 *
 * scheduled(): every 15 min, acknowledges newly booked appointments, notifies clients whose
 * appointment moved, sends a reminder SMS ~24h before each appointment, and escalates unanswered
 * ones to red. fetch(): receives the client's "TAK" reply from SMSAPI.
 *
 * State lives on the Google Calendar event (extendedProperties.private + colorId) — no database.
 * See CLAUDE.md for the hard requirements this file implements.
 *
 * @typedef {object} Env
 * @property {string} GOOGLE_SA_EMAIL     secret: service account address
 * @property {string} GOOGLE_SA_PRIVATE_KEY secret: PEM private key (literal \n sequences)
 * @property {string} SMSAPI_TOKEN        secret: SMSAPI OAuth token
 * @property {string} CALLBACK_SECRET     secret: shared secret in the callback query string
 * @property {string} CALENDAR_ID         var: calendar to watch
 * @property {string} SALON_NAME          var: used in the SMS body
 * @property {string} SALON_PHONE         var: cancellation number in the SMS body
 *
 * @typedef {object} CalendarEvent
 * @property {string} id
 * @property {string} [summary]
 * @property {string} [description]
 * @property {string} [colorId]
 * @property {string} [created]           set once on insert; never changes, unlike `updated`
 * @property {string} [recurringEventId]  present on instances of a recurring series
 * @property {{ dateTime?: string, date?: string }} [start]
 * @property {{ private?: Record<string,string> }} [extendedProperties]
 */

const HOUR = 3600_000;
const TZ = "Europe/Warsaw";
const CHECK = "✅";

/** How far back the booking pass trusts `created` — 4 cron ticks of slack. */
const BOOKING_LOOKBACK = HOUR;

/** Traffic light the salon owner reads off the calendar. */
const YELLOW = "5"; // confirmation asked, awaiting reply
const GREEN = "10"; // client confirmed
const RED = "11"; // no reply after 4h — call this client

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const SMSAPI_URL = "https://api.smsapi.pl/sms.do";

/* ------------------------------------------------------------------ *
 * Pure helpers — no I/O, exported so the tests can reach them.
 * ------------------------------------------------------------------ */

/**
 * Pull a Polish mobile number out of free text (event title or description).
 * Accepts 9 digits with optional spaces/dots/dashes and an optional +48 / 48 prefix.
 * Rejects digit runs longer than the number so an ID in the title can't be mistaken for a phone.
 *
 * @param {string|null|undefined} text
 * @returns {string|null} normalized `48XXXXXXXXX`, or null when there is no number
 */
export function parsePhone(text) {
  if (!text) return null;
  const candidate = /(?:\+?48[\s.-]?)?\d(?:[\s.-]?\d){8}/g;
  let match;
  while ((match = candidate.exec(text)) !== null) {
    const before = text[match.index - 1];
    const after = text[match.index + match[0].length];
    if (/\d/.test(before ?? "") || /\d/.test(after ?? "")) continue;
    const digits = match[0].replace(/\D/g, "");
    if (digits.length === 9) return `48${digits}`;
    if (digits.length === 11 && digits.startsWith("48")) return digits;
  }
  return null;
}

/**
 * Mask the middle of a number for logging — never log a client's full number.
 * @param {string|null|undefined} phone
 * @returns {string}
 */
export function maskPhone(phone) {
  if (!phone || phone.length < 8) return "***";
  return `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

/**
 * Strip Polish diacritics so the SMS stays GSM-7 (160 chars/message instead of Unicode's 70).
 * NFD splits every Polish letter except ł into base + combining mark, so ł is handled up front.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function gsmSanitize(text) {
  if (!text) return "";
  return String(text)
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Does the client's reply mean "yes"? Case-insensitive, punctuation-tolerant, whole-word only
 * (so "taksowka" is not a confirmation). Anything else is treated as unknown by the caller.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isConfirmation(text) {
  if (!text) return false;
  const normalized = gsmSanitize(text).toLowerCase();
  return /(?:^|[^\p{L}\p{N}])(?:tak|ok|potwierdzam)(?:[^\p{L}\p{N}]|$)/u.test(normalized);
}

/**
 * Appointment date and time in Polish local time. Derived via Intl, never a hardcoded offset,
 * so it stays correct across the CET/CEST switch.
 *
 * @param {string} isoStart
 * @returns {{ date: string, time: string }} e.g. `{ date: "czw 28.08", time: "14:00" }`
 */
export function formatWhen(isoStart) {
  const when = new Date(isoStart);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("pl-PL", {
      timeZone: TZ,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    })
      .formatToParts(when)
      .map((p) => [p.type, p.value]),
  );
  const time = new Intl.DateTimeFormat("pl-PL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
  return {
    date: gsmSanitize(`${parts.weekday.replace(/\.$/, "")} ${parts.day}.${parts.month}`),
    time,
  };
}

/**
 * The 24h reminder. Polish (the clients are Polish) but diacritic-free, and ≤160 GSM-7 chars.
 *
 * @param {{ salonName: string, salonPhone: string, start: string }} args
 * @returns {string}
 */
export function buildMessage({ salonName, salonPhone, start }) {
  const { date, time } = formatWhen(start);
  return gsmSanitize(
    `${salonName}: przypominamy o wizycie ${date} o ${time}. ` +
      `Odpisz TAK aby potwierdzic. Odwolanie: tel ${salonPhone}`,
  );
}

/**
 * Acknowledgement sent when the appointment is first booked. Informational only — it never asks
 * for TAK, so a reply to it confirms nothing (see handleCallback).
 *
 * @param {{ salonName: string, salonPhone: string, start: string }} args
 * @returns {string}
 */
export function buildBookingMessage({ salonName, salonPhone, start }) {
  const { date, time } = formatWhen(start);
  return gsmSanitize(
    `${salonName}: rezerwacja przyjeta na ${date} o ${time}. ` +
      `Przypomnimy dzien wczesniej. Odwolanie: tel ${salonPhone}`,
  );
}

/**
 * Sent when the owner moves an appointment. Asks for TAK again only if the client had already
 * been asked to confirm the old time — a client who has only ever had the booking SMS just gets
 * the new time.
 *
 * @param {{ salonName: string, salonPhone: string, start: string, askConfirm?: boolean }} args
 * @returns {string}
 */
export function buildRescheduleMessage({ salonName, salonPhone, start, askConfirm = false }) {
  const { date, time } = formatWhen(start);
  return gsmSanitize(
    `${salonName}: zmiana terminu wizyty na ${date} o ${time}. ` +
      (askConfirm ? "Odpisz TAK aby potwierdzic. " : "") +
      `Odwolanie: tel ${salonPhone}`,
  );
}

/**
 * The SMSAPI message id of a successful send (`{count, list:[{id, ...}]}`). It is what the
 * incoming-SMS callback echoes back as `MsgId`, and therefore the only link between a reply and
 * the appointment it answers.
 *
 * @param {any} response parsed sms.do body
 * @returns {string|null}
 */
export function extractMsgId(response) {
  const id = response?.list?.[0]?.id;
  if (typeof id === "number") return String(id);
  return typeof id === "string" && id ? id : null;
}

/** @param {Date|number} now */
const toMs = (now) => (now instanceof Date ? now.getTime() : now);

/**
 * Appointments due a reminder: starting 23–25h out (the window is 2h wide so the 15-min cron
 * cannot skip one), timed rather than all-day, and not already reminded.
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent[]}
 */
export function selectDueEvents(events, now) {
  const nowMs = toMs(now);
  return events.filter((ev) => {
    if (!ev?.start?.dateTime) return false; // all-day events carry start.date instead
    if (ev.extendedProperties?.private?.reminderSentAt) return false; // §5: never send twice
    const startMs = Date.parse(ev.start.dateTime);
    if (Number.isNaN(startMs)) return false;
    const delta = startMs - nowMs;
    return delta >= 23 * HOUR && delta <= 25 * HOUR;
  });
}

/**
 * Appointments just booked, owed an acknowledgement SMS.
 *
 * Two gates, both needed. `created` is immutable, so it identifies genuinely new events — our own
 * patches bump `updated` but never `created`, and on first deploy the whole existing calendar is
 * older than the lookback, so nobody gets a retroactive blast. `bookingSmsSentAt` is then the hard
 * idempotency guarantee, same contract as `reminderSentAt`.
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent[]}
 */
export function selectNewEvents(events, now) {
  const nowMs = toMs(now);
  return events.filter((ev) => {
    if (!ev?.start?.dateTime) return false; // all-day
    if (ev.recurringEventId) return false; // one creation, many instances — reminders still cover them
    const priv = ev.extendedProperties?.private;
    if (priv?.bookingSmsSentAt) return false;
    if (priv?.reminderSentAt) return false; // already further along than a booking SMS
    const startMs = Date.parse(ev.start.dateTime);
    if (Number.isNaN(startMs) || startMs <= nowMs) return false;
    const createdMs = Date.parse(ev.created ?? "");
    if (Number.isNaN(createdMs)) return false; // no stamp → not provably new
    return nowMs - createdMs <= BOOKING_LOOKBACK;
  });
}

/**
 * Appointments whose start no longer matches what the client was last told.
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent[]}
 */
export function selectRescheduledEvents(events, now) {
  const nowMs = toMs(now);
  return events.filter((ev) => {
    if (!ev?.start?.dateTime) return false;
    const notified = ev.extendedProperties?.private?.notifiedStart;
    if (!notified) return false; // we have never told this client anything
    const startMs = Date.parse(ev.start.dateTime);
    const notifiedMs = Date.parse(notified);
    if (Number.isNaN(startMs) || Number.isNaN(notifiedMs)) return false;
    if (startMs <= nowMs) return false;
    // Compare instants, not strings: Google may re-serialize +02:00 as Z for the same moment.
    return startMs !== notifiedMs;
  });
}

/**
 * Has this client already been asked to confirm this appointment? If so a reschedule has to ask
 * again (and drop back to yellow); if not, the reschedule is purely informational.
 *
 * @param {CalendarEvent} ev
 * @returns {boolean}
 */
export function needsReconfirmation(ev) {
  const priv = ev?.extendedProperties?.private;
  return Boolean(priv?.confirmedAt || priv?.reminderSentAt);
}

/**
 * Appointments to escalate to red: asked over 4h ago, still unconfirmed, still in the future,
 * and not already red (so the cron stops re-patching them every tick).
 *
 * The clock runs from the *last* ask, so a reschedule restarts it. Events written before
 * confirmAskedAt existed fall back to reminderSentAt.
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent[]}
 */
export function selectStaleEvents(events, now) {
  const nowMs = toMs(now);
  return events.filter((ev) => {
    const props = ev?.extendedProperties?.private;
    if (!props || props.confirmedAt) return false;
    const askedAt = props.confirmAskedAt ?? props.reminderSentAt;
    if (!askedAt) return false;
    if (ev.colorId === RED) return false;
    const startMs = Date.parse(ev?.start?.dateTime ?? "");
    if (Number.isNaN(startMs) || startMs <= nowMs) return false;
    const askedMs = Date.parse(askedAt);
    if (Number.isNaN(askedMs)) return false;
    return nowMs - askedMs >= 4 * HOUR;
  });
}

/**
 * Prefix the title with a checkmark, idempotently.
 * @param {string|null|undefined} summary
 * @returns {string}
 */
export function withCheck(summary) {
  const text = (summary ?? "").trim();
  return text.startsWith(CHECK) ? text : `${CHECK} ${text}`.trim();
}

/**
 * Drop the checkmark again — a rescheduled appointment is no longer confirmed.
 * @param {string|null|undefined} summary
 * @returns {string}
 */
export function withoutCheck(summary) {
  return (summary ?? "").replace(new RegExp(`^\\s*${CHECK}\\s*`), "").trim();
}

/* ------------------------------------------------------------------ *
 * Google auth
 * ------------------------------------------------------------------ */

/** Access tokens live 1h; the isolate may not. Cold starts simply re-mint. */
let tokenCache = { token: /** @type {string|null} */ (null), expiresAt: 0 };

/** @param {Uint8Array} bytes */
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text */
const base64urlText = (text) => base64url(new TextEncoder().encode(text));

/**
 * PEM → DER. The secret store hands us the key with literal `\n` sequences, not real newlines.
 * @param {string} pem
 * @returns {ArrayBuffer}
 */
function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/**
 * Service-account access token: hand-built RS256 JWT signed with WebCrypto, exchanged for a
 * bearer token. The googleapis SDK does not run on Workers, hence all of this.
 *
 * @param {Env} env
 * @returns {Promise<string>}
 */
export async function getAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiresAt > nowSec + 60) return tokenCache.token;

  const claims = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput =
    `${base64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    `${base64urlText(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.GOOGLE_SA_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${base64url(new Uint8Array(signature))}`,
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: nowSec + (data.expires_in ?? 3600) };
  return tokenCache.token;
}

/* ------------------------------------------------------------------ *
 * Google Calendar + SMSAPI I/O
 * ------------------------------------------------------------------ */

/**
 * @param {Env} env
 * @param {string} token
 * @param {Record<string,string>} params
 * @returns {Promise<CalendarEvent[]>}
 */
async function listEvents(env, token, params) {
  const url = new URL(`${CALENDAR_BASE}/${encodeURIComponent(env.CALENDAR_ID)}/events`);
  url.search = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
    ...params,
  }).toString();

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`calendar list failed: ${res.status} ${await res.text()}`);
  return (await res.json()).items ?? [];
}

/**
 * @param {Env} env
 * @param {string} token
 * @param {string} eventId
 * @param {object} body
 */
async function patchEvent(env, token, eventId, body) {
  const url = `${CALENDAR_BASE}/${encodeURIComponent(env.CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`calendar patch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Send one SMS. Throws on a gateway error so the caller skips the calendar write and the
 * next cron tick retries — a message is never marked sent unless it actually went out.
 *
 * @param {Env} env
 * @param {string} to normalized `48XXXXXXXXX`
 * @param {string} message
 */
async function sendSms(env, to, message) {
  const res = await fetch(SMSAPI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SMSAPI_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      to,
      message,
      from: "2way",
      format: "json",
      encoding: "utf-8",
    }),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`smsapi returned non-JSON (${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`smsapi error ${data.error ?? res.status}: ${data.message ?? raw.slice(0, 200)}`);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

/**
 * Flags recorded whenever we ask a client to confirm: the time we quoted, when we asked, and the
 * SMSAPI id of the ask. The webhook matches replies on that id and nothing else, so overwriting it
 * on every new ask is what makes a TAK answering a superseded message a no-op.
 *
 * A null id deletes the key rather than leaving a stale one in place.
 *
 * @param {any} sendResult parsed sms.do body
 * @param {string} start the start.dateTime quoted in the message
 * @param {Date} now
 * @param {string} eventId for logging
 */
function askProps(sendResult, start, now, eventId) {
  const msgId = extractMsgId(sendResult);
  if (!msgId) {
    console.log(`event ${eventId}: smsapi returned no message id — this ask cannot be confirmed`);
  }
  return {
    notifiedStart: start,
    confirmAskedAt: now.toISOString(),
    confirmAskMsgId: msgId,
  };
}

/**
 * Acknowledge a freshly booked appointment. No colour change (the traffic light is reminder state)
 * and deliberately no confirmAskMsgId — a reply to this message must not confirm anything.
 *
 * @param {Env} env
 * @param {string} token
 * @param {CalendarEvent} ev
 * @param {Date} now
 */
async function sendBookingSms(env, token, ev, now) {
  const phone = parsePhone(`${ev.summary ?? ""} ${ev.description ?? ""}`);
  if (!phone) {
    console.log(`event ${ev.id}: no phone number in title/description — skipped`);
    return;
  }

  const start = /** @type {string} */ (ev.start?.dateTime);
  await sendSms(
    env,
    phone,
    buildBookingMessage({ salonName: env.SALON_NAME, salonPhone: env.SALON_PHONE, start }),
  );

  await patchEvent(env, token, ev.id, {
    extendedProperties: {
      private: {
        ...(ev.extendedProperties?.private ?? {}),
        bookingSmsSentAt: now.toISOString(),
        clientPhone: phone,
        notifiedStart: start,
      },
    },
  });
  console.log(`event ${ev.id}: booking sms sent to ${maskPhone(phone)}`);
}

/**
 * Tell the client their appointment moved. If they had already been asked to confirm the old time,
 * ask again and drop back to yellow — a green appointment the client agreed to at a different hour
 * is worse than no confirmation at all.
 *
 * @param {Env} env
 * @param {string} token
 * @param {CalendarEvent} ev
 * @param {Date} now
 */
async function sendRescheduleSms(env, token, ev, now) {
  const priv = ev.extendedProperties?.private ?? {};
  const phone = priv.clientPhone ?? parsePhone(`${ev.summary ?? ""} ${ev.description ?? ""}`);
  if (!phone) {
    console.log(`event ${ev.id}: no phone number in title/description — skipped`);
    return;
  }

  const start = /** @type {string} */ (ev.start?.dateTime);
  const askConfirm = needsReconfirmation(ev);
  const sent = await sendSms(
    env,
    phone,
    buildRescheduleMessage({
      salonName: env.SALON_NAME,
      salonPhone: env.SALON_PHONE,
      start,
      askConfirm,
    }),
  );

  await patchEvent(
    env,
    token,
    ev.id,
    askConfirm
      ? {
          colorId: YELLOW,
          // Only rewrite a title that exists — an event carrying its phone in the description
          // alone would otherwise be blanked.
          ...(ev.summary ? { summary: withoutCheck(ev.summary) } : {}),
          extendedProperties: {
            private: { ...priv, confirmedAt: null, ...askProps(sent, start, now, ev.id) },
          },
        }
      : { extendedProperties: { private: { ...priv, notifiedStart: start } } },
  );
  console.log(
    `event ${ev.id}: reschedule sms sent to ${maskPhone(phone)} (askConfirm=${askConfirm})`,
  );
}

/**
 * Send one reminder and record it on the event.
 *
 * Order is deliberate: SMS first, calendar write second. A failed send leaves reminderSentAt
 * unset so the next tick retries; the reverse order could mark a reminder sent that never went out.
 *
 * @param {Env} env
 * @param {string} token
 * @param {CalendarEvent} ev
 * @param {Date} now
 */
async function sendReminder(env, token, ev, now) {
  const phone = parsePhone(`${ev.summary ?? ""} ${ev.description ?? ""}`);
  if (!phone) {
    console.log(`event ${ev.id}: no phone number in title/description — skipped`);
    return;
  }

  const start = /** @type {string} */ (ev.start?.dateTime);
  const sent = await sendSms(
    env,
    phone,
    buildMessage({ salonName: env.SALON_NAME, salonPhone: env.SALON_PHONE, start }),
  );

  await patchEvent(env, token, ev.id, {
    colorId: YELLOW,
    extendedProperties: {
      private: {
        ...(ev.extendedProperties?.private ?? {}),
        reminderSentAt: now.toISOString(),
        clientPhone: phone,
        ...askProps(sent, start, now, ev.id),
      },
    },
  });
  console.log(`event ${ev.id}: reminder sent to ${maskPhone(phone)}`);
}

/**
 * Cron entry point.
 *
 * Two reads. The 26h window covers the 23–25h send band and every escalation candidate (asked at
 * ~24h, red from ~20h out until it starts). The second read is everything in the future touched in
 * the last hour, which is where creations and moves show up — `created` and `notifiedStart` then
 * tell the two apart.
 *
 * @param {ScheduledEvent} _event
 * @param {Env} env
 */
async function scheduled(_event, env) {
  const now = new Date();
  const token = await getAccessToken(env);
  const [upcoming, touched] = await Promise.all([
    listEvents(env, token, {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 26 * HOUR).toISOString(),
    }),
    listEvents(env, token, {
      timeMin: now.toISOString(),
      updatedMin: new Date(now.getTime() - BOOKING_LOOKBACK).toISOString(),
    }),
  ]);

  const fresh = selectNewEvents(touched, now);
  const moved = selectRescheduledEvents(touched, now);
  const due = selectDueEvents(upcoming, now);
  const stale = selectStaleEvents(upcoming, now);
  console.log(
    `tick: ${upcoming.length} events in window, ${due.length} due, ${stale.length} stale, ` +
      `${fresh.length} new, ${moved.length} moved`,
  );

  // Booking and reschedule run first, and anything messaged here sits out the reminder loop: an
  // appointment booked ~24h ahead lands in both passes on the same tick, and two SMS seconds apart
  // is spam. The 23–25h window is 2h wide, so the reminder simply goes out on the next tick.
  const messaged = new Set();

  // Per-event try/catch: one bad event must not abort the rest of the run.
  for (const ev of fresh) {
    try {
      await sendBookingSms(env, token, ev, now);
      messaged.add(ev.id);
    } catch (err) {
      console.log(`event ${ev.id}: booking sms failed — ${err.message}`);
    }
  }
  for (const ev of moved) {
    try {
      await sendRescheduleSms(env, token, ev, now);
      messaged.add(ev.id);
    } catch (err) {
      console.log(`event ${ev.id}: reschedule sms failed — ${err.message}`);
    }
  }
  for (const ev of due) {
    if (messaged.has(ev.id)) {
      console.log(`event ${ev.id}: already messaged this tick — reminder deferred to the next one`);
      continue;
    }
    try {
      await sendReminder(env, token, ev, now);
    } catch (err) {
      console.log(`event ${ev.id}: reminder failed — ${err.message}`);
    }
  }
  for (const ev of stale) {
    try {
      await patchEvent(env, token, ev.id, { colorId: RED });
      console.log(`event ${ev.id}: no reply after 4h — marked red`);
    } catch (err) {
      console.log(`event ${ev.id}: escalation failed — ${err.message}`);
    }
  }
}

const okResponse = () =>
  new Response("OK", { headers: { "content-type": "text/plain; charset=utf-8" } });

/** SMSAPI documents MsgId as "nie większej niż 32 znaki". */
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * SMSAPI incoming-SMS webhook. Fields are `sms_from` / `sms_text` / `MsgId`, form-encoded.
 *
 * `MsgId` is the id of the 2way message being replied to, which is the only reliable link between
 * a "TAK" and the appointment it answers — a client may be holding a booking SMS, an old reminder
 * and a reschedule notice at once. We store the id of the last message that *asked* for
 * confirmation, so a reply to anything else matches nothing and is ignored.
 *
 * Every outcome answers 200 with the body `OK` — SMSAPI redelivers indefinitely without it,
 * so even an internal failure is logged and acknowledged rather than surfaced as a 500.
 *
 * @param {Request} request
 * @param {Env} env
 */
async function handleCallback(request, env) {
  if (new URL(request.url).searchParams.get("secret") !== env.CALLBACK_SECRET) {
    console.log("callback rejected: bad or missing secret");
    return new Response("forbidden", { status: 403 });
  }

  try {
    const form = new URLSearchParams(await request.text());
    const phone = parsePhone(form.get("sms_from")); // logging only — MsgId does the matching
    const body = form.get("sms_text") ?? "";
    if (!isConfirmation(body)) {
      // Not a "yes" — possibly a cancellation, so leave a trace for the owner.
      console.log(`callback: non-confirmation from ${maskPhone(phone)}: ${JSON.stringify(body)}`);
      return okResponse();
    }

    const msgId = form.get("MsgId") ?? "";
    if (!MSG_ID_RE.test(msgId)) {
      // Nothing to match on. Log which fields did arrive — that is the diagnostic if SMSAPI ever
      // stops sending MsgId (documented as empty for replies to a dedicated number).
      console.log(
        `callback: confirmation from ${maskPhone(phone)} without a usable MsgId — ` +
          `fields received: ${[...form.keys()].join(", ")}`,
      );
      return okResponse();
    }

    const now = new Date();
    const token = await getAccessToken(env);
    const [match] = await listEvents(env, token, {
      timeMin: now.toISOString(),
      privateExtendedProperty: `confirmAskMsgId=${msgId}`,
    });
    if (!match) {
      console.log(`callback: MsgId ${msgId} answers no pending ask — superseded or informational`);
      return okResponse();
    }

    await patchEvent(env, token, match.id, {
      colorId: GREEN,
      ...(match.summary ? { summary: withCheck(match.summary) } : {}),
      extendedProperties: {
        private: {
          ...(match.extendedProperties?.private ?? {}),
          confirmedAt: now.toISOString(),
        },
      },
    });
    console.log(`event ${match.id}: confirmed by ${maskPhone(phone)}`);
  } catch (err) {
    console.log(`callback error (acknowledged anyway): ${err.message}`);
  }

  return okResponse();
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function handleFetch(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/sms-callback" && request.method === "POST") {
    return handleCallback(request, env);
  }
  if (pathname === "/health") return okResponse();
  return new Response("not found", { status: 404 });
}

export default { scheduled, fetch: handleFetch };
