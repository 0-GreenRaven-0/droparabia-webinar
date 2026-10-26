/**
 * Phone validation check.
 *
 * This exists because phone bugs here are silent in both directions. A number
 * refused by the form leaves no trace anywhere — no sheet row, no Brevo contact,
 * no pixel event — which is how the landing page rejected every Lebanese 03
 * number for days without anyone noticing. A bad number accepted is just as
 * quiet: it saves fine and then Interakt refuses it with "Invalid
 * 'fullPhoneNumber'" and the lead never gets their WhatsApp confirmation.
 *
 *   node scripts/check-phone.mjs
 */

import { normalizePhone } from '../src/lib/phone.ts';

const VALID = [
  // The forms people actually use, all meaning the same 71 number.
  ['+96171087463',   '+961', '+96171087463', 'full E.164'],
  ['071087463',      '+961', '+96171087463', 'trunk zero'],
  ['71087463',       '+961', '+96171087463', 'bare national'],
  ['0096171087463',  '+961', '+96171087463', '00 international prefix'],
  ['+961 71 087 463','+961', '+96171087463', 'spaced'],
  ['(03) 123-456',   '+961', '+9613123456',  'brackets and dash'],

  // Every Lebanese mobile prefix at its correct length.
  ['03123456',       '+961', '+9613123456',  '3 prefix, 7 digits'],
  ['70123456',       '+961', '+96170123456', '70 prefix'],
  ['71123456',       '+961', '+96171123456', '71 prefix'],
  ['76123456',       '+961', '+96176123456', '76 prefix'],
  ['78123456',       '+961', '+96178123456', '78 prefix'],
  ['79123456',       '+961', '+96179123456', '79 prefix'],
  ['81123456',       '+961', '+96181123456', '81 prefix'],

  // The server calls normalizePhone(phone) with no country code, so the default
  // is +961. A foreign number carrying its own code must still be judged by that
  // code — checking the dropdown first rejected every non-Lebanese registrant.
  ['+971501234567',  undefined, '+971501234567', 'UAE, no country code passed'],
  ['+14408647178',   undefined, '+14408647178',  'US, no country code passed'],
  ['+963993841608',  undefined, '+963993841608', 'Syria, no country code passed'],

  // Other countries stay libphonenumber's business.
  ['+971501234567',  '+971', '+971501234567', 'UAE mobile'],
  ['00971501234567', '+971', '+971501234567', 'UAE via 00'],
  ['+14155550123',   '+1',   '+14155550123',  'US mobile'],
];

const INVALID = [
  // The two that reached production.
  ['+96133979789', '+961', 'prefix 33 is not a Lebanese mobile'],
  ['+9617013206',  '+961', '70 prefix with only 7 digits'],

  // Lebanese landlines: real numbers, but no WhatsApp.
  ['01234567',     '+961', 'Beirut landline'],
  ['04123456',     '+961', '04 landline'],
  ['05123456',     '+961', '05 landline'],
  ['06123456',     '+961', '06 landline'],
  ['07123456',     '+961', '07 landline'],
  ['08123456',     '+961', '08 landline'],
  ['09123456',     '+961', '09 landline'],

  // Wrong lengths on real prefixes.
  ['031234567',    '+961', '3 prefix with 8 digits'],
  ['7012345',      '+961', '70 prefix one digit short'],
  ['701234567',    '+961', '70 prefix one digit long'],

  // Not numbers at all.
  ['',             '+961', 'empty'],
  ['hello',        '+961', 'letters'],
  ['1234',         '+961', 'far too short'],
  ['+971123',      '+971', 'invalid UAE number'],
];

let failed = 0;

for (const [input, cc, want, note] of VALID) {
  const got = cc === undefined ? normalizePhone(input) : normalizePhone(input, cc);
  const ok = got.ok && got.e164 === want;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(18)} ${String(cc).padEnd(6)} -> ` +
    `${got.ok ? got.e164 : 'REJECTED: ' + got.error}${ok ? '' : `   WANTED ${want}`}   ${note}`,
  );
}

for (const [input, cc, note] of INVALID) {
  const got = cc === undefined ? normalizePhone(input) : normalizePhone(input, cc);
  const ok = !got.ok;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(18)} ${String(cc).padEnd(6)} -> ` +
    `${got.ok ? 'ACCEPTED ' + got.e164 + '   WANTED rejection' : 'rejected'}   ${note}`,
  );
}

const total = VALID.length + INVALID.length;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
