/**
 * The structure mode's Openings column: the size a click on a wall places
 * (a standard door or window, or cells set by hand), every opening of the
 * structure listed (its kind and size, its wall, its prop and whether that
 * prop is shut) with select and delete, and the selected opening's own
 * fields: its width, height and sill (one `setComponent`, the generator's
 * checks first), its prop picked from the project's models that fit it
 * ("none" leaves an open hole) and whether that prop is glass (light passes
 * it while shut).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { OPENING_SIZES, VOXEL_SIZE_M, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';

import type { ProjectedEntity } from '../../session/projection';
import { openingProblem, openingWords, propChoices, propOutgrown, withOpening, withoutOpening, type OpeningShape, type PropAsset } from '../../session/structure-openings';
import { definitionOf, type StructureValue } from '../../session/structure-shape';
import { Section } from '../editmode/controls';
import type { StructureTools } from '../shell/useStructureTools';

/** The size picked: a standard size by index, or "custom" with its cells. */
export interface OpeningSizeChoice {
  readonly pick: number | 'custom';
  readonly custom: OpeningShape;
}

/** The shape a click places for a size choice. */
export function shapeOf(c: OpeningSizeChoice): OpeningShape {
  if (c.pick === 'custom') return c.custom;
  const s = OPENING_SIZES[c.pick]!;
  return { kind: s.kind, width: s.width, height: s.height, sill: s.sill };
}

type Portal = { open: boolean; stops: { light: boolean; sight: boolean; walk: boolean } };

/** A whole number of cells from a field (null: not one at or over `min`). */
const cellsOf = (raw: string, min: number): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
};

function CellsField({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (cells: number) => void }): JSX.Element {
  return (
    <label className="tl-field" title={`${label} in 0.5 m cells`}>
      <span className="tl-field__label">{label} (cells)</span>
      <input
        className="tl-input"
        aria-label={`opening ${label.toLowerCase()}`}
        type="number"
        step={1}
        min={min}
        defaultValue={value}
        key={value}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const c = cellsOf((e.target as HTMLInputElement).value, min);
          if (c !== null) onCommit(c);
        }}
        onBlur={(e) => {
          const c = cellsOf(e.target.value, min);
          if (c !== null && c !== value) onCommit(c);
        }}
      />
    </label>
  );
}

/** The size picker: the standard sizes, then custom cells. */
export function OpeningSizePicker({ choice, onChange }: { choice: OpeningSizeChoice; onChange: (c: OpeningSizeChoice) => void }): JSX.Element {
  const c = choice.custom;
  return (
    <div aria-label="opening size picker">
      <select className="tl-input" aria-label="opening size" value={String(choice.pick)} onChange={(e) => onChange({ ...choice, pick: e.target.value === 'custom' ? 'custom' : Number(e.target.value) })}>
        {OPENING_SIZES.map((s, i) => (
          <option key={s.label} value={i}>
            {s.label}
            {s.sill > 0 ? ` (sill ${s.sill * VOXEL_SIZE_M} m)` : ''}
          </option>
        ))}
        <option value="custom">Custom (cells)…</option>
      </select>
      {choice.pick === 'custom' && (
        <>
          <CellsField label="Width" value={c.width} min={1} onCommit={(n) => onChange({ ...choice, custom: { ...c, width: n } })} />
          <CellsField label="Height" value={c.height} min={1} onCommit={(n) => onChange({ ...choice, custom: { ...c, height: n } })} />
          <CellsField label="Sill" value={c.sill} min={0} onCommit={(n) => onChange({ ...choice, custom: { ...c, sill: n, kind: n === 0 ? 'door' : 'window' } })} />
        </>
      )}
    </div>
  );
}

/** What the list says of an opening's prop: its name and state, or that it is an open hole. */
function propWords(o: StructureOpening, entities: readonly ProjectedEntity[]): string {
  const e = o.prop === undefined ? undefined : entities.find((x) => x.id === o.prop);
  if (e === undefined) return 'no prop (an open hole)';
  const p = e.components['voxelPortal'] as Portal | undefined;
  return `${e.name}${p === undefined ? '' : p.open ? ', open' : ', shut'}${p !== undefined && !p.stops.light ? ', glass' : ''}`;
}

export interface OpeningsListProps {
  readonly entityId: string;
  readonly value: StructureValue;
  readonly tools: StructureTools;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
}

