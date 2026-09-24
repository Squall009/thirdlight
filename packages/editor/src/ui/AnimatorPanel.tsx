/**
 * Phase 9.7: the Animator window — animator controllers as a state graph.
 *
 * States are boxes (drag to move); arrows are transitions. Right click on the
 * graph adds a state or a blend tree; right click on a state (or "Any
 * State") starts a transition (then click the target), makes it the entry
 * state or deletes it. The side panel edits the selected state (its clip or
 * blend tree, speed, loop, clip events), the selected transition (conditions,
 * crossfade, exit time) or the parameters. Every edit is one `setAnimator`
 * (one undo). "Platformer" builds a controller from a model's clips named
 * idle/run/jump/fall/land with the parameters the player gets automatically.
 * "Preview" runs the controller live on its model in a small canvas, with
 * the parameters as sliders, checkboxes and trigger buttons (nothing saved).
 * Phase 16.0: in the bottom dock a controller list (double-click) or "Open in
 * tab" opens a controller as a centre tab, where the same panel runs in
 * document mode (`controllerId`: that one controller).
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AnimatorClipRef, AnimatorCondition, AnimatorController, AnimatorLayer, AnimatorParameter, AnimatorState, AnimatorTransition } from '@thirdlight/project-model';

export interface ClipInfo {
  name: string;
  duration: number;
}

/** Phase 14.6: one bone of a model's skeleton (for layer masks). */
export interface BoneInfo {
  name: string;
  parent: string | null;
  depth: number;
}

/** A clip a state can play: the model's own, or one of an animation-only asset marked "clips for" it. */
interface ClipChoice extends ClipInfo {
  assetId: string;
  /** The asset's name when it is not the model itself. */
  source: string | null;
}

/** A running live preview of one controller (App owns the model and the frame loop). */
export interface AnimatorPreview {
  set(name: string, value: number | boolean): void;
  trigger(name: string): void;
  /** The current state's name. */
  state(): string;
  /** Phase 14.6: every layer's current state (the base layer first). */
  layerStates?(): string[];
  dispose(): void;
}

export interface AnimatorPanelProps {
  controllers: AnimatorController[];
  /**
   * Phase 16.0: document mode — the panel edits this one controller (a
   * centre workspace tab "Animator: <name>"); the controller picker and the
   * create buttons are hidden.
   */
  controllerId?: string;
  /** Phase 16.0: open a controller in its own centre tab (double-click in the list). */
  onOpen?: (controllerId: string) => void;
  /** Start a live preview of `controller` in `canvas`, or say why not. */
  preview?: (controller: AnimatorController, canvas: HTMLCanvasElement) => Promise<AnimatorPreview | string>;
  /** Model assets; `clipsFor` marks an animation-only file whose clips play on that model (phase 14.6). */
  models: { assetId: string; displayName: string; clipsFor?: string }[];
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
  /** Phase 14.6: the model's skeleton (its bones, or its nodes when it has none). */
  skeletonOf?: (assetId: string) => Promise<BoneInfo[]>;
  onSave: (controller: AnimatorController) => void;
  onDelete: (controllerId: string) => void;
  error: string | null;
}

const NODE_W = 132;
const NODE_H = 34;
const ANY = '*';
const ANY_POS: [number, number] = [16, 16];

const newId = (prefix: string, taken: Iterable<string>): string => {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}-${String(i).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
};
const posOf = (s: AnimatorState, i: number): [number, number] => s.position ?? [180 + (i % 4) * 170, 20 + Math.floor(i / 4) * 80];
const clipLabel = (c: AnimatorClipRef): string => c.clip;

/** Phase 14.6: one layer's graph (0 = the base layer: the controller's own states). */
type Graph = { states: AnimatorState[]; transitions: AnimatorTransition[]; entry: string };
export const MAX_LAYERS = 3;
function graphOf(c: AnimatorController, layer: number): Graph {
  return layer === 0 ? c : (c.layers?.[layer - 1] ?? c);
}
function withGraph(c: AnimatorController, layer: number, patch: Partial<Graph>): AnimatorController {
  if (layer === 0) return { ...c, ...patch };
  return { ...c, layers: (c.layers ?? []).map((l, i) => (i === layer - 1 ? { ...l, ...patch } : l)) };
}
const allStateIds = (c: AnimatorController): string[] => [c, ...(c.layers ?? [])].flatMap((g) => g.states.map((s) => s.id));
/** Where a controller's clips come from: its first clip's asset (a clips-only asset stands for its rig). */
function rigOf(c: AnimatorController | null, models: AnimatorPanelProps['models']): string | undefined {
  for (const g of c === null ? [] : [c, ...(c.layers ?? [])]) {
    for (const s of g.states) {
      const id = s.motion.kind === 'clip' ? s.motion.clip.assetId : s.motion.kind === 'blend1d' ? s.motion.children[0]?.clip.assetId : undefined;
      if (id !== undefined) return models.find((m) => m.assetId === id)?.clipsFor ?? id;
    }
  }
  return undefined;
}

