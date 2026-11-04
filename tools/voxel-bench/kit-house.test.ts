/**
 * The placeholder kits on the walls a builder makes: a one-cell-thick house
 * (runs of 7 m and 5 m, four outside corners, a T wall inside with a free
 * end, a door and a window) through the real derive with the committed log
 * and stone kits and the real GLB geometry. Pins the placement convention
 * end to end: a case's piece, authored with its front toward +z and its run
 * along +x, lands turned (and mirrored) by the instance onto the world so
 * that its front faces open air, its run follows the wall, and no part of
 * it stands inside a neighbouring solid cell.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DRAFT_TRIM_LAYOUT, voxelKitMeshFacts, type VoxelKit, type VoxelKitMeshFacts } from '@thirdlight/project-model';
import { createVoxelSurface, PIECE_U_ATTRIBUTE, TRIM_RUN_ATTRIBUTE, trimUPerMetre, VoxelChunkView, VoxelKitMeshes, voxelStandInLook } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { applyFold, chunkGrid, createWorldStore, deriveFromStore, FloatingOrigin, joinSectionsForDraw, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, WETNESS_MAX, DRAFT_CASE_CATALOGUE, INSTANCE_BYTES, KIT_PIECE_BASE, kitPieceList, PIECE_VARIANT_MASK, PIECE_VARIANT_MIRROR, VOXEL_ROLE, VOXEL_SIZE_M, WORLD_RULES, worldPieceTable, type PaletteStore } from '@thirdlight/voxel';
import { caseAndSectionAt } from './case-probe';
import { flatGround, putVoxel } from './scenes';
import { MAT } from './world-kit';

const DIR = join(import.meta.dirname, 'kits');
const grid = chunkGrid(32);
const R = VOXEL_ROLE;
const M = VOXEL_SIZE_M;

/** A one-cell-thick house on flat ground: walls x 2…15 by z 2…11, 6 high; a T wall at x 9 from the front wall to z 7; a door (x 5–6, y 0–3) and a window (x 11–12, y 2–3) in the front wall. */
function house(s: PaletteStore, m: number): void {
  flatGround(s, 0, 32, 0, 32, 3, 0);
  const wall = (x: number, y: number, z: number): void => putVoxel(s, x, y, z, m, R.wall);
  for (let y = 0; y < 6; y++) {
    for (let x = 2; x < 16; x++) {
      wall(x, y, 2);
      wall(x, y, 11);
    }
    for (let z = 2; z < 12; z++) {
      wall(2, y, z);
      wall(15, y, z);
    }
    for (let z = 3; z < 8; z++) wall(9, y, z);
  }
  for (let x = 5; x < 7; x++) for (let y = 0; y < 4; y++) putVoxel(s, x, y, 2, m, R.opening);
  for (let x = 11; x < 13; x++) for (let y = 2; y < 4; y++) putVoxel(s, x, y, 2, m, R.opening);
}

interface Placed {
  cell: [number, number, number];
  caseId: string;
  pieceCase: string;
  fold: number;
  /** World cells (offsets from the piece's own) that triangle centres of the piece stand well inside, and whether each is solid. */
  into: Map<string, boolean>;
}

