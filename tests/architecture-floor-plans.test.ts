/**
 * Floor plans and furnishing (project-model): a room program splits a
 * building's footprint into rooms that tile it, on the grid, deterministic
 * by seed, every room reached through doors from the front door (the stairs
 * above the ground), wired types side by side; storeys share the stair
 * room, its flights switching back; slanted footprints are reported. The
 * expansion makes the rooms inside the building (its walls on the footprint
 * made once, partitions shared, its own floors and trims gone where rooms
 * fill a storey), lists them as rooms with their types and doors. A
 * furnishing set places props by room type against walls facing in, clear
 * of door clearances, keeping a walkable path between doors and stairs;
 * one light per room within the set's count; pinned props stay where they
 * were under a new seed; a locked plan (its rooms stored) is the generated
 * one. With TL_PERF=1 split and furnish are timed per building.
 * Browser-free; the inspector and the pixels are in the layered-material
 * e2e. The programs and sets here are neutral test data, not game content.
 */
import { describe, expect, it } from 'vitest';

import { buildingFloorPlan, floorPlanOutlines } from '../packages/project-model/src/arch-building-plan';
import { footprintZones, splitFloorPlan, type FloorPlan, type PlanRect } from '../packages/project-model/src/arch-floor-plan';
import { facingDir, FURNISH_CELL, type FurnishedProp } from '../packages/project-model/src/arch-furnish';
import { architectureCopies, generateArchitecture } from '../packages/project-model/src/arch-generate';
import { withFurnishingLights } from '../packages/project-model/src/arch-lights';
import { distanceToEdges, pointInPolygon } from '../packages/project-model/src/arch-mesh';
import { FURNISHING_SET_KIND, ROOM_PROGRAM_KIND, roomProgramDef } from '../packages/project-model/src/arch-plan-kinds';
import { expandArchitecture } from '../packages/project-model/src/arch-rooms';
import { architectureGraphsOf, architectureStylesOf } from '../packages/project-model/src/arch-style';
import { validateArchitectureComponent, type ArchitectureBuilding, type ArchitectureComponent, type ArchitectureFill } from '../packages/project-model/src/architecture';
import type { ModelErrorV2 } from '../packages/project-model/src/errors';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';

import { at, building, graphs, L_SHAPE, programGraph, RECT } from './arch-plan-fixtures';

const SHEETS = { '*': defaultTrimSheet() };

const areaOf = (r: PlanRect): number => (r[2] - r[0]) * (r[3] - r[1]);

/** Whether a plan's rooms on one storey tile a footprint: inside it, not overlapping, the same area. */
function tiles(plan: FloorPlan, storey: number, footprint: [number, number][]): boolean {
  const rooms = plan.rooms.filter((r) => r.storey === storey || (r.storeys > 1 && r.storey <= storey));
  const poly = footprint.flatMap((p) => p);
  let fa = 0;
  for (let i = 0; i < footprint.length; i++) {
    const [ax, az] = footprint[i]!;
    const [bx, bz] = footprint[(i + 1) % footprint.length]!;
    fa += ax * bz - bx * az;
  }
  const sum = rooms.reduce((s, r) => s + areaOf(r.rect), 0);
  if (Math.abs(sum - Math.abs(fa) / 2) > 1e-6) return false;
  for (const r of rooms) if (!pointInPolygon((r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2, poly)) return false;
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const [a, b] = [rooms[i]!.rect, rooms[j]!.rect];
      if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1e-6 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1e-6) return false;
    }
  return true;
}

/** The rooms reached through a storey's doors from a start room. */
function reached(plan: FloorPlan, storey: number, start: string): Set<string> {
  const seen = new Set([start]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of plan.doors.filter((x) => x.storey === storey))
      if (seen.has(d.a) !== seen.has(d.b)) {
        seen.add(d.a);
        seen.add(d.b);
        changed = true;
      }
  }
  return seen;
}

