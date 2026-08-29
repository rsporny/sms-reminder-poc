import { describe, expect, it } from "vitest";
import {
  buildBookingMessage,
  buildMessage,
  buildRescheduleMessage,
  extractMsgId,
  formatWhen,
  gsmSanitize,
  isConfirmation,
  maskPhone,
  needsReconfirmation,
  parsePhone,
  selectDueEvents,
  selectNewEvents,
  selectRescheduledEvents,
  selectStaleEvents,
  withCheck,
  withoutCheck,
} from "../src/index.js";

const HOUR = 3600_000;
const NOW = new Date("2026-08-27T10:00:00Z");

// GSM 03.38 basic alphabet: anything outside it forces Unicode encoding (70 chars/SMS).
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** Assert a message fits in a single GSM-7 SMS. */
function expectOneSms(message) {
  expect(message.length).toBeLessThanOrEqual(160);
  expect([...message].filter((ch) => !GSM7.includes(ch))).toEqual([]);
}

/** Build a calendar event `hours` from NOW. `createdHoursAgo: null` omits the created stamp. */
function event(
  hours,
  {
    id = "e1",
    priv = null,
    colorId = undefined,
    allDay = false,
    createdHoursAgo = 24 * 30,
    recurringEventId = undefined,
  } = {},
) {
  const at = new Date(NOW.getTime() + hours * HOUR).toISOString();
  return {
    id,
    summary: "Anna Kowalska 500123456",
    start: allDay ? { date: at.slice(0, 10) } : { dateTime: at },
    ...(createdHoursAgo === null
      ? {}
      : { created: new Date(NOW.getTime() - createdHoursAgo * HOUR).toISOString() }),
    ...(colorId ? { colorId } : {}),
    ...(recurringEventId ? { recurringEventId } : {}),
    ...(priv ? { extendedProperties: { private: priv } } : {}),
  };
}

describe("parsePhone", () => {
  it("reads a bare 9-digit number out of a title", () => {
    expect(parsePhone("Anna Kowalska 500123456 — strzyzenie")).toBe("48500123456");
  });

  it("accepts +48 and 48 prefixes", () => {
    expect(parsePhone("Jan +48500123456")).toBe("48500123456");
    expect(parsePhone("Jan 48500123456")).toBe("48500123456");
    expect(parsePhone("Jan +48 500 123 456")).toBe("48500123456");
  });

  it("accepts spaces, dashes and dots between digits", () => {
    expect(parsePhone("500 123 456")).toBe("48500123456");
    expect(parsePhone("500-123-456")).toBe("48500123456");
    expect(parsePhone("500.123.456")).toBe("48500123456");
  });

  it("returns null when there is no number", () => {
    expect(parsePhone("Anna Kowalska — koloryzacja")).toBeNull();
    expect(parsePhone("")).toBeNull();
    expect(parsePhone(null)).toBeNull();
  });

  it("ignores digit runs that are not 9 digits long", () => {
    expect(parsePhone("faktura 123456789012")).toBeNull(); // too long
    expect(parsePhone("pokoj 1234")).toBeNull(); // too short
  });
});

describe("maskPhone", () => {
  it("hides the middle of the number", () => {
    expect(maskPhone("48500123456")).toBe("48500***456");
  });

  it("degrades safely on junk input", () => {
    expect(maskPhone(null)).toBe("***");
    expect(maskPhone("123")).toBe("***");
  });
});

describe("gsmSanitize", () => {
  it("strips every Polish diacritic, both cases", () => {
    expect(gsmSanitize("ąćęłńóśźż")).toBe("acelnoszz");
    expect(gsmSanitize("ĄĆĘŁŃÓŚŹŻ")).toBe("ACELNOSZZ");
  });

  it("leaves plain ASCII untouched", () => {
    expect(gsmSanitize("Odpisz TAK aby potwierdzic.")).toBe("Odpisz TAK aby potwierdzic.");
  });
});

const messageArgs = {
  salonName: "Salon Piękność Anny",
  salonPhone: "500 100 200",
  start: "2026-08-28T14:00:00+02:00",
};

describe("buildMessage", () => {
  const message = buildMessage(messageArgs);

  it("renders the reminder in Polish without diacritics", () => {
    expect(message).toContain("Salon Pieknosc Anny");
    expect(message).toContain("Odpisz TAK aby potwierdzic");
    expect(message).toContain("14:00");
  });

  it("stays inside one GSM-7 SMS", () => expectOneSms(message));
});

describe("buildBookingMessage", () => {
  const message = buildBookingMessage(messageArgs);

  it("acknowledges the booking with its date and time", () => {
    expect(message).toContain("Salon Pieknosc Anny");
    expect(message).toContain("rezerwacja przyjeta");
    expect(message).toContain("14:00");
  });

  it("never asks for a confirmation — that is the reminder's job", () => {
    expect(message).not.toContain("TAK");
  });

  it("stays inside one GSM-7 SMS", () => expectOneSms(message));
});

