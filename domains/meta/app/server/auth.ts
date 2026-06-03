import type { FastifyReply, FastifyRequest } from 'fastify';

// No-op auth for local-only mode. When exposing the dashboard over a tunnel
// (Tailscale, Cloudflare), replace with token verification reading from an
// env var like DASHBOARD_TOKEN.
export async function auth(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  return;
}
