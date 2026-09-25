/**
 * Phase 9.7 / 16.2: the bottom-dock Animator — the project's animator
 * controllers as a list. A controller opens as a centre tab
 * ("Animator: <controller>", the state-graph editor: AnimatorDocument) with
 * a double-click, Enter or **Open**; "New controller" and "New from clips:
 * Platformer" create one from the chosen model's clips and open it. Every
 * edit is one command (`setAnimator` / `deleteAnimator`; the graph itself
 * is edited with `graphEdit` in the tab).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { AnimatorController } from '@thirdlight/project-model';

import { newId, platformerController, type AnimatorModels, type BoneInfo, type ClipInfo, type StartPreview } from './animator/parts';

export type { AnimatorPreview, BoneInfo, ClipInfo } from './animator/parts';
export { platformerController } from './animator/parts';

export interface AnimatorPanelProps {
  controllers: AnimatorController[];
  /** Open a controller in its own centre tab. */
  onOpen: (controllerId: string) => void;
  /** Start a live preview of `controller` in `canvas`, or say why not. */
  preview?: StartPreview;
  /** Model assets; `clipsFor` marks an animation-only file whose clips play on that model (phase 14.6). */
  models: AnimatorModels;
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
  /** Phase 14.6: the model's skeleton (its bones, or its nodes when it has none). */
  skeletonOf?: (assetId: string) => Promise<BoneInfo[]>;
  onSave: (controller: AnimatorController) => void;
  onDelete: (controllerId: string) => void;
  error: string | null;
}

export function AnimatorPanel(p: AnimatorPanelProps): JSX.Element {
  const rigs = p.models.filter((m) => m.clipsFor === undefined);
  const [model, setModel] = useState<string>(rigs[0]?.assetId ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(p.controllers[0]?.controllerId ?? null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (model === '' && rigs[0] !== undefined) setModel(rigs[0].assetId);
  }, [rigs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedId === null || !p.controllers.some((c) => c.controllerId === selectedId)) setSelectedId(p.controllers[0]?.controllerId ?? null);
  }, [p.controllers.map((c) => c.controllerId).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = p.controllers.find((c) => c.controllerId === selectedId) ?? null;

  const create = async (preset: 'empty' | 'platformer'): Promise<void> => {
    setMessage(null);
    if (model === '') return setMessage('import a model with animation clips first');
    const list = await p.clipsOf(model);
    if (list.length === 0) return setMessage('this model has no animation clips');
    const id = newId('animator', p.controllers.map((c) => c.controllerId));
    let c: AnimatorController | string;
    if (preset === 'platformer') c = platformerController(id, model, list);
    else
      c = {
        controllerId: id,
        name: 'New animator',
        parameters: [{ name: 'speed', type: 'float', default: 0 }],
        states: [{ id: 'state-01', name: list[0]!.name, motion: { kind: 'clip', clip: { assetId: model, clip: list[0]!.name, duration: Math.max(0.001, list[0]!.duration) } }, speed: 1, loop: true, position: [180, 40] }],
        transitions: [],
        entry: 'state-01',
        events: [],
      };
    if (typeof c === 'string') return setMessage(c);
    p.onSave(c);
    setSelectedId(c.controllerId);
    // The new controller opens in its tab once the backend has it (the tab shows it when it arrives).
    p.onOpen(c.controllerId);
  };

  return (
    <div className="tl-panel tl-animator" aria-label="animator">
      <div className="tl-animator__bar">
        <select className="tl-input" aria-label="animator model" value={model} onChange={(e) => setModel(e.target.value)} title="The model whose clips a new controller uses">
          {rigs.length === 0 && <option value="">— no model —</option>}
          {rigs.map((m) => (
            <option key={m.assetId} value={m.assetId}>
              {m.displayName}
            </option>
          ))}
        </select>
        <button type="button" className="tl-button" onClick={() => void create('empty')}>
          New controller
        </button>
        <button type="button" className="tl-button" onClick={() => void create('platformer')} title="States and transitions for clips named idle/run/jump/fall/land">
          New from clips: Platformer
        </button>
        {selected !== null && (
          <>
            <button type="button" className="tl-button" onClick={() => p.onOpen(selected.controllerId)} title="Edit this controller in its tab in the centre area">
              Open in tab
            </button>
            <button type="button" className="tl-button" onClick={() => p.onDelete(selected.controllerId)}>
              Delete controller
            </button>
          </>
        )}
      </div>
      {(message ?? p.error) !== null && (
        <p className="tl-lighting__message" role="alert">
          {message ?? p.error}
        </p>
      )}
      {p.controllers.length === 0 ? (
        <p className="tl-hint">No animator controllers yet: pick a model with clips and create one.</p>
      ) : (
        <ul className="tl-animator__list" aria-label="animator controllers" title="Double-click (or Enter) to open in a centre tab">
          {p.controllers.map((c) => {
            const states = [c, ...(c.layers ?? [])].reduce((n, l) => n + l.states.length, 0);
            return (
              <li key={c.controllerId}>
                <button
                  type="button"
                  className={`tl-button${c.controllerId === selectedId ? ' is-active' : ''}`}
                  aria-pressed={c.controllerId === selectedId}
                  title={`${states} state${states === 1 ? '' : 's'}, ${c.parameters.length} parameter${c.parameters.length === 1 ? '' : 's'}${(c.layers ?? []).length > 0 ? `, ${c.layers!.length + 1} layers` : ''}`}
                  onClick={() => setSelectedId(c.controllerId)}
                  onDoubleClick={() => p.onOpen(c.controllerId)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), p.onOpen(c.controllerId))}
                >
                  {c.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
