/**
 * Phase 16.2: the "Animator: <controller>" centre tab — the controller's
 * state machine on the graph framework (16.1).
 *
 * - The graph: the layer's states (clip, blend tree, empty), the fixed Entry
 *   and Any State nodes and one wire per state pair with transitions (a
 *   count on the wire when a pair has several). Every gesture is one
 *   `graphEdit` on owner kind `animator` (the backend writes it into the
 *   controller; the change is a `setAnimators`, the view is read back from
 *   it — editor/src/graph/animator.ts). The selection shows in the right
 *   dock's Inspector (AnimatorInspector).
 * - Layers (14.6) are tabs above the graph; a blend tree opens as its own
 *   graph (double-click it, or "Open blend tree" in the Inspector) with a
 *   breadcrumb back to its layer.
 * - Left: the controller's parameters and, on an override layer, the
 *   layer's settings (weight, bone mask). Controller-level edits are
 *   `setAnimator` (one undo each).
 * - The live preview (9.7) is a pane inside the tab, docked right or at the
 *   bottom, or hidden (remembered in the browser); the states it is in are
 *   highlighted in the graph.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { AnimatorController, AnimatorLayer, GraphValue } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import { animatorBlendStateOf, animatorGraphOf, animatorLayerOf, animatorOwnerId, animatorTransitionPairs, parseAnimatorOwnerId, type AnimatorOwnerTarget } from '../../graph/animator';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { allStateIds, LayerSettings, LivePreview, MAX_LAYERS, newId, ParameterList, rigOf, useClipChoices, type AnimatorModels, type BoneInfo, type ClipInfo, type StartPreview } from './parts';

export interface AnimatorDocumentProps {
  controllerId: string;
  controllers: AnimatorController[];
  models: AnimatorModels;
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
  skeletonOf?: (assetId: string) => Promise<BoneInfo[]>;
  preview?: StartPreview;
  onSave: (controller: AnimatorController) => void;
  onDelete: (controllerId: string) => void;
  error: string | null;
  /** The registered graph kinds (from the backend). */
  kinds: Readonly<Record<string, GraphKindDef>>;
  /** The graph shown (an animator owner id: `ctrl`, `ctrl@n`, `ctrl#state`); kept by the app per controller. */
  target: string;
  onTarget: (ownerId: string) => void;
  /** Sends `graphEdit` ops for an animator owner id (queued; resolves with a refusal or null). */
  onGraphEdit: (ownerId: string, ops: GraphOp[]) => Promise<string | null>;
  /** The graph selection (the Inspector shows it). */
  onSelection: (ownerId: string, ids: readonly string[]) => void;
  /** An item to select and frame (from the Inspector). */
  focus: { id: string; nonce: number } | null;
}

type PreviewDock = 'right' | 'bottom' | 'hidden';
const DOCK_KEY = 'thirdlight.animatorPreviewDock.v1';
function loadDock(): PreviewDock {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    return v === 'bottom' || v === 'hidden' ? v : 'right';
  } catch {
    return 'right';
  }
}

/** The target to show: the requested one when it still exists, else the base layer. */
function resolveTarget(c: AnimatorController, ownerId: string): AnimatorOwnerTarget {
  const t = parseAnimatorOwnerId(ownerId);
  if (t !== null && t.controllerId === c.controllerId && animatorGraphOf(c, t) !== null) return t;
  return { controllerId: c.controllerId, layer: 0 };
}

/** The layer (0 = base) a state belongs to. */
function layerOfState(c: AnimatorController, stateId: string): number {
  if (c.states.some((s) => s.id === stateId)) return 0;
  const i = (c.layers ?? []).findIndex((l) => l.states.some((s) => s.id === stateId));
  return i < 0 ? 0 : i + 1;
}

