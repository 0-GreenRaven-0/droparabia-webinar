export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken, getBookingCount } from '../../lib/google-sheets';

const MAX_SPOTS = 10;

export const POST: APIRoute = async () => {
  try {
    const sheetId   = import.meta.env.GOOGLE_SHEET_BOOKED_WEBINAR;
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!sheetId || !credsJson) {
      return json({ success: true }, 200);
    }

    const token  = await getGoogleAccessToken(credsJson);
    const booked = await getBookingCount(sheetId, token);

    if (booked >= MAX_SPOTS) {
      return json({ success: false, full: true }, 200);
    }

    // Ensure counter label exists, then increment
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (booked === 0) {
      await fetch(`${base}/A1:B1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ values: [['Bookings', 1]] }),
      });
    } else {
      await fetch(`${base}/B1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ values: [[booked + 1]] }),
      });
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