/** Every opening of the structure (kind, size, wall, prop) with select and delete; then the selected one's fields. */
export function OpeningsList({ entityId, value, tools, selected, onSelect }: OpeningsListProps): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null);
  const entities = tools.entities;
  const def = definitionOf(value);
  const send = (next: StructureDefinition, check: StructureOpening | null): void => {
    const why = check === null ? null : openingProblem(def, check);
    setProblem(why);
    if (why === null) void tools.define(entityId, value, next);
  };
  const sel = def.openings.find((o) => o.id === selected);
  return (
    <>
      <Section title="Openings" aside={<span className="tl-sec__note">{def.openings.length}</span>}>
        {def.openings.length === 0 && <p className="tl-hint">None yet: pick a size and click a wall.</p>}
        <ul className="tl-structure__openings" aria-label="structure openings">
          {def.openings.map((o) => (
            <li key={o.id} data-opening={o.id}>
              <button type="button" className={`tl-structure__opening${o.id === selected ? ' is-active' : ''}`} aria-pressed={o.id === selected} onClick={() => onSelect(o.id === selected ? null : o.id)}>
                {openingWords(o)} · wall {o.edge} of {o.polygon}, storey {o.storey} · {propWords(o, entities)}
              </button>
              <button
                type="button"
                className="tl-btn tl-btn--small"
                aria-label={`delete opening ${o.id}`}
                onClick={() => {
                  send(withoutOpening(def, o.id), null);
                  if (o.id === selected) onSelect(null);
                }}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
        {problem !== null && (
          <p className="tl-prop__error" role="alert" aria-label="opening refused">
            {problem}
          </p>
        )}
      </Section>
      {sel !== undefined && <OpeningFields key={sel.id} entityId={entityId} value={value} opening={sel} tools={tools} entities={entities} send={send} />}
    </>
  );
}

function OpeningFields({ entityId, value, opening: o, tools, entities, send }: { entityId: string; value: StructureValue; opening: StructureOpening; tools: StructureTools; entities: readonly ProjectedEntity[]; send: (next: StructureDefinition, check: StructureOpening) => void }): JSX.Element {
  const def = definitionOf(value);
  const prop = o.prop === undefined ? undefined : entities.find((x) => x.id === o.prop);
  const portal = prop?.components['voxelPortal'] as Portal | undefined;
  const [glass, setGlassChoice] = useState(o.sill > 0);
  const isGlass = portal !== undefined ? !portal.stops.light : glass;
  const assets = tools.propAssets;
  const choices = assets === null ? [] : propChoices(assets, o);
  const propAsset = (prop?.components['model'] as { asset?: { assetId?: string } } | undefined)?.asset?.assetId;
  const current = assets?.find((a) => a.assetId === propAsset) ?? null;
  const resize = (patch: Partial<StructureOpening>): void => {
    const next = { ...o, ...patch };
    send(withOpening(def, next), next);
  };
  const pick = (assetId: string): void => {
    const a: PropAsset | null = assetId === '' ? null : (assets?.find((x) => x.assetId === assetId) ?? null);
    void tools.setProp(entityId, value, o, a, isGlass);
  };
  return (
    <Section title={`Opening ${o.id}`}>
      <CellsField label="Width" value={o.width} min={1} onCommit={(n) => resize({ width: n })} />
      <CellsField label="Height" value={o.height} min={1} onCommit={(n) => resize({ height: n })} />
      <CellsField label="Sill" value={o.sill} min={0} onCommit={(n) => resize({ sill: n })} />
      <label className="tl-field" title="A model of the project that fits the opening (its bounds within it, a cell deep); none leaves an open hole.">
        <span className="tl-field__label">Prop</span>
        <select className="tl-input" aria-label="opening prop" value={propAsset ?? ''} disabled={assets === null} onChange={(e) => pick(e.target.value)}>
          <option value="">none (an open hole)</option>
          {propAsset !== undefined && !choices.some((c) => c.asset.assetId === propAsset) && <option value={propAsset}>{current?.displayName ?? propAsset} (does not fit)</option>}
          {choices.map((c) => (
            <option key={c.asset.assetId} value={c.asset.assetId}>
              {c.asset.displayName}
              {c.fits === null ? ' (size unknown)' : ''}
            </option>
          ))}
        </select>
      </label>
      {assets !== null && choices.length === 0 && <p className="tl-hint">No model of the project fits this opening ({openingWords(o)}).</p>}
      <label className="tl-field" title="Light passes the prop while it is shut (a pane); it still stops walkers.">
        <input
          type="checkbox"
          aria-label="opening prop glass"
          checked={isGlass}
          onChange={(e) => {
            if (prop !== undefined) void tools.setGlass(prop.id, e.target.checked);
            else setGlassChoice(e.target.checked);
          }}
        />
        <span>glass (light passes)</span>
      </label>
      {prop !== undefined && (
        <p className="tl-hint" aria-label="opening prop state">
          {prop.name}: {portal?.open === true ? 'open' : 'shut'} as the game starts{current !== null && propOutgrown(current.bounds, o) ? '; it no longer fits this opening' : ''}.
        </p>
      )}
    </Section>
  );
}
