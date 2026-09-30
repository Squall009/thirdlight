/**
 * The bottom-dock Animator — the project's animator
 * controllers as a list. A controller opens as a centre tab
 * ("Animator: <controller>", the state-graph editor: AnimatorDocument) with
 * a double-click, Enter or **Open**; "New controller" and "New from clips:
 * Character locomotion" create one from the chosen model's clips and open it. Every
 * edit is one command (`setAnimator` / `deleteAnimator`; the graph itself
 * is edited with `graphEdit` in the tab).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { AnimatorController } from '@thirdlight/project-model';

import { newId, locomotionController, type BoneInfo, type ClipInfo, type StartPreview } from './animator/parts';
import { MODEL_KINDS, RefPicker, useFirstEntry } from './catalog/RefPicker';

export type { AnimatorPreview, BoneInfo, ClipInfo } from './animator/parts';
export { locomotionController } from './animator/parts';

export interface AnimatorPanelProps {
  controllers: AnimatorController[];
  /** Open a controller in its own centre tab. */
  onOpen: (controllerId: string) => void;
  /** Start a live preview of `controller` in `canvas`, or say why not. */
  preview?: StartPreview;
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
  /** The model's skeleton (its bones, or its nodes when it has none). */
  skeletonOf?: (assetId: string) => Promise<BoneInfo[]>;
  onSave: (controller: AnimatorController) => void;
  onDelete: (controllerId: string) => void;
  error: string | null;
}

export function AnimatorPanel(p: AnimatorPanelProps): JSX.Element {
  const firstModel = useFirstEntry(MODEL_KINDS).first;
  const [picked, setModel] = useState<string>('');
  // The first model of the project until one is picked.
  const model = picked !== '' ? picked : (firstModel ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(p.controllers[0]?.controllerId ?? null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId === null || !p.controllers.some((c) => c.controllerId === selectedId)) setSelectedId(p.controllers[0]?.controllerId ?? null);
  }, [p.controllers.map((c) => c.controllerId).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the controller ids; the controllers array is new each render
  const selected = p.controllers.find((c) => c.controllerId === selectedId) ?? null;

  const create = async (preset: 'empty' | 'locomotion'): Promise<void> => {
    setMessage(null);
    if (model === '') return setMessage('import a model with animation clips first');
    const list = await p.clipsOf(model);
    if (list.length === 0) return setMessage('this model has no animation clips');
    const id = newId('animator', p.controllers.map((c) => c.controllerId));
    let c: AnimatorController | string;
    if (preset === 'locomotion') c = locomotionController(id, model, list);
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
        <RefPicker aria="animator model" kinds={MODEL_KINDS} value={model} none={firstModel === null ? '— no model —' : null} title="The model whose clips a new controller uses" onPick={setModel} />
        <button type="button" className="tl-button" onClick={() => void create('empty')}>
          New controller
        </button>
        <button type="button" className="tl-button" onClick={() => void create('locomotion')} title="States and transitions for clips named idle/run/jump/fall/land">
          New from clips: Character locomotion
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
