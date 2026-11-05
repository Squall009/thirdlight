/**
 * Instances carry kit pieces, through the real derive with the world's edge
 * rule set: the piece table built from kits (material → kit by the test
 * binding, kit-local piece indices, the fallback order for a missing case),
 * the instance's piece, turns, placement and variant word (still 8 bytes, a
 * cell owning one instance an edge, corner or roof edge), variants that stay
 * put under unrelated edits and whichever unit derives a cell, and the
 * pieces per level (high in chunks, low in level-1 nodes, none coarser)
 * with no suppressed cell left without a piece.
 */
import {
  buildApron,
  buildPieceTable,
  DEFAULT_KIT_ID,
  DEFAULT_KIT_PIECES,
  DEFAULT_KIT_UNITS,
  defaultKitSource,
  materialSwap,
  NO_KIT,
  PIECE_TABLE_FORMAT,
  pieceTableKitChanges,
  worldPieceTable,
  chunkGrid,
  createWorldStore,
  defaultPiece,
  defaultPieceFamily,
  deriveFromStore,
  deriveMipNode,
  deriveSectionsWithApron,
  EDGE_RULES,
  encodeDerived,
  INSTANCE_BYTES,
  INSTANCE_FLAG,
  jobRadius,
  KIT_PIECE_BASE,
  kitPieceList,
  MipTree,
  NO_PIECE,
  PIECE_FAMILY,
  PIECE_VARIANT_MASK,
  PIECE_VARIANT_MIRROR,
  pieceTableChanges,
  readPieceTable,
  RUN_SECTION,
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
  it('numbers a kit\'s own pieces after the default ones and resolves a missing piece in order: the case\'s body, its single, its stand-in of the same form, then the default or nothing', () => {
    const one = { variants: weightedVariants(1) };
    const kit: PieceKitSource = {
      voxelKitId: 'log',
      materials: [MAT.timber],
      cases: {
        'edge-out-top': { sections: { single: one } },
        beam: { sections: { body: { variants: weightedVariants(2) } } },
        'banister-rail': { sections: { single: one, body: one, end: one, middle: one } },
        debris: { sections: { single: one } },
        gazebo: { sections: { single: one } },
      },
    };
    const rival: PieceKitSource = { voxelKitId: 'zz-rival', materials: [MAT.timber, MAT.stone], cases: { beam: { sections: { body: one } } } };
    const list = kitPieceList(kit, CAT);
    // Catalogue case order, then section order; unknown cases and sections are problems, never pieces.
    expect(list.pieces.map((p) => `${p.caseId}/${p.sectionId}`)).toEqual(['edge-out-top/single', 'debris/single', 'beam/body', 'banister-rail/single', 'banister-rail/body', 'banister-rail/end']);
    expect(list.problems.join('\n')).toMatch(/gazebo[\s\S]*middle/);
    const { table, problems } = buildPieceTable([rival, kit], RULES);
    expect(problems.some((p) => p.includes(`material ${MAT.timber}`) && p.includes('log draws it'))).toBe(true);
    const p = (c: string, s: number, m: number = MAT.timber): number => tablePiece(table, m, caseIndex(c), s);
    const [edgeTop, debris, beamBody, railSingle, railBody, railEnd] = [0, 1, 2, 3, 4, 5].map((k) => KIT_PIECE_BASE + k);
    // The case's own section, else its body, else its single.
    expect(p('banister-rail', RUN_SECTION.end)).toBe(railEnd);
    expect(p('banister-rail', RUN_SECTION.start)).toBe(railBody);
    expect(p('banister-rail', RUN_SECTION.corner)).toBe(railBody);
    expect(railSingle).toBe(p('banister-rail', RUN_SECTION.single));
    expect(p('beam', RUN_SECTION.single)).toBe(beamBody);
    expect(p('beam', RUN_SECTION.junction)).toBe(beamBody);
    expect(p('edge-out-top', RUN_SECTION.single)).toBe(edgeTop);
    // A missing case takes its stand-in (the heavy debris stage the light one's piece) ...
    expect(p('debris-heavy', RUN_SECTION.single)).toBe(debris);
    // ... and no role has a fallback: a missing edge, corner or post gets no kit piece (the derive draws the default post).
    expect(p('edge-in-top', RUN_SECTION.single)).toBe(NO_PIECE);
    expect(p('corner-out-top', RUN_SECTION.single)).toBe(NO_PIECE);
    expect(p('banister-post', RUN_SECTION.single)).toBe(NO_PIECE);
    // The rival kit kept stone; plank is bound by no kit.
    expect(p('beam', RUN_SECTION.body, MAT.stone)).toBe(KIT_PIECE_BASE);
    expect(p('beam', RUN_SECTION.body, MAT.plank)).toBe(NO_PIECE);
    // Canonical bytes: the kits' order does not matter, a read gives the same table, a newer format is refused.
    expect(buildPieceTable([kit, rival], RULES).table.bytes).toEqual(table.bytes);
    const again = readPieceTable(table.bytes);
    expect(again.hash).toBe(table.hash);
    expect(again.kits.map((k) => k.hash)).toEqual(table.kits.map((k) => k.hash));
    const newer = table.bytes.slice();
    newer[0] = PIECE_TABLE_FORMAT + 1;
    expect(() => readPieceTable(newer)).toThrow(new RegExp(`format ${PIECE_TABLE_FORMAT + 1}`));
    expect(() => readPieceTable(table.bytes.subarray(0, table.bytes.length - 1))).toThrow(RangeError);
    // A table names its rule set: a derive refuses a table of other rules.
    expect(() => deriveFromStore(createWorldStore(grid), 0, 0, 0, { ...RULES, version: RULES.version + 1, resolve: RULES.resolve }, undefined, table)).toThrow(/piece table/);
    // Changes by material: a kit's edit touches its own materials only.
    const edited: PieceKitSource = { ...kit, cases: { ...kit.cases, beam: { sections: { body: one } } } };
    const after = buildPieceTable([rival, edited], RULES).table;
    expect([...pieceTableChanges(table, after)!]).toEqual([MAT.timber]);
    expect([...pieceTableChanges(table, null)!].sort((a, b) => a - b)).toEqual([MAT.stone, MAT.timber]);
    expect(pieceTableChanges(table, buildPieceTable([rival, kit], RULES).table)!.size).toBe(0);
  });
});

