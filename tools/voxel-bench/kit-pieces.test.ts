/**
 * Instances carry kit pieces, through the real derive: the piece table built
 * from kits (material → kit by the test binding, kit-local piece indices, the
 * fallback order for a missing case), the instance's piece and variant word
 * (still 8 bytes), variants that stay put under unrelated edits and whichever
 * unit derives a cell, and the pieces per level (high in chunks, low in
 * level-1 nodes, none coarser) with no suppressed cell left without a piece.
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
  DRAFT_CASE_CATALOGUE,
  encodeDerived,
  INSTANCE_BYTES,
  INSTANCE_FLAG,
  jobRadius,
  KIT_PIECE_BASE,
  KIT_RULES,
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
const caseIndex = (id: string): number => DRAFT_CASE_CATALOGUE.cases.findIndex((c) => c.id === id);

interface Inst {
  piece: number;
  flags: number;
  variant: number;
}

/** A derived unit's instances by local cell index (x · E + z) · E + y of its edge. */
function instancesOf(d: DerivedData): Map<number, Inst> {
  const out = new Map<number, Inst>();
  const e = d.edge;
  const b = d.instances.data;
  expect(b.length).toBe(d.instances.count * INSTANCE_BYTES);
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    out.set((b[o]! * e + b[o + 2]!) * e + b[o + 1]!, { piece: b[o + 4]! | (b[o + 5]! << 8), flags: b[o + 3]!, variant: b[o + 6]! | (b[o + 7]! << 8) });
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
  it('numbers a kit\'s own pieces after the default ones and resolves a missing piece in order: the case\'s body, its single, the role fallback of the same form, then the default or nothing', () => {
    const one = { variants: weightedVariants(1) };
    const kit: PieceKitSource = {
      voxelKitId: 'log',
      materials: [MAT.timber],
      cases: {
        'wall-plain': { sections: { single: one } },
        beam: { sections: { body: { variants: weightedVariants(2) } } },
        'banister-rail': { sections: { single: one, body: one, end: one, middle: one } },
        gazebo: { sections: { single: one } },
      },
    };
    const rival: PieceKitSource = { voxelKitId: 'zz-rival', materials: [MAT.timber, MAT.stone], cases: { beam: { sections: { body: one } } } };
    const list = kitPieceList(kit, DRAFT_CASE_CATALOGUE);
    // Catalogue case order, then section order; unknown cases and sections are problems, never pieces.
    expect(list.pieces.map((p) => `${p.caseId}/${p.sectionId}`)).toEqual(['wall-plain/single', 'beam/body', 'banister-rail/single', 'banister-rail/body', 'banister-rail/end']);
    expect(list.problems.join('\n')).toMatch(/gazebo[\s\S]*middle/);
    const { table, problems } = buildPieceTable([rival, kit], KIT_RULES);
    expect(problems.some((p) => p.includes(`material ${MAT.timber}`) && p.includes('log draws it'))).toBe(true);
    const p = (c: string, s: number, m: number = MAT.timber): number => tablePiece(table, m, caseIndex(c), s);
    const [wallPlain, beamBody, railSingle, railBody, railEnd] = [0, 1, 2, 3, 4].map((k) => KIT_PIECE_BASE + k);
    // The case's own section, else its body, else its single.
    expect(p('banister-rail', RUN_SECTION.end)).toBe(railEnd);
    expect(p('banister-rail', RUN_SECTION.start)).toBe(railBody);
    expect(p('banister-rail', RUN_SECTION.corner)).toBe(railBody);
    expect(p('beam', RUN_SECTION.single)).toBe(beamBody);
    expect(p('beam', RUN_SECTION.junction)).toBe(beamBody);
    // A missing case takes its role's fallback where that declares the same base and shape (keep / box) ...
    expect(p('moulding', RUN_SECTION.body)).toBe(wallPlain);
    expect(p('wall-top', RUN_SECTION.end)).toBe(wallPlain);
    // ... never across forms: a post or a soffit get no wall piece (the derive draws the default post, the soffit its slab).
    expect(p('banister-post', RUN_SECTION.single)).toBe(NO_PIECE);
    expect(p('soffit', RUN_SECTION.body)).toBe(NO_PIECE);
    expect(p('floor-edge', RUN_SECTION.body)).toBe(NO_PIECE);
    // The rival kit kept stone; plank is bound by no kit.
    expect(p('beam', RUN_SECTION.body, MAT.stone)).toBe(KIT_PIECE_BASE);
    expect(p('beam', RUN_SECTION.body, MAT.plank)).toBe(NO_PIECE);
    // Canonical bytes: the kits' order does not matter, a read gives the same table, a newer format is refused.
    expect(buildPieceTable([kit, rival], KIT_RULES).table.bytes).toEqual(table.bytes);
    const again = readPieceTable(table.bytes);
    expect(again.hash).toBe(table.hash);
    expect(again.kits.map((k) => k.hash)).toEqual(table.kits.map((k) => k.hash));
    const newer = table.bytes.slice();
    newer[0] = PIECE_TABLE_FORMAT + 1;
    expect(() => readPieceTable(newer)).toThrow(new RegExp(`format ${PIECE_TABLE_FORMAT + 1}`));
    expect(() => readPieceTable(table.bytes.subarray(0, table.bytes.length - 1))).toThrow(RangeError);
    // A table names its rule set: the terrain rules have no catalogue, and a derive refuses a table of other rules.
    expect(() => deriveFromStore(createWorldStore(grid), 0, 0, 0, { ...KIT_RULES, version: KIT_RULES.version + 1, resolve: KIT_RULES.resolve }, undefined, table)).toThrow(/piece table/);
    // Changes by material: a kit's edit touches its own materials only.
    const edited: PieceKitSource = { ...kit, cases: { ...kit.cases, beam: { sections: { body: one } } } };
    const after = buildPieceTable([rival, edited], KIT_RULES).table;
    expect([...pieceTableChanges(table, after)!]).toEqual([MAT.timber]);
    expect([...pieceTableChanges(table, null)!].sort((a, b) => a - b)).toEqual([MAT.stone, MAT.timber]);
    expect(pieceTableChanges(table, buildPieceTable([rival, kit], KIT_RULES).table)!.size).toBe(0);
  });
});

