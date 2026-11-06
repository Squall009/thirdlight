/**
 * Instances carry kit pieces, through the real derive with the world's edge
 * rule set: the piece table built from kits as slots (material → kit by the
 * test binding, a kit-local piece a filled slot, an empty slot nothing), the
 * project's piece seed and each kit's jitter; the instance's piece, turns,
 * placement and variant word (the mesh pick; still 8 bytes, a cell owning
 * one instance an edge, corner or roof edge); picks that stay put under
 * unrelated edits and whichever unit derives a cell, the same under one
 * seed and others under another; no kit, no pieces; and the pieces per level
 * (in chunks only, none in coarser nodes).
 */
import {
  buildApron,
  buildPieceTable,
  CUBE_ROTATION_X90,
  materialSwap,
  NO_KIT,
  PIECE_JITTER_DEFAULT,
  PIECE_TABLE_FORMAT,
  pieceTableKitChanges,
  worldPieceTable,
  chunkGrid,
  createWorldStore,
  deriveFromStore,
  deriveMipNode,
  deriveSectionsWithApron,
  EDGE_RULES,
  encodeDerived,
  INSTANCE_BYTES,
  INSTANCE_FLAG,
  jobRadius,
  kitPieceList,
  MipTree,
  NO_PIECE,
  PIECE_VARIANT_MASK,
  PIECE_VARIANT_MIRROR,
  pieceTableChanges,
  readPieceTable,
  tablePiece,
  voxel,
  type DerivedData,
  type PaletteStore,
  type PieceKitSource,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { loadArea } from './regions';
import { placeWallBeamBanister, putVoxel } from './scenes';
import { BUILDING_MATERIALS, fullTestKit, weightedVariants } from './test-kits';
import { townWorld } from './town';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
/** The world's rule set and catalogue: the edge rules. */
const RULES = EDGE_RULES;
const CAT = RULES.catalogue!;
const caseIndex = (id: string): number => CAT.cases.findIndex((c) => c.id === id);

interface Inst {
  piece: number;
  flags: number;
  variant: number;
}

/** An instance's key: its local cell index (x · E + z) · E + y, its turns and placement (the rotation byte's low bits) and its piece. */
const instKey = (cell: number, rotation: number, piece: number): string => `${cell}:${rotation & 0x0f}:${piece}`;
/** The local cell index of an instance key. */
const cellOfKey = (k: string): number => Number(k.split(':')[0]);

/** A derived unit's instances by key ({@link instKey}); no two instances of a unit share one. */
function instancesOf(d: DerivedData): Map<string, Inst> {
  const out = new Map<string, Inst>();
  const e = d.edge;
  const b = d.instances.data;
  expect(b.length).toBe(d.instances.count * INSTANCE_BYTES);
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    const piece = b[o + 4]! | (b[o + 5]! << 8);
    const key = instKey((b[o]! * e + b[o + 2]!) * e + b[o + 1]!, b[o + 3]!, piece);
    expect(out.has(key), `instance ${key} twice`).toBe(false);
    out.set(key, { piece, flags: b[o + 3]!, variant: b[o + 6]! | (b[o + 7]! << 8) });
  }
  return out;
}

function townStore(): PaletteStore {
  const s = createWorldStore(grid);
  loadArea(townWorld({ footprint: 128 }).grids[0]!, s, 0, 0, 128, 128);
  return s;
}

/** The town chunks holding construction (houses stand on y 0 up). */
const TOWN_CHUNKS: Array<[number, number, number]> = [];
for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) for (let cy = 0; cy < 2; cy++) TOWN_CHUNKS.push([cx, cy, cz]);

