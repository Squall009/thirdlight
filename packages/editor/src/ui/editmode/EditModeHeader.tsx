/**
 * The edit mode's header: what is edited and how to leave.
 *
 * Left, the object's icon over its editor's name and the object's name, and
 * a small fact about it (a terrain's tiles). Right, the mode's own extras,
 * a note (a scene's mode: what can be picked), the Context toggle (an
 * object's mode: the rest of the scene shown, not pickable), undo and
 * redo of the one history, and Done (Esc; its badge dims while Esc would
 * first deselect or drop the tool). The brand-coloured stripe on top says a
 * mode is open.
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
  /** The Context toggle (absent: none — a scene's mode already shows the whole scene). */
  context?: boolean;
  onContext?: () => void;
  /** A note before undo ("Only decals can be picked"). */
  note?: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
  /** Esc would leave now (else it deselects or drops the tool first). */
  escLeaves: boolean;
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
      {p.note !== undefined && (
        <span className="tl-emh__note">
          <Glyph name="info" size={14} />
          {p.note}
        </span>
      )}
      {p.onContext !== undefined && (
        <button
          type="button"
          className={`tl-chipbtn${p.context === true ? ' is-on' : ''}`}
          aria-pressed={p.context === true}
          aria-label="Context"
          title="Show the rest of the scene around it (it cannot be picked) (C)"
          onClick={p.onContext}
        >
          <Glyph name="ghost" size={16} />
          Context
          <Kbd k="C" />
        </button>
      )}
      <span className="tl-emh__sep" />
      <button type="button" className="tl-iconbtn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}>
        <Glyph name="undo" size={18} />
      </button>
      <button type="button" className="tl-iconbtn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!p.canRedo} onClick={p.onRedo}>
        <Glyph name="redo" size={18} />
      </button>
      <span className="tl-emh__sep" />
      <button type="button" className="tl-done" title={p.escLeaves ? 'Back to the Scene (Esc)' : 'Back to the Scene (Esc leaves once nothing is selected and no tool is armed)'} onClick={p.onDone}>
        <Glyph name="check" size={16} />
        Done
        <kbd className={`tl-kbd${p.escLeaves ? '' : ' is-dim'}`} data-esc-leaves={String(p.escLeaves)}>
          Esc
        </kbd>
      </button>
    </header>
  );
}
