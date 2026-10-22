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
  | { sent: false; skipped: 'no_api_key' | 'no_template_id' | 'dry_run'; payload?: unknown }
  | { sent: false; status: number; error: string };

/**
 * Registration confirmation via Brevo's TRANSACTIONAL endpoint (/v3/smtp/email).
 *
 * Two modes, chosen by BREVO_USE_TEMPLATE:
 *
 *   false (default) — plain text. Body composed in confirmation-email.ts and sent
 *     as a single text/plain part. No HTML wrapper, no open-tracking pixel, no
 *     rewritten links.
 *   true — renders Brevo template BREVO_CONFIRMATION_TEMPLATE_ID, which owns the
 *     subject, body and sender. Easier to edit, but template 13 measured 13.7KB of
 *     styled HTML and the delivered mail landed in Gmail's Promotions tab even on
 *     an address with prior conversation history.
 *
 * A template must personalise with {{ params.FIRSTNAME }} — {{ contact.* }} does
 * not resolve on the transactional stream and renders blank.
 */
export async function brevoSendConfirmation(contact: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<BrevoEmailResult> {
  const apiKey = (await getRuntimeEnv('BREVO_API_KEY')) || import.meta.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, skipped: 'no_api_key' };

  const useTemplateRaw =
    (await getRuntimeEnv('BREVO_USE_TEMPLATE')) || import.meta.env.BREVO_USE_TEMPLATE;
  const useTemplate = String(useTemplateRaw).toLowerCase() === 'true';

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const recipient = [{ email: contact.email, ...(name ? { name } : {}) }];

  let payload: Record<string, unknown>;
  if (useTemplate) {
    const templateId = Number(
      (await getRuntimeEnv('BREVO_CONFIRMATION_TEMPLATE_ID')) || import.meta.env.BREVO_CONFIRMATION_TEMPLATE_ID,
    );
    if (!templateId) return { sent: false, skipped: 'no_template_id' };
    payload = {
      to: recipient,
      templateId,
      params: { FIRSTNAME: contact.firstName || '' },
      // Asks Brevo not to rewrite links. Not honoured reliably on this endpoint —
      // switch click tracking off on the template itself if links still come
      // through pointing at a Brevo tracking domain.
      headers: { 'X-Mailin-Track': '0' },
    };
  } else {
    payload = {
      sender: { name: CONFIRMATION_SENDER.name, email: CONFIRMATION_SENDER.email },
      to: recipient,
      subject: CONFIRMATION_SUBJECT,
      textContent: confirmationText(contact.firstName || ''),
    };
  }

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
