// Shared utility helpers for OS apps.
// Lifted from the PR-review prototype's app.jsx + components.jsx.

/** Convert a hex color (#rgb or #rrggbb) to an rgba() string with the given alpha. */
export function hex2rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = Number.parseInt(x, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Concatenate class names; skips falsy values. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** Extract a PR number from a GitHub PR URL; returns "Pull request #N" or a fallback. */
export function parsePRTitle(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `Pull request #${m[1]}` : 'Pull request review';
}

/** Extract a repo name from a GitHub PR or repo URL. */
export function parseRepo(url: string): string {
  const m = url.match(/github\.com\/([\w-]+)\/([\w.-]+?)(?:\/pull\/|$)/);
  return m ? m[2] : 'unknown';
}
