/**
 * The plain gas draw against the voxel package's real derive, join and draw
 * batcher: a world without gas makes no program; a chunk with gas draws one
 * more mesh in its material's look; a gas-only change replaces that mesh
 * alone; the eye's layer follows the camera into and out of a bank; the
 * density overlay is a switch; what the view made is let go with it.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ALL_DERIVED_PARTS,
  buildApron,
  ChunkDrawBatcher,
  chunkGrid,
  createWorldStore,
  DERIVED_PART,
  deriveSectionsWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PLACEHOLDER_RULES,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  type ChunkDrawBatch,
  type JoinedDraw,
  type PaletteStore,
  type StreamEvent,
} from '@thirdlight/voxel';

import { wgslOf, wgslRenderer } from './test-wgsl';
import { applyChunkDrawBatch } from './voxel-batch-stage';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { GAS_DEPTH_CAP_M, GAS_EYE_FADE_M, gasEyeSlab, VOXEL_GAS_DENSITY_ATTRIBUTE, VOXEL_GAS_MATERIAL_ATTRIBUTE } from './voxel-gas-draw';
import { voxelRecordLooks, type VoxelLookRecord } from './voxel-material-looks';
import { createVoxelSurface, type VoxelGridRenderer, type VoxelSurface } from './voxel-surface';
import { voxelGasFromUrl } from './voxel-surface-path';

const grid = chunkGrid(32);
const R = jobRadius(PLACEHOLDER_RULES);
const SECTION = 16;
const MIST = 31;
const SMOKE = 32;

const RECORDS: VoxelLookRecord[] = [
  { materialId: 'mist', shader: 'standard', params: {}, voxel: { id: MIST, use: 'gas' as const, gas: { color: '#808080', density: 0.5 } } },
  { materialId: 'smoke', shader: 'standard', params: {}, voxel: { id: SMOKE, use: 'gas' as const } },
  { materialId: 'rock', shader: 'standard', params: { color: '#404040' }, voxel: { id: 2, use: 'terrain' as const } },
];

function renderer(): VoxelGridRenderer {
  return { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
}

/** Flat ground to y 3 over two chunks in x, and one above the first. */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = 0; x < 64; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 4; y++) s.setVoxel(x, y, z, { material: 2, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  return s;
}

function gas(s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, shape = 15, material = MIST): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) s.setVoxel(x, y, z, shape === 0 ? { material: 0, role: 0, shape: 0, wetness: 0 } : { material, role: VOXEL_ROLE.gas, shape, wetness: 0 });
}

function joined(s: PaletteStore, cx: number, cy: number, cz: number, cells: Uint16Array): JoinedDraw {
  const n = grid.edge / SECTION;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(s, cx, cy, cz, R), (out) => s.exportChunk(cx, cy, cz, out), SECTION, ids);
  return joinSectionsForDraw(grid.edge, SECTION, results.map((r) => r.assembly), cells);
}

/** A view fed by the real draw batcher from `s`; `emit` announces a chunk's change and applies its batch. */
function setup(s: PaletteStore, opts: { gas?: boolean } = {}): { view: VoxelChunkView; surface: VoxelSurface; batches: ChunkDrawBatch[]; parts: Map<string, number>; emit: (cx: number, cy: number, cz: number, parts?: number) => void } {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelRecordLooks(RECORDS, voxelStandInLook), blendMetres: 0.25 });
  const origin = new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } });
  const view = new VoxelChunkView({ grid, origin, surface, renderer: renderer(), ...(opts.gas === undefined ? {} : { gas: opts.gas }) });
  const listeners: Array<(e: StreamEvent) => void> = [];
  const parts = new Map<string, number>();
  const feed = {
    grid,
    on: (l: (e: StreamEvent) => void) => void listeners.push(l),
    joinedChunk: (cx: number, cy: number, cz: number, _times: unknown, cells: Uint16Array) => joined(s, cx, cy, cz, cells),
    setPart: (cx: number, cy: number, cz: number, part: string, bytes: number) => {
      parts.set(`${cx},${cy},${cz}:${part}`, bytes);
      return true;
    },
  };
  const batches: ChunkDrawBatch[] = [];
  let flush: () => void = () => {};
  const batcher = new ChunkDrawBatcher('w', feed, SECTION, (b) => {
    batches.push(b);
    const done = applyChunkDrawBatch(view, b);
    batcher.drawn(done.chunkBytes, done.coarseBytes);
  }, { schedule: (f) => (flush = f), inPlace: true });
  const emit = (cx: number, cy: number, cz: number, changed = ALL_DERIVED_PARTS): void => {
    const whole = changed === ALL_DERIVED_PARTS;
    listeners.forEach((l) => l({ type: 'chunk', cx, cy, cz, shaderOnly: !whole, reliefOnly: false, parts: changed }));
    flush();
  };
  return { view, surface, batches, parts, emit };
}