describe('instances carry kit pieces', () => {
  it('gives each cell its material\'s kit piece (kit-local index, variant word with the mirror), the default piece where a kit lacks a suppressed case, nothing where a kept cell does not show; still 8 bytes an instance', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    // Timber (beam, rail, posts) and stone (the wall) bound; the plank slab is not. No post piece in the kit.
    const kit = fullTestKit('log', [MAT.timber, MAT.stone], 3);
    delete (kit.cases as Record<string, unknown>)['banister-post'];
    const { table } = buildPieceTable([kit], KIT_RULES);
    const unbound = buildPieceTable([fullTestKit('nothing', [])], KIT_RULES).table;
    const v = voxel();
    const seen = { kit: 0, kept: 0, defaults: 0, mirrored: 0, variants: new Set<number>() };
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = deriveFromStore(s, cx, cy, cz, KIT_RULES);
      // A table binding no material derives what no table derives, byte for byte.
      expect(encodeDerived(deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, unbound))).toEqual(encodeDerived(plain));
      const d = deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, table);
      const before = instancesOf(plain);
      const now = instancesOf(d);
      // Every cell a piece replaced still has one; the kit adds pieces only on cells whose base stays.
      for (const [i, b] of before) {
        expect(now.get(i)?.flags, `cell ${i}`).toBe(b.flags);
        expect(b.piece).toBeLessThan(KIT_PIECE_BASE);
      }
      for (const [i, inst] of now) {
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        const mat = s.voxelAt(cx * E + lx, cy * E + ly, cz * E + lz, v).material;
        expect(INSTANCE_BYTES).toBe(8);
        if (inst.piece >= KIT_PIECE_BASE) {
          seen.kit++;
          expect([MAT.timber, MAT.stone]).toContain(mat);
          expect(inst.variant & PIECE_VARIANT_MASK).toBeLessThan(3);
          seen.variants.add(inst.variant & PIECE_VARIANT_MASK);
          if ((inst.flags & INSTANCE_FLAG.replacesBase) === 0) {
            seen.kept++;
            // A kept cell's piece shows: one of its six neighbours is open.
            const open = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => s.voxelAt(cx * E + lx + dx!, cy * E + ly + dy!, cz * E + lz + dz!, v).material === 0);
            expect(open, `kept piece at ${lx},${ly},${lz}`).toBe(true);
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
    expect(seen.kept).toBeGreaterThan(20);
    expect(seen.defaults).toBeGreaterThan(0);
    expect(seen.variants.size).toBe(3);
    // The beam (timber, suppressed) is the kit's beam body.
    const beam = instancesOf(deriveFromStore(s, 0, 0, -1, KIT_RULES, undefined, table)).get((0 * E + 31) * E + 5)!;
    expect(beam.piece).toBe(tablePiece(table, MAT.timber, caseIndex('beam'), RUN_SECTION.body));
    expect(beam.flags & INSTANCE_FLAG.replacesBase).not.toBe(0);
    expect(defaultPiece(PIECE_FAMILY.post, RUN_SECTION.single)).toBeLessThan(KIT_PIECE_BASE);
  });

  it('keeps every surviving piece\'s variant after a dig elsewhere, and gives a cell the same piece and variant whichever unit derives it', () => {
    const s = townStore();
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 4)], KIT_RULES);
    // The town chunk with the most kit pieces.
    let best: [number, number, number] = TOWN_CHUNKS[0]!;
    let most = -1;
    for (const c of TOWN_CHUNKS) {
      const n = deriveFromStore(s, ...c, KIT_RULES, undefined, table).instances.count;
      if (n > most) [best, most] = [c, n];
    }
    const [cx, cy, cz] = best;
    const before = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, table));
    expect(new Set([...before.values()].map((x) => x.variant & PIECE_VARIANT_MASK)).size).toBe(4);
    // 16³ sections, each from its own origin, give the chunk's pieces and variants cell for cell.
    const pad = jobRadius(KIT_RULES);
    const sections = deriveSectionsWithApron(grid, KIT_RULES, buildApron(s, cx, cy, cz, pad), (out) => s.exportChunk(cx, cy, cz, out), 16, [0, 1, 2, 3, 4, 5, 6, 7], 0, { table, chunk: [cx, cy, cz] });
    const joined = new Map<number, Inst>();
    for (const r of sections) {
      const [ox, oy, oz] = [(r.id >> 2) & 1, r.id & 1, (r.id >> 1) & 1].map((b) => b * 16) as [number, number, number];
      for (const [i, inst] of instancesOf(r.assembly!)) joined.set(((Math.floor(i / 256) + ox) * E + (Math.floor(i / 16) % 16) + oz) * E + (i % 16) + oy, inst);
    }
    expect(joined).toEqual(before);
    // Dig a 3³ hole into a piece-bearing cell of the chunk: only cells within the job's reach can change at all.
    const [hole] = [...before.keys()].filter((i) => (before.get(i)!.flags & INSTANCE_FLAG.replacesBase) === 0);
    const [hx, hz, hy] = [Math.floor(hole! / (E * E)), Math.floor(hole! / E) % E, hole! % E];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) putVoxel(s, cx * E + hx + dx, cy * E + hy + dy, cz * E + hz + dz, 0, 0);
    const after = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, table));
    let far = 0;
    let changedNear = 0;
    for (const [i, b] of before) {
      const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
      const reach = Math.max(Math.abs(lx - hx), Math.abs(ly - hy), Math.abs(lz - hz));
      const a = after.get(i);
      // A cell keeping its piece keeps its variant (the hash reads the cell and the kit only; near the dig its case may turn or mirror).
      if (a !== undefined && a.piece === b.piece) expect(a.variant & PIECE_VARIANT_MASK, `cell ${lx},${ly},${lz}`).toBe(b.variant & PIECE_VARIANT_MASK);
      if (reach > 1 + pad + 1) {
        far++;
        expect(a, `cell ${lx},${ly},${lz}`).toEqual(b);
      } else if (a === undefined || a.piece !== b.piece) changedNear++;
    }
    expect(far).toBeGreaterThan(100);
    expect(changedNear).toBeGreaterThan(0);
  });
});

