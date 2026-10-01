/**
 * Pieces shared by the Animator's views — the bottom-dock
 * controller list, the "Animator: <controller>" tab (graph, layers,
 * parameters) and its Inspector extension: clip choices of a controller's
 * model, the clip picker, layer settings (weight, bone mask) and the
 * parameter list. The live preview runs in the editor window's preview pane.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type * as THREE from 'three';
import type { AnimatorClipRef, AnimatorController, AnimatorLayer, AnimatorParameter, AnimatorState, AnimatorTransition } from '@thirdlight/project-model';
import { MAX_ANIMATOR_LAYERS } from '@thirdlight/project-model/limits';

import { useAssetSummaries, useCatalog } from '../catalog/catalog-context';
import { MODEL_KINDS } from '../catalog/RefPicker';

export interface ClipInfo {
  name: string;
  duration: number;
}

/** One bone of a model's skeleton (for layer masks). */
export interface BoneInfo {
  name: string;
  parent: string | null;
  depth: number;
}

/** A clip a state can play: the model's own, or one of an animation-only asset marked "clips for" it. */
export interface ClipChoice extends ClipInfo {
  assetId: string;
  /** The asset's name when it is not the model itself. */
  source: string | null;
}

/** A running live preview of one controller: its model under the preview pane's stage, stepped by the pane's frames. */
export interface AnimatorPreview {
  readonly root: THREE.Object3D;
  /** Step the controller and pose the model (seconds, before the speed). */
  step(dtSeconds: number): void;
  set(name: string, value: number | boolean): void;
  trigger(name: string): void;
  /** The current state's name. */
  state(): string;
  /** Every layer's current state (the base layer first). */
  layerStates?(): string[];
  /** The playback speed (× every clip and crossfade, as ctx.animator(id).setSpeed sets it in the game). */
  setSpeed?(speed: number): void;
  /** Seconds into the base layer's (heaviest) clip now. */
  clipTime?(): number;
  /** Seconds the preview has stepped (before the speed; the clip time runs at speed × this). */
  elapsed?(): number;
  dispose(): void;
}

/** Realize `controller`'s model under `parent` with the controller running, or say why not. */
export type StartPreview = (controller: AnimatorController, parent: THREE.Object3D) => Promise<AnimatorPreview | string>;

export const MAX_LAYERS = MAX_ANIMATOR_LAYERS;

export const newId = (prefix: string, taken: Iterable<string>): string => {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}-${String(i).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
};
export const allStateIds = (c: AnimatorController): string[] => [c, ...(c.layers ?? [])].flatMap((g) => g.states.map((s) => s.id));

