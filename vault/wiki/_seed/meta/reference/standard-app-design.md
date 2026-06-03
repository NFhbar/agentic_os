---
id: standard-app-design
type: reference
domain: meta
created: 2026-05-22T02:16:32Z
updated: 2026-05-26T22:30:00Z
tags: [standard, app, design, ui, css, components, design-system]
source: manual
private: false
title: App design standard
url: internal://standard/app-design
kind: doc
last_verified: 2026-05-26
---

# App design standard

The OS-wide visual language. Codifies the CSS token system, component primitives, and page archetypes that every app (and the dashboard itself) uses. **One design system, no per-app variations.**

The source of truth lives at `domains/meta/app/src/shared/` — visual primitives ported from an earlier JSX prototype into TypeScript + ES modules.

> Goes with: [[standard-app-architecture]] (manifest + lifecycle), [[standard-app-persistence]] (data layers). Apps don't ship without conforming to all three.

## 1. Design tokens (CSS variables)

The complete token inventory is in `shared/theme.css`. Two themes are defined: `dark` (default) and `light`. The user toggles via the dashboard topbar; `data-theme="dark|light"` flips on `<html>`; apps respond automatically.

### Surfaces

```css
--bg              /* page background */
--bg-2            /* alternate row / sub-panel background */
--panel           /* card / surface background */
--panel-2         /* nested surface */
--panel-3         /* deeper nested surface */
--border          /* default border */
--border-strong   /* divider for visual heft */
--hover           /* hover overlay (translucent white in dark; black in light) */
--hover-strong
```

### Text

```css
--text            /* primary */
--text-2          /* secondary, slightly muted */
--muted           /* tertiary */
--subtle          /* fourth-level, hint text */
--faint           /* near-invisible markers */
```

### Accent

```css
--accent          /* SINGLE accent: electric blue (#3b82f6). Fixed. No per-app overrides. */
--accent-soft     /* translucent fill */
--accent-border   /* translucent border */
--accent-text     /* on-light-bg accent text */
```

Per [[standard-app-architecture]] § 6, accent is **not** user-customizable. The only theme toggle is light/dark.

### Semantic

```css
--success         /* green; emerald */
--success-soft
--success-text
--warning         /* amber */
--warning-soft
--warning-text
--danger          /* red */
--danger-soft
--danger-text
```

### Severity scheme (review/audit contexts)

```css
--severity-bug          /* maps to --danger */
--severity-bug-soft
--severity-nit          /* maps to --warning */
--severity-nit-soft
--severity-suggestion   /* maps to --accent */
--severity-suggestion-soft
--severity-info         /* maps to --muted */
--severity-info-soft
```

Severity scheme is **fixed** at the classic mapping (bug=danger, nit=warning, suggestion=accent). The prototype's tweakable schemes (`traffic`, `cool`, `mono`) are prototype-only and don't ship.

### Diff (code review contexts)

```css
--diff-add-bg          /* faint green tint behind added lines */
--diff-add-marker      /* the leading + bar */
--diff-remove-bg
--diff-remove-marker
```

### Type

```css
--font-sans   /* 'Geist', system fallbacks */
--font-mono   /* 'Geist Mono', SF Mono fallbacks */
```

Type sizes use a fixed scale (no token, just inline) to avoid token sprawl:

| use                  | size                                |
| -------------------- | ----------------------------------- |
| Page title (`<h1>`)  | 22-24px / 600 weight                |
| Section title (`h2`) | 16-17px / 600                       |
| Card title (`h3`)    | 13.5px / 500                        |
| Body                 | 13.5px / 400                        |
| Table / list row     | 13px / 400                          |
| Tiny / meta          | 11.5-12px / 400 (use `.tiny` class) |
| Code                 | 12-13px / `var(--font-mono)`        |

### Radii + shadow

```css
--radius-sm  6px        /* small badges, pills, chips */
--radius     8px        /* default — cards, panels */
--radius-lg  12px       /* hero, larger surfaces */
--radius-xl  16px       /* page-level wrappers */

--shadow-sm  /* drop shadow for tooltips, lifted chips */
--shadow     /* card lift on hover */
--shadow-lg  /* modal / dropdown */
```

### Sidebar

```css
--sidebar-w           232px
--sidebar-w-collapsed  56px
```

## 2. Component primitives

These live in `domains/meta/app/src/shared/`. Apps import from there; never inline a primitive's implementation.

