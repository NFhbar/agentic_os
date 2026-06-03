---
name: dev-add-change
description: 'Scaffold a code change — single-repo, single-PR unit of work. Tracks intent, branch, status. Optionally part of a larger project.'
user-invocable: true
version: 1
domain: development
tags: [scaffold, change, code]
inputs:
  name:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change slug (lowercase kebab-case, becomes the file + id; commonly mirrors the branch name)'
  title:
    type: string
    required: true
    description: 'Short title (e.g. "Add search debounce", "Bump biome to v2")'
  domain:
    type: string
    required: true
    description: 'Owning domain (must already exist as a folder under domains/; usually `development`)'
  repo:
    type: string
    required: true
    description: 'Entity id of an ingested repo (must exist with kind=repo). Use /os ingest repo first if needed.'
  type:
    type: string
    required: false
    enum: [feat, fix, docs, style, refactor, test, chore]
    description: 'STRICT ENUM: semantic-release branch + commit type. One of `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore` — no other values. Determines branch prefix AND the primary commit''s `<type>` per [[standard-git-hygiene]] §3-4. If absent, the skill infers from the title (Add LICENSE → docs, Fix X → fix, Add feature Y → feat, otherwise chore).'
  issue_number:
    type: string
    required: false
    pattern: '^[0-9]+$'
    description: 'Optional issue/ticket number (digits only). When set, the computed branch uses the three-part shape `<type>/#<issue>/<name>` per [[standard-git-hygiene]] §3.'
  branch:
    type: string
    required: false
    description: 'Explicit branch name override. When provided, used verbatim and short-circuits the type/issue_number-based computation. Otherwise the branch is computed as `<type>/<name>` (or `<type>/#<issue>/<name>` when issue_number is set), with `type` resolved from inputs.type or inferred from the title. Repo-specific overrides in the entity entry''s `## Conventions` win.'
  size:
    type: string
    required: false
    enum: [small, medium, large, s, m, l]
    description: 'One of `small` / `medium` / `large` (canonical on-disk form) OR their short aliases `s` / `m` / `l` (ergonomic CLI form). Short forms are normalized to the long form before writing frontmatter, so the vault always stores the canonical value. Informational; informs depth of analysis in downstream skills.'
  project:
    type: string
    required: false
    description: 'Optional project id this change belongs to (must exist as a `type: project` entry). When set, the change appears under the project''s owned-changes section.'
  review_required:
    type: boolean
    required: false
    default: true
    description: 'Whether this change must pass `dev-review-change` before `dev-write-change` executes. Default true. Set false for trivial changes (dep bumps, typo fixes, version constant updates). When false, the entry is scaffolded with review_status=not-required and the writer skips the review gate.'
  description:
    type: string
    required: false
    description: 'Optional free-form context: motivation, constraints, files involved, edge cases. Used by the auto-draft step (procedure step 9.5) to seed the change body. The shorter the title, the more useful this is. When provided, the scaffolder drafts a first-pass `## Why`, `## Approach`, `## Done when` (each prefixed with a `> **DRAFT**` blockquote that the human must remove before invoking dev-write-change).'
outputs:
  - kind: file
    path: vault/wiki/{{input.domain}}/change/{{input.name}}.md
spawns: []
---

# dev-add-change

## Purpose

Create a `change` archetype entry — the atomic unit of code work in the OS. A change is **single-repo, single-PR**: one branch, one merge. When work spans multiple repos, create a project and scaffold one change per repo, each linking to the project via the `project:` field.

This skill scaffolds the tracking entry. Future skills (`dev-write-change`, `dev-open-pr`, `dev-close-change`) consume it to actually do/manage the work.

## Procedure

1. Validate `inputs.name` against `^[a-z0-9][a-z0-9-]*$`. Reject if invalid.
2. Confirm `domains/<input.domain>/` exists. If not, reject and suggest `/os add-domain` first.
3. Verify the **repo** entity exists at `vault/wiki/<input.domain>/entity/<input.repo>.md` AND has `kind: repo` in its frontmatter. If not, reject with: "repo `<repo>` not found or not a kind=repo entity — ingest it first via `/os ingest repo <source>`."
4. If `inputs.project` is provided: verify the project entity exists at `vault/wiki/*/project/<input.project>.md` with `type: project`. If not, reject with hint to `/os add-project <id>` first.
5. Target path: `vault/wiki/<input.domain>/change/<input.name>.md`. If it exists, abort with "change `<name>` already exists" (do not overwrite — changes are deliberate).
6. **Compute `branch`** per [[standard-git-hygiene]] §3:
   - **If `inputs.branch` is provided** (explicit override): use it verbatim, skip the rest of this step.
   - **Otherwise**:
     1. Resolve `type`:
        - If `inputs.type` is provided: validate it is exactly one of `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore` (reject with "invalid type: must be feat|fix|docs|style|refactor|test|chore" otherwise). Use it.
        - If `inputs.type` is absent: infer from `inputs.title` via keywords (case-insensitive substring match, first match wins):
          | title contains | inferred type |
          | ----------------------------------------------------------------- | ------------- |
          | `fix`, `bug`, `regression`, `hotfix`, `patch` | `fix` |
          | `add license`, `license`, `readme`, `docs`, `documentation`, `changelog` | `docs` |
          | `refactor`, `restructure`, `rewrite`, `cleanup`, `simplify` | `refactor` |
          | `test`, `tests`, `spec` | `test` |
          | `format`, `style`, `lint`, `prettier`, `whitespace` | `style` |
          | `bump`, `upgrade`, `dep`, `dependency`, `ci`, `workflow`, `chore` | `chore` |
          | `add`, `new`, `introduce`, `feature`, `support` | `feat` |
          | (no match) | `chore` |
     2. Resolve issue suffix: if `inputs.issue_number` is provided → `#<issue_number>` segment; otherwise empty.
     3. Assemble: `<type>/<input.name>` (no issue) or `<type>/#<issue>/<input.name>` (with issue).
   - **Examples**:
     - inputs `{name: add-license, title: "Add MIT LICENSE"}` → inferred type `docs` → branch `docs/add-license`
     - inputs `{name: retry-backoff, type: feat, issue_number: 1234}` → branch `feat/#1234/retry-backoff`
     - inputs `{name: typo-fix, type: fix}` → branch `fix/typo-fix`
     - inputs `{name: bump-eslint, title: "Bump eslint to v9"}` → inferred type `chore` → branch `chore/bump-eslint`
   - **Repo overrides win**: if the repo entity's `## Conventions` section specifies a different shape (e.g. `JIRA-<id>-<slug>`), surface that to the user and follow it instead. Don't silently override per the universal default.