function solidAt(s: PaletteStore, x: number, y: number, z: number): boolean {
  const v = s.voxelAt(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
  return v.material !== 0 && v.role !== R.opening && v.role !== R.air;
}

function kitFiles(id: 'log' | 'stone'): { kit: VoxelKit; glb: Uint8Array } {
  return { kit: JSON.parse(readFileSync(join(DIR, `${id}.voxelkit.json`), 'utf8')) as VoxelKit, glb: new Uint8Array(readFileSync(join(DIR, `voxel-kit-${id}.glb`))) };
}

function placed(id: 'log' | 'stone', material: number): { store: PaletteStore; pieces: Map<string, Placed> } {
  const { kit, glb } = kitFiles(id);
  const store = createWorldStore(grid);
  house(store, material);
  const d = deriveFromStore(store, 0, 0, 0, WORLD_RULES, undefined, worldPieceTable([kit]));
  const list = kitPieceList(kit, DRAFT_CASE_CATALOGUE).pieces;
  const facts = new Map<string, VoxelKitMeshFacts>();
  const out = new Map<string, Placed>();
  const b = d.instances.data;
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    const cell: [number, number, number] = [b[o]!, b[o + 1]!, b[o + 2]!];
    const piece = b[o + 4]! | (b[o + 5]! << 8);
    if (piece < KIT_PIECE_BASE) continue;
    const word = b[o + 6]! | (b[o + 7]! << 8);
    const fold = (b[o + 3]! & 3) + ((word & PIECE_VARIANT_MIRROR) !== 0 ? 4 : 0);
    const pc = list[piece - KIT_PIECE_BASE]!;
    const node = kit.cases[pc.caseId]!.sections![pc.sectionId]!.variants[word & PIECE_VARIANT_MASK]!.high.node!;
    let f = facts.get(node);
    if (f === undefined) facts.set(node, (f = voxelKitMeshFacts(glb, node)));
    const into = new Map<string, boolean>();
    const P = f.positions;
    for (let i = 0; i < P.length; i += 9) {
      // The instance's transform as the renderer applies it: mirror x, then quarter turns taking +x to +z.
      const [px, py, pz] = applyFold(fold, [(P[i]! + P[i + 3]! + P[i + 6]!) / 3, (P[i + 1]! + P[i + 4]! + P[i + 7]!) / 3, (P[i + 2]! + P[i + 5]! + P[i + 8]!) / 3]);
      const w = [(cell[0] + 0.5) * M + px, (cell[1] + 0.5) * M + py, (cell[2] + 0.5) * M + pz];
      const c = w.map((q) => Math.floor(q / M));
      // Well inside: a centre on or near a cell face belongs to neither side.
      if (c.every((q, a) => q === cell[a]) || !w.every((q, a) => q - c[a]! * M > 0.01 && q - c[a]! * M < M - 0.01)) continue;
      into.set(`${c[0]! - cell[0]},${c[1]! - cell[1]},${c[2]! - cell[2]}`, solidAt(store, c[0]!, c[1]!, c[2]!));
    }
    out.set(cell.join(','), { cell, caseId: caseAndSectionAt(store, ...cell).caseId!, pieceCase: pc.caseId, fold, into });
  }
  return { store, pieces: out };
}

/** Where a case direction lands on the world under a fold. */
const dir = (fold: number, d: [number, number, number]): string => applyFold(fold, d).join(',');
/** A direction's axis, sign dropped. */
const axis = (fold: number, d: [number, number, number]): string => applyFold(fold, d).map(Math.abs).join(',');

describe.each([
  ['log', MAT.timber],
  ['stone', MAT.stone],
] as const)('the %s kit on a one-cell-thick house', (id, material) => {
  const { store, pieces } = placed(id, material);
  const at = (x: number, y: number, z: number): Placed => {
    const p = pieces.get(`${x},${y},${z}`);
    if (p === undefined) throw new Error(`no ${id} piece at ${x},${y},${z} (case ${caseAndSectionAt(store, x, y, z).caseId})`);
    return p;
  };

  it('never stands a piece inside a solid neighbour: every part outside its own cell is in open air', () => {
    const inSolid = [...pieces.values()].filter((p) => [...p.into.values()].some((solid) => solid)).map((p) => `${p.cell.join(',')} ${p.caseId}→${p.pieceCase} fold ${p.fold}: ${[...p.into].filter(([, s]) => s).map(([k]) => k).join(' ')}`);
    expect(inSolid).toEqual([]);
    expect(pieces.size).toBeGreaterThan(200);
  });

  it('dresses both faces of a thin wall along the wall (its foot too), and turns the front onto the wall face at lintels, sills and jambs', () => {
    for (const [x, y, z, along] of [[10, 3, 11, 'x'], [10, 0, 11, 'x'], [4, 4, 2, 'x'], [15, 2, 6, 'z'], [2, 3, 8, 'z'], [9, 2, 5, 'z']] as const) {
      const p = at(x, y, z);
      expect(p.caseId, `${x},${y},${z}`).toBe('wall-thin');
      expect(axis(p.fold, [1, 0, 0]), `${x},${y},${z} run`).toBe(along === 'x' ? '1,0,0' : '0,0,1');
    }
    for (const [x, y, z, c] of [[11, 1, 2, 'wall-sill'], [12, 4, 2, 'wall-lintel'], [5, 4, 2, 'wall-lintel'], [4, 1, 2, 'wall-jamb'], [7, 2, 2, 'wall-jamb']] as const) {
      const p = at(x, y, z);
      expect(p.caseId).toBe(c);
      expect(axis(p.fold, [0, 0, 1]), `${x},${y},${z} front`).toBe('0,0,1');
    }
    expect(axis(at(15, 5, 6).fold, [1, 0, 0])).toBe('0,0,1');
    expect(axis(at(10, 5, 11).fold, [1, 0, 0])).toBe('1,0,0');
  });

  it("puts a corner piece on each outside corner with its two faces (+x, +z) on the two open sides, and the T wall's free end out of its end", () => {
    for (const [x, z, open] of [[2, 2, ['-1,0,0', '0,0,-1']], [15, 2, ['1,0,0', '0,0,-1']], [2, 11, ['-1,0,0', '0,0,1']], [15, 11, ['1,0,0', '0,0,1']]] as const) {
      for (let y = 0; y < 6; y++) {
        const p = at(x, y, z);
        expect(p.caseId, `${x},${y},${z}`).toBe('wall-corner');
        expect([dir(p.fold, [1, 0, 0]), dir(p.fold, [0, 0, 1])].sort(), `${x},${y},${z}`).toEqual([...open].sort());
      }
    }
    for (let y = 1; y < 5; y++) {
      const p = at(9, y, 7);
      expect(p.caseId).toBe('wall-end');
      expect(dir(p.fold, [1, 0, 0])).toBe('0,0,1');
    }
  });

  if (id === 'stone') {
    it("frames the door and window in the wall's plane: heads, sills and thresholds run along the wall", () => {
      for (const [x, y, c] of [[5, 0, 'opening-threshold'], [6, 3, 'opening-head'], [11, 2, 'opening-sill'], [12, 3, 'opening-head']] as const) {
        const p = at(x, y, 2);
        expect(p.caseId).toBe(c);
        expect(axis(p.fold, [1, 0, 0]), `${x},${y} run`).toBe('1,0,0');
      }
    });
  }
});