/** A controller's first clip's asset (the file its clips come from). */
function firstClipAsset(c: AnimatorController | null): string | undefined {
  for (const g of c === null ? [] : [c, ...(c.layers ?? [])]) {
    for (const s of g.states) {
      const id = s.motion.kind === 'clip' ? s.motion.clip.assetId : s.motion.kind === 'blend1d' ? s.motion.children[0]?.clip.assetId : undefined;
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

/** Where a controller's clips come from: its first clip's asset (a clips-only asset stands for its rig; read by id). */
export function useRigOf(c: AnimatorController | null): string | undefined {
  const first = firstClipAsset(c);
  const [summary] = useAssetSummaries(first !== undefined ? [first] : []);
  return first === undefined ? undefined : (summary?.clipsFor ?? first);
}

/**
 * The clips of `model` and of every animation-only asset marked "clips for"
 * it (the models whose index entry names it, checked on their summaries;
 * loaded asynchronously).
 */
export function useClipChoices(model: string, clipsOf: (assetId: string) => Promise<ClipInfo[]>): ClipChoice[] {
  const { catalog, version, asset } = useCatalog();
  const [clips, setClips] = useState<ClipChoice[]>([]);
  // The animation-only files marked "clips for" the model, read again when the index changes; their
  // clips are read only when that list changes (reading a model while its preview loads it would supersede that load).
  const [sources, setSources] = useState<{ model: string; key: string; list: { assetId: string; source: string | null }[] }>({ model: '', key: '', list: [] });
  useEffect(() => {
    let live = true;
    if (model === '' || catalog === null) {
      setSources((s) => (s.model === model && s.key === '' ? s : { model, key: '', list: [] }));
      return;
    }
    void (async () => {
      // Every model that names it, however many (a failed read offers the model's own clips only).
      const users = await catalog.all({ kinds: MODEL_KINDS, referencing: model }).catch(() => []);
      await catalog.ensureAssets(users.map((e) => e.id));
      const list = users.filter((e) => e.id !== model && asset(e.id)?.clipsFor === model).map((e) => ({ assetId: e.id, source: e.name as string | null }));
      const key = list.map((x) => `${x.assetId}:${x.source ?? ''}`).join('|');
      if (live) setSources((s) => (s.model === model && s.key === key ? s : { model, key, list }));
    })();
    return () => {
      live = false;
    };
  }, [model, catalog, version, asset]);
  useEffect(() => {
    let live = true;
    if (model === '' || sources.model !== model) {
      setClips([]);
      return;
    }
    const all = [{ assetId: model, source: null as string | null }, ...sources.list];
    void Promise.all(all.map(async (src) => (await clipsOf(src.assetId)).map((c) => ({ ...c, assetId: src.assetId, source: src.source })))).then((lists) => live && setClips(lists.flat()));
    return () => {
      live = false;
    };
  }, [model, sources]); // eslint-disable-line react-hooks/exhaustive-deps -- clipsOf is a new closure each render; the clips follow the model and its clip files
  return clips;
}

export const clipRef = (c: ClipChoice): AnimatorClipRef => ({ assetId: c.assetId, clip: c.name, duration: Math.max(0.001, c.duration) });

/** A clip picker: the model's own clips by name, other assets' as `assetId/clip`. */
export function ClipSelect({ value, clips, model, label, onPick }: { value: AnimatorClipRef; clips: readonly ClipChoice[]; model: string; label: string; onPick: (c: AnimatorClipRef) => void }): JSX.Element {
  const choiceValue = (assetId: string, clip: string): string => (assetId === model ? clip : `${assetId}/${clip}`);
  const known = clips.some((c) => c.assetId === value.assetId && c.name === value.clip);
  return (
    <select
      className="tl-input"
      aria-label={label}
      value={known ? choiceValue(value.assetId, value.clip) : ''}
      onChange={(e) => {
        const c = clips.find((x) => choiceValue(x.assetId, x.name) === e.target.value);
        if (c !== undefined) onPick(clipRef(c));
      }}
    >
      {!known && <option value="">{value.clip} (other model)</option>}
      {clips.map((c) => (
        <option key={choiceValue(c.assetId, c.name)} value={choiceValue(c.assetId, c.name)}>
          {c.name}
          {c.source !== null ? ` · ${c.source}` : ''} ({c.duration.toFixed(2)} s)
        </option>
      ))}
    </select>
  );
}

export function paramOptions(c: AnimatorController, types: readonly string[]): JSX.Element[] {
  return c.parameters
    .filter((x) => types.includes(x.type))
    .map((x) => (
      <option key={x.name} value={x.name}>
        {x.name}
      </option>
    ));
}

/**
 * A character locomotion controller from clips named like
 * idle/run (or walk)/jump/fall/land. An opt-in preset driven by the parameters
 * the engine's character controller sets on its animators (speed, grounded,
 * velocityY and landed: the motion's names, no genre), not a default. Thresholds (genre-neutral
 * reasons): run above 0.2 m/s — 5 % of the default 4 m/s run speed, clearly moving
 * rather than drifting at any character scale; jump/fall beyond ±0.5 m/s vertical —
 * above the small vertical motion of ground snap and slopes, far below a 7 m/s jump;
 * crossfades 0.05–0.15 s — quick enough to follow input, long enough to hide the cut.
 */
export function locomotionController(controllerId: string, assetId: string, clips: readonly ClipInfo[]): AnimatorController | string {
  const find = (...names: string[]): ClipInfo | undefined => clips.find((c) => names.some((n) => c.name.toLowerCase() === n)) ?? clips.find((c) => names.some((n) => c.name.toLowerCase().includes(n)));
  const idle = find('idle');
  const run = find('run', 'walk');
  if (idle === undefined || run === undefined) return 'the model needs at least an idle and a run (or walk) clip';
  const jump = find('jump');
  const fall = find('fall', 'airborne');
  const land = find('land');
  const ref = (c: ClipInfo): AnimatorClipRef => ({ assetId, clip: c.name, duration: c.duration });
  const states: AnimatorState[] = [
    { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: ref(idle) }, speed: 1, loop: true, position: [180, 30] },
    { id: 'run', name: 'Run', motion: { kind: 'clip', clip: ref(run) }, speed: 1, loop: true, position: [440, 30] },
  ];
  const transitions: AnimatorTransition[] = [
    { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.2 }], duration: 0.12 },
    { from: 'run', to: 'idle', conditions: [{ parameter: 'speed', op: 'less', value: 0.2 }], duration: 0.15 },
  ];
  const air = fall ?? jump;
  if (jump !== undefined) {
    states.push({ id: 'jump', name: 'Jump', motion: { kind: 'clip', clip: ref(jump) }, speed: 1, loop: false, position: [180, 190] });
    transitions.push({ from: '*', to: 'jump', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'greater', value: 0.5 }], duration: 0.05 });
  }
  if (air !== undefined && air !== jump) {
    states.push({ id: 'fall', name: 'Fall', motion: { kind: 'clip', clip: ref(air) }, speed: 1, loop: true, position: [440, 190] });
    if (jump !== undefined) transitions.push({ from: 'jump', to: 'fall', conditions: [], duration: 0.1, exitTime: 1 });
    transitions.push({ from: 'idle', to: 'fall', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'less', value: -0.5 }], duration: 0.1 });
    transitions.push({ from: 'run', to: 'fall', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'less', value: -0.5 }], duration: 0.1 });
  }
  const airIds = states.filter((s) => s.id === 'jump' || s.id === 'fall').map((s) => s.id);
  if (land !== undefined) {
    states.push({ id: 'land', name: 'Land', motion: { kind: 'clip', clip: ref(land) }, speed: 1, loop: false, position: [700, 190] });
    for (const id of airIds) transitions.push({ from: id, to: 'land', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0.05 });
    transitions.push({ from: 'land', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.2 }], duration: 0.1 });
    transitions.push({ from: 'land', to: 'idle', conditions: [], duration: 0.1, exitTime: 1 });
  } else {
    for (const id of airIds) transitions.push({ from: id, to: 'idle', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0.1 });
  }
  return {
    controllerId,
    name: 'Character locomotion',
    parameters: [
      { name: 'speed', type: 'float', default: 0 },
      { name: 'grounded', type: 'bool', default: true },
      { name: 'velocityY', type: 'float', default: 0 },
      { name: 'landed', type: 'trigger' },
    ],
    states,
    transitions,
    entry: 'idle',
    events: [],
  };
}

