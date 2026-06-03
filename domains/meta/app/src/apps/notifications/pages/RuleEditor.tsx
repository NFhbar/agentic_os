// RuleEditor: form for one notification-config rule. Renders the owning-
// domain dropdown (locked after create), per-channel delivery sub-form,
// the test-send safety banner, and the test-send button.

import type React from 'react';
import { useEffect, useState } from 'react';
import { Icons } from '../../../shared';
import type {
  ChannelId,
  EventCatalogEntry,
  RuleListItem,
  SlackMode,
  TestSendResult,
  ValidationError,
} from '../data';
import {
  VALID_CHANNELS,
  createRule,
  deleteRule,
  getEventCatalog,
  getRule,
  getSlackMode,
  listOwningDomains,
  listProjectIds,
  listRules,
  testSend,
  updateRule,
} from '../data';

interface Props {
  // null = new rule mode; rule object = existing rule (locked owning-domain)
  ruleId: string | null;
  // when creating, pre-fill from URL params
  defaultEventType?: string;
  defaultChannel?: ChannelId;
  defaultFilterProject?: string;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onCancel: () => void;
}

interface FormState {
  domain: string;
  title: string;
  event_type: string;
  channel: ChannelId;
  enabled: boolean;
  filter_project: string;
  filter_domain: string;
  filter_severity: '' | 'success' | 'info' | 'warning' | 'urgent';
  // slack
  slack_channel: string;
  slack_tags: string;
  // email
  email_to: string;
  email_cc: string;
  email_from: string;
  // desktop
  desktop_urgency: '' | 'low' | 'normal' | 'critical';
  // rate limit
  cap_per_day: string;
}

function emptyForm(
  defaultEventType?: string,
  defaultChannel?: ChannelId,
  defaultFilterProject?: string,
): FormState {
  return {
    domain: 'meta',
    title: '',
    event_type: defaultEventType ?? '',
    channel: defaultChannel ?? 'slack',
    enabled: true,
    filter_project: defaultFilterProject ?? '',
    filter_domain: '',
    filter_severity: '',
    slack_channel: '',
    slack_tags: '',
    email_to: '',
    email_cc: '',
    email_from: '',
    desktop_urgency: '',
    cap_per_day: '',
  };
}

function ruleToForm(r: RuleListItem): FormState {
  return {
    domain: r.domain,
    title: r.title,
    event_type: r.event_type,
    channel: r.channel,
    enabled: r.enabled,
    filter_project: (r.filter.project as string) ?? '',
    filter_domain: (r.filter.domain as string) ?? '',
    filter_severity: (r.filter.severity as FormState['filter_severity']) ?? '',
    slack_channel: r.delivery.slack_channel ?? '',
    slack_tags: (r.delivery.tags ?? []).join(', '),
    email_to: (r.delivery.to ?? []).join(', '),
    email_cc: (r.delivery.cc ?? []).join(', '),
    email_from: r.delivery.from ?? '',
    desktop_urgency: (r.delivery.urgency as FormState['desktop_urgency']) ?? '',
    cap_per_day: r.rate_limit?.cap_per_day != null ? String(r.rate_limit.cap_per_day) : '',
  };
}

// biome-ignore lint/suspicious/noExplicitAny: shaped at the boundary
function formToBody(f: FormState, isCreate: boolean): any {
  const delivery: Record<string, unknown> = {};
  if (f.channel === 'slack') {
    if (f.slack_channel.trim()) delivery.slack_channel = f.slack_channel.trim();
    const tags = f.slack_tags.split(',').map((s) => s.trim()).filter(Boolean);
    if (tags.length > 0) delivery.tags = tags;
  } else if (f.channel === 'email') {
    const to = f.email_to.split(',').map((s) => s.trim()).filter(Boolean);
    if (to.length > 0) delivery.to = to;
    const cc = f.email_cc.split(',').map((s) => s.trim()).filter(Boolean);
    if (cc.length > 0) delivery.cc = cc;
    if (f.email_from.trim()) delivery.from = f.email_from.trim();
  } else if (f.channel === 'desktop') {
    if (f.desktop_urgency) delivery.urgency = f.desktop_urgency;
  }
  const filter: Record<string, unknown> = {};
  if (f.filter_project.trim()) filter.project = f.filter_project.trim();
  if (f.filter_domain.trim()) filter.domain = f.filter_domain.trim();
  if (f.filter_severity) filter.severity = f.filter_severity;
  const rate_limit: Record<string, unknown> | null =
    f.cap_per_day.trim() === ''
      ? null
      : { cap_per_day: Number.parseInt(f.cap_per_day.trim(), 10) };
  // biome-ignore lint/suspicious/noExplicitAny: shape varies by isCreate
  const body: any = {
    title: f.title.trim(),
    event_type: f.event_type.trim(),
    channel: f.channel,
    enabled: f.enabled,
  };
  if (Object.keys(filter).length > 0) body.filter = filter;
  if (Object.keys(delivery).length > 0) body.delivery = delivery;
  if (rate_limit) body.rate_limit = rate_limit;
  if (isCreate) body.domain = f.domain;
  return body;
}

