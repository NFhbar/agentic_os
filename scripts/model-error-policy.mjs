// Model-availability policy — why a run died, and what the OS may do about it.
//
// A `claude -p` child that cannot reach its pinned model dies fast and quiet:
// exit 1 in under a second, no result event, an empty `error` column. The row
// reads "failed" and says nothing — the runtime lies by omission about a
// condition the operator can fix in thirty seconds (top up credits, re-login,
// wait out a rate limit). This module turns that evidence into a named class
// and a message the dashboard and notifications can key on.
//
// Skills declare their posture in SKILL.md frontmatter (flat scalars):
//
//   model: <model-id>            # the pin
//   model_policy: required       # or: fallback-allowed  (absent → inherit)
//   model_fallbacks: <model-id>[, …]   # only read with fallback-allowed
//
// `required` parks: a review gate that silently downgrades to a weaker model
// still *passes* things, which removes the safety property the pin bought.
// `fallback-allowed` is for drafters whose output flows into a required gate
// anyway — those may be re-dispatched once on the declared fallback.
//
// PURE AND SQLITE-FREE BY CONTRACT. The finalize paths import this from both
// the launchd supervisor and the dashboard server, and the classifier is
// unit-tested — pulling node:sqlite (runs-db) into this module's graph would
// break vitest's resolver. Only node built-ins + the shared frontmatter
// parser (js-yaml, already in the launchd graph via scheduler-tick).

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared real-YAML parser. Every runtime frontmatter read is consolidated
// onto one parser (see scripts/frontmatter.mjs), a superset of a flat-line
// read — it accepts the documented scalar shape AND a YAML list of
// fallbacks, and surfaces malformed frontmatter as parseError instead of
// silently half-reading it.
import { parseFrontmatter } from './frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// How much of the journal / stderr tail is evidence. Availability failures
// are terminal — the message is in the last handful of lines — and both
// terminal paths call this synchronously, so the read is bounded by design.
export const MODEL_ERROR_TAIL_BYTES = 8 * 1024;

// Declared postures. Anything else in `model_policy:` (typo, future value)
// reads as `inherit` — an unknown policy must never be treated as permission
// to swap a model.
export const MODEL_POLICIES = new Set(['required', 'fallback-allowed', 'inherit']);

// Availability classes, in FIRST-MATCH-WINS order. Case-insensitive. The
// order matters: `usage limit` is a credits condition even though the word
// "limit" also appears in the rate-limit class, and an auth failure that
// mentions a model id must not read as model-not-found.
//
// `null` (no class matches) means "not an availability failure" — ordinary
// error handling keeps the row exactly as it is today.
export const MODEL_UNAVAILABILITY_PATTERNS = [
  [
    'credits',
    /credit balance|out of credits|usage limit|insufficient credit|spending (?:limit|cap)|billing_error/i,
  ],
  [
    'auth',
    /not logged in|invalid (?:api key|x-api-key)|authentication_error|unauthorized|\b401\b|oauth token|token (?:expired|revoked)|please run \/login/i,
  ],
  [
    'model-not-found',
    /model[^\n]{0,60}(?:not found|does not exist|unavailable|not available)|not_found_error[^\n]{0,80}model/i,
  ],
  ['rate-limit', /rate.?limit|\b429\b|overloaded_error|overloaded/i],
];

// Classify free text (journal tail, stderr tail, an error column) into one of
// the four availability classes, or null.
export function classifyModelUnavailability(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const [cls, re] of MODEL_UNAVAILABILITY_PATTERNS) {
    if (re.test(text)) return cls;
  }
  return null;
}

// The stderr sidecar next to a run's journal. Mirrors runs-db's
// stderrPathFor — duplicated deliberately: runs-db pulls node:sqlite, and
// this module's whole point is staying out of that graph.
export function stderrSiblingPath(outputPath) {
  if (typeof outputPath !== 'string' || outputPath === '') return null;
  return outputPath.replace(/\.raw\.jsonl$|\.jsonl$/, '.stderr.log');
}

// Last `cap` bytes of a file, '' on any read failure (missing journal,
// permissions, a path from a legacy row).
function readTail(path, cap = MODEL_ERROR_TAIL_BYTES) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - cap);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

