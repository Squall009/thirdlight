/**
 * A mode's tools as a grid of tiles — a glyph over a plain label, the key
 * that picks it in the corner — the first section of an edit mode's column
 * in every editor. The picked tile is the state colour. Letter keys pick a
 * tile (`toolKeyOf`: never C, F or X, which the shared key map owns).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, type JSX } from 'react';

import { toolKeyOf } from '../../session/edit-keys';
import { isTyping } from '../workspace/EditorWindow';
import { Glyph } from './glyphs';

export interface ToolTile {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
  /** The key shown on the tile (a letter). */
  readonly key?: string;
  /** What the tool does (the tooltip). */
  readonly hint?: string;
}

export function ToolGrid({ tools, active, onPick, aria, cols = 3, disabled }: { tools: readonly ToolTile[]; active: string; onPick: (id: string) => void; aria: string; cols?: number; disabled?: boolean }): JSX.Element {
  const latest = useRef({ tools, onPick, disabled });
  latest.current = { tools, onPick, disabled };
  // Captured before the shell's own keys, as the palette's digits are.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const q = latest.current;
      if (e.defaultPrevented || q.disabled === true || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null) return;
      const k = toolKeyOf(e);
      const t = k === null ? undefined : q.tools.find((x) => x.key === k);
      if (t === undefined) return;
      e.preventDefault();
      q.onPick(t.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="tl-toolgrid" role="toolbar" aria-label={aria} style={{ ['--cols' as string]: String(cols) }}>
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tl-tool${t.id === active ? ' is-active' : ''}`}
          aria-pressed={t.id === active}
          title={t.hint !== undefined ? `${t.label}${t.key !== undefined ? ` (${t.key})` : ''}: ${t.hint}` : t.label}
          disabled={disabled}
          onClick={() => onPick(t.id)}
        >
          <Glyph name={t.glyph} size={22} />
          <span>{t.label}</span>
          {t.key !== undefined && (
            <kbd className="tl-kbd" aria-hidden="true">
              {t.key}
            </kbd>
          )}
        </button>
      ))}
    </div>
  );
}
