// Single source of truth for when the training happens.
// The date used to live in RegisterSection.astro in two places, which is how a
// stale date silently closed registration twice. Everything reads it from here now.
//
// Taken from the pasted mock-ups: "Thursday, October 29 at 8:00 PM".
// Lebanon is UTC+2 after the clocks change on Oct 25.
export const WEBINAR_START = '2026-10-29 20:00:00';
export const WEBINAR_START_ISO = '2026-10-29T20:00:00+02:00';

/** Human-readable, for body copy. */
export const WEBINAR_WHEN = 'Thursday, October 29 at 8:00 PM';

/** 90-minute slot, in the UTC basic format Google Calendar expects. */
export const WEBINAR_GCAL_DATES = '20261029T180000Z/20261029T193000Z';

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

/**
 * The registration day as the 0–5 index Brevo automations key off (WEBINAR_DAY):
 *
 *   Sat 24 Oct = 0   Sun = 1   Mon = 2   Tue = 3   Wed = 4   Thu 29 Oct = 5
 *
 * Counted backwards from the webinar rather than forwards from a hardcoded start,
 * so moving WEBINAR_START moves the whole scale with it instead of silently
 * mislabelling everyone.
 *
 * Dates are resolved in Asia/Beirut, not the server's zone: a Cloudflare worker
 * answering from UTC would roll the day over two or three hours early and put
 * late-evening registrants a day ahead of where the automation expects them.
 */
export function webinarDayIndex(now: Date = new Date()): number {
  const inBeirut = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Beirut',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);

  const today = Date.parse(inBeirut(now));
  const webinarDay = Date.parse(WEBINAR_START.slice(0, 10));
  const daysUntil = Math.round((webinarDay - today) / 86_400_000);

  // Clamped: an early or late signup still lands on a step the automation knows.
  return Math.min(5, Math.max(0, 5 - daysUntil));
}
