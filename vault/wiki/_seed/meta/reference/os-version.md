---
id: os-version
type: reference
domain: meta
created: 2026-06-03T18:00:00Z
updated: 2026-06-07T14:30:00Z
tags: [version, distribution, compatibility]
source: seed
private: false
title: OS version — canonical version marker for compatibility tracking
url: internal://reference/os-version
kind: reference
last_verified: 2026-06-07
version: 0.4.0
---

# OS version

This entry is the **single source of truth for what version of the Agentic OS is shipping**. The `version:` field in the frontmatter is the canonical value; everything else in the file describes how versioning works.

Current version: **0.4.0** (Settings app + effort propagation).

## Versioning policy

The OS uses loose semver:

- **Patch** (`0.2.0 → 0.2.1`) — bug fixes, doc updates, small UX polish. Pull and go; no migration work.
- **Minor** (`0.2.0 → 0.3.0`) — new features (skills, archetypes, dashboard surfaces). Pull and go; per-team opt-in for features that change behavior; no required migration.
- **Major** (`0.2.0 → 1.0.0`) — breaking changes that require teams to take action (e.g., schema migration in events.db, deprecated skills being removed). Avoided when possible; CHANGELOG explicitly documents required actions.

## How teams pin

Teams that need a specific version pin via git:

```bash
git checkout v0.2.0       # pin to tag (when tags exist)
# OR
git checkout <sha>        # pin to specific commit
```

For loose tracking, teams stay on their fork's `main` branch and pull periodically. The CHANGELOG.md documents what changed between versions; CONTRIBUTING.md § Upgrading covers merge-conflict resolution patterns.

## Where the version appears

The version lives **only here** as a structured field. The CHANGELOG references this entry; install.sh stamps it into `.claude/state/installed-at` (alongside the install timestamp) so the dashboard can display "this install is on v0.2.0, last installed 2026-06-03." When the OS bumps version, this file's frontmatter is the single edit; everywhere else reads from it.

For machine-readable access from skills or apps:

```bash
# CLI
grep '^version:' vault/wiki/_seed/meta/reference/os-version.md | awk '{print $2}'

# Manifest query (via vault MCP or similar)
{
  "type": "reference",
  "id": "os-version"
}
# → fm.version
```

## Why not in package.json

`package.json` carries `version: "0.1.0"` for the root npm tooling (Prettier + vitest). That's the version of the OS's _npm tooling layer_, not the OS itself. Teams may add or change their npm tooling versions independently of the OS version. Keeping the two separate avoids the confusion of "which version does this install actually run?"

## Compatibility contract

Within a major version, teams can pull updates with confidence that:

- No skill they were using has been removed (skills may be deprecated with a one-version warning before removal in the next major)
- No archetype field has changed shape (additive only)
- No event store schema migration is needed (additive only)
- No notification template variables have been removed
- Existing wiki entries continue to load and render

Across major versions, the CHANGELOG names exactly what changed and what teams need to do. Major-version bumps are rare and discussed in advance.

## See also

- [`CHANGELOG.md`](../../../../CHANGELOG.md) — what shipped in each version
- [`CONTRIBUTING.md § Upgrading`](../../../../CONTRIBUTING.md) — how to pull updates and resolve conflicts
- [[decision-distribution-v1-architecture]] — why the OS is shaped this way (the broader context for versioning)
