/**
 * The fill tools' and the fog brush's arithmetic: what is sent is read back as the backend reads it
 * (`canonicalEditCommand`, the project model's checks), the cells a fog stroke names are checked against made
 * values, and the reach the panel states is the command's own bound.
 */
import type { ModelErrorV2 } from '@thirdlight/project-model';
import { validateMaterialVoxel } from '@thirdlight/project-model/voxel-materials';
import { canonicalEditCommand, chunkGrid, editChunks, EditRefused, recordValue, SHAPE_FULL, valueShape, VOXEL_ROLE, type BrushEdit, type DigEdit, type FloodEdit, type SetEdit } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { CELL_NOT_LOADED } from '../voxel-world/scene-voxels-wire';
import { FOG_BRUSH_BOUNDS, GAS_PALETTE_USES, LIQUID_PALETTE_USES, PAINT_PALETTE_USES, voxelPalette, voxelStrokeCommand } from './voxel-brush';
import { cellMiddleM, dabsBox, draggedLevelM, fogCells, fogCellsCommand, fogDensity, floodCommand, floodReachBoundM, gasValue, leakMessage, metresPerPixel, seedCell, snapLevelM, splineCreate, splineStartVoxels, waterBodyCreate } from './voxel-fill';
import { densityPercent, gasOverlayShown, paletteTiles, paintsFog, starterMedium, WORLD_BRUSH_START, worldBrushArming, type WorldPalettes } from './world-mode';

describe('a fill is one flood command', () => {
  it('fog: the seed, the level in cells, the gas, the reach in cells and the fade in metres, as the backend reads them', () => {
    const c = canonicalEditCommand(floodCommand({ grid: 0, seed: [4, -3, 9], levelM: 1.25, gas: 40, reachM: 32, fadeM: 1.5 })) as FloodEdit;
    expect(c).toEqual({ v: 3, grid: 0, kind: 'flood', seed: [4, -3, 9], level: 2.5, value: { material: 40, role: VOXEL_ROLE.gas }, reach: 64, fade: 1.5 });
    // No fade: the field is left out (the command refuses a fade of 0).
    expect(canonicalEditCommand(floodCommand({ grid: 0, seed: [0, 0, 0], levelM: 2, gas: 40, reachM: 8, fadeM: 0 }))).not.toHaveProperty('fade');
  });

  it('a drain is the same flood with air, and never a fade', () => {
    const c = canonicalEditCommand(floodCommand({ grid: 0, seed: [1, 2, 3], levelM: 3, gas: null, reachM: 10, fadeM: 2 })) as FloodEdit;
    expect(c.value).toEqual({ material: 0, role: 0 });
    expect(c.fade).toBeUndefined();
    expect(c.reach).toBe(20);
  });

  it('the reach the panel states is the bound of one stroke: a flood at it is taken, one well past it is over budget', () => {
    const bound = floodReachBoundM();
    expect(bound).toBeGreaterThanOrEqual(WORLD_BRUSH_START.reach);
    const grid = chunkGrid(32);
    const at = (reachM: number): (() => unknown) => () => editChunks(grid, canonicalEditCommand(floodCommand({ grid: 0, seed: [0, 0, 0], levelM: 16, gas: 1, reachM, fadeM: 0 })));
    expect(at(bound)).not.toThrow();
    expect(at(bound * 2)).toThrow(EditRefused);
  });

  it('the seed is the open cell in front of the face met; a level lands on quarter metres and follows the drag by the view\'s scale', () => {
    expect(seedCell([3, -1, 7], [0, 1, 0])).toEqual([3, 0, 7]);
    expect(seedCell([3, 2, 7], [-1, 0, 0])).toEqual([2, 2, 7]);
    expect(cellMiddleM([3, 0, 7])).toEqual([1.75, 0.25, 3.75]);
    expect(snapLevelM(1.13)).toBe(1.25);
    expect(snapLevelM(-0.1)).toBe(0);
    // 60° of view over 600 px, 20 m away: a pixel is 20 · 2 tan 30° ÷ 600 metres.
    const px = metresPerPixel(60, 600, 20);
    expect(px).toBeCloseTo((40 * Math.tan(Math.PI / 6)) / 600, 12);
    expect(draggedLevelM(2, 100, px)).toBe(snapLevelM(2 + 100 * px));
    expect(draggedLevelM(2, -30, px)).toBeLessThan(2);
  });

  it('a refused flood\'s places are said in words', () => {
    expect(leakMessage('The fog', [{ at: [5.25, 0.75, -3], kind: 'reach', cells: 4 }, { at: [1, 1, 1], kind: 'reach', cells: 1 }])).toMatch(/^The fog leaks past its reach at 2 places, first at \(5\.3, 0\.8, -3\.0\) m: nothing was written/);
    expect(leakMessage('The drain', [{ at: [0, 0, 0], kind: 'world', cells: 1 }])).toMatch(/leaks out of the world at 1 place,/);
  });
});

