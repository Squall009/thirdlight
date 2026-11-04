/**
 * The consumers read the case: every cell's render occupancy, collision,
 * navigation, light coverage, base surface and piece follow its form (its
 * case's declared coarse shape and base, case-forms.ts), never a piece
 * mesh — checked cell by cell against the real derive on the town, the
 * hand scenes and random worlds, at chunk-tree levels 0, 1 and 2; a
 * balcony's soffits drawn, collided and lit as their raised slab; and a
 * chunk's 16³ and 8³ sections giving the whole chunk's consumers cell for
 * cell and the same base surface area in every face plane.
 */
import {
  ASSEMBLY_CLASS,
  buildApron,
  caseIndexOf,
  cellBit,
  classifyRoofs,
  cellOutputs,
  chunkGrid,
  CLASS_MASK,
  classForm,
  COLLISION_STEPS_PER_CELL,
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  deriveFromStore,
  deriveMipNode,
  deriveSectionsWithApron,
  DRAFT_CASE_CATALOGUE,
  evaluateAssembly,
  evaluateCases,
  evaluateForms,
  fillNeighbourhood,
  FORM_BASE,
  FORM_SHAPE,
  FORM_SHAPE_BOX,
  formBaseOf,
  formBox,
  formCoverage,
  formShapeOf,
  formSupports,
  INSTANCE_BYTES,
  defaultPieceFamily,
  INSTANCE_FLAG,
  jobRadius,
  joinSections,
  KIT_RULES,
  LIGHT_COVERAGE,
  MipTree,
  NO_CASE,
  OCCUPANCY,
  PIECE_FAMILY,
  POSITION_STEPS_PER_CELL,
  RUN_X,
  RUN_Z,
  sectionLocalOrigin,
  SURFACE_ISO,
  SURFACE_VERTEX_BYTES,
  VOXEL_ROLE,
  type DerivedData,
  type PaletteStore,
  type SurfaceBuffer,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { bodiesOnly, bodySurface } from './base-cases';
import { loadArea } from './regions';
import { dabDetailRoles, placeBalcony, placeWallBeamBanister, randomAssemblyWorld, randomTerrainWorld } from './scenes';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const KR = jobRadius(KIT_RULES);
const S = COLLISION_STEPS_PER_CELL;

type ChunkSource = Parameters<typeof buildApron>[0] & Pick<PaletteStore, 'exportChunk'>;

/** The job's classes and forms of a chunk (or a level's node) under the kit rules, the evaluation a derive runs. */
function jobForms(src: ChunkSource, cx: number, cy: number, cz: number, level: number): { n: ReturnType<typeof createNeighbourhood>; classes: Uint8Array; cases: Uint16Array; forms: Uint8Array; roofs: Uint32Array } {
  const n = createNeighbourhood(E, KR);
  const dense = createDenseChunk(grid);
  fillNeighbourhood(n, grid, src.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(src, cx, cy, cz, KR));
  const classes = new Uint8Array(n.values.length);
  evaluateAssembly(n, KIT_RULES, classes);
  const cases = new Uint16Array(n.values.length);
  evaluateCases(n, KIT_RULES, level, cases);
  const forms = new Uint8Array(n.values.length);
  evaluateForms(n, KIT_RULES, classes, cases, forms);
  const roofs = new Uint32Array(n.values.length);
  classifyRoofs(n, roofs);
  return { n, classes, cases, forms, roofs };
}

/** What every consumer says about a local cell of a derived result, read from its arrays (no piece meshes involved). */
interface CellView {
  light: number;
  blocks: boolean;
  solid: boolean;
  /** 'full', 'none', or the partial box in steps within the cell. */
  collision: string;
  /** Family and the replaces-base flag, or null. */
  piece: string | null;
  standable: boolean;
}

function viewer(d: DerivedData): (x: number, y: number, z: number) => CellView {
  const e = d.edge;
  const full = new Uint8Array(e * e * e);
  const partial = new Map<number, string>();
  const b = d.collision.boxes;
  for (let k = 0; k * 6 < b.length; k++) {
    const o = k * 6;
    if (k < d.collision.fullBoxes) {
      for (let x = b[o]! / S; x < b[o + 3]! / S; x++) for (let z = b[o + 2]! / S; z < b[o + 5]! / S; z++) for (let y = b[o + 1]! / S; y < b[o + 4]! / S; y++) full[(x * e + z) * e + y] = 1;
    } else {
      const [x, y, z] = [Math.floor(b[o]! / S), Math.floor(b[o + 1]! / S), Math.floor(b[o + 2]! / S)];
      partial.set((x * e + z) * e + y, [b[o]! - x * S, b[o + 1]! - y * S, b[o + 2]! - z * S, b[o + 3]! - x * S, b[o + 4]! - y * S, b[o + 5]! - z * S].join(','));
    }
  }
  const pieces = new Map<number, string>();
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    const data = d.instances.data;
    pieces.set((data[o]! * e + data[o + 2]!) * e + data[o + 1]!, `${defaultPieceFamily(data[o + 4]! | (data[o + 5]! << 8))}:${(data[o + 3]! & INSTANCE_FLAG.replacesBase) !== 0}`);
  }
  const partialLight = new Map<number, number>();
  d.light.partialCells.forEach((c, k) => partialLight.set(c, d.light.partialCover[k]!));
  const standable = new Set(d.nav.standable);
  return (x, y, z) => {
    const i = (x * e + z) * e + y;
    const light = d.light.uniform >= 0 ? d.light.uniform : cellBit(d.light.full, i) ? 255 : (partialLight.get(i) ?? 0);
    return {
      light,
      blocks: d.nav.blocking === OCCUPANCY.solid || (d.nav.blocking === OCCUPANCY.mixed && cellBit(d.nav.blocks, i)),
      solid: d.occupancy.flag === OCCUPANCY.solid || (d.occupancy.flag === OCCUPANCY.mixed && cellBit(d.occupancy.mask, i)),
      collision: full[i] === 1 ? 'full' : (partial.get(i) ?? 'none'),
      piece: pieces.get(i) ?? null,
      standable: standable.has(i),
    };
  };
}

