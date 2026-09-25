/**
 * Phase 20.0/20.1: the "Effect: <name>" centre tab — an effect's particle
 * systems, each a node graph (graph kind `effect`) on the graph framework.
 *
 * - Left: the effect's settings (duration, loop, seed, culling bounds), its
 *   systems (pick the one shown; "+ System" adds one with the four context
 *   nodes; name, max particles, simulation space, remove) and its exposed
 *   parameters. Each change is one `setEffect` (a rename is `renameEffect`).
 * - The graph of the shown system: every gesture is one `graphEdit` on owner
 *   kind `effect` (owner id `<effectId>/<systemId>`); the selection shows in
 *   the right dock's Inspector (GraphInspector with curve and gradient
 *   widgets).
 * - Phase 20.3: the looping preview pane (right column, `EffectPreviewPane`):
 *   the effect on its own renderer with the executor Play would use, a
 *   timeline (play/pause, restart, scrub), spawn counters, the frame cost and
 *   preview-only parameter sliders; it follows every edit live.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { EffectDef, EffectParameter, GraphValue } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphContext, GraphKindDef, GraphOp } from '../../graph/model';
import { newSystem, uniqueId } from '../../session/effect-edit';
import { ParameterValue } from '../material/MaterialDocument';
import { EffectPreviewPane, type EffectPreviewPaneProps } from './EffectPreviewPane';

export interface EffectDocumentProps {
  effectId: string;
  effects: readonly EffectDef[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  /** The system shown for each effect (App keeps it so the Inspector follows it). */
  systemOf: (effectId: string) => string | null;
  onSystem: (effectId: string, systemId: string | null) => void;
  /** Sends `graphEdit` ops for one system (owner id `<effectId>/<systemId>`; queued; resolves with a refusal or null). */
  onEdit: (ownerId: string, ops: GraphOp[]) => Promise<string | null>;
  /** One `setEffect`. */
  onSave: (effect: EffectDef) => void;
  /** One `renameEffect`. */
  onRename: (effectId: string, name: string) => void;
  onSelection: (ids: readonly string[]) => void;
  focus: { id: string; nonce: number } | null;
  error: string | null;
  /** Phase 20.3: the preview's environment (the project's, with its wind; null = a neutral backdrop). */
  environment: EffectPreviewPaneProps['environment'];
  /** A texture asset's texture (particle textures in the preview). */
  loadTexture: EffectPreviewPaneProps['loadTexture'];
  /** A model asset's scene (mesh particles and mesh-surface shapes in the preview). */
  loadModel?: EffectPreviewPaneProps['loadModel'];
}

/** The system a tab shows: the chosen one while it exists (a new one may still be on its way), else the first. */
export function shownSystem(fx: EffectDef, chosen: string | null): EffectDef['systems'][number] | null {
  return fx.systems.find((s) => s.systemId === chosen) ?? fx.systems[0] ?? null;
}

/** What the effect's Parameter nodes read: its exposed parameters' types. */
export function effectPortContext(parameters: readonly EffectParameter[] | undefined): GraphContext {
  return { lookup: (name, value) => (name === 'parameter' ? ((parameters ?? []).find((p) => p.key === value)?.type ?? null) : null) };
}

const PARAM_TYPES: readonly EffectParameter['type'][] = ['float', 'vec3', 'color'];
const paramDefault = (t: EffectParameter['type']): EffectParameter['default'] => (t === 'color' ? '#ffffff' : t === 'vec3' ? [0, 0, 0] : 0);

