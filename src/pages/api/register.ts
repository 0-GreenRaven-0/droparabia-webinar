export const prerender = false;

import type { APIRoute } from 'astro';
import { getRuntimeEnv } from '../../lib/env';
import { brevoAddContact, brevoSendConfirmation } from '../../lib/brevo';

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

// Column L records when the confirmation email went out, so it is visible who
// received one and a re-run cannot silently double-send.
const SHEET_HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Date', 'Traffic Source', 'Campaign Name', 'Creative', 'Hook', 'Headline', 'Investment Intent', 'Confirmation Sent At'];
const CONFIRMATION_COLUMN = 'L';

/** Appends the row and returns the row number Sheets put it on, for the stamp below. */
async function appendToSheet(sheetId: string, row: string[], token: string): Promise<number | null> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const check = await fetch(`${base}/A1:L1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existingHeaders = checkData.values?.[0] ?? [];
  if (existingHeaders[0] !== 'First Name' || existingHeaders.length < SHEET_HEADERS.length) {
    await fetch(`${base}/A1:L1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  // Sheets errors used to be ignored here, so a 403 (sheet not shared with the
  // service account) or 404 (wrong id) still reported success and the row vanished.
  const appended = await fetch(`${base}/A:L:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
  if (!appended.ok) {
    throw new Error(`Sheets append failed: ${appended.status} ${await appended.text()}`);
  }

  // e.g. "Sheet1!A7:L7" -> 7
  const result = await appended.json() as { updates?: { updatedRange?: string } };
  const match = /![A-Z]+(\d+)/.exec(result.updates?.updatedRange ?? '');
  return match ? Number(match[1]) : null;
}

/** Writes the send timestamp into the row's confirmation column. Never fatal. */
async function stampConfirmationSent(sheetId: string, rowNumber: number, token: string): Promise<void> {
  const cell = `${CONFIRMATION_COLUMN}${rowNumber}`;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${cell}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[new Date().toISOString()]] }),
    },
  ).catch(() => { /* the stamp is bookkeeping; losing it must not affect the lead */ });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { firstName, lastName, email, phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, headline, intent } = body;

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
    const credsJson = (await getRuntimeEnv('GOOGLE_SERVICE_ACCOUNT_JSON')) || import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    // Never report success when the row was not written.
    if (!sheetId || !credsJson) {
      return json({
        success: false,
        error: `Sheet not configured: ${!sheetId ? 'GOOGLE_SHEET_WEBINAR' : ''}${!sheetId && !credsJson ? ' and ' : ''}${!credsJson ? 'GOOGLE_SERVICE_ACCOUNT_JSON' : ''} missing from the environment.`,
      }, 500);
    }

    const token = await getGoogleAccessToken(credsJson);
    let rowNumber: number | null = null;
    {
      const date = new Date().toLocaleDateString('en-GB');
      const isPaid = (utm_medium || '').toLowerCase().trim() === 'paid';
      const trafficSource = buildTrafficSource(utm_source || '', utm_medium || '', referrer || '');
      const campaignName  = isPaid ? (utm_campaign || '') : '';
      const creative      = isPaid ? (utm_content  || '') : '';
      const hook          = isPaid ? (utm_term     || '') : '';
      rowNumber = await appendToSheet(sheetId, [firstName, lastName || '', email, phone, date, trafficSource, campaignName, creative, hook, headline || '', intent || ''], token);
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

    // ── Confirmation email (transactional, also never fatal) ──
    // Being registered matters more than being emailed, so a send failure is reported
    // in the payload and logged, never turned into an error for the visitor.
    // It is awaited rather than fired-and-forgotten: a Worker stops executing once the
    // response is returned, so an un-awaited fetch would be cancelled mid-flight. The
    // call is a single round-trip, and nothing below it blocks the sheet row.
    let emailStatus: Record<string, unknown> = {};
    try {
      const mail = await brevoSendConfirmation({ email, firstName, lastName: lastName || '' });
      if (mail.sent) {
        // Stamp only after a 2xx, so the column means "this person was emailed"
        // and a replay can tell what still needs sending.
        if (rowNumber) await stampConfirmationSent(sheetId, rowNumber, token);
        emailStatus = { confirmationEmail: 'sent' };
      } else if ('skipped' in mail) {
        emailStatus = { confirmationEmail: `skipped:${mail.skipped}` };
      } else {
        console.error('[register] confirmation email failed', mail.status, mail.error);
        emailStatus = { confirmationEmailError: mail.error };
      }
    } catch (mailErr) {
      console.error('[register] confirmation email threw', mailErr);
      emailStatus = { confirmationEmailError: String(mailErr) };
    }

    // brevoSkipped is reported explicitly: a missing API key used to return a plain
    // success:true, which is indistinguishable from Brevo having accepted the contact.
    return json(
      {
        success: true,
        ...(brevo.ok
          ? (brevo.skipped ? { brevoSkipped: brevo.skipped } : {})
          : { brevoError: brevo.error }),
        ...emailStatus,
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
