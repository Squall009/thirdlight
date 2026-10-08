/**
 * Buildings (project-model): roofs over any convex or right-angled footprint
 * are the straight skeleton's (each point of an L, T or U hip as high as the
 * slope times its distance in from the walls, the largest square that fits;
 * a convex polygon's the slope times its distance to the nearest eave), a
 * concave slanted footprint is reported; a building's one definition makes
 * the whole, the exterior and the interior with the same walls (windows and
 * doors line up on both sides), the exterior without the inside's trims and
 * stairs, the interior without the facade's trims and the roof; the door
 * links pair both sides; the build adds the interior to its scene. With
 * TL_PERF=1 the generation of a village of buildings is timed per chunk.
 * Browser-free; the tool, the inspector and the pixels are in the
 * layered-material e2e.
 */
import { describe, expect, it } from 'vitest';

import { architectureDoorLinks, buildingInteriorId, withBuildingInteriors } from '../packages/project-model/src/arch-buildings';
import { architectureChunkKeys, generateArchitecture, generateArchitectureChunk, type ArchitectureChunk } from '../packages/project-model/src/arch-generate';
import { pointInPolygon } from '../packages/project-model/src/arch-mesh';
import { largestRectangles } from '../packages/project-model/src/arch-roof';
import { expandArchitecture } from '../packages/project-model/src/arch-rooms';
import { architectureStylesOf } from '../packages/project-model/src/arch-style';
import { validateArchitectureComponent, type ArchitectureBuilding, type ArchitectureComponent, type ArchitectureFill } from '../packages/project-model/src/architecture';
import type { ModelErrorV2 } from '../packages/project-model/src/errors';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';
import { RuntimeArchitecture } from '../packages/runtime/src/architecture';

const SHEETS = { '*': defaultTrimSheet() };
const STARTERS = architectureStylesOf([]);
type P3 = [number, number, number];
const at = (pts: [number, number][], y = 0): P3[] => pts.map(([x, z]) => [x, y, z]);
/** An L: 10 × 4 along x and 4 × 10 along z, sharing the corner square (inside right of travel). */
const L_SHAPE: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const T_SHAPE: [number, number][] = [[0, 0], [12, 0], [12, 4], [8, 4], [8, 12], [4, 12], [4, 4], [0, 4]];
const U_SHAPE: [number, number][] = [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]];
const HEXAGON: [number, number][] = [[2, 0], [6, 0], [8, 3], [6, 6], [2, 6], [0, 3]];

/** The highest roof point over (x, z) among the near-level triangles, or −Infinity. */
function heightAt(chunks: readonly ArchitectureChunk[], x: number, z: number): number {
  let best = -Infinity;
  for (const c of chunks)
    for (const m of c.meshes) {
      const l = m.mesh;
      for (let i = 0; i < l.indices.length; i += 3) {
        const v = [0, 1, 2].map((k) => l.indices[i + k]! * 3);
        const [ax, ay, az] = [l.positions[v[0]!]!, l.positions[v[0]! + 1]!, l.positions[v[0]! + 2]!];
        const [bx, by, bz] = [l.positions[v[1]!]!, l.positions[v[1]! + 1]!, l.positions[v[1]! + 2]!];
        const [cx, cy, cz] = [l.positions[v[2]!]!, l.positions[v[2]! + 1]!, l.positions[v[2]! + 2]!];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (u < -1e-4 || w < -1e-4 || u + w > 1 + 1e-4) continue;
        best = Math.max(best, u * ay + w * by + (1 - u - w) * cy);
      }
    }
  return best;
}

/** The half-side of the largest axis-aligned square centred on (x, z) inside a right-angled polygon: its L∞ distance to the walls. */
function squareDepth(x: number, z: number, poly: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i]!;
    const [bx, bz] = poly[(i + 1) % poly.length]!;
    const dx = Math.max(Math.min(ax, bx) - x, 0, x - Math.max(ax, bx));
    const dz = Math.max(Math.min(az, bz) - z, 0, z - Math.max(az, bz));
    best = Math.min(best, Math.max(dx, dz));
  }
  return best;
}

