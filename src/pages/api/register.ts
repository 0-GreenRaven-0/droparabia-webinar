export const prerender = false;

import type { APIRoute } from 'astro';

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

  const data = await res.json() as { access_token: string };
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

const SHEET_HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Date', 'Traffic Source', 'Campaign Name', 'Creative', 'Hook'];

async function appendToSheet(sheetId: string, row: string[], token: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const check = await fetch(`${base}/A1:I1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existingHeaders = checkData.values?.[0] ?? [];
  if (existingHeaders[0] !== 'First Name' || existingHeaders.length < SHEET_HEADERS.length) {
    await fetch(`${base}/A1:I1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  await fetch(`${base}/A:I:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { firstName, lastName, email, phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer } = body;

    if (!firstName || !email || !phone) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }

    const sheetId = import.meta.env.GOOGLE_SHEET_WEBINAR;
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (sheetId && credsJson) {
      const token = await getGoogleAccessToken(credsJson);
      const date = new Date().toLocaleDateString('en-GB');
      const isPaid = (utm_medium || '').toLowerCase().trim() === 'paid';
      const trafficSource = buildTrafficSource(utm_source || '', utm_medium || '', referrer || '');
      const campaignName  = isPaid ? (utm_campaign || '') : '';
      const creative      = isPaid ? (utm_content  || '') : '';
      const hook          = isPaid ? (utm_term     || '') : '';
      await appendToSheet(sheetId, [firstName, lastName || '', email, phone, date, trafficSource, campaignName, creative, hook], token);
    }

    return json({ success: true }, 200);
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
