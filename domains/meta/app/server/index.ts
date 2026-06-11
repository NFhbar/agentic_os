import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { setAfterInsertHook } from '../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { getEventsAfterId, getMaxEventId } from '../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { sweepDeadRuns } from '../../../../scripts/runs-supervisor.mjs';
import { loadAppEnv } from './load-env.js';

// Load app .env BEFORE importing routes — some route modules read process.env
// at import time. Per standard-env-config: process.env wins (shell-exported
// vars stay authoritative); the file populates anything still unset.
{
  const result = loadAppEnv();
  if (result.missing) {
    console.log(`[env] no .env at ${result.path} — using shell process.env only`);
  } else {
    console.log(`[env] loaded ${result.loaded} key(s) from ${result.path}`);
  }
}

import { auth } from './auth.js';
import { dispatchEvent } from './notifications/dispatcher.js';
import { actionRoutes } from './routes/action.js';
import { auditRoutes } from './routes/audit.js';
import { auditsRoutes } from './routes/audits.js';
import {
  automationRoutes,
  changeAutomationRoutes,
  checkMergedChangesAndAdvance,
} from './routes/automation.js';
import { changesRoutes } from './routes/changes.js';
import { commandsRoutes } from './routes/commands.js';
import { curationRoutes } from './routes/curation.js';
import { decisionsRoutes } from './routes/decisions.js';
import { domainsRoutes } from './routes/domains.js';
import { editRoutes } from './routes/edit.js';
import { eventsDbRoutes } from './routes/events-db.js';
import { eventsRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { mcpsRoutes } from './routes/mcps.js';
import { modelsRoutes } from './routes/models.js';
import { notificationsRoutes } from './routes/notifications.js';
import { prReviewConfigRoutes } from './routes/pr-review-config.js';
import { prReviewMetricsRoutes } from './routes/pr-review-metrics.js';
import { projectsRoutes } from './routes/projects.js';
import { reposRoutes } from './routes/repos.js';
import { researchRoutes } from './routes/research.js';
import { reviewsRoutes } from './routes/reviews.js';
import { routerLogRoutes } from './routes/router-log.js';
import { processUnhookedRuns, runsRoutes } from './routes/runs.js';
import { schedulesRoutes } from './routes/schedules.js';
import { settingsRoutes } from './routes/settings.js';
import { skillsRoutes } from './routes/skills.js';
import { tuningSuggestionsRoutes } from './routes/tuning-suggestions.js';
import { usageRoutes } from './routes/usage.js';
import { vaultRoutes } from './routes/vault.js';

// maxParamLength bumped from the find-my-way default of 100. Audit
// action-item ids are composed `audit:<check-id>:<finding-path>:<msg-hash>`
// and can comfortably exceed 100 chars when the finding-path is a long
// catalog key (e.g. `event-catalog:dashboard.notification-rule-test-send`).
// 512 is generous headroom that still bounds the param size for safety.
const fastify = Fastify({ logger: { level: 'info' }, maxParamLength: 512 });

await fastify.register(cors);
await fastify.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB per file
    files: 20,
  },
});
fastify.addHook('onRequest', auth);