/** A convex polygon's distance from (x, z) to its nearest side's line. */
function edgeDepth(x: number, z: number, poly: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i]!;
    const [bx, bz] = poly[(i + 1) % poly.length]!;
    const l = Math.hypot(bx - ax, bz - az);
    best = Math.min(best, Math.abs((bx - ax) * (az - z) - (ax - x) * (bz - az)) / l);
  }
  return best;
}

const roofOf = (poly: [number, number][], shape: ArchitectureFill['shape'], extra: Partial<ArchitectureFill> = {}): ArchitectureChunk[] =>
  generateArchitecture({ elements: [{ id: 'roof', kind: 'fill', path: { points: at(poly, 3), closed: true }, shape, slot: 'upper_wall', ...extra }] }, SHEETS);

/** Every grid point strictly inside the polygon: the roof there is `expect`ed high (3 m eaves). */
function checkRoof(chunks: readonly ArchitectureChunk[], poly: [number, number][], expected: (x: number, z: number) => number): number {
  const flat = poly.flat();
  let n = 0;
  for (let x = 0.25; x < 12; x += 0.5)
    for (let z = 0.25; z < 12; z += 0.5) {
      if (!pointInPolygon(x, z, flat)) continue;
      expect(Math.abs(heightAt(chunks, x, z) - expected(x, z)), `roof at ${x}, ${z}`).toBeLessThan(2e-3);
      n++;
    }
  return n;
}

describe('roofs over any footprint', () => {
  it('a hip over an L, a T and a U is the straight skeleton\'s: slope × the largest square that fits', () => {
    for (const poly of [L_SHAPE, T_SHAPE, U_SHAPE]) {
      // Deepest inset 2 m (4 m wide wings), rise 1.5: slope 0.75.
      const chunks = roofOf(poly, 'hip', { rise: 1.5, overhang: 0.4 });
      expect(chunks.flatMap((c) => c.problems)).toEqual([]);
      expect(checkRoof(chunks, poly, (x, z) => 3 + 0.75 * squareDepth(x, z, poly))).toBeGreaterThan(50);
    }
    // An L's largest rectangles are its two wings.
    expect(largestRectangles(L_SHAPE.flat(), [1, 0], [0, 1]).sort()).toEqual([[0, 10, 0, 4], [0, 4, 0, 10]].sort());
  });

  it('a mansard over an L bends at one inset and height; a gable over it crosses the wings\' gables', () => {
    const chunks = roofOf(L_SHAPE, 'mansard', { rise: 2, inset: 0.5, breakRise: 0.6 });
    // Lower slope 1.2 m over 0.5 m, then 0.8 m over the remaining 1.5 m.
    checkRoof(chunks, L_SHAPE, (x, z) => {
      const d = squareDepth(x, z, L_SHAPE);
      return 3 + (d <= 0.5 ? (1.2 / 0.5) * d : 1.2 + (0.8 / 1.5) * (d - 0.5));
    });
    const gable = roofOf(L_SHAPE, 'gable', { rise: 1 });
    expect(gable.flatMap((c) => c.problems)).toEqual([]);
    // Each wing's ridge runs to its own gable end: 4 m high at the ridge over the far ends, the ends' gables at x = 10 and z = 10.
    expect(Math.abs(heightAt(gable, 9.9, 2) - 4)).toBeLessThan(0.06);
    expect(Math.abs(heightAt(gable, 2, 9.9) - 4)).toBeLessThan(0.06);
  });

  it('a convex polygon\'s hip is its eaves\' lowest plane; a concave one with slanted sides is reported', () => {
    const chunks = roofOf(HEXAGON, 'hip', { rise: 2 });
    expect(chunks.flatMap((c) => c.problems)).toEqual([]);
    let deepest = 0;
    for (let x = 0; x <= 8; x += 0.05) for (let z = 0; z <= 6; z += 0.05) if (pointInPolygon(x, z, HEXAGON.flat())) deepest = Math.max(deepest, edgeDepth(x, z, HEXAGON));
    checkRoof(chunks, HEXAGON, (x, z) => 3 + (2 / 3) * edgeDepth(x, z, HEXAGON));
    expect(Math.abs(deepest - 3)).toBeLessThan(0.06);
    const bad = roofOf([[0, 0], [8, 0], [8, 6], [4, 3], [0, 6]], 'hip');
    expect(bad.flatMap((c) => c.problems)).toEqual(['fill "roof": a hip needs a convex footprint or one with only right angles']);
    // A rectangle's roof is as before (eaves at 3 m, rise a quarter of the width).
    expect(Math.abs(heightAt(roofOf([[0, 0], [8, 0], [8, 6], [0, 6]], 'hip'), 4, 3) - 4.5)).toBeLessThan(1e-4);
  });
});

