import type React from 'react';
import { isValidElement, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigation } from '../lib/navigation';
import { fetchSkillNames } from '../lib/skills';
import { MermaidDiagram } from './MermaidDiagram';

interface Props {
  // Repo-relative path; what /api/edit will write to.
  path: string;
  // Current content from the server. When this changes (e.g. user selects a
  // different file), the editor resets.
  content: string;
  // Optional callback after a successful save.
  onSaved?: (newContent: string) => void;
}

// Split a markdown file into its frontmatter (raw YAML string) and body.
function splitFrontmatter(content: string): { fm: string; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: '', body: content };
  return { fm: m[1], body: m[2] };
}

const WIKILINK_HREF_PREFIX = 'wiki://';

// Convert [[entry-id]] occurrences to clickable links with a sentinel href
// scheme, which the link renderer below intercepts.
function preprocessWikilinks(body: string): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
    const id = raw.trim();
    return `[${id}](${WIKILINK_HREF_PREFIX}${encodeURIComponent(id)})`;
  });
}

// View/edit toggle for markdown files. Save POSTs the draft to /api/edit
// (which enforces the path allowlist on the backend).
export function EditableMarkdown({ path, content, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset when path or upstream content changes.
  useEffect(() => {
    setEditing(false);
    setDraft(content);
    setErr(null);
  }, [path, content]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content: draft }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      setEditing(false);
      onSaved?.(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="detail-toolbar">
        {!editing ? (
          <button
            onClick={() => {
              setDraft(content);
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : (
          <>
            <button className="primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setDraft(content);
                setErr(null);
              }}
            >
              Cancel
            </button>
          </>
        )}
        {err && <span className="err">{err}</span>}
      </div>
      {editing ? (
        <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <Rendered content={content} />
      )}
    </>
  );
}

export function Rendered({ content }: { content: string }) {
  const nav = useNavigation();
  const { fm, body } = useMemo(() => splitFrontmatter(content), [content]);
  const processed = useMemo(() => preprocessWikilinks(body), [body]);

  // Cache the set of known skill names so wikilinks can resolve polymorphically:
  // [[name]] routes to Skills view when `name` is a skill, else to Vault.
  // Cached at fetchSkills() level — same fetch as Skills view + Quick Actions.
  const [skillNames, setSkillNames] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    fetchSkillNames()
      .then(setSkillNames)
      .catch(() => {
        /* leave empty — wikilinks fall back to Vault navigation */
      });
  }, []);

  // Custom renderers:
  // - <a>: intercept wiki:// links and route through the navigation context
  // - <pre>: detect fenced ```mermaid blocks and render via MermaidDiagram
  const components = useMemo(
    () => ({
      a({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
        if (href?.startsWith(WIKILINK_HREF_PREFIX)) {
          const id = decodeURIComponent(href.slice(WIKILINK_HREF_PREFIX.length));
          const isSkill = skillNames.has(id);
          return (
            <button
              type="button"
              className={isSkill ? 'wikilink wikilink-skill' : 'wikilink'}
              onClick={() => (isSkill ? nav.navigateToSkill(id) : nav.navigateToEntry(id))}
              title={isSkill ? `Open ${id} in Skills` : `Open ${id} in Vault`}
            >
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...rest}>
            {children}
          </a>
        );
      },
      pre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
        // react-markdown wraps fenced code blocks as <pre><code class="language-X">...</code></pre>.
        // If the inner code is a mermaid block, render via MermaidDiagram instead of <pre>.
        // For other fenced blocks, extract the language from the className and
        // render a small uppercase badge in the corner so the reader can tell
        // at-a-glance what language the snippet is.
        if (isValidElement(children)) {
          const codeProps = children.props as {
            className?: string;
            children?: React.ReactNode;
          };
          if (codeProps.className === 'language-mermaid') {
            const source = String(codeProps.children ?? '').replace(/\n$/, '');
            return <MermaidDiagram source={source} />;
          }
          // Match `language-<lang>` (the convention react-markdown uses for
          // fenced blocks like ```go). Unfenced inline code has no className.
          const langMatch = codeProps.className?.match(/^language-([\w-]+)/);
          if (langMatch) {
            return (
              <pre {...rest} className="rendered-code-block" data-lang={langMatch[1]}>
                {children}
              </pre>
            );
          }
        }
        return <pre {...rest}>{children}</pre>;
      },
    }),
    [nav, skillNames],
  );

  return (
    <article className="rendered">
      {fm && (
        <details className="frontmatter">
          <summary>Metadata</summary>
          <pre>{fm}</pre>
        </details>
      )}
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {processed}
        </ReactMarkdown>
      </div>
    </article>
  );
}