describe('trim pieces drawn with world-anchored U', () => {
  it.each([
    ['log', MAT.timber],
    ['stone', MAT.stone],
  ] as const)('the %s kit: every run face of every drawn instance reads U from its world position along the run, whatever its turn, mirror or cell', async (id, material) => {
    const { kit, glb } = kitFiles(id);
    const store = createWorldStore(grid);
    house(store, material);
    const table = worldPieceTable([kit]);
    const meshes = new VoxelKitMeshes();
    try {
      const loaded = await meshes.load([kit], async () => ({ bytes: glb, version: 1 }), createGltfLoaderPort());
      expect(loaded.failed).toEqual([]);
      const surface = createVoxelSurface({ cellMetres: M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
      const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
      const v = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, kits: meshes.set(table, [kit]) });
      const d = deriveFromStore(store, 0, 0, 0, WORLD_RULES, undefined, table);
      const j = joinSectionsForDraw(grid.edge, grid.edge, [d], v.cells);
      v.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid }, 0);
      v.root.updateMatrixWorld(true);
      const perM = trimUPerMetre(DRAFT_TRIM_LAYOUT);
      const draws = v.root.children.flatMap((g) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.geometry.getAttribute(PIECE_U_ATTRIBUTE) !== undefined));
      expect(draws.length).toBeGreaterThan(5);
      const offsets = new Set<string>();
      let checked = 0;
      let worst = 0;
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const x = new THREE.Vector3();
      for (const mesh of draws) {
        const g = mesh.geometry;
        const pos = g.getAttribute('position');
        const uvs = g.getAttribute('uv');
        const run = g.getAttribute(TRIM_RUN_ATTRIBUTE);
        const pu = g.getAttribute(PIECE_U_ATTRIBUTE);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          m.premultiply(mesh.matrixWorld);
          // The world axis the drawn mesh's +x lies on (instances turn by quarters about +y).
          x.set(1, 0, 0).transformDirection(m);
          const axis = Math.abs(x.x) > 0.5 ? 'x' : 'z';
          offsets.add(pu.getX(i).toFixed(4));
          for (let k = 0; k < pos.count; k++) {
            if (run.getX(k) !== 1) continue;
            p.fromBufferAttribute(pos, k).applyMatrix4(m);
            const want = perM * p[axis];
            const got = pu.getX(i) + pu.getY(i) * uvs.getX(k);
            const off = Math.abs(got - want - Math.round(got - want));
            worst = Math.max(worst, off);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      // Within a texel of a 4096 sheet: the authored U is within the kit check's 0.002.
      expect(worst).toBeLessThan(0.0025);
      // Cells along a 7 m run take every eighth of the sheet, not just its first (the authored 0.5 m).
      expect(offsets.size).toBeGreaterThanOrEqual(8);
    } finally {
      meshes.dispose();
    }
  });
});
