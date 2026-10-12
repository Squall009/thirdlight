/**
 * The edit mode's left rail: the editor's modes, one glyph and a plain label
 * each, with the key that picks it (Shift+number). The active mode is the
 * state colour with a bar on the rail's edge.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { EDIT_MODE_KEYS } from '../../session/edit-keys';
import { Glyph } from './glyphs';

export interface RailItem {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
}

export function ToolRail({ items, active, onPick }: { items: readonly RailItem[]; active: string; onPick: (id: string) => void }): JSX.Element {
  return (
    <nav className="tl-rail" role="tablist" aria-label="editor modes" aria-orientation="vertical">
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={it.id === active}
          className={`tl-rail__item${it.id === active ? ' is-active' : ''}`}
          title={i < EDIT_MODE_KEYS ? `${it.label} (Shift+${i + 1})` : it.label}
          onClick={() => onPick(it.id)}
        >
          <Glyph name={it.glyph} size={22} />
          <span className="tl-rail__label">{it.label}</span>
          {i < EDIT_MODE_KEYS && (
            <kbd className="tl-kbd tl-rail__key" aria-hidden="true">
              ⇧{i + 1}
            </kbd>
          )}
        </button>
      ))}
    </nav>
  );
}
