/**
 * A block layer's Rooms tool in the Inspector: how the Scene view draws
 * (rectangle, polygon or path with arcs, doors, windows and arches put on
 * walls, walls dragged), the presets new rooms and paths wear, the rooms on
 * the layer, and the picked room's inspector — its inside and outside
 * presets, storeys, openings (a door piece put in an opening: the layer's
 * edge piece there, a live block if its type is one), stairs and floor
 * holes; a building's also its facade, its roof and where its interior is
 * (in place, or a scene of its own: the interior is made there and its doors
 * are linked). The rooms are one generated-architecture object on the layer
 * (`architecture.layer`), made with the first room; every change is one
 * command (a new interior scene is made first, then named).
 */
import { useEffect, useState, type JSX } from 'react';
import type { ArchitectureBuilding, ArchitectureComponent, ArchitectureOpening, ArchitectureOutline, ArchitectureRoomPlan, BlockEdit, BlockType } from '@thirdlight/project-model';
import { ARCHITECTURE_ROOF_SHAPES } from '@thirdlight/runtime';

import { allOutlines, DEFAULT_ROOM_OPTIONS, isBuilding, openingEdges, withOutlineSet, type RoomToolMode, type RoomToolOptions } from '../../session/room-draw';
import { edgesEdit } from '../../session/block-brush';
import type { BlockEditor } from '../../viewport/block-editor';

/** The rooms object of a layer as the Inspector binds it. */
export interface RoomsBinding {
  /** The object (null: none yet: the first room makes it). */
  entityId: string | null;
  component: ArchitectureComponent | null;
  /** Its place (the layer's for a new one), and the layer's. */
  origin: readonly number[];
  layerOrigin: readonly number[];
  /** Each room storey's floor plan (expanded: floors and wall tops). */
  plans: readonly ArchitectureRoomPlan[];
  /** The cell edges the rooms' walls stand on (the paint brush reaches their faces). */
  walls: ReadonlyMap<number, boolean> | null;
  /** Every preset: [id, name]. */
  presets: readonly (readonly [string, string])[];
  /** The project's scenes ([id, name]) and the one the rooms are in (a building's interior goes in another). */
  scenes: readonly (readonly [string, string])[];
  sceneId: string | null;
  /** Make a new scene named so (resolves its id; null: refused). */
  createScene(name: string): Promise<string | null>;
  /** Store the rooms (making the object on the first room). */
  setRooms(next: ArchitectureComponent, what: string): Promise<boolean>;
  /** Draw the object as `next` without storing it (null: as stored). */
  preview(entityId: string, next: ArchitectureComponent | null): void;
}

interface Props {
  editor: BlockEditor | null;
  layerId: string;
  layerOrigin: readonly number[];
  cellSize: readonly number[];
  bounds: { min: readonly number[]; max: readonly number[] };
  binding: RoomsBinding;
  /** Edge block types (door pieces). */
  edgeTypes: readonly BlockType[];
  edit: (what: string, edits: BlockEdit[]) => Promise<boolean>;
}

const MODES: readonly [RoomToolMode, string, string][] = [
  ['rect', 'Rectangle', 'Drag a room from corner to corner on the slice\'s floor.'],
  ['polygon', 'Polygon', 'Click the corners (the Arc bulge makes the next side an arc); click the first corner, double-click or Enter to close.'],
  ['path', 'Path', 'Click the points of a rail, fence or pipe; double-click or Enter to finish.'],
  ['building', 'Building', 'Click a building\'s footprint corners (an L or T too): it wears the facade preset outside and a hip roof; click the first corner, double-click or Enter to close.'],
  ['door', 'Door', 'Click a room\'s wall: a door one cell wide.'],
  ['window', 'Window', 'Click a room\'s wall: a window one cell wide with a pane.'],
  ['arch', 'Arch', 'Click a room\'s wall: an opening two cells wide, no door.'],
  ['walls', 'Walls', 'Drag a straight wall across itself by whole cells (a shared wall moves with both rooms); click a room to pick it.'],
];

