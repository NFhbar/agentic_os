# Audit-log args — `meta-status-report`

Read this at procedure step 11, when recording the run. The `--args` payload is what
notification templates render into Slack/email, so it must carry the substance of the
generated file — not just its path.

## Command

Record via the dual-write wrapper. Stuff the TL;DR + key sections into `--args` so
notification templates can render a meaningful Slack/email message without re-reading the
file. The dispatcher passes `args` to the template engine as `event.args` for Mustache
interpolation.

```bash
node scripts/record-dashboard-action.mjs \
  --action status-report \
  --skill meta-status-report \
  --args '{
    "project":"<id>",
    "report_type":"<kickoff|status|wrap-up>",
    "title":"<project title>",
    "tldr":"<the ## TL;DR section as a single line — strip newlines>",
    "progress_summary":"<one-line summary of the Changes block — e.g. \"2 of 6 merged · 1 in PR review · 3 in planning\">",
    "blockers":"<the ## Blockers / risks section as a single line, semicolon-separated bullets>",
    "next":"<the ## Next section as a single line, semicolon-separated bullets>",
    "report_path":"<full vault/output/... path>",
    "period_local":"<the **Period:** line value, e.g. \"Jun 1, 2026 7:55 AM PDT → Jun 1, 2026 8:55 AM PDT\">"
  }' \
  --files-touched '["<report path>","vault/wiki/<domain>/project/<project>.md"]'
```

## Formatting rule

Keep each field a single line — Mustache templates render directly into Slack/email text.
Strip embedded newlines from the source sections; replace bullet markers with `· `
separators so the values stay readable when concatenated.
