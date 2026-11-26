/**
 * The picture set's editor screens (picture-list.ts `screen` entries), taken by driving the real editor against a
 * real backend with Playwright as a library, one browser for all of them.
 *
 * The authoring screens (the editor with a scene, structure mode, a water body, a spline road) are taken on a fresh
 * backend (tests/e2e/backend.ts: its own data root, removed after) whose project holds a made yard: 64 m of flat
 * grass in a voxel world, a two-storey house with a door and windows, a lake in a dug hollow and a spline that
 * writes a road, every one made by the same commands the editor sends. The voxel world page and Play are taken on
 * staging's 8 km town (what the world pictures show), which they only read.
 *
 * Each screen waits for the editor's own settle signals (the Scene view's voxel worlds settled and no frame wanted,
 * the page's `settle`, Play's streaming counts and light volume), never a fixed sleep; a screen that does not settle
 * within its timeout is saved but reported "did not settle: <what>".
 */
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { chunkGrid, createWorldStore } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';
import { startBackend, type E2EBackend } from '../../tests/e2e/backend';
import { mustCommand } from '../../tests/support/commands';
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
const YARD_MAT = { road: 21, water: 30 } as const;

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
  readonly worlds: Record<string, { chunks: number }>;
  readonly states: Record<string, { settled: boolean; grids?: Record<string, { settled: boolean }> }>;
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
        type Play = { stats(): { worlds: Record<string, { chunks: number; far: { bricks: number } }> }; light?: { progress(): { settled?: boolean; waiting: number } | null } };
        let last = '';
        let still = 0;
        w = await until(page, async () => {
          const r = await game.evaluate((_c, world) => {
            const h = (window as unknown as { __tlVoxelPlay?: Play }).__tlVoxelPlay;
            if (h === undefined) return null;
            const st = h.stats().worlds[world];
            const p = h.light?.progress() ?? null;
            return { chunks: st?.chunks ?? 0, bricks: st?.far.bricks ?? 0, lit: p === null ? null : p.settled === true && p.waiting === 0 };
          }, s.world).catch(() => null);
          if (r === null) return 'Play not drawing yet';
          if (r.chunks === 0) return 'no chunk drawn in Play';
          const now = `${r.chunks}/${r.bricks}`;
          still = now === last ? still + 1 : 0;
          last = now;
          // Counts unchanged for 3 s (12 polls) and the light volume settled.
          if (still < 12) return `streaming (chunks/bricks ${now})`;
          if (r.lit === false) return 'the light volume settling';
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
