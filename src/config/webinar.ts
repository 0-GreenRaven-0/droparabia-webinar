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
export const SOCIAL_YOUTUBE = 'https://www.youtube.com/@MJ.biznes';
