/**
 * The picture set's editor screens (picture-list.ts `screen` entries), taken by driving the real editor against a
 * real backend with Playwright as a library, one browser for all of them.
 *
 * The authoring screens (the editor with a scene, structure mode, a water body, a spline road) are taken on a fresh
 * backend (tests/e2e/backend.ts: its own data root, removed after) whose project holds a made yard: 64 m of flat
 * grass in a voxel world, a two-storey house with a door and windows, a lake in a dug hollow and a spline that
 * writes a road, every one made by the same commands the editor sends. The world mode's screen comes last on that
 * yard: a hill is raised, smoothed and painted by the strokes the mode's brush sends (`voxelStrokeCommand`), sent
 * through the backend while the editor is open, and then one stroke is dragged with the real pointer. After it the
 * Fill rail's screen: two hollows dug by commands, one filled with fog and the other, breached by a trench, refused,
 * both by the real pointer on the Fill rail's Fog tool. The voxel world
 * page and Play are taken on staging's 8 km town (what the world pictures show), which they only read.
 *
 * Each screen waits for the editor's own settle signals (the Scene view's voxel worlds settled and no frame wanted,
 * the page's `settle`, Play's streaming counts and light volume), never a fixed sleep; a screen that does not settle
 * within its timeout is saved but reported "did not settle: <what>".
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Browser, Locator, Page } from '@playwright/test';
import { chunkGrid, createWorldStore, VOXEL_ROLE } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';
import { voxelStrokeCommand, type VoxelStroke } from '../../packages/editor/src/session/voxel-brush';
import { startBackend, type E2EBackend } from '../../tests/e2e/backend';
import { mustCommand } from '../../tests/support/commands';
import { BENCH_COVER_FOLDER, BENCH_COVER_MODELS, BENCH_MEADOW_DRESSING, benchCoverDressings, type BenchCoverModel } from './bench-cover';
import type { ScreenName } from './picture-list';
import type { PictureResult } from './picture-pack';
import { flatGround } from './scenes';
import { TEST_WORLD_ID } from './test-world-id';
import { MAT } from './world-kit';

/** The editor window's size for every screen (the world pictures' 1280 × 720 plus room for the editor's docks). */
export const SCREEN_VIEWPORT = Object.freeze({ width: 1600, height: 900 });
/** The longest a screen waits for its settle signals (a cold backend, a first WebGPU pipeline build, a loaded host). */
const SETTLE_MS = 120_000;
const POLL_MS = 250;

const YARD = 'yard';
/** The yard's half side in cells (0.5 m): 64 m across. */
const YARD_HALF = 64;
const YARD_MAT = { road: 21, dryGrass: 22, water: 30, mist: 31 } as const;

type Results = Map<ScreenName, PictureResult>;
type Wait = { ok: true; s: number } | { ok: false; what: string };

/** Polls `ready` (null: settled; a string: what it still waits for) until settled or the timeout. */
async function until(page: Page, ready: () => Promise<string | null>, ms = SETTLE_MS): Promise<Wait> {
  const t0 = Date.now();
  let what = 'never read';
  for (;;) {
    const r = await ready().catch((e: unknown) => `could not read: ${String(e).slice(0, 120)}`);
    if (r === null) return { ok: true, s: Number(((Date.now() - t0) / 1000).toFixed(1)) };
    what = r;
    if (Date.now() - t0 > ms) return { ok: false, what };
    await page.waitForTimeout(POLL_MS);
  }
}

interface SceneVoxels {
  readonly worlds: Record<string, { chunks: number; gas?: { triangles: number; program: boolean; eyeInside: boolean; overlay: boolean } }>;
  readonly states: Record<string, { settled: boolean; revision?: number; grids?: Record<string, { settled: boolean }> }>;
  readonly problems: Record<string, string>;
}
const sceneVoxels = async (page: Page): Promise<SceneVoxels | null> => JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-voxels')) ?? 'null') as SceneVoxels | null;

/** The Scene view settled: the yard and every structure grid in it settled, chunks drawn, no frame wanted. */
async function sceneSettled(page: Page): Promise<string | null> {
  const v = await sceneVoxels(page);
  const st = v?.states[YARD];
  if (st === undefined) return 'the yard not in the Scene view';
  const grids = Object.entries(st.grids ?? {}).filter(([, g]) => !g.settled).map(([k]) => k);
  if (!st.settled) return 'the yard streaming';
  // The house's own grid: known to the view once its structure is read (before that the yard alone can look settled).
  if (Object.keys(st.grids ?? {}).length === 0) return 'the house grid not in the Scene view';
  if (grids.length > 0) return `structure grids streaming (${grids.join(', ')})`;
  if ((v?.worlds[YARD]?.chunks ?? 0) === 0) return 'no yard chunk drawn';
  if ((await page.locator('canvas.tl-viewport').getAttribute('data-frame-wanted')) !== '0') return 'the Scene view still drawing';
  return null;
}

/**
 * The world mode's fog view switched to Density (the overlay), a picture of it taken into `file`, and switched back:
 * what the Scene view says it draws (`data-gas-overlay`) and its gas as drawn then.
 */
async function densityView(page: Page, mode: Locator, file: string): Promise<Record<string, unknown>> {
  const group = mode.getByRole('radiogroup', { name: 'world fog view', exact: true });
  if ((await group.count()) === 0) return { switched: false, why: 'no fog view switch on the panel' };
  const drawn = async (): Promise<string | null> => page.locator('[data-gas-overlay]').first().getAttribute('data-gas-overlay').catch(() => null);
  await group.getByRole('radio', { name: 'Density', exact: true }).click();
  const on = await until(page, async () => ((await drawn()) === 'density' ? sceneSettled(page) : 'the Scene view not drawing fog by density'), 20_000);
  await page.screenshot({ path: file });
  const gas = (await sceneVoxels(page))?.worlds[YARD]?.gas ?? null;
  await group.getByRole('radio', { name: 'As drawn', exact: true }).click();
  const off = await until(page, async () => ((await drawn()) === 'off' ? sceneSettled(page) : 'the Scene view still drawing fog by density'), 20_000);
  return { switched: on.ok, file, gas, back: off.ok };
}