describe('the piece table', () => {
  it('numbers a kit\'s filled slots in catalogue order; an empty slot, an unbound material and an unknown slot draw nothing; rotations, jitter and the seed are in its bytes', () => {
    const one = { meshes: weightedVariants(1) };
    const kit: PieceKitSource = {
      voxelKitId: 'log',
      materials: [MAT.timber],
      jitter: 2,
      slots: {
        'edge-out-top': one,
        'edge-out-bottom': { meshes: [{ rotation: CUBE_ROTATION_X90 }, { rotation: 0, weight: 3 }] },
        debris: one,
        // Not cases of the catalogue: beams and banisters are no slots.
        beam: one,
        gazebo: one,
      },
    };
    const rival: PieceKitSource = { voxelKitId: 'zz-rival', materials: [MAT.timber, MAT.stone], slots: { 'corner-out-top': one } };
    const list = kitPieceList(kit, CAT);
    // Catalogue case order; unknown slots are problems, never pieces.
    expect(list.pieces.map((p) => p.caseId)).toEqual(['edge-out-top', 'edge-out-bottom', 'debris']);
    expect(list.pieces[1]).toMatchObject({ weights: [1, 3], rotations: [CUBE_ROTATION_X90, 0] });
    expect(list.problems.join('\n')).toMatch(/slot "beam"[\s\S]*slot "gazebo"/);
    const { table, problems } = buildPieceTable([rival, kit], RULES, 99);
    expect(problems.some((p) => p.includes(`material ${MAT.timber}`) && p.includes('log draws it'))).toBe(true);
    const p = (c: string, m: number = MAT.timber): number => tablePiece(table, m, caseIndex(c));
    expect([p('edge-out-top'), p('edge-out-bottom'), p('debris')]).toEqual([0, 1, 2]);
    // An empty slot draws nothing: no stand-in (the heavy debris stage takes no light-stage piece), no fallback.
    for (const c of ['debris-heavy', 'edge-in-top', 'corner-out-top', 'roof-ridge']) expect(p(c), c).toBe(NO_PIECE);
    // The rival kit kept stone; plank is bound by no kit.
    expect(p('corner-out-top', MAT.stone)).toBe(0);
    expect(p('edge-out-top', MAT.plank)).toBe(NO_PIECE);
    expect(table.materialKit[MAT.plank]).toBe(NO_KIT);
    // Seed and jitter as given (the rival's the default).
    expect(table.seed).toBe(99);
    expect(table.kits.map((k) => [k.id, k.jitter])).toEqual([['log', 2], ['zz-rival', PIECE_JITTER_DEFAULT]]);
    // Canonical bytes: the kits' order does not matter, a read gives the same table, a newer format is refused.
    expect(buildPieceTable([kit, rival], RULES, 99).table.bytes).toEqual(table.bytes);
    const again = readPieceTable(table.bytes);
    expect(again.hash).toBe(table.hash);
    expect(again.kits.map((k) => k.hash)).toEqual(table.kits.map((k) => k.hash));
    const newer = table.bytes.slice();
    newer[0] = PIECE_TABLE_FORMAT + 1;
    expect(() => readPieceTable(newer)).toThrow(new RegExp(`format ${PIECE_TABLE_FORMAT + 1}`));
    expect(() => readPieceTable(table.bytes.subarray(0, table.bytes.length - 1))).toThrow(RangeError);
    expect(() => buildPieceTable([kit], RULES, -1)).toThrow(/seed/);
    expect(() => buildPieceTable([kit], RULES, 2 ** 32)).toThrow(/seed/);
    // A jitter or rotation out of range is a problem, never a refusal: the default jitter draws.
    const wild = buildPieceTable([{ ...kit, jitter: 9, slots: { 'edge-out-top': { meshes: [{ rotation: 30 }] } } }], RULES, 0);
    expect(wild.problems.join('\n')).toMatch(/jitter 9[\s\S]*rotation 30/);
    expect(wild.table.kits[0]!.jitter).toBe(PIECE_JITTER_DEFAULT);
    // A table names its rule set: a derive refuses a table of other rules.
    expect(() => deriveFromStore(createWorldStore(grid), 0, 0, 0, { ...RULES, version: RULES.version + 1, resolve: RULES.resolve }, undefined, table)).toThrow(/piece table/);
    // Changes by material: a kit's edit (a slot, its jitter) touches its own materials only; the seed every bound one.
    const edited: PieceKitSource = { ...kit, slots: { ...kit.slots, 'roof-ridge': one } };
    expect([...pieceTableChanges(table, buildPieceTable([rival, edited], RULES, 99).table)!]).toEqual([MAT.timber]);
    expect([...pieceTableChanges(table, buildPieceTable([rival, { ...kit, jitter: 1.5 }], RULES, 99).table)!]).toEqual([MAT.timber]);
    expect([...pieceTableChanges(table, buildPieceTable([rival, kit], RULES, 100).table)!].sort((a, b) => a - b)).toEqual([MAT.stone, MAT.timber]);
    expect([...pieceTableChanges(table, null)!].sort((a, b) => a - b)).toEqual([MAT.stone, MAT.timber]);
    expect(pieceTableChanges(table, buildPieceTable([rival, kit], RULES, 99).table)!.size).toBe(0);
  });

  it('with no kit binds no material: a world table of no kits derives what no table derives, and no cell has a piece', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    const t = worldPieceTable([], 5);
    expect(t.kits).toEqual([]);
    expect(t.materialKit.every((k) => k === NO_KIT)).toBe(true);
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = deriveFromStore(s, cx, cy, cz, RULES);
      expect(plain.instances.count).toBe(0);
      expect(encodeDerived(deriveFromStore(s, cx, cy, cz, RULES, undefined, t))).toEqual(encodeDerived(plain));
    }
    // A kit bound to timber only: the stone wall's edges stay plain (no piece on stone).
    const log = worldPieceTable([fullTestKit('log', [MAT.timber], 2)], 5);
    const v = voxel();
    let timber = 0;
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const d = deriveFromStore(s, cx, cy, cz, RULES, undefined, log);
      for (const [k] of instancesOf(d)) {
        const i = cellOfKey(k);
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        expect(s.voxelAt(cx * E + lx, cy * E + ly, cz * E + lz, v).material).toBe(MAT.timber);
        timber++;
      }
    }
    expect(timber).toBeGreaterThan(10);
    // Painting between two unbound materials changes no kit; onto the log kit's, it does.
    expect(pieceTableKitChanges(log, [materialSwap(MAT.stone, MAT.plank)])).toBe(false);
    expect(pieceTableKitChanges(log, [materialSwap(MAT.stone, MAT.timber)])).toBe(true);
  });
});