const FAMILY_OF_SHAPE: Record<number, number> = { [FORM_SHAPE.bar]: PIECE_FAMILY.beam, [FORM_SHAPE.panel]: PIECE_FAMILY.rail, [FORM_SHAPE.post]: PIECE_FAMILY.post };

/**
 * What a cell's form (and, for ground, its density) says each consumer
 * receives. A roof's plane cell (`plane`) collides as the roof's ramp and
 * takes no piece; light, navigation and occupancy read its voxel.
 */
function expected(n: ReturnType<typeof createNeighbourhood>, classes: Uint8Array, forms: Uint8Array, i: number, piecesDrawn: boolean, plane = false): Omit<CellView, 'standable'> {
  const f = forms[i]!;
  const ground = (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground;
  const solidGround = ground && n.shapes[i]! >= SURFACE_ISO;
  const shape = formShapeOf(f);
  const box = [0, 0, 0, 0, 0, 0];
  const family = FAMILY_OF_SHAPE[shape];
  return {
    light: ground ? n.shapes[i]! : formCoverage(f),
    blocks: shape !== FORM_SHAPE.none || solidGround,
    solid: shape === FORM_SHAPE.box || solidGround,
    collision: plane ? 'none' : shape === FORM_SHAPE.box ? 'full' : formBox(f, box) ? box.join(',') : 'none',
    piece: !plane && piecesDrawn && formBaseOf(f) === FORM_BASE.suppress && family !== undefined ? `${family}:true` : null,
  };
}

/** Compares every cell of a derived chunk (or node) with what its forms say; returns the cells checked and those with a case. */
function checkAgainstForms(d: DerivedData, job: ReturnType<typeof jobForms>, at: string): { cells: number; withCase: number; shapes: Set<number> } {
  const view = viewer(d);
  const { n, classes, forms, cases, roofs } = job;
  const s = n.side;
  const p = n.pad;
  const piecesDrawn = d.level < 2;
  let withCase = 0;
  const shapes = new Set<number>();
  for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    const got = view(x, y, z);
    const want = expected(n, classes, forms, i, piecesDrawn, roofs[i] !== 0);
    const { standable, ...rest } = got;
    if (JSON.stringify(rest) !== JSON.stringify(want)) expect(rest, `${at} cell ${x},${y},${z} form ${forms[i]}`).toEqual(want);
    // Standable: free, on a cell whose form covers its top (or ground).
    const below = i - 1;
    const supports = formSupports(forms[below]!) || ((classes[below]! & CLASS_MASK) === ASSEMBLY_CLASS.ground && n.shapes[below]! >= SURFACE_ISO);
    if (standable !== (!want.blocks && supports)) expect(standable, `${at} cell ${x},${y},${z} standable`).toBe(!want.blocks && supports);
    if (cases[i] !== NO_CASE) withCase++;
    shapes.add(formShapeOf(forms[i]!));
  }
  return { cells: E ** 3, withCase, shapes };
}