/**
 * The bench's meadow on the yard's grass (its stand-in models imported, its dressing set on the material), the Scene
 * view waited for and a picture of it taken into `file`: what the view says it holds of cover then.
 */
async function yardCover(be: E2EBackend, page: Page, file: string): Promise<Record<string, unknown>> {
  const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => mustCommand(be, op, args, { clientId: 'pictures' });
  const dir = join(be.projectDir, ...BENCH_COVER_FOLDER.split('/'));
  mkdirSync(dir, { recursive: true });
  for (const m of Object.values(BENCH_COVER_MODELS)) writeFileSync(join(dir, m.file), m.glb());
  await cmd('importAssets', { folder: BENCH_COVER_FOLDER });
  const assets = ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 100 } }))['assets'] ?? []) as Array<{ assetId: string; sourcePath?: string }>;
  const models = Object.fromEntries(Object.entries(BENCH_COVER_MODELS).map(([name, m]) => [name, assets.find((a) => a.sourcePath === `${BENCH_COVER_FOLDER}/${m.file}`)?.assetId ?? ''])) as Record<BenchCoverModel, string>;
  const dressings = benchCoverDressings(models);
  for (const dressing of dressings) await cmd('setDressing', { dressing });
  const grass = (dressing?: string): Record<string, unknown> => ({ materialId: 'mat-grass', name: 'Grass', shader: 'standard', params: { color: '#4d7a3a' }, textures: {}, voxel: { id: MAT.grass, use: 'terrain', ...(dressing !== undefined ? { dressing } : {}) } });
  await cmd('setMaterial', { material: grass(BENCH_MEADOW_DRESSING) });
  const cover = async (): Promise<{ species?: number; points?: number; pending?: number } | null> => ((await sceneVoxels(page)) as unknown as { cover?: { species: number; points: number; pending: number } } | null)?.cover ?? null;
  const grown = await until(page, async () => {
    const c = await cover();
    if ((c?.points ?? 0) === 0) return 'no cover in the Scene view';
    if ((c?.pending ?? 0) > 0) return 'cover sets waiting';
    return sceneSettled(page);
  }, 60_000);
  await page.screenshot({ path: file });
  const held = await cover();
  // Taken off: the material names no dressing, so every column lets its cover go, and the dressings are deleted.
  await cmd('setMaterial', { material: grass() });
  for (const d of dressings) await cmd('deleteDressing', { dressingId: d.dressingId });
  const gone = await until(page, async () => ((await cover())?.points === 0 ? sceneSettled(page) : 'cover still in the Scene view'), 60_000);
  return { grown: grown.ok, ...(grown.ok ? {} : { why: grown.what }), file, models, cover: held, takenOff: gone.ok };
}

async function shoot(page: Page, file: string, wait: Wait, facts: Record<string, unknown>, id: string, waited: string): Promise<PictureResult> {
  await page.screenshot({ path: file });
  return { id, source: file, settled: wait.ok, settle: wait.ok ? `${waited} after ${wait.s} s` : `did not settle: ${wait.what}`, specks: null, facts };
}

/** The made yard's project: materials, the world, and the objects the screens show. */
async function makeYard(be: E2EBackend): Promise<Record<string, string>> {
  const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => mustCommand(be, op, args, { clientId: 'pictures' });
  const store = createWorldStore(chunkGrid(32));
  flatGround(store, -YARD_HALF, YARD_HALF, -YARD_HALF, YARD_HALF, 6, 0);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeVoxelWorld(join(be.projectDir, VOXEL_WORLDS_FOLDER, YARD), { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, store);
  const mat = (materialId: string, name: string, color: string, id: number, use: 'construction' | 'terrain' | 'liquid'): Promise<unknown> => cmd('setMaterial', { material: { materialId, name, shader: 'standard', params: { color }, textures: {}, voxel: { id, use } } });
  await mat('mat-grass', 'Grass', '#4d7a3a', MAT.grass, 'terrain');
  await mat('mat-stone', 'Stone', '#a8a39a', MAT.stone, 'construction');
  await mat('mat-roof', 'Roof tile', '#9a3b2a', MAT.roofTile, 'construction');
  await mat('mat-brick', 'Brick', '#c0603a', MAT.brick, 'construction');
  await mat('mat-road', 'Road', '#8a8070', YARD_MAT.road, 'terrain');
  await mat('mat-water', 'Water', '#2a5fc0', YARD_MAT.water, 'liquid');
  const made = async (name: string, position: number[], components: Record<string, unknown> = {}): Promise<string> => String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name, transform: { position }, components }))['createdId']);
  const ids: Record<string, string> = {};
  ids['yard'] = await made('Yard', [0, 0, 0], { voxelWorld: { world: YARD } });
  // 10 × 8 m, two storeys of 3 m, a gable roof: a door and a window on its front, a window over the door.
  ids['house'] = await made('House', [4, 0, 4], {
    voxelStructure: {
      world: YARD,
      footprint: [{ id: 'main', points: [[0, 0], [20, 0], [20, 16], [0, 16]] }],
      storeys: 2,
      storeyHeight: 6,
      foundationDepth: 1,
      roof: { shape: 'gable', overhang: 1, axis: 'x' },
      materials: { wall: MAT.brick, floor: MAT.stone, roof: MAT.roofTile, foundation: MAT.stone, stair: MAT.stone },
      // On every side, so whichever two the view sees show a door or windows.
      openings: [
        { id: 'door-1', polygon: 'main', edge: 2, storey: 0, at: 4, width: 2, height: 4, sill: 0 },
        { id: 'window-1', polygon: 'main', edge: 2, storey: 0, at: 12, width: 3, height: 2, sill: 2 },
        { id: 'window-2', polygon: 'main', edge: 2, storey: 1, at: 8, width: 2, height: 2, sill: 2 },
        { id: 'window-3', polygon: 'main', edge: 0, storey: 1, at: 8, width: 2, height: 2, sill: 2 },
        { id: 'window-4', polygon: 'main', edge: 1, storey: 0, at: 6, width: 2, height: 2, sill: 2 },
        { id: 'window-5', polygon: 'main', edge: 3, storey: 1, at: 6, width: 2, height: 2, sill: 2 },
      ],
      stairs: [],
    },
  });
  // The hollow, 8 × 8 m and 2 m deep, in the yard's far corner; the lake fills it to a metre under the grass.
  const dug = await be.command({ op: 'editVoxels', projectId: be.projectId, args: { world: YARD, command: { v: 2, grid: 0, kind: 'fill', min: [-56, -4, 40], max: [-41, -1, 55], mode: 'dig' } } });
  if (dug['ok'] !== true) throw new Error(`the hollow: ${JSON.stringify(dug).slice(0, 300)}`);
  ids['lake'] = await made('Lake', [-24, -1, 24], { waterBody: { world: YARD, level: -1, material: YARD_MAT.water, reach: 256 } });
  // A bent lane across the yard's near side, half a metre under the grass: a road cut with a metre of air over it.
  ids['lane'] = await made('Lane', [0, 0, -20], { spline: { points: [{ at: [-16, -0.5, 0] }, { at: [0, -0.5, 6] }, { at: [16, -0.5, 0] }], width: 4, voxels: { kind: 'road', material: YARD_MAT.road, clear: 1 } } });
  // An object far off that draws nothing: selected before a picture whose subject is not a selection.
  ids['marker'] = await made('Marker', [400, 0, 0]);
  return ids;
}

