export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken, appendToSheet } from '../../lib/google-sheets';

const HEADERS = ['First Name', 'Last Name', 'Phone Number', 'Email', 'Date'];

export const POST: APIRoute = async ({ request }) => {
  try {
    const { firstName, lastName, email, phone } = await request.json();

    if (!firstName || !email || !phone) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }

    const sheetId   = import.meta.env.GOOGLE_SHEET_WAITLIST_WEBINAR;
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!sheetId || !credsJson) {
      return json({ success: true }, 200);
    }

    const token = await getGoogleAccessToken(credsJson);
    const date  = new Date().toLocaleDateString('en-GB');
    await appendToSheet(sheetId, HEADERS, [firstName, lastName || '', phone, email, date], token);

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
