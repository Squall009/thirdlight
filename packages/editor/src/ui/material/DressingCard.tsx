/**
 * The Dressing card of a voxel material: which dressing the material names
 * (`voxel.dressing`: pick, create, clear; on an instance its own, else its
 * parent's) and that dressing's contents: the ordered species entries, each
 * with its model, class, density, spacing, scale, turn, lean, seed and the
 * ten conditions that say where it grows.
 *
 * It holds no copy and draws no preview: every change is one command
 * (`setMaterial` for which dressing, `setDressing` for its contents: the
 * commands MCP sends, one undo each), and the Scene view grows the cover
 * again when the change arrives. A dressing is shared by every material
 * naming it, which the card says.
 *
 * Browser-only (React).
 */
import { createContext, useContext, useState, type JSX } from 'react';
import type { FadeRange } from '@thirdlight/shared';
import type { DressingDef, DressingSpecies, MaterialDef } from '@thirdlight/project-model';
import { DRESSING_CLASSES, DRESSING_LIMITS } from '@thirdlight/project-model/dressing';
import { DRESSING_ROLE_NAMES } from '@thirdlight/voxel';

import { CONDITION_RANGE_ROWS, conditionCount, dressingUsers, materialWithDressing, newDressing, noiseWith, NOISE_SCALE_START, rangeWith, scaleWith, setWith, withCondition, withName, withSpecies, withSpeciesAdded, withSpeciesMoved, withSpeciesRemoved, type ConditionRangeRow } from '../../session/dressing-edits';
import { MODEL_KINDS, RefPicker, useEntryName } from '../catalog/RefPicker';
import { NumberField } from './NumberField';

/** What the card reads and sends: the project's dressings, the two dressing commands (resolving with a refusal's words, or null) and a free id for a new one. */
export interface DressingHost {
  readonly dressings: readonly DressingDef[];
  command(op: 'setDressing' | 'deleteDressing', args: Record<string, unknown>): Promise<string | null>;
  newId(name: string): Promise<string>;
}

/** Given where a material's Inspector is shown (absent: the card is not drawn). */
export const DressingHostContext = createContext<DressingHost | null>(null);

const DRESSING_KINDS: readonly string[] = ['dressing'];
const L = DRESSING_LIMITS;

/** One range condition: least, most and the fade past an end; empty fields are open ends. */
function RangeRow(p: { row: ConditionRangeRow; value: FadeRange | undefined; aria: string; onChange: (r: FadeRange | undefined) => void; children?: JSX.Element }): JSX.Element {
  const { row, value } = p;
  const span = row.max - row.min;
  return (
    <div className="tl-field" title={row.hint}>
      <span className="tl-field__label">
        {row.label}
        {row.unit !== '' ? ` ${row.unit}` : ''}
      </span>
      <span className="tl-dressing__range">
        <NumberField aria={`${p.aria} min`} value={value?.min} placeholder="min" min={row.min} max={row.max} step={row.step} onCommit={(min) => p.onChange(rangeWith(value, { min }))} />
        <NumberField aria={`${p.aria} max`} value={value?.max} placeholder="max" min={row.min} max={row.max} step={row.step} onCommit={(max) => p.onChange(rangeWith(value, { max }))} />
        <NumberField aria={`${p.aria} fade`} value={value?.fade} placeholder="fade" min={0} max={span} step={row.step} onCommit={(fade) => p.onChange(rangeWith(value, { fade }))} />
        {p.children}
      </span>
    </div>
  );
}

/** A set condition as ticks (none ticked: any). */
function TickSet<T extends string | number>(p: { label: string; aria: string; options: readonly { id: T; label: string }[]; value: readonly T[] | undefined; hint: string; onChange: (v: T[] | undefined) => void }): JSX.Element {
  return (
    <div className="tl-field" title={p.hint}>
      <span className="tl-field__label">{p.label}</span>
      <span className="tl-dressing__ticks" role="group" aria-label={p.aria}>
        {p.options.map((o) => (
          <label key={String(o.id)} className="tl-dressing__tick">
            <input type="checkbox" aria-label={`${p.aria} ${o.label}`} checked={p.value?.includes(o.id) === true} onChange={(e) => p.onChange(setWith(p.value, o.id, e.target.checked))} />
            {o.label}
          </label>
        ))}
        {p.value === undefined && <span className="tl-hint">any</span>}
      </span>
    </div>
  );
}

