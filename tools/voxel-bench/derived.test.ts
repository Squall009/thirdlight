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
  cellOutputs,
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
  deriveWithApron,
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
  lightCoverage,
  lightCoverageAt,
  mipCellMetres,
  mipChildren,
  MIP_ROLE_PRIORITY,
  deriveMipNode,
  MipTree,
  mipNodeKey,
  mipNodeOf,
  MipStaleSet,
  NAV_CLEARANCE_CONTINUES,
  OCCUPANCY,
  levelDrawsPieces,
  PLACEHOLDER_RULES,
  RULE_CONFORMANCE_EXTRA_PAD,
  CASE_REACH,
  caseIndexOf,
  cropNeighbourhood,
  EDGE_CASE_CATALOGUE,
  evaluateCases,
  evaluateForms,
  classForm,
  EDGE_RULES,
  levelHasCases,
  NO_CASE,
  sectionLocalOrigin,
  TERRAIN_MESHER_REACH,
  terrainSurface,
  WORLD_RULES,
  POSITION_STEPS_PER_CELL,
  registeredAssemblyRules,
  ruleRadiusMismatches,
  propCoverageChunk,
  PROP_COVERAGE_PART,
  PropLightChannel,
  type PropShape,
  RUN_X,
  RUN_Z,
  sameDenseChunk,
  streamJobHandlers,
  shaderEntry,
  shaderEntryAt,
  SHADER_BORDER_CELLS,
  SURFACE_VERTEX_BYTES,
  TERRAIN_FEATURE,
  TERRAIN_RULES,
  terrainFeatureOf,
  VOXEL_ROLE,
  valueRole,
  voxel,
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
import { beforeAll, describe, expect, it } from 'vitest';
import { bodiesOnly, bodySurface, coverage, exposedFaces, naiveOpenSegments, openSegments, tJunctions, weldBase } from './base-cases';
import { loadArea, zstdDecompress } from './regions';
import { instanceList, triangleList } from './mesh-compare';
import { houseVoxel, townWorld, type House } from './town';
import { FEATURE_GROUND, FEATURE_PAD, featureCases, featuresStore } from './features';
import { dabDetailRoles, flatGround, placeWallBeamBanister, putVoxel, randomAssemblyWorld, randomTerrainWorld } from './scenes';
import { MAT } from './world-kit';
import { hillyWorld } from './worlds';
import { featureSpecs, measurePatch, type SeamResult } from './lod-seams';

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

/** The resolved class bytes of one chunk of a store under a rule set, by local cell (the evaluation a derive runs). */
function classesOfChunk(store: PaletteStore, rules: AssemblyRuleSet, cx: number, cy: number, cz: number): (lx: number, ly: number, lz: number) => number {
  const g = store.grid;
  const pad = jobRadius(rules);
  const n = createNeighbourhood(g.edge, pad);
  const dense = createDenseChunk(g);
  const has = store.exportChunk(cx, cy, cz, dense);
  fillNeighbourhood(n, g, has ? dense : null, buildApron(store, cx, cy, cz, pad));
  const out = new Uint8Array(n.values.length);
  evaluateAssembly(n, rules, out);
  return (lx, ly, lz) => out[((lx + pad) * n.side + (lz + pad)) * n.side + (ly + pad)]!;
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
  it('resolves the same construction cells as wall, beam or rail by their neighbours, and every consumer draws them all as plain voxels', () => {
    const s = wallBeamBanister();
    expect(classAt(s, 0, 4, 0)).toBe(ASSEMBLY_CLASS.wall);
    expect(classAt(s, 0, 5, -1)).toBe(ASSEMBLY_CLASS.beam | RUN_X);
    expect(classAt(s, 1, 2, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    expect(classAt(s, 0, 1, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X | RUN_Z);
    expect(classAt(s, 0, 0, 5)).toBe(ASSEMBLY_CLASS.wall);

    // Beams and banisters left the voxel world: the classes stay, every consumer gets a whole voxel, no piece.
    const plain = { light: 255, navBlocks: true, collision: 'full', instance: null, renderSolid: true };
    expect(consumersAt(s, 0, 4, 0)).toMatchObject(plain);
    expect(consumersAt(s, 0, 5, -1)).toMatchObject(plain);
    expect(consumersAt(s, 1, 2, 7)).toMatchObject(plain);
    expect(consumersAt(s, 0, 1, 7)).toMatchObject(plain);
    // Standing: on top of the wall and of the rail (a whole voxel); the slab under the banister holds standable cells.
    expect(consumersAt(s, 0, 8, 0).standable).toBe(true);
    expect(consumersAt(s, 1, 3, 7).standable).toBe(true);
    expect(consumersAt(s, 1, 1, 6).standable).toBe(true);
    // The rail cell is drawn by the base surface: its open faces are there.
    expect(baseFaceTouches(derivedAt(s, 1, 2, 7), 1, 2, 7)).toBe(true);

    // Grow the banister upward: the run is a wall class, the same voxels as before for every consumer.
    for (let x = -4; x < 4; x++) put(s, x, 3, 7, MAT.timber, C.wall);
    expect(classAt(s, 1, 2, 7)).toBe(ASSEMBLY_CLASS.wall);
    expect(consumersAt(s, 0, 2, 7)).toMatchObject(plain);
    expect(consumersAt(s, 0, 4, 7).standable).toBe(true);
  });

  it('draws the beam, rail and post cells as the bodies they are at every level: no piece, the same consumers whatever the level', () => {
    const s = wallBeamBanister();
    // The same cells derived as a chunk (level 0) and as nodes of levels 1 and 2: only the level differs.
    const at = (x: number, y: number, z: number, level: number): DerivedData => {
      const [cx, cy, cz] = [chunkOf(x), chunkOf(y), chunkOf(z)];
      return deriveWithApron(grid, PLACEHOLDER_RULES, buildApron(s, cx, cy, cz, R), (out) => s.exportChunk(cx, cy, cz, out), undefined, level);
    };
    expect([0, 1, 2, 5].map(levelDrawsPieces)).toEqual([true, false, false, false]);
    for (const [x, y, z] of [[0, 5, -1], [1, 2, 7], [0, 1, 7]] as const) {
      const outs = [0, 1, 2].map((level) => cellOutputs(at(x, y, z, level), local(x), local(y), local(z)));
      const name = `cell ${x},${y},${z}`;
      expect(outs[0]!.piece, name).toBeNull();
      expect(outs[0]!.baseFaces, name).toBeGreaterThan(0);
      for (const o of outs.slice(1)) expect(o, name).toEqual(outs[0]);
    }
    for (const [cx, cy, cz] of [[0, 0, -1], [0, 0, 0], [-1, 0, 0]] as const) {
      const [d0, d1, d2] = [0, 1, 2].map((level) => at(cx * E, cy * E, cz * E, level)) as [DerivedData, DerivedData, DerivedData];
      for (const d of [d0, d1, d2]) expect(d.instances.count).toBe(0);
      expect(d1.base).toEqual(d0.base);
      expect(d2.base).toEqual(d0.base);
      expect(d1.collision).toEqual(d0.collision);
    }
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

  // Each registered rule set (the terrain rules, the world rules with their case and edge passes, and any set registered later)
  // resolves every cell the consumers read the same, class and case, with the job's apron (radius + reach) as with 3
  // cells more, on random worlds at both chunk edges (16: every face of a 32³ chunk's 16³ sections is a chunk face):
  // the assembly arrangements and random terrain (cliffs, risers, slopes with partial fills, ledges, one-cell walls
  // and spikes, caves), each with every detail role dabbed in.
  it.each(registeredAssemblyRules().map((r) => [r.id, r] as const))('%s reads no further than its declared radius', (_id, rules) => {
    for (const [g, seeds] of [[g16, [1, 2, 3]], [grid, [4]]] as const) {
      for (const seed of seeds) {
        for (const [kind, world] of [['assembly', randomAssemblyWorld], ['terrain', randomTerrainWorld]] as const) {
          const s = createWorldStore(g);
          world(s, seed, 24);
          dabDetailRoles(s, seed);
          const chunks = g.edge === 16 ? cube : [-1, 0].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0].map((cz) => ({ cx, cy, cz }))));
          expect(ruleRadiusMismatches(s, rules, chunks), `${kind} world, edge ${g.edge}, seed ${seed}`).toEqual([]);
        }
      }
    }
  });

  it('meets every ground feature in the random terrain it is checked on', () => {
    // The conformance check above only proves the rules it reaches: every feature class must occur in its worlds.
    const seen = new Map<number, number>();
    for (const seed of [1, 2, 3]) {
      const s = createWorldStore(g16);
      randomTerrainWorld(s, seed, 24);
      for (const c of cube) {
        const at = classesOfChunk(s, TERRAIN_RULES, c.cx, c.cy, c.cz);
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
          const f = terrainFeatureOf(at(x, y, z));
          seen.set(f, (seen.get(f) ?? 0) + 1);
        }
      }
    }
    for (const [name, f] of Object.entries(TERRAIN_FEATURE)) expect(seen.get(f) ?? 0, name).toBeGreaterThan(0);
    // A cell's feature does not depend on how the world is cut: 16³ and 32³ evaluations agree everywhere.
    const s16 = createWorldStore(g16);
    const s32 = createWorldStore(grid);
    randomTerrainWorld(s16, 1, 24);
    randomTerrainWorld(s32, 1, 24);
    const at32 = new Map<string, (lx: number, ly: number, lz: number) => number>();
    for (const cx of [-1, 0]) for (const cy of [-1, 0]) for (const cz of [-1, 0]) at32.set(`${cx},${cy},${cz}`, classesOfChunk(s32, TERRAIN_RULES, cx, cy, cz));
    let differ = 0;
    for (const c of cube) {
      const at16 = classesOfChunk(s16, TERRAIN_RULES, c.cx, c.cy, c.cz);
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
        const [wx, wy, wz] = [c.cx * 16 + x, c.cy * 16 + y, c.cz * 16 + z];
        if (at16(x, y, z) !== at32.get(`${wx >> 5},${wy >> 5},${wz >> 5}`)!(wx & 31, wy & 31, wz & 31)) differ++;
      }
    }
    expect(differ).toBe(0);
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
    // A case pass reading 3 cells along x under a set declaring 2 is caught the same way, as a case.
    const far: AssemblyRuleSet = {
      ...EDGE_RULES,
      id: 'far',
      resolveCases(n, lo, hi, _level, out) {
        const ss = n.side;
        for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) {
          const i = (x * ss + z) * ss + y;
          out[i] = n.values[i + 3 * ss * ss] !== 0 ? 8 : NO_CASE;
        }
        return 0;
      },
    };
    const caseMisses = ruleRadiusMismatches(s, far, cube);
    expect(caseMisses.length).toBeGreaterThan(0);
    for (const m of caseMisses) expect([m.part, m.lx]).toEqual(['case', 16]);
    // An edge pass reading past the job's apron along x is caught too, as edge pieces of the chunk's own cells.
    const reach = jobRadius(EDGE_RULES) + 1;
    const farEdges: AssemblyRuleSet = {
      ...EDGE_RULES,
      id: 'far-edges',
      resolveEdges(n, lo, hi, _level, out) {
        const ss = n.side;
        for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) {
          const i = (x * ss + z) * ss + y;
          out.pieces[i] = n.values[i + reach * ss * ss] !== 0 ? 1 : 0;
          out.inner[i] = 0;
        }
        return 0;
      },
    };
    const edgeMisses = ruleRadiusMismatches(s, farEdges, cube);
    expect(edgeMisses.length).toBeGreaterThan(0);
    for (const m of edgeMisses) expect([m.part, m.lx]).toEqual(['edge', 15]);
  });
});

