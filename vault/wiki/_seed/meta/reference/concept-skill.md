---
id: concept-skill
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [concept, core, plain-language]
source: manual
private: false
title: Skill
url: internal://concept/skill
kind: doc
last_verified: 2026-05-20
---

# Skill

## What it is

A **skill** is an invokable action — a markdown file that tells Claude how to do something. Every skill lives at `.claude/skills/<name>/SKILL.md` and has:

- **Frontmatter** — name, description, version, optional `inputs` schema, `user-invocable: true` for slash-command exposure
- **Body** — a numbered procedure Claude follows to execute the skill

The dashboard reads skill frontmatter to auto-generate forms (one input per declared field).

## When you use it

- You have a workflow you'll do more than twice and want to capture as reusable
- You want a UI form for an action (the dashboard renders forms from skill `inputs:` schemas automatically)
- You want consistent behavior — the same skill produces the same shape of output every time

If something is a one-off, just do it. If it's a recurring procedure, make it a skill.

## How to invoke

```
/os <intent>              # router maps your phrasing to a skill
/<skill-name>             # direct invocation (power-user escape hatch)
```

The router reads `OS.md`'s intent vocabulary table to find the right skill for your intent.

## Example

`meta-add-domain` is a skill. Its frontmatter declares 4 inputs (name, display_name, purpose, parent). Its body procedure tells Claude to validate inputs, render the template, write the playbook, update OS.md.

You invoke it via `/os add-domain` or via the dashboard's **+ New Domain** button (which uses the same frontmatter to generate a form).

## How to create one

```
/os add-skill
```

The form asks for name, domain, and description. `meta-add-skill` scaffolds the SKILL.md from a template and registers the skill in the domain's playbook.

## Related

- [[concept-router]] — how `/os` dispatches to skills
- [[concept-domain]] — every skill belongs to a domain
- [[standard-skill-format]] — the frontmatter contract
- [[standard-dashboard-patterns]] — how the dashboard renders skill forms