### Icons (`shared/icons.tsx`)

- Lucide-style, hand-rolled SVG
- `viewBox="0 0 24 24"`, `strokeWidth=1.5`, `currentColor` stroke + fill
- Default size 16px; per-instance override via `size` prop
- Available set: `Home`, `Repo`, `Reviews`, `Settings`, `Plus`, `Search`, `Refresh`, `Trash`, `ArrowRight`, `ChevronRight/Down/Left`, `External`, `Play`, `Send`, `Check`, `X`, `Bug`, `Sparkles`, `GitPullRequest`, `GitBranch`, `GitCommit`, `Code`, `File`, `Folder`, `Database`, `Clock`, `Zap`, `AlertTriangle`, `Shield`, `Activity`, `PanelLeft`, `Filter`, `Bell`, `More`, `Star`, `Cpu`, `Eye`, `Copy`

Adding new icons: append to `shared/icons.tsx`; keep style consistent.

### Badges + pills (`shared/badges.tsx`)

- `StatusBadge` — `running` (accent + spinner dot), `completed`, `failed` (danger), `queued` (muted), plus app-specific extensions
- `ResultBadge` — `approve` (success + check), `changes` (warning + triangle), `block` (danger + X)
- `SeverityBadge` — `bug` / `nit` / `suggestion` / `info`; uses severity tokens
- `AgentChip` — letter-icon + label; agent-color background; used by review apps

### Severity bar (`shared/severity-bar.tsx`)

Horizontal stacked bar: bug / nit / suggestion proportional segments. Used in lists where space is tight.

### Code pane (`shared/code-pane.tsx`)

- File header with name + language
- Line numbers + +/- markers
- Per-line `kind`: `add` (green tint), `remove` (red tint), `highlight` (accent tint), `context` (no tint)
- Tiny tokenizer for syntax flavor (Go/TS/Python keywords + strings + comments)
- Used by review apps for diff hunks

### Charts (`shared/charts.tsx`)

- `Sparkline` — inline mini-line chart with gradient fill; takes `{ data: number[] }`
- `TrendChart` — bar chart with per-bar stacking (e.g. clean / nits / bugs); takes `{ data: { d, …keys }[] }`

Charts are pure SVG, no chart library. Keep them small and dependency-free.

### Form controls (`shared/controls.tsx`)

- `Switch` — segment-style toggle (`data-on` for state)
- `Button` — variants: `primary`, `ghost`, `danger`; sizes: default, `sm`
- `Input` — text field with `.input` class
- `Select` — native `<select>` styled

### Layout (`shared/layout.tsx`)

- `Card` — `.card` + `.card-header` + `.card-body`
- `Metric` — label, big value, optional delta, optional sparkline
- `Empty` — empty-state placeholder with icon + title + hint
- `Modal` — scrim + content + footer
- `Toast` — bottom-center floating message

### Utility helpers (`shared/utils.ts`)

