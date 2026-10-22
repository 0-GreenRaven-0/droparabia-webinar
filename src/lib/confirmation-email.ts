import { WHATSAPP_CHANNEL_URL } from '../config/webinar';

/**
 * Body of the registration confirmation.
 *
 * Deliberately plain text: no HTML part, no template, no tracking parameters.
 * An HTML multipart with a tracking pixel and rewritten links is a large part of
 * what sorts mail into Gmail's Promotions tab, so this is sent as a single
 * text/plain body — which is also what a genuine one-to-one email looks like.
 *
 * Keep it plain when editing. Adding htmlContent re-introduces exactly what this
 * is avoiding.
 */
export const CONFIRMATION_SUBJECT = 'Research us before Thursday';

export const CONFIRMATION_SENDER = {
  name: 'Majd Abdulsalam',
  email: 'hello@droparabia.com',
} as const;

export function confirmationText(firstName: string): string {
  // Falls back to a greeting without a name rather than printing "Hello ,".
  const greeting = firstName.trim() ? `Hello ${firstName.trim()},` : 'Hello,';

  return `${greeting}

Thank you for registering for "The No-Stock Blueprint."

Before Thursday, I'd like you to do something most people skip: research us.

Since you are giving me an hour of your evening, I want you to understand that DropArabia is a system over 800 people across Lebanon have used over the past few months to build online stores.

Guys like Mohamad generated ten thousand dollars in 3 months despite the situation in Lebanon. John Carl reached over eleven thousand dollars in 2 months. Karim made over eight thousand dollars in 3 months, and Mahdi made seven thousand dollars in a single month.

None of them bought inventory upfront. That is the core lesson of the blueprint: holding stock is not required to build a real business.

On Thursday, Oct 29 at 8:00 PM Beirut time, I'll walk through how they did it step by step.

Please join our official WhatsApp updates channel where we will post the live link:
${WHATSAPP_CHANNEL_URL}

Make sure notifications are on so you get the link immediately. Please plan to attend live, as we will not be sending out any recordings or replays afterward.

To confirm this landed in your main inbox, could you reply with a quick "got it"? That helps make sure my future updates don't get buried.

Best,
Majd Abdulsalam
Founder of DropArabia`;
}
