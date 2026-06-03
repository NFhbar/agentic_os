// Structural integrity test for the event subsystem.
//
// Three sets must stay aligned:
//   1. event_types listed in vault/wiki/_seed/meta/reference/event-catalog.md
//   2. notification template filenames in vault/wiki/_seed/meta/template/
//   3. notification rules in vault/wiki/<domain>/notification-config/
//
// When a template references a non-cataloged event, the dispatcher's
// per-event override resolution falls through to default-template silently;
// when a rule references a non-cataloged event, the rule never fires for
// new code paths because the catalog drives event-type validation. Both
// drifts are silent in production — these tests turn them into pre-commit
// failures.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import {
  REPO_ROOT,
  parseFrontmatter,
  relPath,
  walkWikiMarkdown,
} from '../helpers/vault.js';

const CATALOG_PATH = join(
  REPO_ROOT,
  'vault',
  'wiki',
  '_seed',
  'meta',
  'reference',
  'event-catalog.md',
);
const TEMPLATE_DIR = join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'template');

// Parse the event-catalog markdown tables. Each catalog table has rows of
// the shape: `| event_type | description | entity | ... |`. The event_type
// column is what we care about.
function readCatalogEventTypes(): Set<string> {
  if (!existsSync(CATALOG_PATH)) return new Set();
  const lines = readFileSync(CATALOG_PATH, 'utf8').split('\n');
  const out = new Set<string>();
  for (const line of lines) {
    // Match rows where the first non-pipe cell looks like `dashboard.<something>`.
    const m = line.match(/^\|\s*(dashboard\.[a-z0-9._-]+)\s*\|/);
    if (m) out.add(m[1].trim());
  }
  return out;
}

// Templates are filename-resolved: notification-<event_type-with-dots-as-dashes>.md.
function templateFilenameToEventType(filename: string): string | null {
  if (!filename.startsWith('notification-')) return null;
  if (!filename.endsWith('.md')) return null;
  const stem = filename.slice('notification-'.length, -'.md'.length);
  if (stem === 'default') return null; // the generic fallback template
  // dashboard-event-name → dashboard.event-name
  // First "-" goes to "." (separates kind from action).
  const firstDash = stem.indexOf('-');
  if (firstDash < 0) return null;
  return `${stem.slice(0, firstDash)}.${stem.slice(firstDash + 1)}`;
}

const cataloged = readCatalogEventTypes();

describe('event catalog', () => {
  it('has at least one event_type', () => {
    expect(cataloged.size).toBeGreaterThan(0);
  });
});

describe('notification templates ↔ event catalog', () => {
  const templates = existsSync(TEMPLATE_DIR)
    ? readdirSync(TEMPLATE_DIR).filter((n) => n.startsWith('notification-') && n.endsWith('.md'))
    : [];

  it('every per-event template names an event in the catalog', () => {
    const orphans: string[] = [];
    for (const filename of templates) {
      const et = templateFilenameToEventType(filename);
      if (!et) continue; // default template, skipped above
      if (!cataloged.has(et)) {
        orphans.push(`${filename} → ${et}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} template(s) reference an event_type not in the catalog:\n` +
        orphans.map((o) => `  ${o}`).join('\n') +
        '\n\nAdd the event to event-catalog.md OR remove/rename the template.',
    );
  });
});

describe('notification rules ↔ event catalog', () => {
  const ruleFiles = walkWikiMarkdown().filter((p) =>
    dirname(p).endsWith('/notification-config'),
  );

  it('every rule references an event_type in the catalog', () => {
    const orphans: string[] = [];
    for (const file of ruleFiles) {
      const { fm } = parseFrontmatter(file);
      const et = fm?.event_type;
      if (typeof et !== 'string' || et.length === 0) continue;
      if (!cataloged.has(et)) {
        orphans.push(`${basename(file)} → ${et}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} notification rule(s) reference an event_type not in the catalog:\n` +
        orphans.map((o) => `  ${o}`).join('\n') +
        '\n\nAdd the event to event-catalog.md OR fix the rule.',
    );
  });
});
