/**
 * The webinar email sequence.
 *
 * Pure decision logic: given a registration time and "now", it says which
 * template is due and when. No network, no sheet, no Brevo — so every rule
 * below is testable without sending anything to anyone.
 *
 * Shape of the campaign (all times Asia/Beirut):
 *
 *   Sat 24  day 0   23 on signup
 *   Sun 25  day 1   23 on signup · 26 at 10:00 (or signup+1h if they joined today)
 *   Mon 26  day 2   23 on signup · 27 at 10:00 (or signup+1h)
 *   Tue 27  day 3   23 on signup · 28 at 12:00 (or signup+1h)
 *   Wed 28  day 4   23 on signup · 30 at 18:00 (or signup+1h)
 *   Thu 29  day 5   31 on signup (replaces 23) · 32 at 19:00 · 33 at 20:00
 *
 * Two rules that are easy to miss:
 *
 *  - No back-fill. You receive your own day's email onward, never the earlier
 *    ones. Someone joining Wednesday never sees 26, 27 or 28.
 *  - The day's email is offset to signup+1h ONLY on the day you register, so the
 *    confirmation always lands first. Everyone who registered earlier gets the
 *    plain slot time. The Thursday reminders are exempt: "one hour before" and
 *    "we're live" are anchored to the webinar, and delaying them would make them
 *    untrue.
 */

export const TIMEZONE = 'Asia/Beirut';

/** Brevo template ids. */
export const T = {
  CONFIRMATION: 23,
  SUNDAY: 26,
  MONDAY: 27,
  TUESDAY: 28,
  WEDNESDAY: 30,
  THURSDAY_CONFIRMATION: 31,
  HOUR_BEFORE: 32,
  LIVE_NOW: 33,
} as const;

/** Every template the sequence can send, for the sheet's tracking columns. */
export const ALL_TEMPLATES = [23, 26, 27, 28, 30, 31, 32, 33] as const;
export type TemplateId = (typeof ALL_TEMPLATES)[number];

/** Campaign days, keyed by the 0–5 index webinarDayIndex() produces. */
interface DaySpec {
  /** Sent the moment someone registers on this day. */
  onSignup: TemplateId;
  /** The day's scheduled email, or null where the day has none. */
  daily: { template: TemplateId; hour: number } | null;
  /** Fixed-time sends that apply to everyone, never offset. */
  anchored: { template: TemplateId; hour: number }[];
}

export const DAYS: Record<number, DaySpec> = {
  // Saturday — the campaign starts tomorrow, so today is confirmation only.
  0: { onSignup: T.CONFIRMATION, daily: null, anchored: [] },
  1: { onSignup: T.CONFIRMATION, daily: { template: T.SUNDAY, hour: 10 }, anchored: [] },
  2: { onSignup: T.CONFIRMATION, daily: { template: T.MONDAY, hour: 10 }, anchored: [] },
  3: { onSignup: T.CONFIRMATION, daily: { template: T.TUESDAY, hour: 12 }, anchored: [] },
  4: { onSignup: T.CONFIRMATION, daily: { template: T.WEDNESDAY, hour: 18 }, anchored: [] },
  // Thursday: a different confirmation, and the two reminders everyone gets.
  5: {
    onSignup: T.THURSDAY_CONFIRMATION,
    daily: null,
    anchored: [
      { template: T.HOUR_BEFORE, hour: 19 },
      { template: T.LIVE_NOW, hour: 20 },
    ],
  },
};

/**
 * After this hour, a signup+1h email would land in the middle of the night, so
 * it is dropped and that person simply joins the next day's send.
 */
export const LATE_CUTOFF_HOUR = 21;

export interface PlannedSend {
  template: TemplateId;
  /** When to send, as an absolute instant. */
  at: Date;
  /** Why it is in the plan — useful in logs and in the sheet. */
  reason: 'signup' | 'same-day-offset' | 'daily-slot' | 'anchored';
}

/** The calendar date, in Beirut, that an instant falls on. */
export function beirutDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The hour of day, in Beirut, that an instant falls on. */
export function beirutHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(at),
  );
}

/**
 * Builds the instant for a given Beirut wall-clock time on a given Beirut date.
 *
 * Done by probing rather than by assuming a fixed offset: Lebanon leaves DST on
 * 25 October, in the middle of this very campaign, so a hardcoded +02:00 or
 * +03:00 would put Sunday's 10:00 send an hour out.
 */
export function beirutInstant(dateYMD: string, hour: number): Date {
  const [y, m, d] = dateYMD.split('-').map(Number);
  // Start from the UTC guess, then correct by the zone's actual offset that day.
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const asBeirut = new Date(guess);
  const offsetMinutes =
    (new Date(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(asBeirut).replace(',', ''),
    ).getTime() -
      new Date(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(asBeirut).replace(',', ''),
      ).getTime()) /
    60000;
  return new Date(guess + offsetMinutes * 60000);
}

/**
 * What to send someone the moment they register.
 *
 * Returns the confirmation plus, where the day has one, that day's email at
 * signup+1h. On Thursday it returns the reminders too, since those are anchored
 * and a late registrant still needs them.
 */
export function planOnSignup(dayIndex: number, registeredAt: Date): PlannedSend[] {
  const spec = DAYS[dayIndex];
  if (!spec) return [];

  const today = beirutDate(registeredAt);
  const plan: PlannedSend[] = [];

  // Thursday after the webinar has started: nothing at all.
  if (dayIndex === 5 && beirutHour(registeredAt) >= 20) return [];

  plan.push({ template: spec.onSignup, at: registeredAt, reason: 'signup' });

  if (spec.daily) {
    const offset = new Date(registeredAt.getTime() + 60 * 60 * 1000);
    // Dropped rather than sent at 2am; they join tomorrow's slot instead.
    if (beirutHour(registeredAt) < LATE_CUTOFF_HOUR) {
      plan.push({ template: spec.daily.template, at: offset, reason: 'same-day-offset' });
    }
  }

  for (const a of spec.anchored) {
    const at = beirutInstant(today, a.hour);
    // Only what is still ahead of them.
    if (at.getTime() > registeredAt.getTime()) {
      plan.push({ template: a.template, at, reason: 'anchored' });
    }
  }

  return plan;
}

/**
 * What to send, on a given day, to someone who registered earlier.
 *
 * These are the plain slot times — no offset, because their confirmation went
 * out on a previous day and cannot be overtaken.
 */
export function planForDay(todayIndex: number, todayYMD: string): PlannedSend[] {
  const spec = DAYS[todayIndex];
  if (!spec) return [];

  const plan: PlannedSend[] = [];
  if (spec.daily) {
    plan.push({
      template: spec.daily.template,
      at: beirutInstant(todayYMD, spec.daily.hour),
      reason: 'daily-slot',
    });
  }
  for (const a of spec.anchored) {
    plan.push({ template: a.template, at: beirutInstant(todayYMD, a.hour), reason: 'anchored' });
  }
  return plan;
}