const fog = (view: VoxelChunkView): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  view.root.traverse((o) => void (o.name === 'voxel gas' && out.push(o as THREE.Mesh)));
  return out;
};

/** A camera at a point of the view's metres, looking along −z. */
function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  c.position.set(x, y, z);
  c.updateMatrixWorld(true);
  return c;
}

describe('the plain gas draw', () => {
  it('makes no program, layer or mesh for a world without gas', () => {
    const s = world();
    const { view, emit } = setup(s);
    emit(0, 0, 0);
    expect(view.has(0, 0, 0)).toBe(true);
    expect(view.gases.look.built).toBe(false);
    expect(view.gases.layer).toBeNull();
    expect(fog(view)).toEqual([]);
    expect(view.gases.triangles).toBe(0);
    // Nothing to follow: a render's update finds no gas at the eye.
    view.gases.update(cameraAt(4, 3, 4));
    expect(view.gases.eyeRun).toBeNull();
    view.dispose();
  });

  it('draws a chunk\'s gas as one more mesh in its material\'s colour and density: see-through, unlit, no shadow, counted in the chunk\'s bytes', () => {
    const s = world();
    const { view, surface, parts, emit } = setup(s);
    emit(0, 0, 0);
    const dry = parts.get('0,0,0:mesh')!;
    // A bank on the ground: 6 × 6 columns, three cells deep with a soft top (15, 11, 4).
    gas(s, 4, 9, 4, 4, 4, 9, 15);
    gas(s, 4, 9, 5, 5, 4, 9, 11);
    gas(s, 4, 9, 6, 6, 4, 9, 4);
    emit(0, 0, 0);
    const meshes = fog(view);
    expect(meshes.length).toBe(1);
    const mesh = meshes[0]!;
    // Its top and, on each of four sides, a quad a density: 13 quads.
    expect(view.gases.triangles).toBe(26);
    expect(mesh.geometry.getAttribute('position').count).toBe(52);
    const m = mesh.material as THREE.Material & { lights: boolean };
    expect([m.name, m.transparent, m.depthWrite, m.depthTest, m.side, m.lights]).toEqual(['voxel gas', true, false, true, THREE.FrontSide, false]);
    expect([mesh.castShadow, mesh.receiveShadow]).toEqual([false, false]);
    expect(view.gases.look.built).toBe(true);
    // Every vertex names the mist, and the top face carries its own density and the one under it.
    const mat = mesh.geometry.getAttribute(VOXEL_GAS_MATERIAL_ATTRIBUTE);
    const den = mesh.geometry.getAttribute(VOXEL_GAS_DENSITY_ATTRIBUTE);
    const nor = mesh.geometry.getAttribute('normal');
    const pos = mesh.geometry.getAttribute('position');
    let tops = 0;
    for (let v = 0; v < mat.count; v++) {
      expect(mat.getX(v)).toBe(MIST);
      if (nor.getY(v) !== 1) continue;
      tops++;
      expect(pos.getY(v)).toBeCloseTo(7 * VOXEL_SIZE_M, 6);
      expect(den.getX(v)).toBeCloseTo(4 / 15, 6);
      expect(den.getY(v)).toBeCloseTo(11 / 15, 6);
    }
    expect(tops).toBe(4);
    // The material table holds the record's look (linear colour, density a metre); a gas no record names shows by the defaults.
    const look = surface.tableEntry(MIST).gas;
    expect(look[3]).toBe(0.5);
    expect(look[0]).toBeCloseTo(new THREE.Color().setHex(0x808080).r, 6);
    for (const id of [SMOKE, 77]) {
      expect(surface.tableEntry(id).gas.slice(0, 3), `material ${id}`).toEqual([1, 1, 1]);
      expect(surface.tableEntry(id).gas[3], `material ${id}`).toBeCloseTo(0.1, 6);
    }
    expect(parts.get('0,0,0:mesh')).toBeGreaterThan(dry);
    // The eye's layer came with the first gas: one triangle over the screen, never culled, drawn after everything.
    const layer = view.gases.layer!;
    expect(layer.parent).toBe(view.root);
    expect([layer.frustumCulled, layer.geometry.getAttribute('position').count, (layer.material as THREE.Material).depthTest]).toEqual([false, 3, false]);
    expect(layer.renderOrder).toBeGreaterThan(mesh.renderOrder);
    view.dispose();
  });

  it('replaces the gas mesh alone when only the gas part changed: the surface mesh is the same object, no grid is uploaded', () => {
    const s = world();
    const { view, batches, emit } = setup(s);
    gas(s, 4, 9, 4, 5, 4, 9);
    emit(0, 0, 0);
    const surfaceMesh = view.root.getObjectByName('voxel-chunk 0,0,0')!.children.find((c) => c.name !== 'voxel gas') as THREE.Mesh;
    const geometry = surfaceMesh.geometry;
    const before = fog(view)[0]!;
    let disposed = 0;
    before.geometry.addEventListener('dispose', () => disposed++);
    const [builds, shaders] = [view.meshBuilds, view.shaderSets];
    // Half of it erased: a change only between gas and air.
    gas(s, 4, 6, 4, 5, 4, 9, 0);
    emit(0, 0, 0, DERIVED_PART.gas);
    expect(batches.at(-1)!.chunks.map((c) => c.kind)).toEqual(['gas']);
    expect(batches.at(-1)!.chunks[0]!.ground).toBeUndefined();
    expect([view.meshBuilds, view.shaderSets, view.gases.sets]).toEqual([builds, shaders, 1]);
    const after = fog(view)[0]!;
    expect(after).not.toBe(before);
    expect(disposed).toBe(1);
    expect(view.root.getObjectByName('voxel-chunk 0,0,0')!.children).toContain(surfaceMesh);
    expect(surfaceMesh.geometry).toBe(geometry);
    expect(view.gases.triangles).toBe(10);
    // All of it erased: the mesh goes, the chunk stays drawn, the counts come back to none.
    gas(s, 7, 9, 4, 5, 4, 9, 0);
    emit(0, 0, 0, DERIVED_PART.gas);
    expect(fog(view)).toEqual([]);
    expect(view.gases.triangles).toBe(0);
    expect(view.has(0, 0, 0)).toBe(true);
    view.dispose();
  });

  it('follows the camera into a bank: the eye\'s run joined across sections and chunks, its slab, and nothing while outside', () => {
    const s = world();
    const { view, emit } = setup(s);
    // A column of mist from the ground through the section border (y 16) and the chunk's top (y 32) to y 39.
    gas(s, 4, 9, 4, 39, 4, 9, 15);
    gas(s, 4, 9, 38, 39, 4, 9, 5);
    emit(0, 0, 0);
    emit(0, 1, 0);
    expect(view.gases.runAt(5, 20, 5)).toEqual({ y0: 4, y1: 40, material: MIST, density: (34 * 15 + 2 * 5) / (36 * 15) });
    expect(view.gases.runAt(5, 3, 5)).toBeNull();
    expect(view.gases.runAt(12, 20, 5)).toBeNull();
    const look = view.gases.look;
    // Inside, 2 m over the ground (row 8): the layer is on at the bank's mean density, the slab's top 16 m over the eye.
    view.gases.update(cameraAt(2.6, 4, 2.6));
    expect(view.gases.eyeRun).toMatchObject({ y0: 4, y1: 40 });
    expect(look.slab.x).toBeCloseTo(0.5 * ((34 * 15 + 2 * 5) / (36 * 15)), 6);
    expect([look.slab.y, look.slab.z]).toEqual([16, 2]);
    expect(look.slabColour.x).toBeCloseTo(new THREE.Color().setHex(0x808080).r, 6);
    // Just under the top it has only begun to come in; over the top, beside the bank and under the ground it is off.
    view.gases.update(cameraAt(2.6, 19.75, 2.6));
    expect(look.slab.x).toBeCloseTo(0.5 * ((34 * 15 + 2 * 5) / (36 * 15)) * (0.25 / GAS_EYE_FADE_M), 6);
    for (const p of [[2.6, 20.1, 2.6], [1.9, 4, 2.6], [2.6, 1, 2.6]] as const) {
      view.gases.update(cameraAt(p[0], p[1], p[2]));
      expect(view.gases.eyeRun, p.join(',')).toBeNull();
      expect(look.slab.x, p.join(',')).toBe(0);
    }
    // The bank erased under a camera standing in it: the next render finds no gas there.
    view.gases.update(cameraAt(2.6, 4, 2.6));
    expect(look.slab.x).toBeGreaterThan(0);
    gas(s, 4, 9, 4, 39, 4, 9, 0);
    emit(0, 0, 0, DERIVED_PART.gas);
    emit(0, 1, 0, DERIVED_PART.gas);
    view.gases.update(cameraAt(2.6, 4, 2.6));
    expect(look.slab.x).toBe(0);
    view.dispose();
  });

  it('keeps the runs of gas with no face to draw (closed in), so an eye inside it is still in fog', () => {
    const s = world();
    const { view, emit } = setup(s);
    // A sealed chamber in the ground, full of smoke.
    gas(s, 10, 13, 1, 2, 10, 13, 15, SMOKE);
    emit(0, 0, 0);
    expect(fog(view)).toEqual([]);
    expect(view.gases.layer).not.toBeNull();
    expect(view.gases.look.built).toBe(true);
    view.gases.update(cameraAt(5.6, 0.9, 5.6));
    expect(view.gases.eyeRun).toEqual({ y0: 1, y1: 3, material: SMOKE, density: 1 });
    expect(view.gases.look.slab.x).toBeGreaterThan(0);
    view.dispose();
  });

  it('gives the slab of an eye in a run, and none outside it', () => {
    const run = { y0: 4, y1: 12, material: MIST, density: 0.6 };
    expect(gasEyeSlab(run, 6, [1, 0.5, 0.25], 2)).toEqual({ perMetre: 2 * 0.6, aboveM: 3, belowM: 1, colour: [1, 0.5, 0.25] });
    expect(gasEyeSlab(run, 11.5, [1, 1, 1], 2).perMetre).toBeCloseTo(2 * 0.6 * 0.25, 6);
    expect(gasEyeSlab(run, 12, [1, 1, 1], 2).perMetre).toBe(0);
    expect(gasEyeSlab(run, 3.9, [1, 1, 1], 2).perMetre).toBe(0);
    expect(gasEyeSlab(null, 6, [1, 1, 1], 2).perMetre).toBe(0);
    expect(GAS_DEPTH_CAP_M).toBeGreaterThan(0);
  });

  it('switches the density overlay with no new mesh or program, and turns the eye\'s layer off under it', () => {
    const s = world();
    const { view, emit } = setup(s);
    gas(s, 4, 9, 4, 9, 4, 9);
    emit(0, 0, 0);
    const mesh = fog(view)[0]!;
    const material = mesh.material;
    expect(view.gases.look.overlay).toBe(false);
    view.gases.setOverlay(true);
    expect(view.gases.look.overlay).toBe(true);
    expect(fog(view)[0]).toBe(mesh);
    expect(mesh.material).toBe(material);
    view.gases.setOverlay(false);
    expect(view.gases.look.overlay).toBe(false);
    view.dispose();
  });

  it('builds both programs: the hull reads the scene\'s depth and the material table and no light; the layer is a clip-space triangle', () => {
    const s = world();
    const { view, emit } = setup(s);
    gas(s, 4, 9, 4, 9, 4, 9);
    emit(0, 0, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.DirectionalLight(0xffffff, 1));
    scene.add(view.root);
    const r = wgslRenderer();
    // The scene's depth copy asks the backend for the renderer's sample count, which a build-only renderer's backend lacks.
    (r as unknown as { backend: { renderer: unknown } }).backend.renderer = r;
    const hull = wgslOf(r, scene, fog(view)[0]!);
    expect(hull).toContain('texture_depth_2d');
    expect(hull).toContain(VOXEL_GAS_DENSITY_ATTRIBUTE);
    expect(hull).not.toMatch(/DirectionalLight|shadow/i);
    const layer = wgslOf(r, scene, view.gases.layer!);
    expect(layer).toContain('texture_depth_2d');
    expect(layer).not.toMatch(/modelViewMatrix|DirectionalLight/);
    view.dispose();
  });

  it('draws no gas where the page asks for none (a cost comparison), and lets go of what it made with the view', () => {
    expect([voxelGasFromUrl(''), voxelGasFromUrl('?voxelGas=off'), voxelGasFromUrl('?voxelGas=1')]).toEqual([true, false, true]);
    const s = world();
    gas(s, 4, 9, 4, 9, 4, 9);
    const off = setup(s, { gas: false });
    off.emit(0, 0, 0);
    expect(fog(off.view)).toEqual([]);
    expect(off.view.gases.look.built).toBe(false);
    expect(off.view.gases.layer).toBeNull();
    off.view.gases.update(cameraAt(2.6, 3, 2.6));
    expect(off.view.gases.eyeRun).toBeNull();
    off.view.dispose();

    const { view, emit } = setup(s);
    emit(0, 0, 0);
    const mesh = fog(view)[0]!;
    const layer = view.gases.layer!;
    // Both programs made (the layer's with its first draw's ask).
    const gone: string[] = [];
    mesh.geometry.addEventListener('dispose', () => gone.push('hull geometry'));
    (mesh.material as THREE.Material).addEventListener('dispose', () => gone.push('hull program'));
    layer.geometry.addEventListener('dispose', () => gone.push('layer geometry'));
    (layer.material as THREE.Material).addEventListener('dispose', () => gone.push('layer program'));
    view.dispose();
    expect(gone.sort()).toEqual(['hull geometry', 'hull program', 'layer geometry', 'layer program']);
    expect(layer.parent).toBeNull();
    expect(view.gases.layer).toBeNull();
    expect(view.gases.look.built).toBe(false);
    expect(view.gases.triangles).toBe(0);
  });
});
