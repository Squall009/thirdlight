/**
 * A building's floor plan and furnishing as the expansion makes them: the
 * rooms its room program splits the footprint into, as room outlines
 * naming the building (the same outlines a locked plan stores), and the
 * props its furnishing set places, as the generator's kit copies.
 *
 * - Rooms of a building (made by its program, or stored with `building`)
 *   stand inside its footprint: the building's walls are theirs on the
 *   footprint (each room's wall there is the building's, its face in the
 *   room's rows), and on the storeys they fill the building makes only its
 *   walls (the rooms make floors, ceilings and trims). Their doors between
 *   rooms are cut once in the wall they share, framed both sides.
 * - Props are kit copies (one instance set per model per chunk), placed at
 *   load like the rest of the architecture; pinned props stand where they
 *   were pinned.
 *
 * Pure.
 */
import { distanceAlongRect, planRectCorners, splitFloorPlan, type FloorPlan } from './arch-floor-plan';
import { facingDir, type FurnishedProp } from './arch-furnish';
import { pathPointAt, samplePath } from './arch-path';
import type { RoomProgramDef } from './arch-plan-kinds';
import { ARCHITECTURE_DOOR_SILL_MAX, ARCHITECTURE_LIMITS, type ArchitectureBuilding, type ArchitectureOpening, type ArchitectureOutline, type ArchitectureRepeat, type ArchitectureStair } from './architecture';

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A building's ground-storey doors (x, z of the middle, width), in its openings' order. */
export function buildingFrontDoors(b: ArchitectureBuilding): [number, number, number][] {
  const doors = (b.openings ?? []).filter((o) => (o.storey ?? 0) === 0 && o.bottom <= ARCHITECTURE_DOOR_SILL_MAX);
  if (doors.length === 0) return [];
  const s = samplePath(b.path);
  const p = [0, 0, 0];
  const t = [0, 0, 0];
  return doors.map((o) => {
    pathPointAt(s, o.at, p, t);
    return [r6(p[0]!), r6(p[2]!), o.width];
  });
}

/** Plans made, per program (a program read again is a new object): the editor expands the same buildings at every edit. */
const plans = new WeakMap<RoomProgramDef, Map<string, FloorPlan>>();
/** Plans remembered per program before the memory starts over. */
const PLANS_KEPT = 1024;

/** A building's floor plan by its program (`storeyHeight`: metres between its storeys' floors). */
export function buildingFloorPlan(b: ArchitectureBuilding, program: RoomProgramDef, storeyHeight: number): FloorPlan {
  const input = {
    id: b.id,
    footprint: b.path.points.map((q) => [q[0], q[2]] as [number, number]),
    storeys: b.storeys ?? 1,
    storeyHeight,
    frontDoors: buildingFrontDoors(b),
    program,
    seed: b.layoutSeed ?? 0,
  };
  let memo = plans.get(program);
  if (memo === undefined) plans.set(program, (memo = new Map()));
  const key = JSON.stringify([input.id, input.footprint, input.storeys, storeyHeight, input.frontDoors, input.seed]);
  const known = memo.get(key);
  if (known !== undefined) return known;
  if (memo.size >= PLANS_KEPT) memo.clear();
  const made = splitFloorPlan(input);
  memo.set(key, made);
  return made;
}

/**
 * A floor plan as room outlines naming the building: each room's rectangle
 * on its storey's floor, its doors (a door between rooms is the first
 * single-storey room's: the stair room spans storeys), the stair room's
 * flights. What the expansion makes and what locking a plan stores.
 */
export function floorPlanOutlines(b: ArchitectureBuilding, plan: FloorPlan, storeyHeight: number): ArchitectureOutline[] {
  const y0 = b.path.points[0]![1];
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const openings = new Map<string, ArchitectureOpening[]>();
  plan.doors.forEach((d, i) => {
    const A = byId.get(d.a);
    const B = byId.get(d.b);
    const host = A !== undefined && A.storeys === 1 ? A : B !== undefined && B.storeys === 1 ? B : A ?? B;
    if (host === undefined) return;
    const list = openings.get(host.id) ?? [];
    list.push({ id: `door-${i + 1}`, at: distanceAlongRect(host.rect, d.at[0], d.at[1]), width: d.width, bottom: 0, top: d.height, ...(host.storeys > 1 && d.storey > 0 ? { storey: d.storey } : {}) });
    openings.set(host.id, list);
  });
  return plan.rooms.map((r) => {
    const y = r6(y0 + r.storey * storeyHeight);
    const stairs: ArchitectureStair[] = plan.stairs
      .filter((s) => s.room === r.id)
      .map((s) => ({ id: `flight-${s.storey + 1}`, from: [s.from[0], r6(y0 + s.storey * storeyHeight), s.from[1]], to: [s.to[0], r6(y0 + (s.storey + 1) * storeyHeight), s.to[1]], width: s.width }));
    const own = openings.get(r.id);
    return {
      id: r.id,
      path: { points: planRectCorners(r.rect).map(([x, z]) => [x, y, z] as [number, number, number]), closed: true },
      preset: r.preset !== '' ? r.preset : b.preset,
      ...(own !== undefined ? { openings: own } : {}),
      ...(r.storeys > 1 ? { storeys: r.storeys, storeyHeight: r6(storeyHeight) } : {}),
      ...(stairs.length > 0 ? { stairs } : {}),
      building: b.id,
      roomType: r.type,
    };
  });
}

/** A prop as the generator's element: one kit copy at its foot, its front (+Z) toward its facing. */
export function propElement(p: FurnishedProp): ArchitectureRepeat {
  const [fx, fz] = facingDir(p.facing);
  // A copy's +X runs along the path; its +Z is right of that: (fz, -fx) puts +Z on the facing.
  const [x, y, z] = p.position;
  return {
    id: p.id,
    kind: 'repeat',
    path: { points: [[x, y, z], [r6(x + fz), y, r6(z - fx)]] },
    spacing: ARCHITECTURE_LIMITS.distanceMax,
    piece: { model: p.model },
  };
}