describe('material and wetness feed the shader data, kits bound', () => {
  it('keeps every output but the shader data under a wetness paint and a material paint within one kit; a paint to another kit changes only the painted cells\' pieces', () => {
    const s = townStore();
    // Timber and plank are one kit, the masonry another: a paint between kits moves cells' pieces, one within a kit none.
    const { table } = buildPieceTable([fullTestKit('wood', [MAT.timber, MAT.plank], 3), fullTestKit('masonry', [MAT.stone, MAT.brick, MAT.plaster, MAT.roofTile], 2)], KIT_RULES);
    const v = voxel();
    // The town's west half: enough of every material, half the derive time.
    const chunks = TOWN_CHUNKS.filter(([cx]) => cx < 2);
    const derive = (): DerivedData[] => chunks.map((c) => deriveFromStore(s, ...c, KIT_RULES, undefined, table));
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
      for (const i of new Set([...was.keys(), ...now.keys()])) {
        const [lx, lz, ly] = [Math.floor(i / (E * E)), Math.floor(i / E) % E, i % E];
        if (painted.has(`${cx * E + lx},${cy * E + ly},${cz * E + lz}`)) {
          // The kits number alike, so the variant (the other kit's seed and weights) tells them apart where the piece does not.
          if (JSON.stringify(was.get(i)) !== JSON.stringify(now.get(i))) moved++;
        } else expect(now.get(i), `cell ${lx},${ly},${lz} of ${cx},${cy},${cz}`).toEqual(was.get(i));
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
    const { table } = buildPieceTable([fullTestKit('town', BUILDING_MATERIALS, 2)], KIT_RULES);
    const count = { l0: 0, l1: 0, l1kit: 0, replaced: [0, 0] };
    const replacing = (m: Map<number, Inst>): number[] => [...m].filter(([, x]) => (x.flags & INSTANCE_FLAG.replacesBase) !== 0).map(([i]) => i).sort((a, b) => a - b);
    for (const [cx, cy, cz] of TOWN_CHUNKS) {
      const withKit = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, table));
      const plain = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES));
      expect(replacing(withKit)).toEqual(replacing(plain));
      count.replaced[0]! += replacing(withKit).length;
      for (const x of withKit.values()) expect(x.flags & INSTANCE_FLAG.low).toBe(0);
      count.l0 += withKit.size;
    }
    for (const [nx, ny, nz] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] as const) {
      const node = { level: 1, nx, ny, nz };
      const withKit = instancesOf(deriveMipNode(tree, node, KIT_RULES, undefined, table));
      const plain = instancesOf(deriveMipNode(tree, node, KIT_RULES));
      expect(replacing(withKit)).toEqual(replacing(plain));
      count.replaced[1]! += replacing(withKit).length;
      for (const x of withKit.values()) {
        expect(x.flags & INSTANCE_FLAG.low).not.toBe(0);
        if (x.piece >= KIT_PIECE_BASE) count.l1kit++;
      }
      count.l1 += withKit.size;
      expect(deriveMipNode(tree, { level: 2, nx: nx >> 1, ny: ny >> 1, nz: nz >> 1 }, KIT_RULES, undefined, table).instances.count).toBe(0);
    }
    expect(count.l0).toBeGreaterThan(count.l1);
    expect(count.l1kit).toBeGreaterThan(0);
    expect(count.replaced[0]).toBeGreaterThan(0);
    expect(count.replaced[1]).toBeGreaterThan(0);
  });
});