export function EffectDocument(p: EffectDocumentProps): JSX.Element {
  const fx = p.effects.find((x) => x.effectId === p.effectId) ?? null;
  const kind = p.kinds['effect'];
  const portContext = useMemo(() => effectPortContext(fx?.parameters), [fx?.parameters]);
  const system = fx !== null ? shownSystem(fx, p.systemOf(p.effectId)) : null;
  if (fx === null) return <p className="tl-hint">This effect no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (kind === undefined) return <p className="tl-hint">Loading the effect node catalogue…</p>;
  const save = (patch: Partial<EffectDef>): void => p.onSave({ ...fx, ...patch });
  const addSystem = (): void => {
    const name = `System ${fx.systems.length + 1}`;
    const id = uniqueId(name, fx.systems.map((s) => s.systemId), 'system');
    p.onSave({ ...fx, systems: [...fx.systems, newSystem(id, name)] });
    p.onSystem(fx.effectId, id);
  };
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => {
    // A new Parameter node reads the first parameter; a new "From event" listens to another system.
    if (type === 'value.parameter' && (fx.parameters ?? []).length > 0) return { key: fx.parameters![0]!.key };
    const other = fx.systems.find((s) => s.systemId !== system?.systemId);
    if (type === 'spawn.event' && other !== undefined) return { system: other.systemId };
    return undefined;
  };
  return (
    <div className="tl-animator-doc tl-effect-doc" aria-label="effect graph">
      <div className="tl-animator__bar">
        <input className="tl-input" aria-label="effect name" defaultValue={fx.name} key={`${fx.effectId}:${fx.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== fx.name && p.onRename(fx.effectId, e.target.value.trim().slice(0, 128))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className="tl-hint">Effect · {fx.systems.length} system{fx.systems.length === 1 ? '' : 's'}</span>
      </div>
      <p className="tl-hint tl-material-doc__note" role="note">
        The preview plays the effect as Play would (WebGPU compute, or the CPU executor on WebGL 2) and follows every edit. Effects are visual only: they never change the game simulation.
      </p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator-doc__main">
        <div className="tl-animator-doc__side">
          <div className="tl-subhead">Effect</div>
          <div className="tl-effect-doc__settings">
            <span>Duration (s)</span>
            <NumberBox label="effect duration" value={fx.duration} min={0.01} max={3600} onCommit={(n) => save({ duration: n })} />
            <span>Loop</span>
            <input type="checkbox" aria-label="effect loop" checked={fx.loop} onChange={(e) => save({ loop: e.target.checked })} />
            <span>Seed</span>
            <NumberBox label="effect seed" value={fx.seed} min={0} max={4294967295} integer onCommit={(n) => save({ seed: n })} />
            <span>Bounds centre</span>
            <VecBox label="effect bounds centre" value={fx.bounds.center} onCommit={(v) => save({ bounds: { ...fx.bounds, center: v } })} />
            <span>Bounds size</span>
            <VecBox label="effect bounds size" value={fx.bounds.size} positive onCommit={(v) => save({ bounds: { ...fx.bounds, size: v } })} />
          </div>
          <div className="tl-subhead">
            Systems
            <button type="button" className="tl-btn tl-btn--small" aria-label="add system" onClick={addSystem} disabled={fx.systems.length >= 16}>
              + System
            </button>
          </div>
          <div className="tl-effect-doc__systems" role="tablist" aria-label="systems">
            {fx.systems.map((s) => (
              <button key={s.systemId} type="button" role="tab" aria-selected={s.systemId === system?.systemId} className={`tl-tab${s.systemId === system?.systemId ? ' is-active' : ''}`} onClick={() => p.onSystem(fx.effectId, s.systemId)}>
                {s.name}
              </button>
            ))}
          </div>
          {system !== null && (
            <div className="tl-effect-doc__settings" aria-label="system settings">
              <span>Name</span>
              <input className="tl-input" aria-label="system name" defaultValue={system.name} key={`${system.systemId}:${system.name}`} maxLength={128} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== system.name && save({ systems: fx.systems.map((s) => (s === system ? { ...s, name: e.target.value.trim() } : s)) })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
              <span>Max particles</span>
              <NumberBox label="system max particles" value={system.maxParticles} min={1} max={1048576} integer onCommit={(n) => save({ systems: fx.systems.map((s) => (s === system ? { ...s, maxParticles: n } : s)) })} />
              <span>Space</span>
              <select className="tl-input" aria-label="system space" value={system.space} onChange={(e) => save({ systems: fx.systems.map((s) => (s === system ? { ...s, space: e.target.value as 'local' | 'world' } : s)) })}>
                <option value="local">local (moves with the object)</option>
                <option value="world">world (stays where born)</option>
              </select>
              <span />
              <button type="button" className="tl-btn tl-btn--small" aria-label="remove system" onClick={() => save({ systems: fx.systems.filter((s) => s !== system) })}>
                Remove system
              </button>
            </div>
          )}
          <EffectParameters effect={fx} onSave={p.onSave} />
        </div>
        <div className="tl-animator-doc__graph">
          {system === null ? (
            <p className="tl-hint">No systems yet: "+ System" adds one (its graph starts with the Spawn, Initialize, Update and Output contexts).</p>
          ) : (
            <GraphEditor
              key={`${fx.effectId}/${system.systemId}`}
              kind={kind}
              owner={{ kind: 'effect', id: `${fx.effectId}/${system.systemId}` }}
              graph={system.graph}
              onEdit={(ops) => p.onEdit(`${fx.effectId}/${system.systemId}`, ops)}
              onSelection={p.onSelection}
              focus={p.focus}
              newNodeData={newNodeData}
              portContext={portContext}
            />
          )}
        </div>
        <div className="tl-animator-doc__preview tl-animator-doc__preview--right tl-effect-doc__preview">
          <EffectPreviewPane effect={fx} environment={p.environment} loadTexture={p.loadTexture} {...(p.loadModel !== undefined ? { loadModel: p.loadModel } : {})} />
        </div>
      </div>
    </div>
  );
}

/** The exposed parameters: one row per parameter; each change is one `setEffect`. */
function EffectParameters({ effect, onSave }: { effect: EffectDef; onSave: (e: EffectDef) => void }): JSX.Element {
  const list = effect.parameters ?? [];
  const save = (next: EffectParameter[]): void => onSave({ ...effect, parameters: next });
  const setAt = (i: number, patch: Partial<EffectParameter>): void => save(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = (): void => {
    let n = list.length + 1;
    while (list.some((x) => x.key === `param${n}`)) n++;
    save([...list, { key: `param${n}`, type: 'float', default: 0 }]);
  };
  return (
    <div className="tl-material-params" aria-label="exposed parameters">
      <div className="tl-subhead">
        Exposed parameters
        <button type="button" className="tl-btn tl-btn--small" onClick={add} title="A value Parameter nodes read (objects may override public ones)" disabled={list.length >= 32}>
          + parameter
        </button>
      </div>
      {list.length === 0 && <p className="tl-hint">None yet. Parameter nodes read these; objects override the public ones (Inspector → Effect).</p>}
      {list.map((x, i) => (
        <div key={`${i}:${x.key}`} className="tl-material-param" data-parameter={x.key}>
          <input className="tl-input" aria-label={`parameter ${i + 1} key`} defaultValue={x.key} maxLength={32} onBlur={(e) => e.target.value !== x.key && setAt(i, { key: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <select
            className="tl-input"
            aria-label={`parameter ${x.key} type`}
            value={x.type}
            onChange={(e) => {
              // A new type starts at its default; a colour has no range.
              const type = e.target.value as EffectParameter['type'];
              const { min: _a, max: _b, ...rest } = x;
              save(list.map((y, j) => (j === i ? { ...(type === 'color' ? rest : x), type, default: paramDefault(type) } : y)));
            }}
          >
            {PARAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <ParameterValue param={x} textures={[]} onCommit={(v) => setAt(i, { default: v })} />
          <select className="tl-input" aria-label={`parameter ${x.key} visibility`} value={x.visibility ?? 'public'} onChange={(e) => setAt(i, { visibility: e.target.value as 'public' | 'private' })}>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove parameter ${x.key}`} onClick={() => save(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function NumberBox({ label, value, min, max, integer, onCommit }: { label: string; value: number; min: number; max: number; integer?: boolean; onCommit: (v: number) => void }): JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer === true && !Number.isInteger(n))) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return <input className="tl-input tl-input--num" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function VecBox({ label, value, positive, onCommit }: { label: string; value: readonly [number, number, number]; positive?: boolean; onCommit: (v: [number, number, number]) => void }): JSX.Element {
  const shown = value.join(', ');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = (): void => {
    const parts = text.split(',').map((x) => Number(x.trim()));
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e4 || (positive === true && x <= 0))) {
      setText(shown);
      return;
    }
    if (parts.join(', ') !== shown) onCommit([parts[0]!, parts[1]!, parts[2]!]);
  };
  return <input className="tl-input" aria-label={label} title="x, y, z (metres)" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
