/**
 * The editor's modal dialogs: Export game, Play from…, Snapping settings,
 * Keyboard shortcuts, Instance set and About.
 */
import type { JSX, MutableRefObject } from 'react';
import { readEditorConfig } from '../../config';
import { Dialog } from '../Dialog';
import type { GameMode, SaveSchema } from '@thirdlight/project-model';
import type { SceneHeaderView } from '../Hierarchy';
import { MODEL_KINDS, RefPicker } from '../catalog/RefPicker';
import { DEFAULT_SNAP_SETTINGS, saveSnapSettings, snapSettingError, type SnapSettings } from '../../session/snapping';
import type { EditorDialogsState } from './useEditorDialogs';

export interface EditorDialogsProps {
  dialogs: EditorDialogsState;
  cfg: MutableRefObject<ReturnType<typeof readEditorConfig>>;
  /** The project revision (About). */
  revision: number;
  sceneHeaders: SceneHeaderView[] | null;
  closedScenes: { sceneId: string; name: string }[];
  saveSchema: SaveSchema | null;
  modes: GameMode[];
  playing: boolean;
  setSnapSettingsState: (settings: SnapSettings) => void;
}

export function EditorDialogs(props: EditorDialogsProps): JSX.Element {
  const { cfg, sceneHeaders, closedScenes, saveSchema, modes, playing, setSnapSettingsState } = props;
  const { dialog, setDialog, playFromForm, setPlayFromForm, scatter, setScatter, exportState, snapDraft, setSnapDraft, exportGame, downloadExport, createInstanceSet, playFrom } = props.dialogs;
  const ui = { revision: props.revision };
  return (
    <>
    {dialog === 'export' && (
      <Dialog title="Export game" onClose={() => setDialog(null)}>
        <p>Builds the current revision into a standalone web game: a folder of static files that runs from any web server without Thirdlight.</p>
        {exportState.result === null ? (
          <button className="tl-btn" disabled={exportState.busy} onClick={() => void exportGame()}>
            {exportState.busy ? 'Exporting…' : 'Export now'}
          </button>
        ) : (
          <div className="tl-dialog__result">
            <p>
              Exported revision {exportState.result.revision}: {exportState.result.files} files in <code>{exportState.result.outputDir}</code> under the server's export root.
            </p>
            <button className="tl-btn" onClick={() => void downloadExport(exportState.result!.outputDir)}>
              Download zip
            </button>
          </div>
        )}
        {exportState.error ? <p className="tl-connect__message">{exportState.error}</p> : null}
      </Dialog>
    )}
    {dialog === 'playFrom' && (
      <Dialog title="Play from…" onClose={() => setDialog(null)}>
        <p>Start Play somewhere other than the game's start: at a scene (with the start scenes, at its first spawn), with script variables (the values the scripts read with ctx.save from the first step), or from one of Play's project save slots (a project with a save schema). MCP's tl_play_start takes the same options.</p>
        <div className="tl-exit">
          <label className="tl-field">
            <span className="tl-field__label">Scene</span>
            <select className="tl-input" aria-label="play from scene" value={playFromForm.sceneId} onChange={(e) => setPlayFromForm((f) => ({ ...f, sceneId: e.target.value, error: null }))}>
              <option value="">— the game's start —</option>
              {[...(sceneHeaders ?? []), ...closedScenes].map((sc) => (
                <option key={sc.sceneId} value={sc.sceneId}>
                  {sc.name}
                </option>
              ))}
            </select>
          </label>
          <label className="tl-field">
            <span className="tl-field__label">Variables (JSON object)</span>
            <textarea className="tl-input" aria-label="play from variables" rows={4} placeholder='{"gold": 100, "chapter": 2}' value={playFromForm.variables} onChange={(e) => setPlayFromForm((f) => ({ ...f, variables: e.target.value, error: null }))} />
          </label>
          {saveSchema !== null && (
            <label className="tl-field">
              <span className="tl-field__label">Save slot</span>
              <select className="tl-input" aria-label="play from save slot" value={playFromForm.saveSlot} onChange={(e) => setPlayFromForm((f) => ({ ...f, saveSlot: e.target.value, error: null }))}>
                <option value="">— none —</option>
                {Array.from({ length: Math.max(0, Math.min(99, saveSchema.slots)) }, (_, i) => String(i + 1)).map((n) => (
                  <option key={n} value={n}>
                    Slot {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {modes.length > 0 && (
            <label className="tl-field">
              <span className="tl-field__label">Game mode</span>
              <select className="tl-input" aria-label="play from game mode" value={playFromForm.mode} onChange={(e) => setPlayFromForm((f) => ({ ...f, mode: e.target.value, error: null }))}>
                <option value="">— the start mode —</option>
                {modes.map((m) => (
                  <option key={m.modeId} value={m.modeId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {playFromForm.error !== null && <p className="tl-dialog__error" role="alert">{playFromForm.error}</p>}
        <button className="tl-btn" disabled={playFromForm.busy || playing} onClick={() => void playFrom()}>
          {playFromForm.busy ? 'Starting…' : playing ? 'Stop Play first' : '▶ Play'}
        </button>
      </Dialog>
    )}
    {dialog === 'snapping' && snapDraft !== null && (
      <Dialog title="Snapping settings" onClose={() => setDialog(null)}>
        <div className="tl-snapform" aria-label="snapping settings">
          <p className="tl-note">Editor settings for this project in this browser (not project data). Shift held turns snapping off for one gesture.</p>
          {([['translateM', 'Move step (m)'], ['rotateDeg', 'Rotate step (°)'], ['scale', 'Scale step']] as const).map(([k, label]) => (
            <label key={k} className="tl-snapform__row">
              <span>{label}</span>
              <input aria-label={label} type="number" step="any" value={snapDraft[k]} onChange={(e) => setSnapDraft({ ...snapDraft, [k]: e.target.value })} />
              {snapSettingError(k, Number(snapDraft[k])) !== null && <span className="tl-prop__error">{snapSettingError(k, Number(snapDraft[k]))}</span>}
            </label>
          ))}
          <label className="tl-snapform__row">
            <input type="checkbox" aria-label="snap to cell tops" checked={snapDraft.cellTops} onChange={(e) => setSnapDraft({ ...snapDraft, cellTops: e.target.checked })} />
            <span>Snap objects to block cell tops (moved and dropped objects land on the block layer under them)</span>
          </label>
          <div className="tl-dialog__actions">
            <button className="tl-btn" onClick={() => setSnapDraft({ translateM: String(DEFAULT_SNAP_SETTINGS.translateM), rotateDeg: String(DEFAULT_SNAP_SETTINGS.rotateDeg), scale: String(DEFAULT_SNAP_SETTINGS.scale), cellTops: false })}>
              Defaults
            </button>
            <button
              className="tl-btn"
              disabled={(['translateM', 'rotateDeg', 'scale'] as const).some((k) => snapSettingError(k, Number(snapDraft[k])) !== null)}
              onClick={() => {
                setSnapSettingsState(saveSnapSettings(window.localStorage, cfg.current.ok ? cfg.current.config.projectId : 'default', { translateM: Number(snapDraft.translateM), rotateDeg: Number(snapDraft.rotateDeg), scale: Number(snapDraft.scale), cellTops: snapDraft.cellTops }));
                setDialog(null);
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Dialog>
    )}
    {dialog === 'shortcuts' && (
      <Dialog title="Keyboard shortcuts" onClose={() => setDialog(null)}>
        <table className="tl-shortcuts">
          <tbody>
            {[
              ['W / E / R', 'Move / rotate / scale tool'],
              ['F', 'Frame the selection'],
              ['Delete, Backspace', 'Delete the selection'],
              ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
              ['Shift+F11', 'Full screen'],
              ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab of the editor window (Scene / Game without it)'],
              ['Middle-click a tab', 'Close an item of the editor window'],
              ['Double-click an item in the project window', 'Open it in the editor window'],
              ['Esc (editor window)', 'Back to the Scene, with the selection it had'],
              ['Shift (held)', 'Disable snapping for one gesture'],
              ['PageUp / PageDown, ] / [', 'Blocks: move the height slice'],
              ['Q', 'Blocks: turn the brush'],
              ['Alt+drag, right-drag', 'Blocks: orbit while the block tools are on'],
              ['Escape', 'Cancel a gesture / clear the selection / close a menu'],
              ['Double-click a name', 'Rename in the hierarchy'],
              ['Drag a row onto another', 'Reparent'],
            ].map(([k, v]) => (
              <tr key={k}>
                <td><kbd>{k}</kbd></td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    )}
    {dialog === 'instances' && (
      <Dialog title="Instance set" onClose={() => setDialog(null)}>
        <p>Many copies of one model as a single object (drawn with instancing): good for foliage, rocks and other repeated detail. The copies are spread on the ground plane around the point the camera looks at.</p>
        <div className="tl-scatter">
          <label className="tl-field">
            <span className="tl-field__label">Model</span>
            <RefPicker aria="instance model" kinds={MODEL_KINDS} value={scatter.assetId} none="— select —" onPick={(id) => setScatter((f) => ({ ...f, assetId: id }))} />
          </label>
          {(
            [
              ['count', 'Copies'],
              ['width', 'Width (X, m)'],
              ['depth', 'Depth (Z, m)'],
              ['scaleMin', 'Min scale'],
              ['scaleMax', 'Max scale'],
              ['seed', 'Seed'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="tl-field">
              <span className="tl-field__label">{label}</span>
              <input className="tl-input" type="number" aria-label={label} value={scatter[key]} onChange={(e) => setScatter((f) => ({ ...f, [key]: e.target.value }))} />
            </label>
          ))}
          <label className="tl-field tl-field--inline">
            <input type="checkbox" checked={scatter.randomYaw} onChange={(e) => setScatter((f) => ({ ...f, randomYaw: e.target.checked }))} />
            <span className="tl-field__label">Random turn</span>
          </label>
        </div>
        {scatter.error !== null && <p className="tl-dialog__error" role="alert">{scatter.error}</p>}
        <button className="tl-btn" disabled={scatter.busy} onClick={() => void createInstanceSet()}>
          {scatter.busy ? 'Creating…' : 'Create instance set'}
        </button>
      </Dialog>
    )}
    {dialog === 'about' && (
      <Dialog title="About Thirdlight" onClose={() => setDialog(null)}>
        <p>Thirdlight engine 0.1.0 — a self-hosted browser game editor on three.js.</p>
        <p>Project: <code>{cfg.current.ok ? cfg.current.config.projectId : ''}</code> · revision {ui.revision}</p>
        <p>Backend: <code>{window.location.origin}</code></p>
      </Dialog>
    )}
    </>
  );
}
