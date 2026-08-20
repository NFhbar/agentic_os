import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Port wiring for the web half of the dashboard.
//
// OS_API_PORT lets the web dev server follow an API that had to start on a
// non-canonical port (e.g. another project's dev server squatting on 5174 —
// the 2026-06-12 empty-dashboard incident). Default stays the canonical 5174.
// OS_WEB_PORT is the sibling for the vite port itself, so meta-dashboard's
// declared port inputs actually drive the spawn. Default stays 5173.
//
// Both are read from the shell first and from the app's own `.env` second.
// `npm run dev` starts web and api as two sibling processes, so the API's
// server/load-env.ts read of that file never reaches this config — loadEnv is
// how a per-install .env (the two-installs-side-by-side case documented in
// .env.example) actually moves the vite ports. Shell wins, matching the
// server-side precedence.
//
// strictPort: a taken web port must FAIL the spawn, never drift. Vite's default
// is to walk to the next free port, which silently invalidates every URL the
// launcher already printed, opened, and polled — the launch reports a dashboard
// at the requested port while the app answers somewhere else, and a later reuse
// probe reads whatever squats on the requested port as "already running".
// EADDRINUSE is the only outcome a launcher can act on (free the port, or pass
// another one), so make it the outcome.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), ['PORT', 'OS_']);
  const pick = (key: string) => process.env[key] ?? fileEnv[key];
  return {
    plugins: [react()],
    server: {
      port: Number(pick('OS_WEB_PORT')) || 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${Number(pick('OS_API_PORT')) || 5174}`,
          changeOrigin: true,
        },
      },
    },
  };
});