/** The world mode's hill: its middle in the yard's open corner (cells; the ground's top is y = 0). */
const HILL = Object.freeze({ x: -28, z: -12 });

/**
 * The world mode's hill: raised with Add strokes of grass, evened with Smooth strokes and painted on its top, each
 * the command the mode's brush sends for such a stroke. Returns what was sent, the material painted (a variant of
 * Grass when the project took the instance, else the road's, with why) and the object the view is framed on.
 */
async function makeHill(be: E2EBackend): Promise<{ strokes: number; painted: string; variant: string; view: string | null }> {
  const refusal = (e: unknown): string => String(e).slice(0, 300);
  const variant = await mustCommand(be, 'setMaterial', { material: { materialId: 'mat-grass-dry', name: 'Dry grass', shader: 'standard', instanceOf: 'mat-grass', params: { color: '#b8a24a' }, textures: {}, voxel: { id: YARD_MAT.dryGrass } } }, { clientId: 'pictures' }).then(() => 'made', refusal);
  const painted = variant === 'made' ? { id: YARD_MAT.dryGrass, name: 'Dry grass (a variant of Grass)' } : { id: YARD_MAT.road, name: 'Road' };
  const base = { grid: 0, shape: 'sphere', soft: true } as const;
  const grass = { material: MAT.grass, role: VOXEL_ROLE.terrain, wetness: 0 };
  const row = (y: number, dxs: readonly number[], dz: number): [number, number, number][] => dxs.map((dx) => [HILL.x + dx, y, HILL.z + dz]);
  const strokes: VoxelStroke[] = [
    { ...base, kind: 'add', across: 17, voxel: grass, cells: [...row(0, [-6, -2, 2, 6], 0), ...row(0, [-2, 2], -4), ...row(0, [-2, 2], 4)] },
    { ...base, kind: 'add', across: 11, voxel: grass, cells: row(7, [-2, 0, 2], 0) },
    ...Array.from({ length: 6 }, (): VoxelStroke => ({ ...base, kind: 'smooth', across: 25, cells: [...row(4, [-8, -4, 0, 4, 8], 0), ...row(4, [-4, 0, 4], -6), ...row(4, [-4, 0, 4], 6)] })),
    { ...base, kind: 'paint', soft: false, across: 11, voxel: { material: painted.id, wetness: 0 }, cells: row(8, [-1, 1], 0) },
  ];
  for (const s of strokes) {
    const r = await be.command({ op: 'editVoxels', projectId: be.projectId, args: { world: YARD, command: voxelStrokeCommand(s) } });
    if (r['ok'] !== true) throw new Error(`the hill's ${s.kind} stroke: ${JSON.stringify(r).slice(0, 300)}`);
  }
  // A curve over the hill that draws nothing by itself: F frames a curve by its bounds, so the view fits the hill.
  const cx = HILL.x / 2;
  const cz = HILL.z / 2;
  const view = await mustCommand(be, 'createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Hill view', transform: { position: [cx, 0, cz] }, components: { spline: { points: [{ at: [-9, 0, 0] }, { at: [0, 6, 0] }, { at: [9, 0, 0] }], width: 12 } } }, { clientId: 'pictures' }).then((r) => String(r['createdId']), () => null);
  return { strokes: strokes.length, painted: painted.name, variant, view };
}

interface BrushStamp {
  readonly navigate: boolean;
  readonly cursor: boolean;
  readonly stroke: { dabs: number } | null;
  readonly hover: { mine: boolean; at: [number, number] | null; cell: [number, number, number] } | null;
  readonly last: { stroke: string; dabs?: number; cells?: number; ok: boolean | null; error?: string; refused?: string } | null;
  /** The Fill rail's gesture (absent: a brush is armed). */
  readonly fill?: { readonly kind: string; readonly gesture: { seed: number[]; level: number } | null; readonly ring: boolean; readonly leaks: number[][]; readonly last: { fill: string; level?: number; ok: boolean | null; error?: string; leaks?: number } | null };
}
const brushStamp = async (page: Page): Promise<BrushStamp | null> => JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-voxel-brush')) ?? 'null') as BrushStamp | null;