describe('floor plans', () => {
  const program = roomProgramDef('test-program', programGraph());

  it('tiles a footprint with the program\'s rooms on the grid, every room reached from the front door, wired rooms side by side, the same plan for the same seed', () => {
    const input = { id: 'house', footprint: RECT, storeys: 1, storeyHeight: 3, frontDoors: [[6, 0, 1]] as [number, number, number][], program, seed: 7 };
    const plan = splitFloorPlan(input);
    expect(plan.problems).toEqual([]);
    expect(plan.rooms.map((r) => r.type).sort()).toEqual(['hall', 'room-a', 'room-b', 'small']);
    expect(tiles(plan, 0, RECT)).toBe(true);
    for (const r of plan.rooms) for (const v of r.rect) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9);
    const hall = plan.rooms.find((r) => r.type === 'hall')!;
    // The entrance holds the front door on its boundary.
    expect(hall.rect[1] === 0 && hall.rect[0] <= 5.5 && hall.rect[2] >= 6.5).toBe(true);
    expect(reached(plan, 0, hall.id).size).toBe(plan.rooms.length);
    for (const t of ['room-a', 'room-b']) {
      const r = plan.rooms.find((x) => x.type === t)!;
      expect(plan.doors.some((d) => (d.a === r.id && d.b === hall.id) || (d.b === r.id && d.a === hall.id))).toBe(true);
    }
    expect(splitFloorPlan(input)).toEqual(plan);
    const others = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(splitFloorPlan({ ...input, seed }).rooms.map((r) => r.rect)));
    expect(new Set([JSON.stringify(plan.rooms.map((r) => r.rect)), ...others]).size).toBeGreaterThan(1);
  });

  it('splits an L, takes stairs up through every storey in one room with switchback flights, and reports a slanted footprint', () => {
    const p2 = roomProgramDef('p', programGraph({ upper: true, stairs: true }));
    const plan = splitFloorPlan({ id: 'l', footprint: L_SHAPE, storeys: 3, storeyHeight: 3, frontDoors: [[3, 0, 1]], program: p2, seed: 1 });
    expect(plan.problems).toEqual([]);
    for (const s of [0, 1, 2]) expect(tiles(plan, s, L_SHAPE)).toBe(true);
    const stair = plan.rooms.find((r) => r.type === 'stairs')!;
    expect(stair.storeys).toBe(3);
    expect(plan.rooms.filter((r) => r.type === 'upper').map((r) => r.storey)).toEqual([1, 1, 2, 2]);
    expect(plan.stairs.map((s) => s.storey)).toEqual([0, 1]);
    // The second flight starts where the first ends and runs back on the other strip (not over the first's hole).
    const [f0, f1] = plan.stairs;
    const alongX = Math.abs(f0!.to[0] - f0!.from[0]) > Math.abs(f0!.to[1] - f0!.from[1]);
    const ax = alongX ? 0 : 1;
    expect(f1!.from[ax]).toBeCloseTo(f0!.to[ax], 6);
    expect(Math.abs(f1!.from[1 - ax]! - f0!.from[1 - ax]!)).toBeCloseTo(f0!.width, 6);
    for (const s of [1, 2]) expect(reached(plan, s, stair.id).size).toBe(plan.rooms.filter((r) => r.storey === s || r === stair).length);
    expect(footprintZones(L_SHAPE)!.length).toBe(2);
    const slanted = splitFloorPlan({ id: 'x', footprint: [[0, 0], [8, 0], [6, 6], [0, 6]], storeys: 1, storeyHeight: 3, frontDoors: [], program, seed: 0 });
    expect(slanted.rooms).toEqual([]);
    expect(slanted.problems[0]).toMatch(/sides run along x and z/);
  });
});

