/**
 * What a kit holds, read-only, under its item in the Inspector: its trim
 * sheet, presets, block types and piece slots (the standard ones always
 * listed, empty or not, then its own). Parts are named as the project names
 * them; a part the project no longer has is marked missing (the backend's
 * Problems say the same).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { KitDef } from '@thirdlight/project-model';
import { KIT_STANDARD_SLOTS } from '@thirdlight/project-model/limits';

export interface KitSummaryProps {
  kit: KitDef;
  /** Names of the items a kit can name, by id. */
  names: { materials: ReadonlyMap<string, string>; graphs: ReadonlyMap<string, string>; blockTypes: ReadonlyMap<string, string> };
}

function Part(p: { id: string; names: ReadonlyMap<string, string> }): JSX.Element {
  const name = p.names.get(p.id);
  return name !== undefined ? <span title={p.id}>{name}</span> : <span className="tl-assets__error" title="Not in the project">{p.id} (missing)</span>;
}

function Row(p: { label: string; children: JSX.Element | JSX.Element[] | string }): JSX.Element {
  return (
    <div className="tl-assets__source">
      <span className="tl-field__label">{p.label}: </span>
      {p.children}
    </div>
  );
}

function list(ids: readonly string[] | undefined, names: ReadonlyMap<string, string>): JSX.Element[] | string {
  if (ids === undefined || ids.length === 0) return 'none';
  return ids.flatMap((id, i) => [...(i > 0 ? [<span key={`${id}-sep`}>, </span>] : []), <Part key={id} id={id} names={names} />]);
}

export function KitSummary({ kit, names }: KitSummaryProps): JSX.Element {
  const standard = new Set(KIT_STANDARD_SLOTS.map((s) => s.slot));
  const own = Object.keys(kit.pieces ?? {}).filter((s) => !standard.has(s));
  const slots = [...KIT_STANDARD_SLOTS, ...own.map((slot) => ({ slot, label: slot }))];
  return (
    <div className="tl-assets__preview" aria-label="kit contents" data-kit={kit.kitId}>
      {kit.description !== undefined && <div className="tl-assets__source">{kit.description}</div>}
      <Row label="Trim sheet">{kit.trimMaterial === undefined ? 'none' : <Part id={kit.trimMaterial} names={names.materials} />}</Row>
      <Row label="Presets">{list(kit.presets, names.graphs)}</Row>
      <Row label="Block types">{list(kit.blockTypes, names.blockTypes)}</Row>
      <div className="tl-field__label">Pieces</div>
      <ul className="tl-kit-slots" aria-label="kit pieces">
        {slots.map(({ slot, label }) => {
          const pieces = kit.pieces?.[slot] ?? [];
          return (
            <li key={slot} data-slot={slot}>
              {label}: {pieces.length === 0 ? 'empty' : pieces.map((p) => (p.piece !== undefined ? `${p.assetId} / ${p.piece}` : p.assetId)).join(', ')}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
