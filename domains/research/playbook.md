---
domain: research
version: 1
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
---

# Research

## Purpose

Reading, synthesis, decision-capture. Where articles, papers, talks, threads, and conversations get distilled into durable knowledge. Conclusions that emerge here often inform action in `development/` or other domains.

## Entities

- `reference` — articles, papers, talks, threads, docs, dashboards
- `decision` — well-considered choices that emerged from reading
- `project` — ongoing research threads (e.g. "investigating multi-agent patterns")
- `entity` — domain experts, trusted sources (kind: `person`)
- `note` — half-formed ideas, observations, open questions

## Skills

- `research-write` — author a research-report under a project (graduated from `meta-research-project`)
- `research-review` — read-only peer-review of a research-report; writes verdict + flips `review_status`
- `research-revise` — fold review findings into a research-report; bumps `report_revision`; preserves prior `review_status`
- `research-update` — delta-driven rewrite when new materials land / milestones fire / changes merge; appends `## Update N` block; may reset `review_status` when the update is substantive
- `research-scaffold-recommendations` — materialize approved `recommended_changes[]` into `change` entries via `dev-add-change`; writes back the new slug + flips `status: scaffolded` per row; mirrors `meta-scaffold-project-plan` for the research surface

Additional research skills can be added via `meta-add-skill --domain research` as the lifecycle evolves.

## Apps

(none yet)

## Sub-domains

(none yet)

## Conventions

- Wiki entries: `vault/wiki/research/<archetype>/<slug>.md`
- Outputs: `vault/output/research/<kind>/<slug>.md` (synthesis reports, decision docs)
- Skills prefixed with `research-`
- Sources that justify a `decision` should be linked from it via `[[reference-...]]`
- A `project` archetype entry is the right container for an ongoing thread — its body links out to references and notes as they accumulate

## Cross-domain links

- Research decisions often affect `development/` — create a `decision` entry here, mirror with a `reference` link from the dev side
- Reading that doesn't fit a specific other domain lands here by default; can be moved later

## How research feeds changes

Research isn't a dead end — it's the _upstream_ of change decisions. The canonical flow:

1. **Open question or hypothesis** → scaffold a `project` (`/os add-project`, `domain: research`) to hold the thread.
2. **Reading + synthesis** → accumulate `reference`, `note`, and `decision` archetype entries under that project. Future `research-*` skills (synthesize, capture-decision, from-url) will drive this loop.
3. **Recommendation surfaces** → write a final `decision` entry (or a structured wiki note) that says "based on the reading, do X" or "the right approach for the next change is Y."
4. **Hand off to development** → scaffold a `change` (`/os add-change`, `domain: development`) and link the research decision in the change's body via `[[<decision-id>]]`. The change's PLAN phase reads the linked decisions as authoritative context.

This is the OS's answer to "where does the design thinking happen before the code is written." Research projects can run for weeks; the change they spawn captures one concrete unit of work the research recommended.

The audit trail goes both ways: the development change links back to the research that informed it; the research project's owned-changes list shows the work that resulted.
