---
name: meta-add-project
description: Scaffold a project — an initiative with scope, lifecycle, and (optionally) a repo + reporting cadence
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [scaffold, evolution, project]
inputs:
  name:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Project slug (lowercase kebab-case, becomes the file + id)
  title:
    type: string
    required: true
    description: Human-readable title (e.g. "Search revamp v2")
  domain:
    type: string
    required: true
    description: Owning domain (must already exist as a folder under domains/)
  repos:
    type: string
    required: false
    description: Comma-separated list of entity ids (each must be an already-ingested repo, kind=repo). Projects can span multiple repos (e.g. `web,api,infra`). Optional — projects can exist without any repos (planning, research, etc.).
  deadline:
    type: string
    required: false
    description: Target ship date (YYYY-MM-DD). Optional.
  stakeholders:
    type: string
    required: false
    description: Comma-separated list of stakeholder names (people/teams involved). Each is resolved against the vault manifest by kebab id — a match becomes a `[[entity-id]]` reference, a miss becomes a plain string (promote it later via `/os add-entity`). Never blind-wrapped into an unresolved reference.
  reporting_cadence:
    type: string
    required: false
    default: none
    description: 'How often to generate status updates: `daily`, `weekly`, or `none` (default).'
  reporting_target:
    type: string
    required: false
    default: clipboard
    description: 'Where status updates go: `clipboard` (markdown file the user copy-pastes), `notion`, `linear`, `slack`, or `none`. v1 ships clipboard only — others reserved for future integrations.'
outputs:
  - kind: file
    path: vault/wiki/{{input.domain}}/project/{{input.name}}.md
---

# meta-add-project

## Purpose

Create a new `project` archetype entry that can act as a workflow scope — bundling a repo, lifecycle stage, milestones, and reporting cadence. Downstream skills (status report generation, project-scoped schedules, future PR-writing) read this entry to know what they're working on.

A project is the **glue** between primitives. The entry itself stays lean; everything else discovers project membership via `[[project-id]]` wikilinks (the manifest's backlinks make this queryable both directions).

## Procedure

1. Validate `inputs.name` against `^[a-z0-9][a-z0-9-]*$`. Reject if invalid.
2. Confirm `domains/<input.domain>/` exists. If not, reject and suggest `/os add-domain` first.
3. If `inputs.repos` is provided: parse as comma-separated. For each id, confirm `vault/wiki/<input.domain>/entity/<repo-id>.md` exists AND has `kind: repo` in its frontmatter. Reject (listing the missing ones) if any are not found — hint to run `/os ingest repo` first.
4. Target path: `vault/wiki/<input.domain>/project/<input.name>.md`. If it exists, abort with "project `<name>` already exists" (do not overwrite — projects are deliberate).
5. Read `_templates/wiki-entry/project.md.tmpl`.
6. Substitute Mustache placeholders:
   - `{{slug}}` → input.name
   - `{{domain}}` → input.domain
   - `{{title}}` → input.title
   - `{{deadline}}` → input.deadline (leave as `null` or empty string if not provided — the template treats it as optional)
   - `{{source}}` → "manual"
   - `{{datetime}}` → current ISO 8601 UTC
7. After substitution, **uncomment** and populate the workflow fields based on inputs:
   - If `inputs.repos` is set: uncomment the `repos:` array block and write each id as a `- <id>` line
   - If `inputs.reporting_cadence != "none"` OR `inputs.reporting_target != "clipboard"`: uncomment the entire `reporting:` block and set `cadence`, `target`, `target_ref` (null if not yet known), and compute `next_due` from cadence + today (daily = tomorrow, weekly = today + 7d)
   - Always uncomment `lifecycle_stage: planning` — every new project starts in planning
   - `milestones` stays commented out — user fills in manually
8. Parse `inputs.stakeholders` (if provided): split on comma, trim. For each token, **resolve it against the vault manifest instead of blind-wrapping it** (the old behavior minted dangling links — it wrapped the raw display name, which can't resolve even if a matching entity later exists):
   - Derive the kebab id using the **same rule as [[meta-add-entity]] step 2** (canonical definition): `id = kebab-case(token)` (lowercase, spaces/punctuation → single hyphens, strip leading/trailing hyphens). These must stay byte-identical — an entity stored under meta-add-entity's id must match the id derived here, or resolution silently falls back to a plain string.
   - Load `vault/.index/manifest.json` and scan `entries` for any entry with `type: entity` whose `id` equals the derived id. This is the same flat, domain-agnostic resolution the `wikilinks` structural test uses — so a match here guarantees the reference resolves.
   - **If found** → emit `[[<id>]]` (the kebab id, never the display name).
   - **If not found** → emit the token as a **plain string** (no wikilink). Collect these unresolved tokens so the success report can hint: run `/os add-entity name="<token>"` to promote them to entities, after which a re-run resolves them.

   Set the frontmatter `stakeholders:` array to this mixed list of `[[id]]` references and plain strings. Never blind-wrap a free-text name into an unresolved wikilink reference.

9. Write the rendered content via the Write tool.
10. Record the audit event via the dual-write wrapper:
    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-project \
      --skill meta-add-project \
      --args '{"name":"<name>","repos":["<repo>", ...]}' \
      --files-touched '["vault/wiki/<domain>/project/<name>.md"]'
    ```
11. Print a short confirmation:

    ```
    ✓ Project created: <title>
      slug:       <name>
      lifecycle:  planning
      repos:      <comma-list or "(no repos linked)">
      reporting:  <cadence> → <target>
      stakeholders: <comma-list of resolved [[id]] + plain strings, or "(none)">
      entry:      vault/wiki/<domain>/project/<name>.md
    ```

    If any stakeholder tokens were written as plain strings (no matching entity), add a line:
    `    note: stakeholders <list> have no entity — run /os add-entity to promote, then re-run to resolve them.`

## Outputs

- New `project` archetype entry at `vault/wiki/<domain>/project/<name>.md`
- Audit log entry

## Errors

- Invalid name pattern → reject with the pattern shown
- Domain folder missing → suggest `/os add-domain <domain>` first
- Any repo in `repos` doesn't have a matching entity → reject listing the missing ids; suggest `/os ingest repo <id>` for each
- Project slug already exists → reject; pick a different `name` or rename the existing project via `/os rename`
- Invalid `reporting_cadence` or `reporting_target` value → reject with allowed values
- Stakeholder token doesn't match an existing entity → not an error; written as a plain string and surfaced in the report as promotable via `/os add-entity`

## See also

- [[standard-project-workflow]] — the canonical contract for projects
- [[archetype-project]] — the underlying archetype
- [[dev-ingest-repo]] — produces the repo entity that a project can reference
- [[meta-add-entity]] — creates the non-repo entities (people/teams) that stakeholders resolve to; run it to promote a plain-string stakeholder into a resolvable reference
- [[standard-scheduled-jobs]] — runbooks can carry `project: <id>` to fire only when the project is active
