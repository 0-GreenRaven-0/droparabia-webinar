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

const SHEET_HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Date'];

async function appendToSheet(sheetId: string, row: string[], token: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const check = await fetch(`${base}/A1:E1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  if (!checkData.values || checkData.values[0]?.[0] !== 'First Name') {
    await fetch(`${base}/A1:E1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  await fetch(`${base}/A:E:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { firstName, lastName, email, phone } = body;

    if (!firstName || !email || !phone) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }

    const sheetId = import.meta.env.GOOGLE_SHEET_WEBINAR;
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (sheetId && credsJson) {
      const token = await getGoogleAccessToken(credsJson);
      const date = new Date().toLocaleDateString('en-GB');
      await appendToSheet(sheetId, [firstName, lastName || '', email, phone, date], token);
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
