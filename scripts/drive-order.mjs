#!/usr/bin/env node
// Drive order — "which of a project's changes is next, and is anything in the
// way?", answered from `parent_change` chains rather than from memory.
//
// `dev-drive-project` sequences a project's scaffolded changes through the
// lifecycle. The ordering rule is a dependency rule, not a list rule: a change
// whose `parent_change` names another change must not be driven until that
// parent reaches a terminal status. `research-scaffold-recommendations` writes
// exactly this chain when it materializes a report's recommendations, so the
// chain is the recorded intent of the owning artifact — the input order is only
// the tiebreak between changes that carry no dependency on each other.
//
// Splitting the decision out of the skill's prose buys two things. The
// ordering is deterministic across runs (a model re-deriving a topological
// sort from prose is not), and it is testable — see
// tests/unit/lifecycle/drive-order.test.ts.
//
// Usage:
//   node scripts/drive-order.mjs --project <project-id>
//   node scripts/drive-order.mjs --project <project-id> --json
//
// Exit 0 when the plan resolved (including "everything is terminal"); exit 1
// when the plan is unsound (cycle, duplicate ids, an unresolvable parent) or
// the project has no changes. The driver treats a non-zero exit as a stop, not
// as something to work around.
//
// The decision core (planDriveOrder) is pure — it takes already-shaped records
// so it can be unit-tested without a vault. The CLI half below does the wiki
// walk that shapes them.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Decision core (pure).
// ---------------------------------------------------------------------------

// A change is done being driven when it reaches one of these. Everything else
// — including a status string this OS version does not recognize — counts as
// live work, because treating an unknown status as "finished" would silently
// skip a change.
export const TERMINAL_CHANGE_STATUSES = Object.freeze(['merged', 'abandoned']);

export function isTerminalChangeStatus(status) {
  return typeof status === 'string' && TERMINAL_CHANGE_STATUSES.includes(status);
}

/**
 * Order a project's changes by their `parent_change` dependency chains and
 * pick the one to drive next.
 *
 * @param {Array<{id: string, status?: string|null, parent_change?: string|null, in_scope?: boolean}>} changes
 *   The change records the driver assembled. Input order is the tiebreak
 *   between mutually-independent changes, so pass them in the owning
 *   artifact's order. `in_scope: false` marks a record the driver resolved
 *   only to answer a dependency (a parent outside the project) — such records
 *   gate their descendants but are never selected to drive.
 * @returns {{ordered: Array<object>, next: object|null, remaining: number, stop: {reason: string, detail: string, ids: string[]}|null}}
 */
