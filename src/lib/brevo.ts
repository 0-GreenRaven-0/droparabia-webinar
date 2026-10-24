import { getRuntimeEnv } from './env';

/**
 * Brevo contact creation, ported from droparabia-landing's subscribe.ts.
 *
 * Webinar registrants all go to one list, so the multi-list routing and the
 * unlink bookkeeping from that project are left out — only the contact upsert
 * and the duplicate-SMS recovery are kept, since both affect whether a lead
 * lands at all.
 */
export const BREVO_WEBINAR_LIST_ID = 24;

export interface BrevoContact {
  email: string;
  firstName?: string;
  lastName?: string;
  /** E.164, e.g. +96170123456. Brevo rejects anything else. */
  phoneE164?: string;
  /** 0-5 step the Brevo automation keys off; see webinarDayIndex(). */
  webinarDay?: number;
}

export type BrevoResult =
  | { ok: true; skipped?: 'no_api_key' }
  | { ok: false; status: number; error: string };

export async function brevoAddContact(contact: BrevoContact): Promise<BrevoResult> {
  const apiKey = (await getRuntimeEnv('BREVO_API_KEY')) || import.meta.env.BREVO_API_KEY;
  if (!apiKey) return { ok: true, skipped: 'no_api_key' };

  const listIdRaw = (await getRuntimeEnv('BREVO_LIST_WEBINAR')) || import.meta.env.BREVO_LIST_WEBINAR;
  const listId = Number(listIdRaw) || BREVO_WEBINAR_LIST_ID;

  const body: Record<string, unknown> = {
    email: contact.email,
    attributes: {
      FIRSTNAME: contact.firstName || '',
      LASTNAME: contact.lastName || '',
      ...(contact.phoneE164 ? { SMS: contact.phoneE164 } : {}),
      // Sent even when 0: omitting it would leave day-0 registrants with no
      // value at all, which an automation reads as 'not set' rather than 'day 0'.
      ...(contact.webinarDay != null ? { WEBINAR_DAY: contact.webinarDay } : {}),
    },
    listIds: [listId],
    // Existing contacts are updated rather than rejected as duplicates.
    updateEnabled: true,
  };

  const post = (payload: Record<string, unknown>) =>
    fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
    });

  let res = await post(body);

  // updateEnabled resolves a duplicate EMAIL but not a duplicate SMS: if the number
  // already belongs to another contact, Brevo hard-rejects with 400 duplicate_parameter
  // and the signup is lost. Retry without the phone so the lead still reaches the list;
  // the number simply stays on whichever contact already owns it.
  if (res.status === 400) {
    const text = await res.clone().text();
    let duplicateSms = false;
    try {
      const parsed = JSON.parse(text) as { code?: string; metadata?: { duplicate_identifiers?: string[] } };
      duplicateSms =
        parsed.code === 'duplicate_parameter' &&
        Array.isArray(parsed.metadata?.duplicate_identifiers) &&
        parsed.metadata.duplicate_identifiers.includes('SMS');
    } catch {
      /* non-JSON error body — reported as-is below */
    }
    if (duplicateSms) {
      const attributes = { ...(body.attributes as Record<string, unknown>) };
      delete attributes.SMS;
      res = await post({ ...body, attributes });
    }
  }

  if (res.status !== 201 && res.status !== 204) {
    return { ok: false, status: res.status, error: await res.text() };
  }
  return { ok: true };
}

/** "Webinar - Email 1" — the day-0 confirmation, sent the moment someone registers. */
export const BREVO_TEMPLATE_CONFIRMATION = 23;

export type BrevoSendResult =
  | { ok: true; messageId?: string; skipped?: 'no_api_key' }
  | { ok: false; status: number; error: string };

/**
 * Sends a Brevo template to one address.
 *
 * The template renders {{ contact.FIRSTNAME }}, which Brevo resolves from the
 * stored contact rather than from this request — so the contact has to exist
 * before this runs, or the greeting comes out blank. brevoAddContact() is
 * called first for exactly that reason.
 *
 * Never fatal: the sheet row is the registration. An email that fails to send
 * is reported alongside success, not in place of it.
 */
export async function brevoSendTemplate(
  email: string,
  templateId: number = BREVO_TEMPLATE_CONFIRMATION,
): Promise<BrevoSendResult> {
  const apiKey = (await getRuntimeEnv('BREVO_API_KEY')) || import.meta.env.BREVO_API_KEY;
  if (!apiKey) return { ok: true, skipped: 'no_api_key' };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    // No sender override: the template carries its own verified sender, and
    // passing a different one is how mail ends up unauthenticated.
    body: JSON.stringify({ to: [{ email }], templateId }),
  });

  if (res.status !== 201 && res.status !== 202) {
    return { ok: false, status: res.status, error: await res.text() };
  }
  const data = (await res.json().catch(() => ({}))) as { messageId?: string };
  return { ok: true, messageId: data.messageId };
}