function Num(props: { label: string; value: number | undefined; min?: number; max?: number; step?: number; placeholder?: string; onCommit: (v: number | undefined) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.value === undefined ? '' : String(props.value));
  useEffect(() => setDraft(props.value === undefined ? '' : String(props.value)), [props.value]);
  const commit = (): void => {
    const v = draft.trim() === '' ? undefined : Number(draft);
    if (v !== undefined && !Number.isFinite(v)) return setDraft(props.value === undefined ? '' : String(props.value));
    const c = v === undefined ? undefined : Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
    if (c !== props.value) props.onCommit(c);
  };
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <input className="tl-input tl-input--num" aria-label={props.label} type="number" step={props.step ?? 0.1} placeholder={props.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function Text(props: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (): void => {
    if (draft.trim() !== props.value) props.onCommit(draft.trim());
  };
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <input className="tl-input" aria-label={props.label} placeholder={props.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function Pick(props: { label: string; value: string; options: readonly (readonly [string, string])[]; onCommit: (v: string) => void }): JSX.Element {
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <select className="tl-input" aria-label={props.label} value={props.value} onChange={(e) => props.onCommit(e.target.value)}>
        {!props.options.some(([v]) => v === props.value) && <option value={props.value}>{props.value} (missing)</option>}
        {props.options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RoomsPanel(p: Props): JSX.Element {
  const [opts, setOpts] = useState<RoomToolOptions>(DEFAULT_ROOM_OPTIONS);
  const [picked, setPicked] = useState<string | null>(null);
  const [piece, setPiece] = useState('');
  const b = p.binding;
  const editor = p.editor;
  useEffect(() => editor?.rooms.setOptions(opts), [editor, opts]);
  useEffect(() => {
    editor?.rooms.setTarget({ entityId: b.entityId, component: b.component, origin: b.origin });
    editor?.setRoomWalls(b.walls);
  }, [editor, b.entityId, b.component, b.origin, b.walls]);
  if (editor !== null) {
    editor.roomHandlers.current = {
      onRooms: (_layerId, next, what) => b.setRooms(next, what),
      onPreview: (id, next) => b.preview(id, next),
      onPickRoom: (id) => setPicked(id),
    };
  }
  const outlines = allOutlines(b.component);
  const room = outlines.find((o) => o.id === picked) ?? null;
  const building = room !== null && isBuilding(b.component, room.id) ? (room as ArchitectureBuilding) : null;
  const offset = [0, 1, 2].map((i) => (b.origin[i] ?? 0) - (p.layerOrigin[i] ?? 0));
  const set = (next: ArchitectureOutline | null, what: string): void => {
    if (b.component === null || room === null) return;
    void b.setRooms(withOutlineSet(b.component, room.id, next), what);
    if (next === null) setPicked(null);
  };
  const setOpening = (i: number, next: ArchitectureOpening | null): void => {
    if (room === null) return;
    const list = (room.openings ?? []).flatMap((o, j) => (j !== i ? [o] : next !== null ? [next] : []));
    const { openings: _o, ...rest } = room;
    set(list.length > 0 ? { ...rest, openings: list } : rest, next === null ? 'Remove opening' : 'Edit opening');
  };
  const putPiece = (o: ArchitectureOpening): void => {
    if (room === null || piece === '') return;
    const plan = b.plans.find((x) => x.outline === room.id && x.storey === (o.storey ?? 0));
    const floor = plan?.floor ?? room.path.points[0]?.[1] ?? 0;
    const edges = openingEdges(room, o, floor, offset, p.cellSize);
    const edits = edgesEdit(edges, { block: piece }, { min: [...p.bounds.min] as [number, number, number], max: [...p.bounds.max] as [number, number, number] });
    if (edits !== null) void p.edit('Put door piece', edits);
  };
  const roomPresets = p.binding.presets;
  return (
    <div className="tl-rooms" aria-label="rooms panel">
      <div className="tl-blocks__tools" role="toolbar" aria-label="room tools">
        {MODES.map(([m, label, hint]) => (
          <button key={m} type="button" className={`tl-btn tl-btn--small${opts.mode === m ? ' is-active' : ''}`} aria-pressed={opts.mode === m} title={hint} onClick={() => setOpts((o) => ({ ...o, mode: m }))}>
            {label}
          </button>
        ))}
      </div>
      <div className="tl-blocks__opts">
        <Pick label="new room preset" value={opts.roomPreset} options={roomPresets} onCommit={(v) => setOpts((o) => ({ ...o, roomPreset: v }))} />
        <Pick label="new path preset" value={opts.pathPreset} options={roomPresets} onCommit={(v) => setOpts((o) => ({ ...o, pathPreset: v }))} />
        <Pick label="new facade preset" value={opts.facadePreset} options={[['', '— the inside’s —'], ...roomPresets]} onCommit={(v) => setOpts((o) => ({ ...o, facadePreset: v }))} />
        <Num label="arc bulge" value={opts.bulge} min={-2.4} max={2.4} step={0.05} onCommit={(v) => setOpts((o) => ({ ...o, bulge: v ?? 0 }))} />
      </div>
      <div className="tl-rooms__list" aria-label="rooms">
        {outlines.length === 0 && <p className="tl-note">No rooms yet: draw one on the slice's floor.</p>}
        {outlines.map((o) => (
          <button key={o.id} type="button" className={`tl-btn tl-btn--small${o.id === picked ? ' is-active' : ''}`} aria-label={`${isBuilding(b.component, o.id) ? 'building' : 'room'} ${o.id}`} aria-pressed={o.id === picked} onClick={() => setPicked(o.id)}>
            {o.id}
            {o.path.closed === true ? '' : ' (path)'}
          </button>
        ))}
      </div>
      {room !== null && (
        <div className="tl-rooms__inspector" aria-label={`${building !== null ? 'building' : 'room'} ${room.id} inspector`}>
          <div className="tl-inspector__subtitle">{building !== null ? 'Building' : room.path.closed === true ? 'Room' : 'Path'} “{room.id}”</div>
          <Pick label={room.path.closed === true ? 'inside preset' : 'preset'} value={room.preset} options={roomPresets} onCommit={(v) => set({ ...room, preset: v }, 'Room preset')} />
          {room.path.closed === true && (
            <>
              <Pick
                label={building !== null ? 'facade preset' : 'outside preset'}
                value={room.outside ?? ''}
                options={[['', '— the inside’s —'], ...roomPresets]}
                onCommit={(v) => {
                  const { outside: _o, ...rest } = room;
                  set(v === '' ? rest : { ...rest, outside: v }, 'Room outside');
                }}
              />
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
                placeholder="the walls' top"
                onCommit={(v) => {
                  const { storeyHeight: _h, ...rest } = room;
                  set(v === undefined ? rest : { ...rest, storeyHeight: v }, 'Storey height');
                }}
              />
            </>
          )}
          {building !== null && <BuildingFields building={building} binding={b} onSet={(next, what) => set(next, what)} />}
          <div className="tl-inspector__subtitle">Openings</div>
          {p.edgeTypes.length > 0 && (
            <Pick label="door piece" value={piece} options={[['', '— none —'], ...p.edgeTypes.map((t) => [t.blockId, t.name] as const)]} onCommit={setPiece} />
          )}
          {(room.openings ?? []).map((o, i) => (
            <div key={o.id} className="tl-rooms__opening" aria-label={`opening ${o.id}`}>
              <span className="tl-field__label">{o.id}</span>
              <Num label={`${o.id} at`} value={o.at} min={0} onCommit={(v) => setOpening(i, { ...o, at: v ?? o.at })} />
              <Num label={`${o.id} width`} value={o.width} min={0.01} onCommit={(v) => setOpening(i, { ...o, width: v ?? o.width })} />
              <Num label={`${o.id} sill`} value={o.bottom} onCommit={(v) => setOpening(i, { ...o, bottom: v ?? o.bottom })} />
              <Num label={`${o.id} head`} value={o.top} onCommit={(v) => setOpening(i, { ...o, top: v ?? o.top })} />
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
              {piece !== '' && (
                <button type="button" className="tl-btn tl-btn--small" aria-label={`put door piece in ${o.id}`} title="Put the door piece on the layer's cell edges in the opening (a live door type spawns its object; scripts open and close it)" onClick={() => putPiece(o)}>
                  Put piece
                </button>
              )}
              <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${o.id}`} onClick={() => setOpening(i, null)}>
                ✕
              </button>
            </div>
          ))}
          {room.path.closed === true && (
            <>
              <div className="tl-inspector__subtitle">Stairs and holes</div>
              {(room.stairs ?? []).map((s, i) => (
                <div key={s.id} className="tl-rooms__opening" aria-label={`stair ${s.id}`}>
                  <span className="tl-field__label">{s.id}</span>
                  <Num label={`${s.id} rise`} value={Math.round((s.to[1] - s.from[1]) * 1000) / 1000} min={0.1} onCommit={(v) => set({ ...room, stairs: (room.stairs ?? []).map((x, j) => (j === i ? { ...x, to: [x.to[0], x.from[1] + (v ?? 3), x.to[2]] } : x)) }, 'Stair rise')} />
                  <Num label={`${s.id} width`} value={s.width} min={0.1} onCommit={(v) => set({ ...room, stairs: (room.stairs ?? []).map((x, j) => (j === i ? { ...x, width: v ?? x.width } : x)) }, 'Stair width')} />
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${s.id}`} onClick={() => set({ ...room, stairs: (room.stairs ?? []).filter((_x, j) => j !== i) }, 'Remove stair')}>
                    ✕
                  </button>
                </div>
              ))}
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
                  const cs = p.cellSize[0]!;
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
                  const cs = p.cellSize[0]!;
                  const mx = Math.round(pts.reduce((s, q) => s + q[0], 0) / pts.length / cs) * cs;
                  const mz = Math.round(pts.reduce((s, q) => s + q[2], 0) / pts.length / cs) * cs;
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
            </>
          )}
          <button type="button" className="tl-btn tl-btn--small" aria-label={`delete ${room.id}`} onClick={() => set(null, building !== null ? 'Delete building' : room.path.closed === true ? 'Delete room' : 'Delete path')}>
            Delete {building !== null ? 'building' : room.path.closed === true ? 'room' : 'path'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A building's roof and interior in the room inspector. */
function BuildingFields(p: { building: ArchitectureBuilding; binding: RoomsBinding; onSet: (next: ArchitectureBuilding, what: string) => void }): JSX.Element {
  const bld = p.building;
  const roof = bld.roof;
  const setRoof = (next: ArchitectureBuilding['roof'] | undefined, what: string): void => {
    const { roof: _r, ...rest } = bld;
    p.onSet(next === undefined ? rest : { ...rest, roof: next }, what);
  };
  const roofNum = (key: 'rise' | 'overhang', v: number | undefined): void => {
    if (roof === undefined) return;
    const { [key]: _k, ...rest } = roof;
    setRoof(v === undefined ? rest : { ...rest, [key]: v }, `Roof ${key}`);
  };
  const scenes = p.binding.scenes.filter(([id]) => id !== p.binding.sceneId);
  const setInterior = (scene: string): void => {
    const { interior: _i, ...rest } = bld;
    p.onSet(scene === '' ? rest : { ...rest, interior: { ...(bld.interior?.offset !== undefined ? { offset: bld.interior.offset } : {}), scene } }, 'Building interior');
  };
  const offset = bld.interior?.offset ?? [0, 0, 0];
  const setOffset = (k: number, v: number | undefined): void => {
    if (bld.interior === undefined) return;
    const next: [number, number, number] = [offset[0], offset[1], offset[2]];
    next[k] = v ?? 0;
    const { offset: _o, ...inner } = bld.interior;
    p.onSet({ ...bld, interior: next.every((x) => x === 0) ? inner : { ...inner, offset: next } }, 'Interior offset');
  };
  return (
    <>
      <div className="tl-inspector__subtitle">Roof</div>
      <Pick label="roof shape" value={roof?.shape ?? ''} options={[['', '— none —'], ...ARCHITECTURE_ROOF_SHAPES.map((s) => [s, s] as const)]} onCommit={(v) => setRoof(v === '' ? undefined : { ...(roof ?? {}), shape: v as NonNullable<ArchitectureBuilding['roof']>['shape'] }, 'Roof shape')} />
      {roof !== undefined && (
        <>
          <Num label="roof rise" value={roof.rise} min={0} placeholder="half the deepest inset" onCommit={(v) => roofNum('rise', v)} />
          <Num label="roof overhang" value={roof.overhang} min={0} placeholder="0.3" onCommit={(v) => roofNum('overhang', v)} />
          <Text
            label="roof slot"
            value={roof.slot ?? ''}
            placeholder="upper_wall"
            onCommit={(v) => {
              const { slot: _s, ...rest } = roof;
              setRoof(v === '' ? rest : { ...rest, slot: v }, 'Roof slot');
            }}
          />
        </>
      )}
      <div className="tl-inspector__subtitle">Interior</div>
      <Pick label="interior" value={bld.interior?.scene ?? ''} options={[['', 'in place'], ...scenes]} onCommit={setInterior} />
      <button
        type="button"
        className="tl-btn tl-btn--small"
        title="A new scene for the interior: it is made there from this building, its doors linked to the exterior's"
        onClick={() => {
          void p.binding.createScene(`${bld.id} interior`).then((id) => {
            if (id !== null) setInterior(id);
          });
        }}
      >
        New interior scene
      </button>
      {bld.interior !== undefined && (
        <>
          <Num label="interior offset x" value={offset[0]} step={1} onCommit={(v) => setOffset(0, v)} />
          <Num label="interior offset y" value={offset[1]} step={1} onCommit={(v) => setOffset(1, v)} />
          <Num label="interior offset z" value={offset[2]} step={1} onCommit={(v) => setOffset(2, v)} />
        </>
      )}
    </>
  );
}
