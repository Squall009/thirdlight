/**
 * The tool row under the menu bar: transform tools, snapping, and play/stop.
 * Creation, editing and history live in the menu bar.
 */
import type { JSX } from 'react';

import type { GizmoMode } from '../viewport/viewport';
import { actionIcon } from '../session/item-icons';

interface Props {
  projectId: string;
  onProjects: () => void;
  gizmoMode: GizmoMode;
  onGizmoMode: (mode: GizmoMode) => void;
  /** An edit mode shows: its tools own the Scene view (the transform tools and the tool windows stand aside). */
  editing?: boolean;
  playing: boolean;
  /** The local snapping gesture option (never persisted). */
  snapping: boolean;
  onToggleSnapping: () => void;
  /** The decal editor is open (the button opens and closes it). */
  decalTool?: boolean;
  onToggleDecalTool?: () => void;
  /** The Scene view's lighting — the fixed editor rig or the scene's own lights. */
  lighting?: 'editor' | 'game';
  onToggleLighting?: () => void;
  /** The Scene view's See-through preview (view only; the project's setting is what Play uses). */
  seeThrough?: boolean;
  onToggleSeeThrough?: () => void;
  onPlay: () => void;
  /** Open the "Play from…" dialog (a scene, variables, a save slot). */
  onPlayFrom?: () => void;
  onStop: () => void;
  /** The running Play's game mode (a project with modes). */
  playMode?: { current: string; name: string };
}

const TOOLS: ReadonlyArray<{ mode: GizmoMode; icon: string; title: string }> = [
  { mode: 'translate', icon: actionIcon('move'), title: 'Move tool (W)' },
  { mode: 'rotate', icon: actionIcon('rotate'), title: 'Rotate tool (E)' },
  { mode: 'scale', icon: actionIcon('scale'), title: 'Scale tool (R)' },
];

export function Toolbar(p: Props): JSX.Element {
  return (
    <div className="tl-toolbar">
      <button className="tl-btn tl-toolbar__project" onClick={p.onProjects} title="All projects">
        ◂ {p.projectId}
      </button>
      <div className="tl-toolbar__group" role="radiogroup" aria-label="Transform tool">
        {TOOLS.map((t) => (
          <button key={t.mode} role="radio" aria-checked={p.gizmoMode === t.mode} disabled={p.editing === true} className={`tl-btn tl-btn--tool${p.gizmoMode === t.mode ? ' is-active' : ''}`} onClick={() => p.onGizmoMode(t.mode)} title={t.title}>
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
        {p.onToggleDecalTool !== undefined && (
          <button className={p.decalTool === true ? 'tl-btn is-active' : 'tl-btn'} aria-pressed={p.decalTool === true} disabled={p.editing === true && p.decalTool !== true} onClick={p.onToggleDecalTool} title="The decal editor: place, scatter and select decals over the whole scene">
            decal
          </button>
        )}
        {p.lighting !== undefined && (
          <button
            className={p.lighting === 'game' ? 'tl-btn is-active' : 'tl-btn'}
            onClick={p.onToggleLighting}
            title="Scene view lighting: the scene's own lights (as in Play) or a fixed editor rig"
          >
            light: {p.lighting}
          </button>
        )}
        {p.onToggleSeeThrough !== undefined && (
          <button
            className={p.seeThrough === true ? 'tl-btn is-active' : 'tl-btn'}
            aria-pressed={p.seeThrough === true}
            onClick={p.onToggleSeeThrough}
            title="See-through preview: what stands between the camera and the selected object (or the camera's target) thins as in Play, with the project's see-through settings. Only this view; nothing is saved"
          >
            see-through{p.seeThrough === true ? ': on' : ': off'}
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
