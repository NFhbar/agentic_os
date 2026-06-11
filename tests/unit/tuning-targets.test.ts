import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { CHANGE_DEFAULTS, TARGET_KINDS, TUNING_TARGETS, missingTargetPaths, normalizeTargetName, resolveTuningTarget } from '../../scripts/tuning-targets.mjs';

const REPO_ROOT = join(__dirname, '..', '..');

describe('normalizeTargetName', () => {
  it('lowercases and collapses non-alphanumerics to single hyphens', () => {
    expect(normalizeTargetName('Meta — Automation Orchestrator')).toBe('meta-automation-orchestrator');
    expect(normalizeTargetName('  router!! ')).toBe('router');
  });

  it('returns empty string for null/empty input', () => {
    expect(normalizeTargetName(null)).toBe('');
    expect(normalizeTargetName('')).toBe('');
  });
});

describe('resolveTuningTarget', () => {
  it('resolves a canonical id exactly', () => {
    expect(resolveTuningTarget('automation-orchestrator')?.id).toBe('automation-orchestrator');
    expect(resolveTuningTarget('dispatch-helper')?.kind).toBe('script');
  });

  it('resolves aliases', () => {
    expect(resolveTuningTarget('router')?.id).toBe('router-vocabulary');
    expect(resolveTuningTarget('supervisor')?.id).toBe('runs-supervisor');
  });

  it('rescues historical free-prose targets via substring', () => {
    // The real Finding 3.2 example: an audit wrote this exact prose.
    expect(resolveTuningTarget('meta — automation orchestrator')?.id).toBe('automation-orchestrator');
    expect(resolveTuningTarget('the session usage importer script')?.id).toBe('session-importer');
  });

  it('returns null for unknown targets and empty input', () => {
    expect(resolveTuningTarget('completely-unknown-surface')).toBeNull();
    expect(resolveTuningTarget('')).toBeNull();
  });
});

describe('TUNING_TARGETS map integrity', () => {
  it('every entry uses a non-skill kind from the vocabulary', () => {
    for (const t of TUNING_TARGETS) {
      expect(TARGET_KINDS).toContain(t.kind);
      expect(t.kind).not.toBe('skill');
    }
  });

  it('ids are unique and kebab-case', () => {
    const ids = TUNING_TARGETS.map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('every mapped path exists on disk (freshness — the map must not rot)', () => {
    expect(missingTargetPaths()).toEqual([]);
    for (const t of TUNING_TARGETS) {
      for (const p of t.paths) {
        expect(existsSync(join(REPO_ROOT, p)), `${t.id} → ${p}`).toBe(true);
      }
    }
  });

  it('change defaults name the development domain + OS repo', () => {
    expect(CHANGE_DEFAULTS).toEqual({ domain: 'development', repo: 'agentic-os' });
  });
});