describe('instances carry kit pieces', () => {
  it('gives each edge its material\'s kit piece (kit-local index, turns, variant word), the default piece where a kit lacks a suppressed case, never a piece on a kept cell\'s flat face; still 8 bytes an instance', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    // Timber (beam, rail, posts) and stone (the wall) bound; the plank slab is not. No post piece in the kit.
    const kit = fullTestKit('log', [MAT.timber, MAT.stone], 3);
    delete (kit.cases as Record<string, unknown>)['banister-post'];
    const { table } = buildPieceTable([kit], RULES);
    const unbound = buildPieceTable([fullTestKit('nothing', [])], RULES).table;
    const v = voxel();
    const seen = { kit: 0, edges: 0, defaults: 0, mirrored: 0, variants: new Set<number>() };
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = deriveFromStore(s, cx, cy, cz, RULES);
      // A table binding no material derives what no table derives, byte for byte.
      expect(encodeDerived(deriveFromStore(s, cx, cy, cz, RULES, undefined, unbound))).toEqual(encodeDerived(plain));
      const d = deriveFromStore(s, cx, cy, cz, RULES, undefined, table);
      const before = instancesOf(plain);
      const now = instancesOf(d);
      // Without a table only the engine's stand-ins for beams and banisters; each cell they replace keeps one with the kit.
      const replaced = (m: Map<string, Inst>): number[] => [...m].filter(([, x]) => (x.flags & INSTANCE_FLAG.replacesBase) !== 0).map(([k]) => cellOfKey(k)).sort((a, b) => a - b);
      for (const b of before.values()) expect(b.piece).toBeLessThan(KIT_PIECE_BASE);
      expect(replaced(now)).toEqual(replaced(before));
      for (const [k, inst] of now) {
        const i = cellOfKey(k);
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        const mat = s.voxelAt(cx * E + lx, cy * E + ly, cz * E + lz, v).material;
        expect(INSTANCE_BYTES).toBe(8);
        if (inst.piece >= KIT_PIECE_BASE) {
          seen.kit++;
          expect([MAT.timber, MAT.stone]).toContain(mat);
          expect(inst.variant & PIECE_VARIANT_MASK).toBeLessThan(3);
          seen.variants.add(inst.variant & PIECE_VARIANT_MASK);
          if ((inst.flags & INSTANCE_FLAG.replacesBase) === 0) {
            seen.edges++;
            // An edge piece's cell shows: one of its six neighbours is open.
            const open = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => s.voxelAt(cx * E + lx + dx!, cy * E + ly + dy!, cz * E + lz + dz!, v).material === 0);
            expect(open, `edge piece at ${lx},${ly},${lz}`).toBe(true);
          }
        } else {
          seen.defaults++;
          // Only the posts (no kit piece) and unbound materials fall to the engine's pieces.
          if (mat === MAT.timber) expect(defaultPieceFamily(inst.piece)).toBe(PIECE_FAMILY.post);
        }
        if ((inst.variant & PIECE_VARIANT_MIRROR) !== 0) seen.mirrored++;
      }
    }
    expect(seen.kit).toBeGreaterThan(50);
    expect(seen.edges).toBeGreaterThan(20);
    expect(seen.defaults).toBeGreaterThan(0);
    expect(seen.variants.size).toBe(3);
    // The beam (timber, suppressed) is the kit's beam body, the only piece of its cell.
    const beamCell = (0 * E + 31) * E + 5;
    const beam = [...instancesOf(deriveFromStore(s, 0, 0, -1, RULES, undefined, table))].filter(([k]) => cellOfKey(k) === beamCell);
    expect(beam).toHaveLength(1);
    expect(beam[0]![1].piece).toBe(tablePiece(table, MAT.timber, caseIndex('beam'), RUN_SECTION.body));
    expect(beam[0]![1].flags & INSTANCE_FLAG.replacesBase).not.toBe(0);
    expect(defaultPiece(PIECE_FAMILY.post, RUN_SECTION.single)).toBeLessThan(KIT_PIECE_BASE);
  });

  it('keeps every surviving piece\'s variant after a dig elsewhere, and gives a cell the same pieces and variants whichever unit derives it', () => {
    const s = townStore();
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 4)], RULES);
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
      // A piece that stays (same cell, case, turns and placement) keeps its variant: the hash reads the cell, the piece's place and the kit only.
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
    const { table } = buildPieceTable([fullTestKit('wood', [MAT.timber, MAT.plank], 3), fullTestKit('masonry', [MAT.stone, MAT.brick, MAT.plaster, MAT.roofTile], 2)], RULES);
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
  it('lists the kit\'s pieces high in chunks and low in level-1 nodes and none from level 2; every cell a piece replaces keeps one at levels 0 and 1 (no roofless houses at level 1)', () => {
    const s = townStore();
    const tree = new MipTree(s);
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 2)], RULES);
    const count = { l0: 0, l1: 0, l1kit: 0, replaced: [0, 0] };
    const replacing = (m: Map<string, Inst>): number[] => [...m].filter(([, x]) => (x.flags & INSTANCE_FLAG.replacesBase) !== 0).map(([k]) => cellOfKey(k)).sort((a, b) => a - b);
    for (const [cx, cy, cz] of TOWN_CHUNKS) {
      const withKit = instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, table));
      const plain = instancesOf(deriveFromStore(s, cx, cy, cz, RULES));
      expect(replacing(withKit)).toEqual(replacing(plain));
      count.replaced[0]! += replacing(withKit).length;
      for (const x of withKit.values()) expect(x.flags & INSTANCE_FLAG.low).toBe(0);
      count.l0 += withKit.size;
    }
    for (const [nx, ny, nz] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] as const) {
      const node = { level: 1, nx, ny, nz };
      const withKit = instancesOf(deriveMipNode(tree, node, RULES, undefined, table));
      const plain = instancesOf(deriveMipNode(tree, node, RULES));
      expect(replacing(withKit)).toEqual(replacing(plain));
      count.replaced[1]! += replacing(withKit).length;
      for (const x of withKit.values()) {
        expect(x.flags & INSTANCE_FLAG.low).not.toBe(0);
        if (x.piece >= KIT_PIECE_BASE) count.l1kit++;
      }
      count.l1 += withKit.size;
      expect(deriveMipNode(tree, { level: 2, nx: nx >> 1, ny: ny >> 1, nz: nz >> 1 }, RULES, undefined, table).instances.count).toBe(0);
    }
    expect(count.l0).toBeGreaterThan(count.l1);
    expect(count.l1kit).toBeGreaterThan(0);
    expect(count.replaced[0]).toBeGreaterThan(0);
    expect(count.replaced[1]).toBeGreaterThan(0);
  });
});