// Overlap detection — find existing rules whose filter scope would
// double-fire alongside the current form's settings (Task #419). Two rules
// overlap on a given event when:
//   - same event_type (exact string match)
//   - same channel
//   - both enabled (disabled rules don't actually fire)
//   - filter scope is compatible: for each filter dimension (project,
//     domain, severity), either both rules are wildcard OR both match the
//     same specific value OR one is wildcard and the other specific. Two
//     different specific values DON'T overlap on that dimension — they
//     partition the matched-event space.
// Excludes the rule currently being edited (selfRuleId) so editing doesn't
// flag itself. Returns an array of overlapping rule titles + ids.
function findOverlappingRules(
  form: FormState,
  allRules: RuleListItem[],
  selfRuleId: string | null,
): RuleListItem[] {
  if (!form.event_type.trim() || !form.enabled) return [];
  const a = {
    project: form.filter_project.trim(),
    domain: form.filter_domain.trim(),
    severity: form.filter_severity || '',
  };
  function dimensionsOverlap(aVal: string, bVal: string): boolean {
    if (!aVal || !bVal) return true; // wildcard ∩ anything = match
    return aVal === bVal;
  }
  return allRules.filter((r) => {
    if (r.id === selfRuleId) return false;
    if (!r.enabled) return false;
    if (r.event_type !== form.event_type.trim()) return false;
    if (r.channel !== form.channel) return false;
    const b = {
      project: (r.filter.project as string) ?? '',
      domain: (r.filter.domain as string) ?? '',
      severity: (r.filter.severity as string) ?? '',
    };
    return (
      dimensionsOverlap(a.project, b.project) &&
      dimensionsOverlap(a.domain, b.domain) &&
      dimensionsOverlap(a.severity, b.severity)
    );
  });
}

function hasRecipient(f: FormState): boolean {
  if (f.channel === 'slack') return f.slack_channel.trim() !== '';
  if (f.channel === 'email') return f.email_to.trim() !== '';
  if (f.channel === 'desktop') return true;
  return false;
}

