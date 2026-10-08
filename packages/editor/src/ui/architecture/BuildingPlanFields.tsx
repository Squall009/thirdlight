/**
 * A building's floor plan and furnishing in the room inspector: the room
 * program that splits its footprint into rooms and the furnishing set that
 * places props in them (the project's graphs of those kinds), the layout's
 * seed (a new seed lays rooms and props out again), and the hand edits on
 * top of the generated plan:
 * - Lock: the program's rooms are stored as the building's rooms (edited
 *   with the Rooms tool like any room); the program no longer runs.
 * - Detach: locked, and every prop pinned.
 * - Pin a prop: it stays where it is (same id) whatever is made again;
 *   unpin hands it back to the furnishing.
 */
import type { JSX } from 'react';
import type { ArchitectureBuilding, FurnishedProp } from '@thirdlight/project-model';

import { Num, Pick, type RoomsBinding } from './RoomsPanel';

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
          <button type="button" className="tl-btn tl-btn--small" title="Store the program's rooms as the building's rooms: edit them with the Rooms tool; the program no longer runs" disabled={B.planRooms.every((o) => o.building !== bld.id)} onClick={() => lock(false)}>
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