describe("buildRescheduleMessage", () => {
  const info = buildRescheduleMessage(messageArgs);
  const ask = buildRescheduleMessage({ ...messageArgs, askConfirm: true });

  it("announces the new time in both variants", () => {
    for (const message of [info, ask]) {
      expect(message).toContain("zmiana terminu");
      expect(message).toContain("14:00");
    }
  });

  it("asks for TAK only when the client had already been asked to confirm", () => {
    expect(info).not.toContain("TAK");
    expect(ask).toContain("Odpisz TAK aby potwierdzic");
  });

  it("stays inside one GSM-7 SMS", () => {
    expectOneSms(info);
    expectOneSms(ask);
  });
});

describe("extractMsgId", () => {
  it("reads the id out of a sms.do response", () => {
    const response = { count: 1, list: [{ id: "1460969715572091219", status: "QUEUE" }] };
    expect(extractMsgId(response)).toBe("1460969715572091219");
  });

  it("coerces a numeric id to a string", () => {
    expect(extractMsgId({ list: [{ id: 1460969715572091 }] })).toBe("1460969715572091");
  });

  it("returns null when there is no id to store", () => {
    expect(extractMsgId({})).toBeNull();
    expect(extractMsgId({ count: 0, list: [] })).toBeNull();
    expect(extractMsgId({ error: 13, message: "No correct phone numbers" })).toBeNull();
    expect(extractMsgId(null)).toBeNull();
  });
});

describe("formatWhen", () => {
  // Same UTC instant, six months apart: Warsaw is UTC+1 in winter and UTC+2 in summer.
  // A hardcoded offset would make one of these wrong.
  it("renders winter instants in CET", () => {
    expect(formatWhen("2026-01-15T12:00:00Z").time).toBe("13:00");
  });

  it("renders summer instants in CEST", () => {
    expect(formatWhen("2026-07-15T12:00:00Z").time).toBe("14:00");
  });

  it("renders a diacritic-free weekday and dd.MM date", () => {
    const { date } = formatWhen("2026-08-28T14:00:00+02:00");
    expect(date).toMatch(/^[a-z]+ 28\.08$/);
  });
});

describe("isConfirmation", () => {
  it.each(["TAK", "tak", "TAK.", "Tak, będę", "ok", "OK!", "potwierdzam", "  tak  "])(
    "treats %j as a confirmation",
    (reply) => expect(isConfirmation(reply)).toBe(true),
  );

  it.each(["NIE", "odwoluje", "taksowka", "nie moge przyjsc", "", null])(
    "treats %j as not a confirmation",
    (reply) => expect(isConfirmation(reply)).toBe(false),
  );
});

describe("selectDueEvents", () => {
  it("takes only events starting 23-25h out", () => {
    const events = [event(22), event(23), event(24), event(25), event(26)];
    const starts = selectDueEvents(events, NOW).map((e) => e.start.dateTime);
    expect(starts).toEqual([23, 24, 25].map((h) => new Date(NOW.getTime() + h * HOUR).toISOString()));
  });

  it("skips events already reminded", () => {
    const events = [event(24, { priv: { reminderSentAt: NOW.toISOString() } })];
    expect(selectDueEvents(events, NOW)).toEqual([]);
  });

  it("skips all-day events", () => {
    expect(selectDueEvents([event(24, { allDay: true })], NOW)).toEqual([]);
  });
});

describe("selectNewEvents", () => {
  const fresh = { createdHoursAgo: 10 / 60 }; // booked 10 minutes ago

  it("takes a just-created future appointment", () => {
    expect(selectNewEvents([event(48, fresh)], NOW)).toHaveLength(1);
  });

  it("ignores anything created before the lookback", () => {
    // Also the first-deploy guarantee: an existing calendar is never blasted retroactively.
    expect(selectNewEvents([event(48, { createdHoursAgo: 3 })], NOW)).toEqual([]);
  });

  it("never acknowledges the same booking twice", () => {
    const priv = { bookingSmsSentAt: NOW.toISOString() };
    expect(selectNewEvents([event(48, { ...fresh, priv })], NOW)).toEqual([]);
  });

  it("skips events already further along than a booking", () => {
    const priv = { reminderSentAt: NOW.toISOString() };
    expect(selectNewEvents([event(24, { ...fresh, priv })], NOW)).toEqual([]);
  });

  it("skips instances of a recurring series", () => {
    const events = [event(48, { ...fresh, recurringEventId: "series-1" })];
    expect(selectNewEvents(events, NOW)).toEqual([]);
  });

  it("skips all-day events and appointments already in the past", () => {
    expect(selectNewEvents([event(48, { ...fresh, allDay: true })], NOW)).toEqual([]);
    expect(selectNewEvents([event(-2, fresh)], NOW)).toEqual([]);
  });

  it("skips events with no created stamp — they are not provably new", () => {
    expect(selectNewEvents([event(48, { createdHoursAgo: null })], NOW)).toEqual([]);
  });
});

