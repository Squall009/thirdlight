/**
 * The level classes' decal and paint switches without a browser: at 0 the
 * class is the plan it was; above 0 the marks are where the switches say
 * (ground, walls and props, the pairs overlapping), deterministic, and the
 * kinds the engine can't draw yet are refused rather than built as
 * something else.
 */
import { describe, expect, it } from 'vitest';

import { levelPlan, LEVEL_SPEC } from '../../tools/perf/level';
import { DECAL_PAIR_SHARE, MARK_QUAD, MESH_DECAL_LIFT, NO_LEVEL_MARKS, PAINTED_FILE_SUFFIX, marksNotBuilt, parseLevelMarks, type LevelDecalPlacement } from '../../tools/perf/level-marks';
import { propGlb } from '../../tools/perf/village-assets';

const plan = (marks = NO_LEVEL_MARKS, kind: 'area' | 'landscape' = 'area'): ReturnType<typeof levelPlan> => levelPlan(kind, undefined, 0, false, false, 'none', false, 0, false, 0, 0, 'on', false, 0, true, true, false, marks);
const flags = (o: Record<string, string>) => (f: string): string | undefined => o[f];
/** The +Z axis (the surface's normal) of a rotation. */
const zAxis = ([x, y, z, w]: readonly number[]): [number, number, number] => [2 * (x! * z! + w! * y!), 2 * (y! * z! - w! * x!), 1 - 2 * (x! * x! + y! * y!)];

