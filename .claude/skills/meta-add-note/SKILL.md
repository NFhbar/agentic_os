---
name: meta-add-note
description: Scaffold a generic note entry — a domain- or project-scoped observation, lesson, or running log that doesn't fit decision / change / research archetypes. Vault-only — writes a single markdown file under vault/wiki/<domain>/note/.
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [scaffold, note, vault-only]
inputs:
  title:
    type: string
    required: true
    description: 'Human-readable title (e.g. "Slack MCP scope limitations"). Used to derive the slug if `slug` is not provided.'
  domain:
    type: string
    required: true
    description: 'Owning domain (must already exist as a folder under domains/). Note lands at vault/wiki/<domain>/note/<slug>.md.'
  slug:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Override the auto-derived slug. Defaults to a kebab-case slug derived from the title (lowercased, non-alphanumeric → hyphen, collapsed runs, max 80 chars).'
  project:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Owning project id. When set, the note appears under the project page''s Notes tab + lifecycle stepper. Optional — orphan notes (no project) are valid; they live as domain-level observations.'
  topic:
    type: string
    required: false
    description: 'Short topical category for grouping (e.g. "dogfooding-friction", "decision-rationale"). Surfaces in the Notes view''s sidebar. Optional.'
  tags:
    type: string
    required: false
    description: 'Comma-separated free tags. Combined with auto-tags (none today). Example: `dogfooding,friction,research`.'
  body:
    type: string
    required: false
    description: 'Initial body content (markdown). Optional — defaults to the template''s placeholder text the user can fill in via the dashboard or editor.'
outputs:
  - kind: file
    path: vault/wiki/{{input.domain}}/note/{{input.slug-or-derived-from-title}}.md
spawns: []
---

# meta-add-note

## Purpose

Create a new `note` archetype entry — a domain- or project-scoped observation. Notes are the long-form text that doesn't fit the other archetypes:

- Not a `decision` — no formal "this is what we chose and why" structure
- Not a `change` — no code/branch/PR lifecycle
- Not a `research-report` — no investigation + recommendations
- Just running observations, lessons, friction logs, etc.

The dashboard's Overview quick-action "Note" dispatches this skill. Until this skill existed, generic notes had to be hand-authored — that gap blocked the Note button from being functional.

The closest sibling is `meta-add-research-note` — that one appends to a research-report's `notes_log` (mid-lifecycle guidance for downstream skills). This skill is for stand-alone notes; the two don't overlap.

## Pre-conditions

- The `<domain>` must already exist as a directory under `domains/<domain>/`. If not, the skill rejects with a hint to run `/os add-domain <name>` first.
- The target file path must not already exist. If it does, the skill rejects with the existing path (user resolves by choosing a different slug OR editing the existing file).

## Procedure

1. **Validate inputs.**
   - `title` is required + non-empty after trim.
   - `domain` is required + the directory `domains/<domain>/` exists. Reject with `domain "<value>" does not exist — run /os add-domain <value> first` otherwise.
   - `slug` (if provided) matches `^[a-z0-9][a-z0-9-]*$`. If not provided, derive from `title`:
     - Lowercase
     - Replace any non-alphanumeric run with `-`
     - Collapse repeated `-` into single
     - Strip leading/trailing `-`
     - Truncate to 80 chars
     - Re-strip trailing `-` after truncation
   - `project` (if provided) matches `^[a-z0-9][a-z0-9-]*$` AND a wiki entry with `type: project` AND `id: <project>` exists in the manifest. Reject with `project "<id>" not found in vault` otherwise.
   - `tags` (if provided) splits on `,` then trims each. Empty result is fine — defaults to `[]`.

2. **Compute the target path.** `vault/wiki/<domain>/note/<slug>.md`. If the file already exists at that path, reject:

   ```
   A note already exists at vault/wiki/<domain>/note/<slug>.md. Use a different slug OR edit the existing file directly.
   ```

