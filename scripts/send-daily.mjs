/**
 * The daily send for the webinar email sequence.
 *
 * Runs once a morning from GitHub Actions. It does NOT send at the exact minute
 * an email is due — it hands Brevo a `scheduledAt` and lets Brevo fire it. That
 * is deliberate: GitHub's cron is best-effort and can run fifteen minutes late,
 * which would be fatal for the 20:00 "we're live" email. Brevo's scheduler is
 * exact, and everything this job schedules is inside Brevo's 72-hour window.
 *
 * Who gets what:
 *
 *  - The day's email goes to people who registered on an EARLIER day. Anyone who
 *    registered today already had it scheduled at signup+1h by /api/register, so
 *    sending again here would double it.
 *  - The Thursday reminders (32, 33) are anchored and go to everyone, but a
 *    stamped cell means it was already scheduled at signup, so they are skipped.
 *
 * Nothing sends twice: every template has its own column, and a non-empty cell
 * means "already scheduled". The job can be re-run safely at any point.
 *
 * Usage:
 *   node scripts/send-daily.mjs            # schedule for real
 *   node scripts/send-daily.mjs --dry-run  # print the plan, touch nothing
 */

import crypto from 'node:crypto';
import { planForDay, beirutDate, ALL_TEMPLATES } from '../src/lib/sequence.ts';
import { webinarDayIndex } from '../src/config/webinar.ts';

const DRY_RUN = process.argv.includes('--dry-run');

// --as-of=YYYY-MM-DD pretends it is that Beirut date. Two uses: proving the
// whole week's behaviour before the week happens, and re-running a day that was
// missed because the scheduler never fired.
const asOfArg = process.argv.find((a) => a.startsWith('--as-of='));
const AS_OF = asOfArg
  ? new Date(`${asOfArg.slice('--as-of='.length)}T09:00:00+02:00`)
  : new Date();

// ── Column layout ────────────────────────────────────────────────────────────
// A..S is the registration itself; T..AC is this job's bookkeeping.
const COL = {
  EMAIL: 2,          // C
  EVENT_TIME: 9,     // J — unix seconds, when they registered
  SENT_FIRST: 19,    // T — first of the eight "<template> Sent" columns
  BATCH_ID: 27,      // AB
  STATUS: 28,        // AC
};
const SENT_COLUMN = Object.fromEntries(ALL_TEMPLATES.map((t, i) => [t, COL.SENT_FIRST + i]));

// Checked together, not one at a time. Exiting on the first missing secret hides
// the rest, so you fix one, wait for the next run, and find another — which is how
// day 1 of the campaign was spent.
const MISSING = ['BREVO_API_KEY', 'GOOGLE_SHEET_WEBINAR', 'SHEETS_MAILER_ACCOUNT'].filter(
  (name) => !process.env[name],
);
if (MISSING.length) {
  console.error(`Missing repository secret(s): ${MISSING.join(', ')}`);
  console.error('Add them under Settings -> Secrets and variables -> Actions -> Repository secrets.');
  process.exit(1);
}

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_WEBINAR;

// A service-account key pasted with its line breaks intact parses as nothing
// useful, and the failure otherwise surfaces as an unreadable JSON error.
let CREDS;
try {
  CREDS = JSON.parse(process.env.SHEETS_MAILER_ACCOUNT);
} catch {
  console.error('SHEETS_MAILER_ACCOUNT is not valid JSON.');
  console.error('Paste the whole service-account file, braces included, as one value.');
  process.exit(1);
}
if (!CREDS.client_email || !CREDS.private_key) {
  console.error('SHEETS_MAILER_ACCOUNT is missing client_email or private_key.');
  process.exit(1);
}

// ── Google auth ──────────────────────────────────────────────────────────────
async function sheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input =
    b64({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64({
      iss: CREDS.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), CREDS.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${input}.${sig}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token failed: ' + JSON.stringify(data));
  return data.access_token;
}

const colLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));

// ── Main ─────────────────────────────────────────────────────────────────────
const token = await sheetsToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const today = beirutDate(AS_OF);
const dayIndex = webinarDayIndex(AS_OF);
const plan = planForDay(dayIndex, today);

