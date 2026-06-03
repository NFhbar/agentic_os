---
name: meta-research-project
description: '(deprecated) Alias for research-write. Emits a one-time warning + delegates. Removal candidate after phase E of the research-domain project — kept while legacy callers (`domains/meta/app/server/routes/projects.ts`, `View.tsx` tooltips, dashboard prompt templates) still name this skill by string.'
user-invocable: true
version: 2
domain: meta
tags: [project, research, deprecated, alias]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Pass-through to research-write''s `project` input.'
  prompt:
    type: string
    required: false
    description: 'Legacy free-form research prompt. The alias derives a slug-safe `report_topic` from this prompt (3–5 word summary, regex-validated, retried-on-failure with `untitled-<timestamp>` fallback) and passes the full original prompt as `notes` to research-write so nothing is lost.'
  report_topic:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'
    description: 'Forward-compat input. If set, used verbatim as research-write''s `report_topic` (skipping slug derivation). When both `prompt` and `report_topic` are present, `prompt` still flows through as `notes`.'
  materials:
    type: object
    required: false
    description: 'Pass-through to research-write''s `materials` input (shape `{ wikilinks: [...], urls: [...] }`).'
  material_limit:
    type: integer
    required: false
    description: 'Pass-through to research-write''s `material_limit`. Default lives in research-write (10).'
outputs:
  - kind: file
    path: vault/wiki/research/research-report/{{input.project}}-{{derived_topic}}.md
spawns:
  - research-write
---

# meta-research-project (deprecated alias)

## Purpose

**Deprecated.** This skill is the project-orchestration entry point for research from the pre-graduation era. Phase B of the [[research-domain]] project graduated the research-domain skills into [[research-write]] / [[research-review]] / [[research-revise]] / [[research-update]]; this skill is retained ONLY as a delegation alias so legacy callers don't break mid-graduation:

- `domains/meta/app/server/routes/projects.ts` — the Project page's research-dispatch endpoint names this skill in its prompt
- `domains/meta/app/src/apps/projects/View.tsx` — phase tooltips reference this skill
- The dashboard run-system prompt template

Phase D (the research app UI) is the natural place to switch those callers to [[research-write]] directly. After phase D + phase E ship, this alias becomes a one-line removal — captured as a follow-up in [[research-domain]]'s `## Out-of-scope`.

**New work should call [[research-write]] directly.** Use this alias only when something already names this skill by string.

## Procedure

### Step 1: Emit deprecation warning

Print to stderr (single line, once per invocation):

```
⚠ meta-research-project is deprecated — use /os research write (research-write skill) instead. Delegating now.
```

### Step 2: Derive `report_topic`

The slug-derivation rule turns the legacy free-form `prompt` into the structured `report_topic` [[research-write]] needs.

**2a. Short-circuit when `report_topic` is provided.** If `inputs.report_topic` is set AND matches `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`, use it verbatim. Skip to Step 3. (This is the forward-compat path — a caller migrating off the alias may have started passing `report_topic` directly.)

**2b. Reject when neither `prompt` nor `report_topic` is provided.** The legacy contract required `prompt`. Reject with: `meta-research-project (deprecated): one of "prompt" or "report_topic" is required.`

**2c. Derive slug from `prompt`.** Issue the following prompt to the model:

```
Given this free-form research intent: <inputs.prompt>. Output ONLY a 3-5 word slug-safe summary (lowercase, hyphenated) suitable for use as a filename slug. No prose, no quotes.
```

Validate the response against `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`. If it matches, use it as `report_topic`.

**2d. Retry once on validation failure.** If the response doesn't match, re-issue with a clarification: `Your previous answer "<bad output>" didn't match the required regex ^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$. Try again — 3-5 lowercase words separated by hyphens, no other characters.`

**2e. Fallback on second failure.** If the retry also fails validation, use `untitled-<unix-timestamp>` (e.g. `untitled-1748307025`). This is defensive — the regex is forgiving enough that the LLM should clear it; the fallback exists so the alias never hard-fails on slug derivation.

### Step 3: Delegate to research-write

Invoke [[research-write]] via the Skill tool. Pass:

- `project: <inputs.project>` (verbatim)
- `report_topic: <derived or passed-through slug>` (from Step 2)
- `notes: <inputs.prompt>` (the full original prompt is preserved here — research-write surfaces it as a `> User intent:` blockquote so the free-form context isn't lost behind the slug)
- `materials: <inputs.materials>` (verbatim if provided, else omit)
- `material_limit: <inputs.material_limit>` (verbatim if provided, else omit — research-write applies its own default)

Return [[research-write]]'s output verbatim (the existence check, the report write, the audit event, the summary block — all owned by the delegated skill).

### Step 4: Audit log

The audit event for the work is recorded by [[research-write]]'s Step 10 (action: `research-write`). The alias adds a secondary event recording the indirection so dashboard introspection can surface which calls came through the alias vs direct:

```bash
node scripts/record-dashboard-action.mjs \
  --action meta-research-project-aliased \
  --skill meta-research-project \
  --args '{"project":"<id>","derived_report_topic":"<slug>","derivation_source":"<passthrough|llm|fallback>"}' \
  --files-touched '[]'
```

(`derivation_source: passthrough` when Step 2a fired; `llm` when Step 2c or 2d produced the slug; `fallback` when Step 2e fired.)

## Caveats

- **Slug determinism.** Different invocations of this alias against the same `prompt` may produce different slugs (LLM nondeterminism). That means the existence check at the top of [[research-write]] (`<project>-<report_topic>` already on disk?) will MISS, and a second report will be scaffolded instead of the user being routed at [[research-update]]. Mitigation: if you're re-dispatching the same investigation, pass `report_topic` directly (Step 2a's short-circuit). The dashboard's project view exposes the most recent report id under each project; copy/paste from there.
- **No idempotency at the alias layer.** Idempotency lives in [[research-write]]'s existence check — the alias is a thin pass-through. Re-running with the same `prompt` may produce a fresh `report_topic`; see the slug-determinism caveat above.
- **Multi-report-per-project workflows should call [[research-write]] directly.** The alias is fine for legacy single-report flows; for project-orchestration scenarios that emit multiple reports under one project, use the direct skill so you control `report_topic`.

## Outputs

- Whatever [[research-write]] writes (report markdown + project frontmatter mutation + audit event)
- One additional audit event tagged `meta-research-project-aliased` recording the indirection

## Errors

- Neither `prompt` nor `report_topic` provided → reject (Step 2b)
- Slug derivation fails the retry → fallback to `untitled-<timestamp>` (Step 2e), never hard-error here
- Errors raised by [[research-write]] propagate verbatim — the alias adds no extra error surface

## See also

- [[research-write]] — the graduation target this alias delegates to
- [[research-review]] · [[research-revise]] · [[research-update]] — sibling skills in the research-domain lifecycle
- [[research-domain]] — the project whose phase B introduced this graduation
- [[meta-research-project]] — (legacy reference: this file IS the deprecation alias — direct callers should migrate to [[research-write]])