describe('the terrain rule set', () => {
  let built: PaletteStore | null = null;
  // The hard-case row (5 s to build) only when these tests run, not when the file is collected.
  beforeAll(() => {
    built = featuresStore();
  }, 60_000);
  const features = (): PaletteStore => built!;
  const cases = new Map(featureCases().map((c) => [c.name, c.x0]));
  const chunks = new Map<string, (lx: number, ly: number, lz: number) => number>();
  /** The ground feature of a world cell of the hard-case row (each chunk evaluated once). */
  const featureAt = (x: number, y: number, z: number): number => {
    const key = `${chunkOf(x)},${chunkOf(y)},${chunkOf(z)}`;
    let at = chunks.get(key);
    if (at === undefined) {
      at = classesOfChunk(features(), TERRAIN_RULES, chunkOf(x), chunkOf(y), chunkOf(z));
      chunks.set(key, at);
    }
    return terrainFeatureOf(at(local(x), local(y), local(z)));
  };
  const F = TERRAIN_FEATURE;
  const name = (f: number): string => Object.entries(F).find(([, v]) => v === f)?.[0] ?? String(f);
  /** Every exposed ground cell's feature in the columns x0 + [u0, u1) × [w0, w1) that `keep` accepts, by name. */
  function featuresIn(caseName: string, u0: number, u1: number, w0: number, w1: number, keep: (u: number, w: number) => boolean = () => true): Map<string, number> {
    const x0 = cases.get(caseName)!;
    const out = new Map<string, number>();
    for (let u = u0; u < u1; u++) for (let w = w0; w < w1; w++) {
      if (!keep(u, w)) continue;
      for (let y = 0; y < 60; y++) {
        const f = featureAt(x0 + u, y, w);
        if (f !== F.none) out.set(name(f), (out.get(name(f)) ?? 0) + 1);
      }
    }
    return out;
  }
  const only = (m: Map<string, number>, feature: string): void => {
    expect([...m.keys()], JSON.stringify([...m])).toEqual([feature]);
    expect(m.get(feature)).toBeGreaterThan(20);
  };
  const G = Math.floor(FEATURE_GROUND);

  it('is registered, one evaluation of the construction rules and the terrain rules, within the placeholder radius', () => {
    expect(registeredAssemblyRules()).toContain(TERRAIN_RULES);
    expect(TERRAIN_RULES.radius).toBe(PLACEHOLDER_RULES.radius);
    expect(jobRadius(TERRAIN_RULES)).toBe(R);
  });

  it('reads gentle slopes as gentle', () => {
    only(featuresIn('slope-1:20', 8, 56, 8, 56), 'gentle');
    only(featuresIn('slope-1:5', 8, 56, 8, 56), 'gentle');
    // The flat ground between the bumps and around the walls too.
    only(featuresIn('wall-1', 8, 24, 8, 56), 'gentle');
  });

  it('reads the 1:1 bank as steep', () => {
    // Columns whose centre is 3.5 cells or more inside the bank's foot and top along its slope.
    const c = Math.SQRT1_2;
    only(featuresIn('bank-1:1', 8, 56, 8, 56, (u, w) => (u + 0.5) * c + (w + 0.5) * c >= 33.5 && (u + 0.5) * c + (w + 0.5) * c <= 42.5), 'steep');
  });

  it("reads the cliff's face and its top edge as cliff", () => {
    const x0 = cases.get('cliff-20m')!;
    for (let z = 8; z < 56; z++) {
      for (let y = G + 3; y < G + 37; y++) expect(name(featureAt(x0 + 28, y, z)), `face y ${y} z ${z}`).toBe('cliff');
      expect(name(featureAt(x0 + 28, G + 39, z)), `top edge z ${z}`).toBe('cliff');
      // The ground at its foot and on top is flat ground, not the cliff.
      expect(name(featureAt(x0 + 27, G - 1, z))).toBe('gentle');
      expect(name(featureAt(x0 + 32, G + 39, z))).toBe('gentle');
    }
  });

  it('reads the top edges of one- and two-cell risers as terrace lips, and only those', () => {
    for (const [caseName, every, rise, risers] of [['terraces-1', 6, 1, 8], ['terraces-2', 8, 2, 6]] as const) {
      const x0 = cases.get(caseName)!;
      for (let k = 0; k < risers; k++) {
        for (let z = 8; z < 56; z++) {
          expect(name(featureAt(x0 + 8 + every * k, G + rise * (k + 1) - 1, z)), `${caseName} riser ${k} z ${z}`).toBe('terraceLip');
          // The middle of the tread behind it is flat ground.
          expect(name(featureAt(x0 + 8 + every * k + every / 2, G + rise * (k + 1) - 1, z)), `${caseName} tread ${k} z ${z}`).toBe('gentle');
        }
      }
      expect(featuresIn(caseName, 4, 8 + every * risers - 1, 8, 56).get('terraceLip'), caseName).toBe(risers * 48);
    }
  });

  it('reads the ledge front and the cave mouth as overhang, the ceilings under cover as cave roof', () => {
    const ledge = cases.get('overhang')!;
    const cave = cases.get('cave')!;
    for (let z = 8; z < 56; z++) {
      // The ledge's underside (y = G + 11) within reach of its front at x0 + 22 is an overhang; further in, nothing
      // within reach tells it from a ceiling.
      for (const u of [22, 23]) expect(name(featureAt(ledge + u, G + 11, z)), `ledge ${u} z ${z}`).toBe('overhang');
      for (let u = 25; u < 32; u++) expect(name(featureAt(ledge + u, G + 11, z)), `ledge ${u} z ${z}`).toBe('caveRoof');
    }
    for (let z = 30; z < 35; z++) {
      for (let u = 16; u < 40; u++) expect(name(featureAt(cave + u, G + 8, z)), `cave ceiling ${u} z ${z}`).toBe('caveRoof');
      expect(name(featureAt(cave + 12, G + 8, z)), `cave mouth z ${z}`).toBe('overhang');
    }
  });

  it('reads the one-cell wall as thin and the one-cell column as spike', () => {
    const wall = cases.get('wall-1')!;
    for (let z = 16; z < 48; z++) for (let y = G; y < 15; y++) expect(name(featureAt(wall + 32, y, z)), `wall y ${y} z ${z}`).toBe('thin');
    const spike = cases.get('spike-1')!;
    for (let y = G; y < 18; y++) expect(name(featureAt(spike + 32, y, 32)), `spike y ${y}`).toBe('spike');
  });

  it('changes no derived output but the ground surface: consumers read the class, the mesher the creases', () => {
    // Every output but the ground derives to the placeholder rules' bytes; the ground differs only where the rules
    // set a crease (the placeholder rules set none, so the mesher places those cubes as plain nets).
    const strip = (d: DerivedData): DerivedData => ({ ...d, rules: { id: '', version: 0, radius: 0 }, ground: { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) } });
    let differ = 0;
    // The surface chunks of every case (each pad's near half on z, where every case crosses).
    for (let cx = 0; cx < (FEATURE_PAD * featureCases().length) / E; cx++) for (const [cy, cz] of [[0, 0], [1, 0]] as const) {
      const a = deriveFromStore(features(), cx, cy, cz, TERRAIN_RULES);
      expect(a.rules).toEqual({ id: 'terrain', version: 1, radius: 2 });
      const b = deriveFromStore(features(), cx, cy, cz, PLACEHOLDER_RULES);
      expect(encodeDerived(strip(a)), `chunk ${cx},${cy},${cz}`).toEqual(encodeDerived(strip(b)));
      expect(a.counts).toEqual(b.counts);
      if (triangleList(a.ground).join() !== triangleList(b.ground).join()) differ++;
    }
    expect(differ).toBeGreaterThan(0);
    const s = createWorldStore(grid);
    randomTerrainWorld(s, 5, 24);
    randomAssemblyWorld(s, 6, 24);
    for (const cx of [-1, 0]) for (const cy of [-1, 0]) for (const cz of [-1, 0]) {
      expect(encodeDerived(strip(deriveFromStore(s, cx, cy, cz, TERRAIN_RULES)))).toEqual(encodeDerived(strip(deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES))));
    }
  }, 30_000);
});