describe('a building split into rooms and furnished', () => {
  const table = architectureStylesOf(graphs({ lights: 3 }));
  const comp = (b: ArchitectureBuilding): ArchitectureComponent => ({ elements: [], buildings: [b] });

  it('makes the rooms inside the building: one wall per stretch, its own floors gone, rooms with types and doors, generated without problems', () => {
    const b = building(RECT, { layoutSeed: 3 });
    const x = expandArchitecture(comp(b), [0, 0, 0], table);
    expect(x.problems).toEqual([]);
    expect(x.rooms.map((r) => r.type).sort()).toEqual(['hall', 'room-a', 'room-b', 'small']);
    expect(x.rooms.some((r) => r.id === 'house')).toBe(false);
    // The floors: one per room (the building's own is gone where its rooms fill it).
    const floors = x.component.elements.filter((e): e is ArchitectureFill => e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up');
    expect(floors.length).toBe(4);
    // Every wall stretch is made once: no two wall sweeps run along the same segment.
    const segs = new Map<string, number>();
    for (const e of x.component.elements) {
      if (e.kind !== 'sweep' || e.wall !== true) continue;
      const pts = e.path.points;
      const n = e.path.closed === true ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const [p, q] = [pts[i]!, pts[(i + 1) % pts.length]!];
        const k = [p[0], p[2], q[0], q[2]].map((v) => v.toFixed(3));
        const key = k[0]! + k[1]! < k[2]! + k[3]! ? k.join() : [k[2], k[3], k[0], k[1]].join();
        segs.set(key, (segs.get(key) ?? 0) + 1);
      }
    }
    expect([...segs.values()].every((v) => v === 1)).toBe(true);
    // Doors between rooms show as openings rooms see each other through; the front door is the hall's.
    const hall = x.rooms.find((r) => r.type === 'hall')!;
    expect(hall.openings.some((o) => o.from[1] === 0 && o.to[1] === 0 && Math.min(o.from[0], o.to[0]) === 5.5)).toBe(true);
    expect(x.rooms.reduce((s, r) => s + r.openings.length, 0)).toBeGreaterThanOrEqual(4);
    const chunks = generateArchitecture(x.component, SHEETS);
    expect(chunks.flatMap((c) => c.problems)).toEqual([]);
  });

  it('furnishes by room type: against walls facing in, clear of doors, a walkable path between doors; lights within the count; deterministic', () => {
    const b = building(RECT, { layoutSeed: 3, furnishing: 'test-furnishing' });
    const x = expandArchitecture(comp(b), [0, 0, 0], table);
    expect(x.problems).toEqual([]);
    const props = x.props ?? [];
    expect(props.length).toBeGreaterThanOrEqual(8);
    expect(props.filter((p) => p.model.assetId === 'kit-table').every((p) => x.rooms.find((r) => r.id === p.room)?.type === 'room-a')).toBe(true);
    // Lights: the set's count, one per room, largest rooms first.
    expect((x.lights ?? []).length).toBe(3);
    expect(new Set((x.lights ?? []).map((l) => l.room)).size).toBe(3);
    // Kit copies: one per prop, as instances of their models.
    const copies = architectureCopies(x.component);
    expect(copies.reduce((s, c) => s + c.ids.length, 0)).toBe(props.length);
    expect(new Set(copies.map((c) => c.model.assetId))).toEqual(new Set(['kit-cabinet', 'kit-crate', 'kit-table']));
    for (const r of x.rooms) {
      const mine = props.filter((p) => p.room === r.id);
      const inner = shrink(r.points, 0.1);
      for (const p of mine.filter((q) => q.model.assetId === 'kit-cabinet')) {
        // Its back against a wall: the point behind its middle by half its depth is the wall's face.
        const [fx, fz] = facingDir(p.facing);
        const bx = p.position[0] - fx * (p.size[1] / 2 + 0.02);
        const bz = p.position[2] - fz * (p.size[1] / 2 + 0.02);
        expect(distanceToEdges(bx, bz, inner)).toBeLessThan(0.02);
        // Facing in: a step forward is further from the walls.
        expect(distanceToEdges(p.position[0] + fx * 0.3, p.position[2] + fz * 0.3, inner)).toBeGreaterThan(distanceToEdges(p.position[0], p.position[2], inner));
      }
      // Doors: nothing within the clearance in front; the doors stay joined by a path 0.8 m wide.
      const doors = r.openings.filter((o) => o.bottom <= r.floor + 0.05);
      for (const d of doors) for (const p of mine) expect(overlapsDoor(p, d, r.points)).toBe(false);
      expect(pathJoins(inner, mine, doors.map((d) => inFront(d, r.points, 0.6)))).toBe(true);
    }
    expect(expandArchitecture(comp(b), [0, 0, 0], table).props).toEqual(props);
  });

  it('keeps pinned props where they were under a new seed, a pin replacing its generated prop; a locked plan is the generated one', () => {
    const b = building(RECT, { layoutSeed: 3, furnishing: 'test-furnishing' });
    const before = expandArchitecture(comp(b), [0, 0, 0], table).props!;
    const pick = before.find((p) => p.model.assetId === 'kit-cabinet')!;
    const pin = { id: pick.id, model: pick.model, position: pick.position, facing: pick.facing, size: pick.size };
    const after = expandArchitecture(comp({ ...b, layoutSeed: 99, pins: [pin] }), [0, 0, 0], table).props!;
    const kept = after.filter((p) => p.id === pick.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ pinned: true, position: pick.position, facing: pick.facing });
    expect(after.filter((p) => !p.pinned).map((p) => p.position)).not.toEqual(before.filter((p) => p.id !== pick.id).map((p) => p.position));
    // Locked: the plan's rooms stored on the object reproduce the plan; the program no longer runs.
    const plan = buildingFloorPlan(b, table.programs.get('test-program')!, 0);
    const lockedC: ArchitectureComponent = { elements: [], outlines: floorPlanOutlines(b, plan, 0), buildings: [{ ...b, layoutSeed: 42 }] };
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent(lockedC, '/a', errors);
    expect(errors).toEqual([]);
    const locked = expandArchitecture(lockedC, [0, 0, 0], table);
    const generated = expandArchitecture(comp(b), [0, 0, 0], table);
    expect(locked.rooms.map((r) => [r.id, r.type, r.points])).toEqual(generated.rooms.map((r) => [r.id, r.type, r.points]));
  });

  it('makes the furnishing lights into the scene as light objects within its budget of point and spot lights', () => {
    const b = building(RECT, { layoutSeed: 3, furnishing: 'test-furnishing' });
    const arch = { id: 'arch', components: { transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, architecture: comp(b) } };
    const lamp = (i: number): { id: string; components: object } => ({ id: `lamp-${i}`, components: { transform: { position: [0, 0, 0] }, light: { type: 'point', color: '#ffffff', intensity: 1 } } });
    const [made] = withFurnishingLights([{ sceneId: 's', entities: [arch] }], table);
    const lights = made!.entities.filter((e) => (e as { parentId?: string }).parentId === 'arch');
    expect(lights).toHaveLength(3);
    expect(lights[0]!.components).toMatchObject({ light: { type: 'point' } });
    // A scene with 14 lamps of its own has room for two.
    const [full] = withFurnishingLights([{ sceneId: 's', entities: [arch, ...Array.from({ length: 14 }, (_x, i) => lamp(i))] }], table);
    expect(full!.entities.length - 15).toBe(2);
  });

  it('validates the new fields', () => {
    const bad = (b: Record<string, unknown>, o: Record<string, unknown>[] = []): string[] => {
      const errors: ModelErrorV2[] = [];
      validateArchitectureComponent({ elements: [], outlines: o, buildings: [{ ...building(RECT), ...b }] }, '/a', errors);
      return errors.map((e) => e.path);
    };
    expect(bad({ furnishing: 'f', layoutSeed: 5, pins: [{ id: 'p', model: { assetId: 'kit-crate' }, position: [1, 0, 1], facing: 90 }] })).toEqual([]);
    expect(bad({ layoutSeed: -1 })).toEqual(['/a/buildings/0/layoutSeed']);
    expect(bad({ pins: [{ id: 'p', model: { assetId: 'kit-crate' }, position: [1, 0], facing: 0 }] })).toEqual(['/a/buildings/0/pins/0/position']);
    expect(bad({}, [{ id: 'r', path: { points: at(RECT), closed: true }, preset: 'starter-room', building: 'nope' }])).toEqual(['/a/outlines/0/building']);
    expect(architectureGraphsOf([{ kind: ROOM_PROGRAM_KIND }, { kind: FURNISHING_SET_KIND }, { kind: 'material-function' }]).length).toBe(2);
  });

  it.runIf(process.env['TL_PERF'] === '1')('times split and furnish per building (a village of 64 two-storey houses)', () => {
    const fresh = (): ReturnType<typeof architectureStylesOf> => architectureStylesOf(graphs({ upper: true, stairs: true, lights: 4 }));
    const buildings: ArchitectureBuilding[] = [];
    for (let i = 0; i < 64; i++) {
      const [ox, oz] = [(i % 8) * 20, Math.floor(i / 8) * 20];
      buildings.push({ ...building(L_SHAPE.map(([x, z]) => [x + ox, z + oz] as [number, number]), { id: `h${i}`, storeys: 2, storeyHeight: 3, layoutSeed: i, furnishing: 'test-furnishing' }), openings: [{ id: 'front', at: 3, width: 1, bottom: 0, top: 2.1 }] });
    }
    const village: ArchitectureComponent = { elements: [], buildings };
    const plansOnly: ArchitectureComponent = { elements: [], buildings: buildings.map(({ furnishing: _f, ...b }) => b) };
    const bare: ArchitectureComponent = { elements: [], buildings: buildings.map(({ program: _p, furnishing: _f, ...b }) => b) };
    const median = (f: () => void): number => {
      const runs: number[] = [];
      for (let k = 0; k < 7; k++) {
        const t = performance.now();
        f();
        runs.push(performance.now() - t);
      }
      return runs.sort((a, b) => a - b)[3]!;
    };
    // Cold: a table read again (programs and sets are new objects: nothing remembered); warm: the same table again.
    for (let k = 0; k < 3; k++) expandArchitecture(village, [0, 0, 0], fresh());
    const cold = (c: ArchitectureComponent): number => median(() => expandArchitecture(c, [0, 0, 0], fresh()));
    const warmTable = fresh();
    const warm = median(() => expandArchitecture(village, [0, 0, 0], warmTable));
    const [tBare, tPlans, tAll] = [cold(bare), cold(plansOnly), cold(village)];
    const program = warmTable.programs.get('test-program')!;
    const split = median(() => {
      for (const b of buildings) splitFloorPlan({ id: `${b.id}-x`, footprint: b.path.points.map((q) => [q[0], q[2]] as [number, number]), storeys: 2, storeyHeight: 3, frontDoors: [[3, 0, 1]], program, seed: Math.random() * 1e9 });
    });
    const x = expandArchitecture(village, [0, 0, 0], warmTable);
    const chunks = generateArchitecture(x.component, SHEETS);
    const draws = chunks.reduce((s, c) => s + c.meshes.length, 0);
    const copyDraws = chunks.reduce((s, c) => s + c.copies.length, 0);
    console.log(`[perf] 64 two-storey buildings, ${x.rooms.length} rooms, ${(x.props ?? []).length} props, ${(x.lights ?? []).length} lights: expand ${tBare.toFixed(1)} ms bare, ${tPlans.toFixed(1)} ms with plans, ${tAll.toFixed(1)} ms with plans + furnishing (cold), ${warm.toFixed(1)} ms remembered; split alone ${(split / 64).toFixed(3)} ms a building, the plan's rooms ${((tPlans - tBare) / 64).toFixed(2)} ms, furnishing ${((tAll - tPlans) / 64).toFixed(2)} ms a building; ${chunks.length} chunks: ${draws} mesh draws, ${copyDraws} prop instance draws (one per model per chunk)`);
    expect(x.problems).toEqual([]);
  });
});