console.log(`Beirut date   : ${today}  (campaign day ${dayIndex})${asOfArg ? '  [simulated]' : ''}`);
console.log(`Due today     : ${plan.length ? plan.map((p) => `${p.template}@${p.at.toISOString()}`).join(', ') : 'nothing'}`);
if (DRY_RUN) console.log('MODE          : DRY RUN — nothing will be sent or written\n');

if (!plan.length) {
  console.log('No emails scheduled for today. Done.');
  process.exit(0);
}

const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:AC`, { headers: auth });
if (!res.ok) throw new Error('Sheet read failed: ' + res.status + ' ' + (await res.text()));
const rows = (await res.json()).values ?? [];
console.log(`Registrants   : ${Math.max(0, rows.length - 1)}\n`);

const updates = [];
let scheduled = 0;
let skipped = 0;
let duplicates = 0;
const failures = [];

// The same address can appear on more than one row — someone registering twice,
// or a re-submit. Brevo would happily send them the same email once per row, so
// each template goes out at most once per address per run. The extra rows are
// still stamped, otherwise tomorrow's run would treat them as unsent.
const alreadySent = new Map(); // template -> Set<email>

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const email = (row[COL.EMAIL] || '').trim();
  if (!email) continue;

  const status = (row[COL.STATUS] || 'active').trim().toLowerCase();
  if (status !== 'active') {
    skipped++;
    continue;
  }

  // Registered today? Their day's email was already scheduled at signup+1h.
  const eventTime = Number(row[COL.EVENT_TIME]);
  const registeredOn = Number.isFinite(eventTime) && eventTime > 0 ? beirutDate(new Date(eventTime * 1000)) : null;
  const registeredToday = registeredOn === today;

  for (const item of plan) {
    const col = SENT_COLUMN[item.template];
    if (row[col]) { skipped++; continue; }                    // already scheduled
    if (item.reason === 'daily-slot' && registeredToday) { skipped++; continue; }

    const seen = alreadySent.get(item.template) ?? new Set();
    alreadySent.set(item.template, seen);
    const key = email.toLowerCase();
    const isDuplicate = seen.has(key);
    seen.add(key);

    if (DRY_RUN) {
      console.log(
        `  ${isDuplicate ? 'stamp only (duplicate address)' : 'would schedule'} ` +
        `${item.template} -> ${email} at ${item.at.toISOString()}`,
      );
      if (isDuplicate) duplicates++; else scheduled++;
      continue;
    }

    // Stamped but not sent: the address already got this template this run.
    if (isDuplicate) {
      updates.push({ range: `${colLetter(col)}${r + 1}`, values: [[item.at.toISOString()]] });
      duplicates++;
      continue;
    }

    const send = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        to: [{ email }],
        templateId: item.template,
        scheduledAt: item.at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
    });

    if (send.status !== 201 && send.status !== 202) {
      failures.push(`${item.template} -> ${email}: ${send.status} ${(await send.text()).slice(0, 120)}`);
      continue;
    }
    const body = await send.json().catch(() => ({}));
    updates.push({
      range: `${colLetter(col)}${r + 1}`,
      values: [[item.at.toISOString()]],
    });
    if (body.batchId) updates.push({ range: `${colLetter(COL.BATCH_ID)}${r + 1}`, values: [[body.batchId]] });
    scheduled++;
  }
}

// One batched write rather than a request per cell: the per-minute Sheets quota
// is what breaks first on a large list.
if (updates.length) {
  const write = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
  });
  if (!write.ok) {
    // The emails are already scheduled at this point, so a failed stamp means a
    // re-run would double them. Loud, not silent.
    console.error('SHEET STAMP FAILED — emails ARE scheduled but not recorded.');
    console.error('Do NOT re-run until the cells are filled in by hand:', await write.text());
    process.exit(1);
  }
}

console.log(`\nscheduled: ${scheduled}   duplicates stamped: ${duplicates}   skipped: ${skipped}   failed: ${failures.length}`);
for (const f of failures) console.error('  FAILED ' + f);
process.exit(failures.length ? 1 : 0);
