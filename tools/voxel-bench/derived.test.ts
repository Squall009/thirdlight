/**
 * Derived data against the real store, codec and job handler: the one
 * assembly evaluation and every consumer's output (occupancy, collision,
 * navigation, light, meshes, instances), their invalidation radius, the
 * voxel mips and the prop light channel.
 */
import {
  applyEdit,
  ASSEMBLY_CLASS,
  buildApron,
  canonicalEditCommand,
  cellBit,
  ChunkTreeFlags,
  chunkGrid,
  CLASS_MASK,
  COLLISION_STEPS_PER_CELL,
  combineCoverage,
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  DEFAULT_REGION_FOOTPRINT,
  dependentChunks,
  deriveFromStore,
  deriveSectionsWithApron,
  downsampleMip,
  editBounds,
  encodeDerived,
  encodeShader,
  evaluateAssembly,
  fillNeighbourhood,
  INSTANCE_BYTES,
  INSTANCE_FLAG,
  joinSections,
  PLANE_BIT,
  jobRadius,
  LIGHT_COVERAGE,
  lightCoverage,
  mipChildren,
  mipNodeKey,
  mipNodeOf,
  MipStaleSet,
  NAV_CLEARANCE_CONTINUES,
  OCCUPANCY,
  PIECE_FAMILY,
  PLACEHOLDER_RULES,
  POSITION_STEPS_PER_CELL,
  registeredAssemblyRules,
  ruleRadiusMismatches,
  propCoverageChunk,
  RUN_X,
  RUN_Z,
  sameDenseChunk,
  streamJobHandlers,
  shaderEntry,
  shaderEntryAt,
  SHADER_BORDER_CELLS,
  SURFACE_VERTEX_BYTES,
  VOXEL_ROLE,
  valueRole,
  type AssemblyRuleSet,
  type DenseChunk,
  type DeriveOutput,
  type DerivedData,
  type JoinedChunk,
  type MipNode,
  type PaletteStore,
  type SurfaceBuffer,
  type VoxelEditCommand,
} from '@thirdlight/voxel';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from '@thirdlight/shared';
import { listRegionFiles, RegionWorld } from '@thirdlight/workspace';
import { describe, expect, it } from 'vitest';
import { loadArea, zstdDecompress } from './regions';
import { instanceList, triangleList } from './mesh-compare';
import { houseVoxel, townWorld, type House } from './town';
import { flatGround, placeWallBeamBanister, putVoxel, randomAssemblyWorld } from './scenes';
import { MAT } from './world-kit';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const R = jobRadius(PLACEHOLDER_RULES);
const C = VOXEL_ROLE;

const put = putVoxel;
const ground = flatGround;

const local = (v: number): number => v & grid.mask;
const chunkOf = (v: number): number => v >> grid.shift;
const li = (x: number, y: number, z: number): number => (local(x) * E + local(z)) * E + local(y);

function derivedAt(store: PaletteStore, x: number, y: number, z: number): DerivedData {
  return deriveFromStore(store, chunkOf(x), chunkOf(y), chunkOf(z), PLACEHOLDER_RULES);
}

/** The resolved class byte of one cell (the evaluation the derive runs). */
function classAt(store: PaletteStore, x: number, y: number, z: number): number {
  const cx = chunkOf(x);
  const cy = chunkOf(y);
  const cz = chunkOf(z);
  const n = createNeighbourhood(E, R);
  const dense = createDenseChunk(grid);
  const has = store.exportChunk(cx, cy, cz, dense);
  fillNeighbourhood(n, grid, has ? dense : null, buildApron(store, cx, cy, cz, R));
  const out = new Uint8Array(n.values.length);
  evaluateAssembly(n, PLACEHOLDER_RULES, out);
  return out[((local(x) + R) * n.side + (local(z) + R)) * n.side + (local(y) + R)]!;
}

/** What each consumer says about one cell. */
function consumersAt(store: PaletteStore, x: number, y: number, z: number): { light: number; navBlocks: boolean; standable: boolean; collision: 'none' | 'full' | 'partial'; instance: number | null; renderSolid: boolean } {
  const d = derivedAt(store, x, y, z);
  const i = li(x, y, z);
  const light = lightCoverage(grid, d.light, null)[i]!;
  const navBlocks = d.nav.blocking === OCCUPANCY.solid || cellBit(d.nav.blocks, i);
  const standable = d.nav.standable.includes(i);
  const S = COLLISION_STEPS_PER_CELL;
  let collision: 'none' | 'full' | 'partial' = 'none';
  const b = d.collision.boxes;
  const [lx, ly, lz] = [local(x), local(y), local(z)];
  for (let k = 0; k < b.length; k += 6) {
    const inside = (lo: number, hi: number, c: number): boolean => lo < (c + 1) * S && hi > c * S;
    if (!inside(b[k]!, b[k + 3]!, lx) || !inside(b[k + 1]!, b[k + 4]!, ly) || !inside(b[k + 2]!, b[k + 5]!, lz)) continue;
    const covers = b[k]! <= lx * S && b[k + 3]! >= (lx + 1) * S && b[k + 1]! <= ly * S && b[k + 4]! >= (ly + 1) * S && b[k + 2]! <= lz * S && b[k + 5]! >= (lz + 1) * S;
    collision = covers ? 'full' : 'partial';
  }
  let instance: number | null = null;
  const data = d.instances.data;
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    if (data[o] === lx && data[o + 1] === ly && data[o + 2] === lz) instance = data[o + 4]! | (data[o + 5]! << 8);
  }
  const renderSolid = d.occupancy.flag === OCCUPANCY.solid || cellBit(d.occupancy.mask, i);
  return { light, navBlocks, standable, collision, instance, renderSolid };
}

/** The wall, beam and banister scene around the origin (scenes.ts). */
function wallBeamBanister(): PaletteStore {
  const s = createWorldStore(grid);
  placeWallBeamBanister(s);
  return s;
}

