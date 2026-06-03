import React, { useEffect, useRef, useState } from 'react';
import { runAction, runStream } from '../lib/api';

interface CloseStatus {
  done: boolean; // true when the SSE stream delivered the final chunk
  success: boolean; // true only when done && exit === 0
}

interface Props {
  prompt: string;
  title?: string;
  // Optional alternate streaming endpoint. When provided with `body`, the
  // runner POSTs to that endpoint instead of /api/action. The endpoint must
  // emit the same chunk/stderr/done SSE schema. `prompt` is still shown in
  // the modal header for transparency.
  endpoint?: string;
  body?: unknown;
  // Receives both `done` and `success` so the parent can distinguish between
  // (a) the run completed cleanly, (b) the run completed with a non-zero exit,
  // and (c) the user closed mid-run (server still working in the background).
  onClose: (status: CloseStatus) => void;
  // Optional. When provided, minimize state is LIFTED to the parent so the
  // in-flight indicator can live in the parent's UI. When minimized=true,
  // ActionRunner falls back to a small floating dock (bottom-right) unless
  // `minimizeBehavior='hidden'` — used by apps that render their own
  // in-flight indicator (e.g. PR Review's Repos table injects a "running"
  // row that already serves as the user's window into the run).
  minimized?: boolean;
  onMinimize?: (v: boolean) => void;
  minimizeBehavior?: 'dock' | 'hidden';
}

// Module-level dispatch dedupe. React.StrictMode in dev does a full
// unmount → remount cycle, which means useRef-based guards reset on the
// second mount and the dispatch fires twice. By keying off a Map that lives
// outside the component lifecycle, we survive the remount cycle.
//
// A short timestamp window (500ms) means legitimate re-runs of the same
// prompt after a real result are NOT blocked — StrictMode's remount happens
// in microseconds, so this is comfortably wide enough to catch it without
// fighting users.
const recentDispatches = new Map<string, number>();
const DISPATCH_DEDUPE_MS = 500;

// Modal that runs an AI action and streams its output.
// Shows the prompt for transparency, accumulates stdout, surfaces exit status.
// When minimized (controlled by the parent), renders NOTHING — the parent is
// expected to show an in-flight indicator elsewhere (e.g. a running row in a
// data table). All streaming state stays alive on the component while
// minimized, so re-opening returns the user to the live output unchanged.
export function ActionRunner({
  prompt,
  title,
  endpoint,
  body,
  onClose,
  minimized,
  onMinimize,
  minimizeBehavior = 'dock',
}: Props) {
  const [output, setOutput] = useState<string>('');
  const [stderr, setStderr] = useState<string>('');
  const [done, setDone] = useState<boolean>(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [running, setRunning] = useState<boolean>(true);
  const startedAtRef = useRef<number>(Date.now());
  const outRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    // Strict-mode-safe dedupe — see module-level `recentDispatches` above.
    // A duplicate within DISPATCH_DEDUPE_MS is treated as a remount artifact
    // and skipped; the original effect already kicked off the fetch.
    const key = `${endpoint ?? '/api/action'}::${prompt}`;
    const now = Date.now();
    const last = recentDispatches.get(key);
    if (last !== undefined && now - last < DISPATCH_DEDUPE_MS) return;
    recentDispatches.set(key, now);

    let cancelled = false;
    (async () => {
      const stream = endpoint ? runStream(endpoint, body) : runAction(prompt);
      for await (const chunk of stream) {
        if (cancelled) return;
        if (chunk.chunk) setOutput((s) => s + chunk.chunk);
        if (chunk.stderr) setStderr((s) => s + chunk.stderr);
        if (chunk.done) {
          setExitCode(chunk.exit ?? null);
          setDone(true);
          setRunning(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prompt, endpoint, body]);

  useEffect(() => {
    if (outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }, [output]);

  const success = done && exitCode === 0;
  // Note: we used to auto-close when (done && minimized) so the parent's
  // row could transition out of "analyzing" automatically. That trapped the
  // user: if SSE `done` fired before they wanted to read the output (e.g.
  // when the sub-skill chain finished but they'd minimized early), the
  // modal unmounted and the streaming buffer was unrecoverable. Now we
  // leave the modal alive — the user explicitly clicks "View output" then
  // Close when they're satisfied. The row visual stays decorated as
  // analyzing until then, which is a small cost vs. lost output.

  const failed = done && exitCode !== 0;
  const canMinimize = typeof onMinimize === 'function';

  // Minimized = the in-flight indicator lives somewhere else (in our app,
  // it's a row in the Repos table). Render nothing here while minimized;
  // streaming state stays alive in this component's closure.
  if (canMinimize && minimized) {
    // Caller renders its own in-flight indicator (e.g. a running row in a
    // data table) — render nothing here so the two don't double up.
    if (minimizeBehavior === 'hidden') return null;
    // Default: small floating dock at bottom-right. Single-line title +
    // elapsed time + status dot + restore button + close. Stays out of the
    // way; clicking ▴ restores the modal with all streaming state intact.
    const elapsedSec = Math.floor((Date.now() - startedAtRef.current) / 1000);
    const elapsedLabel =
      elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
    const dotClass = success ? 'dot done' : failed ? 'dot failed' : 'dot running';
    const stateLabel = success ? '✓ done' : failed ? '✗ failed' : `running · ${elapsedLabel}`;
    return (
      <output className="action-runner-dock" aria-live="polite">
        <span className="dock-state">
          <span className={dotClass} />
          {stateLabel}
        </span>
        <span className="dock-title">{title ?? 'AI action'}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onMinimize?.(false)}
          title="Restore"
          style={{ width: 28, height: 28 }}
        >
          ▴
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onClose({ done, success })}
          title="Close (work continues in background)"
          style={{ width: 28, height: 28 }}
        >
          ×
        </button>
      </output>
    );
  }

  // While a run is in flight AND the parent supports minimize, every dismiss
  // path (X, backdrop, footer button) acts as a minimize — the row in the
  // parent's table is the in-flight indicator and shouldn't disappear when
  // the user just wants to hide this modal. Once the run is done, dismiss
  // means "close for real" (the row will reflect the final state without
  // needing this modal at all).
  const dismiss =
    canMinimize && !done ? () => onMinimize?.(true) : () => onClose({ done, success });

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title ?? 'AI action'}</h3>
          <button
            className="close"
            style={{ marginLeft: 'auto' }}
            onClick={dismiss}
            title={
              canMinimize && !done
                ? 'Minimize (run continues; the table row stays as the indicator)'
                : 'Close'
            }
          >
            {canMinimize && !done ? '–' : '×'}
          </button>
        </header>

        <section className="prompt">
          <label>Prompt</label>
          <pre>{prompt}</pre>
        </section>

        <section className="output">
          <label>
            Output
            {running && <span className="running-dot"> ● running</span>}
            {success && <span className="success-tag"> ✓ exit 0</span>}
            {failed && <span className="failed-tag"> ✗ exit {exitCode}</span>}
          </label>
          <pre ref={outRef} className="stream">
            {output || (running ? '(waiting…)' : '(no output)')}
          </pre>
          {stderr && (
            <>
              <label>Stderr</label>
              <pre className="stream stderr">{stderr}</pre>
            </>
          )}
        </section>

        <footer>
          <button className="primary" onClick={dismiss}>
            {canMinimize && !done ? 'Minimize' : 'Close'}
          </button>
        </footer>
      </div>
    </div>
  );
}