7. **MANDATORY:** Invoke the `Read` tool on `_templates/wiki-entry/change.md.tmpl` right now. Do NOT compose the output from memory or training data — the template may have been edited and your context may be stale. If you skip this step you will silently produce drift; the `change-frontmatter-stale-comments` audit check will catch it but the artifact will be polluted. Use Read.
8. Substitute Mustache placeholders:
   - `{{slug}}` → input.name
   - `{{domain}}` → input.domain
   - `{{title}}` → input.title
   - `{{repo}}` → input.repo
   - `{{branch}}` → the computed branch
   - `{{source}}` → "manual"
   - `{{datetime}}` → current ISO 8601 UTC
9. After substitution, **uncomment** optional fields based on inputs:
   - If `inputs.size` is set: accept either the long form (`small` / `medium` / `large`) OR the short form (`s` / `m` / `l`) — normalize short to long before populating (`s` → `small`, `m` → `medium`, `l` → `large`). Reject anything else with "invalid size: must be small | medium | large (short forms s/m/l also accepted)". Uncomment + populate `size:` with the normalized long form so on-disk frontmatter stays canonical.
   - If `inputs.project` is set: uncomment + populate `project:`
   - `scope`, `pr_url`, `parent_change` stay commented — user fills in later
   - **Review gate**: the template ships with `review_required: true` and `review_status: pending` uncommented. If `inputs.review_required == false`: set `review_required: false` AND `review_status: not-required` (so `dev-write-change` skips the review gate on first invocation).
     9.5. **Auto-draft body sections** (NEW):

   Decide whether to draft:
   - **DRAFT** if `inputs.description` is provided
   - **DRAFT** if the title is specific enough that Why/Approach/Done-when can be reasonably derived from title + repo entity context alone (judgment call — e.g., `Add MIT LICENSE` against a repo flagged `license: unknown` is draftable; `Fix bug` or `Update deps` is not)
   - **SKIP** otherwise — leave the template's placeholder text intact so the body-completeness gate fires later and prompts the human to fill in

   If drafting:
   - Read the repo's entity entry at `vault/wiki/<input.domain>/entity/<input.repo>.md` (use the Read tool; do not compose from memory)
   - Compose three sections from: title + (inputs.description if present) + entity frontmatter (especially flagged issues like `license: unknown`) + entity body
   - **Each section MUST start with a DRAFT marker blockquote**, formatted exactly:

     ```
     ## Why
     > **DRAFT** — review and refine before invoking dev-write-change.

     <drafted content here>

     ## Approach
     > **DRAFT** — review and refine before invoking dev-write-change.

     <drafted content here>

     ## Done when
     > **DRAFT** — review and refine before invoking dev-write-change.

     - [ ] <drafted item 1>
     - [ ] <drafted item 2>
     ```

   - Replace the template's placeholder body sections (`## Why`, `## Approach`, `## Done when`) with the drafted content. Leave the `## Notes` section intact.
   - The DRAFT markers are load-bearing — both the `dev-write-change` PLAN gate and the `change-body-template-placeholder` audit refuse to proceed while they're present. The human's review-and-accept step (Step 3 of the workflow) is to remove the `> **DRAFT**` blockquote lines, edit content if needed, then save.

   If skipping the draft: leave template placeholder text intact and proceed to step 10.

10. Write the rendered content via the Write tool.
11. Record the audit event via the dual-write wrapper:
    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-change \
      --skill dev-add-change \
      --args '{"name":"<name>","repo":"<repo>","project":"<project|null>"}' \
      --files-touched '["vault/wiki/<domain>/change/<name>.md"]'
    ```
12. Print a short confirmation:
    ```
    ✓ Change created: <title>
      slug:    <name>
      repo:    <repo>
      branch:  <branch>
      status:  planning
      project: <project or "(standalone)">
      entry:   vault/wiki/<domain>/change/<name>.md
    ```

## Outputs

- New `change` archetype entry at `vault/wiki/<domain>/change/<name>.md`
- Audit log line

## Errors

- Invalid name pattern → reject with the pattern shown
- Domain folder missing → suggest `/os add-domain <domain>` first
- Repo entity missing or not `kind: repo` → reject; suggest `/os ingest repo <source>` first
- Project specified but missing → reject; suggest `/os add-project <id>` first
- Change slug already exists → reject; pick a different `name` or rename existing via `/os rename`

## See also

- [[standard-change-workflow]] — canonical change workflow standard
- [[archetype-change]] — the underlying archetype
- [[dev-ingest-repo]] — produces the repo entity that a change references
- [[meta-add-project]] — projects own changes (when scope is bigger than one repo)
- `dev-pr-review` — reviews the PR a change produces (future composition: takes change id, reads `pr_url`)