/**
 * A controller for a platformer character from clips named like idle/run/jump/fall/land.
 * An opt-in preset for the built-in player controller (it sets speed, grounded,
 * velocityY and landed), not a default. Thresholds (phase 15.5, genre-neutral
 * reasons): run above 0.2 m/s — 5 % of the default 4 m/s run speed, clearly moving
 * rather than drifting at any character scale; jump/fall beyond ±0.5 m/s vertical —
 * above the small vertical motion of ground snap and slopes, far below a 7 m/s jump;
 * crossfades 0.05–0.15 s — quick enough to follow input, long enough to hide the cut.
 */
export function platformerController(controllerId: string, assetId: string, clips: readonly ClipInfo[]): AnimatorController | string {
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
    { id: 'run', name: 'Run', motion: { kind: 'clip', clip: ref(run) }, speed: 1, loop: true, position: [400, 30] },
  ];
  const transitions: AnimatorTransition[] = [
    { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.2 }], duration: 0.12 },
    { from: 'run', to: 'idle', conditions: [{ parameter: 'speed', op: 'less', value: 0.2 }], duration: 0.15 },
  ];
  const air = fall ?? jump;
  if (jump !== undefined) {
    states.push({ id: 'jump', name: 'Jump', motion: { kind: 'clip', clip: ref(jump) }, speed: 1, loop: false, position: [180, 130] });
    transitions.push({ from: ANY, to: 'jump', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'greater', value: 0.5 }], duration: 0.05 });
  }
  if (air !== undefined && air !== jump) {
    states.push({ id: 'fall', name: 'Fall', motion: { kind: 'clip', clip: ref(air) }, speed: 1, loop: true, position: [400, 130] });
    if (jump !== undefined) transitions.push({ from: 'jump', to: 'fall', conditions: [], duration: 0.1, exitTime: 1 });
    transitions.push({ from: 'idle', to: 'fall', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'less', value: -0.5 }], duration: 0.1 });
    transitions.push({ from: 'run', to: 'fall', conditions: [{ parameter: 'grounded', op: 'false' }, { parameter: 'velocityY', op: 'less', value: -0.5 }], duration: 0.1 });
  }
  const airIds = states.filter((s) => s.id === 'jump' || s.id === 'fall').map((s) => s.id);
  if (land !== undefined) {
    states.push({ id: 'land', name: 'Land', motion: { kind: 'clip', clip: ref(land) }, speed: 1, loop: false, position: [620, 130] });
    for (const id of airIds) transitions.push({ from: id, to: 'land', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0.05 });
    transitions.push({ from: 'land', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.2 }], duration: 0.1 });
    transitions.push({ from: 'land', to: 'idle', conditions: [], duration: 0.1, exitTime: 1 });
  } else {
    for (const id of airIds) transitions.push({ from: id, to: 'idle', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0.1 });
  }
  return {
    controllerId,
    name: 'Platformer',
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

export function AnimatorPanel(p: AnimatorPanelProps): JSX.Element {
  const doc = p.controllerId !== undefined;
  const [selectedId, setSelectedId] = useState<string | null>(p.controllerId ?? p.controllers[0]?.controllerId ?? null);
  // Rigs: models that are not animation-only files (their clips are listed under their rig).
  const rigs = p.models.filter((m) => m.clipsFor === undefined);
  const [model, setModel] = useState<string>(rigs[0]?.assetId ?? '');
  const [clips, setClips] = useState<ClipChoice[]>([]);
  const [layer, setLayer] = useState(0);
  const [bones, setBones] = useState<BoneInfo[]>([]);
  const [draft, setDraft] = useState<AnimatorController | null>(null);
  const [selection, setSelection] = useState<{ kind: 'state'; id: string } | { kind: 'transition'; index: number } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const saved = p.controllers.find((c) => c.controllerId === selectedId) ?? null;
  useEffect(() => {
    setDraft(saved === null ? null : structuredClone(saved));
  }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!doc && selectedId === null && p.controllers.length > 0) setSelectedId(p.controllers[0]!.controllerId);
  }, [p.controllers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // The model whose clips the pickers list: the controller's first clip's, else the chosen one.
  const firstAsset = useMemo(() => rigOf(draft, p.models), [draft, p.models]);
  useEffect(() => {
    if (firstAsset !== undefined && firstAsset !== model) setModel(firstAsset);
  }, [firstAsset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    if (model === '') {
      setClips([]);
      return;
    }
    // The model's own clips, then those of every animation-only asset marked "clips for" it.
    const sources = [{ assetId: model, source: null as string | null }, ...p.models.filter((m) => m.clipsFor === model).map((m) => ({ assetId: m.assetId, source: m.displayName }))];
    void Promise.all(sources.map(async (src) => (await p.clipsOf(src.assetId)).map((c) => ({ ...c, assetId: src.assetId, source: src.source })))).then((lists) => live && setClips(lists.flat()));
    if (p.skeletonOf !== undefined) void p.skeletonOf(model).then((b) => live && setBones(b));
    return () => {
      live = false;
    };
  }, [model, JSON.stringify(p.models)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLayer(0);
  }, [selectedId]);
  // A removed layer: back to the base layer.
  useEffect(() => {
    if (draft !== null && layer > (draft.layers?.length ?? 0)) setLayer(0);
  }, [draft, layer]);
  const g: Graph | null = draft === null ? null : graphOf(draft, layer);
  const gs = g?.states ?? [];
  const gt = g?.transitions ?? [];
  const gentry = g?.entry ?? '';
  const put = (patch: Partial<Graph>): void => {
    if (draft !== null) save(withGraph(draft, layer, patch));
  };

  const save = (next: AnimatorController): void => {
    setDraft(next);
    p.onSave(next);
  };
  const ref = (c: ClipInfo & { assetId?: string }): AnimatorClipRef => ({ assetId: c.assetId ?? model, clip: c.name, duration: Math.max(0.001, c.duration) });

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
        states: [{ id: 'state-01', name: list[0]!.name, motion: { kind: 'clip', clip: ref(list[0]!) }, speed: 1, loop: true, position: [180, 40] }],
        transitions: [],
        entry: 'state-01',
        events: [],
      };
    if (typeof c === 'string') return setMessage(c);
    p.onSave(c);
    setSelectedId(c.controllerId);
    setSelection(null);
  };

  // ---- graph interaction ---------------------------------------------------------
  const point = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current?.getBoundingClientRect();
    return r === undefined ? [0, 0] : [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
  };
  const addState = (kind: 'clip' | 'blend1d' | 'empty', at: [number, number]): void => {
    if (draft === null) return;
    if (kind !== 'empty' && clips.length === 0) return setMessage('the model has no clips');
    const id = newId('state', allStateIds(draft));
    const numeric = draft.parameters.find((x) => x.type === 'float' || x.type === 'int');
    if (kind === 'blend1d' && numeric === undefined) return setMessage('a blend tree needs a float or int parameter; add one first');
    const state: AnimatorState = {
      id,
      name: kind === 'clip' ? clips[0]!.name : kind === 'empty' ? 'Empty' : 'Blend',
      motion:
        kind === 'empty'
          ? { kind: 'empty' }
          : kind === 'clip'
          ? { kind: 'clip', clip: ref(clips[0]!) }
          : { kind: 'blend1d', parameter: numeric!.name, children: [{ threshold: 0, clip: ref(clips[0]!) }, { threshold: 1, clip: ref(clips[Math.min(1, clips.length - 1)]!) }] },
      speed: 1,
      loop: true,
      position: [Math.max(0, at[0] - NODE_W / 2), Math.max(0, at[1] - NODE_H / 2)],
    };
    put({ states: [...gs, state] });
    setSelection({ kind: 'state', id });
  };
  const deleteState = (id: string): void => {
    if (draft === null) return;
    if (gs.length === 1) return setMessage('a layer keeps at least one state');
    const states = gs.filter((s) => s.id !== id);
    put({ states, transitions: gt.filter((t) => t.from !== id && t.to !== id), entry: gentry === id ? states[0]!.id : gentry });
    setSelection(null);
  };
  const clickNode = (id: string): void => {
    if (draft === null) return;
    if (linking !== null) {
      if (id === ANY) return;
      const t: AnimatorTransition = { from: linking, to: id, conditions: [], duration: 0.1, exitTime: 1 };
      put({ transitions: [...gt, t] });
      setSelection({ kind: 'transition', index: gt.length });
      setLinking(null);
      return;
    }
    if (id !== ANY) setSelection({ kind: 'state', id });
  };

  const nodePos = (id: string): [number, number] => {
    if (id === ANY) return ANY_POS;
    const i = gs.findIndex((s) => s.id === id);
    return i < 0 ? [0, 0] : posOf(gs[i]!, i);
  };

  const stateSel = selection?.kind === 'state' ? gs.find((s) => s.id === selection.id) ?? null : null;
  const transSel = selection?.kind === 'transition' ? gt[selection.index] ?? null : null;

  const setState = (next: AnimatorState): void => {
    if (draft === null) return;
    put({ states: gs.map((s) => (s.id === next.id ? next : s)) });
  };
  const setTransition = (index: number, next: AnimatorTransition): void => {
    if (draft === null) return;
    put({ transitions: gt.map((t, i) => (i === index ? next : t)) });
  };
  /** An option's value: the clip name for the model's own clips, `assetId/clip` for another asset's. */
  const choiceValue = (assetId: string, clip: string): string => (assetId === model ? clip : `${assetId}/${clip}`);
  const clipSelect = (value: AnimatorClipRef, onPick: (c: AnimatorClipRef) => void, label: string): JSX.Element => (
    <select className="tl-input" aria-label={label} value={clips.some((c) => c.assetId === value.assetId && c.name === value.clip) ? choiceValue(value.assetId, value.clip) : ''} onChange={(e) => {
      const c = clips.find((x) => choiceValue(x.assetId, x.name) === e.target.value);
      if (c !== undefined) onPick(ref(c));
    }}>
      {!clips.some((c) => c.assetId === value.assetId && c.name === value.clip) && <option value="">{clipLabel(value)} (other model)</option>}
      {clips.map((c) => (
        <option key={choiceValue(c.assetId, c.name)} value={choiceValue(c.assetId, c.name)}>
          {c.name}{c.source !== null ? ` · ${c.source}` : ''} ({c.duration.toFixed(2)} s)
        </option>
      ))}
    </select>
  );

  const paramOptions = (types: readonly string[]): JSX.Element[] =>
    (draft?.parameters ?? []).filter((x) => types.includes(x.type)).map((x) => (
      <option key={x.name} value={x.name}>
        {x.name}
      </option>
    ));

  const conditionRow = (t: AnimatorTransition, index: number, c: AnimatorCondition, j: number): JSX.Element => {
    const type = draft?.parameters.find((x) => x.name === c.parameter)?.type ?? 'float';
    const ops = type === 'trigger' ? ['trigger'] : type === 'bool' ? ['true', 'false'] : ['greater', 'less', 'equals', 'notEquals'];
    const put = (nc: AnimatorCondition): void => setTransition(index, { ...t, conditions: t.conditions.map((x, k) => (k === j ? nc : x)) });
    return (
      <div className="tl-animator__row" key={j}>
        <select className="tl-input" aria-label={`condition ${j + 1} parameter`} value={c.parameter} onChange={(e) => {
          const nt = draft?.parameters.find((x) => x.name === e.target.value)?.type ?? 'float';
          put(nt === 'trigger' ? { parameter: e.target.value, op: 'trigger' } : nt === 'bool' ? { parameter: e.target.value, op: 'true' } : { parameter: e.target.value, op: 'greater', value: 0 });
        }}>
          {paramOptions(['float', 'int', 'bool', 'trigger'])}
        </select>
        <select className="tl-input" aria-label={`condition ${j + 1} test`} value={c.op} onChange={(e) => put({ ...c, op: e.target.value as AnimatorCondition['op'] })}>
          {ops.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {c.value !== undefined && (
          <input className="tl-input tl-input--num" type="number" step={0.1} aria-label={`condition ${j + 1} value`} value={c.value} onChange={(e) => Number.isFinite(Number(e.target.value)) && put({ ...c, value: Number(e.target.value) })} />
        )}
        <button type="button" className="tl-button" aria-label={`remove condition ${j + 1}`} onClick={() => setTransition(index, { ...t, conditions: t.conditions.filter((_, k) => k !== j) })}>
          ×
        </button>
      </div>
    );
  };

  return (
    <div className={`tl-panel tl-animator${doc ? ' tl-animator--document' : ''}`} aria-label="animator">
      <div className="tl-animator__bar">
        {!doc && (
        <select className="tl-input" aria-label="animator controller" value={selectedId ?? ''} onChange={(e) => { setSelectedId(e.target.value || null); setSelection(null); }}>
          {p.controllers.length === 0 && <option value="">— no controller —</option>}
          {p.controllers.map((c) => (
            <option key={c.controllerId} value={c.controllerId}>
              {c.name}
            </option>
          ))}
        </select>
        )}
        <select className="tl-input" aria-label="animator model" value={model} onChange={(e) => setModel(e.target.value)} title="The model whose clips the controller uses">
          {rigs.length === 0 && <option value="">— no model —</option>}
          {rigs.map((m) => (
            <option key={m.assetId} value={m.assetId}>
              {m.displayName}
            </option>
          ))}
        </select>
        {!doc && (
          <>
            <button type="button" className="tl-button" onClick={() => void create('empty')}>
              New controller
            </button>
            <button type="button" className="tl-button" onClick={() => void create('platformer')} title="States and transitions for clips named idle/run/jump/fall/land">
              New from clips: Platformer
            </button>
            {p.onOpen !== undefined && draft !== null && (
              <button type="button" className="tl-button" onClick={() => p.onOpen?.(draft.controllerId)} title="Edit this controller in its own tab in the centre area">
                Open in tab
              </button>
            )}
          </>
        )}
        {draft !== null && (
          <>
            <input className="tl-input" aria-label="controller name" defaultValue={draft.name} key={`${draft.controllerId}:${draft.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value !== draft.name && save({ ...draft, name: e.target.value.trim() })} />
            <button type="button" className="tl-button" onClick={() => p.onDelete(draft.controllerId)}>
              Delete controller
            </button>
          </>
        )}
      </div>
      {!doc && p.onOpen !== undefined && p.controllers.length > 0 && (
        <ul className="tl-animator__list" aria-label="animator controllers" title="Click to edit here; double-click to open in a centre tab">
          {p.controllers.map((c) => (
            <li key={c.controllerId}>
              <button
                type="button"
                className={`tl-button${c.controllerId === selectedId ? ' is-active' : ''}`}
                aria-pressed={c.controllerId === selectedId}
                onClick={() => { setSelectedId(c.controllerId); setSelection(null); }}
                onDoubleClick={() => p.onOpen?.(c.controllerId)}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {doc && saved === null && <p className="tl-hint">This animator controller no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>}
      {(message ?? p.error) !== null && <p className="tl-lighting__message" role="alert">{message ?? p.error}</p>}
      {draft !== null && (
        <div className="tl-animator__layers" role="tablist" aria-label="animator layers">
          {[draft, ...(draft.layers ?? [])].map((l, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={layer === i}
              className={`tl-button${layer === i ? ' is-active' : ''}`}
              onClick={() => {
                setLayer(i);
                setSelection(null);
                setLinking(null);
              }}
            >
              {i === 0 ? 'Base layer' : (l as AnimatorLayer).name}
            </button>
          ))}
          <button
            type="button"
            className="tl-button"
            disabled={(draft.layers?.length ?? 0) >= MAX_LAYERS}
            title="An override layer: its own states on the bones of its mask (e.g. an upper-body attack while running)"
            onClick={() => {
              const id = newId('state', allStateIds(draft));
              const n = (draft.layers?.length ?? 0) + 1;
              const next: AnimatorLayer = { name: `Layer ${n}`, mask: [], weight: 1, states: [{ id, name: 'Empty', motion: { kind: 'empty' }, speed: 1, loop: true, position: [180, 40] }], transitions: [], entry: id };
              save({ ...draft, layers: [...(draft.layers ?? []), next] });
              setLayer(n);
              setSelection(null);
            }}
          >
            Add layer
          </button>
        </div>
      )}
      {linking !== null && <p className="tl-hint">Click the state the transition goes to (Esc cancels).</p>}
      {draft !== null && (
        <div className="tl-animator__body">
          <svg
            ref={svg}
            className="tl-animator__graph"
            aria-label="animator graph"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Escape' && (setLinking(null), setMenu(null))}
            onContextMenu={(e) => {
              e.preventDefault();
              const [x, y] = point(e);
              setMenu({ x, y, target: null });
            }}
            onClick={() => setMenu(null)}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d === null) return;
              const [x, y] = point(e);
              d.moved = true;
              setDraft(withGraph(draft, layer, { states: gs.map((s) => (s.id === d.id ? { ...s, position: [Math.max(0, x - d.dx), Math.max(0, y - d.dy)] } : s)) }));
            }}
            onPointerUp={() => {
              const d = drag.current;
              drag.current = null;
              if (d?.moved === true) save(draft);
            }}
          >
            <defs>
              <marker id="tl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#9fb4d6" />
              </marker>
            </defs>
            {gt.map((t, i) => {
              const [ax, ay] = nodePos(t.from);
              const [bx, by] = nodePos(t.to);
              const x1 = ax + NODE_W / 2;
              const y1 = ay + NODE_H / 2;
              const x2 = bx + NODE_W / 2;
              const y2 = by + NODE_H / 2;
              const len = Math.hypot(x2 - x1, y2 - y1) || 1;
              // Offset sideways so A→B and B→A do not overlap; stop at the target box.
              const ox = (-(y2 - y1) / len) * 6;
              const oy = ((x2 - x1) / len) * 6;
              const shrink = Math.min(0.45, (NODE_W / 2 + 4) / len);
              const sx = x1 + ox;
              const sy = y1 + oy;
              const ex = x2 + ox - (x2 - x1) * shrink;
              const ey = y2 + oy - (y2 - y1) * shrink;
              const selected = selection?.kind === 'transition' && selection.index === i;
              return (
                <g key={i} role="button" aria-label={`transition ${t.from === ANY ? 'Any State' : gs.find((s) => s.id === t.from)?.name} to ${gs.find((s) => s.id === t.to)?.name}`} onClick={(e) => { e.stopPropagation(); setSelection({ kind: 'transition', index: i }); }}>
                  <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={12} />
                  <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={selected ? '#f2b544' : '#9fb4d6'} strokeWidth={selected ? 2.5 : 1.5} markerEnd="url(#tl-arrow)" />
                </g>
              );
            })}
            <g
              role="button"
              aria-label="state Any State"
              onClick={(e) => { e.stopPropagation(); clickNode(ANY); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const [x, y] = point(e); setMenu({ x, y, target: ANY }); }}
            >
              <rect x={ANY_POS[0]} y={ANY_POS[1]} width={NODE_W} height={NODE_H} rx={6} className="tl-animator__node tl-animator__node--any" />
              <text x={ANY_POS[0] + NODE_W / 2} y={ANY_POS[1] + NODE_H / 2 + 4} textAnchor="middle" className="tl-animator__label">
                Any State
              </text>
            </g>
            {gs.map((s, i) => {
              const [x, y] = posOf(s, i);
              const selected = selection?.kind === 'state' && selection.id === s.id;
              return (
                <g
                  key={s.id}
                  role="button"
                  aria-label={`state ${s.name}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || linking !== null) return;
                    const [px, py] = point(e);
                    drag.current = { id: s.id, dx: px - x, dy: py - y, moved: false };
                  }}
                  onClick={(e) => { e.stopPropagation(); clickNode(s.id); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const [mx, my] = point(e); setMenu({ x: mx, y: my, target: s.id }); }}
                >
                  <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={6} className={`tl-animator__node${selected ? ' is-selected' : ''}${gentry === s.id ? ' is-entry' : ''}`} />
                  <text x={x + NODE_W / 2} y={y + NODE_H / 2 + 4} textAnchor="middle" className="tl-animator__label">
                    {s.name}
                    {s.motion.kind === 'blend1d' ? ' ◇' : s.motion.kind === 'empty' ? ' ∅' : ''}
                  </text>
                </g>
              );
            })}
          </svg>
          {menu !== null && (
            <div className="tl-menu tl-animator__menu" role="menu" style={{ left: menu.x, top: menu.y }}>
              {menu.target === null && (
                <>
                  <button type="button" role="menuitem" onClick={() => { addState('clip', [menu.x, menu.y]); setMenu(null); }}>
                    Add state
                  </button>
                  <button type="button" role="menuitem" onClick={() => { addState('blend1d', [menu.x, menu.y]); setMenu(null); }}>
                    Add blend tree
                  </button>
                  {layer > 0 && (
                    <button type="button" role="menuitem" onClick={() => { addState('empty', [menu.x, menu.y]); setMenu(null); }}>
                      Add empty state
                    </button>
                  )}
                </>
              )}
              {menu.target !== null && (
                <button type="button" role="menuitem" onClick={() => { setLinking(menu.target); setMenu(null); }}>
                  Make transition
                </button>
              )}
              {menu.target !== null && menu.target !== ANY && (
                <>
                  <button type="button" role="menuitem" onClick={() => { put({ entry: menu.target! }); setMenu(null); }}>
                    Set as entry state
                  </button>
                  <button type="button" role="menuitem" onClick={() => { deleteState(menu.target!); setMenu(null); }}>
                    Delete state
                  </button>
                </>
              )}
            </div>
          )}
          <div className="tl-animator__side">
            {layer > 0 && draft.layers?.[layer - 1] !== undefined && (
              <LayerSettings
                layer={draft.layers[layer - 1]!}
                parameters={draft.parameters}
                bones={bones}
                onChange={(next) => save({ ...draft, layers: draft.layers!.map((l, i) => (i === layer - 1 ? next : l)) })}
                onRemove={() => {
                  const rest = draft.layers!.filter((_, i) => i !== layer - 1);
                  const { layers: _drop, ...base } = draft;
                  save(rest.length > 0 ? { ...base, layers: rest } : base);
                  setLayer(0);
                  setSelection(null);
                }}
              />
            )}
            {stateSel !== null && (
              <div aria-label="state inspector">
                <div className="tl-panel__title">State</div>
                <label className="tl-field">
                  <span className="tl-field__label">name</span>
                  <input className="tl-input" aria-label="state name" defaultValue={stateSel.name} key={stateSel.id} onBlur={(e) => e.target.value.trim() !== '' && setState({ ...stateSel, name: e.target.value.trim() })} />
                </label>
                {stateSel.motion.kind === 'empty' ? (
                  <p className="tl-hint">Empty: this layer plays nothing here (the layers under it show through).</p>
                ) : stateSel.motion.kind === 'clip' ? (
                  <label className="tl-field">
                    <span className="tl-field__label">clip</span>
                    {clipSelect(stateSel.motion.clip, (c) => setState({ ...stateSel, motion: { kind: 'clip', clip: c } }), 'state clip')}
                  </label>
                ) : (
                  <>
                    <label className="tl-field">
                      <span className="tl-field__label">blend by</span>
                      <select className="tl-input" aria-label="blend parameter" value={stateSel.motion.parameter} onChange={(e) => setState({ ...stateSel, motion: { ...(stateSel.motion as Extract<AnimatorState['motion'], { kind: 'blend1d' }>), parameter: e.target.value } })}>
                        {paramOptions(['float', 'int'])}
                      </select>
                    </label>
                    {stateSel.motion.children.map((k, j) => {
                      const m = stateSel.motion as Extract<AnimatorState['motion'], { kind: 'blend1d' }>;
                      const put = (nk: typeof k): void => setState({ ...stateSel, motion: { ...m, children: m.children.map((x, q) => (q === j ? nk : x)) } });
                      return (
                        <div className="tl-animator__row" key={j}>
                          <input className="tl-input tl-input--num" type="number" step={0.1} aria-label={`blend ${j + 1} threshold`} value={k.threshold} onChange={(e) => Number.isFinite(Number(e.target.value)) && put({ ...k, threshold: Number(e.target.value) })} />
                          {clipSelect(k.clip, (c) => put({ ...k, clip: c }), `blend ${j + 1} clip`)}
                          {m.children.length > 2 && (
                            <button type="button" className="tl-button" aria-label={`remove blend ${j + 1}`} onClick={() => setState({ ...stateSel, motion: { ...m, children: m.children.filter((_, q) => q !== j) } })}>
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <button type="button" className="tl-button" onClick={() => {
                      const m = stateSel.motion as Extract<AnimatorState['motion'], { kind: 'blend1d' }>;
                      const last = m.children[m.children.length - 1]!;
                      setState({ ...stateSel, motion: { ...m, children: [...m.children, { threshold: last.threshold + 1, clip: last.clip }] } });
                    }}>
                      Add blend clip
                    </button>
                  </>
                )}
                <label className="tl-field">
                  <span className="tl-field__label">speed</span>
                  <input className="tl-input tl-input--num" type="number" min={0} max={10} step={0.05} aria-label="state speed" value={stateSel.speed} onChange={(e) => Number.isFinite(Number(e.target.value)) && setState({ ...stateSel, speed: Math.min(10, Math.max(0, Number(e.target.value))) })} />
                </label>
                <label className="tl-field">
                  <span className="tl-field__label">× parameter</span>
                  <select className="tl-input" aria-label="state speed parameter" value={stateSel.speedParameter ?? ''} onChange={(e) => {
                    const { speedParameter: _drop, ...rest } = stateSel;
                    setState(e.target.value === '' ? rest : { ...rest, speedParameter: e.target.value });
                  }}>
                    <option value="">— none —</option>
                    {paramOptions(['float'])}
                  </select>
                </label>
                <label className="tl-flag">
                  <input type="checkbox" aria-label="state loops" checked={stateSel.loop} onChange={(e) => setState({ ...stateSel, loop: e.target.checked })} />
                  loops
                </label>
                {stateSel.motion.kind === 'clip' && (
                  <div aria-label="clip events">
                    <div className="tl-field__label">events of {stateSel.motion.clip.clip}</div>
                    {draft.events.map((ev, j) => {
                      const clip = (stateSel.motion as Extract<AnimatorState['motion'], { kind: 'clip' }>).clip;
                      if (ev.assetId !== clip.assetId || ev.clip !== clip.clip) return null;
                      const put = (ne: typeof ev | null): void => save({ ...draft, events: ne === null ? draft.events.filter((_, q) => q !== j) : draft.events.map((x, q) => (q === j ? ne : x)) });
                      return (
                        <div className="tl-animator__row" key={j}>
                          <input className="tl-input" aria-label={`event ${j + 1} name`} defaultValue={ev.name} onBlur={(e) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.target.value) && put({ ...ev, name: e.target.value })} />
                          <input className="tl-input tl-input--num" type="number" step={0.01} min={0} aria-label={`event ${j + 1} time`} value={ev.time} onChange={(e) => Number(e.target.value) >= 0 && put({ ...ev, time: Number(e.target.value) })} />
                          <button type="button" className="tl-button" aria-label={`remove event ${j + 1}`} onClick={() => put(null)}>
                            ×
                          </button>
                        </div>
                      );
                    })}
                    <button type="button" className="tl-button" onClick={() => {
                      const clip = (stateSel.motion as Extract<AnimatorState['motion'], { kind: 'clip' }>).clip;
                      save({ ...draft, events: [...draft.events, { assetId: clip.assetId, clip: clip.clip, time: 0, name: 'step' }] });
                    }}>
                      Add event
                    </button>
                  </div>
                )}
              </div>
            )}
            {transSel !== null && selection?.kind === 'transition' && (
              <div aria-label="transition inspector">
                <div className="tl-panel__title">
                  Transition: {transSel.from === ANY ? 'Any State' : gs.find((s) => s.id === transSel.from)?.name} → {gs.find((s) => s.id === transSel.to)?.name}
                </div>
                {transSel.conditions.map((c, j) => conditionRow(transSel, selection.index, c, j))}
                <button type="button" className="tl-button" disabled={draft.parameters.length === 0} onClick={() => {
                  const first = draft.parameters[0]!;
                  const c: AnimatorCondition = first.type === 'trigger' ? { parameter: first.name, op: 'trigger' } : first.type === 'bool' ? { parameter: first.name, op: 'true' } : { parameter: first.name, op: 'greater', value: 0 };
                  setTransition(selection.index, { ...transSel, conditions: [...transSel.conditions, c] });
                }}>
                  Add condition
                </button>
                <label className="tl-field">
                  <span className="tl-field__label">crossfade (s)</span>
                  <input className="tl-input tl-input--num" type="number" min={0} max={10} step={0.05} aria-label="transition duration" value={transSel.duration} onChange={(e) => Number.isFinite(Number(e.target.value)) && setTransition(selection.index, { ...transSel, duration: Math.min(10, Math.max(0, Number(e.target.value))) })} />
                </label>
                <label className="tl-flag">
                  <input type="checkbox" aria-label="transition has exit time" checked={transSel.exitTime !== undefined} onChange={(e) => {
                    const { exitTime: _drop, ...rest } = transSel;
                    if (!e.target.checked && rest.conditions.length === 0) return setMessage('a transition without an exit time needs a condition');
                    setTransition(selection.index, e.target.checked ? { ...rest, exitTime: 1 } : rest);
                  }} />
                  exit time
                </label>
                {transSel.exitTime !== undefined && (
                  <input className="tl-input tl-input--num" type="number" min={0} step={0.05} aria-label="transition exit time" value={transSel.exitTime} onChange={(e) => Number(e.target.value) >= 0 && setTransition(selection.index, { ...transSel, exitTime: Number(e.target.value) })} />
                )}
                <label className="tl-field">
                  <span className="tl-field__label">interruption</span>
                  <select className="tl-input" aria-label="transition interruption" value={transSel.interruption ?? 'none'} onChange={(e) => setTransition(selection.index, { ...transSel, interruption: e.target.value as 'none' | 'source' })}>
                    <option value="none">none</option>
                    <option value="source">by the source state</option>
                  </select>
                </label>
                <button type="button" className="tl-button" onClick={() => { put({ transitions: gt.filter((_, i) => i !== selection.index) }); setSelection(null); }}>
                  Delete transition
                </button>
              </div>
            )}
            <ParameterList controller={draft} onSave={save} />
            {p.preview !== undefined && <LivePreview controller={draft} start={p.preview} />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Phase 14.6: an override layer's name, weight (and weight parameter) and its
 * bone mask, picked from the model's skeleton. A bone's checkbox toggles that
 * bone; "+ children" sets the bone and every bone under it. An empty mask
 * drives every bone.
 */
function LayerSettings({ layer, parameters, bones, onChange, onRemove }: { layer: AnimatorLayer; parameters: readonly AnimatorParameter[]; bones: readonly BoneInfo[]; onChange: (l: AnimatorLayer) => void; onRemove: () => void }): JSX.Element {
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
        <select className="tl-input" aria-label="layer weight parameter" value={layer.weightParameter ?? ''} onChange={(e) => {
          const { weightParameter: _drop, ...rest } = layer;
          onChange(e.target.value === '' ? rest : { ...rest, weightParameter: e.target.value });
        }}>
          <option value="">— none —</option>
          {parameters.filter((x) => x.type === 'float').map((x) => (
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
              <input type="checkbox" aria-label={`mask bone ${b.name}`} checked={mask.has(b.name)} onChange={(e) => {
                const next = new Set(mask);
                if (e.target.checked) next.add(b.name);
                else next.delete(b.name);
                setMask(next);
              }} />
              {b.name}
            </label>
            {bones.some((x) => x.parent === b.name) && (
              <button type="button" className="tl-button" aria-label={`mask branch ${b.name}`} title="This bone and every bone under it" onClick={() => {
                const next = new Set(mask);
                const on = !mask.has(b.name);
                for (const n of below(b.name)) if (on) next.add(n);
                else next.delete(n);
                setMask(next);
              }}>
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

function ParameterList({ controller, onSave }: { controller: AnimatorController; onSave: (c: AnimatorController) => void }): JSX.Element {
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
          {x.type === 'bool' && (
            <input type="checkbox" aria-label={`parameter ${x.name} default`} checked={x.default === true} onChange={(e) => onSave({ ...controller, parameters: controller.parameters.map((q, j) => (j === i ? { ...q, default: e.target.checked } : q)) })} />
          )}
          {(x.type === 'float' || x.type === 'int') && (
            <input className="tl-input tl-input--num" type="number" step={x.type === 'int' ? 1 : 0.1} aria-label={`parameter ${x.name} default`} value={Number(x.default ?? 0)} onChange={(e) => Number.isFinite(Number(e.target.value)) && onSave({ ...controller, parameters: controller.parameters.map((q, j) => (j === i ? { ...q, default: x.type === 'int' ? Math.trunc(Number(e.target.value)) : Number(e.target.value) } : q)) })} />
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
        <button type="button" className="tl-button" disabled={!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || controller.parameters.some((x) => x.name === name)} onClick={() => {
          const p: AnimatorParameter = type === 'trigger' ? { name, type } : { name, type, default: type === 'bool' ? false : 0 };
          onSave({ ...controller, parameters: [...controller.parameters, p] });
          setName('');
        }}>
          Add parameter
        </button>
      </div>
    </div>
  );
}

function LivePreview({ controller, start }: { controller: AnimatorController; start: NonNullable<AnimatorPanelProps['preview']> }): JSX.Element {
  const [on, setOn] = useState(false);
  const [state, setState] = useState('');
  const [layerStates, setLayerStates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<AnimatorPreview | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const key = JSON.stringify(controller);
  // (Re)start while on: an edited controller restarts the preview with the values kept.
  useEffect(() => {
    if (!on || canvas.current === null) return;
    let cancelled = false;
    void start(controller, canvas.current).then((r) => {
      if (typeof r === 'string') {
        if (!cancelled) {
          setError(r);
          setOn(false);
        }
        return;
      }
      if (cancelled) {
        r.dispose();
        return;
      }
      setError(null);
      for (const [k, v] of Object.entries(valuesRef.current)) r.set(k, v);
      live.current = r;
    });
    const timer = setInterval(() => {
      setState(live.current?.state() ?? '');
      setLayerStates(live.current?.layerStates?.() ?? []);
    }, 100);
    return () => {
      cancelled = true;
      clearInterval(timer);
      live.current?.dispose();
      live.current = null;
    };
  }, [on, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (name: string, v: number | boolean): void => {
    setValues((x) => ({ ...x, [name]: v }));
    live.current?.set(name, v);
  };
  const valueOf = (x: AnimatorParameter): number | boolean => values[x.name] ?? x.default ?? (x.type === 'bool' ? false : 0);
  return (
    <div aria-label="animator preview panel">
      <div className="tl-panel__title">Live preview</div>
      <button type="button" className="tl-button" onClick={() => setOn(!on)} disabled={controller.states.length === 0}>
        {on ? 'Stop preview' : 'Preview'}
      </button>
      {error !== null && <p className="tl-hint" role="alert">{error}</p>}
      {on && (
        <>
          <canvas className="tl-animator__preview" aria-label="animator preview" data-state={state} data-layer-states={layerStates.slice(1).join('|')} ref={canvas} />
          <div className="tl-hint">state: <b aria-label="preview state">{state}</b>
            {layerStates.slice(1).map((x, i) => (
              <span key={i}> · {controller.layers?.[i]?.name ?? `layer ${i + 1}`}: <b aria-label={`preview layer ${i + 1} state`}>{x}</b></span>
            ))}
          </div>
          {controller.parameters.map((x) => (
            <div className="tl-animator__row" key={x.name}>
              <span className="tl-animator__param">{x.name}</span>
              {x.type === 'bool' && <input type="checkbox" aria-label={`preview ${x.name}`} checked={valueOf(x) === true} onChange={(e) => set(x.name, e.target.checked)} />}
              {(x.type === 'float' || x.type === 'int') && (
                <>
                  <input type="range" aria-label={`preview ${x.name}`} min={-10} max={10} step={x.type === 'int' ? 1 : 0.1} value={Number(valueOf(x))} onChange={(e) => set(x.name, Number(e.target.value))} />
                  <small>{Number(valueOf(x)).toFixed(x.type === 'int' ? 0 : 1)}</small>
                </>
              )}
              {x.type === 'trigger' && (
                <button type="button" className="tl-button" aria-label={`preview ${x.name}`} onClick={() => live.current?.trigger(x.name)}>
                  fire
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