/** A room's corners (x, z) moved in by `d` (rectangles). */
function shrink(points: readonly [number, number][], d: number): Float64Array {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs) + d, Math.max(...xs) - d, Math.min(...zs) + d, Math.max(...zs) - d];
  return Float64Array.from([x0, z0, x1, z0, x1, z1, x0, z1]);
}

/** The point `depth` metres in front of a door (into the room). */
function inFront(d: { from: [number, number]; to: [number, number] }, room: readonly [number, number][], depth: number): [number, number] {
  const mx = (d.from[0] + d.to[0]) / 2;
  const mz = (d.from[1] + d.to[1]) / 2;
  const tx = d.to[0] - d.from[0];
  const tz = d.to[1] - d.from[1];
  const l = Math.hypot(tx, tz);
  let [nx, nz] = [-tz / l, tx / l];
  const poly = room.flatMap((p) => p);
  if (!pointInPolygon(mx + nx * 0.2, mz + nz * 0.2, poly)) [nx, nz] = [-nx, -nz];
  return [mx + nx * depth, mz + nz * depth];
}

/** Whether a prop's footprint reaches into the 1 m clearance in front of a door. */
function overlapsDoor(p: FurnishedProp, d: { from: [number, number]; to: [number, number] }, room: readonly [number, number][]): boolean {
  for (let k = 0.15; k <= 0.95; k += 0.2)
    for (let s = 0.15; s <= 0.85; s += 0.35) {
      const a: [number, number] = [d.from[0] + (d.to[0] - d.from[0]) * s, d.from[1] + (d.to[1] - d.from[1]) * s];
      const [x, z] = inFront({ from: a, to: [a[0] + (d.to[0] - d.from[0]) * 0.01, a[1] + (d.to[1] - d.from[1]) * 0.01] }, room, 0.1 + k);
      if (inProp(p, x, z, 0)) return true;
    }
  return false;
}