export function AnimatorDocument(p: AnimatorDocumentProps): JSX.Element {
  const controller = p.controllers.find((c) => c.controllerId === p.controllerId) ?? null;
  const rigs = p.models.filter((m) => m.clipsFor === undefined);
  const firstAsset = useMemo(() => rigOf(controller, p.models), [controller, p.models]);
  const [model, setModel] = useState<string>(firstAsset ?? rigs[0]?.assetId ?? '');
  useEffect(() => {
    if (firstAsset !== undefined && firstAsset !== model) setModel(firstAsset);
  }, [firstAsset]); // eslint-disable-line react-hooks/exhaustive-deps
  const clips = useClipChoices(model, p.models, p.clipsOf);
  const [bones, setBones] = useState<BoneInfo[]>([]);
  useEffect(() => {
    let live = true;
    if (model !== '' && p.skeletonOf !== undefined) void p.skeletonOf(model).then((b) => live && setBones(b));
    return () => {
      live = false;
    };
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dock, setDockState] = useState<PreviewDock>(loadDock);
  const setDock = (d: PreviewDock): void => {
    setDockState(d);
    try {
      localStorage.setItem(DOCK_KEY, d);
    } catch {
      /* storage unavailable: the choice lasts for this page */
    }
  };
  const [previewStates, setPreviewStates] = useState<string[]>([]);

  const target = controller !== null ? resolveTarget(controller, p.target) : null;
  const ownerId = target !== null ? animatorOwnerId(target) : '';
  const view = controller !== null && target !== null ? animatorGraphOf(controller, target) : null;
  const kind = view !== null ? p.kinds[view.kindId] : undefined;
  const layerIndex = controller !== null && target !== null ? ('blendState' in target ? layerOfState(controller, target.blendState) : target.layer) : 0;
  const layer = controller !== null ? animatorLayerOf(controller, layerIndex) : null;

  // Several transitions of one pair are one wire with a count.
  const edgeLabels = useMemo(() => {
    const m = new Map<string, string>();
    if (layer === null || target === null || 'blendState' in target) return m;
    for (const pair of animatorTransitionPairs(layer.transitions)) if (pair.indices.length > 1) m.set(pair.id, `×${pair.indices.length}`);
    return m;
  }, [layer, target === null ? '' : ownerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const highlighted = useMemo(() => {
    if (layer === null || target === null || 'blendState' in target) return new Set<string>();
    const name = previewStates[layerIndex];
    return new Set(layer.states.filter((s) => s.name === name).map((s) => s.id));
  }, [layer, previewStates, layerIndex, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (controller === null) return <p className="tl-hint">This animator controller no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;

  const save = (next: AnimatorController): void => p.onSave(next);
  const firstClip = clips[0];
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => {
    const clipFields = firstClip !== undefined ? { clip: firstClip.name, asset: firstClip.assetId, ...(Math.max(0.001, firstClip.duration) !== 1 ? { duration: Math.max(0.001, firstClip.duration) } : {}) } : {};
    if (type === 'state') return { name: firstClip?.name ?? 'State', ...clipFields };
    if (type === 'blend') {
      const numeric = controller.parameters.find((x) => x.type === 'float' || x.type === 'int');
      return { name: 'Blend tree', ...(numeric !== undefined ? { parameter: numeric.name } : {}) };
    }
    if (type === 'empty') return { name: 'Empty' };
    if (type === 'clip' && target !== null && 'blendState' in target) {
      const s = animatorBlendStateOf(controller, target.blendState);
      const top = s?.motion.kind === 'blend1d' ? Math.max(...s.motion.children.map((k) => k.threshold)) : 0;
      return { threshold: top + 1, ...clipFields };
    }
    return undefined;
  };

  const layerTabs = [controller as AnimatorController | AnimatorLayer, ...(controller.layers ?? [])];
  const blendState = target !== null && 'blendState' in target ? animatorBlendStateOf(controller, target.blendState) : null;

  const previewPane =
    p.preview !== undefined && dock !== 'hidden' ? (
      <div className={`tl-animator-doc__preview tl-animator-doc__preview--${dock}`} aria-label="animator preview pane">
        <LivePreview controller={controller} start={p.preview} onStates={setPreviewStates} />
      </div>
    ) : null;

  return (
    <div className="tl-animator-doc" aria-label="animator">
      <div className="tl-animator__bar">
        <input className="tl-input" aria-label="controller name" defaultValue={controller.name} key={`${controller.controllerId}:${controller.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== controller.name && save({ ...controller, name: e.target.value.trim() })} />
        <select className="tl-input" aria-label="animator model" value={model} onChange={(e) => setModel(e.target.value)} title="The model whose clips the pickers list">
          {rigs.length === 0 && <option value="">— no model —</option>}
          {rigs.map((m) => (
            <option key={m.assetId} value={m.assetId}>
              {m.displayName}
            </option>
          ))}
        </select>
        <button type="button" className="tl-button" onClick={() => p.onDelete(controller.controllerId)}>
          Delete controller
        </button>
        <span className="tl-graph__spacer" />
        {p.preview !== undefined && (
          <span className="tl-animator-doc__dock" role="group" aria-label="preview pane position">
            <span className="tl-hint">Preview:</span>
            {(['right', 'bottom', 'hidden'] as const).map((d) => (
              <button key={d} type="button" className={`tl-button${dock === d ? ' is-active' : ''}`} aria-pressed={dock === d} onClick={() => setDock(d)}>
                {d === 'right' ? 'Right' : d === 'bottom' ? 'Bottom' : 'Hide'}
              </button>
            ))}
          </span>
        )}
      </div>
      {p.error !== null && (
        <p className="tl-lighting__message" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator__layers" role="tablist" aria-label="animator layers">
        {layerTabs.map((l, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={layerIndex === i}
            className={`tl-button${layerIndex === i ? ' is-active' : ''}`}
            onClick={() => p.onTarget(animatorOwnerId({ controllerId: controller.controllerId, layer: i }))}
          >
            {i === 0 ? 'Base layer' : (l as AnimatorLayer).name}
          </button>
        ))}
        <button
          type="button"
          className="tl-button"
          disabled={(controller.layers?.length ?? 0) >= MAX_LAYERS}
          title="An override layer: its own states on the bones of its mask (e.g. an upper-body attack while running)"
          onClick={() => {
            const id = newId('state', allStateIds(controller));
            const n = (controller.layers?.length ?? 0) + 1;
            const next: AnimatorLayer = { name: `Layer ${n}`, mask: [], weight: 1, states: [{ id, name: 'Empty', motion: { kind: 'empty' }, speed: 1, loop: true, position: [180, 40] }], transitions: [], entry: id };
            save({ ...controller, layers: [...(controller.layers ?? []), next] });
            p.onTarget(animatorOwnerId({ controllerId: controller.controllerId, layer: n }));
          }}
        >
          Add layer
        </button>
      </div>
      {blendState !== null && (
        <nav className="tl-animator-doc__path" aria-label="graph path">
          <button type="button" className="tl-button" onClick={() => p.onTarget(animatorOwnerId({ controllerId: controller.controllerId, layer: layerIndex }))}>
            {layerIndex === 0 ? 'Base layer' : (controller.layers?.[layerIndex - 1]?.name ?? `Layer ${layerIndex}`)}
          </button>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Blend tree: {blendState.name}</span>
        </nav>
      )}
      <div className={`tl-animator-doc__body${dock === 'bottom' ? ' is-column' : ' is-row'}`}>
        <div className="tl-animator-doc__main">
          <div className="tl-animator-doc__side">
            {layerIndex > 0 && controller.layers?.[layerIndex - 1] !== undefined && (
              <LayerSettings
                layer={controller.layers[layerIndex - 1]!}
                parameters={controller.parameters}
                bones={bones}
                onChange={(next) => save({ ...controller, layers: controller.layers!.map((l, i) => (i === layerIndex - 1 ? next : l)) })}
                onRemove={() => {
                  const rest = controller.layers!.filter((_, i) => i !== layerIndex - 1);
                  const { layers: _drop, ...base } = controller;
                  save(rest.length > 0 ? { ...base, layers: rest } : base);
                  p.onTarget(controller.controllerId);
                }}
              />
            )}
            <ParameterList controller={controller} onSave={save} />
          </div>
          <div className="tl-animator-doc__graph" aria-label="animator graph">
            {view !== null && kind !== undefined ? (
              <GraphEditor
                key={ownerId}
                kind={kind}
                owner={{ kind: 'animator', id: ownerId }}
                graph={view.graph}
                onEdit={(ops) => p.onGraphEdit(ownerId, ops)}
                onSelection={(ids) => p.onSelection(ownerId, ids)}
                focus={p.focus}
                edgeLabels={edgeLabels}
                highlighted={highlighted}
                newNodeData={newNodeData}
                onOpenNode={(id) => {
                  if (view.graph.nodes.find((n) => n.id === id)?.type === 'blend') p.onTarget(animatorOwnerId({ controllerId: controller.controllerId, blendState: id }));
                }}
              />
            ) : (
              <p className="tl-hint">Loading the animator graph kinds…</p>
            )}
          </div>
        </div>
        {/* One place in the tree for both docks (CSS moves it), so re-docking keeps a running preview. */}
        {previewPane}
      </div>
    </div>
  );
}