describe('assembly evaluation and per-consumer outputs', () => {
  it('resolves the same construction cells as wall, beam or rail by their neighbours, and every consumer follows', () => {
    const s = wallBeamBanister();
    expect(classAt(s, 0, 4, 0)).toBe(ASSEMBLY_CLASS.wall);
    expect(classAt(s, 0, 5, -1)).toBe(ASSEMBLY_CLASS.beam | RUN_X);
    expect(classAt(s, 1, 2, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    expect(classAt(s, 0, 1, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X | RUN_Z);
    expect(classAt(s, 0, 0, 5)).toBe(ASSEMBLY_CLASS.wall);

    const wall = consumersAt(s, 0, 4, 0);
    const beam = consumersAt(s, 0, 5, -1);
    const rail = consumersAt(s, 1, 2, 7);
    expect(wall).toMatchObject({ light: 255, navBlocks: true, collision: 'full', instance: null, renderSolid: true });
    expect(beam).toMatchObject({ light: LIGHT_COVERAGE.beam, navBlocks: true, collision: 'partial', renderSolid: false });
    expect(beam.instance! >> 2).toBe(PIECE_FAMILY.beam);
    expect(rail).toMatchObject({ light: LIGHT_COVERAGE.rail, navBlocks: true, collision: 'partial', renderSolid: false });
    expect(rail.instance! >> 2).toBe(PIECE_FAMILY.rail);
    // Standing: on top of the wall yes, on top of the rail no; the slab under the banister holds standable cells.
    expect(consumersAt(s, 0, 8, 0).standable).toBe(true);
    expect(consumersAt(s, 1, 3, 7).standable).toBe(false);
    expect(consumersAt(s, 1, 1, 6).standable).toBe(true);
    // The rail replaces its base: its instance says so, and no base face sits in its cell.
    const d = derivedAt(s, 1, 2, 7);
    const flags = d.instances.data.filter((_, k) => k % INSTANCE_BYTES === 3);
    expect([...flags].every((f) => (f & INSTANCE_FLAG.replacesBase) !== 0)).toBe(true);
    expect(baseFaceTouches(d, 1, 2, 7)).toBe(false);

    // Grow the banister upward: a third thin cell over the post makes the run a wall for every consumer.
    for (let x = -4; x < 4; x++) put(s, x, 3, 7, MAT.timber, C.wall);
    expect(classAt(s, 1, 2, 7)).toBe(ASSEMBLY_CLASS.wall);
    expect(classAt(s, 0, 2, 7)).toBe(ASSEMBLY_CLASS.wall);
    expect(consumersAt(s, 0, 2, 7)).toMatchObject({ light: 255, collision: 'full', instance: null, renderSolid: true });
    expect(consumersAt(s, 0, 4, 7).standable).toBe(true);
    // Fill under the beam down to the ground: it is now a second wall layer.
    for (let x = -6; x < 6; x++) for (let y = 0; y < 5; y++) put(s, x, y, -1, MAT.timber, C.wall);
    expect(classAt(s, 0, 5, -1)).toBe(ASSEMBLY_CLASS.wall);
    expect(consumersAt(s, 0, 5, -1)).toMatchObject({ light: 255, collision: 'full', instance: null });
  });

  it('is deterministic: the same voxels give the same bytes, after a codec round trip and in the worker job', async () => {
    const s = wallBeamBanister();
    const keys: Array<[number, number, number]> = [[-1, -1, -1], [-1, 0, -1], [0, 0, 0], [-1, 0, 0], [0, -1, 0]];
    const t = createWorldStore(grid);
    for (const [cx, cy, cz] of [-1, 0].flatMap((x) => [-1, 0].flatMap((y) => [-1, 0].map((z) => [x, y, z] as const)))) {
      const bytes = s.encodeChunk(cx, cy, cz);
      if (bytes !== null) t.decodeChunk(cx, cy, cz, bytes);
    }
    const handlers = streamJobHandlers({ decompress: zstdDecompress });
    for (const [cx, cy, cz] of keys) {
      const a = encodeDerived(deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES));
      expect(encodeDerived(deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES))).toEqual(a);
      expect(encodeDerived(deriveFromStore(t, cx, cy, cz, PLACEHOLDER_RULES))).toEqual(a);
      const r = await handlers.derive!({ edge: 32, chunk: { grid: 0, cx, cy, cz }, payload: s.chunkPayload(cx, cy, cz, true), radius: R, apron: buildApron(s, cx, cy, cz, R), rules: { id: 'placeholder', version: 2, radius: 2 } });
      const out = r.output as DeriveOutput;
      expect(encodeDerived(out.assembly!)).toEqual(a);
      expect(out.hash).toBe(crc32(a));
    }
    // The result names its rules; a job naming another version or the wrong radius is refused.
    expect(deriveFromStore(s, 0, 0, 0, PLACEHOLDER_RULES).rules).toEqual({ id: 'placeholder', version: 2, radius: 2 });
    const job = (rules: { id: string; version: number; radius: number }, radius: number): unknown => handlers.derive!({ edge: 32, chunk: { grid: 0, cx: 0, cy: 0, cz: 0 }, payload: s.chunkPayload(0, 0, 0, true), radius, apron: buildApron(s, 0, 0, 0, radius), rules });
    expect(() => job({ id: 'placeholder', version: 3, radius: 2 }, R)).toThrow(RangeError);
    expect(() => job({ id: 'placeholder', version: 2, radius: 2 }, 2)).toThrow(RangeError);
  });

  it('derives the same from runtime set/fill edits as from a structure written by its generator', () => {
    const house: House = { w: 20, d: 16, storeys: 2, wall: MAT.stone, balcony: true };
    const ox = -10;
    const oz = -6;
    const structure = createWorldStore(grid);
    const runtime = createWorldStore(grid);
    ground(structure, -24, 24, -24, 24, 2);
    ground(runtime, -24, 24, -24, 24, 2);
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    let commands = 0;
    for (let x = -2; x < house.w + 2; x++) for (let z = -4; z < house.d + 2; z++) {
      // The runtime side writes each column's runs of equal voxels as one-cell-wide fill boxes: no house record anywhere.
      let run: { y0: number; m: number; c: number; o: number } | null = null;
      const flush = (y1: number): void => {
        if (run === null) return;
        const cmd: VoxelEditCommand = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [ox + x, run.y0, oz + z], max: [ox + x, y1, oz + z], mode: 'place', voxel: { material: run.m, role: run.c, wetness: run.o } });
        applyEdit({ store: () => runtime }, cmd);
        commands++;
        run = null;
      };
      for (let y = 0; y < 24; y++) {
        const hit = houseVoxel(house, x, y, z, v);
        if (hit) put(structure, ox + x, y, oz + z, v.material, v.role, v.shape, v.wetness);
        if (run !== null && (!hit || run.m !== v.material || run.c !== v.role || run.o !== v.wetness)) flush(y - 1);
        if (hit && run === null) run = { y0: y, m: v.material, c: v.role, o: v.wetness };
      }
      flush(23);
    }
    expect(commands).toBeGreaterThan(300);
    const a = createDenseChunk(grid);
    const b = createDenseChunk(grid);
    let beams = 0;
    let rails = 0;
    for (const cx of [-1, 0]) for (const cy of [-1, 0]) for (const cz of [-1, 0]) {
      expect(structure.exportChunk(cx, cy, cz, a)).toBe(runtime.exportChunk(cx, cy, cz, b));
      expect(sameDenseChunk(a, b)).toBe(true);
      const ds = deriveFromStore(structure, cx, cy, cz, PLACEHOLDER_RULES);
      expect(encodeDerived(deriveFromStore(runtime, cx, cy, cz, PLACEHOLDER_RULES))).toEqual(encodeDerived(ds));
      beams += ds.counts.beam;
      rails += ds.counts.rail;
    }
    // The house has beams at its storey line and a banister on its balcony, all inferred.
    expect(beams).toBeGreaterThan(10);
    expect(rails).toBeGreaterThan(5);
  });

  it('reaches the same derived results and region bytes from one arrangement made by different commands in another order', async () => {
    // Two copies of one world folder (ground, the wall-beam-banister scene) edited to the same arrangement:
    // A fills a wall across both chunk faces, digs a hole through it with a brush, sets a rail on it and paints a
    // band; B sets the rail first, adds the wall as two fills in the other order, paints cell by cell before the
    // dig, and digs the hole's cells as a listed dig, in shuffled order.
    const root = mkdtempSync(join(tmpdir(), 'voxel-qa-'));
    try {
      const start = wallBeamBanister();
      ground(start, -24, 24, -24, 24, 3);
      const opts = { grid, worldId: Uint8Array.from({ length: 16 }, (_, i) => i + 1), layout: 'stacked' as const, footprint: DEFAULT_REGION_FOOTPRINT };
      RegionWorld.create(join(root, 'a'), opts, start);
      cpSync(join(root, 'a'), join(root, 'b'), { recursive: true });
      const [a, b] = [(await RegionWorld.open(join(root, 'a'), opts, listRegionFiles(join(root, 'a')))).world, (await RegionWorld.open(join(root, 'b'), opts, listRegionFiles(join(root, 'b')))).world];
      const cmd = (o: Record<string, unknown>): VoxelEditCommand => canonicalEditCommand({ v: 2, grid: 0, ...o });
      const stone = { material: MAT.stone, role: C.wall, wetness: 0 };
      const plaster = { material: MAT.plaster, role: C.wall, wetness: 0 };
      const rail: number[] = [];
      for (let x = -6; x <= 5; x++) rail.push(x, 7, 14);
      const railVoxel = { material: MAT.plank, role: C.wall, wetness: 0, shape: 15 };
      const sphere = cmd({ kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [0, 3, 14.5], mode: 'dig', smooth: false });
      a.edit(cmd({ kind: 'fill', min: [-6, 0, 14], max: [5, 6, 15], mode: 'place', voxel: stone }));
      const hole = a.edit(sphere);
      a.edit(cmd({ kind: 'set', cells: rail, voxel: railVoxel }));
      a.edit(cmd({ kind: 'fill', min: [-6, 5, 14], max: [5, 5, 15], mode: 'paint', voxel: plaster }));
      // The hole's cells, from the brush's undo record: what B digs as a list.
      const holeCells: number[] = [];
      for (const u of hole.chunks) {
        if (u.before.kind !== 'delta') throw new Error('a 2-cell hole is a delta per chunk');
        const d = u.before.delta;
        for (let k = 0; k < d.count; k++) {
          const i = d.cells[k]!;
          holeCells.push((u.cx << grid.shift) + (i >>> (2 * grid.shift)), (u.cy << grid.shift) + (i & grid.mask), (u.cz << grid.shift) + ((i >>> grid.shift) & grid.mask));
        }
      }
      expect(holeCells.length / 3).toBeGreaterThan(20);
      expect(new Set(hole.chunks.map((u) => u.cx)).size).toBe(2);
      const shuffled: number[] = [];
      for (let k = holeCells.length - 3; k >= 0; k -= 6) shuffled.push(...holeCells.slice(k, k + 3));
      for (let k = holeCells.length - 6; k >= 0; k -= 6) shuffled.push(...holeCells.slice(k, k + 3));
      b.edit(cmd({ kind: 'set', cells: rail, voxel: railVoxel }));
      b.edit(cmd({ kind: 'fill', min: [0, 0, 14], max: [5, 6, 15], mode: 'add', voxel: stone }));
      b.edit(cmd({ kind: 'fill', min: [-6, 0, 14], max: [-1, 6, 15], mode: 'add', voxel: stone }));
      const band: number[] = [];
      for (let x = 5; x >= -6; x--) band.push(x, 5, 15, x, 5, 14);
      b.edit(cmd({ kind: 'set', cells: band, voxel: { ...plaster, shape: 15 } }));
      b.edit(cmd({ kind: 'dig', cells: shuffled }));
      a.save();
      b.save();
      // Equal region files, byte for byte, and equal derived results for every chunk around the edits.
      const names = listRegionFiles(join(root, 'a'));
      expect(listRegionFiles(join(root, 'b'))).toEqual(names);
      for (const n of names) expect(readFileSync(join(root, 'b', n)).equals(readFileSync(join(root, 'a', n))), n).toBe(true);
      let beams = 0;
      for (const cx of [-1, 0]) for (const cy of [-1, 0]) for (const cz of [-1, 0]) {
        const da = encodeDerived(deriveFromStore(a.store, cx, cy, cz, PLACEHOLDER_RULES));
        expect(crc32(encodeDerived(deriveFromStore(b.store, cx, cy, cz, PLACEHOLDER_RULES))), `chunk ${cx},${cy},${cz}`).toBe(crc32(da));
        beams += deriveFromStore(a.store, cx, cy, cz, PLACEHOLDER_RULES).counts.beam;
      }
      expect(beams).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Whether any base-surface vertex lies inside cell (x, y, z) (not on its boundary). */
function baseFaceTouches(d: DerivedData, x: number, y: number, z: number): boolean {
  const stride = SURFACE_VERTEX_BYTES;
  const view = new DataView(d.base.vertices.buffer, d.base.vertices.byteOffset, d.base.vertices.byteLength);
  const st = POSITION_STEPS_PER_CELL;
  // A face of a neighbouring cell lies on this cell's boundary; only a face of this cell's own cube has all 4 corners on it.
  const cell = [local(x), local(y), local(z)];
  for (let v = 0; v + 3 < d.base.vertexCount; v += 4) {
    let all = true;
    for (let k = 0; k < 4 && all; k++) for (let a = 0; a < 3 && all; a++) {
      const p = view.getUint16((v + k) * stride + 2 * a, true) / st - 1;
      all = p >= cell[a]! && p <= cell[a]! + 1;
    }
    if (all) {
      // All four corners on the cell's cube: the face is on the cell, from inside or out; the normal says which side.
      const n = [view.getInt8(v * stride + 8), view.getInt8(v * stride + 9), view.getInt8(v * stride + 10)];
      const axis = n.findIndex((c) => c !== 0);
      const p = view.getUint16(v * stride + 2 * axis, true) / st - 1;
      const owner = n[axis]! > 0 ? p - 1 : p;
      if (owner === cell[axis]) return true;
    }
  }
  return false;
}

describe('the radius conformance check every rule set must pass', () => {
  const g16 = chunkGrid(16);
  /** Every chunk of the random worlds' cube (half 24 cells: 3 × 3 chunks of 16 on each axis, and their faces). */
  const cube: Array<{ cx: number; cy: number; cz: number }> = [];
  for (let cx = -2; cx <= 1; cx++) for (let cy = -2; cy <= 1; cy++) for (let cz = -2; cz <= 1; cz++) cube.push({ cx, cy, cz });

  // Each registered rule set (46b's catalogue too, once registered) resolves every cell the consumers read the same
  // with the job's apron (radius + reach) as with 3 cells more, on random worlds at both chunk edges.
  it.each(registeredAssemblyRules().map((r) => [r.id, r] as const))('%s reads no further than its declared radius', (_id, rules) => {
    for (const [g, seeds] of [[g16, [1, 2, 3]], [grid, [4]]] as const) {
      for (const seed of seeds) {
        const s = createWorldStore(g);
        randomAssemblyWorld(s, seed, 24);
        const chunks = g.edge === 16 ? cube : [-1, 0].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0].map((cz) => ({ cx, cy, cz }))));
        expect(ruleRadiusMismatches(s, rules, chunks), `edge ${g.edge}, seed ${seed}`).toEqual([]);
      }
    }
  });

  it('catches a rule set that reads past the radius it declares', () => {
    // A rule that looks 2 cells along x (a construction cell is a beam when another stands 2 cells on), declared as
    // reading 1: the job's apron is a cell short, and near a chunk face it reads past it.
    const resolve = (n: Parameters<AssemblyRuleSet['resolve']>[0], lo: number, hi: number, out: Uint8Array): void => {
      const s = n.side;
      const construction = (i: number): boolean => n.values[i] !== 0 && valueRole(n.values[i]!) === C.wall;
      for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) {
        const i = (x * s + z) * s + y;
        out[i] = n.values[i] === 0 ? ASSEMBLY_CLASS.empty : construction(i) && construction(i + 2 * s * s) ? ASSEMBLY_CLASS.beam : ASSEMBLY_CLASS.wall;
      }
    };
    const short: AssemblyRuleSet = { id: 'short', version: 1, radius: 1, resolve };
    const s = createWorldStore(g16);
    randomAssemblyWorld(s, 1, 24);
    const found = ruleRadiusMismatches(s, short, cube);
    expect(found.length).toBeGreaterThan(0);
    // Wrong classes only where the job's apron ends: the reach cells just past the chunk's high x face.
    for (const m of found) expect(m.lx).toBe(16);
    // The same rule declared honestly passes.
    expect(ruleRadiusMismatches(s, { ...short, radius: 2 }, cube)).toEqual([]);
  });
});