function mixedWorld(seed: number): PaletteStore {
  const s = createWorldStore(grid);
  randomTerrainWorld(s, seed + 10, 24);
  randomAssemblyWorld(s, seed, 24);
  dabDetailRoles(s, seed);
  return s;
}

function sceneStore(place: (s: PaletteStore) => void): PaletteStore {
  const s = createWorldStore(grid);
  place(s);
  return s;
}

function townStore(): PaletteStore {
  const s = createWorldStore(grid);
  loadArea(townWorld({ footprint: 128 }).grids[0]!, s, 0, 0, 128, 128);
  return s;
}

/** Base surface area per face plane: direction and plane coordinate (position steps) → area (cells²). */
function areaByPlane(buf: SurfaceBuffer): Map<string, number> {
  const v = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const pos = (k: number, a: number): number => v.getUint16(k * SURFACE_VERTEX_BYTES + 2 * a, true) / POSITION_STEPS_PER_CELL;
  const out = new Map<string, number>();
  for (let t = 0; t < buf.indices.length; t += 3) {
    const [a, b, c] = [buf.indices[t]!, buf.indices[t + 1]!, buf.indices[t + 2]!];
    let axis = 0;
    while (axis < 3 && v.getInt8(a * SURFACE_VERTEX_BYTES + 8 + axis) === 0) axis++;
    const sign = v.getInt8(a * SURFACE_VERTEX_BYTES + 8 + axis) > 0 ? '+' : '-';
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    const area = Math.abs((pos(b, u) - pos(a, u)) * (pos(c, w) - pos(a, w)) - (pos(c, u) - pos(a, u)) * (pos(b, w) - pos(a, w))) / 2;
    const key = `${axis}${sign}${pos(a, axis)}`;
    out.set(key, (out.get(key) ?? 0) + area);
  }
  return out;
}