export function planDriveOrder(changes) {
  if (!Array.isArray(changes)) {
    throw new TypeError('planDriveOrder expects an array of change records');
  }

  const records = changes.map((c, index) => ({
    id: typeof c?.id === 'string' ? c.id : '',
    status: typeof c?.status === 'string' ? c.status : null,
    parent_change:
      typeof c?.parent_change === 'string' && c.parent_change.length > 0 ? c.parent_change : null,
    in_scope: c?.in_scope !== false,
    index,
    terminal: isTerminalChangeStatus(c?.status),
    blocked_by: null,
  }));

  const nameless = records.filter((r) => r.id === '');
  if (nameless.length > 0) {
    return unsound(records, 'malformed-record', `${nameless.length} record(s) carry no id`, []);
  }

  // Duplicate ids make every downstream answer ambiguous — which record does a
  // `parent_change` pointing at that id mean? Refuse rather than pick one.
  const byId = new Map();
  const duplicates = [];
  for (const r of records) {
    if (byId.has(r.id)) duplicates.push(r.id);
    else byId.set(r.id, r);
  }
  if (duplicates.length > 0) {
    return unsound(
      records,
      'duplicate-id',
      `change id(s) appear more than once: ${[...new Set(duplicates)].join(', ')}`,
      [...new Set(duplicates)],
    );
  }

  // Kahn's algorithm, parent → child, with the input index as a stable
  // tiebreak. A parent that isn't in the record set contributes no edge, so a
  // change with an unresolved parent still sorts (it just never becomes
  // selectable — see the ancestor walk below).
  const childrenOf = new Map(records.map((r) => [r.id, []]));
  const indegree = new Map(records.map((r) => [r.id, 0]));
  for (const r of records) {
    if (r.parent_change && byId.has(r.parent_change)) {
      childrenOf.get(r.parent_change).push(r.id);
      indegree.set(r.id, indegree.get(r.id) + 1);
    }
  }

  const ready = records.filter((r) => indegree.get(r.id) === 0).sort(byInputIndex);
  const ordered = [];
  while (ready.length > 0) {
    const node = ready.shift();
    ordered.push(node);
    for (const childId of childrenOf.get(node.id)) {
      const remainingDeps = indegree.get(childId) - 1;
      indegree.set(childId, remainingDeps);
      if (remainingDeps === 0) {
        ready.push(byId.get(childId));
        ready.sort(byInputIndex);
      }
    }
  }

  // Anything Kahn could not emit sits in (or downstream of) a cycle. Ordering
  // is unsound at that point, so the whole plan stops.
  if (ordered.length !== records.length) {
    const emitted = new Set(ordered.map((r) => r.id));
    const stuck = records.filter((r) => !emitted.has(r.id));
    return unsound(
      [...ordered, ...stuck],
      'dependency-cycle',
      `parent_change chain does not terminate for: ${stuck.map((r) => r.id).join(', ')}`,
      stuck.map((r) => r.id),
    );
  }

  // Per-record blocking, computed from the full ancestor walk rather than
  // inferred from position — an out-of-scope or unresolved ancestor has to
  // name itself in the stop reason, and position alone can't say which
  // descendant it was blocking.
  for (const r of ordered) {
    r.blocked_by = firstBlockingAncestor(r, byId);
  }

  const liveInScope = ordered.filter((r) => r.in_scope && !r.terminal);
  const next = liveInScope.find((r) => r.blocked_by === null) ?? null;

  let stop = null;
  if (!next && liveInScope.length > 0) {
    // Every remaining change is blocked by something the driver may not act on
    // (an out-of-project parent still in flight, or a parent id that resolves
    // to nothing). v1 does not classify or recover — it reports and stops.
    const head = liveInScope[0];
    stop = {
      reason: head.blocked_by.reason,
      detail: `${head.id} is blocked by ${head.blocked_by.id} (${head.blocked_by.reason})`,
      ids: liveInScope.map((r) => r.id),
    };
  }

  return { ordered, next, remaining: liveInScope.length, stop };
}

function byInputIndex(a, b) {
  return a.index - b.index;
}

// A plan the ordering rule cannot express (no ids, ambiguous ids, a chain that
// never terminates). `remaining` still counts live in-scope work so the report
// doesn't read as "nothing left to do".
function unsound(records, reason, detail, ids) {
  return {
    ordered: records,
    next: null,
    remaining: records.filter((r) => r.in_scope && !r.terminal).length,
    stop: { reason, detail, ids },
  };
}