describe('dependency radius and invalidation', () => {
  /** Derived bytes of every chunk in a window. */
  function deriveWindow(s: PaletteStore, win: Array<[number, number, number]>): Map<string, Uint8Array> {
    return new Map(win.map(([x, y, z]) => [`${x},${y},${z}`, encodeDerived(deriveFromStore(s, x, y, z, PLACEHOLDER_RULES))]));
  }

  function windowOf(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]);
    return out;
  }

  /** Applies an edit, re-derives only the chunks within the job radius of it, and checks the whole window equals a fresh derive. */
  function editAndCheck(s: PaletteStore, cache: Map<string, Uint8Array>, win: Array<[number, number, number]>, cmd: VoxelEditCommand, box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): Set<string> {
    applyEdit({ store: () => s }, cmd);
    const deps = new Set(dependentChunks(grid, box, R).map((c) => `${c.cx},${c.cy},${c.cz}`));
    const changed = new Set<string>();
    for (const key of deps) {
      if (!cache.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const now = encodeDerived(deriveFromStore(s, x, y, z, PLACEHOLDER_RULES));
      if (crc32(now) !== crc32(cache.get(key)!)) changed.add(key);
      cache.set(key, now);
    }
    const fresh = deriveWindow(s, win);
    for (const [key, bytes] of fresh) expect(crc32(cache.get(key)!), `chunk ${key} after ${JSON.stringify(cmd)}`).toBe(crc32(bytes));
    return changed;
  }

  it('rebuilds exactly the 8 chunks around an edit at a chunk corner; a banister in the neighbouring chunk becomes a wall', () => {
    const s = createWorldStore(grid);
    // Ground below y = −3, a slab on it at z −6 … −1, a banister along its z = −1 edge (posts at y = −2, rail at
    // y = −1) across the chunk boundary x = 0, just under the boundary y = 0.
    ground(s, -40, 40, -40, 40, 3, -3);
    for (let x = -6; x < 6; x++) for (let z = -6; z < 0; z++) put(s, x, -3, z, MAT.plank, C.wall);
    for (let x = -6; x < 6; x++) {
      if ((x & 1) === 0) put(s, x, -2, -1, MAT.timber, C.wall);
      put(s, x, -1, -1, MAT.timber, C.wall);
    }
    expect(classAt(s, -1, -1, -1) & CLASS_MASK).toBe(ASSEMBLY_CLASS.rail);
    expect(classAt(s, 0, -1, -1) & CLASS_MASK).toBe(ASSEMBLY_CLASS.rail);
    const win = windowOf(-2, 1, -2, 1, -2, 1);
    const cache = deriveWindow(s, win);
    // Two cells on the rail at the corner where 8 chunks meet.
    const box = { minX: -1, minY: 0, minZ: -1, maxX: 0, maxY: 0, maxZ: -1 };
    const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-1, 0, -1], max: [0, 0, -1], mode: 'place', voxel: { material: MAT.timber, role: C.wall, wetness: 0 } });
    expect(dependentChunks(grid, box, R).length).toBe(8);
    const changed = editAndCheck(s, cache, win, cmd, box);
    // The rail cells under the edit, in the chunks below and below-west of it, are walls now.
    expect(classAt(s, -1, -1, -1)).toBe(ASSEMBLY_CLASS.wall);
    expect(classAt(s, 0, -1, -1)).toBe(ASSEMBLY_CLASS.wall);
    expect(changed.has('0,-1,-1')).toBe(true);
    expect(changed.has('-1,-1,-1')).toBe(true);
    expect(changed.has('0,0,-1')).toBe(true);
  }, 60_000);

  it('reaches the rule radius plus the consumers\' reach: an edit 3 cells below a chunk boundary changes the chunk above', () => {
    const s = createWorldStore(grid);
    ground(s, -40, 40, -40, 40, 3, -4);
    for (let x = -6; x < 6; x++) for (let z = -6; z < 0; z++) put(s, x, -3, z, MAT.plank, C.wall);
    for (let x = -6; x < 6; x++) {
      if ((x & 1) === 0) put(s, x, -2, -1, MAT.timber, C.wall);
      put(s, x, -1, -1, MAT.timber, C.wall);
    }
    expect(classAt(s, 1, -1, -1)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    expect(consumersAt(s, 1, 0, -1).standable).toBe(false);
    const win = windowOf(-1, 0, -1, 0, -1, 0);
    const cache = deriveWindow(s, win);
    // Digging the slab under the rail's gap (y = −3) leaves the rail without support: it is a wall now, so the
    // cell on top of it, in the chunk above y = 0, becomes standable. The edit is 2 cells from the rail (the rules'
    // radius) and the rail 1 cell from that cell (the consumers' reach).
    const box = { minX: 0, minY: -3, minZ: -1, maxX: 2, maxY: -3, maxZ: -1 };
    const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, -3, -1], max: [2, -3, -1], mode: 'dig' });
    expect(dependentChunks(grid, box, R).some((c) => c.cy === 0)).toBe(true);
    expect(dependentChunks(grid, box, R - 1).some((c) => c.cy === 0)).toBe(false);
    const changed = editAndCheck(s, cache, win, cmd, box);
    expect(classAt(s, 1, -1, -1)).toBe(ASSEMBLY_CLASS.wall);
    expect(consumersAt(s, 1, 0, -1).standable).toBe(true);
    expect(changed.has('0,0,-1')).toBe(true);
  });

  it('keeps every derived result in a window current under random edits near chunk boundaries, re-deriving only the dependents', () => {
    const s = createWorldStore(grid);
    ground(s, -40, 40, -40, 40);
    const win = windowOf(-2, 1, -1, 0, -2, 1);
    const cache = deriveWindow(s, win);
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const kinds = [
      { material: MAT.timber, role: C.wall },
      { material: MAT.stone, role: C.wall },
      { material: MAT.grass, role: C.terrain },
      { material: MAT.roofTile, role: C.roof },
    ];
    for (let k = 0; k < 16; k++) {
      // Near the corner at the origin, within ±4 cells of a boundary on each axis.
      const x = rnd(9) - 4;
      const y = rnd(7) - 2;
      const z = rnd(9) - 4;
      const w = rnd(2);
      const h = rnd(3);
      const dig = rnd(5) === 0;
      const voxel = kinds[rnd(kinds.length)]!;
      const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x, y, z], max: [x + w, y + h, z], mode: dig ? 'dig' : 'place', ...(dig ? {} : { voxel: { ...voxel, wetness: 0 } }) });
      editAndCheck(s, cache, win, cmd, { minX: x, minY: y, minZ: z, maxX: x + w, maxY: y + h, maxZ: z });
    }
  }, 120_000);
});

