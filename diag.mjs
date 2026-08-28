// Throwaway diagnostic: what does the service account actually see on the calendar?
// Reuses the Worker's real getAccessToken so it exercises the same auth path.
// Run: node diag.mjs      Delete when done.
import { readFileSync } from "node:fs";
import { getAccessToken } from "./src/index.js";

const readVar = (file, key) => {
  const line = readFileSync(file, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*(".*")\\s*$`, "m"));
  if (!line) throw new Error(`${key} not found in ${file}`);
  return JSON.parse(line[1]);
};

const env = {
  GOOGLE_SA_EMAIL: readVar(".dev.vars", "GOOGLE_SA_EMAIL"),
  GOOGLE_SA_PRIVATE_KEY: readVar(".dev.vars", "GOOGLE_SA_PRIVATE_KEY"),
  CALENDAR_ID: readVar("wrangler.toml", "CALENDAR_ID"),
};

const now = new Date();
const warsaw = (d) =>
  new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short",
  }).format(d);

console.log(`service account : ${env.GOOGLE_SA_EMAIL}`);
console.log(`calendar        : ${env.CALENDAR_ID}`);
console.log(`now             : ${now.toISOString()}  (Warsaw ${warsaw(now)})`);

const sendFrom = new Date(now.getTime() + 23 * 3600_000);
const sendTo = new Date(now.getTime() + 25 * 3600_000);
console.log(`\nAn appointment must START inside this window to get a reminder:`);
console.log(`  ${warsaw(sendFrom)}  ..  ${warsaw(sendTo)}   (Warsaw local)`);

const token = await getAccessToken(env);
console.log(`\nauth            : OK, token acquired`);

// Deliberately wide: -7d..+30d, so we see events the 26h cron window would miss.
const url = new URL(
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events`,
);
url.search = new URLSearchParams({
  singleEvents: "true",
  orderBy: "startTime",
  maxResults: "50",
  timeMin: new Date(now.getTime() - 7 * 86400_000).toISOString(),
  timeMax: new Date(now.getTime() + 30 * 86400_000).toISOString(),
}).toString();

const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.log(`\nEVENTS LIST FAILED: ${res.status}\n${await res.text()}`);
  process.exit(1);
}
const items = (await res.json()).items ?? [];

console.log(`\n${items.length} event(s) visible in -7d..+30d:\n`);
if (items.length === 0) {
  console.log("  (none) — the service account can read this calendar but it is empty.");
  console.log("  The appointments were almost certainly created in a DIFFERENT calendar.");
}

for (const ev of items) {
  const iso = ev.start?.dateTime ?? ev.start?.date;
  const allDay = !ev.start?.dateTime;
  const hours = (Date.parse(iso) - now.getTime()) / 3600_000;
  const inWindow = !allDay && hours >= 23 && hours <= 25;
  const priv = ev.extendedProperties?.private ?? {};
  console.log(
    `  ${inWindow ? "✅ IN WINDOW" : "—           "} ${hours >= 0 ? "+" : ""}${hours.toFixed(1)}h  ` +
      `${allDay ? "[all-day] " : ""}${JSON.stringify(ev.summary ?? "(no title)")}`,
  );
  console.log(
    `                 start=${iso} color=${ev.colorId ?? "default"} ` +
      `sent=${priv.reminderSentAt ?? "-"} confirmed=${priv.confirmedAt ?? "-"}`,
  );
}
