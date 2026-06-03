---
id: standard-template-syntax
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, template]
source: manual
private: false
title: Template placeholder syntax
url: internal://standard/template-syntax
kind: doc
last_verified: 2026-05-19
---

# Template placeholder syntax

## What it is

Templates in `_templates/` use Mustache-style `{{var}}` placeholders. Scaffolder skills (`meta-add-*`) read templates, substitute placeholders, and write the rendered output.

## Standard variables

| placeholder        | meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `{{name}}`         | machine name (kebab-case identifier)                          |
| `{{display_name}}` | human-readable name (e.g. "Personal Operations")              |
| `{{purpose}}`      | one-paragraph purpose statement                               |
| `{{description}}`  | one-line description                                          |
| `{{domain}}`       | domain name (or domain path for sub-domains)                  |
| `{{app_name}}`     | app name (kebab-case)                                         |
| `{{datetime}}`     | current ISO 8601 UTC timestamp                                |
| `{{date}}`         | current date YYYY-MM-DD                                       |
| `{{uuid}}`         | freshly generated UUID                                        |
| `{{slug}}`         | kebab-case slug derived from title                            |
| `{{source}}`       | provenance pointer for wiki entries                           |
| `{{title}}`        | human-readable title                                          |
| `{{body}}`         | body content (for note entries)                               |
| `{{kind}}`         | sub-type indicator (e.g. for entity, reference)               |
| `{{trigger}}`      | runbook trigger phrase                                        |
| `{{owner}}`        | runbook owner (entity id)                                     |
| `{{url}}`          | URL for reference entries                                     |
| `{{deadline}}`     | project deadline date                                         |
| `{{fields}}`       | for archetype templates: object of required field definitions |

Skill-specific placeholders may be defined by the scaffolder that uses them.

## What v1 templates do NOT support

- Loops
- Conditionals
- Computed values (math, transforms)

When a scaffolder needs computation (e.g. picking an unused port), it does that in its own code (the skill body), not in the template.

## Rationale

- Mustache is the simplest substitution syntax that doesn't require a library
- Limiting v1 to variable-substitution-only keeps templates inspectable and predictable
- Anything more complex belongs in the scaffolder skill, where the AI can reason

## Related

[[standard-skill-format]] (scaffolder skills)
