import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone validation for the registration flow.
 *
 * The number is not decoration: Interakt reads it to send the WhatsApp
 * confirmation and rejects anything malformed with "Invalid 'fullPhoneNumber'",
 * so a bad number saved to the sheet is a lead who never hears from us.
 *
 * Lebanon is handled by the explicit table below rather than by
 * libphonenumber, because libphonenumber is wrong here in both directions that
 * matter. Checked against its own metadata:
 *
 *   +9617013206   70-prefix with only 7 digits   libphonenumber: valid   actually not
 *   +9611234567   01 Beirut landline             libphonenumber: valid   no WhatsApp
 *   +9614123456   04 landline                    libphonenumber: valid   no WhatsApp
 *   +9619123456   09 landline                    libphonenumber: valid   no WhatsApp
 *
 * Its Lebanon rules allow a bare 7-digit national number regardless of prefix,
 * so it cannot tell a 3-prefix mobile (7 digits) from a 70-prefix mobile that
 * lost a digit. Every other country goes through libphonenumber, which is
 * reliable where we have no local knowledge to add.
 */

/** Lebanese mobile prefixes, mapped to the national number length they take. */
const LEBANON_MOBILE: Record<string, number> = {
  '3': 7,
  '70': 8, '71': 8, '76': 8, '78': 8, '79': 8, '81': 8,
};

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/** Everything a person might type between the digits. */
const strip = (raw: string) => (raw || '').replace(/[\s\-().]/g, '');

/**
 * Reduces any way of writing a Lebanese number to its national part.
 * Handles +961…, 00961…, 961…, a leading trunk zero, and the bare number.
 */
function lebaneseNational(input: string): string {
  let d = strip(input).replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('961')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function validateLebanese(input: string): PhoneResult {
  const national = lebaneseNational(input);
  if (!/^\d+$/.test(national)) {
    return { ok: false, error: 'Please enter your number using digits only.' };
  }

  // Longest prefix first, so 70/71/76/78/79/81 are tried before the bare 3.
  for (const prefix of ['70', '71', '76', '78', '79', '81', '3']) {
    if (national.startsWith(prefix) && national.length === LEBANON_MOBILE[prefix]) {
      return { ok: true, e164: `+961${national}` };
    }
  }

  // One message for every failure, because the prefix a wrong number appears to
  // carry is not trustworthy: 33979789 looks like a 3 number, and an 07 landline
  // looks like 71 once the trunk zero is off. Naming either would send the person
  // off to fix the wrong thing. Landlines also land here — they are real numbers,
  // but cannot receive the WhatsApp confirmation this form promises.
  return {
    ok: false,
    error:
      'Please enter a valid Lebanese mobile number — 03, 70, 71, 76, 78, 79 or 81 ' +
      `followed by 6 digits. You entered ${national.length} digits.`,
  };
}

/**
 * Validates a phone number and returns it in E.164.
 *
 * `countryCode` is the dial code chosen in the form, e.g. '+961'. A number that
 * already carries its own country code (+… or 00…) is trusted over that choice,
 * since someone pasting a full international number means it.
 */
export function normalizePhone(raw: string, countryCode = '+961'): PhoneResult {
  const input = strip(raw);
  if (!input) return { ok: false, error: 'Please enter your phone number.' };

  const explicit = input.startsWith('+') || input.startsWith('00');
  const asInternational = input.startsWith('00') ? `+${input.slice(2)}` : input;

  // A number carrying its own country code is judged by that code, not by the
  // dropdown. This order matters on the server, which receives an already-joined
  // E.164 string and no separate choice: defaulting to +961 and checking the
  // dropdown first would send every foreign number through the Lebanese rules
  // and reject it.
  const isLebanese = explicit ? asInternational.startsWith('+961') : countryCode === '+961';
  if (isLebanese) return validateLebanese(input);

  // Everywhere else: libphonenumber decides. Without a country code in the
  // number itself we would be guessing which country to measure it against.
  const candidate = explicit ? asInternational : `${countryCode}${input}`;
  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed || !parsed.isValid()) {
    return { ok: false, error: 'Please enter a valid phone number, including the country code.' };
  }
  return { ok: true, e164: parsed.number };
}
