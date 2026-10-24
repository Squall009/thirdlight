/**
 * The room, run or building picked in Rooms & buildings, edited in its
 * panel over the view (titled `roomTitle`): its presets (inside, outside or facade) with their sliders and
 * Derive, its storeys, its openings (where each stands and how big, a pane,
 * the kit piece that stands in it, a live door block of the layer), the
 * kit pieces on its walls' segments and corners, a run's repeated piece
 * from the kit, a building's roof, interior and floor plan, a room's type
 * and furnishing (drawn on its own: its set, seed and pinned props), stairs and
 * floor holes, and Delete. Every change is one command on the rooms object.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { ArchitectureBuilding, ArchitectureComponent, ArchitectureModelRef, ArchitectureOpening, ArchitectureOutline, BlockType } from '@thirdlight/project-model';
import { architectureOpeningEdges } from '@thirdlight/runtime';

import { edgesEdit } from '../../session/block-brush';
import { modelKey, type KitPieceChoice } from '../../session/kit-edits';
import { isBuilding, openingResized, overridesOf, withOutlineSet, withOverride, type OpeningPiece } from '../../session/room-draw';
import type { RoomsBinding } from '../architecture/useRoomsBinding';
import { PresetSliders, type PresetSlidersHost } from '../architecture/PresetSliders';
import { Section, Toggle } from '../editmode/controls';
import { BuildingFields, BuildingPlanFields, RoomFurnishingFields } from './BuildingSections';
import { Num, Pick, Text } from './RoomFields';
import type { BlockSetup } from './block-column';

/** The kit's pieces as the room column offers them. */
export interface RoomPieces {
  readonly door: readonly KitPieceChoice[];
  readonly window: readonly KitPieceChoice[];
  readonly railing: readonly KitPieceChoice[];
  /** A model in words (its asset's name, its piece). */
  label(m: ArchitectureModelRef): string;
  /** The hole a door or window piece takes (its size from the kit's check when known). */
  hole(m: ArchitectureModelRef, kind: 'door' | 'window'): Pick<OpeningPiece, 'cells' | 'width' | 'bottom' | 'top'>;
}

export interface RoomInspectorProps {
  s: BlockSetup;
  b: RoomsBinding;
  room: ArchitectureOutline;
  pieces: RoomPieces;
  presets: PresetSlidersHost;
  /** The trim material the rooms object wears for presets naming none. */
  objectSheet: string | null;
  /** Edge block types of the project (live doors put in an opening's cells). */
  edgeTypes: readonly BlockType[];
  /** A preset made from a starter (one undo step with the rooms that take it). */
  onDerive(base: string): void;
  onPick(id: string | null): void;
}

const NO_PIECE = '';

/** The picked outline's kind and name ("Building “b1”"), the title of the panel that edits it. */
export function roomTitle(component: ArchitectureComponent | null, room: ArchitectureOutline): string {
  return `${isBuilding(component, room.id) ? 'Building' : room.path.closed === true ? 'Room' : 'Path'} “${room.id}”`;
}