describe("selectRescheduledEvents", () => {
  const startAt = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();

  it("spots an appointment that no longer starts when the client was told", () => {
    const events = [event(48, { priv: { notifiedStart: startAt(24) } })];
    expect(selectRescheduledEvents(events, NOW)).toHaveLength(1);
  });

  it("compares instants, not strings", () => {
    // Google may hand back +02:00 where we stored Z — the same moment, not a reschedule.
    const events = [
      {
        ...event(48),
        start: { dateTime: "2026-08-28T14:00:00+02:00" },
        extendedProperties: { private: { notifiedStart: "2026-08-28T12:00:00Z" } },
      },
    ];
    expect(selectRescheduledEvents(events, NOW)).toEqual([]);
  });

  it("ignores events the client has never been told about", () => {
    expect(selectRescheduledEvents([event(48)], NOW)).toEqual([]);
  });

  it("ignores all-day events and appointments already in the past", () => {
    const priv = { notifiedStart: startAt(24) };
    expect(selectRescheduledEvents([event(48, { priv, allDay: true })], NOW)).toEqual([]);
    expect(selectRescheduledEvents([event(-2, { priv })], NOW)).toEqual([]);
  });
});

describe("needsReconfirmation", () => {
  it("is true once the client has been asked to confirm", () => {
    expect(needsReconfirmation(event(24, { priv: { reminderSentAt: NOW.toISOString() } }))).toBe(true);
    expect(needsReconfirmation(event(24, { priv: { confirmedAt: NOW.toISOString() } }))).toBe(true);
  });

  it("is false for an appointment that only got a booking SMS", () => {
    const priv = { bookingSmsSentAt: NOW.toISOString(), notifiedStart: NOW.toISOString() };
    expect(needsReconfirmation(event(24, { priv }))).toBe(false);
    expect(needsReconfirmation(event(24))).toBe(false);
  });
});

describe("selectStaleEvents", () => {
  const hoursAgo = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();

  it("escalates an ask unanswered for over 4h", () => {
    const events = [event(20, { priv: { confirmAskedAt: hoursAgo(5) } })];
    expect(selectStaleEvents(events, NOW)).toHaveLength(1);
  });

  it("waits while the ask is younger than 4h", () => {
    const events = [event(20, { priv: { confirmAskedAt: hoursAgo(3) } })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });

  it("falls back to reminderSentAt for events predating confirmAskedAt", () => {
    const events = [event(20, { priv: { reminderSentAt: hoursAgo(5) } })];
    expect(selectStaleEvents(events, NOW)).toHaveLength(1);
  });

  it("restarts the clock when a reschedule re-asks", () => {
    const priv = { reminderSentAt: hoursAgo(9), confirmAskedAt: hoursAgo(1) };
    expect(selectStaleEvents([event(20, { priv })], NOW)).toEqual([]);
  });

  it("leaves confirmed appointments alone", () => {
    const priv = { confirmAskedAt: hoursAgo(5), confirmedAt: hoursAgo(1) };
    expect(selectStaleEvents([event(20, { priv })], NOW)).toEqual([]);
  });

  it("ignores appointments already in the past", () => {
    const events = [event(-2, { priv: { confirmAskedAt: hoursAgo(5) } })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });

  it("does not re-patch an event that is already red", () => {
    const events = [event(20, { priv: { confirmAskedAt: hoursAgo(5) }, colorId: "11" })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });
});

describe("withCheck", () => {
  it("prefixes the checkmark", () => {
    expect(withCheck("Anna Kowalska 500123456")).toBe("✅ Anna Kowalska 500123456");
  });

  it("is idempotent so repeated confirmations do not stack", () => {
    expect(withCheck("✅ Anna Kowalska")).toBe("✅ Anna Kowalska");
  });
});

describe("withoutCheck", () => {
  it("drops the checkmark when a confirmed appointment moves", () => {
    expect(withoutCheck("✅ Anna Kowalska 500123456")).toBe("Anna Kowalska 500123456");
  });

  it("leaves an unconfirmed title untouched", () => {
    expect(withoutCheck("Anna Kowalska")).toBe("Anna Kowalska");
    expect(withoutCheck(null)).toBe("");
  });

  it("round-trips with withCheck", () => {
    expect(withoutCheck(withCheck("Anna Kowalska"))).toBe("Anna Kowalska");
  });
});
