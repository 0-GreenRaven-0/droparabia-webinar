export const prerender = false;

import type { APIRoute } from 'astro';

// ── Brevo ────────────────────────────────────────────────────────────────────

function getListId(list: string): number | null {
  switch (list) {
    case 'vsl':               return Number(import.meta.env.BREVO_LIST_VSL_SUBSCRIBED)      || null;
    case 'survey':            return Number(import.meta.env.BREVO_LIST_DIDNT_FINISH_SURVEY)  || null;
    case 'qualified_no_book': return Number(import.meta.env.BREVO_LIST_QUALIFIED_NO_BOOK)    || null;
    case 'unqualified':       return Number(import.meta.env.BREVO_LIST_UNQUALIFIED)          || null;
    case 'booked':            return Number(import.meta.env.BREVO_LIST_BOOKED)               || null;
    default:                  return null;
  }
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

function getSheetId(list: string): string | null {
  switch (list) {
    case 'vsl':               return import.meta.env.GOOGLE_SHEET_VSL               || null;
    case 'survey':            return import.meta.env.GOOGLE_SHEET_SURVEY             || null;
    case 'qualified_no_book': return import.meta.env.GOOGLE_SHEET_QUALIFIED_NO_BOOK  || null;
    case 'unqualified':       return import.meta.env.GOOGLE_SHEET_UNQUALIFIED        || null;
    case 'booked':            return import.meta.env.GOOGLE_SHEET_BOOKED             || null;
    default:                  return null;
  }
}

function getUnlinkListIds(list: string): number[] {
  const all: Record<string, number> = {
    vsl:               Number(import.meta.env.BREVO_LIST_VSL_SUBSCRIBED)      || 0,
    survey:            Number(import.meta.env.BREVO_LIST_DIDNT_FINISH_SURVEY)  || 0,
    qualified_no_book: Number(import.meta.env.BREVO_LIST_QUALIFIED_NO_BOOK)    || 0,
    unqualified:       Number(import.meta.env.BREVO_LIST_UNQUALIFIED)          || 0,
    booked:            Number(import.meta.env.BREVO_LIST_BOOKED)               || 0,
  };
  return Object.entries(all)
    .filter(([key, id]) => key !== list && id !== 0)
    .map(([, id]) => id);
}


function formatPhoneDisplay(raw: string): string {
  let digits = raw.startsWith('+961') ? raw.slice(4) : raw.startsWith('961') ? raw.slice(3) : raw;
  digits = digits.replace(/\D/g, '');
  if (digits.length === 8) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  return digits;
}

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

const SHEET_HEADERS = ['Name', 'Email', 'Phone', 'Date', 'Traffic Source', 'Campaign Name', 'Ad Creative'];

function buildTrafficSource(source: string, medium: string): string {
  const s = (source || '').toLowerCase().trim();
  const m = (medium || '').toLowerCase().trim();
  if ((s === 'ig' || s === 'instagram') && m === 'paid') return 'Instagram Paid Ad';
  if ((s === 'fb' || s === 'facebook')  && m === 'paid') return 'Facebook Paid Ad';
  if ((s === 'ig' || s === 'instagram') && !m)           return 'Instagram Bio / Organic';
  if (s === 'linkedin' && m === 'referral')              return 'LinkedIn';
  if (s === 'google'   && m === 'organic')               return 'Google Search';
  if (!s && !m)                                          return 'Direct Visit';
  return [s, m].filter(Boolean).join(' / ');
}

async function removeEmailFromSheet(spreadsheetId: string, email: string, token: string): Promise<void> {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const res  = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/B:B`, { headers: auth });
  const data = await res.json() as { values?: string[][] };
  if (!data.values) return;

  const rowsToDelete: number[] = [];
  data.values.forEach((row, i) => {
    if (i === 0) return; // skip header
    if (row[0]?.toLowerCase() === email.toLowerCase()) rowsToDelete.push(i);
  });
  if (rowsToDelete.length === 0) return;

  // Delete bottom-up so indices stay valid
  const requests = rowsToDelete.reverse().map(rowIndex => ({
    deleteDimension: {
      range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
    },
  }));

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ requests }),
  });
}

async function removeEmailFromAllSheets(email: string, token: string): Promise<void> {
  const ids = [
    import.meta.env.GOOGLE_SHEET_VSL,
    import.meta.env.GOOGLE_SHEET_SURVEY,
    import.meta.env.GOOGLE_SHEET_QUALIFIED_NO_BOOK,
    import.meta.env.GOOGLE_SHEET_UNQUALIFIED,
    import.meta.env.GOOGLE_SHEET_BOOKED,
  ].filter(Boolean) as string[];
  await Promise.all(ids.map(id => removeEmailFromSheet(id, email, token)));
}

async function appendToSheet(sheetId: string, row: string[], token: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Check if headers already exist in A1
  const check = await fetch(`${base}/A1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  if (!checkData.values || checkData.values[0]?.[0] !== 'Name') {
    await fetch(`${base}/A1:G1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  await fetch(`${base}/A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { name, email, phone, list, utm_source, utm_medium, utm_campaign, utm_content } = body;

    if (!email || !list) {
      return json({ success: false, error: 'Missing email or list' }, 400);
    }

    const listId = getListId(list);
    if (!listId) {
      return json({ success: false, error: `Unknown or unconfigured list: ${list}` }, 400);
    }

    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    // ── Brevo ──
    const unlinkListIds = getUnlinkListIds(list);
    const brevoBody: Record<string, unknown> = {
      email,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME:  lastName,
        SMS: phone ? (phone.startsWith('+') ? phone : '+961' + phone) : '',
      },
      listIds: [listId],
      updateEnabled: true,
    };
    if (unlinkListIds.length > 0) brevoBody.unlinkListIds = unlinkListIds;

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': import.meta.env.BREVO_API_KEY },
      body: JSON.stringify(brevoBody),
    });

    if (res.status !== 201 && res.status !== 204) {
      const errBody = await res.text();
      return json({ success: false, error: errBody }, res.status);
    }

    // ── Google Sheets (fire after Brevo succeeds, silent fail) ──
    const sheetId   = getSheetId(list);
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (sheetId && credsJson) {
      const rawPhone     = phone ? (phone.startsWith('+') ? phone : '+961' + phone) : '';
      const displayPhone = rawPhone ? formatPhoneDisplay(rawPhone) : '';
      const date         = new Date().toLocaleDateString('en-GB');
      const trafficSource  = buildTrafficSource(utm_source || '', utm_medium || '');
      const campaignName   = utm_campaign || '';
      const adCreative     = (utm_medium || '').toLowerCase() === 'paid' ? (utm_content || '') : '';
      await (async () => {
        const token = await getGoogleAccessToken(credsJson);
        await removeEmailFromAllSheets(email, token);
        await appendToSheet(sheetId, [name || '', email, displayPhone, date, trafficSource, campaignName, adCreative], token);
      })().catch(() => {});
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
