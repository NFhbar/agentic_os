// Pins resolveEffortExecuteForRun (scripts/dispatch-claude.mjs) against the
// REAL skill tree — the sibling of the model_execute phase override. The
// shipped posture is `dev-write-change: effort_execute: xhigh` (Opus executes
// at the xhigh floor while Fable plans at max); a skill without the key
// resolves null so the existing effort: chain applies (fail-open).
//
// The invalid-value → null branch shares VALID_EFFORTS with the tested
// resolveEffortForRun chain (pinned in wall-cap / other dispatch tests) and is
// covered-by-construction here — readSkillField's path is fixed to REPO_ROOT
// and can't be fixtured without fs mocks.

import { describe, expect, it } from 'vitest';
import { resolveEffortExecuteForRun } from '../../../scripts/dispatch-claude.mjs';

describe('resolveEffortExecuteForRun', () => {
  it("dev-write-change ships effort_execute: xhigh (the shipped EXECUTE posture)", async () => {
    expect(await resolveEffortExecuteForRun('dev-write-change')).toBe('xhigh');
  });

  it('a skill without the key resolves null (dev-review-change is review-only)', async () => {
    expect(await resolveEffortExecuteForRun('dev-review-change')).toBeNull();
  });

  it('a null / empty skill name resolves null', async () => {
    expect(await resolveEffortExecuteForRun(null)).toBeNull();
    expect(await resolveEffortExecuteForRun('')).toBeNull();
  });
});