/**
 * An override layer's name, weight (and weight parameter) and its
 * bone mask, picked from the model's skeleton. A bone's checkbox toggles that
 * bone; "+ children" sets the bone and every bone under it. An empty mask
 * drives every bone.
 */
export function LayerSettings({ layer, parameters, bones, onChange, onRemove }: { layer: AnimatorLayer; parameters: readonly AnimatorParameter[]; bones: readonly BoneInfo[]; onChange: (l: AnimatorLayer) => void; onRemove: () => void }): JSX.Element {
  const mask = new Set(layer.mask);
  const below = (name: string): string[] => {
    const out = [name];
    for (let i = 0; i < out.length; i++) for (const b of bones) if (b.parent === out[i]) out.push(b.name);
    return out;
  };
  const setMask = (next: Set<string>): void => {
    // Keep the skeleton's order (names the model does not have stay at the end).
    const ordered = [...bones.map((b) => b.name).filter((n) => next.has(n)), ...[...next].filter((n) => !bones.some((b) => b.name === n))];
    onChange({ ...layer, mask: ordered });
  };
  const missing = layer.mask.filter((n) => !bones.some((b) => b.name === n));
  return (
    <div aria-label="layer settings">
      <div className="tl-panel__title">Layer</div>
      <label className="tl-field">
        <span className="tl-field__label">name</span>
        <input className="tl-input" aria-label="layer name" defaultValue={layer.name} key={layer.name} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== layer.name && onChange({ ...layer, name: e.target.value.trim() })} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">weight</span>
        <input className="tl-input tl-input--num" type="number" min={0} max={1} step={0.05} aria-label="layer weight" value={layer.weight} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange({ ...layer, weight: Math.min(1, Math.max(0, Number(e.target.value))) })} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">× parameter</span>
        <select
          className="tl-input"
          aria-label="layer weight parameter"
          value={layer.weightParameter ?? ''}
          onChange={(e) => {
            const { weightParameter: _drop, ...rest } = layer;
            onChange(e.target.value === '' ? rest : { ...rest, weightParameter: e.target.value });
          }}
        >
          <option value="">— none —</option>
          {parameters
            .filter((x) => x.type === 'float')
            .map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      <div className="tl-field__label">bones ({layer.mask.length === 0 ? 'none picked: every bone' : `${layer.mask.length} picked`})</div>
      <div className="tl-animator__bones" aria-label="layer bone mask">
        {bones.length === 0 && <p className="tl-hint">The model has no skeleton loaded.</p>}
        {bones.map((b) => (
          <div className="tl-animator__row" key={b.name} style={{ paddingLeft: b.depth * 12 }}>
            <label className="tl-flag">
              <input
                type="checkbox"
                aria-label={`mask bone ${b.name}`}
                checked={mask.has(b.name)}
                onChange={(e) => {
                  const next = new Set(mask);
                  if (e.target.checked) next.add(b.name);
                  else next.delete(b.name);
                  setMask(next);
                }}
              />
              {b.name}
            </label>
            {bones.some((x) => x.parent === b.name) && (
              <button
                type="button"
                className="tl-button"
                aria-label={`mask branch ${b.name}`}
                title="This bone and every bone under it"
                onClick={() => {
                  const next = new Set(mask);
                  const on = !mask.has(b.name);
                  for (const n of below(b.name))
                    if (on) next.add(n);
                    else next.delete(n);
                  setMask(next);
                }}
              >
                + children
              </button>
            )}
          </div>
        ))}
        {missing.map((n) => (
          <div className="tl-animator__row" key={`missing-${n}`}>
            <label className="tl-flag" title="This model has no bone of this name">
              <input type="checkbox" aria-label={`mask bone ${n}`} checked onChange={() => setMask(new Set(layer.mask.filter((x) => x !== n)))} />
              {n} (not in this model)
            </label>
          </div>
        ))}
      </div>
      <button type="button" className="tl-button" onClick={onRemove}>
        Remove layer
      </button>
    </div>
  );
}