// Read one skill's availability posture. Unreadable / absent / malformed
// SKILL.md → `inherit` with no pin and no fallbacks: the OS never invents a
// policy for a skill it cannot read.
export function readSkillModelPolicy(skillName, repoRoot = REPO_ROOT) {
  const inherit = { policy: 'inherit', pinned: null, fallbacks: [] };
  // The name is joined straight into a filesystem path; gate on the skill
  // naming shape (`.claude/skills/<name>/SKILL.md`) so a `../`-ish value from
  // prompt-text attribution can't walk out of the skills tree.
  if (typeof skillName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(skillName)) return inherit;
  let text;
  try {
    text = readFileSync(join(repoRoot, '.claude', 'skills', skillName, 'SKILL.md'), 'utf8');
  } catch {
    return inherit;
  }
  const { fm, parseError } = parseFrontmatter(text);
  if (parseError) return inherit;
  const declared = typeof fm.model_policy === 'string' ? fm.model_policy.trim() : null;
  return {
    policy: declared && MODEL_POLICIES.has(declared) ? declared : 'inherit',
    pinned: typeof fm.model === 'string' && fm.model.trim() ? fm.model.trim() : null,
    fallbacks: parseFallbacks(fm.model_fallbacks),
  };
}

// `model_fallbacks:` is documented as a comma-separated scalar; a YAML list
// parses just as well through the shared parser, so accept both.
function parseFallbacks(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

// The exact operator-facing message. Dashboards and notification templates
// key on these three formats — treat them as a wire contract, not prose.
//
// `pinned` is the model to NAME. Callers pass the RESOLVED model (what the
// dispatch actually ran on); the frontmatter pin is the fallback only when
// nothing was resolved. An override or a fallback leg means pin ≠ actual, and
// naming the pin sends the reader to the wrong model.
export function composeModelUnavailableError(
  cls,
  { pinned = null, policy = 'inherit', fallbacks = [] } = {},
) {
  const head = `model-unavailable(${cls}): ${pinned ?? 'unknown'}`;
  if (policy === 'required') {
    // Credits are restored by paying; every other class is restored by
    // regaining access (re-login, entitlement, waiting out the limit).
    const restore = cls === 'credits' ? 'credits' : 'access';
    return `${head} — policy: required; parked, no side effects; restore ${restore} and re-dispatch`;
  }
  if (policy === 'fallback-allowed' && fallbacks.length > 0) {
    return `${head} — policy: fallback-allowed; re-dispatch on ${fallbacks[0]} (drop effort pin)`;
  }
  return head;
}

// Classify one run row from its on-disk evidence: the journal tail plus its
// stderr sidecar tail. Instant deaths (exit 1 in ~0–1 s, the credit shape)
// write nothing but this — which is exactly why the row's own `error` column
// is empty and cannot be the source.
export function classifyRunFailure(row) {
  const journal = row?.output_path ?? null;
  if (!journal) return null;
  const stderrPath = stderrSiblingPath(journal);
  const evidence = [readTail(journal), stderrPath ? readTail(stderrPath) : ''].join('\n');
  return classifyModelUnavailability(evidence);
}

// Terminal-path entry point: null when the run did not die on availability,
// otherwise the structured line to prepend to the run's error.
export function enrichModelUnavailability(row) {
  const cls = classifyRunFailure(row);
  if (!cls) return null;
  const { policy, pinned, fallbacks } = readSkillModelPolicy(row?.skill ?? null);
  return composeModelUnavailableError(cls, {
    // Resolved model first (see composeModelUnavailableError).
    pinned: row?.model ?? pinned,
    policy,
    fallbacks,
  });
}

// Pure decision for the auto-fallback hook — unit-tested without sqlite or a
// filesystem. Every gate is a separate `reason` so the logs say why a run did
// NOT get a second leg, which is the interesting case.
//
// The loop guard ("the fallback hook fires once") has two arms: a
// resolved-model arm — the run already resolved to the declared fallback — and a title
// arm, because a fallback leg that reports a slightly different observed
// model id (a dated variant of the pin) would otherwise slip past the first
// and re-dispatch forever.
export function decideModelFallback({
  state,
  resolvedModel = null,
  cls = null,
  policy = 'inherit',
  fallbacks = [],
  title = null,
} = {}) {
  const no = (reason) => ({ redispatch: false, model: null, reason });
  if (state !== 'failed') return no('not-failed');
  if (policy !== 'fallback-allowed') return no('policy-not-fallback-allowed');
  if (!Array.isArray(fallbacks) || fallbacks.length === 0) return no('no-fallbacks');
  if (!cls) return no('not-classified');
  if (typeof title === 'string' && title.startsWith('fallback(')) return no('fallback-leg');
  if (resolvedModel && resolvedModel === fallbacks[0]) return no('loop-guard');
  return { redispatch: true, model: fallbacks[0], reason: 'ok' };
}

// The re-dispatch title. `<model>` is the model the second leg will run on —
// the row's title is where an operator scanning the Processes list learns
// that this run is a fallback and what it fell back TO.
export function fallbackRunTitle(model, skill) {
  return `fallback(${model}): ${skill ?? 'run'}`;
}
