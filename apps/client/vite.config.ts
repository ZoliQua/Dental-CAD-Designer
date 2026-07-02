import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports and proxy target are fixed by PLAN.md's global constraints
// (Vite dev server 5173, Fastify API 4100) — do not make these configurable
// without updating docs/plans/phase-0-foundation.md.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
    },
  },
});