describe('the default kit', () => {
  it('answers every catalogue case (a piece or none), and a world table draws it for every material no kit binds', () => {
    expect(Object.keys(DEFAULT_KIT_PIECES).sort()).toEqual(CAT.cases.map((c) => c.id).sort());
    for (const [id, p] of Object.entries(DEFAULT_KIT_PIECES)) {
      if (p === null) continue;
      const c = CAT.cases.find((x) => x.id === id)!;
      // A suppressed case is the engine's default pieces' (they carry its run sections); the kit dresses edges, roof edges and debris.
      expect(c.base, id).not.toBe('suppress');
      expect(p.boxes.length).toBeGreaterThan(0);
      for (const b of p.boxes) for (let a = 0; a < 3; a++) {
        expect(b[a + 3]!, id).toBeGreaterThan(b[a]!);
        expect(Math.min(b[a]!, b[a + 3]!)).toBeGreaterThanOrEqual(-2);
        expect(Math.max(b[a]!, b[a + 3]!)).toBeLessThanOrEqual(DEFAULT_KIT_UNITS + 2);
      }
    }
    const log = fullTestKit('log', [MAT.timber], 2);
    const t = worldPieceTable([log]);
    expect(t.kits.map((k) => k.id)).toEqual(['log', DEFAULT_KIT_ID]);
    expect(t.defaultKit).toBe(1);
    expect(t.materialKit[MAT.timber]).toBe(0);
    expect(t.materialKit[MAT.stone]).toBe(1);
    expect(t.materialKit[0]).toBe(NO_KIT);
    expect(readPieceTable(t.bytes).materialKit).toEqual(t.materialKit);
    expect(worldPieceTable([log]).bytes).toEqual(t.bytes);
    expect(() => buildPieceTable([{ voxelKitId: DEFAULT_KIT_ID, cases: {} }], RULES, defaultKitSource(CAT))).toThrow(/default kit's id/);
    // Painting between two unbound materials stays within the default kit; onto the log kit's, it changes kits.
    expect(pieceTableKitChanges(t, [materialSwap(MAT.stone, MAT.plank)])).toBe(false);
    expect(pieceTableKitChanges(t, [materialSwap(MAT.stone, MAT.timber)])).toBe(true);
  });

  it('puts its pieces on the edges and corners of the wall-beam-banister scene and leaves the beam, rail and posts the engine\'s default pieces', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    const t = worldPieceTable([]);
    const cases = new Map<string, number>();
    const own = kitPieceList(defaultKitSource(CAT), CAT).pieces;
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = instancesOf(deriveFromStore(s, cx, cy, cz, RULES));
      const now = instancesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, t));
      // Every piece without a table is there unchanged (the suppressed cells' default pieces).
      for (const [k, b] of plain) expect(now.get(k), `instance ${k}`).toEqual(b);
      for (const [k, inst] of now) {
        if (plain.has(k)) continue;
        expect(inst.piece).toBeGreaterThanOrEqual(KIT_PIECE_BASE);
        expect(inst.flags & INSTANCE_FLAG.replacesBase).toBe(0);
        const id = own[inst.piece - KIT_PIECE_BASE]!.caseId;
        cases.set(id, (cases.get(id) ?? 0) + 1);
      }
    }
    // The wall's top and end edges and its corners, the slab's rim, the floor-wall coves; nothing else.
    expect(cases.get('edge-out-top')).toBeGreaterThan(5);
    expect(cases.get('edge-out-vertical')).toBeGreaterThan(0);
    expect(cases.get('corner-out-top')).toBeGreaterThan(0);
    expect([...cases.keys()].every((id) => id.startsWith('edge-') || id.startsWith('corner-'))).toBe(true);
  });
});