describe('water and splines are objects made by createEntity', () => {
  it('a water body at the seed cell\'s middle with the level and the liquid, its reach left to the component', () => {
    const args = waterBodyCreate({ sceneId: 'scene-main', world: 'yard', seed: [-10, -4, 6], levelM: -0.75, material: 30 });
    expect(args).toEqual({ sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Water', transform: { position: [-4.75, -1.75, 3.25] }, components: { waterBody: { world: 'yard', level: -0.75, material: 30 } } });
    expect(waterBodyCreate({ sceneId: null, world: 'yard', seed: [0, 0, 0], levelM: 1, material: 3 })).not.toHaveProperty('sceneId');
  });

  it('a spline from the drag\'s start to its end with its voxels preset; a click is no stretch; no material, no start', () => {
    expect(splineStartVoxels('road', 7, 30)).toEqual({ kind: 'road', material: 7, bed: { material: 7, depth: 1 } });
    expect(splineStartVoxels('path', 7, null)).toEqual({ kind: 'path', material: 7, bed: { material: 7, depth: 1 } });
    expect(splineStartVoxels('river', 7, 30)).toEqual({ kind: 'river', material: 30 });
    expect(splineStartVoxels('river', 7, null)).toBeNull();
    expect(splineStartVoxels('road', null, 30)).toBeNull();
    const made = splineCreate({ sceneId: 's', from: [2.25, 0, -3.75], to: [10.25, 0.5, -3.75], voxels: splineStartVoxels('path', 7, null)! });
    expect(made).toEqual({ sceneId: 's', parentId: null, kind: 'group', name: 'Path', transform: { position: [2.25, 0, -3.75] }, components: { spline: { points: [{ at: [0, 0, 0] }, { at: [8, 0.5, 0] }], width: 1.5, voxels: { kind: 'path', material: 7, bed: { material: 7, depth: 1 } } } } });
    expect(splineCreate({ sceneId: 's', from: [0, 0, 0], to: [0.5, 3, 0.5], voxels: splineStartVoxels('road', 7, null)! })).toBeNull();
  });
});

describe('the fog brush names its cells', () => {
  const GROUND = recordValue(5, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
  const WALL = recordValue(6, VOXEL_ROLE.wall, SHAPE_FULL, 0);
  const WATER = recordValue(30, VOXEL_ROLE.liquid, SHAPE_FULL, 0);
  const DOOR = recordValue(6, VOXEL_ROLE.opening, 0, 0);
  const MIST = gasValue(40, 8);
  const SMOKE = gasValue(41, 15);
  // Ground under y = 0 with water in x ≥ 3 of its top row, air over it, a wall and a doorway, two gases, a cell not loaded.
  const world = (x: number, y: number, z: number): number => {
    if (x === 2 && y === 2 && z === 0) return CELL_NOT_LOADED;
    if (y < -1) return GROUND;
    if (y === -1) return x >= 3 ? WATER : GROUND;
    if (x === -2 && z === 0) return y === 0 ? DOOR : WALL;
    if (x === 0 && y === 1 && z === 0) return MIST;
    if (x === 1 && y === 1 && z === 0) return SMOKE;
    return 0;
  };
  const dabs: [number, number, number][] = [[0, 0, 0], [3, 0, 0]];
  const across = 5;
  const box = dabsBox(dabs, across)!;
  const values = new Uint32Array((box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1));
  let i = 0;
  for (let x = box.min[0]; x <= box.max[0]; x++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let y = box.min[1]; y <= box.max[1]; y++) values[i++] = world(x, y, z);
  const triples = (flat: readonly number[]): [number, number, number][] => Array.from({ length: flat.length / 3 }, (_, k) => [flat[k * 3]!, flat[k * 3 + 1]!, flat[k * 3 + 2]!]);

  it('reads the box its dabs can cover', () => {
    expect(box).toEqual({ min: [-2, -2, -2], max: [5, 2, 2] });
    expect(dabsBox([], 5)).toBeNull();
  });

  it('paint names only open cells under the dabs: air and gas (but the fog already there), never ground, a wall, a doorway, water or a cell not loaded', () => {
    const cells = triples(fogCells({ kind: 'fog', shape: 'sphere', across, dabs, box, values, value: MIST }));
    expect(cells.length).toBeGreaterThan(20);
    for (const [x, y, z] of cells) {
      const v = world(x, y, z);
      expect(v === 0 || v === SMOKE, `${x},${y},${z} = ${v}`).toBe(true);
      // Within a dab's ball of 2.5 cells.
      expect(dabs.some((d) => (x - d[0]) ** 2 + (y - d[1]) ** 2 + (z - d[2]) ** 2 <= 2.5 ** 2)).toBe(true);
    }
    const has = (x: number, y: number, z: number): boolean => cells.some((c) => c[0] === x && c[1] === y && c[2] === z);
    expect(has(1, 1, 0)).toBe(true); // another gas: painted over
    expect(has(0, 1, 0)).toBe(false); // this fog at this density already
    expect(has(0, -1, 0)).toBe(false); // ground
    expect(has(4, -1, 0)).toBe(false); // water
    expect(has(-2, 0, 0)).toBe(false); // a doorway
    expect(has(-2, 1, 0)).toBe(false); // a wall
    expect(has(2, 2, 0)).toBe(false); // not loaded
    // Each cell once, though the dabs overlap.
    expect(new Set(cells.map((c) => c.join())).size).toBe(cells.length);
    // At another density the fog already there is rewritten.
    expect(triples(fogCells({ kind: 'fog', shape: 'sphere', across, dabs, box, values, value: gasValue(40, 3) })).some((c) => c.join() === '0,1,0')).toBe(true);
  });

  it('erase names only gas cells, of any gas; a box brush covers its whole cube', () => {
    expect(triples(fogCells({ kind: 'fog-erase', shape: 'sphere', across, dabs, box, values, value: 0 })).map((c) => c.join()).sort()).toEqual(['0,1,0', '1,1,0']);
    const cube = triples(fogCells({ kind: 'fog', shape: 'box', across: 3, dabs: [[0, 3, 0]], box: { min: [-1, 2, -1], max: [1, 4, 1] }, values: new Uint32Array(27), value: MIST }));
    expect(cube.length).toBe(27);
    // A disc of 2.5 cells: the square's four corner columns are outside it, at every row.
    const disc = triples(fogCells({ kind: 'fog', shape: 'cylinder', across: 5, dabs: [[0, 4, 0]], box: { min: [-2, 2, -2], max: [2, 6, 2] }, values: new Uint32Array(125), value: MIST }));
    expect(disc.length).toBe(21 * 5);
  });

  it('the stroke is one command the backend reads: a set of the gas at the density, dry, or a dig of the cells; none when no cell is named', () => {
    const cells = fogCells({ kind: 'fog', shape: 'sphere', across, dabs, box, values, value: MIST });
    const set = canonicalEditCommand(fogCellsCommand({ grid: 0, kind: 'fog', cells, material: 40, density: 8 })) as SetEdit;
    expect(set.kind).toBe('set');
    expect(set.voxel).toEqual({ material: 40, role: VOXEL_ROLE.gas, wetness: 0, shape: 8 });
    expect(set.cells.length).toBe(cells.length);
    const dig = canonicalEditCommand(fogCellsCommand({ grid: 0, kind: 'fog-erase', cells: [0, 1, 0, 1, 1, 0], material: 40, density: 8 })) as DigEdit;
    expect(dig).toMatchObject({ kind: 'dig', cells: [0, 1, 0, 1, 1, 0] });
    expect(fogCellsCommand({ grid: 0, kind: 'fog', cells: [], material: 40, density: 8 })).toBeNull();
    // A density is a whole level a cell holds, never none.
    expect([0, 0.4, 7.6, 99].map(fogDensity)).toEqual([1, 1, 8, SHAPE_FULL]);
    expect(valueShape(gasValue(40, 99))).toBe(SHAPE_FULL);
    expect([1, 8, 15].map(densityPercent)).toEqual([7, 53, 100]);
  });

  it('smooth is the brush\'s smooth with the gas as its voxel; fog paint and erase are no brush command', () => {
    const base = { grid: 0, shape: 'sphere', across: 5, soft: true, cells: [[0, 0, 0]] } as const;
    const smooth = canonicalEditCommand(voxelStrokeCommand({ ...base, kind: 'fog-smooth', voxel: { material: 40, role: VOXEL_ROLE.gas, wetness: 0 } }));
    expect(smooth).toMatchObject({ kind: 'brush', mode: 'smooth', smooth: true, voxel: { material: 40, role: VOXEL_ROLE.gas, wetness: 0 } });
    // Without the gas it would smooth the ground: never sent.
    expect(voxelStrokeCommand({ ...base, kind: 'fog-smooth' })).toBeNull();
    expect(voxelStrokeCommand({ ...base, kind: 'fog', voxel: { material: 40, role: VOXEL_ROLE.gas, wetness: 0 } })).toBeNull();
    expect(voxelStrokeCommand({ ...base, kind: 'fog-erase' })).toBeNull();
  });
});

describe('the palettes and what each rail arms', () => {
  const materials = [
    { materialId: 'mat-water', name: 'Water', params: { color: '#2a5fc0' } },
    { materialId: 'mat-lava', name: 'Lava', params: {} },
    { materialId: 'mat-grass', name: 'Grass', params: {} },
    { materialId: 'mat-brick', name: 'Brick', params: {} },
    { materialId: 'mat-mist', name: 'Mist', params: { color: '#dfe6ea' } },
    { materialId: 'mat-mist-thin', name: 'Thin mist', instanceOf: 'mat-mist', params: {} },
    { materialId: 'mat-smoke', name: 'Smoke', params: {} },
  ];
  const parts = new Map<string, { id: number; use?: 'terrain' | 'construction' | 'liquid' | 'gas' }>([
    ['mat-water', { id: 30, use: 'liquid' }],
    ['mat-lava', { id: 31, use: 'liquid' }],
    ['mat-grass', { id: 2, use: 'terrain' }],
    ['mat-brick', { id: 4, use: 'construction' }],
    ['mat-mist', { id: 40, use: 'gas' }],
    ['mat-mist-thin', { id: 42, use: 'gas' }],
    ['mat-smoke', { id: 41, use: 'gas' }],
  ]);
  const palettes: WorldPalettes = { solid: voxelPalette(materials, parts), paint: voxelPalette(materials, parts, PAINT_PALETTE_USES), gas: voxelPalette(materials, parts, GAS_PALETTE_USES), liquid: voxelPalette(materials, parts, LIQUID_PALETTE_USES) };

  it('the gas group and the liquid group hold only their use; Paint\'s palette is ground, construction, then the gases', () => {
    expect(palettes.gas.map((e) => [e.name, e.id, e.use, e.variant])).toEqual([['Smoke', 41, 'gas', false], ['Mist', 40, 'gas', false], ['Thin mist', 42, 'gas', true]]);
    expect(palettes.liquid.map((e) => [e.name, e.id, e.use])).toEqual([['Lava', 31, 'liquid'], ['Water', 30, 'liquid']]);
    expect(palettes.paint.map((e) => e.name)).toEqual(['Grass', 'Brick', 'Smoke', 'Mist', 'Thin mist']);
    expect(palettes.solid.map((e) => e.name)).toEqual(['Grass', 'Brick']);
    expect(paletteTiles(palettes.gas).map((t) => [t.group, t.name, t.badge])).toEqual([['Gases', 'Smoke', undefined], ['Mist', 'Mist', undefined], ['Mist', 'Thin mist', 'V']]);
    expect(paletteTiles(palettes.liquid).map((t) => t.group)).toEqual(['Liquids', 'Liquids']);
  });

  it('the density overlay shows only while its switch is on and the rail has fog tools: Fill, or Paint with a gas picked', () => {
    expect(WORLD_BRUSH_START.overlay).toBe(false);
    const on = { ...WORLD_BRUSH_START, overlay: true, material: 40 };
    expect((['sculpt', 'paint', 'fill', 'spline'] as const).map((rail) => gasOverlayShown(rail, on, palettes))).toEqual([false, true, true, false]);
    // Paint with ground picked is the material brush: fog is seen as a game draws it.
    expect(gasOverlayShown('paint', { ...on, material: 2 }, palettes)).toBe(false);
    expect((['sculpt', 'paint', 'fill', 'spline'] as const).some((rail) => gasOverlayShown(rail, { ...on, overlay: false }, palettes))).toBe(false);
  });

  it('Paint with a gas picked arms the fog brush: the gas, dry, at the density; Smooth alone takes the soft rim', () => {
    const s = { ...WORLD_BRUSH_START, material: 40, density: 5 };
    expect(paintsFog(s, palettes)).toBe(true);
    expect(paintsFog({ ...s, material: 2 }, palettes)).toBe(false);
    expect(worldBrushArming('paint', s, palettes)).toEqual({ kind: 'fog', shape: 'sphere', soft: false, voxel: { material: 40, role: VOXEL_ROLE.gas, wetness: 0 }, uses: ['size', 'spacing', 'invert'], density: 5 });
    expect(worldBrushArming('paint', { ...s, fog: 'fog-erase' }, palettes)).toMatchObject({ kind: 'fog-erase', soft: false });
    expect(worldBrushArming('paint', { ...s, fog: 'fog-smooth' }, palettes)).toMatchObject({ kind: 'fog-smooth', soft: true });
    // Add never writes a gas: with one picked it falls back to the first ground material.
    expect(worldBrushArming('sculpt', s, palettes).voxel).toEqual({ material: 2, role: VOXEL_ROLE.terrain, wetness: 0 });
    // The fog brush is bounded: its strokes name their cells.
    expect(FOG_BRUSH_BOUNDS.size[1]).toBe(8);
  });

  it('Fill arms a fill with the picked gas or liquid, the depth, reach and fade; the spline entry a preset section', () => {
    const s = { ...WORLD_BRUSH_START, gas: 41, liquid: 31, depth: 3, reach: 20, fade: 0.5 };
    expect(worldBrushArming('fill', s, palettes, 'scene-main').fill).toEqual({ kind: 'fog', material: 41, depthM: 3, reachM: 20, fadeM: 0.5, sceneId: 'scene-main' });
    expect(worldBrushArming('fill', { ...s, fill: 'drain' }, palettes).fill).toMatchObject({ kind: 'drain', material: null, sceneId: null });
    expect(worldBrushArming('fill', { ...s, fill: 'water' }, palettes).fill).toMatchObject({ kind: 'water', material: 31 });
    // None picked: the group's first; an empty group: none.
    expect(worldBrushArming('fill', WORLD_BRUSH_START, palettes).fill?.material).toBe(41);
    expect(worldBrushArming('fill', WORLD_BRUSH_START, { ...palettes, gas: [] }).fill?.material).toBeNull();
    expect(worldBrushArming('spline', { ...s, material: 4, spline: 'road' }, palettes).fill).toMatchObject({ kind: 'spline', spline: { kind: 'road', material: 4, bed: { material: 4, depth: 1 } } });
    expect(worldBrushArming('spline', { ...s, spline: 'river' }, palettes).fill?.spline).toEqual({ kind: 'river', material: 31 });
    expect(worldBrushArming('spline', { ...s, liquid: null, spline: 'river' }, palettes).fill?.spline).toEqual({ kind: 'river', material: 31 });
    expect(worldBrushArming('spline', { ...s, spline: 'river' }, { ...palettes, liquid: [] }).fill?.spline).toBeNull();
  });

  it('the material a fill offers to make is one the project model takes: a plain mist, plain water', () => {
    for (const use of ['gas', 'liquid'] as const) {
      const m = starterMedium(use, `mat-${use}`, 9) as { name: string; voxel: Record<string, unknown> };
      const errors: ModelErrorV2[] = [];
      validateMaterialVoxel(m.voxel, '/voxel', errors, false);
      expect(errors, use).toEqual([]);
      expect(m.voxel).toMatchObject({ id: 9, use });
    }
  });
});
