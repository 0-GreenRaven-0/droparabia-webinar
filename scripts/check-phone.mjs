/**
 * Phone normalisation check for the registration form.
 *
 * This exists because the landing form silently refused every Lebanese 03
 * number for the first days of the campaign. An 03 number is seven digits once
 * the trunk zero comes off; the form demanded eight, so those people could not
 * register at all and left no trace anywhere — not the sheet, not Brevo, not the
 * pixel. There was nothing to notice afterwards, which is exactly why it ran for
 * days.
 *
 * The logic below is a copy of what the form does, kept in step by hand. That is
 * a deliberate trade: the form's copy has to stay inline and dependency-free in
 * an Astro `is:inline` script, and a check that runs is worth more than one that
 * is structurally perfect. If you change the form, change this and run it:
 *
 *   node scripts/check-phone.mjs
 */

// Mirrors DIGITS in src/pages/index.astro.
const DIGITS = {
  '+961': [7, 8], '+971': 9, '+966': 9, '+1': 10, '+44': 10, '+33': 9, '+49': 10,
  '+20': 10, '+90': 10, '+962': 9, '+963': 9, '+964': 10, '+965': 8, '+968': 8,
  '+970': 9, '+973': 8, '+974': 8, '+212': 9, '+213': 9, '+216': 8, '+218': 9,
  '+234': 10, '+254': 9, '+91': 10, '+92': 10, '+86': 11, '+7': 10, '+55': 11,
  '+39': 10, '+34': 9, '+31': 9, '+32': 9, '+46': 9, '+61': 9, '+1264': 10,
};

/** Mirrors the submit handler in src/pages/index.astro. */
function normalize(cc, input) {
  let digits = String(input).replace(/\D/g, '');
  const bare = cc.replace('+', '');
  if (digits.indexOf(bare) === 0 && digits.length > bare.length) digits = digits.slice(bare.length);
  if (digits.charAt(0) === '0') digits = digits.slice(1);

  const expected = DIGITS[cc];
  const lengths = expected == null ? null : (Array.isArray(expected) ? expected : [expected]);
  const valid = lengths
    ? lengths.indexOf(digits.length) !== -1
    : (digits.length >= 6 && digits.length <= 15);
  return valid ? cc + digits : null;
}

// Every Lebanese mobile prefix, written the four ways people write them: bare,
// with the trunk zero, pasted with +961, and pasted without the plus. All four
// must reach the same E.164 number, because that is what Brevo stores and what
// Interakt needs to send a WhatsApp message.
const LEBANESE_PREFIXES = [
  ['3',  '751043',  '+9613751043'],
  ['70', '123456',  '+96170123456'],
  ['71', '123456',  '+96171123456'],
  ['76', '123456',  '+96176123456'],
  ['78', '123456',  '+96178123456'],
  ['79', '123456',  '+96179123456'],
  ['81', '123456',  '+96181123456'],
];

const cases = [];
for (const [prefix, rest, want] of LEBANESE_PREFIXES) {
  const national = prefix + rest;
  cases.push([`+961 ${prefix} bare`,           '+961', national,                want]);
  cases.push([`+961 ${prefix} trunk zero`,     '+961', '0' + national,          want]);
  cases.push([`+961 ${prefix} pasted`,         '+961', '+961 ' + national,      want]);
  cases.push([`+961 ${prefix} pasted no plus`, '+961', '961' + national,        want]);
  cases.push([`+961 ${prefix} spaced`,         '+961', `0${prefix} ${rest.slice(0, 3)} ${rest.slice(3)}`, want]);
}

// Other countries must be untouched by the Lebanon-specific handling, and
// nonsense must still be refused.
cases.push(['UAE',            '+971', '50 123 4567',  '+971501234567']);
cases.push(['US',             '+1',   '415 555 0123', '+14155550123']);
cases.push(['too short',      '+961', '1234',         null]);
cases.push(['too long',       '+961', '701234567890', null]);
cases.push(['letters only',   '+961', 'hello',        null]);

let failed = 0;
for (const [name, cc, input, want] of cases) {
  const got = normalize(cc, input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(28)} ${JSON.stringify(input).padEnd(20)} -> ${got === null ? 'rejected' : got}` +
    (ok ? '' : `   WANTED ${want === null ? 'rejected' : want}`),
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
