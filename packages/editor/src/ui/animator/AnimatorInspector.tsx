/**
 * Phase 16.2: the right-dock Inspector while an "Animator: <controller>" tab
 * is in front — the GraphInspector (16.1) with the animator's extension:
 *
 * - a state: name, clip (or blend parameter + "Open blend tree"), speed and
 *   its × parameter, loop, "Set as entry state", clip events, its outgoing
 *   transitions (click one to select its wire);
 * - a transition wire (a state pair): its transitions in priority order,
 *   each with conditions, crossfade, exit time and interruption; add
 *   another, reorder, remove; delete the wire;
 * - a blend tree's clip: threshold and clip; the Blend node: the parameter.
 *
 * Node fields go through `graphEdit` (setNodeData / connect / remove: the
 * graph's ops, written into the controller by the backend); transitions and
 * clip events are controller data edited with `setAnimator` — both one
 * command and one undo step each. Groups and comments use the generic forms.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { AnimatorCondition, AnimatorController, AnimatorState, AnimatorTransition, GraphNode, GraphValue } from '@thirdlight/project-model';

import { GraphInspector } from '../../graph/GraphInspector';
import { ANIMATOR_ANY, ANIMATOR_ENTRY, ANIMATOR_ENTRY_WIRE, animatorBlendStateOf, animatorGraphOf, animatorLayerOf, animatorOwnerId, animatorTransitionPairs, parseAnimatorOwnerId, type AnimatorOwnerTarget } from '../../graph/animator';
import { nodeDefOf, type GraphKindDef, type GraphOp } from '../../graph/model';
import { ClipSelect, paramOptions, rigOf, useClipChoices, type AnimatorModels, type ClipInfo } from './parts';

export interface AnimatorInspectorProps {
  controller: AnimatorController;
  /** The graph in front (an animator owner id). */
  ownerId: string;
  ids: readonly string[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  models: AnimatorModels;
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
  onGraphEdit: (ownerId: string, ops: GraphOp[]) => Promise<string | null>;
  onSave: (controller: AnimatorController) => void;
  /** Show another graph of the controller (a blend tree). */
  onTarget: (ownerId: string) => void;
  /** Select and frame an item of the graph in front. */
  onFocus: (id: string) => void;
}

function withLayerTransitions(c: AnimatorController, layer: number, transitions: AnimatorTransition[]): AnimatorController {
  if (layer === 0) return { ...c, transitions };
  return { ...c, layers: (c.layers ?? []).map((l, i) => (i === layer - 1 ? { ...l, transitions } : l)) };
}