/** A chunk's derive sections of `edge` (one apron, the worker's path), joined into the chunk's draw. */
function joinedFromStore(store: PaletteStore, cx: number, cy: number, cz: number, edge: number): JoinedChunk {
  const n = E / edge;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), edge, ids);
  return joinSections(E, edge, results.map((r) => r.assembly));
}

/** Counts every triangle edge of the ground surfaces of chunks (-1…0)² of a 96-cell hilly square, by world position. */
function groundEdges(draw: (s: PaletteStore, cx: number, cy: number, cz: number) => SurfaceBuffer): { edges: Map<string, number>; tris: number; surface: number } {
  const s = createWorldStore(grid);
  const world = hillyWorld({ footprint: 96 });
  loadArea(world.grids[0]!, s, -48, -48, 48, 48);
  const edges = new Map<string, number>();
  let tris = 0;
  let surface = 0;
  const b = world.grids[0]!.bounds;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) for (let cy = chunkOf(b.min[1]); cy <= chunkOf(b.max[1]); cy++) {
    const g = draw(s, cx, cy, cz);
    if (g.vertexCount === 0) continue;
    surface++;
    const view = new DataView(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength);
    const st = POSITION_STEPS_PER_CELL;
    const pos = (v: number): string => [0, 1, 2].map((a) => view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * a, true) - st + [cx, cy, cz][a]! * E * st).join(',');
    for (let t = 0; t < g.indices.length; t += 3) {
      tris++;
      for (let k = 0; k < 3; k++) {
        const a = pos(g.indices[t + k]!);
        const c = pos(g.indices[t + ((k + 1) % 3)]!);
        const key2 = a < c ? `${a}|${c}` : `${c}|${a}`;
        edges.set(key2, (edges.get(key2) ?? 0) + 1);
      }
    }
  }
  return { edges, tris, surface };
}

