---
id: standard-feature-anatomy
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, meta-process, evolution]
source: seed
private: false
title: Feature anatomy — adding a new capability
url: internal://standard/feature-anatomy
kind: doc
last_verified: 2026-05-20
---

# Feature anatomy — adding a new capability

## What this covers

How to add a **new capability** to the OS — something that didn't exist before and spans multiple artifacts (runtime + scaffolder + dashboard + docs). Scheduled jobs were the first capability built against this standard; workflows, goals, and integrations will follow the same anatomy.

This is the **meta-scaffolder rubric**. It is NOT for adding instances of existing primitives — adding a new domain, skill, app, archetype, or schedule has a dedicated `meta-add-*` scaffolder. This standard is for the rarer case of "we want the OS to _understand_ a new kind of thing or do a new kind of thing."

## When to use this

| you want to…                                       | use…                |
| -------------------------------------------------- | ------------------- |
| add a domain                                       | `/os add-domain`    |
| add a skill                                        | `/os add-skill`     |
| add an app                                         | `/os add-app`       |
| add an archetype                                   | `/os add-archetype` |
| add a schedule                                     | `/os add-schedule`  |
| **add a capability that needs new infrastructure** | **this standard**   |
| change OS structure within existing primitives     | `/os evolve`        |

## Decision tree (read before scaffolding anything)

```
Is this an instance of an existing primitive?
├── Yes → use the matching meta-add-* skill, done.
└── No → continue
       │
       Does it need a new data shape?
       ├── New archetype required (see "Archetype vs extend" rubric below)
       └── Extend an existing archetype with optional fields
       │
       Does it need runtime infrastructure?
       ├── Periodic firing → likely scheduled-runbook (existing) or workflow (future)
       ├── Reactive firing → likely hook (existing primitive)
       ├── On-demand only → no runtime needed, just a skill
       │
       Does it need a system-level installer?
       ├── Yes → installer script + template + opt-in prompt in install.sh
       └── No → skip
       │
       Does it surface in the dashboard?
       ├── Yes → backend route + frontend view + sidebar entry
       └── No → skip
       │
       Does it need a router intent?
       ├── Yes → add row to OS.md "Intent vocabulary"
       └── No → skip (direct skill invocation only)
```

## The anatomy — slots a capability may fill

Not every slot is required. The scheduled-jobs capability filled 9 of these; a simpler feature might fill 3. Use this as a checklist when designing AND when reviewing the diff.

### 1. Data model

- [ ] Decide: new archetype or extend existing? (see rubric below)
- [ ] If new archetype: scaffold it (`/os add-archetype`) — produces template + reference entry + OS.md row
- [ ] If extending: update the existing template (`_templates/wiki-entry/<archetype>.md.tmpl`) AND the archetype reference (`vault/wiki/_seed/meta/reference/archetype-<name>.md`)

### 2. Runtime (only if the feature _does_ something at runtime)

- [ ] Runner at `scripts/<feature>-<verb>.mjs` (pure Node preferred — no npm deps if avoidable, so launchd/cron/CI can invoke it standalone)
- [ ] Ephemeral state at `.claude/state/<feature>-*.json` (e.g. dedupe, last-run timestamps)
- [ ] Audit log at `vault/raw/<feature>-runs.jsonl` — one JSON line per fire; fields include `ts`, `id`, `exit`, `duration_ms`, action-specific data
- [ ] Dry-run / list / force modes via CLI flags (`--dry-run`, `--list`, `--run-id <id>`)

### 3. Installer (only if the feature needs system-level integration)

- [ ] Template at `_templates/<artifact>.tmpl` (e.g. launchd plist, systemd unit, crontab fragment)
- [ ] Installer at `scripts/install-<feature>.sh` — renders the template with absolute paths, installs, reports status, idempotent
- [ ] Opt-in prompt in root `install.sh` so first-run users can enable it
- [ ] Document uninstall in the standards entry