/**
 * One stroke with the real pointer on the world's ground: the pointer moved over the view until the brush is over
 * the world's own cells, pressed, dragged and released. What happened is told, never asserted: whether the tool
 * took the drag, what its command's answer was, and whether the view's world moved to a new revision.
 */
async function dragStroke(page: Page, beforeFile: string): Promise<Record<string, unknown>> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const revision = async (): Promise<number | null> => (await sceneVoxels(page))?.states[YARD]?.revision ?? null;
  const before = await revision();
  let from: { x: number; y: number } | null = null;
  // The view's left half, under its middle: clear of the docked panels on its right edge.
  for (const [fx, fy] of [[0.36, 0.62], [0.3, 0.72], [0.22, 0.8], [0.4, 0.8], [0.3, 0.5], [0.5, 0.7]] as const) {
    const p = { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
    await page.mouse.move(p.x - 6, p.y);
    await page.mouse.move(p.x, p.y);
    const over = await until(page, async () => ((await brushStamp(page))?.hover?.mine === true ? null : 'the brush not over the world\'s ground'), 3000);
    if (over.ok) {
      from = p;
      break;
    }
  }
  if (from === null) return { dragged: false, why: 'no point of the view had the brush over the world\'s ground' };
  // The view as it is before the stroke, beside the picture (the raw folder): what the drag changed is seen by comparing.
  await page.screenshot({ path: beforeFile });
  await page.mouse.down();
  let dabs = 0;
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(from.x + i * 8, from.y);
    await page.waitForTimeout(40);
    dabs = Math.max(dabs, (await brushStamp(page))?.stroke?.dabs ?? 0);
  }
  await page.mouse.up();
  const answered = await until(page, async () => ((await brushStamp(page))?.last?.ok != null ? null : 'the stroke\'s command not answered'), 30_000);
  const last = (await brushStamp(page))?.last ?? null;
  const moved = await until(page, async () => ((await revision()) !== before ? null : 'the view\'s world still at the revision before the stroke'), 30_000);
  return { dragged: true, from, toX: from.x + 128, dabsWhileDragging: dabs, answered: answered.ok, last, revisionBefore: before, revisionAfter: await revision(), viewTookTheChange: moved.ok };
}

/**
 * The Fill rail's two hollows in the yard's open side (cells; the ground's top is y = 0), each 6 m square and 2 m
 * deep: one whole, one whose far bank is cut by a trench of the same depth running 14 m away, so a fill of it
 * passes an 8 m reach in the trench.
 */
const HOLLOW = Object.freeze({ x0: 36, x1: 47, whole: { z0: -24, z1: -13 }, breached: { z0: 0, z1: 11 }, trench: { x0: 41, x1: 42, z1: 40 }, floor: -5 });
const FILL_REACH_M = 8;

/** The hollows dug, a mist material made, and a curve over both that the view is framed on. */
async function makeHollows(be: E2EBackend): Promise<{ view: string | null }> {
  const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => mustCommand(be, op, args, { clientId: 'pictures' });
  await cmd('setMaterial', { material: { materialId: 'mat-mist', name: 'Mist', shader: 'standard', params: { color: '#dfe6ea' }, textures: {}, voxel: { id: YARD_MAT.mist, use: 'gas', gas: { color: '#dfe6ea' } } } });
  const dig = async (min: number[], max: number[]): Promise<void> => {
    const r = await be.command({ op: 'editVoxels', projectId: be.projectId, args: { world: YARD, command: { v: 2, grid: 0, kind: 'fill', min, max, mode: 'dig' } } });
    if (r['ok'] !== true) throw new Error(`a hollow: ${JSON.stringify(r).slice(0, 300)}`);
  };
  const h = HOLLOW;
  await dig([h.x0, h.floor + 1, h.whole.z0], [h.x1, -1, h.whole.z1]);
  await dig([h.x0, h.floor + 1, h.breached.z0], [h.x1, -1, h.breached.z1]);
  await dig([h.trench.x0, h.floor + 1, h.breached.z1 + 1], [h.trench.x1, -1, h.trench.z1]);
  const view = await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Hollows view', transform: { position: [21, 0, 0] }, components: { spline: { points: [{ at: [0, 0, -13] }, { at: [0, 4, 2] }, { at: [0, 0, 19] }], width: 10 } } }).then((r) => String(r['createdId']), () => null);
  return { view };
}

type ViewPoint = { x: number; y: number };

/**
 * Where the pointer is over each hollow's floor (`z0` … `z1`): the view's left three quarters (the docked panels are
 * on its right edge) scanned once, row by row, until every hollow has a point (a far hollow's floor shows as a strip
 * a few dozen pixels high behind its near bank, so the rows are close).
 */
async function floorPoints(page: Page, hollows: readonly { z0: number; z1: number }[]): Promise<(ViewPoint | null)[]> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const found: (ViewPoint | null)[] = hollows.map(() => null);
  const inFloor = (c: readonly number[], h: { z0: number; z1: number }): boolean => c[1] === HOLLOW.floor && c[0]! >= HOLLOW.x0 + 1 && c[0]! <= HOLLOW.x1 - 1 && c[2]! >= h.z0 + 1 && c[2]! <= h.z1 - 1;
  for (let fy = 0.2; fy <= 0.9 && found.includes(null); fy += 0.025) {
    for (let fx = 0.1; fx <= 0.76 && found.includes(null); fx += 0.025) {
      const p = { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
      await page.mouse.move(p.x, p.y);
      // The pick for this point answered (the tool publishes where its hover was picked).
      let hover: BrushStamp['hover'] = null;
      for (let k = 0; k < 20; k++) {
        hover = (await brushStamp(page))?.hover ?? null;
        if (hover?.at != null && Math.abs(hover.at[0] - p.x) <= 1 && Math.abs(hover.at[1] - p.y) <= 1) break;
        hover = null;
        await page.waitForTimeout(15);
      }
      if (hover?.mine !== true) continue;
      hollows.forEach((h, i) => {
        if (found[i] === null && inFloor(hover!.cell, h)) found[i] = p;
      });
    }
  }
  return found;
}