export const RuleEditor: React.FC<Props> = ({ ruleId, defaultEventType, defaultChannel, defaultFilterProject, onSaved, onDeleted, onCancel }) => {
  const isCreate = ruleId === null;
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultEventType, defaultChannel, defaultFilterProject));
  const [originalForm, setOriginalForm] = useState<FormState>(() => emptyForm(defaultEventType, defaultChannel, defaultFilterProject));
  const [domains, setDomains] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});
  const [slackMode, setSlackMode] = useState<SlackMode | null>(null);
  const [eventCatalog, setEventCatalog] = useState<EventCatalogEntry[]>([]);
  // Existing rules loaded on mount — used to surface overlap warnings when
  // the form's event_type + channel + filter scope would double-fire
  // alongside an already-saved rule (Task #419). Empty array when the load
  // fails (overlap detection is best-effort — never blocks editing).
  const [allRules, setAllRules] = useState<RuleListItem[]>([]);
  const [loading, setLoading] = useState(!isCreate);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<ValidationError | null>(null);
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listOwningDomains(),
      listProjectIds(),
      getSlackMode(),
      getEventCatalog(),
      listRules(),
    ])
      .then(([d, p, s, c, r]) => {
        if (cancelled) return;
        setDomains(d.domains);
        setProjectIds(p.ids);
        setProjectTitles(p.titles);
        setSlackMode(s.mode);
        setEventCatalog(c.entries);
        setAllRules(r.rules);
      })
      .catch(() => {
        if (!cancelled) setDomains(['meta']);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isCreate) return;
    let cancelled = false;
    setLoading(true);
    getRule(ruleId as string)
      .then((r) => {
        if (cancelled) return;
        const f = ruleToForm(r);
        setForm(f);
        setOriginalForm(f);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ruleId, isCreate]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(originalForm);
  const showSafetyBanner = hasRecipient(form);

  async function save() {
    setBusy(true);
    setFieldError(null);
    try {
      if (isCreate) {
        const body = formToBody(form, true);
        const res = await createRule(body);
        if ('error' in res) {
          setFieldError(res);
          return;
        }
        onSaved(res.id);
      } else {
        const body = formToBody(form, false);
        const res = await updateRule(ruleId as string, body);
        if ('error' in res) {
          setFieldError(res);
          return;
        }
        setOriginalForm(form);
        onSaved(res.id);
      }
    } catch (e) {
      setFieldError({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        field: '_root',
      });
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setForm(originalForm);
    setFieldError(null);
  }

  async function doDelete() {
    if (!ruleId) return;
    if (
      !window.confirm(
        `Delete rule "${form.title}"?\n\nHistorical events tied to rule:${ruleId} will become orphaned. Prefer disabling (uncheck Enabled) for audit-trail continuity.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteRule(ruleId);
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  async function doTestSend() {
    if (!ruleId || isDirty) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await testSend(ruleId);
      setTestResult(r);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ padding: 18 }}>
        <p className="subtle" style={{ margin: 0 }}>Loading rule…</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>
          {isCreate ? 'Add notification rule' : `Edit "${originalForm.title}"`}
        </h3>
        {!isCreate && (
          <>
            {showSafetyBanner && (
              <div
                className="tiny"
                style={{
                  color: 'var(--warning-text)',
                  background: 'var(--warning-bg, var(--bg-2))',
                  border: '1px solid var(--warning-border)',
                  borderRadius: 4,
                  padding: '6px 10px',
                  maxWidth: 380,
                  lineHeight: 1.4,
                }}
              >
                <strong>Test-send delivers to the real recipient.</strong>{' '}
                The title is prefixed with <code>[TEST]</code> and the audit row records{' '}
                <code>source=rule:{ruleId}:test</code>, but the message body itself is real
                and visible to anyone in the configured channel.
              </div>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={doTestSend}
              disabled={busy || isDirty}
              title={isDirty ? 'Save changes first to test-send what you see' : 'Send a [TEST]-prefixed message via this rule'}
            >
              <Icons.Play size={11} /> Test-send
            </button>
          </>
        )}
      </header>

      <FieldRow label="Owning domain" hint="Distinct from filter.domain. Determines where the rule file is stored.">
        <select
          value={form.domain}
          onChange={(e) => setForm({ ...form, domain: e.target.value })}
          disabled={!isCreate || busy}
        >
          {domains.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        {!isCreate && <span className="tiny subtle" style={{ marginLeft: 8 }}>(locked after create)</span>}
      </FieldRow>

      <FieldRow label="Title">
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          disabled={busy}
          style={{ width: '100%' }}
        />
      </FieldRow>

      <FieldRow
        label="Event type"
        hint={
          eventCatalog.length > 0
            ? `${eventCatalog.length} events in the catalog · pick from the dropdown or type a custom event_type`
            : '{kind}.{action} format, e.g. change.merged'
        }
      >
        {/* HTML datalist gives a typeable input with native autocomplete from
            the event catalog — best of both worlds: free-form entry for custom
            events while surfacing every known event_type as a hint. Browsers
            render the dropdown on focus + filter as the user types. */}
        <input
          type="text"
          list="event-catalog-list"
          value={form.event_type}
          onChange={(e) => setForm({ ...form, event_type: e.target.value })}
          disabled={busy}
          style={{ width: '100%' }}
          placeholder={
            eventCatalog.length > 0
              ? `${eventCatalog[0]?.event_type ?? 'change.merged'} (type to filter, or pick from list)`
              : 'change.merged'
          }
        />
        <datalist id="event-catalog-list">
          {[...eventCatalog]
            .sort((a, b) => a.event_type.localeCompare(b.event_type))
            .map((entry) => (
              <option key={entry.event_type} value={entry.event_type}>
                {entry.description}
              </option>
            ))}
        </datalist>
        {form.event_type && (() => {
          const match = eventCatalog.find((e) => e.event_type === form.event_type);
          return match ? (
            <div
              className="tiny"
              style={{
                marginTop: 6,
                padding: '6px 10px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--muted)',
              }}
            >
              <strong style={{ color: 'var(--text)' }}>{match.event_type}</strong> —{' '}
              {match.description}
              {match.entity !== 'none' && (
                <span style={{ display: 'block', marginTop: 4 }}>
                  Entity: <code className="mono">{match.entity}</code>
                  {match.entity_filter_field && (
                    <>
                      {' · filter field: '}
                      <code className="mono">{match.entity_filter_field}</code>
                    </>
                  )}
                </span>
              )}
            </div>
          ) : (
            <div
              className="tiny"
              style={{ marginTop: 6, color: 'var(--muted)', fontStyle: 'italic' }}
            >
              Custom event_type (not in catalog) — rule will only fire if events with this exact
              type are recorded.
            </div>
          );
        })()}
        {/* Overlap warning — surfaces when another enabled rule shares the
            same event_type + channel + a compatible filter scope (Task #419).
            Without this, a user creating a rule that double-fires alongside
            an existing one gets no signal until they see two notifications
            per event in production. */}
        {(() => {
          const overlaps = findOverlappingRules(form, allRules, ruleId);
          if (overlaps.length === 0) return null;
          return (
            <div
              className="tiny"
              style={{
                marginTop: 6,
                padding: '6px 8px',
                background: 'var(--warning-bg, rgba(250,200,80,0.1))',
                border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
                color: 'var(--warning-text, #e0a02a)',
                borderRadius: 4,
                lineHeight: 1.4,
              }}
              title="Two enabled rules with the same event_type, channel, and compatible filter scope will both fire for the same event — recipients will see duplicate notifications. Either narrow this rule's filters, change the channel, or disable the other rule."
            >
              <strong>⚠ Overlaps with {overlaps.length} existing rule{overlaps.length !== 1 ? 's' : ''}.</strong>{' '}
              Both will fire for the same event — recipients see duplicates. Overlap list:{' '}
              {overlaps.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ', '}
                  <code className="mono">{r.title}</code>
                </span>
              ))}
              .
            </div>
          );
        })()}
      </FieldRow>

      <FieldRow label="Channel">
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {VALID_CHANNELS.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`btn btn-sm ${form.channel === ch ? 'btn-primary' : ''}`}
              onClick={() => setForm({ ...form, channel: ch })}
              disabled={busy}
            >
              {ch}
            </button>
          ))}
        </div>
      </FieldRow>

      <FieldRow label="Enabled">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          disabled={busy}
        />
      </FieldRow>

      {form.channel === 'slack' && (
        <>
          <FieldRow
            label="Slack channel"
            hint={slackChannelHint(slackMode)}
          >
            <input
              type="text"
              value={form.slack_channel}
              onChange={(e) => setForm({ ...form, slack_channel: e.target.value })}
              disabled={busy || slackMode === 'webhook' || slackMode === 'none'}
              style={{
                width: '100%',
                opacity: slackMode === 'webhook' || slackMode === 'none' ? 0.5 : 1,
              }}
              placeholder="#channel  or  Cxxxxxxx"
            />
          </FieldRow>
          <FieldRow label="Tags" hint="Comma-separated, e.g. @alice, @bob">
            <input
              type="text"
              value={form.slack_tags}
              onChange={(e) => setForm({ ...form, slack_tags: e.target.value })}
              disabled={busy}
              style={{ width: '100%' }}
              placeholder="@user1, @user2"
            />
          </FieldRow>
        </>
      )}

      {form.channel === 'email' && (
        <>
          <FieldRow label="To" hint="Comma-separated">
            <input
              type="text"
              value={form.email_to}
              onChange={(e) => setForm({ ...form, email_to: e.target.value })}
              disabled={busy}
              style={{ width: '100%' }}
              placeholder="alice@example.com, bob@example.com"
            />
          </FieldRow>
          <FieldRow label="Cc" hint="Optional, comma-separated">
            <input
              type="text"
              value={form.email_cc}
              onChange={(e) => setForm({ ...form, email_cc: e.target.value })}
              disabled={busy}
              style={{ width: '100%' }}
            />
          </FieldRow>
          <FieldRow label="From" hint="Optional override">
            <input
              type="text"
              value={form.email_from}
              onChange={(e) => setForm({ ...form, email_from: e.target.value })}
              disabled={busy}
              style={{ width: '100%' }}
            />
          </FieldRow>
        </>
      )}

      {form.channel === 'desktop' && (
        <FieldRow label="Urgency" hint="Optional">
          <select
            value={form.desktop_urgency}
            onChange={(e) =>
              setForm({ ...form, desktop_urgency: e.target.value as FormState['desktop_urgency'] })
            }
            disabled={busy}
          >
            <option value="">(default)</option>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="critical">critical</option>
          </select>
        </FieldRow>
      )}

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
        <legend style={{ fontSize: 12, fontWeight: 500 }}>Filter (optional)</legend>
        <FieldRow
          label="Project"
          hint="Restricts the rule to events tagged to this project. Leave as (any) for a global rule that fires across all projects."
        >
          <select
            value={form.filter_project}
            onChange={(e) => setForm({ ...form, filter_project: e.target.value })}
            disabled={busy}
            style={{ width: '100%' }}
          >
            <option value="">(any — global rule)</option>
            {/* If filter_project is set to an id that isn't on disk (deleted
                project, typo in source file), keep it visible as an
                "(unknown)" option so the user can see it's there and fix it. */}
            {form.filter_project && !projectIds.includes(form.filter_project) && (
              <option value={form.filter_project}>
                {form.filter_project} (unknown — no matching project)
              </option>
            )}
            {projectIds.map((pid) => (
              <option key={pid} value={pid}>
                {projectTitles[pid] ? `${projectTitles[pid]} (${pid})` : pid}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Filter domain" hint="Restricts WHICH events trigger the rule — does NOT control where the rule is stored">
          <input
            type="text"
            value={form.filter_domain}
            onChange={(e) => setForm({ ...form, filter_domain: e.target.value })}
            disabled={busy}
            style={{ width: '100%' }}
          />
        </FieldRow>
        <FieldRow label="Severity">
          <select
            value={form.filter_severity}
            onChange={(e) =>
              setForm({ ...form, filter_severity: e.target.value as FormState['filter_severity'] })
            }
            disabled={busy}
          >
            <option value="">(any)</option>
            <option value="success">success</option>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="urgent">urgent</option>
          </select>
        </FieldRow>
      </fieldset>

      <FieldRow label="Rate-limit cap per day" hint="Blank = inherit global (100). Per-rule override only — server enforcement ships with the rate-limiter sibling.">
        <input
          type="number"
          min={1}
          value={form.cap_per_day}
          onChange={(e) => setForm({ ...form, cap_per_day: e.target.value })}
          disabled={busy}
          style={{ width: 120 }}
          placeholder="100"
        />
      </FieldRow>

      {fieldError && (
        <div
          className="tiny"
          style={{
            color: 'var(--danger-text)',
            background: 'var(--danger-bg, var(--bg-2))',
            border: '1px solid var(--danger-border)',
            borderRadius: 4,
            padding: '8px 12px',
          }}
        >
          <strong>{fieldError.field}:</strong> {fieldError.error}
        </div>
      )}

      {testResult && (
        <div
          className="tiny"
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div>
            <strong>Test-send result:</strong>{' '}
            <span
              style={{
                color:
                  testResult.adapter_result.status === 'ok'
                    ? 'var(--success-text)'
                    : 'var(--danger-text)',
              }}
            >
              {testResult.adapter_result.status}
            </span>
            {testResult.adapter_result.error && ` — ${testResult.adapter_result.error}`}
          </div>
          <div>
            <strong>Rendered title:</strong> {testResult.rendered.title}
          </div>
          <div>
            <strong>Rendered body:</strong> {testResult.rendered.body}
          </div>
        </div>
      )}

      <footer style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {!isCreate && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={doDelete}
            disabled={busy}
            style={{ color: 'var(--danger-text)' }}
            title="Delete this rule. Prefer disabling to preserve audit history."
          >
            <Icons.Trash size={11} /> Delete
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {isDirty && !isCreate && (
          <button type="button" className="btn btn-sm" onClick={discard} disabled={busy}>
            Discard changes
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={save}
          disabled={busy || (!isCreate && !isDirty)}
        >
          {isCreate ? 'Create' : 'Save'}
        </button>
      </footer>
    </div>
  );
};

function slackChannelHint(mode: SlackMode | null): string {
  if (mode == null) return 'Checking active Slack transport…';
  if (mode === 'bot-token') {
    return 'Accepts #channel-name or Cxxxxxxx channel ID. Bot must be invited to the channel (or have chat:write.public scope). chat.postMessage routes to whatever channel you specify here.';
  }
  if (mode === 'webhook') {
    return 'Disabled — webhook mode delivers to the channel chosen at app-install time; this field is ignored. Set SLACK_BOT_TOKEN in domains/meta/app/.env to enable per-rule channel routing.';
  }
  return 'Disabled — no Slack transport configured. Set SLACK_BOT_TOKEN (preferred) or SLACK_WEBHOOK_URL in domains/meta/app/.env to enable Slack delivery.';
}

const FieldRow: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 12, fontWeight: 500 }}>{label}</label>
    {children}
    {hint && <span className="tiny subtle">{hint}</span>}
  </div>
);