describe('instances carry kit pieces', () => {
  it('gives each edge its material\'s kit piece (kit-local index, turns, mesh pick), never a piece on a flat face, beams and banisters plain voxels; still 8 bytes an instance', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    // Timber (the former beam, rail and posts) and stone (the wall) bound; the plank slab is not.
    const { table } = buildPieceTable([fullTestKit('log', [MAT.timber, MAT.stone], 3)], RULES, 0);
    const unbound = buildPieceTable([fullTestKit('nothing', [])], RULES, 0).table;
    const v = voxel();
    const seen = { kit: 0, mirrored: 0, variants: new Set<number>() };
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = deriveFromStore(s, cx, cy, cz, RULES);
      // A table binding no material derives what no table derives, byte for byte: no piece at all.
      expect(encodeDerived(deriveFromStore(s, cx, cy, cz, RULES, undefined, unbound))).toEqual(encodeDerived(plain));
      expect(plain.instances.count).toBe(0);
      const d = deriveFromStore(s, cx, cy, cz, RULES, undefined, table);
      for (const [k, inst] of instancesOf(d)) {
        const i = cellOfKey(k);
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        const mat = s.voxelAt(cx * E + lx, cy * E + ly, cz * E + lz, v).material;
        expect(INSTANCE_BYTES).toBe(8);
        seen.kit++;
        expect([MAT.timber, MAT.stone]).toContain(mat);
        expect(inst.variant & PIECE_VARIANT_MASK).toBeLessThan(3);
        seen.variants.add(inst.variant & PIECE_VARIANT_MASK);
        // No damage here: nothing replaces a cell's base (beams and rails are plain voxels, drawn by the base surface).
        expect(inst.flags & INSTANCE_FLAG.replacesBase).toBe(0);
        // An edge piece's cell shows: one of its six neighbours is open.
        const open = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => s.voxelAt(cx * E + lx + dx!, cy * E + ly + dy!, cz * E + lz + dz!, v).material === 0);
        expect(open, `edge piece at ${lx},${ly},${lz}`).toBe(true);
        if ((inst.variant & PIECE_VARIANT_MIRROR) !== 0) seen.mirrored++;
      }
    }
    expect(seen.kit).toBeGreaterThan(50);
    expect(seen.variants.size).toBe(3);
    // The former beam cell: a plain voxel whose edges carry pieces (its base drawn, nothing replacing it).
    const beamCell = (0 * E + 31) * E + 5;
    const beam = [...instancesOf(deriveFromStore(s, 0, 0, -1, RULES, undefined, table))].filter(([k]) => cellOfKey(k) === beamCell);
    expect(beam.length).toBeGreaterThan(1);
    expect(beam.every(([, x]) => (x.flags & INSTANCE_FLAG.replacesBase) === 0)).toBe(true);
  });

  it('keeps every surviving piece\'s mesh pick after a dig elsewhere, gives a cell the same pieces and picks whichever unit derives it, the same under one seed and others under another', () => {
    const s = townStore();
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 4)], RULES, 0);
    // The town chunk with the most kit pieces.
    let best: [number, number, number] = TOWN_CHUNKS[0]!;
    let most = -1;
    for (const c of TOWN_CHUNKS) {
      const n = deriveFromStore(s, ...c, RULES, undefined, table).instances.count;
      if (n > most) [best, most] = [c, n];
    }
    const [cx, cy, cz] = best;
    const before = instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, table));
    expect(new Set([...before.values()].map((x) => x.variant & PIECE_VARIANT_MASK)).size).toBe(4);
    // The project seed decides the picks: the same seed gives the same ones on every derive, another seed others
    // (the same pieces in the same places, about three in four picked otherwise with four equally weighted meshes).
    expect(instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 4)], RULES, 0).table))).toEqual(before);
    const reseeded = instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 4)], RULES, 12345).table));
    expect([...reseeded.keys()].sort()).toEqual([...before.keys()].sort());
    const repicked = [...before].filter(([k, x]) => reseeded.get(k)!.variant !== x.variant).length;
    expect(repicked).toBeGreaterThan(before.size / 2);
    // A cell's several pieces vary on their own (the hash reads which piece it is): some cell shows two variants.
    const byCell = new Map<number, Set<number>>();
    for (const [k, x] of before) {
      const c = cellOfKey(k);
      if (!byCell.has(c)) byCell.set(c, new Set());
      byCell.get(c)!.add(x.variant & PIECE_VARIANT_MASK);
    }
    expect([...byCell.values()].some((v) => v.size > 1)).toBe(true);
    // 16³ sections, each from its own origin, give the chunk's pieces and variants cell for cell.
    const pad = jobRadius(RULES);
    const sections = deriveSectionsWithApron(grid, RULES, buildApron(s, cx, cy, cz, pad), (out) => s.exportChunk(cx, cy, cz, out), 16, [0, 1, 2, 3, 4, 5, 6, 7], 0, { table, chunk: [cx, cy, cz] });
    const joined = new Map<string, Inst>();
    for (const r of sections) {
      const [ox, oy, oz] = [(r.id >> 2) & 1, r.id & 1, (r.id >> 1) & 1].map((b) => b * 16) as [number, number, number];
      for (const [k, inst] of instancesOf(r.assembly!)) {
        const i = cellOfKey(k);
        const cell = ((Math.floor(i / 256) + ox) * E + (Math.floor(i / 16) % 16) + oz) * E + (i % 16) + oy;
        joined.set(instKey(cell, inst.flags, inst.piece), inst);
      }
    }
    expect(joined).toEqual(before);
    // Dig a 3³ hole into an edge piece's cell of the chunk: only cells within the job's reach can change at all.
    const [hole] = [...before].filter(([, x]) => (x.flags & INSTANCE_FLAG.replacesBase) === 0).map(([k]) => cellOfKey(k));
    const [hx, hz, hy] = [Math.floor(hole! / (E * E)), Math.floor(hole! / E) % E, hole! % E];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) putVoxel(s, cx * E + hx + dx, cy * E + hy + dy, cz * E + hz + dz, 0, 0);
    const after = instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, table));
    let far = 0;
    let changedNear = 0;
    for (const [k, b] of before) {
      const i = cellOfKey(k);
      const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
      const reach = Math.max(Math.abs(lx - hx), Math.abs(ly - hy), Math.abs(lz - hz));
      const a = after.get(k);
      // A piece that stays (same cell, case, turns and placement) keeps its pick: the hash reads the cell, the piece's place and the seed only.
      if (a !== undefined) expect(a.variant, `cell ${lx},${ly},${lz}`).toBe(b.variant);
      if (reach > 1 + pad + 1) {
        far++;
        expect(a, `cell ${lx},${ly},${lz}`).toEqual(b);
      } else if (a === undefined) changedNear++;
    }
    expect(far).toBeGreaterThan(100);
    expect(changedNear).toBeGreaterThan(0);
  });
});