describe('consumers from the case', () => {
  it('declares each shape once, in the case\'s own orientation; light is its share of the cell; classes without a case keep the placeholder shapes', () => {
    expect(LIGHT_COVERAGE).toEqual({ none: 0, box: 255, slab: 128, panel: 64, bar: 100, post: 16 });
    const box = [0, 0, 0, 0, 0, 0];
    // A beam, rail and post read from classes collide as the placeholder shapes did: run along x, along z, both.
    const cases: Array<[number, number[]]> = [
      [ASSEMBLY_CLASS.beam | RUN_X, [0, 3, 3, 16, 13, 13]],
      [ASSEMBLY_CLASS.beam | RUN_Z, [3, 3, 0, 13, 13, 16]],
      [ASSEMBLY_CLASS.rail | RUN_X, [0, 0, 6, 16, 16, 10]],
      [ASSEMBLY_CLASS.rail | RUN_Z, [6, 0, 0, 10, 16, 16]],
      [ASSEMBLY_CLASS.rail | RUN_X | RUN_Z, [6, 0, 6, 10, 16, 10]],
    ];
    for (const [cls, want] of cases) {
      const f = classForm(cls);
      expect(formBaseOf(f), `class ${cls}`).toBe(FORM_BASE.suppress);
      expect(formBox(f, box) && box, `class ${cls}`).toEqual(want);
    }
    expect(formShapeOf(classForm(ASSEMBLY_CLASS.wall))).toBe(FORM_SHAPE.box);
    expect(formShapeOf(classForm(ASSEMBLY_CLASS.ground))).toBe(FORM_SHAPE.none);
    // The draft catalogue: beams, banisters and soffits leave or reshape the base; every other built case keeps a whole cell; openings are gaps.
    const forms = Object.fromEntries(DRAFT_CASE_CATALOGUE.cases.map((c) => [c.id, `${c.base}/${c.shape}`]));
    expect(forms).toMatchObject({ beam: 'suppress/bar', 'banister-rail': 'suppress/panel', 'banister-post': 'suppress/post', soffit: 'reshape/slab', 'wall-plain': 'keep/box', moulding: 'keep/box', 'running-board': 'keep/box', 'opening-plain': 'keep/none' });
    for (const c of DRAFT_CASE_CATALOGUE.cases) if (c.roles.every((r) => r === VOXEL_ROLE.opening)) expect(c.shape, c.id).toBe('none');
    expect(FORM_SHAPE_BOX.slab).toEqual([0, 8, 0, 16, 16, 16]);
  });

  it('gives every consumer the cell\'s form, never a piece: town, scenes and random worlds at levels 0 and 1 (cases) and 2 (classes)', () => {
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['scene', sceneStore((s) => placeWallBeamBanister(s)), [[-1, 0, -1], [0, 0, 0], [-1, 0, 0], [-1, -1, -1]]],
      ['balcony', sceneStore((s) => placeBalcony(s)), [[-1, 0, 0], [0, 0, 0]]],
      ['town', townStore(), [[0, 0, 0], [1, 0, 1], [2, 1, 2], [3, 0, 1], [1, 1, 3]]],
      ['mixed', mixedWorld(3), [[-1, -1, -1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]]],
      ['mixed', mixedWorld(8), [[-1, -1, -1], [0, 0, 0], [-1, 0, -1]]],
    ];
    let withCase = 0;
    const shapes = new Set<number>();
    const levels = new Set<number>();
    for (const [name, store, chunks] of stores) {
      const tree = new MipTree(store);
      for (const [cx, cy, cz] of chunks) {
        const r = checkAgainstForms(deriveFromStore(store, cx, cy, cz, KIT_RULES), jobForms(store, cx, cy, cz, 0), `${name} chunk ${cx},${cy},${cz}`);
        withCase += r.withCase;
        for (const k of r.shapes) shapes.add(k);
        levels.add(0);
        for (const level of [1, 2]) {
          const node = { level, nx: cx >> level, ny: cy >> level, nz: cz >> level };
          const d = deriveMipNode(tree, node, KIT_RULES);
          const job = jobForms(tree.level(level), node.nx, node.ny, node.nz, level);
          const rr = checkAgainstForms(d, job, `${name} level ${level} node ${node.nx},${node.ny},${node.nz}`);
          if (level === 2) expect(rr.withCase).toBe(0);
          else if (rr.withCase > 0) levels.add(1);
        }
      }
    }
    expect(withCase).toBeGreaterThan(5000);
    expect([...levels].sort()).toEqual([0, 1]);
    // Every declared shape occurs: whole cells, the soffit's slab, rails, beams and posts, and open space.
    expect([...shapes].sort()).toEqual(Object.values(FORM_SHAPE).sort());
  }, 120_000);

  it('reads a balcony\'s open edges as soffits: the base draws the raised underside, collision is the slab, light half, standable on top, open below', () => {
    const s = sceneStore((st) => placeBalcony(st));
    const d = deriveFromStore(s, 0, 0, 0, KIT_RULES);
    const job = jobForms(s, 0, 0, 0, 0);
    const caseAt = (x: number, y: number, z: number): string => {
      const i = ((x + KR) * job.n.side + (z + KR)) * job.n.side + (y + KR);
      return DRAFT_CASE_CATALOGUE.cases[caseIndexOf(job.cases[i]!)]!.id;
    };
    expect(caseAt(1, 4, 3)).toBe('soffit');
    expect(caseAt(3, 4, 2)).toBe('soffit');
    expect(caseAt(1, 4, 1)).toBe('floor-plain');
    const soffit = cellOutputs(d, 1, 4, 3);
    expect(soffit).toMatchObject({ renderSolid: false, collision: 'partial', partialBox: [0, 8, 0, 16, 16, 16], navBlocks: true, light: LIGHT_COVERAGE.slab, piece: null });
    // The side edge's slab, turned: still the upper half.
    expect(cellOutputs(d, 3, 4, 2).partialBox).toEqual([0, 8, 0, 16, 16, 16]);
    expect(cellOutputs(d, 1, 4, 1)).toMatchObject({ renderSolid: true, collision: 'full', light: 255 });
    // On the balcony: standable over a soffit and over the plain floor; under the soffit the cell is free.
    expect(cellOutputs(d, 1, 5, 3).standable).toBe(true);
    expect(cellOutputs(d, 1, 5, 1).standable).toBe(true);
    expect(cellOutputs(d, 1, 3, 3)).toMatchObject({ navBlocks: false, collision: 'none', light: 0 });
    // The base surface: a downward face at y 4.5 under every soffit cell, none at y 4 there; the plain floor's underside at y 4.
    const v = new DataView(d.base.vertices.buffer, d.base.vertices.byteOffset, d.base.vertices.byteLength);
    const at = (k: number, a: number): number => v.getUint16(k * SURFACE_VERTEX_BYTES + 2 * a, true) / POSITION_STEPS_PER_CELL - 1;
    /** The heights of the downward base faces over a point (x, z). */
    const downAt = (px: number, pz: number): number[] => {
      const ys: number[] = [];
      for (let t = 0; t < d.base.indices.length; t += 3) {
        const ks = [d.base.indices[t]!, d.base.indices[t + 1]!, d.base.indices[t + 2]!];
        if (v.getInt8(ks[0]! * SURFACE_VERTEX_BYTES + 9) >= 0) continue;
        const side = (a: number, b: number): number => (at(b, 0) - at(a, 0)) * (pz - at(a, 2)) - (at(b, 2) - at(a, 2)) * (px - at(a, 0));
        const s1 = side(ks[0]!, ks[1]!), s2 = side(ks[1]!, ks[2]!), s3 = side(ks[2]!, ks[0]!);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) ys.push(at(ks[0]!, 1));
      }
      return ys;
    };
    // Over the soffit only its raised underside; over the plain floor its underside at y 4.
    expect(downAt(1.31, 3.57)).toEqual([4.5]);
    expect(downAt(1.31, 1.57)).toEqual([4]);
    // Every base triangle faces out of a solid: a soffit's quads are wound like the rest (normals and winding agree).
    for (let t = 0; t < d.base.indices.length; t += 3) {
      const ks = [d.base.indices[t]!, d.base.indices[t + 1]!, d.base.indices[t + 2]!];
      const p = ks.map((k) => [at(k, 0), at(k, 1), at(k, 2)]);
      const e1 = p[1]!.map((c, a) => c - p[0]![a]!);
      const e2 = p[2]!.map((c, a) => c - p[0]![a]!);
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const nrm = [0, 1, 2].map((a) => v.getInt8(ks[0]! * SURFACE_VERTEX_BYTES + 8 + a));
      expect(cross.reduce((sum, c, a) => sum + c * nrm[a]!, 0)).toBeGreaterThan(0);
    }
  });

  it('joins a chunk\'s 16³ and 8³ sections into the whole chunk\'s consumers cell for cell, and the same base area in every face plane', () => {
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['balcony', sceneStore((s) => placeBalcony(s)), [[-1, 0, 0], [0, 0, 0]]],
      ['scene', sceneStore((s) => placeWallBeamBanister(s)), [[-1, 0, -1], [0, 0, 0]]],
      ['town', townStore(), [[1, 0, 1], [2, 1, 2], [3, 0, 1]]],
      ['mixed', mixedWorld(5), [[-1, -1, -1], [0, 0, -1]]],
    ];
    let reshaped = 0;
    for (const [name, store, chunks] of stores) {
      for (const [cx, cy, cz] of chunks) {
        const whole = deriveFromStore(store, cx, cy, cz, KIT_RULES);
        const wv = viewer(whole);
        const job = jobForms(store, cx, cy, cz, 0);
        for (let i = 0; i < job.forms.length; i++) if (formBaseOf(job.forms[i]!) === FORM_BASE.reshape) reshaped++;
        for (const edge of [16, 8]) {
          const ids = Array.from({ length: (E / edge) ** 3 }, (_, k) => k);
          const sections = deriveSectionsWithApron(grid, KIT_RULES, buildApron(store, cx, cy, cz, KR), (out) => store.exportChunk(cx, cy, cz, out), edge, ids).map((r) => r.assembly!);
          sections.forEach((d, id) => {
            const [ox, oy, oz] = sectionLocalOrigin(E, edge, id);
            const sv = viewer(d);
            for (let x = 0; x < edge; x++) for (let z = 0; z < edge; z++) for (let y = 0; y < edge; y++) {
              const a = sv(x, y, z);
              const b = wv(ox + x, oy + y, oz + z);
              if (JSON.stringify(a) !== JSON.stringify(b)) expect(a, `${name} chunk ${cx},${cy},${cz} ${edge}³ section ${id} cell ${x},${y},${z}`).toEqual(b);
            }
          });
          // The bodies' faces (the roofs' sloped planes are compared in roof-mesher.test.ts).
          const joined = joinSections(E, edge, sections.map((d) => bodiesOnly(d)));
          const want = areaByPlane(bodySurface(whole));
          const got = areaByPlane(joined.base);
          expect([...got.keys()].sort(), `${name} ${edge}³ planes`).toEqual([...want.keys()].sort());
          for (const [k, area] of want) expect(got.get(k), `${name} ${edge}³ plane ${k}`).toBeCloseTo(area, 6);
        }
      }
    }
    expect(reshaped).toBeGreaterThan(10);
  }, 120_000);
});