export function RoomInspector(p: RoomInspectorProps): JSX.Element {
  const { s, b, room } = p;
  const building = isBuilding(b.component, room.id) ? (room as ArchitectureBuilding) : null;
  const closed = room.path.closed === true;
  const kind = building !== null ? 'building' : closed ? 'room' : 'path';
  const cs = s.component.cellSize;
  // Why the last opening edit was not made (shown in the openings until the next edit).
  const [refusal, setRefusal] = useState<string | null>(null);
  const set = (next: ArchitectureOutline | null, what: string): void => {
    if (b.component === null) return;
    void b.setRooms(withOutlineSet(b.component, room.id, next), what);
    if (next === null) p.onPick(null);
  };
  const setOpening = (i: number, next: ArchitectureOpening | null, what?: string): void => {
    setRefusal(null);
    const list = (room.openings ?? []).flatMap((o, j) => (j !== i ? [o] : next !== null ? [next] : []));
    const { openings: _o, ...rest } = room;
    set(list.length > 0 ? { ...rest, openings: list } : rest, what ?? (next === null ? 'Remove opening' : 'Edit opening'));
  };
  // A kit piece in an opening takes the whole cells it needs on its wall's axis, re-centred on whole cells where the
  // opening stood (refused when the wall is too short); none: the style's reveals and frame.
  const setOpeningPiece = (i: number, o: ArchitectureOpening, key: string): void => {
    const choice = [...p.pieces.door, ...p.pieces.window].find((c) => c.key === key);
    const { model: _m, ...rest } = o;
    if (choice === undefined) return setOpening(i, rest, 'Opening piece off');
    const hole = p.pieces.hole(choice.model, choice.slot === 'window' ? 'window' : 'door');
    const place = openingResized(room, o, hole, cs);
    if (typeof place === 'string') return setRefusal(place);
    const { pane: _p, ...unglazed } = rest;
    setOpening(i, { ...unglazed, at: place.at, width: place.width, bottom: hole.bottom, top: hole.top, model: { ...choice.model } }, 'Opening piece');
  };
  const putLiveDoor = (o: ArchitectureOpening, blockId: string): void => {
    const offset = [0, 1, 2].map((i) => (b.origin[i] ?? 0) - (b.layerOrigin[i] ?? 0));
    const plan = b.plans.find((x) => x.outline === room.id && x.storey === (o.storey ?? 0));
    const floor = plan?.floor ?? room.path.points[0]?.[1] ?? 0;
    const edges = architectureOpeningEdges(room.path, o, floor, offset, cs);
    const bounds = s.component.bounds;
    const edits = edgesEdit(edges, { block: blockId }, { min: [...bounds.min] as [number, number, number], max: [...bounds.max] as [number, number, number] });
    if (edits !== null) void s.blocks.edit('Put live door', s.entity.id, edits);
  };
  const overrides = overridesOf(b.component, room.id);
  const setComponent = (next: ArchitectureComponent, what: string): void => void b.setRooms(next, what);
  const openingChoices: (readonly [string, string])[] = [[NO_PIECE, 'The style’s frame (no piece)'], ...[...p.pieces.door, ...p.pieces.window].map((c) => [c.key, `${c.slot === 'window' ? 'Window' : 'Door'} · ${p.pieces.label(c.model)}`] as const)];
  const presetIds = [...new Set([room.preset, ...(room.outside !== undefined ? [room.outside] : [])])];
  return (
    <div className="tl-rooms__inspector" aria-label={`${kind} ${room.id} inspector`}>
      <div className="tl-dpanel__pad" role="group" aria-label={`${kind} ${room.id} properties`}>
        <Pick label={closed ? 'inside preset' : 'preset'} value={room.preset} options={b.presets} onCommit={(v) => set({ ...room, preset: v }, 'Room preset')} />
        {closed && (
          <Pick
            label={building !== null ? 'facade preset' : 'outside preset'}
            value={room.outside ?? ''}
            options={[['', '— the inside’s —'], ...b.presets]}
            onCommit={(v) => {
              const { outside: _o, ...rest } = room;
              set(v === '' ? rest : { ...rest, outside: v }, 'Room outside');
            }}
          />
        )}
        {closed && (
          <>
            <Num
              label="storeys"
              value={room.storeys ?? 1}
              min={1}
              max={64}
              step={1}
              onCommit={(v) => {
                const { storeys: _s, ...rest } = room;
                const n = Math.round(v ?? 1);
                set(n > 1 ? { ...rest, storeys: n } : rest, 'Room storeys');
              }}
            />
            <Num
              label="storey height"
              value={room.storeyHeight}
              min={0.1}
              placeholder="auto"
              hint="Empty: the inside preset's wall height."
              onCommit={(v) => {
                const { storeyHeight: _h, ...rest } = room;
                set(v === undefined ? rest : { ...rest, storeyHeight: v }, 'Storey height');
              }}
            />
          </>
        )}
        {closed && building === null && (
          <Text
            label="room type"
            value={room.roomType ?? ''}
            placeholder={room.building !== undefined ? 'what the furnishing set reads' : 'living, kitchen, bedroom, …: the set’s types'}
            onCommit={(v) => {
              const { roomType: _t, ...rest } = room;
              set(v === '' ? rest : { ...rest, roomType: v }, 'Room type');
            }}
          />
        )}
        <button type="button" className="tl-btn tl-btn--small tl-btn--danger" aria-label={`delete ${room.id}`} onClick={() => set(null, kind === 'building' ? 'Delete building' : kind === 'room' ? 'Delete room' : 'Delete path')}>
          Delete {kind}
        </button>
      </div>
      <Section title="Preset sliders" open={false} aside={<span className="tl-sec__note">{presetIds.length}</span>}>
        {presetIds.map((id) => (
          <PresetSliders key={id} presetId={id} {...p.presets} objectSheet={p.objectSheet} onDerive={p.onDerive} />
        ))}
      </Section>
      <Section title="Openings" aside={<span className="tl-sec__note">{room.openings?.length ?? 0}</span>}>
        {(room.openings ?? []).length === 0 && <p className="tl-hint">None yet: Door, Window or Arch, then click the wall.</p>}
        {refusal !== null && (
          <p className="tl-hint" role="status" aria-label="opening refused">
            {refusal}
          </p>
        )}
        {(room.openings ?? []).map((o, i) => (
          <div key={o.id} className="tl-rooms__opening" aria-label={`opening ${o.id}`}>
            <span className="tl-field__label">{o.id}</span>
            <Pick label={`${o.id} piece`} value={o.model !== undefined ? modelKey(o.model) : NO_PIECE} options={openingChoices} onCommit={(v) => setOpeningPiece(i, o, v)} />
            <Num label={`${o.id} at`} value={o.at} min={0} onCommit={(v) => setOpening(i, { ...o, at: v ?? o.at })} />
            <Num label={`${o.id} width`} value={o.width} min={0.01} onCommit={(v) => setOpening(i, { ...o, width: v ?? o.width })} />
            <Num label={`${o.id} sill`} value={o.bottom} onCommit={(v) => setOpening(i, { ...o, bottom: v ?? o.bottom })} />
            <Num label={`${o.id} head`} value={o.top} onCommit={(v) => setOpening(i, { ...o, top: v ?? o.top })} />
            {o.model === undefined && (
              <label className="tl-field">
                <span className="tl-field__label">pane</span>
                <input
                  type="checkbox"
                  aria-label={`${o.id} pane`}
                  checked={o.pane === true}
                  onChange={(e) => {
                    const { pane: _p, ...rest } = o;
                    setOpening(i, e.target.checked ? { ...rest, pane: true } : rest);
                  }}
                />
              </label>
            )}
            {p.edgeTypes.length > 0 && (
              <Pick label={`${o.id} live door`} value="" options={[['', 'Put a live door block…'], ...p.edgeTypes.map((t) => [t.blockId, t.name] as const)]} onCommit={(v) => v !== '' && putLiveDoor(o, v)} />
            )}
            <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${o.id}`} onClick={() => setOpening(i, null)}>
              ✕
            </button>
          </div>
        ))}
      </Section>
      {closed && (
        <Section title="Wall and corner pieces" aside={<span className="tl-sec__note">{overrides.length}</span>}>
          {overrides.length === 0 && <p className="tl-hint">None yet: pick a wall or corner piece above, then Wall piece or Corner piece and click the wall.</p>}
          <ul className="tl-blist" aria-label="wall pieces">
            {overrides.map(({ index, override: o }) => {
              const spot = o.segment !== undefined ? `seg${o.segment}` : `corner${o.corner}`;
              return (
                <li key={index} aria-label={`piece ${o.element}:${spot}`}>
                  <span className="tl-blist__name" title={o.element}>
                    {o.segment !== undefined ? `Wall ${o.segment + 1}` : `Corner ${(o.corner ?? 0) + 1}`} · {p.pieces.label(o.model)}
                  </span>
                  {o.segment !== undefined && <Toggle label="Stretch" aria={`stretch ${o.element}:${spot}`} on={o.stretch !== false} onChange={(on) => b.component !== null && setComponent({ ...b.component, overrides: (b.component.overrides ?? []).map((x, j) => (j === index ? (on ? (({ stretch: _s, ...r }) => r)(x) : { ...x, stretch: false }) : x)) }, 'Piece stretch')} hint="On: one copy of the piece per cell along the wall (a wall piece is made one cell long). Off: placed once at its own size." />}
                  <button type="button" className="tl-icon-btn" aria-label={`remove piece ${o.element}:${spot}`} title="Take the piece off (the wall is made there again)" onClick={() => b.component !== null && setComponent(withOverride(b.component, o.segment !== undefined ? { element: o.element, segment: o.segment } : { element: o.element, corner: o.corner! }, null), 'Remove piece')}>
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {!closed && (
        <Section title="Repeated piece">
          <Pick
            label="repeat piece"
            value={room.repeatModel !== undefined ? modelKey(room.repeatModel) : NO_PIECE}
            options={[[NO_PIECE, 'The style’s own (posts, rails)'], ...p.pieces.railing.map((c) => [c.key, p.pieces.label(c.model)] as const)]}
            onCommit={(v) => {
              const { repeatModel: _r, ...rest } = room;
              const choice = p.pieces.railing.find((c) => c.key === v);
              set(choice === undefined ? rest : { ...rest, repeatModel: { ...choice.model } }, 'Repeated piece');
            }}
          />
          <p className="tl-hint">{p.pieces.railing.length === 0 ? 'The kit has no railing piece: add one in the kit editor to repeat it along the path.' : 'The kit’s railing piece placed where the preset spaces its copies.'}</p>
        </Section>
      )}
      {building !== null && (
        <Section title="Roof and interior">
          <BuildingFields building={building} binding={b} onSet={(next, what) => set(next, what)} />
        </Section>
      )}
      {building !== null && (
        <Section title="Floor plan">
          <BuildingPlanFields building={building} binding={b} onSet={(next, what) => set(next, what)} />
        </Section>
      )}
      {closed && building === null && room.building === undefined && (
        <Section title="Furnishing" aside={<span className="tl-sec__note">{b.props.filter((x) => x.outline === room.id).length}</span>}>
          <RoomFurnishingFields room={room} binding={b} onSet={(next, what) => set(next, what)} />
        </Section>
      )}
      {closed && <StairsSection {...p} set={set} />}
    </div>
  );
}

/** Stairs and floor holes of a room. */
function StairsSection(p: RoomInspectorProps & { set: (next: ArchitectureOutline | null, what: string) => void }): JSX.Element {
  const { room, b, set } = p;
  const cs = p.s.component.cellSize[0]!;
  return (
    <Section title="Stairs and holes" open={(room.stairs ?? []).length > 0 || (room.holes ?? []).length > 0}>
      {(room.stairs ?? []).map((st, i) => (
        <div key={st.id} className="tl-rooms__opening" aria-label={`stair ${st.id}`}>
          <span className="tl-field__label">{st.id}</span>
          <Num label={`${st.id} rise`} value={Math.round((st.to[1] - st.from[1]) * 1000) / 1000} min={0.1} onCommit={(v) => set({ ...room, stairs: (room.stairs ?? []).map((x, j) => (j === i ? { ...x, to: [x.to[0], x.from[1] + (v ?? 3), x.to[2]] } : x)) }, 'Stair rise')} />
          <Num label={`${st.id} width`} value={st.width} min={0.1} onCommit={(v) => set({ ...room, stairs: (room.stairs ?? []).map((x, j) => (j === i ? { ...x, width: v ?? x.width } : x)) }, 'Stair width')} />
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${st.id}`} onClick={() => set({ ...room, stairs: (room.stairs ?? []).filter((_x, j) => j !== i) }, 'Remove stair')}>
            ✕
          </button>
        </div>
      ))}
      <div className="tl-btnrow">
        <button
          type="button"
          className="tl-btn tl-btn--small"
          title="A flight along the room's first wall, one cell in, rising a storey (its floor above gets a hole over it)"
          onClick={() => {
            const [a, c] = [room.path.points[0]!, room.path.points[1]!];
            const len = Math.hypot(c[0] - a[0], c[2] - a[2]) || 1;
            const [ux, uz] = [(c[0] - a[0]) / len, (c[2] - a[2]) / len];
            // One cell in from the wall (right of travel is the inside), from one cell along to four.
            const [rx, rz] = [-uz, ux];
            const at = (d: number, y: number): [number, number, number] => [a[0] + ux * d + rx * cs, y, a[2] + uz * d + rz * cs];
            const plan = b.plans.find((x) => x.outline === room.id && x.storey === 0);
            const rise = room.storeyHeight ?? (plan !== undefined ? plan.top - plan.floor : 3);
            let n = 1;
            while ((room.stairs ?? []).some((x) => x.id === `stair-${n}`)) n++;
            set({ ...room, stairs: [...(room.stairs ?? []), { id: `stair-${n}`, from: at(cs, a[1]), to: at(Math.min(len - cs, cs + rise * 1.6), a[1] + rise), width: cs }] }, 'Add stair');
          }}
        >
          Add stair
        </button>
        <button
          type="button"
          className="tl-btn tl-btn--small"
          disabled={(room.storeys ?? 1) < 2}
          title="A one-cell hole in the upper storey's floor, at the room's middle"
          onClick={() => {
            const pts = room.path.points;
            const mx = Math.round(pts.reduce((t, q) => t + q[0], 0) / pts.length / cs) * cs;
            const mz = Math.round(pts.reduce((t, q) => t + q[2], 0) / pts.length / cs) * cs;
            const y = pts[0]![1];
            set({ ...room, holes: [...(room.holes ?? []), { storey: 1, path: { points: [[mx, y, mz], [mx + cs, y, mz], [mx + cs, y, mz + cs], [mx, y, mz + cs]], closed: true } }] }, 'Add floor hole');
          }}
        >
          Add hole
        </button>
        {(room.holes ?? []).length > 0 && (
          <button type="button" className="tl-btn tl-btn--small" onClick={() => set({ ...room, holes: [] }, 'Remove floor holes')}>
            Remove holes ({room.holes!.length})
          </button>
        )}
      </div>
    </Section>
  );
}
