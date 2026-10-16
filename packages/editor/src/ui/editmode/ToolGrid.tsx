/**
 * A mode's tools as a grid of tiles — a glyph over a plain label, the key
 * that picks it in the corner — the first section of an edit mode's column
 * in every editor. The picked tile is the state colour. Letter keys pick a
 * tile (`toolKeyOf`: never C, F or X, which the shared key map owns).
 *
 * In an editor the grid starts with the Navigate tile (no tool: a drag
 * orbits, a click selects), lit while no tool is armed; the remembered tile
 * then wears a "last" mark (Space arms it again). Picking a tile, by click
 * or letter, arms it; a click on the armed tile drops it. A press on a tile
 * never takes the keyboard focus, so Space and the letters keep reaching the
 * editor.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, type JSX } from 'react';

import { toolKeyOf } from '../../session/edit-keys';
import { isTyping } from '../workspace/EditorWindow';
import { useEditTool, useToolGridPresence } from './edit-tool';
import { Glyph } from './glyphs';

/** The Navigate tile's id (no tile of a mode's own uses it). */
export const NAVIGATE_TILE = 'navigate';

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
  const edit = useEditTool();
  const armed = edit?.armed ?? true;
  const remembered = tools.find((t) => t.id === active);
  useToolGridPresence(remembered?.label ?? null, disabled !== true);
  const pick = (id: string): void => {
    if (edit === null) return onPick(id);
    if (armed && id === active) return edit.drop();
    onPick(id);
    edit.arm();
  };
  const latest = useRef({ tools, pick, disabled, active, armed });
  latest.current = { tools, pick, disabled, active, armed };
  // Captured before the shell's own keys, as the palette's digits are.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const q = latest.current;
      if (e.defaultPrevented || q.disabled === true || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null) return;
      const k = toolKeyOf(e);
      const t = k === null ? undefined : q.tools.find((x) => x.key === k);
      if (t === undefined) return;
      e.preventDefault();
      // A letter arms its tool (the armed tool's own letter keeps it armed).
      if (!(q.armed && t.id === q.active)) q.pick(t.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const tile = (t: ToolTile, lit: boolean, cls: string, onClick: () => void, keyLabel: string | undefined, last: boolean): JSX.Element => (
    <button
      key={t.id}
      type="button"
      className={`tl-tool${cls}${lit ? ' is-active' : ''}${last ? ' is-last' : ''}`}
      aria-pressed={lit}
      title={t.hint !== undefined ? `${t.label}${keyLabel !== undefined ? ` (${keyLabel})` : ''}: ${t.hint}` : t.label}
      disabled={disabled === true && t.id !== NAVIGATE_TILE}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {last && (
        <i className="tl-tool__last" aria-hidden="true">
          last
        </i>
      )}
      <Glyph name={t.glyph} size={22} />
      <span>{t.label}</span>
      {keyLabel !== undefined && (
        <kbd className="tl-kbd" aria-hidden="true">
          {keyLabel}
        </kbd>
      )}
    </button>
  );
  return (
    <>
      <div className="tl-toolgrid" role="toolbar" aria-label={aria} style={{ ['--cols' as string]: String(cols) }}>
        {edit !== null && tile({ id: NAVIGATE_TILE, label: 'Navigate', glyph: 'navigate', hint: `No tool. ${edit.hint}` }, !armed, ' tl-tool--nav', () => edit.drop(), 'Esc', false)}
        {tools.map((t) => tile(t, armed && t.id === active, '', () => pick(t.id), t.key, !armed && edit !== null && t.id === active))}
      </div>
      {edit !== null && !armed && (
        <p className="tl-navnote" aria-label="navigate">
          <Glyph name="navigate" size={14} />
          <span>
            <b>No tool:</b> {edit.hint} Pick a tool or press its letter; <kbd className="tl-kbd">Esc</kbd> again leaves.
          </span>
        </p>
      )}
    </>
  );
}