describe('the default kit', () => {
  it('answers every catalogue case (a piece or none), and a world table draws it for every material no kit binds', () => {
    expect(Object.keys(DEFAULT_KIT_PIECES).sort()).toEqual(DRAFT_CASE_CATALOGUE.cases.map((c) => c.id).sort());
    for (const [id, p] of Object.entries(DEFAULT_KIT_PIECES)) {
      if (p === null) continue;
      const c = DRAFT_CASE_CATALOGUE.cases.find((x) => x.id === id)!;
      // A suppressed case is the engine's default pieces' (they carry its run sections); the kit adds to kept bases only.
      expect(c.base, id).not.toBe('suppress');
      expect(p.boxes.length).toBeGreaterThan(0);
      for (const b of p.boxes) for (let a = 0; a < 3; a++) {
        expect(b[a + 3]!, id).toBeGreaterThan(b[a]!);
        expect(Math.min(b[a]!, b[a + 3]!)).toBeGreaterThanOrEqual(-2);
        expect(Math.max(b[a]!, b[a + 3]!)).toBeLessThanOrEqual(DEFAULT_KIT_UNITS + 6);
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
    expect(() => buildPieceTable([{ voxelKitId: DEFAULT_KIT_ID, cases: {} }], KIT_RULES, defaultKitSource(DRAFT_CASE_CATALOGUE))).toThrow(/default kit's id/);
    // Painting between two unbound materials stays within the default kit; onto the log kit's, it changes kits.
    expect(pieceTableKitChanges(t, [materialSwap(MAT.stone, MAT.plank)])).toBe(false);
    expect(pieceTableKitChanges(t, [materialSwap(MAT.stone, MAT.timber)])).toBe(true);
  });

  it('puts its pieces on the kept edges of the wall-beam-banister scene and leaves the beam, rail and posts the engine\'s default pieces', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    const t = worldPieceTable([]);
    const cases = new Map<string, number>();
    const seenCase = (inst: Inst): void => {
      const pc = kitPieceList(defaultKitSource(DRAFT_CASE_CATALOGUE), DRAFT_CASE_CATALOGUE).pieces[inst.piece - KIT_PIECE_BASE]!;
      cases.set(pc.caseId, (cases.get(pc.caseId) ?? 0) + 1);
    };
    for (const [cx, cy, cz] of [[-1, 0, -1], [0, 0, -1], [-1, 0, 0], [0, 0, 0]] as const) {
      const plain = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES));
      const now = instancesOf(deriveFromStore(s, cx, cy, cz, KIT_RULES, undefined, t));
      // Every piece without a table is there unchanged (the suppressed cells' default pieces).
      for (const [i, b] of plain) expect(now.get(i), `cell ${i}`).toEqual(b);
      for (const [i, inst] of now) {
        if (plain.has(i)) continue;
        expect(inst.piece).toBeGreaterThanOrEqual(KIT_PIECE_BASE);
        expect(inst.flags & INSTANCE_FLAG.replacesBase).toBe(0);
        seenCase(inst);
      }
    }
    // The wall's coping and its end and corner boards, the slab's edge band; nothing for plain faces.
    expect(cases.get('wall-top')).toBeGreaterThan(5);
    expect([...cases.keys()].every((id) => DEFAULT_KIT_PIECES[id] !== null)).toBe(true);
    expect(cases.has('wall-plain')).toBe(false);
  });
});