/**
 * One fill with the real pointer: moved onto a hollow's floor, pressed, dragged down until the level is `downM`
 * under where it began (0: no drag), and released. What happened is told, never asserted: where it clicked, the
 * level sent, the command's answer, the leaks marked.
 */
async function fillClick(page: Page, from: ViewPoint | null, downM: number): Promise<Record<string, unknown>> {
  if (from === null) return { clicked: false, why: 'no point of the view had the pointer over the hollow\'s floor' };
  await page.mouse.move(from.x - 3, from.y);
  await page.mouse.move(from.x, from.y);
  const over = await until(page, async () => {
    const at = (await brushStamp(page))?.hover?.at;
    return at != null && Math.abs(at[0] - from.x) <= 1 && Math.abs(at[1] - from.y) <= 1 ? null : 'the pick not answered';
  }, 3000);
  const floorCell = (await brushStamp(page))?.hover?.cell ?? null;
  // The answer of the fill before this one: this one's is the next that differs from it.
  const earlier = JSON.stringify((await brushStamp(page))?.fill?.last ?? null);
  await page.mouse.down();
  await until(page, async () => ((await brushStamp(page))?.fill?.gesture != null ? null : 'the press not taken'), 3000);
  const start = (await brushStamp(page))?.fill?.gesture?.level ?? null;
  let level = start;
  for (let dy = 4; downM > 0 && start !== null && level !== null && level > start - downM && dy <= 400; dy += 4) {
    await page.mouse.move(from.x, from.y + dy);
    await page.waitForTimeout(30);
    level = (await brushStamp(page))?.fill?.gesture?.level ?? level;
  }
  await page.mouse.up();
  const answered = await until(page, async () => {
    const last = (await brushStamp(page))?.fill?.last ?? null;
    return last !== null && last.ok != null && JSON.stringify(last) !== earlier ? null : 'the fill\'s command not answered';
  }, 30_000);
  const fill = (await brushStamp(page))?.fill ?? null;
  return { clicked: true, pickAnswered: over.ok, from, floorCell, levelAtPress: start, levelSent: level, answered: answered.ok, last: answered.ok ? (fill?.last ?? null) : null, leaksMarked: fill?.leaks ?? [] };
}

/**
 * One fog stroke with the real pointer on the Paint rail (the Mist picked, the fog brush's Fog tool): pressed on
 * `from`, dragged 96 px to the right, released. A fog stroke reads the cells under it from the view's worker
 * before it names them, so this is that read in a real page. Told, never asserted.
 */
async function fogStroke(page: Page, mode: ReturnType<Page['getByRole']>, from: ViewPoint | null): Promise<Record<string, unknown>> {
  if (from === null) return { dragged: false, why: 'no point on a hollow\'s floor to start from' };
  await mode.getByRole('tab', { name: /Paint/ }).click();
  const mist = mode.getByRole('radio', { name: 'voxel material Mist', exact: true });
  const tile = mode.locator('button.tl-tool', { hasText: 'Fog' });
  const armed = await until(page, async () => {
    if ((await mist.getAttribute('aria-checked')) !== 'true') {
      await mist.click();
      return 'the Mist not picked';
    }
    if ((await tile.getAttribute('aria-pressed')) !== 'true') {
      await tile.click();
      return 'the fog brush not armed';
    }
    const stamp = await brushStamp(page);
    return stamp?.navigate === false && (stamp as { kind?: string }).kind === 'fog' && stamp.fill === undefined ? null : 'the fog brush not armed in the Scene view';
  }, 20_000);
  if (!armed.ok) return { dragged: false, why: armed.what };
  await page.mouse.move(from.x - 3, from.y);
  await page.mouse.move(from.x, from.y);
  await until(page, async () => ((await brushStamp(page))?.hover?.mine === true ? null : 'the brush not over the ground'), 3000);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + i * 8, from.y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  const answered = await until(page, async () => {
    const last = (await brushStamp(page))?.last ?? null;
    return last !== null && last.stroke === 'fog' && last.ok != null ? null : 'the fog stroke not answered';
  }, 30_000);
  return { dragged: true, from, toX: from.x + 96, answered: answered.ok, last: (await brushStamp(page))?.last ?? null };
}

async function editorOpen(page: Page, url: string): Promise<Wait> {
  await page.goto(url);
  return until(page, async () => ((await page.locator('.tl-statusbar').textContent()) ?? '').includes('connected') ? null : 'the editor not connected');
}

async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
}

/** Frames the selected object (F) and backs off `notches` wheel steps over the view's middle. */
async function frame(page: Page, notches: number): Promise<void> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  await page.keyboard.press('f');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < notches; k++) await page.mouse.wheel(0, 300);
}

