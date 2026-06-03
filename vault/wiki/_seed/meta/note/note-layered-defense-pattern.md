---
id: note-layered-defense-pattern
type: note
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [pattern, defense-in-depth, dogfood]
source: seed
private: false
project: build-agentic-os-v1
---

# Layered defense (skill + audit + dashboard)

A pattern that emerged during the v1 build and now appears in every constraint we want to enforce: place the enforcement in **three places** rather than one.

## The three layers

| layer                 | role                                            | when it fires                                                                                                                  |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Skill gate**        | Fail-fast at the point of harm                  | The instant an agent tries to do the bad thing (e.g. `dev-write-change` PLAN phase refuses to plan if body is unfilled)        |
| **Audit**             | Passive scan, surfaces drift                    | When the user runs `/os audit` or opens the Health view; also via the weekly health-check runbook                              |
| **Dashboard surface** | Visual nudge before the user does the bad thing | The Changes view shows a yellow state-hint card when body is placeholder; the Overview shows a red badge when audit has errors |

## Why three

- **Skill alone** catches the offense at the right moment but silently lets pre-existing drift accumulate (only checks at write-time)
- **Audit alone** catches drift but only when invoked; nothing stops a half-formed action mid-flight
- **Dashboard alone** is visible only when the user happens to look; doesn't gate agent operations at all

Combined: the agent can't proceed with broken state (skill), accumulated drift surfaces on demand (audit), and the user notices before they trigger an action (dashboard).

## Examples in the v1 OS

| constraint                                          | skill gate                                          | audit check                                             | dashboard signal                                                                             |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Change descriptions filled in                       | `dev-write-change` PLAN refuses if body is template | `change-body-template-placeholder` (warn)               | Yellow state-hint in Changes view                                                            |
| YAML frontmatter valid                              | (js-yaml errors at parse time)                      | `skill-frontmatter-unquoted-colon` (warn)               | Skills view's Drift section + Overview red banner                                            |
| Scheduled runbooks fire only when project is active | Scheduler tick skips with stderr message            | `entry-project-exists` (error) for missing project refs | Schedules view shows skipped (when implemented)                                              |
| Wikilinks resolve                                   | (not enforced at write time)                        | `wiki-link-dangling` (warn)                             | Polymorphic resolver in EditableMarkdown — broken targets just navigate to empty Vault state |

## When NOT to use three layers

For trivial conventions (file naming kebab-case, etc.) one layer (the audit) is enough. Use three when:

- The constraint is **load-bearing** — violating it breaks downstream behavior, not just aesthetics
- The constraint has a **clear point of harm** — there's a specific skill operation that's the wrong moment to violate it
- The drift is **visible from the dashboard** — there's a natural place to surface it

## See also

- [[standard-feature-anatomy]] — the meta-framework that informs where each layer lives
- [[standard-os-audit]] — the audit layer's check registry
- [[standard-change-workflow]] — the most-developed example of all three layers in action
- [[build-agentic-os-v1]] — the seed project under which this pattern emerged
