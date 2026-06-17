---
name: meta-add-entity
description: Scaffold a non-repo entity (person / system / other / project) as a graph node wikilink references can resolve to
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [scaffold, evolution, entity]
inputs:
  name:
    type: string
    required: true
    description: Human-readable entity name (e.g. "Micah Fivecoate", "Postgres"). The kebab `id` is derived from this unless `slug` overrides it.
  kind:
    type: string
    required: false
    default: person
    description: 'Entity kind: `person`, `system`, `other`, or `project`. `repo` is rejected — repo entities are created exclusively by dev-ingest-repo.'
  domain:
    type: string
    required: false
    default: development
    description: Owning domain (must already exist as a folder under domains/). The entity file lands at vault/wiki/<domain>/entity/<id>.md.
  slug:
    type: string
    required: false
    description: Explicit kebab-case id override (`^[a-z0-9][a-z0-9-]*$`). Use when the name doesn't derive a clean id (punctuation, unicode).
  description:
    type: string
    required: false
    description: One-paragraph description; fills the entry's `## Context` body when provided.
outputs:
  - kind: file
    path: vault/wiki/{{input.domain}}/entity/<derived-id>.md
    description: 'The id is `slug || kebab-case(name)` (see step 2) — when `slug` is omitted the file lands at the kebab-derived id, not a literal `{{input.slug}}`.'
---

# meta-add-entity

## Purpose

Create a **non-repo** `entity` archetype entry — the graph node that entity-id wikilink references point at. The [[archetype-entity]] supports `kind: person | project | repo | system | other`, but the only path to create one was [[dev-ingest-repo]], which makes `kind: repo` entities exclusively. This skill fills the gap for the other kinds, so a reference like a project stakeholder can resolve to a real entry instead of dangling.

`repo` entities stay with [[dev-ingest-repo]] — it does repo-specific work (clone, analyze, build/test fields) that doesn't belong here. This skill covers the non-repo kinds the archetype already defines.

## Procedure

1. **Resolve + validate `kind`.** Accept one of `person`, `system`, `other`, `project`. If `inputs.kind` is `repo`, reject:

   ```
   ✗ kind: repo is not supported by meta-add-entity.
     Repo entities are created by dev-ingest-repo (clone + analyze + build/test fields).
     Run: /os ingest repo <url-or-path>
   ```

   Any other unrecognized value → reject listing the four allowed kinds.

2. **Derive the `id`.** `id = inputs.slug || kebab-case(inputs.name)` (lowercase, spaces/punctuation → single hyphens, strip leading/trailing hyphens). Validate against `^[a-z0-9][a-z0-9-]*$`. If the derived id is empty or invalid (name was all punctuation/unicode), reject with a hint to pass an explicit `slug`:

   ```
   ✗ Could not derive a valid kebab id from "<name>".
     Pass an explicit slug: /os add-entity name="<name>" slug="<your-kebab-id>"
   ```

3. **Confirm the domain exists.** `domains/<inputs.domain>/` must exist. If not, reject and suggest `/os add-domain <domain>` first.

4. **Idempotency — global id check.** Entity ids resolve as a flat, domain-agnostic set (the wikilinks test resolves them globally), so a domain-scoped path check alone would let the same id be minted in a second domain. Load `vault/.index/manifest.json` and scan `entries` for any entry with `type: entity` whose `id` equals the derived id. On a hit, report the existing entry and **exit 0** (idempotent — not an error):

   ```
   ↻ Entity `<id>` already exists — nothing to do.
     path:   <existing entry's path>
     domain: <existing entry's domain>
     kind:   <existing entry's kind, if available>
   ```

   This is intentionally stricter than [[meta-add-project]] step 4's domain-scoped path check, because entity ids are a flat global set. See Errors for why.

5. **Render the template.** Read `_templates/wiki-entry/entity.md.tmpl` and substitute:
   - `{{slug}}` → derived id
   - `{{domain}}` → inputs.domain
   - `{{datetime}}` → current ISO 8601 UTC
   - `{{source}}` → `manual`
   - `{{name}}` → inputs.name
   - `{{kind}}` → resolved kind

   When `inputs.description` is provided, replace the placeholder line _under_ `## Context` with the description text (leave the `## Context` heading itself in place). Leave `## Notable details` and `## Links` as the template ships them (the operator fills these in later).

6. **Write the file** to `vault/wiki/<inputs.domain>/entity/<id>.md` via the Write tool. The PostToolUse `rebuild-vault-index.sh` hook refreshes the manifest so the new entity resolves immediately.

7. **Record the audit event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action add-entity \
     --skill meta-add-entity \
     --args '{"id":"<id>","kind":"<kind>","domain":"<domain>"}' \
     --files-touched '["vault/wiki/<domain>/entity/<id>.md"]'
   ```

8. **Print a short confirmation:**

   ```
   ✓ Entity created: <name>
     id:     <id>
     kind:   <kind>
     domain: <domain>
     entry:  vault/wiki/<domain>/entity/<id>.md
   ```

## Outputs

- New non-repo `entity` archetype entry at `vault/wiki/<domain>/entity/<id>.md`
- Audit log entry

## Errors

- `kind: repo` → reject; direct to `dev-ingest-repo`
- `kind` not in `{person, system, other, project}` → reject listing allowed kinds
- Derived id invalid (name un-kebab-able) → reject; suggest passing an explicit `slug`
- Domain folder missing → suggest `/os add-domain <domain>` first
- Entity id already exists anywhere in the vault → idempotent stop (exit 0), not an error. The check is **global** (not domain-scoped) because entity ids are a flat set the wikilinks test resolves across all domains; minting the same id in two domains would produce two entries that collide on id.

## See also

- [[archetype-entity]] — the entity archetype contract (`kind` enum + shared frontmatter)
- [[dev-ingest-repo]] — the sole creator of `kind: repo` entities (no overlap with this skill)
- [[meta-add-project]] — references entities as `[[entity-id]]` stakeholders; resolves them against the manifest and falls back to a plain string on a miss
- [[meta-add-domain]] — the domain that must exist before an entity can be scoped to it