/** Inside the 2 × 2 chunk window (away from its outer border) every edge has exactly two triangles; returns the inner and the seam edges (`faces`: planes the seams lie on, in cells). */
function expectNoCracks(edges: Map<string, number>, faces: readonly number[]): { inner: number; seam: number } {
  const lo = -E * POSITION_STEPS_PER_CELL + 2 * POSITION_STEPS_PER_CELL;
  const hi = E * POSITION_STEPS_PER_CELL - 2 * POSITION_STEPS_PER_CELL;
  let inner = 0;
  let seam = 0;
  const near = (v: number): boolean => faces.some((f) => Math.abs(v - f * POSITION_STEPS_PER_CELL) < POSITION_STEPS_PER_CELL);
  for (const [key, n] of edges) {
    const pts = key.split('|').map((p) => p.split(',').map(Number));
    if (!pts.every((p) => p[0]! > lo && p[0]! < hi && p[2]! > lo && p[2]! < hi)) continue;
    inner++;
    if (pts.some((p) => near(p[0]!) || near(p[2]!))) seam++;
    expect(n, `edge ${key}`).toBe(2);
  }
  return { inner, seam };
}

describe('meshes', () => {
  it('ground surfaces of neighbouring chunks meet without cracks or doubled triangles', () => {
    const { edges, tris, surface } = groundEdges((s, cx, cy, cz) => deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES).ground);
    expect(surface).toBeGreaterThanOrEqual(4);
    expect(tris).toBeGreaterThan(1000);
    const { inner, seam } = expectNoCracks(edges, [0]);
    expect(inner).toBeGreaterThan(1000);
    expect(seam).toBeGreaterThan(50);
  });

  it('joins a chunk\'s 16³ and 8³ sections into the whole-chunk derive\'s triangles, instances and shader grid; joined chunks meet without cracks', () => {
    const hilly = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 96 }).grids[0]!, hilly, -48, -48, 48, 48);
    const town = createWorldStore(grid);
    const tw = townWorld({ footprint: 128 });
    loadArea(tw.grids[0]!, town, 0, 0, 128, 128);
    const scene = wallBeamBanister();
    const cases: Array<[string, PaletteStore, number, number, number, number, number, number]> = [
      ['hilly', hilly, -1, 0, -2, 1, -1, 0],
      ['town', town, 0, 3, -1, 1, 0, 3],
      ['scene', scene, -1, 0, -1, 0, -1, 0],
    ];
    for (const edge of [16, 8]) {
      const seen = { chunks: 0, ground: 0, base: 0, instances: 0, grids: 0, extraVertices: 0, vertices: 0 };
      for (const [name, store, x0, x1, y0, y1, z0, z1] of cases) {
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
          const whole = deriveFromStore(store, cx, cy, cz, PLACEHOLDER_RULES);
          const joined = joinedFromStore(store, cx, cy, cz, edge);
          const at = `${name} ${edge}³ chunk (${cx}, ${cy}, ${cz})`;
          expect(joined.ground.indices.length, at).toBe(whole.ground.indices.length);
          expect(joined.base.indices.length, at).toBe(whole.base.indices.length);
          expect(triangleList(joined.ground), at).toEqual(triangleList(whole.ground));
          expect(triangleList(joined.base), at).toEqual(triangleList(whole.base));
          expect(joined.instances.count, at).toBe(whole.instances.count);
          expect(instanceList(joined.instances), at).toEqual(instanceList(whole.instances));
          expect(Buffer.from(encodeShader(joined.shader)).equals(Buffer.from(encodeShader(whole.shader))), `${at} shader grid`).toBe(true);
          seen.chunks++;
          if (whole.ground.indices.length > 0) seen.ground++;
          if (whole.base.indices.length > 0) seen.base++;
          if (whole.instances.count > 0) seen.instances++;
          if (whole.shader.width > 0) seen.grids++;
          seen.vertices += whole.ground.vertexCount + whole.base.vertexCount;
          seen.extraVertices += joined.ground.vertexCount + joined.base.vertexCount - whole.ground.vertexCount - whole.base.vertexCount;
        }
      }
      expect(seen.ground).toBeGreaterThan(6);
      expect(seen.base).toBeGreaterThan(3);
      expect(seen.instances).toBeGreaterThan(0);
      expect(seen.grids).toBeGreaterThan(6);
      // Unwelded vertices on the faces between sections: more vertices, never fewer, and a minority.
      expect(seen.extraVertices).toBeGreaterThan(0);
      expect(seen.extraVertices).toBeLessThan(seen.vertices);
      // The 45.6 seam check on joined chunks: every edge inside the window, across section and chunk faces, has two triangles.
      const { edges, tris, surface } = groundEdges((s, cx, cy, cz) => joinedFromStore(s, cx, cy, cz, edge).ground);
      expect(surface).toBeGreaterThanOrEqual(4);
      expect(tris).toBeGreaterThan(1000);
      const faces = Array.from({ length: (2 * E) / edge + 1 }, (_, k) => -E + k * edge);
      const { inner, seam } = expectNoCracks(edges, faces);
      expect(inner).toBeGreaterThan(1000);
      expect(seam).toBeGreaterThan(100);
    }
  }, 60_000);

  it('marks clearance that continues into the chunk above', () => {
    const s = createWorldStore(grid);
    // A floor two cells below the chunk top: its standable cells see 2 free cells, then the chunk ends.
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) put(s, x, E - 3, z, MAT.stone, C.wall);
    const d = deriveFromStore(s, 0, 0, 0, PLACEHOLDER_RULES);
    const k = d.nav.standable.indexOf(li(1, E - 2, 1));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(d.nav.clearance[k]).toBe(2 | NAV_CLEARANCE_CONTINUES);
  });
});