// Walk a record's parent chain and return the first ancestor that stands
// between it and being driveable, or null when the chain is clear.
//
//   unresolved-parent      — the id names no change the driver could read
//   blocked-out-of-scope   — a live parent outside the driven project
//   blocked-pending-parent — a live parent inside the project (it sorts first,
//                            so this is normal queueing, not an error)
function firstBlockingAncestor(record, byId) {
  let cursor = record.parent_change;
  const seen = new Set([record.id]);
  while (cursor) {
    if (seen.has(cursor)) return null; // cycles are handled before this runs
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) return { id: cursor, reason: 'unresolved-parent' };
    if (!parent.terminal) {
      return {
        id: parent.id,
        reason: parent.in_scope ? 'blocked-pending-parent' : 'blocked-out-of-scope',
      };
    }
    cursor = parent.parent_change;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI half — shapes records out of the vault, then calls the core.
// ---------------------------------------------------------------------------

function walkMd(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Every `type: change` entry in the vault, keyed by id. The driver needs the
// whole set, not just the project's — a `parent_change` may point outside the
// project and its status still gates.
export function readChangeEntries() {
  const all = new Map();
  for (const file of walkMd(join(REPO_ROOT, 'vault', 'wiki'))) {
    let fm;
    try {
      ({ fm } = parseFrontmatter(readFileSync(file, 'utf8')));
    } catch {
      continue;
    }
    if (!fm || fm.type !== 'change' || typeof fm.id !== 'string') continue;
    all.set(fm.id, {
      id: fm.id,
      status: typeof fm.status === 'string' ? fm.status : null,
      parent_change: typeof fm.parent_change === 'string' ? fm.parent_change : null,
      project: typeof fm.project === 'string' ? fm.project : null,
      title: typeof fm.title === 'string' ? fm.title : fm.id,
      created: typeof fm.created === 'string' ? fm.created : '',
      path: relative(REPO_ROOT, file),
    });
  }
  return all;
}

// The project's changes (in_scope) plus every out-of-project ancestor reached
// through parent_change (in_scope: false), so the core can gate on them.
export function collectProjectChangeSet(all, projectId) {
  // `created` ascending approximates the owning artifact's order: the
  // scaffolders walk a report's `recommended_changes` (or a plan's steps) in
  // order and stamp `created` as they go. Id is the tiebreak so the walk is
  // deterministic when two entries share a timestamp.
  const inScope = [...all.values()]
    .filter((c) => c.project === projectId)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  const set = inScope.map((c) => ({ ...c, in_scope: true }));
  const included = new Set(set.map((c) => c.id));
  const queue = set.map((c) => c.parent_change).filter(Boolean);
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (included.has(parentId)) continue;
    const parent = all.get(parentId);
    if (!parent) continue; // unresolved — the core reports it by name
    included.add(parentId);
    set.push({ ...parent, in_scope: false });
    if (parent.parent_change) queue.push(parent.parent_change);
  }
  return set;
}

function main() {
  const argv = process.argv.slice(2);
  const projectIdx = argv.indexOf('--project');
  const projectId = projectIdx >= 0 ? argv[projectIdx + 1] : null;
  const json = argv.includes('--json');
  if (!projectId) {
    console.error('usage: node scripts/drive-order.mjs --project <project-id> [--json]');
    process.exit(1);
  }

  const all = readChangeEntries();
  const set = collectProjectChangeSet(all, projectId);
  if (set.filter((c) => c.in_scope).length === 0) {
    const payload = {
      project: projectId,
      ordered: [],
      next: null,
      remaining: 0,
      stop: {
        reason: 'no-changes',
        detail: `no type: change entries carry project: ${projectId}`,
        ids: [],
      },
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`STOP  ${projectId} — ${payload.stop.detail}`);
    process.exit(1);
  }

  const plan = planDriveOrder(set);
  const titleOf = (id) => all.get(id)?.title ?? id;

  if (json) {
    console.log(JSON.stringify({ project: projectId, ...plan }, null, 2));
  } else {
    console.log(`Drive order for ${projectId} (${plan.remaining} change(s) still live):`);
    for (const r of plan.ordered) {
      const marks = [
        r.in_scope ? '' : 'out-of-project',
        r.terminal ? r.status : null,
        r.blocked_by ? `blocked by ${r.blocked_by.id} (${r.blocked_by.reason})` : null,
      ].filter(Boolean);
      const pointer = plan.next && plan.next.id === r.id ? '▶' : ' ';
      console.log(
        `  ${pointer} ${r.id}  [${r.status ?? 'no status'}]${marks.length ? `  — ${marks.join('; ')}` : ''}`,
      );
    }
    if (plan.stop) console.error(`STOP  ${plan.stop.reason} — ${plan.stop.detail}`);
    else if (plan.next) console.log(`NEXT  ${plan.next.id} — ${titleOf(plan.next.id)}`);
    else console.log('DONE  every change in this project is terminal');
  }
  process.exit(plan.stop ? 1 : 0);
}

// Only run when invoked directly (allow importing the core for tests).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