function inProp(p: FurnishedProp, x: number, z: number, grow: number): boolean {
  const [fx, fz] = facingDir(p.facing);
  const dx = x - p.position[0];
  const dz = z - p.position[2];
  const u = dx * fz - dz * fx;
  const v = dx * fx + dz * fz;
  return Math.abs(u) <= p.size[0] / 2 + grow && Math.abs(v) <= p.size[1] / 2 + grow;
}

/** Whether a walker 0.8 m wide gets between all the points around the props (a flood fill on a fine grid). */
function pathJoins(inner: Float64Array, props: readonly FurnishedProp[], points: readonly [number, number][]): boolean {
  if (points.length < 2) return true;
  const c = FURNISH_CELL / 2;
  const r = 0.4 - FURNISH_CELL;
  const xs = [inner[0]!, inner[2]!, inner[4]!, inner[6]!];
  const zs = [inner[1]!, inner[3]!, inner[5]!, inner[7]!];
  const [x0, z0] = [Math.min(...xs), Math.min(...zs)];
  const W = Math.ceil((Math.max(...xs) - x0) / c);
  const H = Math.ceil((Math.max(...zs) - z0) / c);
  const ok = (i: number, j: number): boolean => {
    const x = x0 + (i + 0.5) * c;
    const z = z0 + (j + 0.5) * c;
    return pointInPolygon(x, z, inner) && distanceToEdges(x, z, inner) >= r && !props.some((p) => inProp(p, x, z, r));
  };
  const cell = ([x, z]: [number, number]): number => Math.floor((z - z0) / c) * W + Math.floor((x - x0) / c);
  const seen = new Uint8Array(W * H);
  const start = cell(points[0]!);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const k = stack.pop()!;
    const i = k % W;
    const j = (k - i) / W;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const [a, b] = [i + di, j + dj];
      if (a < 0 || b < 0 || a >= W || b >= H || seen[b * W + a] === 1 || !ok(a, b)) continue;
      seen[b * W + a] = 1;
      stack.push(b * W + a);
    }
  }
  return points.every((p) => seen[cell(p)] === 1);
}
