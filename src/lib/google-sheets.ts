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

export async function getGoogleAccessToken(credsJson: string, readonly = false): Promise<string> {
  const creds = JSON.parse(credsJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:   creds.client_email,
    scope: readonly
      ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
      : 'https://www.googleapis.com/auth/spreadsheets',
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

export async function countSheetRows(sheetId: string, token: string): Promise<number> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:A`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };
  return Math.max(0, (data.values?.length ?? 1) - 1);
}

export async function appendToSheet(
  sheetId: string,
  headers: string[],
  row: string[],
  token: string
): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const range = `A1:${String.fromCharCode(64 + headers.length)}1`;

  const check = await fetch(`${base}/${range}`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existing = checkData.values?.[0] ?? [];
  if (existing[0] !== headers[0] || existing.length < headers.length) {
    await fetch(`${base}/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [headers] }),
    });
  }

  const dataRange = `A:${String.fromCharCode(64 + headers.length)}`;
  await fetch(`${base}/${dataRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });
}

// ── Booking sheet: row 1 = counter, row 2 = headers, row 3+ = data ──

export async function getBookingCount(sheetId: string, token: string): Promise<number> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/B1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };
  const val = data.values?.[0]?.[0];
  return val ? (parseInt(val, 10) || 0) : 0;
}

export async function appendBookingRow(
  sheetId: string,
  headers: string[],
  row: string[],
  token: string
): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Ensure row 1 counter label exists
  const a1Res = await fetch(`${base}/A1`, { headers: auth });
  const a1Data = await a1Res.json() as { values?: string[][] };
  if (!a1Data.values?.[0]?.[0]) {
    await fetch(`${base}/A1:B1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [['Bookings', 0]] }),
    });
  }

  // Ensure row 2 has column headers
  const colEnd = String.fromCharCode(64 + headers.length);
  const hdRes = await fetch(`${base}/A2:${colEnd}2`, { headers: auth });
  const hdData = await hdRes.json() as { values?: string[][] };
  if (!hdData.values?.[0]?.[0]) {
    await fetch(`${base}/A2:${colEnd}2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [headers] }),
    });
  }

  // Append data row (from row 3 onward)
  await fetch(`${base}/A3:${colEnd}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });

  // Increment counter in B1
  const current = await getBookingCount(sheetId, token);
  await fetch(`${base}/B1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ values: [[current + 1]] }),
  });
}
