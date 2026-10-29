export const prerender = false;

import type { APIRoute } from 'astro';
import { getRuntimeEnv } from '../../lib/env';
import { brevoAddContact, brevoSendTemplate } from '../../lib/brevo';
import { webinarDayIndex, TOTAL_SEATS } from '../../config/webinar';
import { planOnSignup, ALL_TEMPLATES } from '../../lib/sequence';
import { normalizePhone } from '../../lib/phone';

function base64url(data: string | ArrayBuffer): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
                 .replace(/-----END PRIVATE KEY-----/, '')
                 .replace(/\n/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function getGoogleAccessToken(credsJson: string): Promise<string> {
  const creds = JSON.parse(credsJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:   creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }));

  const signingInput = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // A malformed or revoked service-account key used to surface as "undefined"
    // bearer token and a quiet 401 from Sheets.
    throw new Error(`Google token request failed: ${res.status} ${data.error_description || data.error || ''}`);
  }
  return data.access_token;
}


/**
 * Where a registrant came from.
 *
 * The UTM parameters are the first authority, but they go missing far more often
 * than you would expect: a visitor who clicks the ad, browses away and returns
 * through Facebook arrives with no query string at all. Judged on the referrer
 * alone that reads as organic reach, which was wrong for every single one of the
 * 21 rows labelled that way during this campaign — all of them carried an ad
 * click id, while the only genuinely unattributed visits carried none.
 *
 * `fbc` is a weaker signal than it looks. Meta appends fbclid to organic links as
 * well as ads — including links in ad comments and from a profile — so its
 * presence proves the click came from a Meta surface, not that it was bought. We
 * post Instagram stories, so an Instagram click with no tags could be either, and
 * calling it paid would take the credit from the stories.
 *
 * What the data does say: every fbc in this campaign was stamped within half an
 * hour of the registration, median about a minute. There are no stale cookies, so
 * an untagged Meta click is a visit that genuinely started on Meta just now. That
 * earns the honest label below rather than a guess in either direction. The way
 * to remove the ambiguity is to tag the story links, not to infer harder here.
 */
function buildTrafficSource(source: string, medium: string, referrer: string, fbc: string, ownHost: string, userAgent: string): string {
  const s = (source || '').toLowerCase().trim();
  const m = (medium || '').toLowerCase().trim();
  const clickedAnAd = Boolean((fbc || '').trim());

  if (s) {
    if ((s === 'ig' || s === 'instagram') && m === 'paid') return 'Instagram Paid Ad';
    if ((s === 'fb' || s === 'facebook')  && m === 'paid') return 'Facebook Paid Ad';
    // Meta fills utm_source from {{site_source_name}}: fb, ig, an, msg. The last
    // two had no rule and fell through to a raw "an / paid".
    if (s === 'an')                                        return 'Audience Network Paid Ad';
    if (s === 'msg' || s === 'messenger')                  return 'Messenger Paid Ad';
    // Tag the story link sticker with ?utm_source=ig&utm_medium=story and the
    // swipe-ups separate themselves from the ads for good, instead of both
    // arriving untagged and indistinguishable.
    if ((s === 'ig' || s === 'instagram') && m === 'story') return 'Instagram Story';
    if ((s === 'fb' || s === 'facebook')  && m === 'story') return 'Facebook Story';
    if ((s === 'ig' || s === 'instagram'))                 return 'Instagram Organic';
    if (s === 'linkedin' || s === 'lnkd.in')              return 'LinkedIn';
    if (s === 'google' && m === 'organic')                 return 'Google Search';
    return [s, m].filter(Boolean).join(' / ');
  }

  // Meta's click token carries the ad id when the click came from an ad, and
  // nothing when it did not. It survives even where the UTMs are lost, so it
  // settles what the referrer alone cannot: of the 14 visits once filed as
  // Facebook organic, 8 held an ad id and were ours all along, while every story
  // and direct visit held none. Checked against known-paid rows first: 79/79
  // Facebook, 17/17 Audience Network.
  //
  // The token is undocumented and Meta may change it, so this is only consulted
  // when no UTM survives, and it never overrides one.
  const fbclid = (fbc || '').split('.').slice(3).join('.');
  const fromAnAd = /YWRpZA|FkaWQ|hZGlk/.test(fbclid);

  let host = '';
  if (referrer) {
    try { host = new URL(referrer).hostname.replace('www.', ''); } catch { /* keep '' */ }
  }

  // Our own pages are not a source. Someone reading the Terms and coming back is
  // the same visit, and treating the domain as a referrer both invented a traffic
  // source and buried whichever ad actually brought them.
  if (host && ownHost && host === ownHost.replace('www.', '')) host = '';

  // Every ad link carries utm_source, and the tags now survive internal
  // navigation, so a Meta visit arriving without them did not come through an ad
  // link: a story swipe-up, the profile or bio link, a shared link, or a click
  // from an ad's comments. That is organic by the ordinary meaning of the word.
  if (host) {
    if (host.includes('instagram.com'))                           return fromAnAd ? 'Instagram Paid Ad' : 'Instagram Organic';
    if (host.includes('facebook.com'))                            return fromAnAd ? 'Facebook Paid Ad'  : 'Facebook Organic';
    if (host.includes('linkedin.com') || host.includes('lnkd.in')) return 'LinkedIn';
    if (host.includes('google.com'))                              return 'Google Search';
    if (host.includes('youtube.com'))                             return 'YouTube';
    return host;
  }

  // No tags and no referrer, which is what an in-app browser usually sends. The
  // app is still named in the user agent, so the platform need not be guessed:
  // every such visit in this campaign turned out to be the Facebook app.
  if (/Instagram/i.test(userAgent)) return fromAnAd ? 'Instagram Paid Ad' : 'Instagram Organic';
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return fromAnAd ? 'Facebook Paid Ad' : 'Facebook Organic';
  if (clickedAnAd) return fromAnAd ? 'Meta Paid Ad' : 'Meta Organic';

  return 'Direct Visit';
}

