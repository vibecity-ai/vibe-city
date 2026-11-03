import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser only ever talks to the Vibe City backend (same origin via this proxy).
// The Hermes dashboard token and Hermes URLs never reach the browser.
const backend = process.env.VIBE_CITY_BACKEND ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false, ws: true },
    },
  },
});
