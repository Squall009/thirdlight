/**
 * The tool row under the menu bar: transform tools, snapping, and play/stop.
 * Creation, editing and history live in the menu bar.
 */
import type { JSX } from 'react';

import type { GizmoMode } from '../viewport/viewport';

interface Props {
  projectId: string;
  onProjects: () => void;
  gizmoMode: GizmoMode;
  onGizmoMode: (mode: GizmoMode) => void;
  playing: boolean;
  /** The local snapping gesture option (never persisted — sessions.md §9). */
  snapping: boolean;
  onToggleSnapping: () => void;
  /** Phase 9.5: the Scene view's lighting — the fixed editor rig or the scene's own lights. */
  lighting?: 'editor' | 'game';
  onToggleLighting?: () => void;
  onPlay: () => void;
  /** Phase 23.8: open the "Play from…" dialog (a scene, variables, a save slot). */
  onPlayFrom?: () => void;
  onStop: () => void;
  /** Phase 23.10: the running Play's game mode (a project with modes). */
  playMode?: { current: string; name: string };
}

const TOOLS: ReadonlyArray<{ mode: GizmoMode; icon: string; title: string }> = [
  { mode: 'translate', icon: './icons/move.png', title: 'Move tool (W)' },
  { mode: 'rotate', icon: './icons/rotate.png', title: 'Rotate tool (E)' },
  { mode: 'scale', icon: './icons/scale.png', title: 'Scale tool (R)' },
];

export function Toolbar(p: Props): JSX.Element {
  return (
    <div className="tl-toolbar">
      <button className="tl-btn tl-toolbar__project" onClick={p.onProjects} title="All projects">
        ◂ {p.projectId}
      </button>
      <div className="tl-toolbar__group" role="radiogroup" aria-label="Transform tool">
        {TOOLS.map((t) => (
          <button key={t.mode} role="radio" aria-checked={p.gizmoMode === t.mode} className={`tl-btn tl-btn--tool${p.gizmoMode === t.mode ? ' is-active' : ''}`} onClick={() => p.onGizmoMode(t.mode)} title={t.title}>
            <img className="tl-btn__icon" src={t.icon} alt="" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="tl-toolbar__group">
        <button
          className={p.snapping ? 'tl-btn is-active' : 'tl-btn'}
          onClick={p.onToggleSnapping}
          title="Snap translate 0.25 m / rotate 15° / scale 0.25 — hold Shift to disable for one gesture"
        >
          snap{p.snapping ? ': on' : ': off'}
        </button>
        {p.lighting !== undefined && (
          <button
            className={p.lighting === 'game' ? 'tl-btn is-active' : 'tl-btn'}
            onClick={p.onToggleLighting}
            title="Scene view lighting: the scene's own lights (as in Play) or a fixed editor rig"
          >
            light: {p.lighting}
          </button>
        )}
      </div>
      <div className="tl-toolbar__spacer" />
      <div className="tl-toolbar__group">
        {p.playing ? (
          <>
            {p.playMode !== undefined && (
              <span className="tl-toolbar__mode" data-play-mode={p.playMode.current} title="The game mode the running Play is in">
                mode: {p.playMode.name !== '' ? p.playMode.name : p.playMode.current}
              </span>
            )}
            <button className="tl-btn tl-btn--stop" onClick={p.onStop} title="Stop the play preview">
              ■ stop
            </button>
          </>
        ) : (
          <>
            <button className="tl-btn tl-btn--play" onClick={p.onPlay} title="Start an isolated play preview">
              ▶ play
            </button>
            {p.onPlayFrom !== undefined && (
              <button className="tl-btn" onClick={p.onPlayFrom} title="Play from a scene, with script variables or from a save slot">
                play from…
              </button>
            )}
          </>
        )}
      </div>
      <div className="tl-toolbar__spacer" />
    </div>
  );
}
