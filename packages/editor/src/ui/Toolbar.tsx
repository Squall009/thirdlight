/**
 * Toolbar (React, decision 0001 §10) — create/delete box, undo/redo,
 * play/stop. Every action is an editing command delegated to the backend
 * (the browser never mutates files) or a play-lifecycle call.
 */
import type { JSX } from 'react';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  playing: boolean;
  /** The local snapping gesture option (never persisted — sessions.md §9). */
  snapping: boolean;
  onToggleSnapping: () => void;
  onNewBox: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPlay: () => void;
  onStop: () => void;
}

export function Toolbar(p: Props): JSX.Element {
  return (
    <div className="tl-toolbar">
      <span className="tl-toolbar__brand">Thirdlight</span>
      <div className="tl-toolbar__group">
        <button className="tl-btn" onClick={p.onNewBox} title="Create a box (root)">
          + box
        </button>
        <button className="tl-btn" onClick={p.onDelete} disabled={!p.selectedId} title="Delete the selected entity">
          delete
        </button>
      </div>
      <div className="tl-toolbar__group">
        <button className="tl-btn" onClick={p.onUndo} disabled={!p.canUndo} title="Undo">
          undo
        </button>
        <button className="tl-btn" onClick={p.onRedo} disabled={!p.canRedo} title="Redo">
          redo
        </button>
      </div>
      <div className="tl-toolbar__group">
        <button
          className={p.snapping ? 'tl-btn is-active' : 'tl-btn'}
          onClick={p.onToggleSnapping}
          title="Snap translate 0.25 m / rotate 15° / scale 0.25 — hold Shift to disable for one gesture"
        >
          snap{p.snapping ? ': on' : ': off'}
        </button>
      </div>
      <div className="tl-toolbar__spacer" />
      <div className="tl-toolbar__group">
        {p.playing ? (
          <button className="tl-btn tl-btn--stop" onClick={p.onStop} title="Stop the play preview">
            ■ stop
          </button>
        ) : (
          <button className="tl-btn tl-btn--play" onClick={p.onPlay} title="Start an isolated play preview">
            ▶ play
          </button>
        )}
      </div>
    </div>
  );
}