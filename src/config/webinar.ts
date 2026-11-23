// Single source of truth for when the training happens.
// The date used to live in RegisterSection.astro in two places, which is how a
// stale date silently closed registration twice. Everything reads it from here now.
//
// Third Webinar: Thursday, November 26 at 7:00 PM. Lebanon is UTC+2 in
// November — the clocks already changed back on Oct 25, well before this date.
export const WEBINAR_START = '2026-11-26 19:00:00';
export const WEBINAR_START_ISO = '2026-11-26T19:00:00+02:00';

/** Human-readable, for body copy. */
export const WEBINAR_WHEN = 'Thursday, November 26 at 7:00 PM';

/**
 * How many seats the page sells, and the point past which a registration stops
 * costing us anything.
 *
 * Registrations are never turned away — the row is still written, so the lead is
 * still ours — but once this many have been taken we stop creating the Brevo
 * contact, which means no confirmation email and no sequence past the limit.
 * Every contact past it spends credits on someone who has no seat.
 *
 * Lived in api/spots.ts alone while api/register.ts had no idea what the limit
 * was. It has been changed three times mid-campaign, which is exactly the kind of
 * number that must not exist in two places.
 */
export const TOTAL_SEATS = 500;

/**
 * Whether a new registration still reaches Brevo.
 *
 * On: registrants inside the seat limit get their contact, the confirmation
 * email and their sequence, exactly as the campaign has run all along.
 *
 * Off: nothing new is pushed to Brevo at all and registrants are confirmed on
 * WhatsApp from the sheet instead. Either way nobody already in Brevo is
 * affected — existing contacts keep every email already scheduled against them
 * and the daily job keeps running their sequence untouched.
 */
export const BREVO_ENABLED = true;

/**
 * Which Brevo list a new registration joins.
 *
 * Replaces the old per-template scheduling entirely: a contact is added to
 * exactly one list, the one for the calendar day they registered on, and
 * whatever automation is built on that list in Brevo itself carries them from
 * there. There is no more scheduledAt, no sequence.ts, and no daily job — the
 * old code decided what to send and when; Brevo's own automation does now.
 *
 * Updated by hand as each new day of the campaign starts. "Day 1" here is not
 * webinarDayIndex's old 0–5 scale — it is simply day 1 of this list-based
 * design, starting the day this was introduced (23 Nov 2026).
 */
export const CURRENT_DAY_LIST_ID = 29; // Day 1 — 23 Nov 2026

/** 90-minute slot, in the UTC basic format Google Calendar expects. */
export const WEBINAR_GCAL_DATES = '20261126T170000Z/20261126T183000Z';

export const WEBINAR_GCAL_URL =
  'https://calendar.google.com/calendar/render?action=TEMPLATE' +
  '&text=' + encodeURIComponent('Droparabia Free Live Training') +
  '&dates=' + WEBINAR_GCAL_DATES +
  '&details=' + encodeURIComponent('Live training with Majd. The Zoom link will be sent on WhatsApp.');

/**
 * Where "Join the WhatsApp Channel" points on the thank-you page.
 * The mock-up left this as [WHATSAPP CHANNEL LINK] — until a real URL is set
 * the button renders disabled rather than linking somewhere broken.
 */
export const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb8ydrhLdQeih1BBR02m';

export const SOCIAL_INSTAGRAM = 'https://www.instagram.com/mjbusinessofficial';
export const SOCIAL_THREADS = 'https://www.threads.com/@mjbusinessofficial';
export const SOCIAL_YOUTUBE = 'https://www.youtube.com/@MJ.biznes';

// webinarDayIndex() — the old 0–5 scale counted back from WEBINAR_START, and
// the WEBINAR_DAY contact attribute it fed — is gone along with sequence.ts.
// CURRENT_DAY_LIST_ID above is what carries the "which day" signal now.
