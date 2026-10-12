/**
 * The edit mode's header: what is edited and how to leave.
 *
 * Left, the object's icon over its editor's name and the object's name, and
 * a small fact about it (a terrain's tiles). Right, the mode's own extras,
 * the Context toggle (the rest of the scene shown, not pickable), undo and
 * redo of the one history, and Done (Esc). The brand-coloured stripe on top
 * says a mode is open.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import { Glyph } from './glyphs';
import { Kbd } from './Kbd';

export interface EditModeHeaderProps {
  /** The object's icon (an image URL) and the icon's title. */
  icon: string;
  iconTitle: string;
  /** "Terrain editor". */
  editorLabel: string;
  objectName: string;
  meta?: string;
  /** The mode's own controls, before Context. */
  extra?: ReactNode;
  context: boolean;
  onContext: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
}

export function EditModeHeader(p: EditModeHeaderProps): JSX.Element {
  return (
    <header className="tl-emh" aria-label="edit mode header">
      <img className="tl-emh__icon" src={p.icon} alt="" title={p.iconTitle} />
      <div className="tl-emh__title">
        <span className="tl-emh__editor">{p.editorLabel}</span>
        <span className="tl-emh__name" aria-label="edited object">
          {p.objectName}
        </span>
      </div>
      {p.meta !== undefined && <span className="tl-emh__meta">{p.meta}</span>}
      <span className="tl-emh__spacer" />
      {p.extra}
      <button
        type="button"
        className={`tl-chipbtn${p.context ? ' is-on' : ''}`}
        aria-pressed={p.context}
        aria-label="Context"
        title="Show the rest of the scene around it (it cannot be picked) (C)"
        onClick={p.onContext}
      >
        <Glyph name="ghost" size={16} />
        Context
        <Kbd k="C" />
      </button>
      <span className="tl-emh__sep" />
      <button type="button" className="tl-iconbtn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}>
        <Glyph name="undo" size={18} />
      </button>
      <button type="button" className="tl-iconbtn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!p.canRedo} onClick={p.onRedo}>
        <Glyph name="redo" size={18} />
      </button>
      <span className="tl-emh__sep" />
      <button type="button" className="tl-done" title="Back to the Scene (Esc)" onClick={p.onDone}>
        <Glyph name="check" size={16} />
        Done
        <Kbd k="Esc" />
      </button>
    </header>
  );
}
