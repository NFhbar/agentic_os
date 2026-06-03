// Notification template loader + Mustache-style renderer.
//
// Templates live as wiki entries under `vault/wiki/<domain>/template/` (with
// `vault/wiki/_seed/meta/template/` providing the shipped baseline). The
// dispatcher reads the resolved template at dispatch time, interpolates
// `{{var}}` placeholders against event + rule fields, and returns a
// RenderedNotification shape compatible with the channel adapters.
//
// Per standard-template-syntax: v1 supports variable substitution only — no
// loops, no conditionals. Missing variables substitute to the empty string
// (Mustache default). The template body is parsed by H2 sections:
//
//   ## title          → RenderedNotification.title
//   ## body           → RenderedNotification.body
//   ## link.<label>   → one entry in RenderedNotification.links[]
//                        (label is the H2 suffix; the section body is the URL)
//
// File-stat-driven cache invalidates on template mtime change so authoring
// edits land without a server restart.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type { RenderedNotification } from './channel-adapter.js';
import type { Rule } from './rules.js';
import type { EventRow } from './types.js';

// Resolution order per event:
//   1. vault/wiki/meta/template/notification-<event-type>.md    (active override, per-event)
//   2. vault/wiki/_seed/meta/template/notification-<event-type>.md (seed baseline, per-event)
//   3. vault/wiki/meta/template/notification-default.md          (active override, generic)
//   4. vault/wiki/_seed/meta/template/notification-default.md    (seed baseline, generic)
// First existing file wins. `.` in event_type is sanitized to `-` for filename
// safety (e.g. `dashboard.change-close-local` → `notification-dashboard-change-close-local.md`).

function templateBasenameForEvent(eventType: string): string {
  return `notification-${eventType.replace(/\./g, '-')}.md`;
}

function candidatePaths(eventType: string | null): string[] {
  const paths: string[] = [];
  const templateDirs = [
    join(REPO_ROOT, 'vault', 'wiki', 'meta', 'template'),
    join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'template'),
  ];
  if (eventType) {
    const eventBasename = templateBasenameForEvent(eventType);
    for (const dir of templateDirs) paths.push(join(dir, eventBasename));
  }
  for (const dir of templateDirs) paths.push(join(dir, 'notification-default.md'));
  return paths;
}

interface ParsedTemplate {
  title: string;
  body: string;
  links: Array<{ label: string; url: string }>;
}

interface CacheEntry {
  parsed: ParsedTemplate;
  mtimeMs: number;
  path: string;
}

// Cache keyed by event_type so per-event templates and the default coexist
// in memory without one evicting the other. Cap is generous since the
// catalog has ~35 entries today; resize the constant if it grows past ~100.
const _cache = new Map<string, CacheEntry>();
const CACHE_CAPACITY = 128;

async function resolveTemplatePath(
  eventType: string | null,
): Promise<{ path: string; mtimeMs: number } | null> {
  for (const candidate of candidatePaths(eventType)) {
    try {
      const s = await stat(candidate);
      return { path: candidate, mtimeMs: s.mtimeMs };
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseTemplate(raw: string): ParsedTemplate | null {
  const { body } = parseFrontmatter(raw);
  if (typeof body !== 'string') return null;
  // Strip the optional H1 doc title so it doesn't get mistaken for a section.
  const stripped = body.replace(/^#\s+[^\n]*\n+/, '');
  // Split on lines starting with `## `; parts[0] is preamble (ignored),
  // parts[1..] are sections shaped "<name>\n<body>".
  const parts = stripped.split(/^##\s+/m);
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const name = part.slice(0, nl).trim();
    const text = part.slice(nl + 1).trim();
    sections.set(name, text);
  }
  const title = sections.get('title') ?? '';
  const body_section = sections.get('body') ?? '';
  const links: Array<{ label: string; url: string }> = [];
  for (const [name, text] of sections) {
    if (!name.startsWith('link.')) continue;
    const label = name.slice('link.'.length).trim();
    const url = text.trim();
    if (label.length === 0 || url.length === 0) continue;
    links.push({ label, url });
  }
  return { title, body: body_section, links };
}

async function loadTemplate(eventType: string | null): Promise<ParsedTemplate | null> {
  const resolved = await resolveTemplatePath(eventType);
  if (!resolved) return null;
  const cacheKey = eventType ?? '__default__';
  const hit = _cache.get(cacheKey);
  if (hit && hit.path === resolved.path && hit.mtimeMs === resolved.mtimeMs) {
    return hit.parsed;
  }
  let raw: string;
  try {
    raw = await readFile(resolved.path, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseTemplate(raw);
  if (!parsed) return null;
  if (_cache.size >= CACHE_CAPACITY) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(cacheKey, { parsed, mtimeMs: resolved.mtimeMs, path: resolved.path });
  return parsed;
}

export function clearTemplateCache(): void {
  _cache.clear();
}

// Mustache-style {{var}} substitution. Missing keys → empty string.
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function eventVars(event: EventRow, rule: Rule): Record<string, string> {
  const base: Record<string, string> = {
    event_type: `${event.kind}.${event.action}`,
    kind: event.kind ?? '',
    action: event.action ?? '',
    description: event.description ?? '',
    status: event.status ?? '',
    project: event.project ?? '',
    change_id: event.change_id ?? '',
    report_id: event.report_id ?? '',
    domain: event.domain ?? '',
    skill: event.skill ?? '',
    ts: event.ts,
    rule_id: rule.id,
  };

  // Flatten the event's `args` payload (set by skills via
  // `record-dashboard-action.mjs --args '...'`) into top-level template vars.
  // Skills stuff per-event metadata in args (e.g. the status-report skill
  // writes title/tldr/progress_summary/blockers/next there); the renderer's
  // simple `{{var}}` regex (no dotted paths) means we have to lift them up
  // to top-level keys. Reserved keys above win — args can't shadow `project`,
  // `kind`, etc.
  const raw = event.raw as { args?: unknown } | null | undefined;
  const args = raw && typeof raw === 'object' && raw.args && typeof raw.args === 'object'
    ? (raw.args as Record<string, unknown>)
    : null;
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (k in base) continue; // reserved key — skip
      if (typeof v === 'string') base[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') base[k] = String(v);
      // Skip objects/arrays — they'd serialize to `[object Object]`. If a
      // skill needs to surface a list, pre-join into a string in args.
    }
  }

  // Flatten the rule's delivery.tags into a single space-joined string so a
  // template can use `{{delivery_tags}}`. Empty when no tags configured.
  // biome-ignore lint/suspicious/noExplicitAny: rule.delivery is loose-typed
  const delivery = (rule as any).delivery;
  if (delivery && Array.isArray(delivery.tags)) {
    base.delivery_tags = (delivery.tags as unknown[])
      .filter((t): t is string => typeof t === 'string')
      .join(' ');
  } else {
    base.delivery_tags = '';
  }

  return base;
}

// Render via the on-disk template. Returns null only when no template can be
// resolved at all — callers fall through to the inline `fallbackPayload`
// shape (event_type as title, description as body, no links). Template-found
// always wins; even if a section produces an empty string, that's a
// deliberate template choice the user can fix by editing the template.
export async function renderViaTemplate(
  event: EventRow,
  rule: Rule,
): Promise<RenderedNotification | null> {
  const eventType = `${event.kind}.${event.action}`;
  const template = await loadTemplate(eventType);
  if (!template) return null;
  const vars = eventVars(event, rule);
  return {
    title: interpolate(template.title, vars),
    body: interpolate(template.body, vars),
    links: template.links.map((l) => ({
      label: l.label,
      url: interpolate(l.url, vars),
    })),
  };
}
