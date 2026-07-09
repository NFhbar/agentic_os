import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Both ports are per-install knobs so two OS installs can run dashboards on
// one machine without colliding (e.g. the OS-development install moves aside
// while a work install keeps the canonical defaults):
//   OS_WEB_PORT — the Vite dev-server port          (default 5173)
//   OS_API_PORT — the Fastify API the proxy targets (default 5174)
// Values resolve from the shell env first, then domains/meta/app/.env (the
// same gitignored file the API server loads its PORT from), then defaults.
// strictPort: a taken port fails loudly instead of silently auto-incrementing
// onto a port some other install's proxy may be pointing at (the 2026-06-12
// empty-dashboard incident class).
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, __dirname, '');
  const env = (k: string) => process.env[k] ?? fileEnv[k];
  return {
    plugins: [react()],
    server: {
      port: Number(env('OS_WEB_PORT')) || 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${env('OS_API_PORT') ?? 5174}`,
          changeOrigin: true,
        },
      },
    },
  };
});
