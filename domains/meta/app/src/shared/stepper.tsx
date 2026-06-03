// Lifecycle stepper shared across apps.
// Locked by standard-app-design § 11.4.

import type React from 'react';
import { formatRelative } from '../lib/time';
import { Icons } from './components';

export type StepStatus = 'done' | 'current' | 'pending' | 'skipped';

export interface StepperStep {
  id: string;
  label: string;
  status: StepStatus;
  at?: string | null;
  hint?: string | null;
  onClick?: () => void;
  // When set, renders a small bell affordance next to the step label.
  // Clicking it invokes onNotify — typically navigates to RuleEditor
  // pre-filled with this step's event_type + the entity filter. Per
  // standard event-catalog, each step maps to one canonical event_type
  // the user can subscribe to.
  onNotify?: () => void;
  notifyHint?: string | null;
  // When set, the bell renders in a "subscribed" visual state (accent color,
  // full opacity) — signals that a rule already exists for this step's
  // event_type (matching the entity's scope: project-scoped rule OR a global
  // rule that includes this entity). The id lets the parent decide whether
  // clicking opens the existing rule for edit OR creates a new one.
  subscribedRuleId?: string | null;
}

function stepColors(status: StepStatus): {
  dotColor: string;
  dotFill: string;
  lineColor: string;
  labelColor: string;
} {
  switch (status) {
    case 'done':
      return {
        dotColor: 'var(--success-text)',
        dotFill: 'var(--success-text)',
        lineColor: 'var(--success-text)',
        labelColor: 'var(--text-2)',
      };
    case 'current':
      return {
        dotColor: 'var(--accent)',
        dotFill: 'var(--bg)',
        lineColor: 'var(--border)',
        labelColor: 'var(--accent-text)',
      };
    case 'skipped':
      return {
        dotColor: 'var(--text-3)',
        dotFill: 'var(--bg-2)',
        lineColor: 'var(--border)',
        labelColor: 'var(--text-3)',
      };
    default:
      return {
        dotColor: 'var(--border)',
        dotFill: 'var(--bg-2)',
        lineColor: 'var(--border)',
        labelColor: 'var(--text-3)',
      };
  }
}

export const Stepper: React.FC<{ steps: StepperStep[] }> = ({ steps }) => {
  if (steps.length === 0) return null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        padding: '16px 16px 8px',
        position: 'relative',
      }}
    >
      {steps.map((step, i) => (
        <Step
          key={step.id}
          step={step}
          index={i}
          isFirst={i === 0}
          isLast={i === steps.length - 1}
        />
      ))}
    </div>
  );
};

function Step({
  step,
  index,
  isFirst,
  isLast,
}: {
  step: StepperStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { dotColor, dotFill, lineColor, labelColor } = stepColors(step.status);
  const clickable = !!step.onClick;
  const body = (
    <>
      <div
        style={{
          position: 'absolute',
          top: 9,
          left: 0,
          right: 0,
          height: 2,
          display: 'flex',
        }}
      >
        {!isFirst && <div style={{ flex: 1, background: lineColor, height: 2 }} />}
        <div style={{ width: 20 }} />
        {!isLast && <div style={{ flex: 1, background: lineColor, height: 2 }} />}
      </div>
      <div
        title={step.hint ?? ''}
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: dotFill,
          border: `2px solid ${dotColor}`,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--bg)',
        }}
      >
        {step.status === 'done' && <Icons.Check size={11} />}
        {step.status === 'current' && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: dotColor,
            }}
          />
        )}
        {step.status === 'skipped' && (
          <span style={{ fontSize: 11, color: dotColor, lineHeight: 1 }}>–</span>
        )}
        {step.status === 'pending' && (
          <span style={{ fontSize: 10, color: dotColor, lineHeight: 1 }}>{index + 1}</span>
        )}
      </div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: step.status === 'current' ? 600 : 500,
          marginTop: 8,
          textAlign: 'center',
          color: labelColor,
          lineHeight: 1.3,
          textDecoration: step.status === 'skipped' ? 'line-through' : 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          justifyContent: 'center',
        }}
      >
        {step.label}
        {step.onNotify && (
          // The bell uses a non-button span+role to avoid nesting <button>
          // inside the clickable step wrapper (invalid HTML, a11y violation).
          // stopPropagation prevents the parent's onClick from firing.
          //
          // Visual differentiation: subscribed (rule exists) renders the bell
          // in accent color at full opacity. Unsubscribed renders muted at
          // 0.55 opacity with hover-brighten. Per-state title text clarifies
          // the click action ("Edit existing rule" vs "Create rule").
          (() => {
            const subscribed = !!step.subscribedRuleId;
            const baseOpacity = subscribed ? 1 : 0.55;
            const color = subscribed ? 'var(--accent-text)' : 'inherit';
            const titleText = step.notifyHint
              ? step.notifyHint
              : subscribed
                ? `Edit existing notification rule for the "${step.label}" step`
                : `Create a notification rule for the "${step.label}" step`;
            return (
              <span
                role="button"
                aria-label={titleText}
                aria-pressed={subscribed}
                title={titleText}
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  step.onNotify?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    step.onNotify?.();
                  }
                }}
                style={{
                  cursor: 'pointer',
                  opacity: baseOpacity,
                  color,
                  transition: 'opacity 0.15s',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLSpanElement).style.opacity = '1';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLSpanElement).style.opacity = String(baseOpacity);
                }}
              >
                <Icons.Bell size={10} />
              </span>
            );
          })()
        )}
      </div>
      {step.at && (
        <div className="tiny" style={{ marginTop: 2, textAlign: 'center', fontSize: 10 }}>
          {formatRelative(step.at)}
        </div>
      )}
      {step.hint && (
        <div className="tiny" style={{ marginTop: 2, textAlign: 'center', fontSize: 10 }}>
          {step.hint}
        </div>
      )}
      {step.status === 'skipped' && (
        <div
          className="tiny"
          style={{
            marginTop: 2,
            textAlign: 'center',
            fontSize: 10,
            fontStyle: 'italic',
            color: 'var(--text-3)',
          }}
        >
          n/a
        </div>
      )}
    </>
  );
  const wrapper: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    position: 'relative',
    padding: '0 4px',
  };
  if (clickable) {
    return (
      <button
        type="button"
        onClick={step.onClick}
        style={{
          ...wrapper,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        {body}
      </button>
    );
  }
  return <div style={wrapper}>{body}</div>;
}