describe('material and wetness feed the shader data, kits bound', () => {
  it('keeps every output but the shader data under a wetness paint and a material paint within one kit; a paint to another kit changes only the painted cells\' pieces', () => {
    const s = townStore();
    // Timber and plank are one kit, the masonry another: a paint between kits moves cells' pieces, one within a kit none.
    const { table } = buildPieceTable([fullTestKit('wood', [MAT.timber, MAT.plank], 3), fullTestKit('masonry', [MAT.stone, MAT.brick, MAT.plaster, MAT.roofTile], 2)], RULES, 0);
    const v = voxel();
    // The town's west half: enough of every material, half the derive time.
    const chunks = TOWN_CHUNKS.filter(([cx]) => cx < 2);
    const derive = (): DerivedData[] => chunks.map((c) => deriveFromStore(s, ...c, RULES, undefined, table));
    /** The bytes of a result with another's shader data: equal when only the shader data differ. */
    const withShader = (d: DerivedData, from: DerivedData): Uint8Array => encodeDerived({ ...d, shader: from.shader });
    /** Rewrites one field of every cell `pick` takes in the town's construction chunks; returns the cells. */
    const repaint = (pick: (m: number) => boolean, write: (x: number, y: number, z: number) => void, box?: { x1: number; z1: number }): Set<string> => {
      const cells = new Set<string>();
      for (const [cx, cy, cz] of chunks) for (let lx = 0; lx < E; lx++) for (let lz = 0; lz < E; lz++) for (let ly = 0; ly < E; ly++) {
        const [x, y, z] = [cx * E + lx, cy * E + ly, cz * E + lz];
        if (box !== undefined && (x >= box.x1 || z >= box.z1)) continue;
        if (!pick(s.voxelAt(x, y, z, v).material)) continue;
        write(x, y, z);
        cells.add(`${x},${y},${z}`);
      }
      return cells;
    };
    const set = (x: number, y: number, z: number, f: Partial<{ material: number; wetness: number }>): void => {
      s.voxelAt(x, y, z, v);
      s.setVoxel(x, y, z, { material: f.material ?? v.material, role: v.role, shape: v.shape, wetness: f.wetness ?? v.wetness });
    };
    const steps: Array<[string, () => Set<string>]> = [
      ['wetness on every built cell', () => repaint((m) => BUILDING_MATERIALS.includes(m), (x, y, z) => set(x, y, z, { wetness: 5 }))],
      ['timber to plank (one kit)', () => repaint((m) => m === MAT.timber, (x, y, z) => set(x, y, z, { material: MAT.plank }))],
      ['stone to brick (one kit)', () => repaint((m) => m === MAT.stone, (x, y, z) => set(x, y, z, { material: MAT.brick }))],
    ];
    let before = derive();
    for (const [what, step] of steps) {
      expect(step().size, what).toBeGreaterThan(100);
      const after = derive();
      let shaderChanged = 0;
      after.forEach((d, k) => {
        expect(withShader(before[k]!, d), `${what}: chunk ${chunks[k]!.join(',')}`).toEqual(encodeDerived(d));
        if (Buffer.compare(Buffer.from(encodeDerived(before[k]!)), Buffer.from(encodeDerived(d))) !== 0) shaderChanged++;
      });
      expect(shaderChanged, what).toBeGreaterThan(0);
      before = after;
    }
    // Plank to brick in a quarter of it (wood to masonry): pieces change at painted cells only.
    const painted = repaint((m) => m === MAT.plank, (x, y, z) => set(x, y, z, { material: MAT.brick }), { x1: 64, z1: 64 });
    expect(painted.size).toBeGreaterThan(100);
    const after = derive();
    let moved = 0;
    after.forEach((d, k) => {
      const [cx, cy, cz] = chunks[k]!;
      const was = instancesOf(before[k]!);
      const now = instancesOf(d);
      // By cell (the kits number alike, so a cell's pieces keep their keys and the variant tells the kits apart).
      const listed = (m: Map<string, Inst>, i: number): string => JSON.stringify([...m].filter(([k]) => cellOfKey(k) === i));
      for (const i of new Set([...was.keys(), ...now.keys()].map(cellOfKey))) {
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        if (painted.has(`${cx * E + lx},${cy * E + ly},${cz * E + lz}`)) {
          if (listed(was, i) !== listed(now, i)) moved++;
        } else expect(listed(now, i), `cell ${lx},${ly},${lz} of ${cx},${cy},${cz}`).toBe(listed(was, i));
      }
      // Everything but the instances and the shader data stays.
      expect(encodeDerived({ ...before[k]!, shader: d.shader, instances: d.instances })).toEqual(encodeDerived(d));
    });
    expect(moved).toBeGreaterThan(50);
    // Five derives of 16 town chunks and four passes over their cells: past vitest's 5 s default on a loaded host.
  }, 30_000);
});

describe('kit pieces per level', () => {
  it('lists the kit\'s pieces in chunks only: level-1 and level-2 nodes list none, with the kit bound or not (no piece mesh a level; their edges are plain voxel faces)', () => {
    const s = townStore();
    const tree = new MipTree(s);
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 2)], RULES, 0);
    let l0kit = 0;
    for (const [cx, cy, cz] of TOWN_CHUNKS) l0kit += instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, table)).size;
    expect(l0kit).toBeGreaterThan(0);
    for (const [nx, ny, nz] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] as const) {
      for (const node of [{ level: 1, nx, ny, nz }, { level: 2, nx: nx >> 1, ny: ny >> 1, nz: nz >> 1 }]) {
        const withKit = deriveMipNode(tree, node, RULES, undefined, table);
        const plain = deriveMipNode(tree, node, RULES);
        expect(withKit.instances.count, `level ${node.level}`).toBe(0);
        // The kit changes nothing a coarse node draws: its bytes are the plain ones.
        expect(encodeDerived(withKit)).toEqual(encodeDerived(plain));
      }
    }
  });
});