describe('voxel mips', () => {
  it('downsamples 8 children: mean density, dominant material, its role', () => {
    const kids: Array<DenseChunk | null> = [];
    for (let o = 0; o < 8; o++) kids.push(o === 7 ? null : createDenseChunk(grid));
    const c0 = kids[0]!;
    const set = (c: DenseChunk, x: number, y: number, z: number, m: number, cat: number, shape: number): void => {
      const i = (x * E + z) * E + y;
      c.material[i] = m;
      c.role[i] = cat;
      c.shape[i] = shape;
    };
    // Parent cell (0, 0, 0): 3 stone cells (full), 2 grass cells (half full), 3 air.
    set(c0, 0, 0, 0, MAT.stone, C.wall, 15);
    set(c0, 1, 0, 0, MAT.stone, C.wall, 15);
    set(c0, 0, 1, 0, MAT.stone, C.wall, 15);
    set(c0, 1, 1, 0, MAT.grass, C.terrain, 8);
    set(c0, 0, 0, 1, MAT.grass, C.terrain, 8);
    // Parent cell (1, 0, 0): one grass cell nearly empty: the mean rounds to 0, air.
    set(c0, 2, 0, 0, MAT.grass, C.terrain, 3);
    const out = createDenseChunk(grid);
    expect(downsampleMip(grid, kids, out)).toBe(true);
    expect(out.material[0]).toBe(MAT.stone);
    expect(out.role[0]).toBe(C.wall);
    expect(out.shape[0]).toBe(Math.round((3 * 15 + 2 * 8) / 8));
    expect(out.material[(1 * E + 0) * E + 0]).toBe(0);
    expect(downsampleMip(grid, Array<DenseChunk | null>(8).fill(null), out)).toBe(false);
  });

  it('marks every ancestor of an edited chunk stale, and rebuilding those equals rebuilding the whole tree', () => {
    const s = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 256 }).grids[0]!, s, -64, -64, 64, 64);
    const maxLevel = 2;
    const nodeData = (store: PaletteStore, n: MipNode, tree: Map<string, DenseChunk | null>): DenseChunk | null => {
      if (n.level === 0) {
        const c = createDenseChunk(grid);
        return store.exportChunk(n.nx, n.ny, n.nz, c) ? c : null;
      }
      return tree.get(mipNodeKey(n)) ?? null;
    };
    const build = (store: PaletteStore, n: MipNode, tree: Map<string, DenseChunk | null>): void => {
      const out = createDenseChunk(grid);
      tree.set(mipNodeKey(n), downsampleMip(grid, mipChildren(n).map((c) => nodeData(store, c, tree)), out) ? out : null);
    };
    const nodes = (level: number): MipNode[] => {
      const out: MipNode[] = [];
      const span = 1 << level;
      for (let x = -4 / span; x < 4 / span; x++) for (let z = -4 / span; z < 4 / span; z++) for (let y = -8 / span; y < 8 / span; y++) out.push({ level, nx: x, ny: y, nz: z });
      return out;
    };
    const tree = new Map<string, DenseChunk | null>();
    for (let l = 1; l <= maxLevel; l++) for (const n of nodes(l)) build(s, n, tree);
    // Dig a pit through the corner chunk (−1, 0, −1) … and the chunk below it.
    applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-12, -20, -12], max: [-2, 30, -2], mode: 'dig' }));
    const stale = new MipStaleSet(maxLevel);
    const changed: Array<{ cx: number; cy: number; cz: number }> = [];
    for (let cy = -1; cy <= 0; cy++) changed.push({ cx: -1, cy, cz: -1 });
    stale.markChanged(changed);
    expect(stale.nodes().map(mipNodeKey)).toEqual(['1:-1,-1,-1', '1:-1,0,-1', '2:-1,-1,-1', '2:-1,0,-1']);
    expect(mipNodeOf(-1, 0, -1, 2)).toEqual({ level: 2, nx: -1, ny: 0, nz: -1 });
    for (const n of stale.nodes()) {
      build(s, n, tree);
      stale.rebuilt(n);
    }
    expect(stale.size).toBe(0);
    const fresh = new Map<string, DenseChunk | null>();
    for (let l = 1; l <= maxLevel; l++) for (const n of nodes(l)) build(s, n, fresh);
    let differ = 0;
    for (const [key, f] of fresh) {
      const t = tree.get(key) ?? null;
      expect(t === null, key).toBe(f === null);
      if (t !== null && f !== null) expect(sameDenseChunk(t, f), key).toBe(true);
      if (key.startsWith('1:-1,0,-1')) differ++;
    }
    expect(differ).toBe(1);
  });

  it('keeps solid/empty/mixed flags of every chunk-tree node from the derived chunks, stale ancestors refreshed after an edit', () => {
    const s = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 256 }).grids[0]!, s, -64, -64, 64, 64);
    const maxLevel = 2;
    const chunks: Array<{ cx: number; cy: number; cz: number }> = [];
    // Two level-1 nodes across, seven high: their chunks are all here (level 2 also sees chunks never loaded: empty).
    for (let cx = 0; cx < 2; cx++) for (let cz = 0; cz < 2; cz++) for (let cy = -6; cy < 8; cy++) chunks.push({ cx, cy, cz });
    const flags = new ChunkTreeFlags(maxLevel);
    const derive = (c: { cx: number; cy: number; cz: number }): void => flags.setChunk(c.cx, c.cy, c.cz, deriveFromStore(s, c.cx, c.cy, c.cz, PLACEHOLDER_RULES).occupancy.flag);
    for (const c of chunks) derive(c);
    /** Every node's flag recomputed from scratch from fresh derives (what the tree must agree with). */
    const fresh = (): Map<string, number> => {
      const out = new Map<string, number>();
      for (const c of chunks) out.set(mipNodeKey(mipNodeOf(c.cx, c.cy, c.cz, 0)), deriveFromStore(s, c.cx, c.cy, c.cz, PLACEHOLDER_RULES).occupancy.flag);
      for (let l = 1; l <= maxLevel; l++) {
        const level = new Map(chunks.map((c) => mipNodeOf(c.cx, c.cy, c.cz, l)).map((n) => [mipNodeKey(n), n]));
        for (const [key, n] of level) {
          const kids = mipChildren(n).map((k) => out.get(mipNodeKey(k)) ?? OCCUPANCY.empty);
          out.set(key, kids.every((f) => f === OCCUPANCY.empty) ? OCCUPANCY.empty : kids.every((f) => f === OCCUPANCY.solid) ? OCCUPANCY.solid : OCCUPANCY.mixed);
        }
      }
      return out;
    };
    const agree = (): void => {
      for (const [key, f] of fresh()) {
        const [l, xyz] = key.split(':') as [string, string];
        const [nx, ny, nz] = xyz.split(',').map(Number) as [number, number, number];
        expect(flags.flagOf({ level: Number(l), nx, ny, nz }), key).toBe(f);
      }
    };
    agree();
    // The hilly ground gives all three: sky above, rock deep down, the surface between.
    const level0 = new Set(chunks.map((c) => flags.flagOf(mipNodeOf(c.cx, c.cy, c.cz, 0))));
    expect(level0).toEqual(new Set([OCCUPANCY.empty, OCCUPANCY.solid, OCCUPANCY.mixed]));
    const deep = chunks.find((c) => c.cy < 0 && flags.flagOf(mipNodeOf(c.cx, c.cy, c.cz, 1)) === OCCUPANCY.solid)!;
    expect(deep).toBeDefined();
    // Dig a cave into the solid node: its chunks and every ancestor go mixed; only the edit's dependents are derived again.
    const x = deep.cx * E + 8;
    const y = deep.cy * E + 8;
    const z = deep.cz * E + 8;
    const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x, y, z], max: [x + 3, y + 3, z + 3], mode: 'dig' });
    applyEdit({ store: () => s }, cmd);
    for (const c of dependentChunks(grid, editBounds(grid, cmd), R)) derive(c);
    expect(flags.staleNodes().map(mipNodeKey)).toEqual([mipNodeKey(mipNodeOf(deep.cx, deep.cy, deep.cz, 1)), mipNodeKey(mipNodeOf(deep.cx, deep.cy, deep.cz, 2))]);
    const changed = flags.refresh().map(mipNodeKey);
    expect(changed).toContain(mipNodeKey(mipNodeOf(deep.cx, deep.cy, deep.cz, 1)));
    expect(flags.staleNodes()).toEqual([]);
    expect(flags.flagOf(mipNodeOf(deep.cx, deep.cy, deep.cz, 1))).toBe(OCCUPANCY.mixed);
    agree();
    // Filling it back gives the solid node again; an unchanged flag marks nothing stale.
    applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x, y, z], max: [x + 3, y + 3, z + 3], mode: 'place', voxel: { material: s.voxelAt(x - 1, y, z, { material: 0, role: 0, shape: 0, wetness: 0 }).material, role: VOXEL_ROLE.terrain, wetness: 0 } }));
    for (const c of dependentChunks(grid, editBounds(grid, cmd), R)) derive(c);
    expect(flags.flagOf(mipNodeOf(deep.cx, deep.cy, deep.cz, 1))).toBe(OCCUPANCY.solid);
    agree();
    flags.setChunk(deep.cx, deep.cy, deep.cz, OCCUPANCY.solid);
    expect(flags.staleNodes()).toEqual([]);
    expect(() => flags.setChunk(0, 0, 0, 3)).toThrow(RangeError);
  }, 60_000);
});