function SpeciesEntry(p: { dressing: DressingDef; index: number; species: DressingSpecies; voxelMaterials: readonly { id: number; label: string }[]; send: (next: DressingDef | null) => void }): JSX.Element {
  const { dressing: d, index: i, species: s } = p;
  const name = useEntryName(s.model, MODEL_KINDS);
  const [open, setOpen] = useState(false);
  const aria = `species ${i + 1}`;
  const set = (patch: Partial<DressingSpecies>): void => p.send(withSpecies(d, i, patch));
  const c = s.conditions ?? {};
  const spacingMax = s.class === 'cover' ? L.coverSpacingMax : L.spacingMax;
  return (
    <div className="tl-dressing__species" aria-label={aria} data-species={i}>
      <div className="tl-assets__row">
        <button type="button" className="tl-sec__toggle" aria-expanded={open} aria-label={`${aria} fields`} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} {i + 1}. {name === undefined ? '…' : (name?.name ?? `${s.model} (missing)`)} · {s.class} · {s.density} /m² · {conditionCount(s)} condition{conditionCount(s) === 1 ? '' : 's'}
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label={`${aria} up`} disabled={i === 0} title="Earlier in the list (its plants move: an entry's place picks their positions)" onClick={() => p.send(withSpeciesMoved(d, i, i - 1))}>
          ↑
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label={`${aria} down`} disabled={i === d.species.length - 1} title="Later in the list (its plants move: an entry's place picks their positions)" onClick={() => p.send(withSpeciesMoved(d, i, i + 1))}>
          ↓
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label={`${aria} remove`} title="Take the species out of the dressing (the entries after it move up, and their plants with them)" onClick={() => p.send(withSpeciesRemoved(d, i))}>
          remove
        </button>
      </div>
      {open && (
        <>
          <label className="tl-field">
            <span className="tl-field__label">model</span>
            <RefPicker aria={`${aria} model`} kinds={MODEL_KINDS} value={s.model} none={null} onPick={(id) => id !== '' && set({ model: id })} />
          </label>
          <label className="tl-field">
            <span className="tl-field__label">class</span>
            <select className="tl-input" aria-label={`${aria} class`} value={s.class} onChange={(e) => set({ class: e.target.value as DressingSpecies['class'] })}>
              {DRESSING_CLASSES.map((k) => (
                <option key={k} value={k}>
                  {k === 'cover' ? 'cover (grass, flowers, reeds, pebbles)' : 'large (stored; placed in a later phase)'}
                </option>
              ))}
            </select>
          </label>
          {s.class === 'large' && <p className="tl-hint">A large species (a tree, a bush, a boulder) is stored with the dressing and placed by nothing yet: it shows nowhere.</p>}
          <label className="tl-field" title="Candidates per square metre; each is kept where its conditions hold fully, and a share of them where a condition fades.">
            <span className="tl-field__label">density /m²</span>
            <NumberField aria={`${aria} density`} value={s.density} placeholder="" min={L.density.min} max={L.density.max} step={0.1} onCommit={(v) => v !== undefined && set({ density: v })} />
          </label>
          <label className="tl-field" title="No two of this species' plants closer than this (0: none).">
            <span className="tl-field__label">spacing m</span>
            <NumberField aria={`${aria} spacing`} value={s.spacing} placeholder="0" min={0} max={spacingMax} step={0.05} onCommit={(v) => set({ spacing: v })} />
          </label>
          <div className="tl-field" title="Each plant's size: a random uniform scale between these.">
            <span className="tl-field__label">scale</span>
            <span className="tl-dressing__range">
              <NumberField aria={`${aria} scale min`} value={s.scale?.[0]} placeholder="1" min={L.scale.min} max={L.scale.max} step={0.05} onCommit={(v) => set({ scale: scaleWith(s.scale, 0, v) })} />
              <NumberField aria={`${aria} scale max`} value={s.scale?.[1]} placeholder="1" min={L.scale.min} max={L.scale.max} step={0.05} onCommit={(v) => set({ scale: scaleWith(s.scale, 1, v) })} />
            </span>
          </div>
          <label className="tl-field" title="Each plant is turned about up by a random angle from 0 to this many degrees.">
            <span className="tl-field__label">turn °</span>
            <NumberField aria={`${aria} yaw`} value={s.yaw} placeholder="360" min={0} max={360} step={15} onCommit={(v) => set({ yaw: v })} />
          </label>
          <label className="tl-field" title="How far a plant leans to the ground's slope: 0 stands upright, 1 stands square on the ground.">
            <span className="tl-field__label">lean 0–1</span>
            <NumberField aria={`${aria} align`} value={s.align} placeholder="0" min={0} max={1} step={0.1} onCommit={(v) => set({ align: v })} />
          </label>
          <label className="tl-field" title="Another whole number gives the same species other positions, sizes and turns.">
            <span className="tl-field__label">seed</span>
            <NumberField aria={`${aria} seed`} value={s.seed} placeholder="0" min={0} max={2 ** 31 - 1} step={1} onCommit={(v) => set({ seed: v === undefined ? undefined : Math.round(v) })} />
          </label>
          <div className="tl-subhead">Where it grows</div>
          <p className="tl-hint">It grows on the materials that name this dressing, where every condition below holds. Empty fields are open: no condition.</p>
          <TickSet label="Material" aria={`${aria} material`} options={p.voxelMaterials} value={c.material} hint="Only on these voxel materials (none ticked: on every material that names the dressing)." onChange={(v) => p.send(withCondition(d, i, 'material', v))} />
          <TickSet label="Role" aria={`${aria} role`} options={DRESSING_ROLE_NAMES.map((r) => ({ id: r, label: r }))} value={c.role} hint="Only on surfaces of these kinds (none ticked: any): terrain is ground, the rest are built." onChange={(v) => p.send(withCondition(d, i, 'role', v))} />
          <label className="tl-field" title="Open sky: nothing closed over the surface. Under cover: a cave's floor, a room, under a roof.">
            <span className="tl-field__label">Sky</span>
            <select className="tl-input" aria-label={`${aria} sky`} value={c.sky === undefined ? '' : c.sky ? 'open' : 'cover'} onChange={(e) => p.send(withCondition(d, i, 'sky', e.target.value === '' ? undefined : e.target.value === 'open'))}>
              <option value="">any</option>
              <option value="open">under open sky only</option>
              <option value="cover">under cover only</option>
            </select>
          </label>
          {CONDITION_RANGE_ROWS.map((row) =>
            row.name === 'noise' ? (
              <RangeRow key={row.name} row={row} aria={`${aria} noise`} value={c.noise} onChange={(r) => p.send(withCondition(d, i, 'noise', r === undefined ? undefined : noiseWith(c.noise, { min: r.min, max: r.max, fade: r.fade })))}>
                <>
                  <NumberField aria={`${aria} noise scale`} value={c.noise?.scale} placeholder={`scale ${NOISE_SCALE_START} m`} min={L.noiseScaleMin} max={L.noiseScaleMax} step={1} onCommit={(scale) => c.noise !== undefined && scale !== undefined && p.send(withCondition(d, i, 'noise', noiseWith(c.noise, { scale })))} />
                  <NumberField aria={`${aria} noise seed`} value={c.noise?.seed} placeholder="seed" min={0} max={2 ** 31 - 1} step={1} onCommit={(seed) => c.noise !== undefined && p.send(withCondition(d, i, 'noise', noiseWith(c.noise, { seed: seed === undefined ? undefined : Math.round(seed) })))} />
                </>
              </RangeRow>
            ) : (
              <RangeRow key={row.name} row={row} aria={`${aria} ${row.name}`} value={c[row.name]} onChange={(r) => p.send(withCondition(d, i, row.name, r))} />
            ),
          )}
        </>
      )}
    </div>
  );
}

