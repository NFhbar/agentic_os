---
id: decision-react-markdown
type: decision
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [dashboard, markdown, rendering]
source: manual
private: false
project: build-agentic-os-v1
title: Use react-markdown + remark-gfm for content rendering
status: accepted
alternatives:
  [
    "Raw <pre> (no rendering)",
    "react-markdown + remark-gfm (chosen)",
    "marked + dangerouslySetInnerHTML",
    "Custom regex renderer",
    "MDX",
  ]
---

# Use react-markdown + remark-gfm for content rendering

## Context

The dashboard's primary job is reading markdown — playbooks, skills, wiki entries, the standards. v1.5 rendered everything as plain `<pre>` blocks, which made markdown semantically inert (headings looked the same as paragraphs, tables were unaligned monospace, `[[wikilinks]]` were just text). We needed proper rendering.

## Options considered

- **Raw `<pre>`** — what we had. Zero deps but bad UX for a dashboard whose job is reading.
- **react-markdown + remark-gfm** — React-native, supports GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks), custom component renderers. Chosen.
- **marked + `dangerouslySetInnerHTML`** — fastest, but XSS risk on user-controlled content + no React component customization.
- **Custom regex renderer** — full control, but reimplements heading/list/table/code-fence parsing — high maintenance cost.
- **MDX** — markdown + JSX inline. Overkill; we don't need executable markdown.

## Decision

`react-markdown@^9` with `remark-gfm`. Render only the body (frontmatter is split out and shown in a collapsible `<details>` block). Custom `<a>` component renderer intercepts `wiki://` hrefs (preprocessed from `[[wikilinks]]`) and routes them through `NavigationContext`.

## Rationale

- **React component renderers** let us turn wikilinks into navigation triggers without leaving the React tree.
- **GFM** matches the markdown style our docs already use (tables in standards entries, code fences in playbooks).
- **Safe by default** — react-markdown sanitizes; no `dangerouslySetInnerHTML`.
- **Tree-shakeable** — only loads what we use.

## Consequences

- Bundle weight: dashboard JS grew from ~163 KB to ~322 KB (gzipped 51 → 100 KB). Acceptable for a dashboard that lives on `localhost`. Would matter more for a public web app.
- Wikilinks now feel like a knowledge-graph navigation (clickable, distinct visual style) — a UX qualitative leap.
- Every component that needs to render markdown (`EditableMarkdown` is the canonical user) gets the same look — code blocks, tables, headings, blockquotes all styled consistently via `.rendered .prose` CSS.
- Custom CSS in `styles.css` styles `.rendered`'s output to match the dashboard theme (dark + light schemes).

## References

- [[standard-dashboard-patterns]] — where the renderer lives (EditableMarkdown)
- `domains/meta/app/src/components/EditableMarkdown.tsx` — the preprocessing + custom `<a>` renderer