/** The authoring screens on a fresh backend's yard. */
export async function yardScreens(browser: Browser, want: readonly ScreenName[], idOf: (s: ScreenName) => string, files: (s: ScreenName) => string): Promise<Results> {
  const out: Results = new Map();
  const be = await startBackend('pictures-yard');
  try {
    const ids = await makeYard(be);
    const context = await browser.newContext({ viewport: SCREEN_VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    page.on('pageerror', (e) => void errors.push(e.message.slice(0, 200)));
    const url = `${be.origin}/?project=${be.projectId}&renderer=webgpu#token=${be.token}`;
    const facts = (screen: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ screen, backend: 'fresh backend, made yard (64 m of grass, a house, a lake, a lane)', viewport: SCREEN_VIEWPORT, consoleErrors: errors.slice(0, 5), ...extra });
    const opened = await editorOpen(page, url);
    if (!opened.ok) throw new Error(`the editor did not open: ${opened.what}`);
    if (want.includes('editor')) {
      // The lane framed (F frames a curve by its bounds; a world or structure object by its origin) and backed off to
      // see the yard, then the house selected: its gizmo over the overview.
      await select(page, ids['lane']!);
      await frame(page, 13);
      await select(page, ids['house']!);
      const w = await until(page, () => sceneSettled(page));
      out.set('editor', await shoot(page, files('editor'), w, facts('editor', { selected: 'House' }), idOf('editor'), 'the Scene view settled (the yard and the house grid, no frame wanted)'));
    }
    if (want.includes('structure')) {
      await select(page, ids['house']!);
      await frame(page, 2);
      await page.locator('[data-tl-inspector]').getByRole('button', { name: 'Edit structure', exact: true }).click();
      const mode = page.getByRole('region', { name: 'edit mode', exact: true });
      const tile = mode.locator('button.tl-tool', { hasText: 'Shape' });
      const w = await until(page, async () => {
        if ((await mode.getAttribute('data-edit-mode')) !== 'structure') return 'structure mode not open';
        if ((await tile.getAttribute('aria-pressed')) !== 'true') {
          await tile.click();
          return 'the Shape tool not armed';
        }
        const stamp = JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-structure-tool')) ?? 'null') as { handles?: unknown[] } | null;
        if ((stamp?.handles?.length ?? 0) === 0) return 'no Shape handle on screen';
        return sceneSettled(page);
      });
      out.set('structure', await shoot(page, files('structure'), w, facts('structure', { tool: 'Shape' }), idOf('structure'), 'structure mode open, the Shape tool\'s handles on screen, the Scene view settled'));
      await mode.getByRole('button', { name: /^Done/ }).click().catch(() => undefined);
    }
    if (want.includes('water')) {
      await select(page, ids['lake']!);
      await frame(page, 2);
      await select(page, ids['lake']!);
      const view = page.locator('canvas.tl-viewport');
      const w = await until(page, async () => {
        const grips = JSON.parse((await view.getAttribute('data-size-handles')) ?? '[]') as Array<{ component: string }>;
        if (!grips.some((g) => g.component === 'waterBody')) return 'no level handle on screen';
        if (Number((await page.locator('[data-tl-inspector]').getByLabel('water state').getAttribute('data-cells')) ?? '0') <= 0) return 'the Inspector shows no water held';
        return sceneSettled(page);
      });
      out.set('water', await shoot(page, files('water'), w, facts('water', { selected: 'Lake' }), idOf('water'), 'the lake selected, its level handle on screen and its water held, the Scene view settled'));
    }
    if (want.includes('spline')) {
      await select(page, ids['lane']!);
      await frame(page, 3);
      await select(page, ids['lane']!);
      const w = await until(page, async () => {
        if (Number((await page.locator('[data-tl-inspector]').getByLabel('spline voxels state').getAttribute('data-written')) ?? '0') <= 0) return 'the Inspector shows no road written';
        return sceneSettled(page);
      });
      out.set('spline', await shoot(page, files('spline'), w, facts('spline', { selected: 'Lane' }), idOf('spline'), 'the lane selected, its road written, the Scene view settled'));
    }
    if (want.includes('world-mode')) {
      // After the other screens: the hill is not part of their yard.
      const hill = await makeHill(be);
      // The view on the hill (the curve over it framed by its bounds; without it, the lane and back off).
      await select(page, hill.view ?? ids['lane']!);
      await frame(page, hill.view !== null ? 5 : 8);
      await select(page, ids['yard']!);
      await page.locator('[data-tl-inspector]').getByRole('button', { name: 'Edit world', exact: true }).click();
      const mode = page.getByRole('region', { name: 'edit mode', exact: true });
      const tile = mode.locator('button.tl-tool', { hasText: 'Add' });
      const armed = await until(page, async () => {
        if ((await mode.getAttribute('data-edit-mode')) !== 'world') return 'world mode not open';
        if ((await tile.getAttribute('aria-pressed')) !== 'true') {
          await tile.click();
          return 'the Add tool not armed';
        }
        if ((await brushStamp(page))?.navigate !== false) return 'the voxel brush not armed in the Scene view';
        return sceneSettled(page);
      });
      const drag = armed.ok ? await dragStroke(page, files('world-mode').replace(/\.png$/, '-before-drag.png')) : { dragged: false, why: 'the mode did not open' };
      // The pointer back on the ground where the stroke began: the cursor is in the picture.
      const at = drag['from'] as { x: number; y: number } | undefined;
      if (at !== undefined) {
        await page.mouse.move(at.x + 40, at.y);
        await page.mouse.move(at.x + 48, at.y);
      }
      const w = await until(page, async () => {
        if ((await brushStamp(page))?.cursor !== true) return 'the brush cursor not on the ground';
        return sceneSettled(page);
      });
      const shot = await shoot(page, files('world-mode'), armed.ok ? w : armed, facts('world-mode', { tool: 'Add', hill, pointerDrag: drag }), idOf('world-mode'), 'world mode open, the Add tool armed, the brush cursor on the ground, the Scene view settled');
      out.set('world-mode', shot);
      await mode.getByRole('button', { name: /^Done/ }).click().catch(() => undefined);
      // The yard's grass given the bench's meadow, a picture of the Scene view with it kept beside this one (the raw
      // folder), and the meadow taken off again: the screens after this one show the yard as they always have.
      (shot.facts as Record<string, unknown>)['meadow'] = await yardCover(be, page, files('world-mode').replace(/\.png$/, '-cover.png')).catch((e: unknown) => ({ grown: false, why: String(e).slice(0, 300) }));
    }
    if (want.includes('world-fill')) {
      // After the other screens: the hollows are not part of their yard.
      const hollows = await makeHollows(be);
      await select(page, hollows.view ?? ids['lane']!);
      await frame(page, hollows.view !== null ? 4 : 8);
      await select(page, ids['yard']!);
      await page.locator('[data-tl-inspector]').getByRole('button', { name: 'Edit world', exact: true }).click();
      const mode = page.getByRole('region', { name: 'edit mode', exact: true });
      const tile = mode.locator('button.tl-tool', { hasText: 'Fog' });
      const revision = async (): Promise<number | null> => (await sceneVoxels(page))?.states[YARD]?.revision ?? null;
      const armed = await until(page, async () => {
        if ((await mode.getAttribute('data-edit-mode')) !== 'world') return 'world mode not open';
        const rail = mode.getByRole('tab', { name: /Fill/ });
        if ((await rail.getAttribute('aria-selected')) !== 'true') {
          await rail.click();
          return 'the Fill rail not shown';
        }
        if ((await tile.getAttribute('aria-pressed')) !== 'true') {
          await tile.click();
          return 'the Fog tool not armed';
        }
        const stamp = await brushStamp(page);
        if (stamp?.navigate !== false || stamp.fill?.kind !== 'fog') return 'the fill not armed in the Scene view';
        return sceneSettled(page);
      });
      let reach: string | null = null;
      let whole: Record<string, unknown> = { clicked: false, why: 'the mode did not open' };
      let breached: Record<string, unknown> = whole;
      let fog: Record<string, unknown> = whole;
      const before = await revision();
      let afterFog: number | null = null;
      let afterWhole: number | null = null;
      if (armed.ok) {
        // An 8 m reach: the trench runs past it.
        const field = mode.getByLabel('world fill reach', { exact: true });
        await field.fill(String(FILL_REACH_M));
        await field.press('Enter');
        reach = await field.inputValue().catch(() => null);
        // The whole hollow: its level dragged half a metre down from the brim, so the fog stays under the grass.
        const [far, near] = await floorPoints(page, [HOLLOW.whole, HOLLOW.breached]);
        // First a stroke of the fog brush in the near hollow (the Paint rail), then back to the Fill rail.
        fog = await fogStroke(page, mode, near ?? null);
        await mode.getByRole('tab', { name: /Fill/ }).click();
        await until(page, async () => ((await brushStamp(page))?.fill?.kind === 'fog' ? null : 'the fill not armed again'), 20_000);
        if (fog['answered'] === true && (fog['last'] as { ok?: boolean } | null)?.ok === true) await until(page, async () => ((await revision()) !== before ? null : 'the view\'s world still at the revision before the fog stroke'), 30_000);
        afterFog = await revision();
        whole = await fillClick(page, far ?? null, 0.5);
        await until(page, async () => ((await revision()) !== afterFog ? null : 'the view\'s world still at the revision before the fill'), 30_000);
        afterWhole = await revision();
        // The breached one, to the same depth over its floor: the fog would run down the trench past the reach.
        breached = await fillClick(page, near ?? null, 0);
        // The pointer nudged where it clicked: the level ring is in the picture.
        const at = breached['from'] as { x: number; y: number } | undefined;
        if (at !== undefined) {
          await page.mouse.move(at.x + 3, at.y);
          await page.mouse.move(at.x, at.y);
        }
      }
      const w = await until(page, async () => {
        const stamp = await brushStamp(page);
        if (stamp?.fill?.ring !== true) return 'the level ring not on the ground';
        if ((stamp.fill.leaks.length ?? 0) === 0) return 'no leak marked';
        return sceneSettled(page);
      });
      const status = await page.locator('.tl-hints__text').first().textContent().catch(() => null);
      const gasDrawn = (await sceneVoxels(page))?.worlds[YARD]?.gas ?? null;
      // The fog view switched to Density for a second picture kept beside this one (the raw folder), then back.
      const density = armed.ok ? await densityView(page, mode, files('world-fill').replace(/\.png$/, '-density.png')) : { switched: false, why: 'the mode did not open' };
      out.set('world-fill', await shoot(page, files('world-fill'), armed.ok ? w : armed, facts('world-fill', { gasDrawn, densityView: density, tool: 'Fog', reachField: reach, fogBrushStroke: fog, wholeHollow: whole, breachedHollow: breached, revisionBefore: before, revisionAfterTheFogStroke: afterFog, revisionAfterTheFirstFill: afterWhole, revisionAtTheEnd: await revision(), status: status?.slice(0, 300) ?? null, note: 'the far hollow\'s fill and the fog brush\'s stroke in the near one are drawn as fog (gasDrawn: the Scene view\'s gas triangles); densityView: the same view with the fog view switched to Density, kept beside this picture' }), idOf('world-fill'), 'world mode\'s Fill rail open, the Fog tool armed, a leak marked, the level ring on the ground, the Scene view settled'));
      await mode.getByRole('button', { name: /^Done/ }).click().catch(() => undefined);
    }
    await context.close();
  } finally {
    await be.stop();
  }
  return out;
}

/** Staging's town: where its pictures look from (the town's middle, metres; cells are 0.5 m). */
const TOWN_PAGE_LOOK = Object.freeze({ cell: [0, 8, 0], yaw: -0.6, pitch: 0.45, distM: 90 });

interface Staging {
  readonly origin: string;
  readonly token: string;
  readonly project: string;
  readonly world: string;
}

/** The voxel world page and Play with the Profiler on staging's town (read only). */
export async function stagingScreens(browser: Browser, want: readonly ScreenName[], s: Staging, idOf: (s: ScreenName) => string, files: (s: ScreenName) => string): Promise<Results> {
  const out: Results = new Map();
  const context = await browser.newContext({ viewport: SCREEN_VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const facts = (screen: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ screen, backend: `staging, project ${s.project}, world ${s.world} (the 8 km town)`, viewport: SCREEN_VIEWPORT, consoleErrors: errors.slice(0, 5), ...extra });
    if (want.includes('voxel-world-page')) {
      const l = TOWN_PAGE_LOOK;
      await page.goto(`${s.origin}/voxel-world.html?project=${s.project}&world=${s.world}&at=${l.cell.join(',')}&renderer=webgpu#token=${s.token}`);
      type PageHook = { ready?: boolean; failed?: string; look?(...a: number[]): void; settle?(): Promise<void> };
      const hook = (): Promise<{ ready: boolean; failed: string | null }> => page.evaluate(() => { const h = (window as unknown as { __tlVoxelWorld?: PageHook }).__tlVoxelWorld; return { ready: h?.ready === true, failed: h?.failed ?? null }; });
      let w = await until(page, async () => { const h = await hook(); return h.failed !== null ? `failed: ${h.failed}` : h.ready ? null : 'the page not ready'; });
      if (w.ok) {
        const t0 = Date.now();
        // The page's own settle: kits loaded, the streamer and its far field at rest, the near ring settled.
        const settled = await page.evaluate(async (a) => {
          const h = (window as unknown as { __tlVoxelWorld: PageHook }).__tlVoxelWorld;
          h.look!(a.cell[0]!, a.cell[1]!, a.cell[2]!, a.yaw, a.pitch, a.distM);
          return Promise.race([h.settle!().then(() => true), new Promise<string>((r) => setTimeout(() => r(`not done in ${a.ms / 1000} s`), a.ms))]);
        }, { ...l, cell: [...l.cell], ms: SETTLE_MS }).catch((e: unknown) => String(e));
        w = settled === true ? { ok: true, s: Number((w.s + (Date.now() - t0) / 1000).toFixed(1)) } : { ok: false, what: `the page's settle: ${String(settled)}` };
        await page.waitForTimeout(1000);
      }
      out.set('voxel-world-page', await shoot(page, files('voxel-world-page'), w, facts('voxel-world-page', { look: l }), idOf('voxel-world-page'), 'the page ready and its settle done (kits, streaming, far field, near ring)'));
    }
    if (want.includes('play-profiler')) {
      const w0 = await editorOpen(page, `${s.origin}/?project=${s.project}&renderer=webgpu#token=${s.token}`);
      let w: Wait = w0;
      if (w0.ok) {
        await page.getByTitle('Start an isolated play preview').click();
        const game = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
        type Play = { stats(): { worlds: Record<string, { chunks: number; far: { bricks: number } }> }; light?: { progress(): { settled?: boolean; waiting: number; staleUnits?: number } | null } };
        let last = '';
        let still = 0;
        w = await until(page, async () => {
          const r = await game.evaluate((_c, world) => {
            const h = (window as unknown as { __tlVoxelPlay?: Play }).__tlVoxelPlay;
            if (h === undefined) return null;
            const st = h.stats().worlds[world];
            const p = h.light?.progress() ?? null;
            return { chunks: st?.chunks ?? 0, bricks: st?.far.bricks ?? 0, lit: p === null ? null : p.settled === true && p.waiting === 0, light: p === null ? '' : `settled ${String(p.settled)}, ${p.staleUnits ?? 0} stale, ${p.waiting} waiting` };
          }, s.world).catch(() => null);
          if (r === null) return 'Play not drawing yet';
          if (r.chunks === 0) return 'no chunk drawn in Play';
          const now = `${r.chunks}/${r.bricks}`;
          still = now === last ? still + 1 : 0;
          last = now;
          // Counts unchanged for 3 s (12 polls) and the light volume settled.
          if (still < 12) return `streaming (chunks/bricks ${now})`;
          if (r.lit === false) return `the light volume settling (${r.light})`;
          return null;
        });
        // The Profiler opened on a Play that has run for a while: its first read is then the page's full rings, the
        // largest answer the panel ever asks for.
        await page.locator('.tl-dock--bottom > [role=tablist] [role=tab]', { hasText: 'Profiler' }).click();
        const panel = page.getByTestId('profiler-timeline');
        const p = await until(page, async () => ((await panel.count()) > 0 && (await panel.isVisible()) ? null : 'the Profiler timeline not shown'), 30_000);
        if (w.ok && !p.ok) w = p;
        // The timeline drawn with frames in it: columns, and the page's bars among them (what the picture shows).
        const bars = await until(page, async () => {
          const a = await panel.evaluate((el) => ({ columns: Number(el.dataset['columns'] ?? 0), page: Number(el.dataset['pageBars'] ?? 0) })).catch(() => null);
          if (a === null || a.columns === 0) return 'the Profiler timeline holds no frame';
          return a.page > 0 ? null : 'the Profiler timeline has no page bar drawn';
        }, 30_000);
        if (w.ok && !bars.ok) w = bars;
      }
      out.set('play-profiler', await shoot(page, files('play-profiler'), w, facts('play-profiler', { camera: 'the project\'s Perf far camera as its behaviour holds it' }), idOf('play-profiler'), 'Play drawing, its streaming counts still for 3 s and the light volume settled, the Profiler timeline shown with frames and page bars'));
      await page.getByTitle('Stop the play preview').click().catch(() => undefined);
      await page.locator('iframe.tl-app__preview-frame').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
    }
  } finally {
    await context.close();
  }
  return out;
}
