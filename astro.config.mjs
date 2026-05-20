// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/docs
export default defineConfig({
  output: 'static',
  adapter: cloudflare(),
  devToolbar: { enabled: false },

  vite: {
    plugins: [tailwindcss()],
  },
});