export function ParameterList({ controller, onSave }: { controller: AnimatorController; onSave: (c: AnimatorController) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [type, setType] = useState<AnimatorParameter['type']>('float');
  const graphs = [controller, ...(controller.layers ?? [])];
  const used = (n: string): boolean =>
    (controller.layers ?? []).some((l) => l.weightParameter === n) ||
    graphs.some((g) => g.transitions.some((t) => t.conditions.some((c) => c.parameter === n))) ||
    graphs.some((g) => g.states.some((s) => s.speedParameter === n || (s.motion.kind === 'blend1d' && s.motion.parameter === n)));
  return (
    <div aria-label="animator parameters">
      <div className="tl-panel__title">Parameters</div>
      {controller.parameters.map((x, i) => (
        <div className="tl-animator__row" key={x.name}>
          <span className="tl-animator__param">
            {x.name} <small>{x.type}</small>
          </span>
          {x.type === 'bool' && <input type="checkbox" aria-label={`parameter ${x.name} default`} checked={x.default === true} onChange={(e) => onSave({ ...controller, parameters: controller.parameters.map((q, j) => (j === i ? { ...q, default: e.target.checked } : q)) })} />}
          {(x.type === 'float' || x.type === 'int') && (
            <input
              className="tl-input tl-input--num"
              type="number"
              step={x.type === 'int' ? 1 : 0.1}
              aria-label={`parameter ${x.name} default`}
              value={Number(x.default ?? 0)}
              onChange={(e) => Number.isFinite(Number(e.target.value)) && onSave({ ...controller, parameters: controller.parameters.map((q, j) => (j === i ? { ...q, default: x.type === 'int' ? Math.trunc(Number(e.target.value)) : Number(e.target.value) } : q)) })}
            />
          )}
          <button type="button" className="tl-button" aria-label={`remove parameter ${x.name}`} disabled={used(x.name)} title={used(x.name) ? 'in use by a transition or a state' : 'remove'} onClick={() => onSave({ ...controller, parameters: controller.parameters.filter((_, j) => j !== i) })}>
            ×
          </button>
        </div>
      ))}
      <div className="tl-animator__row">
        <input className="tl-input" aria-label="new parameter name" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="tl-input" aria-label="new parameter type" value={type} onChange={(e) => setType(e.target.value as AnimatorParameter['type'])}>
          <option value="float">float</option>
          <option value="int">int</option>
          <option value="bool">bool</option>
          <option value="trigger">trigger</option>
        </select>
        <button
          type="button"
          className="tl-button"
          disabled={!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || controller.parameters.some((x) => x.name === name)}
          onClick={() => {
            const p: AnimatorParameter = type === 'trigger' ? { name, type } : { name, type, default: type === 'bool' ? false : 0 };
            onSave({ ...controller, parameters: [...controller.parameters, p] });
            setName('');
          }}
        >
          Add parameter
        </button>
      </div>
    </div>
  );
}