### 4. Scaffolder skill (the user-facing entry point for adding instances)

- [ ] `.claude/skills/meta-add-<feature>/SKILL.md` (`user-invocable: true`, schema-driven `inputs:`)
- [ ] Procedure section enumerates the side-effects (write template → write seed entry → update index)
- [ ] Errors section names the rejectable inputs
- [ ] Listed in `domains/meta/playbook.md` Skills section

### 5. Dashboard surface (only if user-facing)

- [ ] Backend route at `domains/meta/app/server/routes/<feature>.ts`
  - `GET /api/<feature>` — list + status
  - `POST /api/<feature>/<verb>` — mutations / triggers
  - Reuse SSE schema if shelling to `claude -p` (see `runStream` in `lib/api.ts`)
- [ ] Registered in `server/index.ts`
- [ ] Frontend app at `domains/meta/app/src/apps/<id>/` with `manifest.ts` (`{ id, label, domain, navGroup, View }`) + `View.tsx` (default export)
- [ ] Sidebar entry, ordering, icon, and section grouping derive from the manifest automatically — see `standard-app-architecture.md`
- [ ] App imports `'../../shared/styles.css'` and uses the shared design primitives (`Card`, `Metric`, `StatusBadge`, etc.) from `src/shared/`

### 6. Router

- [ ] Intent vocabulary row in `OS.md` mapping common phrases to the new skill

### 7. Documentation (load-bearing)

- [ ] Canonical reference at `vault/wiki/_seed/meta/reference/standard-<feature>.md`
- [ ] Summary section in `domains/meta/playbook.md` (under "OS Standards")
- [ ] README section if user-visible (Heartbeat section is the model)
- [ ] Inline help in the dashboard view (muted paragraph at top + empty-state copy)
- [ ] Seed examples in `vault/wiki/_seed/<domain>/<archetype>/`

### 8. Decision entries

- [ ] If a non-obvious design choice was made (new archetype vs. extend, custom installer vs. native primitive, etc.), write `vault/wiki/_seed/meta/decision/decision-<topic>.md`
- [ ] Linked from the playbook's "Captured decisions" section

## Archetype vs. extend rubric

Two-or-more "yes" answers → new archetype. Otherwise extend an existing one with optional fields.

1. Does the new thing have a **distinct lifecycle** (create / active / archive states differ from existing archetypes)?
2. Does it require **≥3 archetype-specific required fields**?
3. Would mixing it into an existing archetype force adding **many** optional fields (>3) that don't apply to the original?
4. Is it queried with a **distinct pattern** ("list all X" frequently, separate from listing the host archetype)?

**Worked example: scheduled jobs.** None of the four answered "yes" — schedule + prompt are just two optional fields on `runbook`, queries via the dashboard filter by their presence, lifecycle matches a runbook. So we extended `runbook` instead of inventing `schedule`.

## Cross-cutting rules every capability inherits

| concern             | rule                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Casing**          | folders/filenames `lowercase-kebab`; frontmatter keys + JSONL fields `snake_case`; TS code `camelCase`; React components `PascalCase` |
| **Logging**         | every runtime fire → one JSONL line at `vault/raw/<feature>-runs.jsonl` with `{ts, id, exit, duration_ms, …}`                         |
| **State**           | ephemeral runtime state → `.claude/state/`; persistent knowledge → `vault/wiki/`; generated artifacts → `vault/output/`               |
| **Permissions**     | dashboard-triggered `claude -p` uses `--permission-mode bypassPermissions` (UI already collected user consent via button + form)      |
| **Failures**        | surface visibly (dashboard shows last_run.exit !== 0); do not auto-disable on failure (let the human decide)                          |
| **Cost**            | features that spawn `claude -p` MUST document expected cadence + cost in the standards entry                                          |
| **Discoverability** | every user-facing command appears in: OS.md intent vocab, README Commands table, meta playbook Skills section                         |

