export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken, getBookingCount } from '../../lib/google-sheets';

const MAX_SPOTS = 10;

export const GET: APIRoute = async () => {
  try {
    const sheetId   = import.meta.env.GOOGLE_SHEET_BOOKED_WEBINAR;
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!sheetId || !credsJson) {
      return json({ booked: 0, remaining: MAX_SPOTS }, 200);
    }

    const token  = await getGoogleAccessToken(credsJson, true);
    const booked = await getBookingCount(sheetId, token);
    const remaining = Math.max(0, MAX_SPOTS - booked);

    return json({ booked, remaining }, 200);
  } catch {
    return json({ booked: 0, remaining: MAX_SPOTS }, 200);
  }
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
