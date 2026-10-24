export const prerender = false;

import type { APIRoute } from 'astro';
import { getRuntimeEnv } from '../../lib/env';
import { brevoAddContact } from '../../lib/brevo';

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


function buildTrafficSource(source: string, medium: string, referrer: string): string {
  const s = (source || '').toLowerCase().trim();
  const m = (medium || '').toLowerCase().trim();

  if (s) {
    if ((s === 'ig' || s === 'instagram') && m === 'paid') return 'Instagram Paid Ad';
    if ((s === 'fb' || s === 'facebook')  && m === 'paid') return 'Facebook Paid Ad';
    if ((s === 'ig' || s === 'instagram'))                 return 'Instagram Organic';
    if (s === 'linkedin' || s === 'lnkd.in')              return 'LinkedIn';
    if (s === 'google' && m === 'organic')                 return 'Google Search';
    return [s, m].filter(Boolean).join(' / ');
  }

  if (referrer) {
    try {
      const host = new URL(referrer).hostname.replace('www.', '');
      if (host.includes('instagram.com'))                           return 'Instagram Organic';
      if (host.includes('linkedin.com') || host.includes('lnkd.in')) return 'LinkedIn';
      if (host.includes('facebook.com'))                            return 'Facebook Organic';
      if (host.includes('google.com'))                              return 'Google Search';
      if (host.includes('youtube.com'))                             return 'YouTube';
      return host;
    } catch { return referrer; }
  }

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
  // Event ID de-duplicates against the browser's Registered fire; Event Time is
  // the unix seconds the event happened; fbp/fbc/IP/UA are sent verbatim; the
  // four hashes are SHA-256 of the normalised values.
  'Event ID', 'Event Time', 'fbp', 'fbc', 'Client IP', 'User Agent', 'Event Source URL',
  'em (SHA-256)', 'ph (SHA-256)', 'fn (SHA-256)', 'ln (SHA-256)',
];

async function appendToSheet(sheetId: string, row: string[], token: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const check = await fetch(`${base}/A1:Q1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existingHeaders = checkData.values?.[0] ?? [];
  if (existingHeaders[0] !== 'First Name' || existingHeaders.length < SHEET_HEADERS.length) {
    await fetch(`${base}/A1:Q1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  // Sheets errors used to be ignored here, so a 403 (sheet not shared with the
  // service account) or 404 (wrong id) still reported success and the row vanished.
  const appended = await fetch(`${base}/A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
  if (!appended.ok) {
    throw new Error(`Sheets append failed: ${appended.status} ${await appended.text()}`);
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    // utm_campaign/content/term and headline are still sent by the form but not
    // stored; Traffic Source is derived from utm_source/utm_medium/referrer.
    const { firstName, lastName, email, phone, utm_source, utm_medium, referrer,
            vslSeconds, eventId, fbp, fbc, sourceUrl } = body;

    // Last name is optional: the landing form marks it optional and hides it on mobile.
    if (!firstName || !email || !phone) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }

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
    {
      // Hashed from the values this request carries, normalised first. Done here
      // rather than in the browser so a tampered or stale client cannot write
      // hashes that match nobody.
      const [emHash, phHash, fnHash, lnHash] = await Promise.all([
        sha256Hex(normEmail(email)),
        sha256Hex(normPhone(phone)),
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

      await appendToSheet(sheetId, [
        firstName, lastName || '', email, phone,
        buildTrafficSource(utm_source || '', utm_medium || '', referrer || ''),
        String(vslSeconds ?? 0),
        eventId || '', String(eventTime), fbp || '', fbc || '', clientIp, userAgent, sourceUrl || '',
        emHash, phHash, fnHash, lnHash,
      ], token);
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
      phoneE164: phone,
    });

    // No email is sent from here. The contact landing on Brevo list 24 is what a
    // Brevo automation keys off; the confirmation is owned entirely by Brevo.

    // brevoSkipped is reported explicitly: a missing API key used to return a plain
    // success:true, which is indistinguishable from Brevo having accepted the contact.
    return json(
      {
        success: true,
        ...(brevo.ok
          ? (brevo.skipped ? { brevoSkipped: brevo.skipped } : {})
          : { brevoError: brevo.error }),
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
