# Quantitative rollup — `meta-status-report`

Read this at procedure step 6a. It defines the fields the rollup carries and the
`events.db` query that produces them.

## Fields

Query `.claude/state/events.db` for every event tagged to this project AND its owned
changes. Build:

- **total_cost_usd** — sum of `cost_usd` across `action = 'ai-prompt'` events.
- **total_wall_time_ms** — sum of `duration_ms` across `action = 'ai-prompt'` events.
- **ai_prompt_runs** — count of `action = 'ai-prompt'` events.
- **runs_by_skill** — `{ <skill>: { count, cost_usd, duration_ms } }` map.
- **changes_terminal** — `merged` + `abandoned` counts from the manifest roll-up
  (already loaded in procedure step 4a).
- **failed_runs** — count of `action = 'ai-prompt'` events where `exit_status != 0`.

## Query sketch

```sql
SELECT skill, COUNT(*) AS n, SUM(cost_usd) AS cost, SUM(duration_ms) AS dur,
       SUM(CASE WHEN exit_status != 0 THEN 1 ELSE 0 END) AS failures
FROM events
WHERE action = 'ai-prompt'
  AND (project = '<project-id>' OR change_id IN (<owned change ids>))
GROUP BY skill;
```

Surface this block so future-you (and any cross-project comparison) has real numbers to
point at. **Required section** — emit even when totals are zero (with a "no recorded runs
in window" note). It renders in every `report_type`.