describe('prop lighting-occupancy channel', () => {
  it('voxelizes a turned prop by coverage, combines overlaps as 1 − (1 − a)(1 − b), and joins the construction light', () => {
    expect(combineCoverage(0, 200)).toBe(200);
    expect(combineCoverage(128, 128)).toBe(255 - Math.round((127 * 127) / 255));
    expect(combineCoverage(255, 10)).toBe(255);
    // A 2 × 1 × 1 m box (half extents 1, 0.5, 0.5) turned 30° at (3.1, 1, 3.3) m in chunk (0, 0, 0).
    const box = { inside: (x: number, y: number, z: number): boolean => Math.abs(x) <= 1 && Math.abs(y) <= 0.5 && Math.abs(z) <= 0.5, min: [-1, -0.5, -0.5] as const, max: [1, 0.5, 0.5] as const, position: [3.1, 1, 3.3] as const, yaw: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] as const, scale: 1 };
    const one = propCoverageChunk(grid, 0, 0, 0, [box], 0.5)!;
    let volume = 0;
    let full = 0;
    let partial = 0;
    for (const c of one) {
      volume += (c / 255) * 0.125;
      if (c === 255) full++;
      else if (c > 0) partial++;
    }
    expect(volume).toBeGreaterThan(2 * 0.97);
    expect(volume).toBeLessThan(2 * 1.03);
    expect(full).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(full);
    expect(propCoverageChunk(grid, 1, 0, 0, [box], 0.5)).toBeNull();
    const two = propCoverageChunk(grid, 0, 0, 0, [box, box], 0.5)!;
    for (let i = 0; i < one.length; i++) expect(two[i]).toBe(combineCoverage(one[i]!, one[i]!));
    // Joined with a rail's coverage in the same chunk.
    const s = wallBeamBanister();
    const d = derivedAt(s, 1, 2, 7);
    const props = new Uint8Array(grid.cellsPerChunk);
    props[li(1, 2, 7)] = 128;
    expect(lightCoverage(grid, d.light, props)[li(1, 2, 7)]).toBe(combineCoverage(LIGHT_COVERAGE.rail, 128));
  });
});