/**
 * Meta's Conversions API wants user data hashed with SHA-256, lowercase hex, and
 * normalised BEFORE hashing — otherwise 'A@b.com ' and 'a@b.com' hash differently
 * and match nobody. Normalisation mirrors what the browser sends to the pixel, so
 * the server-side copy of an event matches the same person as the browser fire.
 *
 * fbp, fbc, the IP and the user agent are deliberately NOT hashed: Meta matches
 * those verbatim and hashing them makes them useless.
 */
async function sha256Hex(value: string): Promise<string> {
  if (!value) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const normEmail = (v: string) => (v || '').trim().toLowerCase();
/** Digits only, country code included, no plus and no leading zero. */
const normPhone = (v: string) => (v || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
const normName  = (v: string) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ');

const SHEET_HEADERS = [
  // Who registered
  'First Name', 'Last Name', 'Email', 'Phone',
  // Where they came from
  'Traffic Source',
  // How much of the VSL they actually watched
  'VSL Watch (s)',
  // Everything Meta's Conversions API needs to send this as a server-side event.
  // Each event carries its own id so each de-duplicates on its own; Event Time is
  // the unix seconds the event happened; fbp/fbc/IP/UA are sent verbatim; the
  // four hashes are SHA-256 of the normalised values.
  'Registered Event ID', 'Lead Event ID', 'VSLView Event ID', 'Event Time', 'fbp', 'fbc', 'Client IP', 'User Agent', 'Event Source URL',
  'em (SHA-256)', 'ph (SHA-256)', 'fn (SHA-256)', 'ln (SHA-256)',
];

/** Returns the 1-based row the registration landed on, so its send columns can be stamped. */
async function appendToSheet(sheetId: string, row: string[], token: string): Promise<number> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const check = await fetch(`${base}/A1:S1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existingHeaders = checkData.values?.[0] ?? [];
  if (existingHeaders[0] !== 'First Name' || existingHeaders.length < SHEET_HEADERS.length) {
    await fetch(`${base}/A1:S1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  // Sheets errors used to be ignored here, so a 403 (sheet not shared with the
  // service account) or 404 (wrong id) still reported success and the row vanished.
  const appended = await fetch(`${base}/A:S:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
  if (!appended.ok) {
    throw new Error(`Sheets append failed: ${appended.status} ${await appended.text()}`);
  }

  // Sheets reports where it put the row, e.g. "Sheet1!A7:S7". Parsing it is the
  // only reliable way to know: counting rows separately would race another
  // registration landing between the two calls.
  const result = (await appended.json()) as { updates?: { updatedRange?: string } };
  const match = /![A-Z]+(\d+)/.exec(result.updates?.updatedRange ?? '');
  return match ? Number(match[1]) : 0;
}

/** Column letter for a 0-based index, A..Z then AA..AC. */
function columnLetter(index: number): string {
  return index < 26
    ? String.fromCharCode(65 + index)
    : 'A' + String.fromCharCode(65 + index - 26);
}

/**
 * Records which templates were scheduled, in that registrant's own row.
 *
 * A filled cell is what stops the daily job sending the same template again, so
 * this is the thing that makes the whole sequence idempotent.
 *
 * The status in AC is the other half: the daily job reads it, treats a blank as
 * 'active', and skips the row on anything else. So a registrant who is not meant
 * to be emailed has to be stamped with a status explicitly — leaving the cell
 * empty is what hands them to tomorrow's job.
 */
async function stampSends(
  sheetId: string,
  rowNumber: number,
  token: string,
  sends: { template: number; at: Date }[],
  status: 'active' | 'waitlist' = 'active',
): Promise<void> {
  if (!rowNumber) return;
  const firstSentColumn = 19; // T
  const data = sends
    .map((s) => {
      const i = ALL_TEMPLATES.indexOf(s.template as never);
      if (i === -1) return null;
      return {
        range: `${columnLetter(firstSentColumn + i)}${rowNumber}`,
        values: [[s.at.toISOString()]],
      };
    })
    .filter(Boolean);

  data.push({ range: `${columnLetter(28)}${rowNumber}`, values: [[status]] }); // AC

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    // utm_campaign/content/term and headline are still sent by the form but not
    // stored; Traffic Source is derived from utm_source/utm_medium/referrer.
    const { firstName, lastName, email, phone, utm_source, utm_medium, referrer,
            vslSeconds, eventId, leadEventId, vslEventId, fbp, fbc, sourceUrl } = body;

    // Last name is optional: the landing form marks it optional and hides it on mobile.
    if (!firstName || !email || !phone) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }

    // The real gate, in front of every write. The browser checks this too, but the
    // browser can be bypassed and the consequence lands downstream: Interakt reads
    // the Phone column to send the WhatsApp confirmation and refuses a malformed
    // number, so a bad one saved here is a lead who hears nothing. Nothing reaches
    // the sheet, Brevo or the pixel unless the number is one we can actually message.
    const checked = normalizePhone(phone);
    if (!checked.ok) {
      return json({ success: false, error: checked.error }, 400);
    }
    const phoneE164 = checked.e164;

    // Cloudflare dashboard variables and secrets only exist at RUNTIME, while
    // import.meta.env is inlined at BUILD time from .env — a file that is not in CI.
    // So in production both were undefined, the write below was skipped, and the
    // request still answered success:true: registrations that looked fine and never
    // reached the sheet. getEnv() prefers the runtime value and falls back to the
    // build-time one for local `astro dev`.
    const sheetId = (await getRuntimeEnv('GOOGLE_SHEET_WEBINAR')) || import.meta.env.GOOGLE_SHEET_WEBINAR;
    const credsJson = (await getRuntimeEnv('SHEETS_SERVICE_ACCOUNT')) || import.meta.env.SHEETS_SERVICE_ACCOUNT;

    // Never report success when the row was not written.
    if (!sheetId || !credsJson) {
      return json({
        success: false,
        error: `Sheet not configured: ${!sheetId ? 'GOOGLE_SHEET_WEBINAR' : ''}${!sheetId && !credsJson ? ' and ' : ''}${!credsJson ? 'SHEETS_SERVICE_ACCOUNT' : ''} missing from the environment.`,
      }, 500);
    }

    const token = await getGoogleAccessToken(credsJson);
    const now = new Date();
    let rowNumber = 0;
    {
      // Hashed from the values this request carries, normalised first. Done here
      // rather than in the browser so a tampered or stale client cannot write
      // hashes that match nobody.
      const [emHash, phHash, fnHash, lnHash] = await Promise.all([
        sha256Hex(normEmail(email)),
        sha256Hex(normPhone(phoneE164)),
        sha256Hex(normName(firstName)),
        sha256Hex(normName(lastName || '')),
      ]);

      // Cloudflare puts the visitor's real address in CF-Connecting-IP; the
      // socket address would be Cloudflare's own edge and match nothing.
      const clientIp = request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
        || '';
      const userAgent = request.headers.get('User-Agent') || '';
      const eventTime = Math.floor(Date.now() / 1000);

      rowNumber = await appendToSheet(sheetId, [
        firstName, lastName || '', email, phoneE164,
        buildTrafficSource(
          utm_source || '', utm_medium || '', referrer || '', fbc || '',
          (() => { try { return new URL(sourceUrl || request.url).hostname; } catch { return ''; } })(),
          userAgent,
        ),
        String(vslSeconds ?? 0),
        eventId || '', leadEventId || '', vslEventId || '', String(eventTime), fbp || '', fbc || '', clientIp, userAgent, sourceUrl || '',
        emHash, phHash, fnHash, lnHash,
      ], token);
    }

    // ── The seat limit ──
    // Past the limit the lead is still kept — the row above is already written, so
    // nothing is lost and the list keeps growing — but they get no Brevo contact
    // and no emails, because every contact past the cap spends WhatsApp CRM
    // credits on someone with no seat.
    //
    // The seat number comes free: Sheets reports the row it appended to, row 1 is
    // the header, so seat = row - 1. No second count, and no race with another
    // registration landing between the two calls.
    //
    // rowNumber 0 means that range could not be parsed, so the seat is unknown. We
    // let those through: a handful of extra contacts cost credits, while wrongly
    // withholding the sequence from someone inside the limit costs the seat they
    // were promised.
    const seat = rowNumber ? rowNumber - 1 : 0;
    const overCapacity = seat > TOTAL_SEATS;

    if (overCapacity) {
      // Stamped 'waitlist' rather than left blank. The daily job reads AC, takes a
      // blank cell as 'active', and would otherwise pick this row up tomorrow and
      // mail someone who has no contact behind them — which renders every
      // {{ contact.FIRSTNAME }} as an empty greeting.
      const stamped = await stampSends(sheetId, rowNumber, token, [], 'waitlist')
        .then(() => true)
        .catch(() => false);
      // Reported rather than swallowed: an unstamped row reads as 'active', which
      // is the one way a waitlisted lead could still be mailed tomorrow.
      return json({ success: true, waitlisted: true, seat, ...(stamped ? {} : { stampFailed: true }) }, 200);
    }

    // ── Brevo (after the sheet, never fatal) ──
    // droparabia-landing forwarded Brevo's status to the visitor, so when its API key
    // was revoked a 401 surfaced as "Could not subscribe" and lost leads whose sheet
    // row had already been written. The row is the source of truth here: a Brevo
    // failure is reported alongside success instead of replacing it.
    const brevo = await brevoAddContact({
      email,
      firstName,
      lastName: lastName || '',
      phoneE164,
      webinarDay: webinarDayIndex(),
    });

    // The sequence, owned by this codebase rather than by a Brevo automation.
    //
    // planOnSignup gives the confirmation plus whatever else this registrant is
    // owed today: the day's email at signup+1h, and on Thursday the reminders
    // that are still ahead of them. Anything in the future is handed to Brevo
    // with scheduledAt, which is exact — far better than us trying to wake up at
    // the right minute.
    //
    // It runs after the contact exists so the templates' {{ contact.FIRSTNAME }}
    // has something to render, and only when the contact actually landed:
    // emailing someone Brevo rejected would promise a seat no list knows about.
    const sendable = brevo.ok && !brevo.skipped;
    const plan = sendable ? planOnSignup(webinarDayIndex(now), now) : [];
    const scheduled: { template: number; at: Date }[] = [];
    const mailErrors: string[] = [];

    for (const item of plan) {
      // A few seconds of slack: "now" from the plan is already a moment ago, and
      // Brevo rejects a scheduledAt in the past.
      const future = item.at.getTime() > Date.now() + 5_000;
      const res = await brevoSendTemplate(email, item.template, future ? item.at : undefined);
      if (res.ok) scheduled.push({ template: item.template, at: item.at });
      else mailErrors.push(`${item.template}: ${res.error}`);
    }

    // Stamped last, and only for what Brevo accepted, so the daily job never
    // sees a template marked sent that never went out.
    if (scheduled.length) {
      await stampSends(sheetId, rowNumber, token, scheduled).catch(() => {
        mailErrors.push('sheet stamp failed');
      });
    }

    // brevoSkipped is reported explicitly: a missing API key used to return a plain
    // success:true, which is indistinguishable from Brevo having accepted the contact.
    return json(
      {
        success: true,
        ...(brevo.ok
          ? (brevo.skipped ? { brevoSkipped: brevo.skipped } : {})
          : { brevoError: brevo.error }),
        ...(mailErrors.length ? { mailErrors } : {}),
        ...(scheduled.length ? { scheduled: scheduled.map((s) => s.template) } : {}),
      },
      200,
    );
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