describe('the level marks switches', () => {
  it('read whole counts of 0 or more and refuse anything else', () => {
    expect(parseLevelMarks(flags({}))).toEqual(NO_LEVEL_MARKS);
    expect(parseLevelMarks(flags({ decals: '200', 'mesh-decals': '1000', 'clipped-decals': '0', painted: '30' }))).toEqual({ decals: 200, meshDecals: 1000, clippedDecals: 0, painted: 30 });
    for (const bad of ['-1', '1.5', 'x', '']) expect(() => parseLevelMarks(flags({ decals: bad }))).toThrow(/--decals: a whole number/);
  });

  it('at 0 leave the class as it was: the same entities, edits and counts, nothing to publish', () => {
    const before = levelPlan('area');
    const after = plan();
    expect(after.batches).toEqual(before.batches);
    expect(after.blockEdits).toEqual(before.blockEdits);
    expect(after.counts).toEqual(before.counts);
    expect(after.marks).toMatchObject({ decals: [], meshDecals: [], clippedDecals: [], paintedProps: [], paintedCopies: [] });
    expect(marksNotBuilt(after.marks!)).toBeNull();
  });

  it('spread projected decals over the ground, the walls and the props, 30 % in overlapping pairs, the rest of the plan unmoved', () => {
    const base = plan();
    const p = plan({ ...NO_LEVEL_MARKS, decals: 200 });
    expect(JSON.stringify(plan({ ...NO_LEVEL_MARKS, decals: 200 }))).toBe(JSON.stringify(p));
    expect(p.batches).toEqual(base.batches);
    expect(p.blockEdits).toEqual(base.blockEdits);
    const d = p.marks!.decals;
    expect(d).toHaveLength(200);
    expect(p.counts).toMatchObject({ decals: 200, decalPairs: 200 * DECAL_PAIR_SHARE / 2 });
    const bySurface = (s: string): LevelDecalPlacement[] => d.filter((x) => x.surface === s);
    for (const s of ['ground', 'wall', 'prop']) expect(bySurface(s).length).toBeGreaterThan(15);
    const half = LEVEL_SPEC.areaSide / 2;
    for (const [i, x] of d.entries()) {
      expect(Math.hypot(...x.rotation)).toBeCloseTo(1, 4);
      expect(Math.abs(x.position[0])).toBeLessThanOrEqual(half + 2);
      expect(Math.abs(x.position[2])).toBeLessThanOrEqual(half + 2);
      const n = zAxis(x.rotation);
      if (x.surface === 'ground') expect(n[1]).toBeGreaterThan(0.7);
      else expect(Math.abs(n[1])).toBeLessThan(1e-3);
      if (x.overlaps !== undefined) {
        // A pair's second lies on its first's surface, closer than the first's width.
        const f = d[x.overlaps]!;
        expect(x.overlaps).toBe(i - 1);
        expect(x.surface).toBe(f.surface);
        expect(Math.hypot(x.position[0] - f.position[0], x.position[1] - f.position[1], x.position[2] - f.position[2])).toBeLessThan(f.size[0]);
      }
    }
    // Not built yet: refused, not measured as something else.
    expect(marksNotBuilt(p.marks!)).toMatch(/--decals: projected decals need the decal component/);
    expect(marksNotBuilt(plan({ ...NO_LEVEL_MARKS, clippedDecals: 10 }).marks!)).toMatch(/--clipped-decals/);
  });

  it('place mesh decals as quads laid over the ground and the walls, static', () => {
    const p = plan({ ...NO_LEVEL_MARKS, meshDecals: 120 });
    const marks = p.batches.flat().filter((e) => e.id.startsWith('mark-'));
    expect(marks).toHaveLength(120);
    expect(p.marks!.meshDecals.some((d) => d.surface === 'prop')).toBe(false);
    expect(p.counts).toMatchObject({ meshDecals: 120 });
    for (const [i, e] of marks.entries()) {
      const d = p.marks!.meshDecals[i]!;
      const t = e.components['transform'] as { position: number[]; rotation: number[]; scale: number[] };
      expect(e.static).toBe(true);
      expect(e.components['model']).toEqual({ asset: { assetId: MARK_QUAD } });
      expect(t.scale).toEqual([d.size[0], d.size[1], 1]);
      const n = zAxis(d.rotation);
      const lift = (t.position[0]! - d.position[0]) * n[0] + (t.position[1]! - d.position[1]) * n[1] + (t.position[2]! - d.position[2]) * n[2];
      expect(lift).toBeCloseTo(MESH_DECAL_LIFT, 3);
    }
    expect(marksNotBuilt(p.marks!)).toBeNull();
  });

  it('paint props from their painted twins first, then copies, which wait for the per-copy stream', () => {
    const p = plan({ ...NO_LEVEL_MARKS, painted: 40 });
    const models = p.batches.flat().filter((e) => e.id.startsWith('prop-')).map((e) => (e.components['model'] as { asset: { assetId: string } }).asset.assetId);
    expect(models.filter((m) => m.endsWith(PAINTED_FILE_SUFFIX))).toHaveLength(40);
    expect(models.slice(0, 40).every((m) => m.endsWith(PAINTED_FILE_SUFFIX))).toBe(true);
    expect(marksNotBuilt(p.marks!)).toBeNull();
    const more = plan({ ...NO_LEVEL_MARKS, painted: LEVEL_SPEC.props + 50 });
    expect(more.marks!.paintedCopies).toHaveLength(50);
    expect(new Set(more.marks!.paintedCopies.map((c) => c.entityId)).size).toBe(LEVEL_SPEC.foliageSets);
    expect(marksNotBuilt(more.marks!)).toMatch(/per-copy paint stream/);
    // The landscape carries the same marks over its area.
    expect(plan({ ...NO_LEVEL_MARKS, painted: 40 }, 'landscape').marks!.paintedProps).toEqual(p.marks!.paintedProps);
  });

  it('give a painted prop file the plain file\'s meshes plus a normalised 4-byte COLOR_0 stream', () => {
    const json = (glb: Buffer): { meshes: { primitives: { attributes: Record<string, number> }[] }[]; accessors: Record<string, unknown>[] } => JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    const spec = { parts: 2, rings: 8, sides: 12, textureSize: 0 };
    const plain = json(propGlb(7, spec));
    const painted = json(propGlb(7, spec, true));
    expect(propGlb(7, spec, false).equals(propGlb(7, spec))).toBe(true);
    expect(painted.meshes).toHaveLength(plain.meshes.length);
    for (const [i, m] of painted.meshes.entries()) {
      const a = m.primitives[0]!.attributes;
      expect(plain.meshes[i]!.primitives[0]!.attributes['COLOR_0']).toBeUndefined();
      expect(painted.accessors[a['COLOR_0']!]).toMatchObject({ componentType: 5121, type: 'VEC4', normalized: true, count: (painted.accessors[a['POSITION']!] as { count: number }).count });
      expect(painted.accessors[a['POSITION']!]).toEqual({ ...(plain.accessors[plain.meshes[i]!.primitives[0]!.attributes['POSITION']!] as object), bufferView: (painted.accessors[a['POSITION']!] as { bufferView: number }).bufferView });
    }
  });
});