/**
 * The card. `material`: the record shown (its own `voxel.dressing` is what
 * pick and clear set); `inherited`: the dressing an instance's parent chain
 * names (grown while the instance names none).
 */
export function DressingCard(p: { material: MaterialDef; inherited: string | undefined; materials: readonly MaterialDef[]; onSave: (m: MaterialDef) => void }): JSX.Element | null {
  const host = useContext(DressingHostContext);
  const [problem, setProblem] = useState<string | null>(null);
  if (host === null || p.material.voxel === undefined) return null;
  const own = p.material.voxel.dressing;
  const shown = own ?? p.inherited;
  const dressing = shown === undefined ? null : (host.dressings.find((d) => d.dressingId === shown) ?? null);
  const instance = p.material.instanceOf !== undefined;
  const send = (next: DressingDef | null): void => {
    if (next === null) return;
    void host.command('setDressing', { dressing: next }).then(setProblem);
  };
  const create = async (): Promise<void> => {
    const name = `${p.material.name} dressing`;
    const d = newDressing(await host.newId(name), name);
    const refused = await host.command('setDressing', { dressing: d });
    setProblem(refused);
    if (refused === null) p.onSave(materialWithDressing(p.material, d.dressingId));
  };
  const users = dressing === null ? [] : dressingUsers(p.materials, dressing.dressingId);
  const voxelMaterials = p.materials.flatMap((m) => (m.voxel !== undefined ? [{ id: m.voxel.id, label: `${m.name} · ${m.voxel.id}` }] : [])).sort((a, b) => a.id - b.id);
  return (
    <div className="tl-dressing" aria-label="dressing card" data-dressing={shown ?? ''}>
      <div className="tl-subhead">Dressing: what grows on it</div>
      <div className="tl-field">
        <span className="tl-field__label">dressing</span>
        <RefPicker aria="voxel dressing" kinds={DRESSING_KINDS} value={own ?? ''} none={instance && p.inherited !== undefined ? `— the parent's (${p.inherited}) —` : '— nothing grows —'} onPick={(id) => p.onSave(materialWithDressing(p.material, id === '' ? undefined : id))} />
        <button type="button" className="tl-btn tl-btn--small" aria-label="new dressing" title="Make an empty dressing and name it here" onClick={() => void create()}>
          new
        </button>
      </div>
      {instance && <p className="tl-hint">A variant grows what its parent grows until it names a dressing of its own (a sparser or denser one: density by variants). It cannot name "nothing": use a dressing with no species.</p>}
      {shown !== undefined && dressing === null && <p className="tl-hint">Reading {shown}…</p>}
      {dressing !== null && (
        <>
          <label className="tl-field">
            <span className="tl-field__label">name</span>
            <input key={`${dressing.dressingId}:${dressing.name}`} className="tl-input" aria-label="dressing name" defaultValue={dressing.name} maxLength={128} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== dressing.name && send(withName(dressing, e.target.value.trim()))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <p className="tl-hint" aria-label="dressing users">
            Shared: a change here changes every material that names this dressing ({users.length === 0 ? 'none yet' : users.map((u) => `${u.name}${u.inherited ? ' (from its parent)' : ''}`).join(', ')}). The Scene view grows it again at once; cover shows within about 40 m of the camera.
          </p>
          {dressing.species.map((s, i) => (
            <SpeciesEntry key={i} dressing={dressing} index={i} species={s} voxelMaterials={voxelMaterials} send={send} />
          ))}
          {dressing.species.length === 0 && <p className="tl-hint">No species yet: nothing grows. Add a model below.</p>}
          <div className="tl-field">
            <span className="tl-field__label">add species</span>
            <RefPicker aria="add species model" kinds={MODEL_KINDS} value="" none="— pick a model —" onPick={(id) => id !== '' && send(withSpeciesAdded(dressing, id))} />
          </div>
        </>
      )}
      {problem !== null && (
        <div className="tl-assets__error" role="alert" data-testid="dressing-error">
          {problem}
        </div>
      )}
    </div>
  );
}
