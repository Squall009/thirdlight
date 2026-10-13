/**
 * A building's sections in Rooms & buildings' room column.
 *
 * - `BuildingFields`: its roof (shape, rise, overhang, the trim row it
 *   wears) and where its interior is: in place, or a scene of its own (made
 *   here: its doors link to the exterior's), with an offset there.
 * - `BuildingPlanFields`: its floor plan and furnishing: the room program
 *   that splits its footprint into rooms and the furnishing set that places
 *   props in them (the project's graphs of those kinds), the layout's seed
 *   (a new seed lays rooms and props out again), and the hand edits on top
 *   of the generated plan. Lock: the program's rooms are stored as the
 *   building's rooms (edited here like any room); the program no longer
 *   runs. Detach: locked, and every prop pinned. Pin a prop: it stays where
 *   it is (same id) whatever is made again; unpin hands it back.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ArchitectureBuilding, FurnishedProp } from '@thirdlight/project-model';
import { ARCHITECTURE_ROOF_SHAPES } from '@thirdlight/runtime';

import type { RoomsBinding } from '../architecture/useRoomsBinding';
import { Num, Pick, Text } from './RoomFields';

const pinOf = (x: FurnishedProp): NonNullable<ArchitectureBuilding['pins']>[number] => ({ id: x.id, model: x.model, position: x.position, facing: x.facing, size: x.size });

export function BuildingPlanFields(p: { building: ArchitectureBuilding; binding: RoomsBinding; onSet: (next: ArchitectureBuilding, what: string) => void }): JSX.Element {
  const bld = p.building;
  const B = p.binding;
  const comp = B.component;
  const locked = (comp?.outlines ?? []).some((o) => o.building === bld.id);
  const props = B.props.filter((x) => x.building === bld.id);
  const pinned = new Set((bld.pins ?? []).map((x) => x.id));
  const setField = (key: 'program' | 'furnishing' | 'layoutSeed', v: string | number | undefined, what: string): void => {
    const rest: ArchitectureBuilding = { ...bld };
    delete rest[key];
    p.onSet(v === undefined || v === '' ? rest : ({ ...rest, [key]: v } as ArchitectureBuilding), what);
  };
  const setPins = (pins: NonNullable<ArchitectureBuilding['pins']>, what: string): void => {
    const { pins: _p, ...rest } = bld;
    p.onSet(pins.length > 0 ? { ...rest, pins } : rest, what);
  };
  /** Stores the program's rooms as the building's (and, detaching, pins every prop). */
  const lock = (detach: boolean): void => {
    if (comp === null) return;
    const rooms = B.planRooms.filter((o) => o.building === bld.id);
    const pins = detach ? [...(bld.pins ?? []), ...props.filter((x) => !pinned.has(x.id)).map(pinOf)] : bld.pins;
    const next: ArchitectureBuilding = { ...bld, ...(pins !== undefined && pins.length > 0 ? { pins } : {}) };
    void B.setRooms({ ...comp, outlines: [...(comp.outlines ?? []), ...rooms], buildings: (comp.buildings ?? []).map((x) => (x.id === bld.id ? next : x)) }, detach ? 'Detach floor plan' : 'Lock floor plan');
  };
  const unlock = (): void => {
    if (comp === null) return;
    const outlines = (comp.outlines ?? []).filter((o) => o.building !== bld.id);
    const { outlines: _o, ...rest } = comp;
    void B.setRooms(outlines.length > 0 ? { ...rest, outlines } : rest, 'Unlock floor plan');
  };
  return (
    <div aria-label={`building ${bld.id} floor plan`}>
      <div className="tl-inspector__subtitle">Floor plan</div>
      <Pick label="room program" value={bld.program ?? ''} options={[['', '— one room —'], ...B.programs]} onCommit={(v) => setField('program', v, 'Room program')} />
      <Pick label="furnishing set" value={bld.furnishing ?? ''} options={[['', '— none —'], ...B.furnishings]} onCommit={(v) => setField('furnishing', v, 'Furnishing set')} />
      <Num label="layout seed" value={bld.layoutSeed ?? 0} min={0} max={0xffffffff} step={1} onCommit={(v) => setField('layoutSeed', v === undefined || v === 0 ? undefined : Math.round(v), 'Layout seed')} />
      <button type="button" className="tl-btn tl-btn--small" title="Lay the rooms and props out again from the next seed (pinned props stay)" disabled={locked && bld.furnishing === undefined} onClick={() => setField('layoutSeed', ((bld.layoutSeed ?? 0) + 1) % 0x100000000, 'New layout')}>
        New layout
      </button>
      {!locked && (
        <>
          <button type="button" className="tl-btn tl-btn--small" title="Store the program's rooms as the building's rooms: edit them here like any room; the program no longer runs" disabled={B.planRooms.every((o) => o.building !== bld.id)} onClick={() => lock(false)}>
            Lock plan
          </button>
          <button type="button" className="tl-btn tl-btn--small" title="Lock the plan and pin every prop: nothing is made again" disabled={B.planRooms.every((o) => o.building !== bld.id)} onClick={() => lock(true)}>
            Detach
          </button>
        </>
      )}
      {locked && (
        <button type="button" className="tl-btn tl-btn--small" title="Remove the stored rooms: the program makes them again" onClick={unlock}>
          Unlock plan
        </button>
      )}
      {props.length > 0 && <div className="tl-inspector__subtitle">Props ({props.length})</div>}
      <div className="tl-rooms__list" aria-label="props">
        {props.map((x) => (
          <div key={x.id} className="tl-rooms__opening" aria-label={`prop ${x.id}`}>
            <span className="tl-field__label" title={`${x.model.assetId} at ${x.position.map((v) => v.toFixed(2)).join(', ')}`}>
              {x.id}
            </span>
            {pinned.has(x.id) ? (
              <button type="button" className="tl-btn tl-btn--small is-active" aria-label={`unpin ${x.id}`} title="Hand it back to the furnishing" onClick={() => setPins((bld.pins ?? []).filter((q) => q.id !== x.id), 'Unpin prop')}>
                Unpin
              </button>
            ) : (
              <button type="button" className="tl-btn tl-btn--small" aria-label={`pin ${x.id}`} title="Keep it where it is whatever is made again" onClick={() => setPins([...(bld.pins ?? []), pinOf(x)], 'Pin prop')}>
                Pin
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A building's roof and interior. */
export function BuildingFields(p: { building: ArchitectureBuilding; binding: RoomsBinding; onSet: (next: ArchitectureBuilding, what: string) => void }): JSX.Element {
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
