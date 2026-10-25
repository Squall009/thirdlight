/**
 * Ground cover on meshes: a triangle list's upward faces are the ground
 * (every floor under another, a face's underside and walls never), baked
 * into point sets by the block layers' code; generated architecture's
 * floors are its flat fills facing up, holes cut out, storeys each a floor.
 */
import { describe, expect, it } from 'vitest';

import { architectureFloorTriangles } from './arch-generate';
import { validateArchitectureComponent, type ArchitectureComponent } from './architecture';
import { validateModelComponent } from './components';
import { bakeCoverPoints, coverPointAt, type CoverPointSet } from './cover-points';
import type { ModelErrorV2 } from './errors';
import { meshCoverChunkRect, meshCoverChunks, meshScatterSurface, validateMeshCoverRules } from './mesh-scatter';
import type { ScatterRule } from './scatter';

const ORIGIN = [10, 1, -5];
const MOSS: ScatterRule = { id: 'moss', asset: { assetId: 'moss' }, density: 4, cover: true, scale: [0.8, 1.2] };

/** A quad (x0..x1, z0..z1) at height y as two triangles, facing up (or down). */
function quad(x0: number, z0: number, x1: number, z1: number, y: number, up = true): number[] {
  // Counter-clockwise seen from above: (x0,z0) → (x0,z1) → (x1,z1).
  const a = [x0, y, z0, x0, y, z1, x1, y, z1];
  const b = [x0, y, z0, x1, y, z1, x1, y, z0];
  const flip = (t: number[]): number[] => [...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6)];
  return up ? [...a, ...b] : [...flip(a), ...flip(b)];
}

/** A set's points (places in the source's frame). */
const points = (set: CoverPointSet): ReturnType<typeof coverPointAt>[] => Array.from({ length: set.count }, (_x, i) => coverPointAt(set, i));

describe('ground cover on meshes', () => {
  it('grows on every upward face: a floor and the shelf over half of it, not the shelf\'s underside or a wall', () => {
    const tris = Float32Array.from([
      ...quad(0, 0, 8, 8, 0),
      // A shelf over x < 4: its top at 2 m, its underside at 1.9 m.
      ...quad(0, 0, 4, 8, 2),
      ...quad(0, 0, 4, 8, 1.9, false),
      // A wall along z = 8.
      0, 0, 8, 8, 0, 8, 8, 3, 8,
    ]);
    expect([...meshCoverChunks(tris)]).toEqual(['0,0']);
    const set = bakeCoverPoints(MOSS, meshScatterSurface(tris, ORIGIN), meshCoverChunkRect(ORIGIN, 0, 0), ORIGIN);
    const ps = points(set);
    const floor = ps.filter((p) => Math.abs(p.y) < 1e-4);
    const shelf = ps.filter((p) => Math.abs(p.y - 2) < 1e-4);
    // Every point on one of the two faces, none on the underside: about 4 a m² on each.
    expect(floor.length + shelf.length).toBe(set.count);
    expect(floor.length / (64 * 4)).toBeGreaterThan(0.85);
    expect(floor.length / (64 * 4)).toBeLessThan(1.15);
    expect(shelf.length / (32 * 4)).toBeGreaterThan(0.8);
    expect(shelf.length / (32 * 4)).toBeLessThan(1.2);
    // The floor under the shelf grows too (an interior), the shelf only over its own half.
    expect(floor.some((p) => p.x < 4)).toBe(true);
    expect(shelf.every((p) => p.x <= 4 + 1e-2)).toBe(true);
    expect(ps.every((p) => p.normal[1] > 0.99)).toBe(true);
  });

  it('reads slope from the face: a 45° ramp holds a rule up to 25° nowhere, one without a slope condition all over', () => {
    // From z = 0, y = 0 up to z = 4, y = 4 (x 0..4).
    const ramp = Float32Array.from([0, 0, 0, 0, 4, 4, 4, 4, 4, 0, 0, 0, 4, 4, 4, 4, 0, 0]);
    const surface = meshScatterSurface(ramp, ORIGIN);
    const rect = meshCoverChunkRect(ORIGIN, 0, 0);
    expect(bakeCoverPoints({ ...MOSS, slope: { max: 25 } }, surface, rect, ORIGIN).count).toBe(0);
    const set = bakeCoverPoints(MOSS, surface, rect, ORIGIN);
    expect(set.count / (16 * 4)).toBeGreaterThan(0.8);
    for (const p of points(set)) {
      expect(p.normal[1]).toBeCloseTo(Math.SQRT1_2, 1);
      // On the ramp: its height is its depth (both in the source's frame).
      expect(p.y).toBeCloseTo(p.z, 2);
    }
  });

  it('grows on generated floors: the ground storey round its stairwell and the storey above, not the ceiling', () => {
    const c: ArchitectureComponent = {
      elements: [
        { id: 'floor', kind: 'fill', path: { points: [[0, 0, 0], [0, 0, 4], [6, 0, 4], [6, 0, 0]], closed: true }, shape: 'flat', slot: 'floor', holes: [{ points: [[1, 0, 1], [1, 0, 3], [3, 0, 3], [3, 0, 1]], closed: true }] },
        { id: 'upper', kind: 'fill', path: { points: [[0, 0, 0], [0, 0, 4], [6, 0, 4], [6, 0, 0]], closed: true }, shape: 'flat', slot: 'floor', height: 3 },
        { id: 'ceiling', kind: 'fill', path: { points: [[0, 0, 0], [0, 0, 4], [6, 0, 4], [6, 0, 0]], closed: true }, shape: 'flat', slot: 'ceiling', height: 2.8, face: 'down' },
      ],
    } as ArchitectureComponent;
    const tris = architectureFloorTriangles(c);
    // Two floors' triangles, each facing up.
    expect(tris.length % 9).toBe(0);
    expect(tris.length / 9).toBeGreaterThanOrEqual(4);
    const set = bakeCoverPoints(MOSS, meshScatterSurface(tris, ORIGIN), meshCoverChunkRect(ORIGIN, 0, 0), ORIGIN);
    const ps = points(set);
    const ground = ps.filter((p) => Math.abs(p.y) < 1e-4);
    const upper = ps.filter((p) => Math.abs(p.y - 3) < 1e-4);
    expect(ground.length + upper.length).toBe(set.count);
    // 24 m² less the 4 m² stairwell below, 24 m² above.
    expect(ground.length / (20 * 4)).toBeGreaterThan(0.8);
    expect(ground.length / (20 * 4)).toBeLessThan(1.2);
    expect(upper.length / (24 * 4)).toBeGreaterThan(0.8);
    expect(upper.length / (24 * 4)).toBeLessThan(1.2);
    const inWell = (p: { x: number; z: number }): boolean => p.x > 1.01 && p.x < 2.99 && p.z > 1.01 && p.z < 2.99;
    expect(ground.some(inWell)).toBe(false);
    expect(upper.some(inWell)).toBe(true);
  });

  it('is ground cover only on a model or architecture, and the components take it', () => {
    const errors: ModelErrorV2[] = [];
    validateMeshCoverRules([MOSS, { ...MOSS, id: 'trees', cover: undefined }], '/scatter', errors);
    expect(errors.map((e) => e.path)).toEqual(['/scatter/1/cover']);
    const ok: ModelErrorV2[] = [];
    validateModelComponent({ asset: { assetId: 'rock' }, scatter: [MOSS] }, '/model', ok);
    validateArchitectureComponent({ elements: [], scatter: [MOSS] }, '/architecture', ok);
    expect(ok).toEqual([]);
  });
});
