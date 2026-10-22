import { getRuntimeEnv } from './env';
import { CONFIRMATION_SENDER, CONFIRMATION_SUBJECT, confirmationText } from './confirmation-email';

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

export type BrevoEmailResult =
  | { sent: true; messageId?: string }
  | { sent: false; skipped: 'no_api_key' | 'dry_run'; payload?: unknown }
  | { sent: false; status: number; error: string };

/**
 * Registration confirmation via Brevo's TRANSACTIONAL endpoint (/v3/smtp/email).
 *
 * Plain text only — no templateId, no htmlContent, no tracking parameters. A
 * template send carries Brevo's HTML wrapper, tracking pixel and rewritten links;
 * those are what make the message read as bulk and land in Gmail's Promotions tab.
 * The body is composed in confirmation-email.ts.
 */
export async function brevoSendConfirmation(contact: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<BrevoEmailResult> {
  const apiKey = (await getRuntimeEnv('BREVO_API_KEY')) || import.meta.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, skipped: 'no_api_key' };

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const payload = {
    sender: { name: CONFIRMATION_SENDER.name, email: CONFIRMATION_SENDER.email },
    to: [{ email: contact.email, ...(name ? { name } : {}) }],
    subject: CONFIRMATION_SUBJECT,
    textContent: confirmationText(contact.firstName || ''),
  };

  // Dry run: payload is built exactly as it would be sent, but nothing leaves.
  const dryRun = (await getRuntimeEnv('BREVO_EMAIL_DRY_RUN')) || import.meta.env.BREVO_EMAIL_DRY_RUN;
  if (String(dryRun).toLowerCase() === 'true') {
    return { sent: false, skipped: 'dry_run', payload };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  // Brevo answers 201 Created with the messageId on success.
  if (res.status !== 201) {
    return { sent: false, status: res.status, error: await res.text() };
  }

  const body = await res.json().catch(() => ({})) as { messageId?: string };
  return { sent: true, messageId: body.messageId };
}