describe('the world rule set\'s case pass', () => {
  const KR = jobRadius(EDGE_RULES);

  /** A chunk's job neighbourhood under the world rules, its classes and its cases at `level` (the evaluation a derive runs). */
  function kitJob(store: PaletteStore, cx: number, cy: number, cz: number, level = 0): { n: ReturnType<typeof createNeighbourhood>; classes: Uint8Array; cases: Uint16Array; count: number } {
    const g = store.grid;
    const n = createNeighbourhood(g.edge, KR);
    const dense = createDenseChunk(g);
    fillNeighbourhood(n, g, store.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(store, cx, cy, cz, KR));
    const classes = new Uint8Array(n.values.length);
    evaluateAssembly(n, EDGE_RULES, classes);
    const cases = new Uint16Array(n.values.length);
    const count = evaluateCases(n, EDGE_RULES, level, cases);
    return { n, classes, cases, count };
  }

  /** A random assembly world with every detail role dabbed in, and random terrain under its own seed. */
  function mixedWorld(g: ReturnType<typeof chunkGrid>, seed: number): PaletteStore {
    const s = createWorldStore(g);
    randomTerrainWorld(s, seed + 10, 24);
    randomAssemblyWorld(s, seed, 24);
    dabDetailRoles(s, seed);
    return s;
  }

  it('composes the terrain rules, the case pass and the edge pass in one evaluation, radius 2, the job apron still 3; the world derives with it; no window case anywhere (no window rules)', () => {
    expect(WORLD_RULES).toBe(EDGE_RULES);
    expect({ id: EDGE_RULES.id, version: EDGE_RULES.version, radius: EDGE_RULES.radius }).toEqual({ id: 'edges', version: 7, radius: 2 });
    expect(registeredAssemblyRules().map((r) => r.id).sort()).toEqual(['edges', 'placeholder', 'terrain']);
    expect(EDGE_RULES.radius).toBe(Math.max(TERRAIN_RULES.radius, CASE_REACH));
    expect(jobRadius(EDGE_RULES)).toBe(3);
    // The classes are the terrain rules' (one class byte a cell); only the world rules give cases.
    const s = mixedWorld(grid, 7);
    for (const [cx, cy, cz] of [[-1, -1, -1], [0, 0, 0], [-1, 0, 0]] as const) {
      const job = kitJob(s, cx, cy, cz);
      expect(job.count).toBe(0);
      const terrain = new Uint8Array(job.n.values.length);
      evaluateAssembly(job.n, TERRAIN_RULES, terrain);
      expect(job.classes).toEqual(terrain);
      const none = new Uint16Array(job.n.values.length);
      expect(evaluateCases(job.n, TERRAIN_RULES, 0, none)).toBe(0);
      const side = job.n.side;
      for (let x = KR - 1; x < KR + E + 1; x++) for (let z = KR - 1; z < KR + E + 1; z++) for (let y = KR - 1; y < KR + E + 1; y++) expect(none[(x * side + z) * side + y]).toBe(NO_CASE);
    }
  });

  it('resolves cases at level 0 only (where pieces are drawn), and the edge catalogue gives no cell one: beams and rails are plain voxels', () => {
    expect([0, 1, 2, 3].map(levelHasCases)).toEqual([true, false, false, false]);
    expect([0, 1, 2, 3].map(levelDrawsPieces)).toEqual([true, false, false, false]);
    const s = wallBeamBanister();
    let beams = 0;
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      for (const level of [0, 1, 2]) {
        const job = kitJob(s, cx, cy, cz, level);
        expect(job.count).toBe(0);
        const side = job.n.side;
        for (let x = KR - 1; x < KR + E + 1; x++) for (let z = KR - 1; z < KR + E + 1; z++) for (let y = KR - 1; y < KR + E + 1; y++) {
          const i = (x * side + z) * side + y;
          expect(job.cases[i]).toBe(NO_CASE);
          if (level === 0 && (job.classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.beam) beams++;
        }
      }
    }
    expect(beams).toBeGreaterThan(0);
  });

  it('changes derived outputs but the instances only through the cases\' forms: a chunk whose cells all keep their class\'s form, its sections, and every level-2 node derive to the terrain rules\' bytes but for their pieces', () => {
    // The edge pass adds pieces only (instances); everything else differs from the terrain rules' only through forms.
    const strip = (d: DerivedData): DerivedData => ({ ...d, rules: { id: '', version: 0, radius: 0 }, instances: { count: 0, data: new Uint8Array(0) } as DerivedData['instances'] });
    const bytes = (d: DerivedData): Uint8Array => encodeDerived(strip(d));
    const town = createWorldStore(grid);
    loadArea(townWorld({ footprint: 128 }).grids[0]!, town, 0, 0, 128, 128);
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['scene', wallBeamBanister(), [[-1, -1, -1], [-1, 0, -1], [0, 0, 0], [-1, 0, 0]]],
      ['town', town, [[0, 0, 0], [1, 0, 1], [2, 1, 2], [3, 0, 1], [1, 1, 3]]],
      ['mixed', mixedWorld(grid, 3), [[-1, -1, -1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]]],
      ['features', featuresStore(), [[6, 0, 0], [7, 0, 0], [8, 1, 0]]],
    ];
    const seen = { same: 0, changed: 0 };
    for (const [name, store, chunks] of stores) {
      const tree = new MipTree(store);
      for (const [cx, cy, cz] of chunks) {
        const a = deriveFromStore(store, cx, cy, cz, EDGE_RULES);
        expect(a.rules).toEqual({ id: 'edges', version: 7, radius: 2 });
        // Does any cell the consumers read take another form from its case than from its class?
        const job = kitJob(store, cx, cy, cz);
        const forms = new Uint8Array(job.n.values.length);
        evaluateForms(job.n, EDGE_RULES, job.classes, job.cases, forms);
        let differs = false;
        const side = job.n.side;
        for (let x = KR - 1; x < KR + E + 1 && !differs; x++) for (let z = KR - 1; z < KR + E + 1 && !differs; z++) for (let y = KR - 1; y < KR + E + 1; y++) {
          const i = (x * side + z) * side + y;
          if (forms[i] !== classForm(job.classes[i]!)) {
            differs = true;
            break;
          }
        }
        const at = `${name} chunk ${cx},${cy},${cz}`;
        if (differs) {
          seen.changed++;
          continue;
        }
        seen.same++;
        expect(bytes(a), at).toEqual(bytes(deriveFromStore(store, cx, cy, cz, TERRAIN_RULES)));
        const ids = Array.from({ length: 8 }, (_, i) => i);
        const ks = deriveSectionsWithApron(grid, EDGE_RULES, buildApron(store, cx, cy, cz, KR), (out) => store.exportChunk(cx, cy, cz, out), 16, ids);
        const ts = deriveSectionsWithApron(grid, TERRAIN_RULES, buildApron(store, cx, cy, cz, KR), (out) => store.exportChunk(cx, cy, cz, out), 16, ids);
        ks.forEach((r, k) => expect(bytes(r.assembly!), `${at} section ${k}`).toEqual(bytes(ts[k]!.assembly!)));
      }
      // Level 2 resolves no case: every node is the terrain rules' (level 1's cases are checked against their forms in case-forms.test.ts).
      for (const [cx, cy, cz] of chunks) {
        const node: MipNode = { level: 2, nx: cx >> 2, ny: cy >> 2, nz: cz >> 2 };
        expect(bytes(deriveMipNode(tree, node, EDGE_RULES)), `${name} level 2 node ${node.nx},${node.ny},${node.nz}`).toEqual(bytes(deriveMipNode(tree, node, TERRAIN_RULES)));
      }
    }
    // Only a damaged cell (a hole) takes another form than its class's: every other chunk is the terrain rules' bytes.
    expect(seen.same).toBeGreaterThan(10);
  }, 60_000);

  it('joins a chunk\'s 16³ and 8³ sections into the whole chunk\'s case grid, cell for cell (the reach margin included)', () => {
    const town = createWorldStore(grid);
    loadArea(townWorld({ footprint: 128 }).grids[0]!, town, 0, 0, 128, 128);
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['scene', wallBeamBanister(), [[-1, 0, -1], [0, 0, 0]]],
      ['town', town, [[1, 0, 1], [2, 1, 2]]],
      ['mixed', mixedWorld(grid, 5), [[-1, -1, -1], [0, 0, -1]]],
    ];
    let compared = 0;
    let withCase = 0;
    for (const [name, store, chunks] of stores) {
      for (const [cx, cy, cz] of chunks) {
        const whole = kitJob(store, cx, cy, cz);
        const fs = whole.n.side;
        for (const edge of [16, 8]) {
          const sub = createNeighbourhood(edge, KR);
          const cases = new Uint16Array(sub.values.length);
          const per = E / edge;
          for (let id = 0; id < per ** 3; id++) {
            const [lx, ly, lz] = sectionLocalOrigin(E, edge, id);
            cropNeighbourhood(whole.n, lx, ly, lz, sub);
            evaluateCases(sub, EDGE_RULES, 0, cases);
            const ss = sub.side;
            for (let x = KR - 1; x < KR + edge + 1; x++) for (let z = KR - 1; z < KR + edge + 1; z++) for (let y = KR - 1; y < KR + edge + 1; y++) {
              const want = whole.cases[((lx + x) * fs + (lz + z)) * fs + (ly + y)]!;
              const got = cases[(x * ss + z) * ss + y]!;
              if (got !== want) expect(got, `${name} chunk ${cx},${cy},${cz} ${edge}³ section ${id} cell ${x - KR},${y - KR},${z - KR}`).toBe(want);
              compared++;
              if (want !== NO_CASE) withCase++;
            }
          }
        }
      }
    }
    // The world catalogue has no window rules: no cell carries a case, in a section as in the whole chunk.
    expect(withCase).toBe(0);
    expect(compared).toBeGreaterThan(100_000);
  }, 60_000);
});