await fastify.register(vaultRoutes, { prefix: '/api/vault' });
await fastify.register(skillsRoutes, { prefix: '/api/skills' });
await fastify.register(domainsRoutes, { prefix: '/api/domains' });
await fastify.register(commandsRoutes, { prefix: '/api/commands' });
await fastify.register(routerLogRoutes, { prefix: '/api/router-log' });
await fastify.register(curationRoutes, { prefix: '/api/curation' });
await fastify.register(schedulesRoutes, { prefix: '/api/schedules' });
await fastify.register(auditRoutes, { prefix: '/api/audit' });
// Lifecycle-audit entries (Overseer output) — distinct from /api/audit
// (which is the OS-compliance audit). Plural namespace for the per-change
// audits the meta-overseer-review skill produces.
await fastify.register(auditsRoutes, { prefix: '/api/audits' });
await fastify.register(tuningSuggestionsRoutes, { prefix: '/api/tuning-suggestions' });
await fastify.register(modelsRoutes, { prefix: '/api/models' });
await fastify.register(decisionsRoutes, { prefix: '/api/decisions' });
await fastify.register(eventsRoutes, { prefix: '/api/events' });
await fastify.register(eventsDbRoutes, { prefix: '/api/events-db' });
await fastify.register(projectsRoutes, { prefix: '/api/projects' });
// Automation endpoints sit under /api/projects/:id/automation/* — registered
// after projectsRoutes (same prefix) so the route table reflects the URL.
await fastify.register(automationRoutes, { prefix: '/api/projects' });
await fastify.register(researchRoutes, { prefix: '/api/research' });
await fastify.register(changesRoutes, { prefix: '/api/changes' });
// Per-change automation endpoints — Phase 2. Sit under /api/changes/:id/
// automation/*. Registered after changesRoutes (same prefix) so route table
// reflects URL.
await fastify.register(changeAutomationRoutes, { prefix: '/api/changes' });
await fastify.register(reviewsRoutes, { prefix: '/api/reviews' });
await fastify.register(reposRoutes, { prefix: '/api/repos' });
await fastify.register(prReviewConfigRoutes, { prefix: '/api/pr-review/config' });
await fastify.register(prReviewMetricsRoutes, { prefix: '/api/pr-review/dashboard-metrics' });
await fastify.register(mcpsRoutes, { prefix: '/api/mcps' });
await fastify.register(notificationsRoutes, { prefix: '/api/notifications' });
await fastify.register(actionRoutes, { prefix: '/api/action' });
await fastify.register(runsRoutes, { prefix: '/api/runs' });
await fastify.register(editRoutes, { prefix: '/api/edit' });
await fastify.register(healthRoutes, { prefix: '/api/health' });
await fastify.register(settingsRoutes, { prefix: '/api/settings' });
await fastify.register(usageRoutes, { prefix: '/api/usage' });

// Dead-run sweep — since durable-runs, children are detached and survive a
// server restart, so boot no longer blanket-fails running rows: the sweep
// only finalizes rows whose PID is actually dead, via runs-finalize.mjs
// (result-event recovery + artifact verification → done /
// died-after-writeback / failed). Note 'periodic' mode at boot too — a
// running row with a live PID is now a healthy adopted run, and queued
// rows from a prior process get failed by the supervisor's next pass if
// they never spawn.
try {
  const swept = await sweepDeadRuns('server restart: PID not alive', 'periodic');
  if (swept > 0) console.log(`runs: finalized ${swept} dead run(s) from prior process`);
} catch (e) {
  console.error('runs dead-run sweep failed', e);
}

// Periodic dead-run sweep — catches the silent-kill pattern where the child
// dies without firing its exit handler. The scheduler tick's supervisor
// covers this too (and wall-caps); this in-server sweep is the fallback for
// installs without the LaunchAgent.
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const orphanSweepTimer = setInterval(() => {
  void sweepDeadRuns('orphan-sweep: PID not alive', 'periodic')
    .then((swept: number) => {
      if (swept > 0) console.log(`runs: finalized ${swept} dead run(s) (periodic sweep)`);
    })
    .catch((e: unknown) => console.error('periodic dead-run sweep failed', e));
}, ORPHAN_SWEEP_INTERVAL_MS);
// Don't let the sweep timer keep the process alive on shutdown.
orphanSweepTimer.unref();

