import { cpSync, writeFileSync } from 'fs';

// Copy pre-rendered HTML/assets to dist root so Cloudflare Pages serves them directly.
// Output directory in Cloudflare Pages must be set to "dist".
cpSync('./dist/client', './dist', { recursive: true });

// Create _worker.js shim — activates Cloudflare Pages Advanced Mode.
// The Worker handles all routing via app.match() which ignores query params,
// so query strings like ?gtm_debug= are handled correctly without any patching.
writeFileSync('./dist/_worker.js', `export { default } from './server/entry.mjs';\n`);

console.log('[postbuild] dist/ ready for Cloudflare Pages (Advanced Mode)');