describe('the terrain mesher\'s reach', () => {
  // The mesher reads voxels TERRAIN_MESHER_REACH cells above and below the chunk (the column-lattice window) and
  // classes one cell round it; the job's pad (the rules' radius + the consumers' reach) must cover that, and the
  // invalidation reach is the same pad. Meshing with the job's pad and with 3 cells more must give the same bytes.
  it('is within the job\'s pad: the ground with the job\'s apron equals the ground with a wider one', () => {
    expect(TERRAIN_MESHER_REACH).toBeLessThanOrEqual(jobRadius(WORLD_RULES));
    const g16 = chunkGrid(16);
    let compared = 0;
    for (const [g, seeds] of [[g16, [1, 2, 3]], [grid, [4]]] as const) {
      const pad = jobRadius(WORLD_RULES);
      const wide = pad + RULE_CONFORMANCE_EXTRA_PAD;
      const narrowN = createNeighbourhood(g.edge, pad);
      const wideN = createNeighbourhood(g.edge, wide);
      const narrowOut = new Uint8Array(narrowN.values.length);
      const wideOut = new Uint8Array(wideN.values.length);
      const dense = createDenseChunk(g);
      for (const seed of seeds) {
        const s = createWorldStore(g);
        randomTerrainWorld(s, seed, 24);
        const lo = g.edge === 16 ? -2 : -1;
        for (let cx = lo; cx <= 0; cx++) for (let cy = lo; cy <= 0; cy++) for (let cz = lo; cz <= 0; cz++) {
          const has = s.exportChunk(cx, cy, cz, dense);
          fillNeighbourhood(narrowN, g, has ? dense : null, buildApron(s, cx, cy, cz, pad));
          fillNeighbourhood(wideN, g, has ? dense : null, buildApron(s, cx, cy, cz, wide));
          WORLD_RULES.resolve(narrowN, pad - 1, pad + g.edge + 1, narrowOut);
          WORLD_RULES.resolve(wideN, wide - 1, wide + g.edge + 1, wideOut);
          const a = terrainSurface(narrowN, narrowOut);
          const b = terrainSurface(wideN, wideOut);
          expect(Buffer.from(a.vertices).equals(Buffer.from(b.vertices)) && Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer)), `edge ${g.edge} seed ${seed} chunk ${cx},${cy},${cz}`).toBe(true);
          compared += a.indices.length / 3;
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
    // A pad short of the reach is refused rather than read past.
    const short = createNeighbourhood(16, TERRAIN_MESHER_REACH - 1);
    expect(() => terrainSurface(short, new Uint8Array(short.values.length))).toThrow(/reads 3 cells past/);
  }, 60_000);
});

describe('dependency radius and invalidation', () => {
  /** Derived bytes of every chunk in a window. */
  function deriveWindow(s: PaletteStore, win: Array<[number, number, number]>): Map<string, Uint8Array> {
    return new Map(win.map(([x, y, z]) => [`${x},${y},${z}`, encodeDerived(deriveFromStore(s, x, y, z, TERRAIN_RULES))]));
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
      const now = encodeDerived(deriveFromStore(s, x, y, z, TERRAIN_RULES));
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

  it('reaches the rule radius plus the consumers\' reach: an edit 3 cells below a chunk boundary is a dependency of the chunk above, and the window stays current', () => {
    const s = createWorldStore(grid);
    ground(s, -40, 40, -40, 40, 3, -4);
    for (let x = -6; x < 6; x++) for (let z = -6; z < 0; z++) put(s, x, -3, z, MAT.plank, C.wall);
    for (let x = -6; x < 6; x++) {
      if ((x & 1) === 0) put(s, x, -2, -1, MAT.timber, C.wall);
      put(s, x, -1, -1, MAT.timber, C.wall);
    }
    expect(classAt(s, 1, -1, -1)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    const win = windowOf(-1, 0, -1, 0, -1, 0);
    const cache = deriveWindow(s, win);
    // Digging the slab under the rail's gap (y = −3) leaves the rail without support: its class is a wall now, 2
    // cells from the edit (the rules' radius), and a cell 1 more out (the consumers' reach) is in the chunk above.
    // Beams and rails are plain voxels for every consumer, so this class change shows in no output any more; the
    // dependency bound still names the chunk above, and every chunk of the window stays equal to a fresh derive.
    const box = { minX: 0, minY: -3, minZ: -1, maxX: 2, maxY: -3, maxZ: -1 };
    const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, -3, -1], max: [2, -3, -1], mode: 'dig' });
    expect(dependentChunks(grid, box, R).some((c) => c.cy === 0)).toBe(true);
    expect(dependentChunks(grid, box, R - 1).some((c) => c.cy === 0)).toBe(false);
    editAndCheck(s, cache, win, cmd, box);
    expect(classAt(s, 1, -1, -1)).toBe(ASSEMBLY_CLASS.wall);
    expect(consumersAt(s, 1, 0, -1).standable).toBe(true);
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
  const results = deriveSectionsWithApron(grid, TERRAIN_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), edge, ids);
  return joinSections(E, edge, results.map((r) => r.assembly));
}

/** A chunk's sections joined with their base surfaces' bodies only (the roofs' planes are checked in roof-mesher.test.ts). */
function joinedBodies(store: PaletteStore, cx: number, cy: number, cz: number, edge: number): SurfaceBuffer {
  const n = E / edge;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, TERRAIN_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), edge, ids);
  return joinSections(E, edge, results.map((r) => bodiesOnly(r.assembly))).base;
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
    const { edges, tris, surface } = groundEdges((s, cx, cy, cz) => deriveFromStore(s, cx, cy, cz, TERRAIN_RULES).ground);
    expect(surface).toBeGreaterThanOrEqual(4);
    expect(tris).toBeGreaterThan(1000);
    const { inner, seam } = expectNoCracks(edges, [0]);
    expect(inner).toBeGreaterThan(1000);
    expect(seam).toBeGreaterThan(50);
  });

  it('joins a chunk\'s 16³ and 8³ sections (terrain rules and mesher) into the whole-chunk derive\'s ground triangles, instances and shader grid, and its base faces (merged per section: same faces, no T-junction); joined chunks meet without cracks', () => {
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
      // The cliff and both terrace cases: crease (dual-contouring) vertices on section and chunk faces.
      ['features', featuresStore(), 6, 9, 0, 1, 0, 1],
    ];
    for (const edge of [16, 8]) {
      const seen = { chunks: 0, ground: 0, base: 0, instances: 0, grids: 0, extraVertices: 0, vertices: 0, baseTriangles: 0, baseFaces: 0 };
      for (const [name, store, x0, x1, y0, y1, z0, z1] of cases) {
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
          const whole = deriveFromStore(store, cx, cy, cz, TERRAIN_RULES);
          const joined = joinedFromStore(store, cx, cy, cz, edge);
          const at = `${name} ${edge}³ chunk (${cx}, ${cy}, ${cz})`;
          expect(joined.ground.indices.length, at).toBe(whole.ground.indices.length);
          expect(triangleList(joined.ground), at).toEqual(triangleList(whole.ground));
          // Base faces merge inside a section only, so the triangles differ; both cover every exposed face once.
          const faces = exposedFaces(store, cx, cy, cz);
          const joinedBase = joinedBodies(store, cx, cy, cz, edge);
          for (const [kind, base] of [['joined', joinedBase], ['whole', bodySurface(whole)]] as const) {
            const mesh = weldBase([{ buf: base, cx, cy, cz }]);
            expect(coverage(mesh, faces), `${at} ${kind}`).toEqual({ uncovered: 0, doubled: 0, area: faces.length, faces: faces.length });
            expect(tJunctions(mesh), `${at} ${kind}`).toBe(0);
            expect(openSegments(mesh), `${at} ${kind}`).toEqual(naiveOpenSegments(faces));
          }
          seen.baseTriangles += joinedBase.indices.length / 3;
          seen.baseFaces += faces.length;
          expect(joined.instances.count, at).toBe(whole.instances.count);
          expect(instanceList(joined.instances), at).toEqual(instanceList(whole.instances));
          expect(Buffer.from(encodeShader(joined.shader)).equals(Buffer.from(encodeShader(whole.shader))), `${at} shader grid`).toBe(true);
          seen.chunks++;
          if (whole.ground.indices.length > 0) seen.ground++;
          if (whole.base.indices.length > 0) seen.base++;
          if (whole.instances.count > 0) seen.instances++;
          if (whole.shader.width > 0) seen.grids++;
          seen.vertices += whole.ground.vertexCount;
          seen.extraVertices += joined.ground.vertexCount - whole.ground.vertexCount;
        }
      }
      expect(seen.ground).toBeGreaterThan(6);
      expect(seen.base).toBeGreaterThan(3);
      // No kit here, so no pieces (a kit's pieces joined from sections: kit-pieces.test.ts).
      expect(seen.instances).toBe(0);
      expect(seen.grids).toBeGreaterThan(6);
      // Unwelded vertices on the faces between sections: more vertices, never fewer, and a minority.
      expect(seen.extraVertices).toBeGreaterThan(0);
      expect(seen.extraVertices).toBeLessThan(seen.vertices);
      // Merged base faces: fewer triangles than the naive two a face, even with merges stopping at section faces.
      expect(seen.baseTriangles).toBeLessThan(seen.baseFaces);
      // The crack-free seam check on joined chunks: every edge inside the window, across section and chunk faces, has two triangles.
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
  it('downsamples 8 children: fill the share of solid, role by priority (whole-cell bodies at least half the parent), the material the surface shows', () => {
    const kids: Array<DenseChunk | null> = [];
    for (let o = 0; o < 8; o++) kids.push(o === 7 ? null : createDenseChunk(grid));
    const c0 = kids[0]!;
    const set = (c: DenseChunk, x: number, y: number, z: number, m: number, cat: number, shape: number, wet = 0): void => {
      const i = (x * E + z) * E + y;
      c.material[i] = m;
      c.role[i] = cat;
      c.shape[i] = shape;
      c.wetness[i] = wet;
    };
    /** The 8 child cells of parent cell (px, 0, 0) in child 0, octant order. */
    const cell = (px: number, k: number): [number, number, number] => [2 * px + (k & 1), (k >> 1) & 1, (k >> 2) & 1];
    const fill = (px: number, specs: ReadonlyArray<readonly [number, number, number, number?] | null>): void =>
      specs.forEach((sp, k) => {
        if (sp !== null) set(c0, ...cell(px, k), sp[0], sp[1], sp[2], sp[3] ?? 0);
      });
    // 0: 3 wall cells (under half the parent) and 2 half-full terrain cells: terrain, the share of all 5 solid cells;
    // at the surface (beside air or partly filled) 2 stone and 2 grass cells, so the material of the larger fill (stone).
    fill(0, [[MAT.stone, C.wall, 15], [MAT.stone, C.wall, 15], [MAT.stone, C.wall, 15], [MAT.grass, C.terrain, 8], [MAT.grass, C.terrain, 8], null, null, null]);
    // 1: a one-cell wall's 4 cells (half the parent) beside two full terrain cells: the wall wins by priority and, a
    // construction shape being integrity, the parent is an intact block (15), not the 6 solid cells' share. Beside the two air cells lie 2 grass and 2 stone cells (the other two stone cells lie
    // against the node's side, not read): a tie of cells and of fill, the lower id (grass); wetness from its first cell.
    fill(1, [[MAT.stone, C.wall, 15, 3], [MAT.stone, C.wall, 15], [MAT.grass, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.stone, C.wall, 15], [MAT.stone, C.wall, 15], null, null]);
    // 2: liquid and an opening fill nothing: one full terrain cell among 4 water cells and an opening is ground of 2/15.
    fill(2, [[MAT.grass, C.terrain, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.stone, C.opening, 15], null, null]);
    // 3: water alone: a liquid parent of its share (6 full cells of 8: 11/15).
    fill(3, [[MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], [MAT.water, C.liquid, 15], null, null]);
    // 4: a nearly empty grass cell: the share rounds to 0, air.
    fill(4, [[MAT.grass, C.terrain, 3], null, null, null, null, null, null, null]);
    // 5: a post's two cells (a quarter of the parent) and nothing else: a body under half the parent leaves the level.
    fill(5, [[MAT.stone, C.pillar, 15], null, [MAT.stone, C.pillar, 15], null, null, null, null, null]);
    // 6: a floor slab's 4 cells under a wall's 4: the wall first; the material by the existing rule (a tie: the lower id).
    fill(6, [[MAT.stone, C.floor, 15], [MAT.stone, C.floor, 15], [MAT.brick, C.wall, 15], [MAT.brick, C.wall, 15], [MAT.stone, C.floor, 15], [MAT.stone, C.floor, 15], [MAT.brick, C.wall, 15], [MAT.brick, C.wall, 15]]);
    // 9: a grass skin of one full cell over soil, a partly filled grass cell above it (in the parent above): grass,
    // though soil fills the other half; the parent above (grass partly filled over air) is grass too.
    fill(9, [[MAT.soil, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.grass, C.terrain, 15]]);
    for (let k = 0; k < 8; k++) if (((k >> 1) & 1) === 0) set(c0, 18 + (k & 1), 2, (k >> 2) & 1, MAT.grass, C.terrain, 5);
    // The same ground round it (soil under grass), so only its top lies near the surface.
    for (let x = 17; x < 21; x++) for (let z = 0; z < 3; z++) if (x === 17 || x === 20 || z === 2) for (let y = 0; y < 2; y++) set(c0, x, y, z, y === 0 ? MAT.soil : MAT.grass, C.terrain, 15);
    // 11: the same skin buried in full soil, against the node's bottom and front sides: no cell beside air or a partly
    // filled one, so the cells against the sides (not read there) count, 4 soil and 2 grass: soil.
    fill(11, [[MAT.soil, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.soil, C.terrain, 15], [MAT.grass, C.terrain, 15], [MAT.grass, C.terrain, 15]]);
    for (let x = 21; x < 25; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) if (x === 21 || x === 24 || y >= 2 || z >= 2) set(c0, x, y, z, MAT.soil, C.terrain, 15);
    const out = createDenseChunk(grid);
    expect(downsampleMip(grid, kids, out)).toBe(true);
    const at = (px: number): [number, number, number, number] => {
      const i = (px * E + 0) * E + 0;
      return [out.material[i]!, out.role[i]!, out.shape[i]!, out.wetness[i]!];
    };
    expect(at(0)).toEqual([MAT.stone, C.terrain, Math.round((3 * 15 + 2 * 8) / 8), 0]);
    expect(at(1)).toEqual([MAT.grass, C.wall, 15, 0]);
    expect(at(2)).toEqual([MAT.grass, C.terrain, 2, 0]);
    expect(at(3)).toEqual([MAT.water, C.liquid, Math.round((6 * 15) / 8), 0]);
    expect(at(4)).toEqual([0, 0, 0, 0]);
    expect(at(5)).toEqual([0, 0, 0, 0]);
    expect(at(6)).toEqual([MAT.stone, C.wall, 15, 0]);
    expect(at(9)).toEqual([MAT.grass, C.terrain, 15, 0]);
    expect(out.material[(9 * E + 0) * E + 1]).toBe(MAT.grass);
    expect(at(11)).toEqual([MAT.soil, C.terrain, 15, 0]);
    expect(MIP_ROLE_PRIORITY.indexOf(C.wall)).toBeLessThan(MIP_ROLE_PRIORITY.indexOf(C.floor));
    expect(MIP_ROLE_PRIORITY[MIP_ROLE_PRIORITY.length - 1]).toBe(C.terrain);
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

describe('mip nodes through the same derive', () => {
  let built: PaletteStore | null = null;
  // The hard-case row (5 s to build) only when these tests run.
  beforeAll(() => {
    built = featuresStore();
  }, 60_000);
  const caseNode = (name: string, level: number): MipNode => ({ level, nx: Math.floor(featureCases().find((c) => c.name === name)!.x0 / (E << level)), ny: 0, nz: 0 });

  it('derives a level-L node with the chunk derive (rules, mesher, consumers): the bytes of a chunk holding the node\'s cells, its level recorded', { timeout: 30_000 }, () => {
    const tree = new MipTree(built!);
    // Level 0 through the tree is the chunk derive itself.
    const c0 = deriveMipNode(tree, { level: 0, nx: 6, ny: 0, nz: 0 }, TERRAIN_RULES);
    expect(c0.level).toBe(0);
    expect(encodeDerived(c0)).toEqual(encodeDerived(deriveFromStore(built!, 6, 0, 0, TERRAIN_RULES)));
    let crease = 0;
    for (const n of [caseNode('cliff-20m', 1), caseNode('cave', 1), caseNode('terraces-2', 1), caseNode('overhang', 2), caseNode('arch', 2)]) {
      // The node and its 26 neighbours as chunks of a level-0 store: a derive there sees exactly the node's cells and apron.
      const copy = createWorldStore(grid);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = tree.node({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
        if (k !== null) copy.importChunk(n.nx + dx, n.ny + dy, n.nz + dz, k);
      }
      const node = deriveMipNode(tree, n, TERRAIN_RULES);
      const chunk = deriveFromStore(copy, n.nx, n.ny, n.nz, TERRAIN_RULES);
      const at = mipNodeKey(n);
      expect(node.level, at).toBe(n.level);
      expect(chunk.level, at).toBe(0);
      expect(node.ground.indices.length, at).toBeGreaterThan(0);
      expect(encodeDerived(node), at).toEqual(encodeDerived({ ...chunk, level: n.level }));
      // The canonical bytes carry the level: a node is never taken for a chunk of the same cells.
      expect(crc32(encodeDerived(node)), at).not.toBe(crc32(encodeDerived(chunk)));
      // Crease placement and splits run at coarse levels too (the rules' thresholds are in cells).
      const view = new DataView(node.ground.vertices.buffer, node.ground.vertices.byteOffset, node.ground.vertices.byteLength);
      const seen = new Map<string, string>();
      for (let v = 0; v < node.ground.vertexCount; v++) {
        const o = v * SURFACE_VERTEX_BYTES;
        const pos = `${view.getUint16(o, true)},${view.getUint16(o + 2, true)},${view.getUint16(o + 4, true)}`;
        const nrm = `${view.getInt8(o + 8)},${view.getInt8(o + 9)},${view.getInt8(o + 10)}`;
        if (seen.has(pos) && seen.get(pos) !== nrm) crease++;
        seen.set(pos, nrm);
      }
    }
    expect(crease).toBeGreaterThan(0);
  });

  it('gives a node shader data over its own cells: a 34³ grid of the node and one node cell round it, each cell its downsampled material and wetness', { timeout: 30_000 }, () => {
    const tree = new MipTree(built!);
    for (const n of [caseNode('cave', 1), caseNode('bumps', 2)]) {
      const d = deriveMipNode(tree, n, TERRAIN_RULES);
      const view = tree.level(n.level);
      const side = E + 2 * SHADER_BORDER_CELLS;
      expect(d.shader.side).toBe(side);
      const v = voxel();
      const entries = new Set<number>();
      let i = 0;
      for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) for (let y = 0; y < side; y++, i++) {
        view.voxelAt(n.nx * E + x - SHADER_BORDER_CELLS, n.ny * E + y - SHADER_BORDER_CELLS, n.nz * E + z - SHADER_BORDER_CELLS, v);
        const want = shaderEntry(v.material, v.wetness, v.role);
        if (shaderEntryAt(d.shader, i) !== want) expect(shaderEntryAt(d.shader, i), `${mipNodeKey(n)} grid ${x},${y},${z}`).toBe(want);
        entries.add(want);
      }
      // Grass, soil, rock and air: the blend has neighbours to blend at every level.
      expect(entries.size).toBeGreaterThanOrEqual(3);
    }
    // One scale from a level's cells to metres: the blend distance and positions are converted with it.
    expect([0, 1, 2, 3].map(mipCellMetres)).toEqual([0.5, 1, 2, 4]);
    expect(() => mipCellMetres(-1)).toThrow(RangeError);
  });
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
    // Joined with the construction's coverage in the same chunk: an open cell (the gap between two posts) and a
    // whole voxel (a rail cell, a plain voxel).
    const s = wallBeamBanister();
    const d = derivedAt(s, 1, 2, 7);
    const props = new Uint8Array(grid.cellsPerChunk);
    props[li(1, 2, 7)] = 128;
    props[li(1, 1, 7)] = 128;
    expect(lightCoverage(grid, d.light, props)[li(1, 2, 7)]).toBe(combineCoverage(255, 128));
    expect(lightCoverage(grid, d.light, props)[li(1, 1, 7)]).toBe(combineCoverage(0, 128));
    for (let i = 0; i < props.length; i += 97) expect(lightCoverageAt(d.light, i, props[i]!)).toBe(lightCoverage(grid, d.light, props)[i]);
    expect(lightCoverageAt(d.light, li(1, 1, 7), 128)).toBe(128);
  });

  it('keeps a channel per resident chunk: a move rebuilds only the chunks the prop left and entered, equal to a fresh build, counted as a budget part', () => {
    const parts = new Map<string, number>();
    const built: string[] = [];
    const channel = new PropLightChannel({ grid, setPart: (cx, cy, cz, part, bytes) => (expect(part).toBe(PROP_COVERAGE_PART), parts.set(`${cx},${cy},${cz}`, bytes), true) }, 0.5);
    channel.onBuild = (cx, cy, cz) => built.push(`${cx},${cy},${cz}`);
    const sphere = (r: number, at: readonly [number, number, number]): PropShape => ({ inside: (x, y, z) => x * x + y * y + z * z <= r * r, min: [-r, -r, -r], max: [r, r, r], position: at, yaw: [1, 0], scale: 1 });
    const crate = (at: readonly [number, number, number]): PropShape => ({ inside: (x, y, z) => Math.abs(x) <= 1.3 && Math.abs(y) <= 0.9 && Math.abs(z) <= 0.7, min: [-1.3, -0.9, -0.7], max: [1.3, 0.9, 0.7], position: at, yaw: [Math.cos(0.52), Math.sin(0.52)], scale: 1 });
    // Resident: chunks −2 … 1 on x and z, −1 … 0 on y (16 m chunks).
    const resident: [number, number, number][] = [];
    for (let cx = -2; cx <= 1; cx++) for (let cy = -1; cy <= 0; cy++) for (let cz = -2; cz <= 1; cz++) resident.push([cx, cy, cz]);
    const shapes = new Map<string, PropShape>();
    const fresh = (): void => {
      for (const [cx, cy, cz] of resident) {
        const want = propCoverageChunk(grid, cx, cy, cz, [...shapes.values()], 0.5);
        expect(channel.chunk(cx, cy, cz)).toEqual(want);
        expect(parts.get(`${cx},${cy},${cz}`)).toBe(want?.byteLength ?? 0);
      }
    };
    const place = (id: string, s: PropShape): string[] => {
      built.length = 0;
      shapes.set(id, s);
      channel.place(id, s);
      return [...built].sort();
    };
    // A crate straddling four chunk columns at the origin, placed before anything loads: nothing to build yet.
    expect(place('crate', crate([0.1, 1.3, -0.2]))).toEqual([]);
    for (const [cx, cy, cz] of resident) channel.loaded(cx, cy, cz);
    expect(built.length).toBe(resident.length);
    fresh();
    expect(place('tree', sphere(3, [8.3, 1.1, 8.2]))).toEqual(['0,-1,0', '0,0,0']);
    fresh();
    // The crate moves 20 m along x: rebuilt are the four chunks it left (x −1 and 0) and the two it entered (x 1), no others.
    expect(place('crate', crate([20.1, 1.3, -0.2]))).toEqual(['-1,0,-1', '-1,0,0', '0,0,-1', '0,0,0', '1,0,-1', '1,0,0']);
    fresh();
    // Out of the resident chunks: those it left are rebuilt; the rest wait for their loads.
    expect(place('crate', crate([40.1, 1.3, -0.2]))).toEqual(['1,0,-1', '1,0,0']);
    fresh();
    // Overlapping props combine; removing one rebuilds its chunks without it.
    expect(place('tree2', sphere(3, [9.1, 1.6, 8.0]))).toEqual(['0,-1,0', '0,0,0']);
    fresh();
    built.length = 0;
    channel.remove('tree2');
    shapes.delete('tree2');
    expect([...built].sort()).toEqual(['0,-1,0', '0,0,0']);
    fresh();
    // A refreshed chunk keeps its channel; an unloaded one loses it and gets it back on its next load.
    built.length = 0;
    channel.loaded(0, 0, 0);
    expect(built).toEqual([]);
    channel.unloaded(0, 0, 0);
    expect(channel.chunk(0, 0, 0)).toBeUndefined();
    expect(channel.at(16, 2, 16)).toBe(0);
    channel.loaded(0, 0, 0);
    fresh();
    expect(channel.at(16, 2, 16)).toBeGreaterThan(0);
    expect(channel.at(16, 2, 16)).toBe(channel.chunk(0, 0, 0)![(((16 << 5) | 16) << 5) | 2]);

    // Costs: a 3 m canopy moved 0.25 m at a time across chunk faces (its chunks rebuilt each move), and the bytes.
    for (let i = 0; i < 200; i++) channel.place('tree', sphere(3, [8.3 + 0.25 * (i % 40), 1.1, 8.2 + 0.25 * (i % 40)]));
    const us = channel.changeUs;
    const st = channel.stats();
    console.log(`prop move (3 m sphere, 1–4 chunks rebuilt): p50 ${us.quantile(0.5).toFixed(0)} µs, p95 ${us.quantile(0.95).toFixed(0)} µs; channel: ${st.chunks} chunks, ${st.covered} covered, ${st.bytes} B`);
    expect(st.bytes).toBe(st.covered * grid.cellsPerChunk);
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
        if (shaderEntryAt(sh, (gx * sh.side + gz) * sh.side + gy) !== shaderEntry(v.material, v.wetness, v.role)) throw new Error(`chunk ${cx},${cy},${cz} grid cell ${gx},${gy},${gz}`);
        checked++;
      }
    }
    expect(checked).toBe(3 * (E + 2) ** 3);
  });
});

describe('seams between levels: the coarser node\'s transition strip (lod-seam.ts) on two-level patches', () => {
  // Every fourth ray of the bench's grid (`run.mjs seams` runs them all, the worlds too).
  const patches = [...featureSpecs(0, ['cliff-20m', 'cave', 'wall-1', 'overhang'], 4), ...featureSpecs(1, ['cliff-20m', 'cave', 'hole-1'], 4)];

  it('closes every hard-case patch across L0 | L1 and L1 | L2, as the measured pick does', { timeout: 120_000 }, () => {
    for (const spec of patches) {
      const r = measurePatch(spec, ['none', 'transition+flaps', 'seam']);
      const at = `${spec.name} ${r.levels}`;
      const by = (c: string): SeamResult => r.results.find((x) => x.candidate === c)!;
      expect(r.controlMisses, at).toEqual([0, 0]);
      expect(by('none').crackRays, at).toBeGreaterThan(0);
      // The bench's pick lets no ray through on these cases (`lod-seams.ts`, transition+flaps); the package's seam must not either.
      expect(by('transition+flaps').crackRays, at).toBe(0);
      expect(by('seam').crackRays, at).toBe(0);
      expect(by('seam').addedTriangles, at).toBeGreaterThan(0);
    }
  });
});
