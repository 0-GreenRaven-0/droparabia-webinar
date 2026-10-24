/**
 * Meta Pixel ID.
 *
 * Hardcoded on purpose. A pixel id is public by definition — it is written into
 * every page's HTML for the browser to read — so there is nothing to protect by
 * keeping it in an environment variable, and doing so cost us a silent outage:
 * PUBLIC_* variables are inlined at BUILD time, Cloudflare builds in CI where
 * .env does not exist, and the dashboard variable had never been added. Every
 * production build therefore compiled the pixel out entirely, with no error
 * anywhere — the pages simply shipped 30 KB lighter and tracked nothing.
 *
 * PUBLIC_META_PIXEL_ID still wins when it is set, so a different pixel can be
 * used for a preview deploy, and setting it to the string 'off' disables
 * tracking everywhere without touching code.
 */
const OVERRIDE = import.meta.env.PUBLIC_META_PIXEL_ID;

export const META_PIXEL_ID =
  OVERRIDE === 'off' ? '' : (OVERRIDE || '4560443994198158');
