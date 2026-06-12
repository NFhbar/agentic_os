import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// OS_API_PORT lets the web dev server follow an API that had to start on a
// non-canonical port (e.g. another project's dev server squatting on 5174 —
// the 2026-06-12 empty-dashboard incident). Default stays the canonical 5174.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.OS_API_PORT ?? 5174}`,
        changeOrigin: true,
      },
    },
  },
});