/** A node's data with one field set (a field default is not stored, like the read side). */
function dataWith(node: GraphNode, kind: GraphKindDef, patch: Record<string, GraphValue>): Record<string, GraphValue> {
  const def = nodeDefOf(kind, node.type);
  const data = { ...(node.data ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    const f = def?.fields?.find((x) => x.key === k);
    if (f !== undefined && JSON.stringify(f.default) === JSON.stringify(v)) delete data[k];
    else data[k] = v;
  }
  return data;
}

export function AnimatorInspector(p: AnimatorInspectorProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [p.ids.join(','), p.ownerId]);
  const c = p.controller;
  const asked = parseAnimatorOwnerId(p.ownerId);
  // A graph that is gone (a removed layer or blend tree) falls back to the base layer, like the tab.
  const target: AnimatorOwnerTarget = asked !== null && asked.controllerId === c.controllerId && animatorGraphOf(c, asked) !== null ? asked : { controllerId: c.controllerId, layer: 0 };
  const view = animatorGraphOf(c, target);
  const kind = view !== null ? p.kinds[view.kindId] : undefined;
  const model = rigOf(c, p.models) ?? '';
  const clips = useClipChoices(model, p.models, p.clipsOf);
  if (view === null || kind === undefined) return <div className="tl-inspector__empty">Loading…</div>;
  const graph = view.graph;
  const edit = (ops: GraphOp[]): void => void p.onGraphEdit(animatorOwnerId(target), ops).then(setError);
  const layerIndex = 'blendState' in target ? 0 : target.layer;
  const layer = 'blendState' in target ? null : animatorLayerOf(c, target.layer);
  const stateName = (id: string): string => (id === ANIMATOR_ANY || id === '*' ? 'Any State' : layer?.states.find((s) => s.id === id)?.name ?? id);

  const extension = (id: string): JSX.Element | null => {
    const node = graph.nodes.find((n) => n.id === id);
    const edge = graph.edges.find((e) => e.id === id);
    if ('blendState' in target) {
      if (node?.type === 'clip') return <BlendClip node={node} kind={kind} clips={clips} model={model} edit={edit} />;
      if (node?.type === 'output') {
        const s = animatorBlendStateOf(c, target.blendState);
        const parentOwner = animatorOwnerId({ controllerId: c.controllerId, layer: [c, ...(c.layers ?? [])].findIndex((l) => l.states.some((x) => x.id === target.blendState)) });
        const parentView = animatorGraphOf(c, parseAnimatorOwnerId(parentOwner)!);
        const parentNode = parentView?.graph.nodes.find((n) => n.id === target.blendState);
        const parentKind = parentView !== null && parentView !== undefined ? p.kinds[parentView.kindId] : undefined;
        return (
          <>
            <div className="tl-inspector__title">Blend tree: {s?.name}</div>
            <p className="tl-hint">Every clip feeds the blend; the parameter picks the mix between the clips at the thresholds around its value.</p>
            <label className="tl-field">
              <span>Blend by</span>
              <select
                className="tl-input"
                aria-label="blend parameter"
                value={s?.motion.kind === 'blend1d' ? s.motion.parameter : ''}
                onChange={(e) => parentNode !== undefined && parentKind !== undefined && void p.onGraphEdit(parentOwner, [{ op: 'setNodeData', id: parentNode.id, data: dataWith(parentNode, parentKind, { parameter: e.target.value }) }]).then(setError)}
              >
                {paramOptions(c, ['float', 'int'])}
              </select>
            </label>
          </>
        );
      }
      if (edge !== undefined) return <p className="tl-hint">Every clip of a blend tree feeds the Blend node; remove a clip by deleting its node.</p>;
      return null;
    }
    if (node?.type === 'entry') return <p className="tl-hint">Entry: the layer starts in the state its wire goes to ({stateName(layer?.entry ?? '')}). Drag a new wire from Entry to change it.</p>;
    if (node?.type === 'any') return <p className="tl-hint">Any State: its transitions may fire from every state of the layer (drag a wire from it to a state).</p>;
    if (node !== undefined && (node.type === 'state' || node.type === 'blend' || node.type === 'empty')) {
      const s = layer?.states.find((x) => x.id === node.id);
      if (s === undefined) return null;
      return (
        <StateFields
          key={s.id}
          controller={c}
          state={s}
          node={node}
          kind={kind}
          clips={clips}
          model={model}
          entry={layer?.entry === s.id}
          edit={edit}
          onSave={p.onSave}
          outgoing={animatorTransitionPairs(layer?.transitions ?? []).filter((x) => x.from === s.id).map((x) => ({ id: x.id, label: `→ ${stateName(x.to)}${x.indices.length > 1 ? ` (×${x.indices.length})` : ''}` }))}
          onFocus={p.onFocus}
          onOpenBlend={() => p.onTarget(animatorOwnerId({ controllerId: c.controllerId, blendState: s.id }))}
        />
      );
    }
    if (edge !== undefined && layer !== null) {
      if (edge.id === ANIMATOR_ENTRY_WIRE || edge.from.node === ANIMATOR_ENTRY) return <p className="tl-hint">Entry → {stateName(edge.to.node)}: the layer starts in this state.</p>;
      const pair = animatorTransitionPairs(layer.transitions).find((x) => x.id === edge.id);
      if (pair === undefined) return null;
      return (
        <TransitionList
          key={pair.id}
          controller={c}
          title={`${stateName(pair.from)} → ${stateName(pair.to)}`}
          transitions={layer.transitions}
          indices={pair.indices}
          onChange={(next) => p.onSave(withLayerTransitions(c, layerIndex, next))}
          onDeleteWire={() => edit([{ op: 'disconnect', ids: [edge.id] }])}
          onError={setError}
        />
      );
    }
    return null;
  };

  return (
    <>
      <GraphInspector
        kind={kind}
        graph={graph}
        ids={p.ids}
        onEdit={(ops) => p.onGraphEdit(animatorOwnerId(target), ops)}
        extension={extension}
        empty={<div className="tl-inspector__empty">{'blendState' in target ? 'Select a clip of the blend tree, or the Blend node.' : 'Select a state or a transition wire. Right click the graph (or + Node) to add a state; drag from a state’s output to another state for a transition.'}</div>}
      />
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface StateFieldsProps {
  controller: AnimatorController;
  state: AnimatorState;
  node: GraphNode;
  kind: GraphKindDef;
  clips: Parameters<typeof ClipSelect>[0]['clips'];
  model: string;
  entry: boolean;
  edit: (ops: GraphOp[]) => void;
  onSave: (c: AnimatorController) => void;
  outgoing: { id: string; label: string }[];
  onFocus: (id: string) => void;
  onOpenBlend: () => void;
}

function StateFields({ controller: c, state: s, node, kind, clips, model, entry, edit, onSave, outgoing, onFocus, onOpenBlend }: StateFieldsProps): JSX.Element {
  const set = (patch: Record<string, GraphValue>): void => edit([{ op: 'setNodeData', id: node.id, data: dataWith(node, kind, patch) }]);
  const [speed, setSpeed] = useState(String(s.speed));
  useEffect(() => setSpeed(String(s.speed)), [s.speed]);
  const commitSpeed = (): void => {
    const n = Number(speed);
    if (speed.trim() === '' || !Number.isFinite(n)) return setSpeed(String(s.speed));
    const v = Math.min(10, Math.max(0, n));
    if (v !== s.speed) set({ speed: v });
    else setSpeed(String(s.speed));
  };
  return (
    <div aria-label="state inspector">
      <div className="tl-inspector__title">{s.motion.kind === 'blend1d' ? 'Blend tree' : s.motion.kind === 'empty' ? 'Empty state' : 'State'}{entry ? ' (entry)' : ''}</div>
      <label className="tl-field">
        <span>Name</span>
        <input className="tl-input" aria-label="state name" defaultValue={s.name} key={s.name} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== s.name && set({ name: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
      {s.motion.kind === 'empty' && <p className="tl-hint">Empty: this layer plays nothing here (the layers under it show through).</p>}
      {s.motion.kind === 'clip' && (
        <label className="tl-field">
          <span>Clip</span>
          <ClipSelect value={s.motion.clip} clips={clips} model={model} label="state clip" onPick={(k) => set({ clip: k.clip, asset: k.assetId, duration: k.duration })} />
        </label>
      )}
      {s.motion.kind === 'blend1d' && (
        <>
          <label className="tl-field">
            <span>Blend by</span>
            <select className="tl-input" aria-label="blend parameter" value={s.motion.parameter} onChange={(e) => set({ parameter: e.target.value })}>
              {paramOptions(c, ['float', 'int'])}
            </select>
          </label>
          <p className="tl-hint">
            {s.motion.children.length} clips: {s.motion.children.map((k) => `${k.clip.clip} @ ${k.threshold}`).join(', ')}
          </p>
          <button type="button" className="tl-button" onClick={onOpenBlend} title="Show the blend tree's clips as a graph (or double-click the node)">
            Open blend tree
          </button>
        </>
      )}
      <label className="tl-field">
        <span>Speed</span>
        <input className="tl-input tl-input--num" aria-label="state speed" value={speed} onChange={(e) => setSpeed(e.target.value)} onBlur={commitSpeed} onKeyDown={(e) => e.key === 'Enter' && commitSpeed()} />
      </label>
      <label className="tl-field">
        <span>× parameter</span>
        <select className="tl-input" aria-label="state speed parameter" value={s.speedParameter ?? ''} onChange={(e) => set({ speedParameter: e.target.value })}>
          <option value="">— none —</option>
          {paramOptions(c, ['float'])}
        </select>
      </label>
      <label className="tl-field tl-field--check">
        <input type="checkbox" aria-label="state loops" checked={s.loop} onChange={(e) => set({ loop: e.target.checked })} />
        <span>Loops</span>
      </label>
      {!entry && (
        <button
          type="button"
          className="tl-button"
          onClick={() => edit([{ op: 'disconnect', ids: [ANIMATOR_ENTRY_WIRE] }, { op: 'connect', edges: [{ id: 'entry-new', from: { node: ANIMATOR_ENTRY, port: 'out' }, to: { node: s.id, port: 'in' } }] }])}
        >
          Set as entry state
        </button>
      )}
      <button type="button" className="tl-button" onClick={() => edit([{ op: 'removeNodes', ids: [s.id] }])}>
        Delete state
      </button>
      {s.motion.kind === 'clip' && (
        <div aria-label="clip events">
          <div className="tl-field__label">events of {s.motion.clip.clip}</div>
          {c.events.map((ev, j) => {
            const clip = (s.motion as Extract<AnimatorState['motion'], { kind: 'clip' }>).clip;
            if (ev.assetId !== clip.assetId || ev.clip !== clip.clip) return null;
            const put = (ne: typeof ev | null): void => onSave({ ...c, events: ne === null ? c.events.filter((_, q) => q !== j) : c.events.map((x, q) => (q === j ? ne : x)) });
            return (
              <div className="tl-animator__row" key={j}>
                <input className="tl-input" aria-label={`event ${j + 1} name`} defaultValue={ev.name} onBlur={(e) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.target.value) && e.target.value !== ev.name && put({ ...ev, name: e.target.value })} />
                <input className="tl-input tl-input--num" type="number" step={0.01} min={0} aria-label={`event ${j + 1} time`} value={ev.time} onChange={(e) => Number(e.target.value) >= 0 && put({ ...ev, time: Number(e.target.value) })} />
                <button type="button" className="tl-button" aria-label={`remove event ${j + 1}`} onClick={() => put(null)}>
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="tl-button"
            onClick={() => {
              const clip = (s.motion as Extract<AnimatorState['motion'], { kind: 'clip' }>).clip;
              onSave({ ...c, events: [...c.events, { assetId: clip.assetId, clip: clip.clip, time: 0, name: 'step' }] });
            }}
          >
            Add event
          </button>
        </div>
      )}
      <div aria-label="outgoing transitions">
        <div className="tl-field__label">transitions from here</div>
        {outgoing.length === 0 && <p className="tl-hint">None: drag from this state&apos;s output to another state.</p>}
        {outgoing.map((o) => (
          <button key={o.id} type="button" className="tl-button tl-animator__link" onClick={() => onFocus(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlendClip({ node, kind, clips, model, edit }: { node: GraphNode; kind: GraphKindDef; clips: Parameters<typeof ClipSelect>[0]['clips']; model: string; edit: (ops: GraphOp[]) => void }): JSX.Element {
  const d = node.data ?? {};
  const threshold = typeof d['threshold'] === 'number' ? d['threshold'] : 0;
  const [text, setText] = useState(String(threshold));
  useEffect(() => setText(String(threshold)), [threshold]);
  const set = (patch: Record<string, GraphValue>): void => edit([{ op: 'setNodeData', id: node.id, data: dataWith(node, kind, patch) }]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(threshold));
    if (n !== threshold) set({ threshold: n });
  };
  const value = { assetId: String(d['asset'] ?? ''), clip: String(d['clip'] ?? ''), duration: typeof d['duration'] === 'number' ? d['duration'] : 1 };
  return (
    <div aria-label="blend clip inspector">
      <div className="tl-inspector__title">Blend clip</div>
      <label className="tl-field">
        <span>Threshold</span>
        <input className="tl-input tl-input--num" aria-label="blend threshold" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      </label>
      <label className="tl-field">
        <span>Clip</span>
        <ClipSelect value={value} clips={clips} model={model} label="blend clip" onPick={(k) => set({ clip: k.clip, asset: k.assetId, duration: k.duration })} />
      </label>
      <p className="tl-hint">Clips are kept in threshold order; two clips cannot share a threshold.</p>
      <button type="button" className="tl-button" onClick={() => edit([{ op: 'removeNodes', ids: [node.id] }])}>
        Remove clip
      </button>
    </div>
  );
}

interface TransitionListProps {
  controller: AnimatorController;
  title: string;
  /** The layer's whole list (the pair's are at `indices`, in priority order). */
  transitions: AnimatorTransition[];
  indices: number[];
  onChange: (next: AnimatorTransition[]) => void;
  onDeleteWire: () => void;
  onError: (e: string | null) => void;
}

function TransitionList({ controller: c, title, transitions, indices, onChange, onDeleteWire, onError }: TransitionListProps): JSX.Element {
  const put = (index: number, next: AnimatorTransition): void => onChange(transitions.map((t, i) => (i === index ? next : t)));
  const first = transitions[indices[0]!]!;
  return (
    <div aria-label="transition inspector">
      <div className="tl-inspector__title">Transition{indices.length > 1 ? `s (${indices.length})` : ''}: {title}</div>
      {indices.length > 1 && <p className="tl-hint">Checked in this order; the first whose conditions hold fires.</p>}
      {indices.map((index, k) => {
        const t = transitions[index]!;
        return (
          <fieldset key={index} className="tl-animator__transition" aria-label={`transition ${k + 1}`}>
            {indices.length > 1 && (
              <legend>
                #{k + 1}
                <button type="button" className="tl-button" aria-label={`move transition ${k + 1} up`} disabled={k === 0} onClick={() => {
                  const other = indices[k - 1]!;
                  const next = [...transitions];
                  [next[other], next[index]] = [next[index]!, next[other]!];
                  onChange(next);
                }}>
                  ↑
                </button>
                <button type="button" className="tl-button" aria-label={`remove transition ${k + 1}`} onClick={() => onChange(transitions.filter((_, i) => i !== index))}>
                  ×
                </button>
              </legend>
            )}
            {t.conditions.map((cond, j) => (
              <ConditionRow key={j} controller={c} condition={cond} index={j} onChange={(nc) => put(index, { ...t, conditions: nc === null ? t.conditions.filter((_, q) => q !== j) : t.conditions.map((x, q) => (q === j ? nc : x)) })} />
            ))}
            <button
              type="button"
              className="tl-button"
              disabled={c.parameters.length === 0}
              onClick={() => {
                const p0 = c.parameters[0]!;
                const nc: AnimatorCondition = p0.type === 'trigger' ? { parameter: p0.name, op: 'trigger' } : p0.type === 'bool' ? { parameter: p0.name, op: 'true' } : { parameter: p0.name, op: 'greater', value: 0 };
                put(index, { ...t, conditions: [...t.conditions, nc] });
              }}
            >
              Add condition
            </button>
            <NumberRow label="transition duration" title="crossfade (s)" value={t.duration} min={0} max={10} onCommit={(v) => put(index, { ...t, duration: v })} />
            <label className="tl-field tl-field--check">
              <input
                type="checkbox"
                aria-label="transition has exit time"
                checked={t.exitTime !== undefined}
                onChange={(e) => {
                  const { exitTime: _drop, ...rest } = t;
                  if (!e.target.checked && rest.conditions.length === 0) return onError('a transition without an exit time needs a condition');
                  put(index, e.target.checked ? { ...rest, exitTime: 1 } : rest);
                }}
              />
              <span>exit time</span>
            </label>
            {t.exitTime !== undefined && <NumberRow label="transition exit time" title="exit time (normalized)" value={t.exitTime} min={0} max={100} onCommit={(v) => put(index, { ...t, exitTime: v })} />}
            <label className="tl-field">
              <span>interruption</span>
              <select className="tl-input" aria-label="transition interruption" value={t.interruption ?? 'none'} onChange={(e) => put(index, { ...t, interruption: e.target.value as 'none' | 'source' })}>
                <option value="none">none</option>
                <option value="source">by the source state</option>
              </select>
            </label>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="tl-button"
        title="Another transition between the same two states (e.g. on a different condition)"
        onClick={() => onChange([...transitions, { from: first.from, to: first.to, conditions: [], duration: first.duration, exitTime: 1 }])}
      >
        Add transition
      </button>
      <button type="button" className="tl-button" onClick={onDeleteWire}>
        Delete {indices.length > 1 ? 'transitions' : 'transition'}
      </button>
    </div>
  );
}

function ConditionRow({ controller: c, condition: cond, index: j, onChange }: { controller: AnimatorController; condition: AnimatorCondition; index: number; onChange: (c: AnimatorCondition | null) => void }): JSX.Element {
  const type = c.parameters.find((x) => x.name === cond.parameter)?.type ?? 'float';
  const ops = type === 'trigger' ? ['trigger'] : type === 'bool' ? ['true', 'false'] : ['greater', 'less', 'equals', 'notEquals'];
  const [value, setValue] = useState(String(cond.value ?? 0));
  useEffect(() => setValue(String(cond.value ?? 0)), [cond.value]);
  return (
    <div className="tl-animator__row">
      <select
        className="tl-input"
        aria-label={`condition ${j + 1} parameter`}
        value={cond.parameter}
        onChange={(e) => {
          const nt = c.parameters.find((x) => x.name === e.target.value)?.type ?? 'float';
          onChange(nt === 'trigger' ? { parameter: e.target.value, op: 'trigger' } : nt === 'bool' ? { parameter: e.target.value, op: 'true' } : { parameter: e.target.value, op: 'greater', value: 0 });
        }}
      >
        {paramOptions(c, ['float', 'int', 'bool', 'trigger'])}
      </select>
      <select className="tl-input" aria-label={`condition ${j + 1} test`} value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as AnimatorCondition['op'] })}>
        {ops.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {cond.value !== undefined && (
        <input
          className="tl-input tl-input--num"
          aria-label={`condition ${j + 1} value`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => (Number.isFinite(Number(value)) && value.trim() !== '' && Number(value) !== cond.value ? onChange({ ...cond, value: Number(value) }) : setValue(String(cond.value)))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      <button type="button" className="tl-button" aria-label={`remove condition ${j + 1}`} onClick={() => onChange(null)}>
        ×
      </button>
    </div>
  );
}

/** A number field that commits on Enter or blur (one command per commit). */
function NumberRow({ label, title, value, min, max, onCommit }: { label: string; title: string; value: number; min: number; max: number; onCommit: (v: number) => void }): JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(value));
    const v = Math.min(max, Math.max(min, n));
    if (v !== value) onCommit(v);
    else setText(String(value));
  };
  return (
    <label className="tl-field">
      <span>{title}</span>
      <input className="tl-input tl-input--num" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}