3. **Scaffold from the template.** Read `_templates/wiki-entry/note.md.tmpl` and substitute:

   | placeholder    | value                                                                                                          |
   | -------------- | -------------------------------------------------------------------------------------------------------------- |
   | `{{slug}}`     | the resolved slug                                                                                              |
   | `{{domain}}`   | `<domain>` input                                                                                               |
   | `{{datetime}}` | now (ISO 8601 UTC, e.g. `2026-06-02T07:00:00Z`)                                                                |
   | `{{source}}`   | `manual` (overridable in the future via an input — for now hardcoded since this skill is the canonical source) |
   | `{{title}}`    | `<title>` input verbatim                                                                                       |
   | `{{topic}}`    | `<topic>` input verbatim if set, else empty string                                                             |
   | `{{body}}`     | `<body>` input verbatim if set, else default placeholder: "Append observations as they come up."               |

4. **Inject `project:` field** when the `project` input is set. The template doesn't include `project:` by default — inserting it after `private:` (alphabetical-ish order, but more importantly after the shared archetype fields) so the file is readable. Use a single-line `project: <id>` insertion via the Edit tool's surgical-replace pattern: locate `private: false\n` and replace with `private: false\nproject: <id>\n`.

   If `project` is not set, skip — the resulting file has no `project:` field (notes are domain-scoped by default).

5. **Inject `tags:` array** when the `tags` input is set + non-empty. Template starts with `tags: []`. Replace with `tags: [<tag1>, <tag2>, ...]` (single-line JSON-array form, per `archetype-note.md`'s convention).

6. **Write the file** via the Write tool. Parent directories should already exist (`vault/wiki/<domain>/note/` is a convention every domain that owns notes follows). If the directory doesn't exist, create it.

7. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action add-note \
     --skill meta-add-note \
     --args '{"slug":"<slug>","domain":"<domain>","project":<json-string-or-null>,"topic":<json-string-or-null>}' \
     --files-touched '["vault/wiki/<domain>/note/<slug>.md"]' \
     --exit-status 0
   ```

8. **Report to the user** with a tight summary:

   ```
   ✓ Note scaffolded — <slug>
     path:     vault/wiki/<domain>/note/<slug>.md
     domain:   <domain>
     project:  <id-or-—>
     topic:    <topic-or-—>
     tags:     <comma-list-or-—>
     next:     edit the body in the dashboard's Vault view OR your $EDITOR.
   ```

## Inputs schema notes

- `slug`: the auto-derivation handles typical title shapes (`Mull dogfooding friction → mull-dogfooding-friction`). For titles with special chars (`@`, `&`, emoji), the result may be ugly — pass `slug:` explicitly.
- `project`: project entries can live under any domain. The validation checks the **manifest** for any entry with `type: project` matching the id — domain mismatch between note + project is allowed (e.g. a project under `development` can own notes under `meta`).
- `topic`: free-form string, no validation. Future Notes tab UI may filter by topic.

## Outputs

- `vault/wiki/<domain>/note/<slug>.md` — the new note entry
- One row in `events.db` (kind: dashboard, action: add-note, source: skill)

## What this skill must NOT do

- **Append to existing notes.** This skill creates new entries only. To append to an existing note, edit the file directly.
- **Touch other entries.** No backlink updates, no project frontmatter mutations. The optional `project:` field is the only cross-entry reference written.
- **Run any analysis.** This is a pure scaffold — no LLM thinking required beyond input validation + template substitution. Should complete in <5 seconds.

## Errors

- `domain "<value>" does not exist — run /os add-domain <value> first` — domain validation.
- `slug "<value>" does not match ^[a-z0-9][a-z0-9-]*$` — invalid slug override.
- `project "<id>" not found in vault` — project reference doesn't resolve in the manifest.
- `A note already exists at vault/wiki/<domain>/note/<slug>.md` — collision; choose a different slug.
- `title is required and must be non-empty` — empty title.

## See also

- [[archetype-note]] — full note archetype reference
- [[meta-add-research-note]] — sibling skill for research-report `notes_log` entries (different surface)
- [[meta-add-project]] — sibling scaffolder pattern
- `_templates/wiki-entry/note.md.tmpl` — the template this skill reads
