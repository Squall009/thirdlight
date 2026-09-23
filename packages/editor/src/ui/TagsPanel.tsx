/**
 * Project tags (phase 12 b; project settings): up to 32 named tags, each with
 * a fixed bit. Renaming keeps the bit; a new tag takes the lowest free bit; a
 * tag an object still carries cannot be removed. Every edit is one `setTags`
 * command (the whole registry), issued by the app.
 */
import { useState, type JSX } from 'react';

export interface TagView {
  bit: number;
  name: string;
}

interface Props {
  tags: readonly TagView[];
  /** How many entities carry each bit themselves (the bit is freed only at 0). */
  usage: ReadonlyMap<number, number>;
  error: string | null;
  onSetTags: (tags: { bit?: number; name: string }[]) => void;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function TagsPanel({ tags, usage, error, onSetTags }: Props): JSX.Element {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ bit: number; name: string } | null>(null);
  const valid = (name: string, exceptBit?: number): string | null => {
    if (!NAME_RE.test(name)) return 'a letter, then letters, digits, _ or - (up to 32)';
    if (tags.some((t) => t.bit !== exceptBit && t.name.toLowerCase() === name.toLowerCase())) return 'that name is taken';
    return null;
  };
  const add = (): void => {
    const name = draft.trim();
    if (valid(name) !== null || tags.length >= 32) return;
    onSetTags([...tags.map((t) => ({ bit: t.bit, name: t.name })), { name }]);
    setDraft('');
  };
  const commitRename = (): void => {
    if (editing === null) return;
    const name = editing.name.trim();
    const current = tags.find((t) => t.bit === editing.bit);
    setEditing(null);
    if (current === undefined || name === current.name || valid(name, editing.bit) !== null) return;
    onSetTags(tags.map((t) => ({ bit: t.bit, name: t.bit === editing.bit ? name : t.name })));
  };
  const draftProblem = draft.trim() === '' ? null : valid(draft.trim());
  return (
    <div className="tl-panel tl-tags" aria-label="project tags">
      <div className="tl-panel__title">Tags — {tags.length} / 32</div>
      <p className="tl-tags__hint">
        A tag keeps its bit for life: renaming keeps it on every object. Folders pass their tags to everything inside. Scripts query objects by tag (<code>ctx.tags</code>).
      </p>
      <ul className="tl-tags__list">
        {tags.map((t) => {
          const used = usage.get(t.bit) ?? 0;
          return (
            <li key={t.bit} className="tl-tags__row" data-tag={t.name}>
              <span className="tl-tags__bit" title="bit">#{t.bit}</span>
              {editing?.bit === t.bit ? (
                <input
                  className="tl-tags__name-input"
                  aria-label={`rename tag ${t.name}`}
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ bit: t.bit, name: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <button className="tl-tags__name" title="rename" onClick={() => setEditing({ bit: t.bit, name: t.name })}>
                  {t.name}
                </button>
              )}
              <span className="tl-tags__used">{used === 0 ? 'unused' : `on ${used} object${used === 1 ? '' : 's'}`}</span>
              <button
                className="tl-btn"
                aria-label={`remove tag ${t.name}`}
                disabled={used > 0}
                title={used > 0 ? 'remove it from every object first (its bit is still in use)' : 'remove this tag (frees its bit)'}
                onClick={() => onSetTags(tags.filter((x) => x.bit !== t.bit).map((x) => ({ bit: x.bit, name: x.name })))}
              >
                remove
              </button>
            </li>
          );
        })}
        {tags.length === 0 && <li className="tl-row--empty">no tags yet</li>}
      </ul>
      <div className="tl-tags__add">
        <input
          aria-label="new tag name"
          placeholder="new tag…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button className="tl-btn" onClick={add} disabled={draft.trim() === '' || draftProblem !== null || tags.length >= 32}>
          add tag
        </button>
        {draftProblem !== null && <span className="tl-prop__error">{draftProblem}</span>}
      </div>
      {error !== null && <div className="tl-prop__error">{error}</div>}
    </div>
  );
}