// Post-terminal hook poll — fires events.db recording + automation
// advancement for runs finalized outside this process (supervisor reaps
// during a server outage). Idempotent via runs.hooks_fired_at. Without
// this, a run that died while the server was down would leave its change
// automation parked forever.
processUnhookedRuns().catch((e) => console.error('unhooked-runs startup poll failed', e));
const UNHOOKED_POLL_INTERVAL_MS = 60 * 1000;
const unhookedTimer = setInterval(() => {
  void processUnhookedRuns().catch((e) => console.error('unhooked-runs poll failed', e));
}, UNHOOKED_POLL_INTERVAL_MS);
unhookedTimer.unref();

// Project automation merge watcher (Phase 1.5+1). The orchestrator parks
// at the `merge` step after dev-pr-review approves because the actual PR
// merge happens outside our skill-dispatch surface. This timer polls every
// 60s and ticks any parked automation whose current_change has reached
// `status: merged`. Runs once at startup too, so server restarts don't miss
// merges that landed while we were down.
const MERGE_WATCHER_INTERVAL_MS = 60 * 1000;
checkMergedChangesAndAdvance().catch((e) => console.error('merge watcher startup run failed', e));
const mergeWatcherTimer = setInterval(() => {
  void checkMergedChangesAndAdvance().catch((e) => console.error('merge watcher tick failed', e));
}, MERGE_WATCHER_INTERVAL_MS);
mergeWatcherTimer.unref();

// Notification dispatcher — fired off the events-db write path via
// setImmediate inside recordEvent, so this handler runs after the row is
// visible. Swallow + log: the hook's caller re-catches, but dispatcher
// errors are actionable and belong in dashboard logs.
//
// CAVEAT: this hook only fires for events recorded IN-PROCESS (test-sends from
// the dashboard, server-side helpers). External writers like
// `record-dashboard-action.mjs` (invoked by every skill) are separate Node
// processes with no hook registered — they insert events.db rows directly,
// bypassing this callback. The poller below closes that gap.
setAfterInsertHook((row: unknown) => {
  dispatchEvent(row as Parameters<typeof dispatchEvent>[0]).catch((err) =>
    console.error('notifications/dispatcher: dispatch failed', err),
  );
});

// Cross-process notification dispatcher poller. Skills + scripts invoke
// `record-dashboard-action.mjs` (separate Node process) to write events.db
// rows — those inserts don't trigger setAfterInsertHook in THIS process.
// Poll the events table every 10s for new rows since the last seen id and
// feed each through the same dispatchEvent path. Initialized to the current
// MAX(id) at startup so rows recorded BEFORE the server started don't get
// re-dispatched (they had their chance at original write time).
const NOTIFICATION_POLL_INTERVAL_MS = 10 * 1000;
let lastDispatchedEventId: number = (() => {
  try {
    return getMaxEventId();
  } catch (e) {
    console.error('notifications/poll: getMaxEventId failed at startup', e);
    return 0;
  }
})();
const notificationPollTimer = setInterval(() => {
  try {
    const rows = getEventsAfterId(lastDispatchedEventId, 200);
    if (rows.length === 0) return;
    // Advance high-water mark BEFORE dispatching so a slow dispatch doesn't
    // cause re-dispatch on the next tick. dispatchEvent is best-effort and
    // self-logs its own errors; we don't want to re-fire the same row.
    lastDispatchedEventId = rows[rows.length - 1].id;
    for (const row of rows) {
      // Skip notification-kind events to avoid loops — same guard the
      // in-process hook relies on. dispatchEvent re-checks this too, but
      // doing it here is cheap and reduces noise.
      if (row.kind === 'notification') continue;
      dispatchEvent(row as Parameters<typeof dispatchEvent>[0]).catch((err) =>
        console.error(`notifications/poll: dispatch failed for event ${row.id}`, err),
      );
    }
  } catch (err) {
    console.error('notifications/poll: tick failed', err);
  }
}, NOTIFICATION_POLL_INTERVAL_MS);
notificationPollTimer.unref();

const port = Number(process.env.PORT) || 5174;
await fastify.listen({ port, host: '127.0.0.1' });
console.log(`Agentic OS dashboard api on http://127.0.0.1:${port}`);
