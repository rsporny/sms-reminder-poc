import { describe, expect, it } from "vitest";
import {
  buildMessage,
  formatWhen,
  gsmSanitize,
  isConfirmation,
  maskPhone,
  parsePhone,
  pickNearestUnconfirmed,
  selectDueEvents,
  selectStaleEvents,
  withCheck,
} from "../src/index.js";

const HOUR = 3600_000;
const NOW = new Date("2026-08-27T10:00:00Z");

/** Build a calendar event `hours` from NOW. */
function event(hours, { id = "e1", priv = null, colorId = undefined, allDay = false } = {}) {
  const at = new Date(NOW.getTime() + hours * HOUR).toISOString();
  return {
    id,
    summary: "Anna Kowalska 500123456",
    start: allDay ? { date: at.slice(0, 10) } : { dateTime: at },
    ...(colorId ? { colorId } : {}),
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

describe("buildMessage", () => {
  // GSM 03.38 basic alphabet: anything outside it forces Unicode encoding (70 chars/SMS).
  const GSM7 =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

  const message = buildMessage({
    salonName: "Salon Piękność Anny",
    salonPhone: "500 100 200",
    start: "2026-08-28T14:00:00+02:00",
  });

  it("renders the reminder in Polish without diacritics", () => {
    expect(message).toContain("Salon Pieknosc Anny");
    expect(message).toContain("Odpisz TAK aby potwierdzic");
    expect(message).toContain("14:00");
  });

  it("stays inside one GSM-7 SMS", () => {
    expect(message.length).toBeLessThanOrEqual(160);
    const offending = [...message].filter((ch) => !GSM7.includes(ch));
    expect(offending).toEqual([]);
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

describe("selectStaleEvents", () => {
  const sentHoursAgo = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();

  it("escalates a reminder unanswered for over 4h", () => {
    const events = [event(20, { priv: { reminderSentAt: sentHoursAgo(5) } })];
    expect(selectStaleEvents(events, NOW)).toHaveLength(1);
  });

  it("waits while the reminder is younger than 4h", () => {
    const events = [event(20, { priv: { reminderSentAt: sentHoursAgo(3) } })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });

  it("leaves confirmed appointments alone", () => {
    const priv = { reminderSentAt: sentHoursAgo(5), confirmedAt: sentHoursAgo(1) };
    expect(selectStaleEvents([event(20, { priv })], NOW)).toEqual([]);
  });

  it("ignores appointments already in the past", () => {
    const events = [event(-2, { priv: { reminderSentAt: sentHoursAgo(5) } })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });

  it("does not re-patch an event that is already red", () => {
    const events = [event(20, { priv: { reminderSentAt: sentHoursAgo(5) }, colorId: "11" })];
    expect(selectStaleEvents(events, NOW)).toEqual([]);
  });
});

describe("pickNearestUnconfirmed", () => {
  it("picks the soonest future appointment", () => {
    const events = [event(48, { id: "later" }), event(5, { id: "soon" })];
    expect(pickNearestUnconfirmed(events, NOW).id).toBe("soon");
  });

  it("skips already-confirmed appointments", () => {
    const events = [
      event(5, { id: "confirmed", priv: { confirmedAt: NOW.toISOString() } }),
      event(48, { id: "open" }),
    ];
    expect(pickNearestUnconfirmed(events, NOW).id).toBe("open");
  });

  it("ignores past appointments", () => {
    expect(pickNearestUnconfirmed([event(-1)], NOW)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickNearestUnconfirmed([], NOW)).toBeNull();
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
