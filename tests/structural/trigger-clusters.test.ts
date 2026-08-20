// Structural integrity test for the trigger-collision fixtures.
//
// tests/fixtures/trigger-clusters.json records the places where two or more
// skills compete for the same natural-language intent, plus the phrasings that
// should resolve each collision. It exists to gate rewrites of a skill's
// `description` — the field the harness routes on — so a description edit that
// steals a sibling's intents fails visibly instead of silently.
//
// This test does NOT run the router. Replaying the cases against a live model
// is a judgment call that belongs to whoever is editing a description. What it
// does is keep the fixture itself honest, because a fixture that references a
// deleted skill, names a winner outside its own cluster, or repeats a prompt is
// a gate that passes for the wrong reason.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SKILLS_DIR } from '../helpers/vault.js';

const FIXTURE_REL = 'tests/fixtures/trigger-clusters.json';
const FIXTURE_PATH = join(REPO_ROOT, FIXTURE_REL);

interface TriggerCase {
  prompt: string;
  expect: string;
}

interface TriggerCluster {
  id: string;
  skills: string[];
  cases: TriggerCase[];
}

interface TriggerFixture {
  purpose: string;
  clusters: TriggerCluster[];
}

// A collision cluster needs at least two competitors (one skill collides with
// nothing) and enough phrasings to be a real gate rather than a spot check.
const MIN_SKILLS_PER_CLUSTER = 2;
const MIN_CASES_PER_CLUSTER = 4;

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as TriggerFixture;

function skillExists(name: string): boolean {
  return existsSync(join(SKILLS_DIR, name, 'SKILL.md'));
}

describe('trigger-collision fixtures', () => {
  it('declares a purpose and at least one cluster', () => {
    expect(typeof fixture.purpose).toBe('string');
    expect(fixture.purpose.length).toBeGreaterThan(20);
    expect(Array.isArray(fixture.clusters)).toBe(true);
    expect(fixture.clusters.length).toBeGreaterThan(0);
  });

  it('cluster ids are unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of fixture.clusters) {
      if (seen.has(c.id)) dupes.push(c.id);
      seen.add(c.id);
    }
    if (dupes.length === 0) return;
    expect.fail(`Duplicate cluster id(s) in ${FIXTURE_REL}: ${dupes.join(', ')}`);
  });

  it('every listed skill exists on disk', () => {
    const missing: string[] = [];
    for (const cluster of fixture.clusters) {
      for (const skill of cluster.skills) {
        if (!skillExists(skill)) missing.push(`${cluster.id} → ${skill}`);
      }
    }
    if (missing.length === 0) return;
    expect.fail(
      `${missing.length} clustered skill(s) have no .claude/skills/<name>/SKILL.md:\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\n\nA fixture referencing a deleted or renamed skill is a gate that can never fail ` +
        `for the right reason. Update ${FIXTURE_REL} alongside the rename/deletion.`,
    );
  });

  it('every expected winner is a member of its own cluster', () => {
    const strays: string[] = [];
    for (const cluster of fixture.clusters) {
      const members = new Set(cluster.skills);
      for (const c of cluster.cases) {
        if (!members.has(c.expect)) {
          strays.push(`${cluster.id}: "${c.prompt}" expects ${c.expect}`);
        }
      }
    }
    if (strays.length === 0) return;
    expect.fail(
      `${strays.length} case(s) name a winner outside their cluster:\n` +
        strays.map((s) => `  ${s}`).join('\n') +
        `\n\nThe cluster's other members are the implicit must-NOT-trigger set — a winner ` +
        `outside it makes the case unfalsifiable. Either add the skill to the cluster or fix ` +
        `the expectation.`,
    );
  });

  it('no prompt appears twice', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const cluster of fixture.clusters) {
      for (const c of cluster.cases) {
        const key = c.prompt.trim().toLowerCase();
        const prior = seen.get(key);
        if (prior) {
          dupes.push(`"${c.prompt}" (in ${prior} and ${cluster.id})`);
          continue;
        }
        seen.set(key, cluster.id);
      }
    }
    if (dupes.length === 0) return;
    expect.fail(
      `${dupes.length} duplicate prompt(s) in ${FIXTURE_REL}:\n` +
        dupes.map((d) => `  ${d}`).join('\n') +
        `\n\nOne prompt cannot have two correct answers — a duplicate either double-counts a ` +
        `phrasing or encodes a contradiction.`,
    );
  });

  for (const cluster of fixture.clusters) {
    describe(`cluster: ${cluster.id}`, () => {
      it(`names at least ${MIN_SKILLS_PER_CLUSTER} competing skills`, () => {
        expect(
          cluster.skills.length,
          `cluster "${cluster.id}" lists ${cluster.skills.length} skill(s) — a collision needs competitors`,
        ).toBeGreaterThanOrEqual(MIN_SKILLS_PER_CLUSTER);
      });

      it(`carries at least ${MIN_CASES_PER_CLUSTER} phrasings`, () => {
        expect(
          cluster.cases.length,
          `cluster "${cluster.id}" carries ${cluster.cases.length} case(s) — too few to gate a description rewrite`,
        ).toBeGreaterThanOrEqual(MIN_CASES_PER_CLUSTER);
      });

      it('every member skill is the expected winner of at least one case', () => {
        const won = new Set(cluster.cases.map((c) => c.expect));
        const unexercised = cluster.skills.filter((s) => !won.has(s));
        if (unexercised.length === 0) return;
        expect.fail(
          `cluster "${cluster.id}" lists skill(s) that win no case: ${unexercised.join(', ')}\n\n` +
            `A member with no winning phrasing is only ever a must-NOT-trigger — the fixture ` +
            `never checks that it CAN be reached, so a description rewrite could make it ` +
            `unroutable without failing anything. Add a phrasing it should win.`,
        );
      });

      it('every case has a non-empty prompt', () => {
        for (const c of cluster.cases) {
          expect(typeof c.prompt).toBe('string');
          expect(c.prompt.trim().length).toBeGreaterThan(0);
        }
      });
    });
  }
});