describe('mesh format v2 and shader data', () => {
  /** A derived chunk's bytes without its shader data: what every consumer but the surface shader receives. */
  const withoutShader = (d: DerivedData): number => crc32(encodeDerived({ ...d, shader: { side: 0, palette: new Uint16Array(1), width: 0, ids: new Uint32Array(0) } }));

  it('meshes, instances and collision carry no material: a material and wetness paint changes only the shader data, within its border', () => {
    const s = createWorldStore(grid);
    const world = hillyWorld({ footprint: 96 });
    loadArea(world.grids[0]!, s, -48, -48, 48, 48);
    applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-3, 0, -6], max: [2, 60, -5], mode: 'place', voxel: { material: MAT.stone, role: C.wall, wetness: 0 } }));
    const b = world.grids[0]!.bounds;
    const chunks: Array<[number, number, number]> = [];
    for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) for (let cy = chunkOf(b.min[1]); cy <= chunkOf(60); cy++) chunks.push([cx, cy, cz]);
    const before = chunks.map(([cx, cy, cz]) => deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES));
    let vertices = 0;
    let boxes = 0;
    for (const d of before) {
      for (const surf of [d.ground, d.base]) {
        expect(surf.vertices.byteLength).toBe(surf.vertexCount * SURFACE_VERTEX_BYTES);
        vertices += surf.vertexCount;
      }
      boxes += d.collision.boxes.length / 6;
    }
    expect(SURFACE_VERTEX_BYTES).toBe(12);
    expect(vertices).toBeGreaterThan(1000);
    expect(boxes).toBeGreaterThan(0);
    // The wall and the ground under one corner, painted: new materials and wetness, roles and shapes kept.
    const wall = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-3, 0, -6], max: [2, 60, -5], mode: 'paint', voxel: { material: MAT.brick, role: C.wall, wetness: 6 } });
    const soil = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-4, b.min[1], 2], max: [3, -1, 9], mode: 'paint', voxel: { material: MAT.sand, role: C.terrain, wetness: 3 } });
    for (const cmd of [wall, soil]) {
      const out = applyEdit({ store: () => s }, cmd);
      expect(out.cells).toBeGreaterThan(0);
      expect(out.fields & ~(PLANE_BIT.material | PLANE_BIT.wetness)).toBe(0);
    }
    const near = new Set<string>();
    for (const box of [editBounds(grid, wall), editBounds(grid, soil)]) for (const c of dependentChunks(grid, box, SHADER_BORDER_CELLS)) near.add(`${c.cx},${c.cy},${c.cz}`);
    let shaderChanged = 0;
    chunks.forEach(([cx, cy, cz], k) => {
      const after = deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES);
      const key = `${cx},${cy},${cz}`;
      expect(withoutShader(after), key).toBe(withoutShader(before[k]!));
      if (crc32(encodeDerived(after)) !== crc32(encodeDerived(before[k]!))) {
        shaderChanged++;
        expect(near.has(key), `shader data of ${key} changed outside the border`).toBe(true);
      }
    });
    expect(shaderChanged).toBeGreaterThanOrEqual(4);
  });

  it("a chunk's shader grid holds its cells and a border of its neighbours' cells, so blends cross chunk faces", () => {
    const s = createWorldStore(grid);
    const world = hillyWorld({ footprint: 96 });
    loadArea(world.grids[0]!, s, -48, -48, 48, 48);
    applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-2, 0, -2], max: [1, 40, 1], mode: 'paint', voxel: { material: MAT.gravel, role: C.terrain, wetness: 7 } }));
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    let checked = 0;
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, 0], [-1, 0, 0]] as const) {
      const sh = deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES).shader;
      expect(sh.side).toBe(E + 2 * SHADER_BORDER_CELLS);
      for (let gx = 0; gx < sh.side; gx++) for (let gz = 0; gz < sh.side; gz++) for (let gy = 0; gy < sh.side; gy++) {
        s.voxelAt(cx * E + gx - SHADER_BORDER_CELLS, cy * E + gy - SHADER_BORDER_CELLS, cz * E + gz - SHADER_BORDER_CELLS, v);
        if (shaderEntryAt(sh, (gx * sh.side + gz) * sh.side + gy) !== shaderEntry(v.material, v.wetness)) throw new Error(`chunk ${cx},${cy},${cz} grid cell ${gx},${gy},${gz}`);
        checked++;
      }
    }
    expect(checked).toBe(3 * (E + 2) ** 3);
  });
});
