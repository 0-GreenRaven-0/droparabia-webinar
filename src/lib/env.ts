/**
 * Reads a secret / environment variable that may only exist at runtime.
 *
 * Why this exists:
 *  - `import.meta.env.X` is inlined by Vite at BUILD time from `.env`. That file is
 *    gitignored, so in CI it is empty and the value is `undefined` in production.
 *  - `Astro.locals.runtime.env` was the runtime escape hatch, but Astro v6 removed
 *    it — reading that property now throws
 *    ("has been removed in Astro v6. Use 'import { env } from \"cloudflare:workers\"'").
 *  - `cloudflare:workers` is a virtual module that only resolves inside workerd, so
 *    it is imported lazily and guarded; outside the Worker (tests, plain node) the
 *    build-time value is used instead.
 */
export async function getRuntimeEnv(key: string): Promise<string | undefined> {
  try {
    const mod = await import(/* @vite-ignore */ 'cloudflare:workers');
    const value = (mod as { env?: Record<string, string> }).env?.[key];
    if (value) return value;
  } catch {
    // Not running under workerd — fall through to the build-time value.
  }
  return undefined;
}
