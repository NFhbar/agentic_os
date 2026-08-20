// Trigger vocabulary translation for research-update dispatch.
//
// Two vocabularies meet at this boundary:
//
//   - The DASHBOARD raises update banners keyed by the archetype's trigger ids
//     (archetype-research-report § Update triggers): `new-materials-ingested`,
//     `staleness-threshold-passed`, `recommended-change-merged:<change-id>`,
//     `unconsidered-note:<n>`. The per-item ids carry a suffix so each one is
//     separately dismissable.
//   - The SKILL records a coarser category on the report body and the audit
//     event (research-update § Trigger sources): `materials`, `milestone`,
//     `change-merged`, `manual`.
//
// Callers may send either spelling; this is where the first becomes the
// second. The mapping is many-to-one and lossy on purpose — the banner id
// itself survives on the report's `dismissed_triggers`, so folding the
// time-based and note-based banners into `manual` loses no audit trail.
// `milestone` has no banner: it belongs to callers outside the dashboard.
//
// Shape mirrors parseRunOrigin in ./run-origin.ts — a wire value is a claim,
// not a guarantee, so it is validated once at the trust boundary and the
// rejection maps to HTTP 400.

export const TRIGGER_SOURCES = ['materials', 'milestone', 'change-merged', 'manual'] as const;

export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

// Keyed by UpdateTriggerKind (research.types.ts) — the part of a banner id
// before its per-item suffix.
export const TRIGGER_KIND_TO_SOURCE: Record<string, TriggerSource> = {
  'new-materials-ingested': 'materials',
  'staleness-threshold-passed': 'manual',
  'recommended-change-merged': 'change-merged',
  'unconsidered-note': 'manual',
};

export type ParseTriggerSourceResult =
  | { ok: true; triggerSource: TriggerSource }
  | { ok: false; error: string };

export function parseTriggerSource(value: unknown): ParseTriggerSourceResult {
  // Unset means "the user asked for a refresh", which is what `manual` says.
  if (value === undefined || value === null || value === '') {
    return { ok: true, triggerSource: 'manual' };
  }
  if (typeof value === 'string') {
    if ((TRIGGER_SOURCES as readonly string[]).includes(value)) {
      return { ok: true, triggerSource: value as TriggerSource };
    }
    const kind = value.split(':')[0];
    const mapped = TRIGGER_KIND_TO_SOURCE[kind];
    if (mapped) return { ok: true, triggerSource: mapped };
  }
  return {
    ok: false,
    error:
      `invalid trigger_source '${String(value)}' — expected one of: ${TRIGGER_SOURCES.join(', ')}` +
      `, or a dashboard trigger id (${Object.keys(TRIGGER_KIND_TO_SOURCE).join(', ')})`,
  };
}