/** A two-storey L building on the starter room, its windows on both storeys, a door, a stair; its interior in scene "inside". */
const building = (extra: Partial<ArchitectureBuilding> = {}): ArchitectureBuilding => ({
  id: 'house',
  preset: 'starter-room',
  outside: 'starter-room',
  path: { points: at(L_SHAPE), closed: true },
  storeys: 2,
  storeyHeight: 3,
  roof: { shape: 'hip', rise: 1.5 },
  openings: [
    { id: 'door-1', at: 5, width: 1, bottom: 0, top: 2.1 },
    { id: 'window-1', at: 2, width: 1, bottom: 0.9, top: 2 },
    { id: 'window-2', at: 2, width: 1, bottom: 0.9, top: 2, storey: 1 },
  ],
  stairs: [{ id: 'stair', from: [1, 0, 6], to: [1, 3, 9], width: 1 }],
  ...extra,
});

describe('buildings', () => {
  it('validates; the interior scene must be another scene of the project', () => {
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent({ elements: [], buildings: [building({ interior: { scene: 'inside', offset: [0, -50, 0] } })], interiorOf: { scene: 'outside', entity: 'house-object' } }, '', errors);
    expect(errors).toEqual([]);
    validateArchitectureComponent({ elements: [], outlines: [{ id: 'house', preset: 'starter-room', path: { points: at(L_SHAPE), closed: true } }], buildings: [building({ roof: { shape: 'dome' as never } })] }, '', errors);
    expect(errors.map((e) => e.path)).toEqual(['/buildings/0/id', '/buildings/0/roof/shape']);
  });

  it('one definition: the whole, the exterior and the interior share their walls; each leaves out what the other side shows', () => {
    const whole = expandArchitecture({ elements: [], buildings: [building()] }, [0, 0, 0], STARTERS);
    const outside = expandArchitecture({ elements: [], buildings: [building({ interior: { scene: 'inside' } })] }, [0, 0, 0], STARTERS);
    const inside = expandArchitecture({ elements: [], buildings: [building({ interior: { scene: 'inside' } })], interiorOf: { scene: 'outside', entity: 'o' } }, [0, 0, 0], STARTERS);
    for (const x of [whole, outside, inside]) expect(x.problems).toEqual([]);
    const ids = (x: typeof whole): string[] => x.component.elements.map((e) => e.id);
    const walls = (x: typeof whole): string => JSON.stringify(x.component.elements.filter((e) => e.kind === 'sweep' && e.wall === true).map((e) => ({ ...e, profile: x.component.profiles![(e as { profile: string }).profile] })));
    // The walls (and so their doors and windows, on both storeys) are the same sweeps on every side.
    expect(walls(outside)).toBe(walls(whole));
    expect(walls(inside)).toBe(walls(whole));
    expect(JSON.parse(walls(whole)).length).toBe(2);
    // The roof sits on the top storey's walls (3 m storeys, the starter's 3 m walls): over the exterior, not the interior.
    const roof = whole.component.elements.find((e) => e.id === 'house-roof') as ArchitectureFill;
    expect(roof.shape).toBe('hip');
    expect(roof.path.points.every((p) => p[1] === 6)).toBe(true);
    expect(ids(outside)).toContain('house-roof');
    expect(ids(inside)).not.toContain('house-roof');
    // The exterior: no stairs, no inside trims (baseboards, coves), but the floors and ceilings behind the windows.
    const kinds = (x: typeof whole): string[] => [...new Set(x.component.elements.map((e) => (e.kind === 'sweep' && e.wall === true ? 'wall' : e.kind === 'sweep' && e.stepped === true ? 'stair' : e.kind)))].sort();
    expect(kinds(whole)).toEqual(['fill', 'stair', 'sweep', 'wall']);
    // (its sweeps besides the walls are the facade's trims only).
    expect(kinds(outside)).toEqual(['fill', 'sweep', 'wall']);
    expect(outside.component.elements.filter((e) => e.kind === 'sweep' && e.wall !== true).every((e) => /^house(-s1)?-x/.test(e.id))).toBe(true);
    expect(kinds(inside)).toEqual(['fill', 'stair', 'sweep', 'wall']);
    // The facade's trims (its baseboard and cove along the outside) are the exterior's only.
    const facade = (x: typeof whole): number => x.component.elements.filter((e) => e.id.startsWith('house-x') || e.id.startsWith('house-s1-x')).length;
    expect(facade(whole)).toBeGreaterThan(0);
    expect(facade(outside)).toBe(facade(whole));
    expect(facade(inside)).toBe(0);
    // Both storeys are rooms; the roof covers the top one.
    expect(whole.rooms.map((r) => [r.id, r.covered])).toEqual([['house', true], ['house-s1', true]]);
    // Made: the generator makes all three without problems, the exterior's roof on its own trim row.
    for (const x of [whole, outside, inside]) expect(generateArchitecture(x.component, SHEETS).flatMap((c) => c.problems)).toEqual([]);
  });

  it('the door links pair the exterior\'s side of each door with the interior\'s, both ways', () => {
    const b = building({ interior: { scene: 'inside', offset: [100, 0, 0] } });
    const out = architectureDoorLinks('o', { elements: [], buildings: [b] }, [10, 0, 20]);
    const inn = architectureDoorLinks('i', { elements: [], buildings: [b], interiorOf: { scene: 'outside', entity: 'o' } }, [110, 0, 20]);
    // Only the ground storey's door (the windows' sills are off the floor).
    expect(out.map((l) => l.id)).toEqual(['house/door-1']);
    const [o, i] = [out[0]!, inn[0]!];
    // The door 5 m along the first side (z = 0): outside it is at (15, 0, 20); one arriving outside stands 1 m out (−z), facing out.
    expect(o).toMatchObject({ side: 'outside', entity: 'o', position: [15, 0, 20], spawn: [15, 0, 19], facing: 180, to: { scene: 'inside', position: [115, 0, 20], spawn: [115, 0, 21], facing: 0 } });
    expect(i).toMatchObject({ side: 'inside', entity: 'i', position: o.to.position, spawn: o.to.spawn, facing: o.to.facing, to: { scene: 'outside', position: o.position, spawn: o.spawn, facing: o.facing } });
  });

  it('scripts read the links of the loaded objects (ctx.grid.doorLinks), with each side\'s scene; the nearest to a point', () => {
    const b = building({ interior: { scene: 'inside', offset: [100, 0, 0] } });
    const arch = new RuntimeArchitecture(false, undefined, [], (id) => (id === 'o' ? 'outside' : id === 'i' ? 'inside' : undefined));
    arch.add([{ id: 'o', components: { transform: { position: [10, 0, 20], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, architecture: { elements: [], buildings: [b] } } }] as never);
    expect(arch.doorLinks().map((l) => [l.id, l.side, l.scene, l.to.scene])).toEqual([['house/door-1', 'outside', 'outside', 'inside']]);
    arch.add([{ id: 'i', components: { transform: { position: [110, 0, 20], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, architecture: { elements: [], buildings: [b], interiorOf: { scene: 'outside', entity: 'o' } } } }] as never);
    expect(arch.doorLinks().map((l) => [l.side, l.scene, l.to.scene])).toEqual([['inside', 'inside', 'outside'], ['outside', 'outside', 'inside']]);
    expect(Object.isFrozen(arch.doorLinks()[0]!.to.spawn)).toBe(true);
    expect(arch.doorLinkNear([15.5, 0, 19])?.side).toBe('outside');
    expect(arch.doorLinkNear([114, 0, 21])?.side).toBe('inside');
    expect(arch.doorLinkNear([30, 0, 30])).toBeNull();
    arch.remove(new Set(['i']));
    expect(arch.doorLinks().length).toBe(1);
  });

  it('the build adds each interior to its scene (once, at the building\'s place moved by the offset), not to the building\'s own', () => {
    const house = { id: 'house-object', name: 'House', components: { transform: { position: [5, 1, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, architecture: { elements: [], buildings: [building({ interior: { scene: 'inside', offset: [0, -40, 0] } })] }, materials: { '*': 'trim' } } };
    const docs = [
      { sceneId: 'outside', entities: [house] },
      { sceneId: 'inside', entities: [{ id: 'lamp', components: {} }] },
    ];
    const out = withBuildingInteriors(docs);
    expect(out[0]).toBe(docs[0]);
    const added = out[1]!.entities[1] as unknown as { id: string; components: { transform: { position: number[] }; architecture: ArchitectureComponent; materials: unknown } };
    expect(added.id).toBe(buildingInteriorId('house-object', 'house'));
    expect(added.components.transform.position).toEqual([5, -39, 5]);
    expect(added.components.materials).toEqual({ '*': 'trim' });
    expect(added.components.architecture.interiorOf).toEqual({ scene: 'outside', entity: 'house-object' });
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent(added.components.architecture, '', errors);
    expect(errors).toEqual([]);
    // A building naming its own scene adds nothing.
    const own = [{ sceneId: 'outside', entities: [{ ...house, components: { ...house.components, architecture: { elements: [], buildings: [building({ interior: { scene: 'outside' } })] } } }] }];
    expect(withBuildingInteriors(own)[0]!.entities.length).toBe(1);
  });

  it('measures a village of buildings: each chunk on a worker, an interior made at its door', () => {
    // 16 two-storey L buildings with hip roofs, 14 m apart, exteriors (their interiors in scenes of their own).
    const buildings: ArchitectureBuilding[] = [];
    for (let k = 0; k < 16; k++) {
      const ox = (k % 4) * 14;
      const oz = Math.floor(k / 4) * 14;
      buildings.push(building({ id: `house-${k}`, path: { points: L_SHAPE.map(([x, z]) => [x + ox, 0, z + oz] as P3), closed: true }, interior: { scene: 'inside' }, stairs: [{ id: 'stair', from: [ox + 1, 0, oz + 6], to: [ox + 1, 3, oz + 9], width: 1 }] }));
    }
    const village = expandArchitecture({ elements: [], buildings, chunkSize: 16 }, [0, 0, 0], STARTERS).component;
    const keys = [...architectureChunkKeys(village, SHEETS).values()];
    generateArchitectureChunk(village, SHEETS, keys[0]!.cx, keys[0]!.cz);
    const times: number[] = [];
    let draws = 0;
    let tris = 0;
    for (const k of keys) {
      const t0 = performance.now();
      const chunk = generateArchitectureChunk(village, SHEETS, k.cx, k.cz);
      times.push(performance.now() - t0);
      // One draw per chunk per material.
      expect(new Set(chunk.meshes.map((m) => m.material)).size).toBe(chunk.meshes.length);
      draws += chunk.meshes.length;
      for (const m of chunk.meshes) tris += m.mesh.indices.length / 3;
    }
    times.sort((a, b) => a - b);
    // One interior, as the page makes it when its scene loads: expand, key and make its chunks (serially, here).
    const inner: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      const c = expandArchitecture({ elements: [], buildings: [buildings[5]!], chunkSize: 16, interiorOf: { scene: 'outside', entity: 'o' } }, [0, 0, 0], STARTERS).component;
      for (const k of architectureChunkKeys(c, SHEETS).values()) generateArchitectureChunk(c, SHEETS, k.cx, k.cz);
      inner.push(performance.now() - t0);
    }
    inner.sort((a, b) => a - b);
    if (process.env['TL_PERF'] === '1') console.log(`buildings: 16 two-storey L exteriors in ${keys.length} chunks (16 m): ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms median, ${times[times.length - 1]!.toFixed(2)} ms worst per chunk; ${draws} draws, ${tris} triangles; one interior made whole ${inner[2]!.toFixed(2)} ms median`);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(200);
  });
});