- `hex2rgba(hex, alpha)` — for translucent variants of accent
- `cn(...classes)` — class-name concatenator
- (Future) `formatRelative`, `formatLocal` — time helpers (move from dashboard's existing `lib/time.ts`)

## 3. Page archetypes

Apps compose pages from these archetypes. Each is documented with reference markup in `shared/archetypes/`.

### Dashboard archetype

The "do action + see what happened" layout. Used as the landing tab of action-oriented apps.

```
┌─ HERO ────────────────────────────────────────────────────────────┐
│ Title + tagline                                                    │
│ Primary action form (input + submit button)                        │
│ Suggested-input chips                                              │
└────────────────────────────────────────────────────────────────────┘

┌─ METRIC STRIP (4 cards, equal width) ─────────────────────────────┐
│ [Metric] [Metric] [Metric] [Metric]                                │
└────────────────────────────────────────────────────────────────────┘

┌─ TREND CHART ──────────────┬─ TOP-N LIST ────────────────────────┐
│ Bar/line chart, 14-day      │ Top repos / top skills / etc.       │
│ Legend + tooltip            │ Click row → navigate                 │
└─────────────────────────────┴──────────────────────────────────────┘

┌─ RECENT ACTIVITY TABLE ───────────────────────────────────────────┐
│ Last N rows, click to open detail                                  │
└────────────────────────────────────────────────────────────────────┘
```

Ported from the earlier dashboard prototype. Drop-in template for any app that wants this layout.

### List archetype

The "scrollable rows + filters + bulk actions" layout.

```
┌─ HEADER ──────────────────────────────────────────────────────────┐
│ Title + count + bulk action button                                 │
└────────────────────────────────────────────────────────────────────┘

┌─ FILTERS / SEARCH ────────────────────────────────────────────────┐
│ Search input + filter chips                                        │
└────────────────────────────────────────────────────────────────────┘

┌─ TABLE ───────────────────────────────────────────────────────────┐
│ Header row                                                         │
│ Row 1 — click navigates to detail                                  │
│ Row 2                                                              │
│ ...                                                                │
└────────────────────────────────────────────────────────────────────┘
```

Reference: `pages/reviews.jsx` and `pages/repos.jsx` in the prototype.

### Detail archetype

The "rich single-record view with sub-sections + actions" layout. Used for reviews, plans, status reports, decisions.

```
┌─ BREADCRUMB + ACTION BAR ─────────────────────────────────────────┐
│ ← Back | <title>                              [Re-trigger] [Publish]│
└────────────────────────────────────────────────────────────────────┘

┌─ HEADER METADATA STRIP ───────────────────────────────────────────┐
│ Status badge | repo | branch | author | duration | started         │
└────────────────────────────────────────────────────────────────────┘

┌─ TL;DR / SUMMARY ─────────────────────────────────────────────────┐
│ One paragraph                                                      │
└────────────────────────────────────────────────────────────────────┘

┌─ STATS GRID ──────────────────────────────────────────────────────┐
│ [Metric] [Metric] [Metric] [Metric]                                │
└────────────────────────────────────────────────────────────────────┘

┌─ SECTIONS (each collapsible) ─────────────────────────────────────┐
│ Section title                                                      │
│   Code pane / list / sub-component                                 │
└────────────────────────────────────────────────────────────────────┘
```

Reference: `pages/review-detail.jsx` — the multi-pass-aware version is the most-developed example.

### Settings archetype

The "form rows grouped by section" layout. Used for app-level prefs, agent toggles, etc.

```
┌─ HEADER ──────────────────────────────────────────────────────────┐
│ Title + intro paragraph                                            │
└────────────────────────────────────────────────────────────────────┘

┌─ SECTION ─────────────────────────────────────────────────────────┐
│ Section title + description                                        │
│ ┌─ Row ──────────────────────────────────────────────────────────┐ │
│ │ Label + hint                            [Control]              │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌─ Row ──────────────────────────────────────────────────────────┐ │
│ │ Label + hint                            [Control]              │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

Reference: `pages/settings.jsx`.

## 4. Sub-navigation within an app

Per [[standard-app-architecture]] § 5, sub-nav is the app's responsibility — a **tab bar inside the app's content area**.

```css
.app-tabs {
  display: flex;
  gap: 4px;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--border);
}
.app-tab {
  padding: 8px 14px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  font-size: 13px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.app-tab[aria-selected="true"] {
  color: var(--text);
  background: var(--panel);
  border-color: var(--border);
}
```

Apps render their own tabs; the shell provides only the top sidebar. Apps without sub-pages skip the tab bar entirely.

## 5. Spacing + density

Fixed density. Not user-configurable.

| context                | rule                                            |
| ---------------------- | ----------------------------------------------- |
| Page wrapper           | 24px padding on all sides                       |
| Card                   | 16-18px padding inside; `var(--radius)` corners |
| Card header            | 12px vertical padding; border-bottom 1px        |
| Table cell             | 10-12px vertical, 14px horizontal               |
| Form row vertical gap  | 12-14px                                         |
| Inter-card gap (grids) | 14-18px                                         |
| Button height          | 28px (default), 24px (sm), 32px (large)         |

## 6. Translation table — prototype patterns → production

The prototype is `babel-standalone` + `window` globals + mock data. Production rules:

| prototype                                                            | production                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `babel-standalone` in `<script type="text/babel">`                   | Vite + TypeScript + ES modules. Source files are `.tsx`, compiled by the dashboard's build.                          |
| `window.MOCK`, `window.Icons`, `window.Sidebar`                      | Proper ES `export` / `import`. No `window` assignments.                                                              |
| Single `app.jsx` with `<App />` mounted to `#root`                   | App is a `manifest.ts` + `View.tsx` in `apps/<id>/`. The shell mounts the View.                                      |
| Local `Sidebar` component                                            | Drops. The dashboard's shell sidebar renders the sidebar entry from the manifest. Apps don't render their own.       |
| Local topbar (search, notifications, theme toggle)                   | Drops. Topbar is owned by the shell.                                                                                 |
| `TweaksPanel` (`tweaks-panel.jsx`) for live theme tweaks             | DROPS ENTIRELY. Production theme is global, dark/light only.                                                         |
| Mock progress simulation via `setInterval`                           | Real progress via SSE from the dashboard's `/api/action`. UI subscribes to the event stream.                         |
| Submitted PR URL → in-process review                                 | Submitted PR URL → POST to `/api/action` triggering `dev-pr-review` skill with `{ url, agents: [...] }` args.        |
| Inline `MOCK.reviews` as state                                       | Reviews loaded from app-DB at mount, refreshed via re-fetch button OR a scheduled background sync.                   |
| Inline `MOCK.repos` as state                                         | Repos loaded from `vault/wiki/development/entity/` via existing `/api/vault` endpoints.                              |
| Inline `MOCK.detail` (the full review)                               | Review markdown loaded from `vault/output/development/pr-review/<slug>-pass-<n>.md` via vault routes.                |
| `submitPR(url)` mutates state directly                               | `submitPR(url)` calls `/api/action` (or its app-specific equivalent). Server-side: spawn `claude -p`, stream events. |
| Severity color scheme variations (`classic`/`traffic`/`cool`/`mono`) | Fixed at `classic`. No alternatives ship.                                                                            |
| `user-customizable accent color`                                     | Drops. Accent is fixed (`#3b82f6`).                                                                                  |
| Inline SVG `<Icons.Bug />`                                           | Imported from `shared/icons`. Same shape, just modularized.                                                          |
| `hex2rgba` helper                                                    | Lives in `shared/utils.ts`. Imported.                                                                                |
| `hl()` syntax highlighter (in components.jsx)                        | Lives in `shared/code-highlight.ts`. Use it; don't reinvent.                                                         |

## 7. Accessibility floor (non-negotiable)

| concern                  | requirement                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Color contrast           | All text-on-surface combinations meet WCAG AA (4.5:1 for body, 3:1 for large). Verified for both dark + light themes. |
| Keyboard nav             | Every interactive element reachable via Tab. Visible focus ring (use the OS focus token).                             |
| Screen reader            | Every icon-only button has `aria-label`. Tables have `<th scope>`. Sections have proper heading hierarchy.            |
| `prefers-reduced-motion` | Sparkline animations, hover transitions, spinner dot — all respect the system pref.                                   |
| ARIA roles               | Tabs use `role="tablist"` / `role="tab"` / `aria-selected`. Modals use `role="dialog"` + `aria-modal="true"`.         |

## 8. What ships in `shared/`

The deliverable structure after Phase 1:

```
domains/meta/app/src/shared/
  theme.css                     ← all CSS variables, light + dark themes
  icons.tsx                     ← icon set
  badges.tsx                    ← StatusBadge / ResultBadge / SeverityBadge / AgentChip
  severity-bar.tsx
  code-pane.tsx                 ← CodePane + CodeLine + supporting types
  code-highlight.ts             ← syntax flavor tokenizer
  charts.tsx                    ← Sparkline + TrendChart
  controls.tsx                  ← Button + Switch + Input + Select
  layout.tsx                    ← Card + Metric + Empty + Modal + Toast
  archetypes/                   ← reference markup snippets, NOT runtime components
    dashboard.tsx               ← copy-this-then-customize template
    list.tsx
    detail.tsx
    settings.tsx
  utils.ts                      ← hex2rgba, cn, etc.
  index.ts                      ← barrel export
```

Apps import from `shared/`:

```typescript
import { Icons, StatusBadge, SeverityBar, Card, Metric } from '@/shared';
```

## 9. Audit hooks

| id                         | severity | what it enforces                                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `app-design-shared-import` | warn     | Apps import primitives from `@/shared` rather than reimplementing them inline                     |
| `app-design-css-variables` | warn     | Apps don't redeclare CSS variables from `shared/theme.css` (catches stray per-app `:root` blocks) |
| `app-design-tweaks-absent` | error    | No app ships a `TweaksPanel` or per-app theme override mechanism                                  |
| `app-design-icon-source`   | info     | Apps' icons are imported from `shared/icons` (catches stray inline SVG that should be lifted)     |

## 10. Future evolution

Locked for v1, revisitable in v2:

- Per-app accent override (currently forbidden)
- Density modes (compact / regular / comfy)
- Font-size override
- Severity color scheme alternatives
- Tab badges with semantic colors beyond accent
- Animations beyond hover/focus

When the user pressure-tests asks for any of these, write a `note-*` entry capturing the request first; ship only if the case is strong.

## 11. Stateful UI patterns (lifted from Research design prototype, 2026-05-26)

The Research design prototype at `vault/raw/research-domain-design-prototype/` formalized five patterns that previously existed informally or inconsistently across the dashboard. They are now canonical primitives.

### 11.1 Action banner with state-machine reducer

**Pattern.** Pages that drive a multi-step workflow (a change going through plan → review → revise → approve → execute, a research-report going through draft → reviewed → approved → updated, a project going through scaffolded → active → completed) MUST render a single, prominent **action banner** whose label, hint text, and primary action change based on the entry's current state. The banner's logic MUST live in a dedicated reducer function (`stateFor(entity)`) rather than inline if/else branches.

**Why.** Inline if/else cascades for state-banner logic get unwieldy fast (we hit 30+ lines on change-detail's banner by phase E of project-orchestration). A named reducer keeps the state-machine inspectable + diffable + testable.

**Canonical reducer shape:**

```ts
// Returns a discriminated string the renderer maps to a banner variant.
// Each branch checks the minimum frontmatter fields needed to commit to a state.
function stateFor(entity): EntityState {
  if (triggerActive) return 'update-trigger';        // overrides everything
  if (entity.status === 'draft' && entity.review_status === 'pending') return 'awaiting-review';
  if (entity.review_status === 'request-changes' && !revisedAfterReview) return 'pre-revise';
  if (entity.review_status === 'request-changes' && revisedAfterReview)  return 'post-revise';
  if (entity.review_status === 'approved' && hasUnscaffolded) return 'ready-to-scaffold';
  if (entity.review_status === 'approved') return 'approved-clean';
  return 'idle';
}
```

**Banner variants** (uniform across all apps):

| state                                               | tone    | primary action                 | secondary (ghost)    | hint                                                        |
| --------------------------------------------------- | ------- | ------------------------------ | -------------------- | ----------------------------------------------------------- |
| `awaiting-review`                                   | accent  | Review / kick off review skill | —                    | "<entity> drafted, awaiting review."                        |
| `pre-revise`                                        | warning | Revise                         | —                    | "Reviewer requested changes — N concerns, M nits."          |
| `post-revise`                                       | accent  | Re-review                      | Revise again (ghost) | "<entity> revised. Verdict below describes prior revision." |
| `ready-to-scaffold` (or equivalent terminal action) | success | Primary action                 | —                    | "Approved · N <thing>s ready."                              |
| `approved-clean`                                    | success | (none)                         | optional bg-action   | "Approved. Watching for triggers."                          |
| `update-trigger` (when applicable)                  | warning | Run update                     | Dismiss              | "Trigger: <label> — incorporate?"                           |

**Disable-while-dispatching:** every banner button MUST be `disabled` when any entity-scoped run is in flight (`useDispatch().runs.some(r => r.state in [queued, running] && r.<entity-id> === <id>)`). Primary label swaps to "Working…" while disabled. Tooltip explains the disable.

**Where it lives:** `shared/layout.tsx` exports `<ActionBanner tone icon title desc actions dispatching />`. Per-page reducer + renderer wiring stays in the page's View.tsx.

**Apply to:** change-detail (already done — `View.tsx` lines around 815-895), project-state-banner (already done — `ProjectStateBanner`), research-detail (Phase D will wire). Future apps: every workflow-driven detail page.

### 11.2 Multi-segment stacked-bar for count-by-category

**Pattern.** When a table cell needs to show counts across mutually-exclusive categories (e.g., recommended-changes by status: proposed/scaffolded/merged/abandoned), render a thin (5px) horizontal stacked-bar where each segment's width = `count/total` and color = category accent token. Below the bar, render a comma-separated text list of non-zero counts in the same color tokens.

**Why.** A row of badges takes 4× the horizontal space; a number alone hides the breakdown. The stacked-bar carries the shape at-a-glance.

**Canonical shape:**

```tsx
<div className="stacked-bar">
  <div className="bar-track">
    {merged > 0     && <i style={{ background: 'var(--success)',     width: `${(merged/total)*100}%` }} />}
    {scaffolded > 0 && <i style={{ background: 'var(--warning)',     width: `${(scaffolded/total)*100}%` }} />}
    {proposed > 0   && <i style={{ background: 'var(--accent)',      width: `${(proposed/total)*100}%` }} />}
    {abandoned > 0  && <i style={{ background: 'var(--muted)',       width: `${(abandoned/total)*100}%` }} />}
  </div>
  <div className="bar-legend tiny mono">
    <span>{total} total</span>
    {merged > 0     && <span style={{ color: 'var(--success-text)' }}>· {merged}m</span>}
    {scaffolded > 0 && <span style={{ color: 'var(--warning-text)' }}>· {scaffolded}s</span>}
    {proposed > 0   && <span style={{ color: 'var(--accent-text)' }}>· {proposed}p</span>}
    {abandoned > 0  && <span style={{ color: 'var(--subtle)' }}>· {abandoned}a</span>}
  </div>
</div>
```

**Where it lives:** `shared/severity-bar.tsx` becomes `shared/stacked-bars.tsx` — exports both `SeverityBar` (existing — bug/nit/suggestion/info) and `CountStackedBar` (new — generic count-by-category accepting `segments: Array<{ count, color, abbr }>`).

**Apply to:** Research list view's "Recommended changes" column (Phase D), Project page Changes tab counts column, Project rollup strip (currently text-only), PR Review's review-pass status counts.

### 11.3 Filter chips with count badges

**Pattern.** Above any list view (Changes, Projects, PR Reviews, Research-reports), render a row of filter chips. Each chip is a button showing label + a `<count>` badge. Active chip has `aria-pressed="true"`. The chip row ends with a `spacer` and optional search input + project/scope select. Click toggles the filter; multi-select chips OR; selectors AND.

**Why.** Today the dashboard uses dropdowns, plain text counts, or inline filter buttons inconsistently. Chips with counts surface scale at-a-glance and are trivially keyboard-navigable.

**Canonical shape:**

```tsx
<div className="chip-row">
  {filters.map(f => (
    <button
      key={f.id}
      className="chip"
      aria-pressed={current === f.id}
      onClick={() => setCurrent(f.id)}
    >
      {f.label} <span className="count">{f.count}</span>
    </button>
  ))}
  <span className="spacer" />
  {/* search / select on the right */}
</div>
```

**Where it lives:** chips are simple enough to live in pages directly; the `count` badge styling lives in `shared/badges.tsx` (extend `Badge` with a `count` variant — small, rounded, panel-2 bg, mono text).

**Apply to:** Changes list (already has chips — verify `count` variant adoption), Projects list (currently has no chips — add), Research list (Phase D will wire), PR Reviews list (currently has dropdown — convert).

### 11.4 Lifecycle stepper

**Pattern.** Multi-stage workflows render a horizontal stepper above the tab bar: connected dots, one per stage, with the current stage highlighted (hollow-accent ring + accent label) and done stages filled (success-token + check icon). Skipped stages render as struck-through label + grayed dot. Terminal states (completed, abandoned) fill every dot.

**Why.** Steppers give a permanent "where am I in the pipeline" cue that's hard to convey in any other UI primitive. Used today on change-detail (`LifecycleStepper`) and project-detail (`ProjectPhaseTimeline`); pattern is consistent across both.

**Canonical shape:** see `domains/meta/app/src/apps/changes/View.tsx::LifecycleStepper` and `apps/projects/View.tsx::ProjectPhaseTimeline`. The two implementations share visual treatment but compute current-index differently per their archetype. Future apps with a workflow can mirror either.

**Where it lives:** `shared/stepper.tsx` (new file) — exports `<Stepper steps={[{id, label, status, at?, hint?}]} onStepClick? />`. Status values: `done | current | pending | skipped`. Click optionally jumps to the matching tab.

**Apply to:** Research detail (Phase D will wire — 4 stages: Drafted → Reviewed → Approved → Updated×N). Future apps with multi-stage workflows.

### 11.5 Decorated markdown rendering for `## Update N` blocks

**Pattern.** Markdown renderers MAY decorate specific `## Update N` heading patterns with a visual divider + badge. Used when a single document carries an update log (research-reports, change frontmatter notes, project decision entries). The decoration: hr / `<Sparkles>` badge / hr around the heading. Body renders normally.

**Why.** Long-lived documents that accumulate `## Update N` sections become hard to scan. The decoration creates a visual anchor without forcing a separate tab or section.

**Canonical shape:** see `vault/raw/research-domain-design-prototype/components.jsx::MarkdownBlock` for the reference. Split on `^## Update N` lines, render each chunk separately with the divider between.

**Where it lives:** `shared/markdown.tsx` (new file) — exports `<MarkdownBlock text decorate?={'updates'|null} />`. Default `decorate=null` matches existing `Rendered` behavior; `decorate='updates'` triggers the Update-block decoration.

**Apply to:** Research report tab (Phase D), any future archetype that supports `## Update N` log sections (likely: decision entries, status reports).

### 11.6 Dispatch modal pattern

**Pattern.** Modals that dispatch a skill (research-update, future non-form dispatches) compose around a shared `<DispatchModal>` so the UX stays consistent: trigger-source pill, optional auto-diff, additional-context textarea, confirm + cancel.

Required fields:

- **Trigger source** (read-only label: "manual", "new-materials-ingested", "milestone-reached", etc.)
- **Auto-detected diff** when applicable (e.g. list of new materials since last ingest)
- **Additional context** (free-text textarea, optional — captures things not in the materials drop zone)
- **Confirm + Cancel** buttons

**Why.** A consistent dispatch modal surfaces what triggered the run and gives a context escape hatch without re-implementing modal chrome each time.

**Where it lives:** `shared/dispatch-modal.tsx` — exports `<DispatchModal title triggerSource autoDiff onConfirm onCancel />`. Pages compose around it (e.g. RunResearchUpdateModal wraps it with research-specific copy).

**Apply to:** Any non-form skill-dispatch (form-driven scaffolds use `ScaffoldForm`).

**Note on cost caps.** An earlier revision of this pattern required a cost-cap slider in every dispatch modal. The slider was UI-only — never wired to `runs.ts` — so it was removed system-wide. See [[decision-remove-dispatch-cost-cap]] for the rationale. Cumulative cost is visible via stream-json's `result` events on every run; that's the cost-visibility surface now.

## 12. Updated `shared/` structure

Section 8's deliverable structure expands with the new primitives:

```
domains/meta/app/src/shared/
  theme.css
  icons.tsx
  badges.tsx                    ← + count-badge variant
  stacked-bars.tsx              ← renamed from severity-bar.tsx; adds CountStackedBar
  stepper.tsx                   ← NEW
  markdown.tsx                  ← NEW (MarkdownBlock w/ ## Update N decoration)
  dispatch-modal.tsx            ← NEW (DispatchModal with cost-cap)
  layout.tsx                    ← + ActionBanner
  code-pane.tsx
  code-highlight.ts
  charts.tsx
  controls.tsx
  utils.ts
  archetypes/
  index.ts
```

## 13. Updated audit hooks

Section 9's list expands:

| id                          | severity | what it enforces                                                                                            |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `app-design-shared-import`  | warn     | Apps import primitives from `@/shared` rather than reimplementing them inline (existing)                    |
| `app-design-css-variables`  | warn     | Apps don't redeclare CSS variables from `shared/theme.css` (existing)                                       |
| `app-design-tweaks-absent`  | error    | No app ships a `TweaksPanel` or per-app theme override mechanism (existing)                                 |
| `app-design-icon-source`    | info     | Apps' icons are imported from `shared/icons` (existing)                                                     |
| `app-design-banner-reducer` | warn     | Pages with state-aware banners use a named `stateFor()` reducer rather than inline if/else cascades (NEW)   |
| `app-design-filter-chips`   | info     | List pages use filter chips with `<count>` badges, not dropdowns, for status-style filtering (NEW)          |
| `app-design-stepper`        | info     | Multi-stage workflows render a `<Stepper>` above the tab bar; current stage matches frontmatter state (NEW) |

## See also

- [[standard-app-architecture]] — manifest contract + apps/ layout
- [[standard-app-persistence]] — per-app SQLite + decision rubric
- [[concept-app]] — plain-language overview
- [[meta-add-app]] — scaffolder that produces apps conforming to this standard
- [[meta-dashboard]] — the shell apps mount into
