// The research-update dispatch boundary speaks two trigger vocabularies: the
// archetype's per-item banner ids on the way in, the skill's four-value
// category enum on the way out. These tests pin the fold — including the
// per-item suffix that made the banner ids unmatchable against a plain
// membership check, and the two banners that legitimately collapse to
// `manual` because no narrower category exists for them.

import { describe, expect, it } from 'vitest';
import {
  TRIGGER_KIND_TO_SOURCE,
  TRIGGER_SOURCES,
  parseTriggerSource,
} from '../../domains/meta/app/server/lib/research-trigger-source.js';

describe('parseTriggerSource — skill enum values', () => {
  it('passes each documented source through unchanged', () => {
    for (const source of TRIGGER_SOURCES) {
      expect(parseTriggerSource(source)).toEqual({ ok: true, triggerSource: source });
    }
  });

  it('defaults to manual when unset', () => {
    expect(parseTriggerSource(undefined)).toEqual({ ok: true, triggerSource: 'manual' });
    expect(parseTriggerSource(null)).toEqual({ ok: true, triggerSource: 'manual' });
    expect(parseTriggerSource('')).toEqual({ ok: true, triggerSource: 'manual' });
  });
});

describe('parseTriggerSource — dashboard trigger ids', () => {
  it('folds each banner kind into a source', () => {
    expect(parseTriggerSource('new-materials-ingested')).toEqual({
      ok: true,
      triggerSource: 'materials',
    });
    expect(parseTriggerSource('recommended-change-merged')).toEqual({
      ok: true,
      triggerSource: 'change-merged',
    });
    expect(parseTriggerSource('staleness-threshold-passed')).toEqual({
      ok: true,
      triggerSource: 'manual',
    });
    expect(parseTriggerSource('unconsidered-note')).toEqual({
      ok: true,
      triggerSource: 'manual',
    });
  });

  it('folds the per-item id shapes, suffix and all', () => {
    expect(parseTriggerSource('recommended-change-merged:some-change')).toEqual({
      ok: true,
      triggerSource: 'change-merged',
    });
    expect(parseTriggerSource('unconsidered-note:3')).toEqual({
      ok: true,
      triggerSource: 'manual',
    });
  });

  it('maps every kind the mapping declares', () => {
    for (const [kind, expected] of Object.entries(TRIGGER_KIND_TO_SOURCE)) {
      expect(parseTriggerSource(kind)).toEqual({ ok: true, triggerSource: expected });
    }
  });
});

describe('parseTriggerSource — rejections', () => {
  it('rejects an unknown string with the bad value and both vocabularies', () => {
    const res = parseTriggerSource('not-a-trigger');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("'not-a-trigger'");
    expect(res.error).toContain('change-merged');
    expect(res.error).toContain('new-materials-ingested');
  });

  it('rejects a non-string wire value', () => {
    expect(parseTriggerSource(7).ok).toBe(false);
    expect(parseTriggerSource({ trigger: 'materials' }).ok).toBe(false);
  });
});
