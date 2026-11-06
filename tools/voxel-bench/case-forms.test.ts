/**
 * The consumers read the case: every cell's render occupancy, collision,
 * navigation, light coverage, base surface and piece follow its form (its
 * case's declared coarse shape and base, case-forms.ts), never a piece
 * mesh — checked cell by cell against the real derive on the town, the
 * hand scenes and random worlds, at chunk-tree levels 0, 1 and 2; and a
 * chunk's 16³ and 8³ sections giving the whole chunk's consumers cell for
 * cell and the same base surface area in every face plane.
 */
import {
  ASSEMBLY_CLASS,
  buildApron,
  cellBit,
  classifyRoofs,
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
  EDGE_CASE_CATALOGUE,
  EDGE_RULES,
  evaluateAssembly,
  evaluateCases,
  evaluateForms,
  fillNeighbourhood,
  FORM_BASE,
  FORM_BODY,
  FORM_SHAPE,
  formBaseOf,
  formBox,
  formCoverage,
  formShapeOf,
  formSupports,
  INSTANCE_BYTES,
  jobRadius,
  levelDrawsPieces,
  joinSections,
  LIGHT_COVERAGE,
  MipTree,
  NO_CASE,
  OCCUPANCY,
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
const KR = jobRadius(EDGE_RULES);
const S = COLLISION_STEPS_PER_CELL;

type ChunkSource = Parameters<typeof buildApron>[0] & Pick<PaletteStore, 'exportChunk'>;

/** The job's classes and forms of a chunk (or a level's node) under the world rules, the evaluation a derive runs. */
function jobForms(src: ChunkSource, cx: number, cy: number, cz: number, level: number): { n: ReturnType<typeof createNeighbourhood>; classes: Uint8Array; cases: Uint16Array; forms: Uint8Array; roofs: Uint32Array } {
  const n = createNeighbourhood(E, KR);
  const dense = createDenseChunk(grid);
  fillNeighbourhood(n, grid, src.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(src, cx, cy, cz, KR));
  const classes = new Uint8Array(n.values.length);
  evaluateAssembly(n, EDGE_RULES, classes);
  const cases = new Uint16Array(n.values.length);
  evaluateCases(n, EDGE_RULES, level, cases);
  const forms = new Uint8Array(n.values.length);
  evaluateForms(n, EDGE_RULES, classes, cases, forms);
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
    pieces.set((data[o]! * e + data[o + 2]!) * e + data[o + 1]!, `${data[o + 4]! | (data[o + 5]! << 8)}`);
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

/**
 * What a cell's form (and, for ground, its density) says each consumer
 * receives, derived without a kit (no piece anywhere). A roof's plane cell
 * (`plane`) collides as the roof's ramp; light, navigation and occupancy
 * read its voxel.
 */
function expected(n: ReturnType<typeof createNeighbourhood>, classes: Uint8Array, forms: Uint8Array, i: number, plane = false): Omit<CellView, 'standable'> {
  const f = forms[i]!;
  const ground = (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground;
  const solidGround = ground && n.shapes[i]! >= SURFACE_ISO;
  const shape = formShapeOf(f);
  const box = [0, 0, 0, 0, 0, 0];
  return {
    light: ground ? n.shapes[i]! : formCoverage(f),
    blocks: shape !== FORM_SHAPE.none || solidGround,
    solid: shape === FORM_SHAPE.box || solidGround,
    collision: plane ? 'none' : shape === FORM_SHAPE.box ? 'full' : formBox(f, box) ? box.join(',') : 'none',
    piece: null,
  };
}

/** Compares every cell of a derived chunk (or node) with what its forms say; returns the cells checked and those with a case. */
function checkAgainstForms(d: DerivedData, job: ReturnType<typeof jobForms>, at: string): { cells: number; withCase: number; shapes: Set<number> } {
  const view = viewer(d);
  const { n, classes, forms, cases, roofs } = job;
  const s = n.side;
  const p = n.pad;
  let withCase = 0;
  const shapes = new Set<number>();
  for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    const got = view(x, y, z);
    const want = expected(n, classes, forms, i, roofs[i] !== 0);
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
  it('declares each shape once, in the case\'s own orientation; light is its share of the cell; a beam, rail or post class is a plain voxel (the body)', () => {
    expect(LIGHT_COVERAGE).toEqual({ none: 0, box: 255, panel: 64, bar: 100, post: 16 });
    // Beams and banisters left the voxel world: the placeholder classes keep their names, every consumer draws them as the body.
    for (const cls of [ASSEMBLY_CLASS.beam | RUN_X, ASSEMBLY_CLASS.beam | RUN_Z, ASSEMBLY_CLASS.rail | RUN_X, ASSEMBLY_CLASS.rail | RUN_Z, ASSEMBLY_CLASS.rail | RUN_X | RUN_Z]) expect(classForm(cls), `class ${cls}`).toBe(FORM_BODY);
    expect(formShapeOf(classForm(ASSEMBLY_CLASS.wall))).toBe(FORM_SHAPE.box);
    expect(formShapeOf(classForm(ASSEMBLY_CLASS.ground))).toBe(FORM_SHAPE.none);
    // The world catalogue: every case (edges, roof edges, damage) keeps a whole cell.
    for (const c of EDGE_CASE_CATALOGUE.cases) expect(`${c.base}/${c.shape}`, c.id).toBe('keep/box');
  });

  it('gives every consumer the cell\'s form, never a piece: town, scenes and random worlds at level 0 (cases) and levels 1 and 2 (classes)', () => {
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['scene', sceneStore((s) => placeWallBeamBanister(s)), [[-1, 0, -1], [0, 0, 0], [-1, 0, 0], [-1, -1, -1]]],
      ['balcony', sceneStore((s) => placeBalcony(s)), [[-1, 0, 0], [0, 0, 0]]],
      ['town', townStore(), [[0, 0, 0], [1, 0, 1], [2, 1, 2], [3, 0, 1], [1, 1, 3]]],
      ['mixed', mixedWorld(3), [[-1, -1, -1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]]],
      ['mixed', mixedWorld(8), [[-1, -1, -1], [0, 0, 0], [-1, 0, -1]]],
    ];
    let withCase = 0;
    const shapes = new Set<number>();
    for (const [name, store, chunks] of stores) {
      const tree = new MipTree(store);
      for (const [cx, cy, cz] of chunks) {
        const r = checkAgainstForms(deriveFromStore(store, cx, cy, cz, EDGE_RULES), jobForms(store, cx, cy, cz, 0), `${name} chunk ${cx},${cy},${cz}`);
        withCase += r.withCase;
        for (const k of r.shapes) shapes.add(k);
        for (const level of [1, 2]) {
          const node = { level, nx: cx >> level, ny: cy >> level, nz: cz >> level };
          const d = deriveMipNode(tree, node, EDGE_RULES);
          const job = jobForms(tree.level(level), node.nx, node.ny, node.nz, level);
          const rr = checkAgainstForms(d, job, `${name} level ${level} node ${node.nx},${node.ny},${node.nz}`);
          // No pieces past level 0, so no cases there either.
          expect(rr.withCase).toBe(0);
        }
      }
    }
    // The world catalogue has no window rules (edges are the edge pass's): no cell carries a window case.
    expect(withCase).toBe(0);
    // Whole cells and open space only: no thin shape stands in for a beam or banister.
    expect([...shapes].sort()).toEqual([FORM_SHAPE.none, FORM_SHAPE.box].sort());
  }, 120_000);

  it('joins a chunk\'s 16³ and 8³ sections into the whole chunk\'s consumers cell for cell, and the same base area in every face plane', () => {
    const stores: Array<[string, PaletteStore, Array<[number, number, number]>]> = [
      ['balcony', sceneStore((s) => placeBalcony(s)), [[-1, 0, 0], [0, 0, 0]]],
      ['scene', sceneStore((s) => placeWallBeamBanister(s)), [[-1, 0, -1], [0, 0, 0]]],
      ['town', townStore(), [[1, 0, 1], [2, 1, 2], [3, 0, 1]]],
      ['mixed', mixedWorld(5), [[-1, -1, -1], [0, 0, -1]]],
    ];
    for (const [name, store, chunks] of stores) {
      for (const [cx, cy, cz] of chunks) {
        const whole = deriveFromStore(store, cx, cy, cz, EDGE_RULES);
        const wv = viewer(whole);
        for (const edge of [16, 8]) {
          const ids = Array.from({ length: (E / edge) ** 3 }, (_, k) => k);
          const sections = deriveSectionsWithApron(grid, EDGE_RULES, buildApron(store, cx, cy, cz, KR), (out) => store.exportChunk(cx, cy, cz, out), edge, ids).map((r) => r.assembly!);
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
  }, 120_000);
});
