/**
 * Salon SMS Reminder — the entire Worker.
 *
 * scheduled(): every 15 min, sends a reminder SMS ~24h before each appointment and
 * escalates unanswered ones to red. fetch(): receives the client's "TAK" reply from SMSAPI.
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
 * @property {{ dateTime?: string, date?: string }} [start]
 * @property {{ private?: Record<string,string> }} [extendedProperties]
 */

const HOUR = 3600_000;
const TZ = "Europe/Warsaw";
const CHECK = "✅";

/** Traffic light the salon owner reads off the calendar. */
const YELLOW = "5"; // SMS sent, awaiting reply
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
 * The reminder SMS. Polish (the clients are Polish) but diacritic-free, and ≤160 GSM-7 chars.
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
 * Appointments to escalate to red: reminded over 4h ago, still unconfirmed, still in the future,
 * and not already red (so the cron stops re-patching them every tick).
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent[]}
 */
export function selectStaleEvents(events, now) {
  const nowMs = toMs(now);
  return events.filter((ev) => {
    const props = ev?.extendedProperties?.private;
    if (!props?.reminderSentAt || props.confirmedAt) return false;
    if (ev.colorId === RED) return false;
    const startMs = Date.parse(ev?.start?.dateTime ?? "");
    if (Number.isNaN(startMs) || startMs <= nowMs) return false;
    const sentMs = Date.parse(props.reminderSentAt);
    if (Number.isNaN(sentMs)) return false;
    return nowMs - sentMs >= 4 * HOUR;
  });
}

/**
 * Which appointment does an incoming "TAK" belong to? The soonest future unconfirmed one.
 *
 * @param {CalendarEvent[]} events
 * @param {Date|number} now
 * @returns {CalendarEvent|null}
 */
export function pickNearestUnconfirmed(events, now) {
  const nowMs = toMs(now);
  let best = null;
  let bestMs = Infinity;
  for (const ev of events) {
    if (ev?.extendedProperties?.private?.confirmedAt) continue;
    const startMs = Date.parse(ev?.start?.dateTime ?? ev?.start?.date ?? "");
    if (Number.isNaN(startMs) || startMs <= nowMs || startMs >= bestMs) continue;
    best = ev;
    bestMs = startMs;
  }
  return best;
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
 * next cron tick retries — a reminder is never marked sent unless it actually went out.
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

  await sendSms(
    env,
    phone,
    buildMessage({
      salonName: env.SALON_NAME,
      salonPhone: env.SALON_PHONE,
      start: /** @type {string} */ (ev.start?.dateTime),
    }),
  );

  await patchEvent(env, token, ev.id, {
    colorId: YELLOW,
    extendedProperties: {
      private: {
        ...(ev.extendedProperties?.private ?? {}),
        reminderSentAt: now.toISOString(),
        clientPhone: phone,
      },
    },
  });
  console.log(`event ${ev.id}: reminder sent to ${maskPhone(phone)}`);
}

/**
 * Cron entry point. One calendar read serves both passes — the 26h window covers the 23–25h
 * send band and every escalation candidate (reminded at ~24h, red from ~20h out until it starts).
 *
 * @param {ScheduledEvent} _event
 * @param {Env} env
 */
async function scheduled(_event, env) {
  const now = new Date();
  const token = await getAccessToken(env);
  const events = await listEvents(env, token, {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + 26 * HOUR).toISOString(),
  });

  const due = selectDueEvents(events, now);
  const stale = selectStaleEvents(events, now);
  console.log(`tick: ${events.length} events in window, ${due.length} due, ${stale.length} stale`);

  // Per-event try/catch: one bad event must not abort the rest of the run.
  for (const ev of due) {
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

/**
 * SMSAPI incoming-SMS webhook. Fields are `sms_from` / `sms_text`, form-encoded.
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
    const phone = parsePhone(form.get("sms_from"));
    const body = form.get("sms_text") ?? "";
    if (!phone) {
      console.log(`callback: unrecognized sender ${JSON.stringify(form.get("sms_from"))}`);
      return okResponse();
    }
    if (!isConfirmation(body)) {
      // Not a "yes" — possibly a cancellation, so leave a trace for the owner.
      console.log(`callback: non-confirmation from ${maskPhone(phone)}: ${JSON.stringify(body)}`);
      return okResponse();
    }

    const now = new Date();
    const token = await getAccessToken(env);
    const events = await listEvents(env, token, {
      timeMin: now.toISOString(),
      privateExtendedProperty: `clientPhone=${phone}`,
    });

    const match = pickNearestUnconfirmed(events, now);
    if (!match) {
      console.log(`callback: no pending appointment for ${maskPhone(phone)}`);
      return okResponse();
    }

    await patchEvent(env, token, match.id, {
      colorId: GREEN,
      summary: withCheck(match.summary),
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