## Retirement (removing a capability cleanly)

When deciding to retire a feature, do **not** silently delete. Future Claude sessions and contributors need to know what was tried and why it didn't fit.

1. **Mark, don't delete the standard.** Update `standard-<feature>.md`: change `last_verified` to today, prepend the body with a `> RETIRED: <date> — <reason>` blockquote, add a "Lessons" section.
2. **Remove the runtime** — delete `scripts/<feature>-*.mjs`, `scripts/install-<feature>.sh`, and the associated `_templates/*.tmpl`.
3. **Remove the dashboard surface** — delete the view, the route, the ViewId entry, the sidebar registration, the CSS block.
4. **Remove the scaffolder skill** — `meta-delete` handles `.claude/skills/meta-add-<feature>/`.
5. **Remove the seed entries** (the example instances). Keep the standards reference (step 1).
6. **Update**: `OS.md` vocab (remove or annotate), `domains/meta/playbook.md` section (remove or mark retired), README (remove section).
7. **Keep the audit log** — `vault/raw/<feature>-runs.jsonl` is historical; do not delete.
8. **Write a `decision-retire-<feature>.md`** explaining why.

## Versioning — primitive shape changes

| change                                  | safe?                  | what to do                                                                                            |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Add optional frontmatter field          | yes                    | document in the archetype reference; ship                                                             |
| Remove unused optional field            | yes (if truly unused)  | grep first; document removal in archetype reference                                                   |
| Add required field                      | breaking               | bump `version` in the archetype reference, write a `decision-*.md`, ship a migration in `meta-evolve` |
| Rename a field                          | breaking               | same as add-required; migration must rewrite existing entries                                         |
| Change field semantics without renaming | breaking AND dangerous | rename instead; never silently repurpose a field                                                      |

## Worked example: scheduled jobs

The scheduled-jobs capability filled these slots — read this as a concrete instance of the anatomy:

| slot             | filled by                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Data model       | Extended `runbook` archetype with optional `schedule` + `prompt` fields (rubric: 0 of 4 → extend, not new archetype)                  |
| Runtime          | `scripts/scheduler-tick.mjs` (Node, no deps) + `.claude/state/schedule-runs.json` (dedupe) + `vault/raw/scheduled-runs.jsonl` (audit) |
| Installer        | `_templates/launchagent.plist.tmpl` + `scripts/install-scheduler.sh` + opt-in prompt in `install.sh`                                  |
| Scaffolder skill | `.claude/skills/meta-add-schedule/SKILL.md`                                                                                           |
| Dashboard        | `server/routes/schedules.ts` (GET list, GET runs, POST run-now SSE) + `src/apps/schedules/` (manifest + View) + scoped CSS            |
| Router           | `OS.md` row: `add schedule` / `new schedule` / `schedule this` → `meta-add-schedule`                                                  |
| Documentation    | `standard-scheduled-jobs.md` (canonical) + playbook section 14 + README "Heartbeat" + inline dashboard help + 2 seed runbooks         |
| Decision entry   | Implicit in the standard's intro; no separate `decision-*.md` because no contentious choice                                           |

## Related

- [[concept-primitives]] — registry of every primitive the OS understands
- [[standard-skill-format]] — required shape for scaffolder skills
- [[standard-wiki-format]] — required shape for archetypes
- [[standard-file-naming]] — where everything lives
- [[standard-log-formats]] — JSONL shape every runtime audit log inherits
- [[standard-scheduled-jobs]] — the first capability built against this anatomy
- [[meta-add-domain]] · [[meta-add-skill]] · [[meta-add-app]] · [[meta-add-archetype]] · [[meta-add-schedule]] · [[meta-add-project]] · [[dev-add-change]] — the instance-level scaffolders the anatomy informs
- [[meta-evolve]] — escape hatch for changes that don't fit existing scaffolder shapes
- [[meta-audit]] — verifies every shipped feature passes the anatomy's contract
