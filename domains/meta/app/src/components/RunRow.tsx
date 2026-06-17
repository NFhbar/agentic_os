// RunRow — single-run summary used in both the drawer (compact mode) and
// the Processes page. Expand toggle attaches a live SSE subscriber for
// running rows or replays the terminal output for finished ones.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type RunRecord, cancelRun, deriveRunLabel, subscribeRun } from '../lib/runs';
// Pure helpers extracted to orphan-recognizer.ts so unit tests can exercise
// them without pulling React. See tests/unit/runs/orphanRecognizer.test.ts.
import { entityLink, recognizeOrphanLike } from './orphan-recognizer';

interface Props {
  run: RunRecord;
  onCancel?: (id: string) => void;
  compact?: boolean;
  defaultExpanded?: boolean;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function durationLabel(run: RunRecord): string {
  if (run.duration_ms != null) {
    const s = Math.floor(run.duration_ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  if (run.state === 'running' && run.started_at) {
    const s = Math.floor((Date.now() - new Date(run.started_at).getTime()) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  return '';
}

function stateDotClass(state: RunRecord['state']): string {
  switch (state) {
    case 'running':
    case 'queued':
      return 'dot running';
    case 'done':
    case 'died-after-writeback':
      return 'dot done';
    case 'failed':
      return 'dot failed';
    case 'cancelled':
      return 'dot cancelled';
    default:
      return 'dot';
  }
}

export function RunRow({ run, onCancel, compact, defaultExpanded = false }: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const orphan = recognizeOrphanLike(run);
  const target = orphan ? entityLink(run) : null;
  const [output, setOutput] = useState('');
  const [stderr, setStderr] = useState('');
  const preRef = useRef<HTMLPreElement | null>(null);

  // Reset streamed buffers if the row's run id changes under us (rare — the
  // list mutates) or if the user collapses + expands.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setOutput('');
    setStderr('');
    (async () => {
      try {
        for await (const chunk of subscribeRun(run.id)) {
          if (cancelled) return;
          if (chunk.chunk) setOutput((s) => s + chunk.chunk);
          if (chunk.stderr) setStderr((s) => s + chunk.stderr);
          if (chunk.done) return;
        }
      } catch {
        /* stream closed — leave the buffer as is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, run.id]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [output]);

  const handleCancel = useCallback(async () => {
    try {
      await cancelRun(run.id);
    } catch {
      /* surface via parent if needed */
    }
    onCancel?.(run.id);
  }, [run.id, onCancel]);

  const isRunning = run.state === 'running' || run.state === 'queued';
  const label = deriveRunLabel(run);
  const tag =
    run.change_id ?? run.project ?? run.repo ?? (run.skill && `skill=${run.skill}`) ?? null;

  return (
    <div
      className={`run-row${compact ? ' compact' : ''}${expanded ? ' expanded' : ''}`}
      data-state={run.state}
    >
      {/* Two-button flex row: the main button toggles expand (covers the
       * entire metadata strip), and the optional cancel button sits as a
       * sibling so we don't nest interactive elements. Disambiguating
       * clicks visually: the row itself is the toggle target; the cancel
       * button has its own outlined affordance. */}
      <div className="run-row-head">
        <button
          type="button"
          className="run-row-line"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Hide output' : 'Show output'}
        >
          <span className={stateDotClass(run.state)} aria-hidden="true" />
          <span className="run-row-state">{run.state}</span>
          <span className="run-row-title">{label}</span>
          {tag && <span className="run-row-tag mono">{tag}</span>}
          <span className="run-row-elapsed">{durationLabel(run)}</span>
          {run.cost_usd != null && run.cost_usd > 0 && (
            <span
              className="run-row-cost"
              title={`Model: ${run.model ?? '(unknown)'} · in: ${(run.tokens_in ?? 0).toLocaleString()} · out: ${(run.tokens_out ?? 0).toLocaleString()} · cache hit: ${(run.tokens_cache_hit ?? 0).toLocaleString()} · cache write: ${(run.tokens_cache_write ?? 0).toLocaleString()}`}
            >
              ${run.cost_usd.toFixed(4)}
            </span>
          )}
          {run.state === 'done' && run.exit_status != null && (
            <span className="run-row-exit ok">exit {run.exit_status}</span>
          )}
          {run.state === 'died-after-writeback' && (
            <span
              className="run-row-exit ok"
              title={
                orphan?.hint ?? run.error ?? 'Work landed; the subprocess died without reporting.'
              }
            >
              ⚠ landed
            </span>
          )}
          {run.state === 'failed' && (
            <span
              className="run-row-exit fail"
              title={
                orphan
                  ? `${orphan.label} — expand for details + a Verify link`
                  : (run.error ?? undefined)
              }
            >
              {orphan ? '⚠' : '✗'} exit {run.exit_status ?? '?'}
            </span>
          )}
          <span className="run-row-started">{relativeTime(run.started_at)}</span>
          <span className="run-row-toggle" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {isRunning && (
          <button
            type="button"
            className="run-row-cancel"
            onClick={handleCancel}
            title="Cancel run (sends SIGTERM; output up to here is preserved)"
          >
            cancel
          </button>
        )}
      </div>
      {expanded && (
        <div className="run-row-output">
          {orphan && (
            <div
              style={{
                padding: '10px 12px',
                marginBottom: 8,
                background: 'var(--warning-bg, rgba(250,200,80,0.1))',
                border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
                borderRadius: 4,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠ {orphan.label}</div>
              <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>{orphan.hint}</div>
              <div className="tiny mono" style={{ marginBottom: 8, opacity: 0.65 }}>
                error: {run.error}
              </div>
              {target && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(target.href)}
                  title={`Open ${target.label} to verify what landed`}
                >
                  Verify {target.label}
                </button>
              )}
            </div>
          )}
          <pre ref={preRef} className="stream">
            {output || (isRunning ? '(waiting…)' : '(no output captured)')}
          </pre>
          {stderr && <pre className="stream stderr">{stderr}</pre>}
        </div>
      )}
    </div>
  );
}
