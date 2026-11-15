/**
 * Voxel shadows read from Play's pixels (voxel-world.e2e.ts's Play test drives them): a script-built wall's sun
 * shadow, a moving box in it, a red lamp's shadow of the wall, a moving box's shadow on the voxel grass. Pixels read
 * with png.ts.
 */
import { writeFileSync } from 'node:fs';

import { changedPixels, decodePng } from './png';
import { expect, test, type Page } from './pw';

/** What the checks drive: the editor page with Play running, the play session, the character's stand (metres), the test objects' ids and where they wait, and the project API. */
export interface ShadowCheckSetup {
  readonly page: Page;
  readonly psid: string;
  readonly at: readonly number[];
  readonly ids: { readonly blue: string; readonly mover: string; readonly lamp: string };
  readonly away: number[];
  readonly api: (path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
}

type Png = ReturnType<typeof decodePng>;
const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
/** The pad's and the hills' grass: green over red and blue, not black. */
const grass = (p: readonly number[]): boolean => p[1]! > 25 && p[1]! > 1.1 * p[0]! && p[1]! > 1.1 * p[2]!;
/** The blue test box (lit or shaded): blue well over green and red. */
const blueBox = (p: readonly number[]): boolean => p[2]! > 30 && p[2]! >= 1.6 * p[1]! && p[2]! >= 2 * p[0]!;

/** Pixels that are grass in both pictures and at least `factor` times as bright in `b` as in `a`. */
function grassBrighter(a: Png, b: Png, factor: number): number {
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    if (grass(p) && grass(q) && lum(q) >= factor * Math.max(lum(p), 1)) n += 1;
  }
  return n;
}

/** How much brighter the blue box is in `b` than in `a`, over the pixels where both show it (and how many). */
function blueRatio(a: Png, b: Png): { ratio: number; n: number } {
  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    if (blueBox(p) && blueBox(q)) {
      sa += lum(p);
      sb += lum(q);
      n += 1;
    }
  }
  return { ratio: n === 0 ? 0 : sb / sa, n };
}

/**
 * Grass a red lamp lights once the wall between them is gone, and not while it stands: red the lamp adds to the
 * grass without the wall (`noWall` − `noWallDark`) of at least `minAdd`, of which the same view with the wall keeps
 * less than `keep` (`wall` − `wallDark`).
 */
function lampShadowed(wallDark: Png, wall: Png, noWallDark: Png, noWall: Png, minAdd: number, keep: number): number {
  let n = 0;
  for (let y = 0; y < wall.height; y++) for (let x = 0; x < wall.width; x++) {
    const ground = noWallDark.pixel(x, y);
    if (!grass(ground) || !grass(wallDark.pixel(x, y))) continue;
    const add = noWall.pixel(x, y)[0]! - ground[0]!;
    const kept = wall.pixel(x, y)[0]! - wallDark.pixel(x, y)[0]!;
    if (add >= minAdd && kept < keep * add) n += 1;
  }
  return n;
}

/** What every check drives: debug commands, the script's counters, moving objects, still pictures (saved by name). */
function driver(o: ShadowCheckSetup) {
  const { page, psid, at, api } = o;
  const frame = page.locator('iframe.tl-app__preview-frame');
  const control = async (name: string, args?: Record<string, unknown>): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name, ...(args !== undefined ? { args } : {}) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const counter = async (name: string): Promise<number> => (((await api(`play/${psid}/observe`)).json as { counters?: Record<string, number> }).counters ?? {})[name] ?? 0;
  const rel = (dx: number, dy: number, dz: number): number[] => [at[0]! + dx, at[1]! + dy, at[2]! + dz];
  const place = (id: string, p: readonly number[]): Promise<void> => control('place', { id, x: p[0], y: p[1], z: p[2] });
  /** The picture once two shots 150 ms apart differ in fewer than 40 pixels (streaming, fades and shadow draws done). */
  const still = async (name: string): Promise<Png> => {
    let last = null as Png | null;
    let png = null as Buffer | null;
    await expect.poll(async () => {
      const b = await frame.screenshot();
      const img = decodePng(b);
      const same = last !== null && changedPixels(last, img, () => true, 30) < 40;
      last = img;
      png = b;
      return same;
    }, { timeout: 20_000, intervals: [150], message: `${name}: the picture settles` }).toBe(true);
    writeFileSync(test.info().outputPath(`${name}.png`), png!);
    return last!;
  };
  return { frame, control, counter, rel, place, still };
}

/**
 * Voxel shadows in Play (WebGPU), on the pad 8 km out under the scene's sun (from the south-west above): a wall 4 m
 * tall built by the script beside the character. Its sun shadow darkens the grass east of it and a moving box
 * standing in it; a red lamp east of it leaves the grass west of it dark; the wall dug (one edit), the grass there
 * brightens and the box with it as soon as the shadows are drawn again (the key light's cached map and the lamp's
 * atlas tile follow the edit). Then a moving box over the pad darkens the voxel grass under it. Each reading is
 * waited for, then required past a bound set well inside what was measured (`console.log`ged with each run).
 */
export async function voxelShadowChecks(o: ShadowCheckSetup): Promise<void> {
  const { ids, away } = o;
  const { frame, control, counter, rel, place, still } = driver(o);
  await control('wall');
  await expect.poll(() => counter('wallBuilt'), { timeout: 10_000 }).toBe(1);
  // In the wall's shadow: 0.3–0.9 m east of its east face, its top 0.6 m up (the shadow there reaches 1.4 m out).
  await place(ids.blue, rel(-1.9, 0.3, -0.75));
  const wall = await still('shadow-wall');
  // The wall dug: its sun shadow goes from the grass and the box once the key light's cached map is drawn again.
  const t0 = Date.now();
  await control('unwall');
  let lit = 0;
  await expect.poll(async () => (lit = grassBrighter(wall, decodePng(await frame.screenshot()), SHADOW_LIT_FACTOR)), { timeout: 15_000, intervals: [50], message: 'the dug wall\'s sun shadow goes' }).toBeGreaterThan(SUN_SHADOW_MIN_PX);
  const sunMs = Date.now() - t0;
  expect(await counter('wallDug')).toBe(1);
  const dug = await still('shadow-dug');
  const sun = grassBrighter(wall, dug, SHADOW_LIT_FACTOR);
  const box = blueRatio(wall, dug);
  // The lamp 0.5 m west of where the wall stood, 3.5 m up (under its top); the wall built again stands between it and
  // the grass east of it (in view): that grass loses the lamp's light once the lamp's atlas tile is drawn again.
  await place(ids.lamp, rel(-3.5, 3.5, -0.75));
  const dugLamp = await still('shadow-dug-lamp');
  const t1 = Date.now();
  await control('wall');
  let kept = 0;
  await expect.poll(async () => (kept = lampShadowed(wall, decodePng(await frame.screenshot()), dug, dugLamp, LAMP_ADD_MIN, LAMP_KEEP)), { timeout: 15_000, intervals: [50], message: "the rebuilt wall's lamp shadow comes" }).toBeGreaterThan(LAMP_SHADOW_MIN_PX);
  const lampMs = Date.now() - t1;
  const wallLamp = await still('shadow-wall-lamp');
  const lamp = lampShadowed(wall, wallLamp, dug, dugLamp, LAMP_ADD_MIN, LAMP_KEEP);
  await control('unwall');
  await place(ids.lamp, away);
  await expect.poll(() => counter('wallDug'), { timeout: 10_000 }).toBe(2);
  await still('shadow-dug-again');
  // A moving box over the pad (0.8 m, its foot 0.8 m up): its shadow on the voxel grass.
  await place(ids.blue, away);
  await place(ids.mover, rel(-5.75, 1.2, -0.25));
  const mover = await still('shadow-mover');
  await place(ids.mover, away);
  const clear = await still('shadow-clear');
  const under = grassBrighter(mover, clear, SHADOW_LIT_FACTOR);
  console.log(`[voxel-play] shadows: sun shadow of the wall on the grass ${sun} px (a shot without it ${sunMs} ms after the dig command, ${lit} px), the box in it ${box.ratio.toFixed(2)} × as bright without it (${box.n} px), lamp shadow ${lamp} px (a shot with it ${lampMs} ms after the build command, ${kept} px), moving box's shadow ${under} px`);
  expect(sun, 'the wall darkens the grass east of it').toBeGreaterThan(SUN_SHADOW_MIN_PX);
  expect(box.n, 'the blue box is in view').toBeGreaterThan(200);
  expect(box.ratio, 'the wall shades the moving box').toBeGreaterThan(BOX_LIT_RATIO);
  expect(lamp, "the wall keeps the lamp's light off the grass behind it").toBeGreaterThan(LAMP_SHADOW_MIN_PX);
  expect(under, "the moving box's shadow falls on the voxel grass").toBeGreaterThan(MOVER_SHADOW_MIN_PX);
}

/**
 * The bounds, from the readings of the first green run (high tier, the preview's 670 × 253 picture): sunlit grass
 * 1.13–1.17 × as bright as shaded (sun 1.2 over ambient 0.6), so a pixel counts at 1.06; the wall's sun shadow 1,161
 * grass pixels (bound 400); the blue box (its 400 pixels shown in both) 1.62 × as bright out of it (bound 1.25); the
 * red lamp adds 45–120 to the grass east of the wall, of which the wall keeps 0 (a pixel counts adding 30, keeping
 * under 35 %): 16,120 pixels (bound 5,000); the moving box's shadow 375 pixels (bound 120). With voxel shadows off
 * (`?voxelShadows=off`, run once): 0, 1.00, 1 and 0.
 */
const SHADOW_LIT_FACTOR = 1.06;
const SUN_SHADOW_MIN_PX = 400;
const BOX_LIT_RATIO = 1.25;
const LAMP_ADD_MIN = 30;
const LAMP_KEEP = 0.35;
const LAMP_SHADOW_MIN_PX = 5000;
const MOVER_SHADOW_MIN_PX = 120;


/** The far checks' setup: the shadow checks' own, the Play camera's id and where it stands. */
export interface FarLightSetup extends ShadowCheckSetup {
  readonly camera: string;
  readonly cameraAt: readonly number[];
}

/**
 * Per band of `BAND_ROWS` rows over the shadow strip: how much darker `wall` is than `dug` (the ratio of their
 * brightness) over the grass pixels `mask` holds. The largest change from one band to the next (bands with at least
 * `BAND_MIN_PX` pixels) is a seam in the shadow; the ratios themselves are returned for the log.
 */
function bandSteps(wall: Png, dug: Png, mask: (x: number, y: number) => boolean): { step: number; ratios: number[] } {
  const ratios: number[] = [];
  for (let y0 = 0; y0 + BAND_ROWS <= wall.height; y0 += BAND_ROWS) {
    let a = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y0 + BAND_ROWS; y++) for (let x = 0; x < wall.width; x++) {
      if (!mask(x, y)) continue;
      a += lum(wall.pixel(x, y));
      b += lum(dug.pixel(x, y));
      n++;
    }
    ratios.push(n >= BAND_MIN_PX ? a / b : NaN);
  }
  let step = 0;
  for (let i = 1; i < ratios.length; i++) if (Number.isFinite(ratios[i]!) && Number.isFinite(ratios[i - 1]!)) step = Math.max(step, Math.abs(ratios[i]! - ratios[i - 1]!));
  return { step, ratios: ratios.filter(Number.isFinite).map((r) => Number(r.toFixed(3))) };
}

/**
 * The sun past the key light's map (WebGPU, the sun heights' shade lines):
 *
 * - a long wall 8 m tall built by the script from 4 m to 38 m ahead: its sun shadow on the grass east of it runs from
 *   inside the key light's map (±26 m round the ground under the camera) out past it. With the march turned off on
 *   the page (`setSunOff`) the shadow stops at the map's edge: the grass past it is brighter; with it on, the strip
 *   is shaded along its length without a step where the map hands over (the band-to-band change of the wall/dug
 *   brightness ratio along the strip stays small, and with the march off it is a step);
 */
export async function voxelFarLightChecks(o: FarLightSetup): Promise<void> {
  const { page, camera, cameraAt } = o;
  const { control, counter, place, still } = driver(o);
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const sunOff = (off: boolean): Promise<unknown> => frame.locator('canvas').first().evaluate((_, v) => (window as unknown as { __tlVoxelPlay: { setSunOff(o: boolean): void } }).__tlVoxelPlay.setSunOff(v), off);
  type SunStats = { steps: number; waiting: number[]; marching: number; farNodes: number };
  const sunStats = (): Promise<SunStats | null> => frame.locator('canvas').first().evaluate(() => (window as unknown as { __tlVoxelPlay: { sun(): SunStats | null } }).__tlVoxelPlay.sun());
  // The tops composed and the shade lines marched again over every row (a change shows once both are done).
  const fieldDone = async (what: string): Promise<number> => {
    const t0 = Date.now();
    await expect.poll(async () => { const s = await sunStats(); return s === null ? -1 : s.waiting[0]! + s.waiting[1]! + s.marching; }, { timeout: 20_000, intervals: [50], message: `${what}: the sun field caught up` }).toBe(0);
    return Date.now() - t0;
  };
  const first = await sunStats();
  expect(first, 'the page has sun heights').not.toBeNull();
  expect(first!.steps, "the tier's samples").toBeGreaterThan(0);
  await expect.poll(async () => (await sunStats())?.farNodes ?? 0, { timeout: 20_000, message: 'far tops' }).toBeGreaterThan(0);
  // The long wall: its shadow with the march on and off, and the grass with no wall (the strip's lit look). The camera
  // 10 m back and 15 m up (the strip 14–48 m ahead of it): the map's square (round the ground under it) ends about
  // 16 m past the character, so the strip crosses its edge.
  await place(camera, [cameraAt[0]!, cameraAt[1]! + 15, cameraAt[2]! + 10]);
  const t0 = Date.now();
  await control('longwall');
  await expect.poll(() => counter('longWallBuilt'), { timeout: 10_000 }).toBe(1);
  // The wall's chunk columns' sky heights reach the page with the batches, its tops are composed, the lines marched.
  await expect.poll(async () => (await sunStats())?.marching ?? 0, { timeout: 10_000, intervals: [20], message: 'the lines march again' }).toBeGreaterThan(0);
  await fieldDone('the wall built');
  const builtMs = Date.now() - t0;
  const wallOn = await still('far-wall-march');
  await sunOff(true);
  const wallOff = await still('far-wall-map-only');
  await sunOff(false);
  const t1 = Date.now();
  await control('unlongwall');
  await expect.poll(() => counter('longWallDug'), { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await sunStats())?.marching ?? 0, { timeout: 10_000, intervals: [20], message: 'the lines march again' }).toBeGreaterThan(0);
  await fieldDone('the wall dug');
  const dugMs = Date.now() - t1;
  const dug = await still('far-wall-dug');
  await place(camera, cameraAt);
  const pastMap = grassBrighter(wallOn, wallOff, SHADOW_LIT_FACTOR);
  // The strip: grass the wall shades with the march on (brighter once it is dug).
  const strip = (x: number, y: number): boolean => grass(wallOn.pixel(x, y)) && grass(dug.pixel(x, y)) && lum(dug.pixel(x, y)) >= SHADOW_LIT_FACTOR * Math.max(lum(wallOn.pixel(x, y)), 1);
  const on = bandSteps(wallOn, dug, strip);
  const off = bandSteps(wallOff, dug, strip);
  console.log(`[voxel-play] far light: the field caught up ${builtMs} ms after the build command, ${dugMs} ms after the dig; grass the march shades past the map ${pastMap} px; strip band ratios on ${JSON.stringify(on.ratios)} (largest step ${on.step.toFixed(3)}), march off ${JSON.stringify(off.ratios)} (largest step ${off.step.toFixed(3)})`);
  expect(pastMap, 'the march shades the strip past the map').toBeGreaterThan(FAR_SHADOW_MIN_PX);
  expect(on.ratios.length, 'shadow bands along the strip').toBeGreaterThan(5);
  expect(on.step, 'no seam where the map hands over').toBeLessThan(SEAM_MAX_STEP);
  expect(off.step, 'with the march off the strip ends at the map: a step').toBeGreaterThan(2 * on.step);
}

/** Rows a band of the strip spans, and the pixels a band needs to count. */
const BAND_ROWS = 6;
const BAND_MIN_PX = 20;
/**
 * The bounds, from the readings of the first green run (high tier, the preview's 670 × 253 picture): the march shades
 * 731 grass pixels past the map that the map alone leaves lit (bound 300); along the strip the wall/dug ratio is
 * 0.854–0.866 band to band, largest step 0.008 (bound 0.03), and with the march off it rises from 0.857 inside the
 * map to 1.0 past it, largest step 0.058.
 */
const FAR_SHADOW_MIN_PX = 300;
const SEAM_MAX_STEP = 0.03;

/** What the surface cache holds of the voxel worlds (the page's `__tlVoxelPlay.light.cache()`; null: the store is not the cache). */
interface CacheStats {
  readonly tiles: number;
  readonly resident: number;
  readonly residentTexels: number;
  readonly litTexels: number;
  readonly staleUnits: number;
  readonly waiting: number;
  readonly texelsWritten: number;
  readonly live: boolean;
  readonly read: boolean;
  /** The live probes over the voxels (absent: none placed yet). */
  readonly probes?: { readonly probes: number; readonly lit: number; readonly stale: number; readonly settled: boolean; readonly drawn: boolean; readonly behind: boolean };
}

/**
 * The surface cache lighting the voxel surfaces (WebGPU, the page's lighting store switched at run time, as
 * `?voxelLight=cache` sets it at the start): a red lamp east of the script's wall, a pillar a cell square between them.
 * The store off, the page has no cache tiles. Switched to the cache, its voxel texels are lit (a counter from the page,
 * waited for), the lamp lights the wall and the grass by the cache's light, and the pillar's traced shadow keeps it off
 * the wall and grass behind (red the lamp adds there without the pillar, which the pillar takes away). Switched off
 * again, the picture is the store-off picture as it was.
 */
export async function voxelCacheLightChecks(o: FarLightSetup): Promise<void> {
  const { ids, away } = o;
  const { frame, control, counter, rel, place, still } = driver(o);
  const hook = async <T>(f: string, arg?: unknown): Promise<T> => (await o.page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first().evaluate((_, a) => {
    const l = (window as unknown as { __tlVoxelPlay: { light: Record<string, (x?: unknown) => unknown> } }).__tlVoxelPlay.light;
    return l[a.f]!(a.arg);
  }, { f, arg })) as T;
  const lamp = rel(-0.75, 1.25, -1.5);
  await control('wall');
  await control('pillar');
  await expect.poll(async () => [await counter('wallBuilt'), await counter('pillarBuilt')], { timeout: 10_000 }).toEqual([3, 1]);
  await place(ids.lamp, lamp);
  expect(await hook<string>('store')).toBe('off');
  expect(await hook<CacheStats | null>('cache'), 'no cache tiles while the store is off').toBeNull();
  const off = await still('cache-off-lamp');
  // The cache: its voxel texels lit, nothing stale or waiting, the surfaces reading it.
  await hook('setStore', 'cache');
  let stats: CacheStats | null = null;
  const settled = async (what: string): Promise<void> => {
    try {
      await expect.poll(async () => {
        stats = await hook<CacheStats | null>('cache');
        const p = stats?.probes;
        const probes = p !== undefined && p.lit > 0 && p.settled && p.drawn && !p.behind;
        return stats !== null && stats.live && stats.read && stats.resident > 0 && stats.litTexels > 0 && stats.texelsWritten > 0 && stats.waiting === 0 && stats.staleUnits === 0 && probes;
      }, { timeout: 60_000, intervals: [250], message: `${what}: the cache's voxel texels and probes are lit` }).toBe(true);
    } catch (e) {
      // What was not lit, for whoever reads the failure.
      throw new Error(`${String(e).slice(0, 300)}; the last reading: ${JSON.stringify(stats).slice(0, 1500)}`);
    }
  };
  const t0 = Date.now();
  await settled('the store switched');
  const litMs = Date.now() - t0;
  const pillarLamp = await still('cache-pillar-lamp');
  await place(ids.lamp, away);
  await settled('the lamp away');
  const pillarDark = await still('cache-pillar-dark');
  await control('unpillar');
  await expect.poll(() => counter('pillarDug'), { timeout: 10_000 }).toBe(1);
  await settled('the pillar dug');
  const openDark = await still('cache-open-dark');
  await place(ids.lamp, lamp);
  await settled('the lamp back');
  const openLamp = await still('cache-open-lamp');
  const lit = redAdded(openDark, openLamp, LAMP_ADD_MIN);
  const shadow = pillarShadowed(pillarDark, pillarLamp, openDark, openLamp, LAMP_ADD_MIN, LAMP_KEEP);
  // An edit under the lit lamp: the pillar built between it and the lit wall, the texels behind it relit dark once the
  // light settles; dug again, lit again.
  // Each edit waits for its change to reach the cache's light (texels written after the command), then for the settle.
  const written = async (): Promise<number> => (await hook<{ texelsWritten: number } | null>('progress'))?.texelsWritten ?? 0;
  const reached = async (what: string, from: number): Promise<void> => {
    await expect.poll(written, { timeout: 30_000, intervals: [50], message: `${what}: the cache relights texels for it` }).toBeGreaterThan(from);
  };
  const tBuild = Date.now();
  let w0 = await written();
  await control('pillar');
  await expect.poll(() => counter('pillarBuilt'), { timeout: 10_000 }).toBe(2);
  await reached('the pillar built under the lamp', w0);
  await settled('the pillar built under the lamp');
  const builtMs = Date.now() - tBuild;
  const pillarEdit = await still('cache-pillar-edit');
  const tDig = Date.now();
  w0 = await written();
  await control('unpillar');
  await expect.poll(() => counter('pillarDug'), { timeout: 10_000 }).toBe(2);
  await reached('the pillar dug under the lamp', w0);
  await settled('the pillar dug under the lamp');
  const dugMs = Date.now() - tDig;
  const openEdit = await still('cache-open-edit');
  const edit = editRelit(pillarDark, pillarLamp, openDark, openLamp, pillarEdit, openEdit);
  const changed = changedPixels(off, pillarLamp, () => true, 20);
  const cs = stats as CacheStats | null;
  await place(ids.lamp, away);
  const hut = await probeHutChecks(o, settled, hook);
  // Off again, the pillar back: the picture is the store-off one.
  await control('pillar');
  await expect.poll(() => counter('pillarBuilt'), { timeout: 10_000 }).toBe(3);
  await hook('setStore', 'off');
  await expect.poll(() => hook<CacheStats | null>('cache'), { timeout: 10_000 }).toBeNull();
  // The shut hut with the store off: the flat ambient term lights its inside as it lights the street.
  await place(o.camera, hut.eye);
  await place(ids.blue, hut.box);
  const hutOff = await still('probe-hut-shut-off');
  await place(o.camera, o.cameraAt);
  await place(ids.blue, away);
  await control('unhut');
  await expect.poll(() => counter('hutDug'), { timeout: 10_000 }).toBe(1);
  await place(ids.lamp, lamp);
  const offAgain = await still('cache-off-again');
  const same = changedPixels(off, offAgain, () => true, 20);
  await place(ids.lamp, away);
  await control('unpillar');
  await control('unwall');
  await expect.poll(() => counter('wallDug'), { timeout: 10_000 }).toBe(3);
  console.log(`[voxel-play] surface cache: lit ${litMs} ms after the switch (${JSON.stringify(cs)}); the lamp adds red to ${lit} px; the pillar's shadow ${shadow} px; the cache's picture differs from the store-off one in ${changed} px, the store-off one before and after in ${same} px`);
  console.log(`[voxel-play] surface cache edits: the pillar built under the lit lamp settled ${builtMs} ms after the command, ${edit.stillLit} of its ${edit.shadow} shadowed px still lit; dug again, settled ${dugMs} ms after, ${edit.litAgain} lit again`);
  expect(lit, 'the lamp lights the wall and grass by the cache').toBeGreaterThan(CACHE_LIT_MIN_PX);
  expect(shadow, "the pillar's traced shadow keeps the lamp off what is behind it").toBeGreaterThan(CACHE_SHADOW_MIN_PX);
  expect(edit.shadow, 'the pillar shadows the lit wall').toBeGreaterThan(CACHE_SHADOW_MIN_PX);
  expect(edit.stillLit, 'built under the lit lamp, the texels behind the pillar are relit dark').toBeLessThan(EDIT_STILL_LIT_SHARE * edit.shadow);
  expect(edit.litAgain, 'dug again, they are lit again').toBeGreaterThan(EDIT_LIT_AGAIN_SHARE * edit.shadow);
  expect(changed, 'the cache changes the picture').toBeGreaterThan(CACHE_CHANGED_MIN_PX);
  expect(same, 'switched off, the picture is the store-off one').toBeLessThan(CACHE_SAME_MAX_PX);
  // The live probes: the shut hut darker inside by the cache than by the flat term (sky occlusion), its blue box too;
  // the roof opened, brighter (the sky and the sun's patch on its floor, bounced by the probes).
  const wallsOff = meanLum(hutOff, WALL_ROWS);
  const boxCache = meanOf(hut.shut, blueBox);
  const boxOff = meanOf(hutOff, blueBox);
  console.log(`[voxel-play] live probes: resolve GPU against CPU ${JSON.stringify(hut.resolve)}; ${JSON.stringify(hut.probes)}; hut walls (upper rows) shut ${hut.walls.shut.toFixed(1)}, open ${hut.walls.open.toFixed(1)}, shut with the store off ${wallsOff.toFixed(1)}; the open roof reached the probes ${hut.openMs} ms after the command; blue box inside ${boxCache.lum.toFixed(1)} (${boxCache.n} px) against ${boxOff.lum.toFixed(1)} with the store off (${boxOff.n} px)`);
  expect(hut.resolve, 'the resolve check ran').not.toBeNull();
  const rc = hut.resolve!;
  expect(rc.rays).toBe(1200);
  expect(rc.voxelHits, 'probe rays hit voxels').toBeGreaterThan(500);
  expect(rc.resolved, 'voxel hits resolve to texels on the GPU').toBeGreaterThan(0.9 * rc.voxelHits);
  expect(rc.lit, 'and read lit texels').toBeGreaterThan(0.5 * rc.voxelHits);
  expect(rc.mismatches, JSON.stringify(rc.examples)).toBeLessThanOrEqual(RESOLVE_MISMATCH_MAX);
  expect(hut.walls.shut, 'the shut hut is darker inside by the probes than by the flat ambient term').toBeLessThan(HUT_DARK_SHARE * wallsOff);
  expect(hut.walls.open, 'the roof opened, the hut is brighter inside').toBeGreaterThan(HUT_OPEN_FACTOR * hut.walls.shut);
  expect(boxCache.n, 'the blue box is in view inside').toBeGreaterThan(100);
  expect(boxCache.lum, 'the moving box inside reads the probes: darker than by the flat term').toBeLessThan(HUT_DARK_SHARE * boxOff.lum);
}

/** The light volume's progress and a cell read back (the page's `__tlVoxelPlay.light.progress` / `volumeCells`). */
interface VolumeProgress {
  readonly texelsWritten: number;
  readonly staleUnits: number;
  readonly waiting: number;
  readonly settled: boolean;
}
interface VolumeCell {
  readonly cell: number[];
  readonly kept: boolean;
  readonly updates: number;
  readonly holds: boolean;
  readonly faces: (number[] | null)[];
}

const clum = (c: readonly number[] | null): number => (c === null ? 0 : 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!);

/**
 * The mean green over red of a picture over the hut's walls: pixels not near black where `walls` (the green-floor
 * picture) is redder than green, so the green floor itself is left out of both pictures' readings.
 */
function greenOverRed(img: Png, walls: Png): { ratio: number; n: number } {
  let g = 0;
  let r = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const w = walls.pixel(x, y);
    const p = img.pixel(x, y);
    if (w[1]! >= w[0]! || p[0]! + p[1]! + p[2]! < 15) continue;
    g += p[1]!;
    r += p[0]!;
    n++;
  }
  return { ratio: r === 0 ? 0 : g / r, n };
}

/** Pixels of `img` that `test` takes, as a mask (the place a test object shows, found in one picture and read in others). */
function maskOf(img: Png, test: (p: readonly number[]) => boolean): boolean[] {
  const m: boolean[] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) m.push(test(img.pixel(x, y)));
  return m;
}

/** The mean brightness of `img` over a mask's pixels, and how many. */
function meanOver(img: Png, mask: readonly boolean[]): { lum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!mask[y * img.width + x]) continue;
    sum += lum(img.pixel(x, y));
    n++;
  }
  return { lum: n === 0 ? 0 : sum / n, n };
}

/** The test kit's sheet on its pieces as lit in the hut: violet (red and blue well over green; 157, 102, 191 by the flat term). */
const magenta = (p: readonly number[]): boolean => p[0]! > 60 && p[0]! > 1.3 * p[1]! && p[2]! > 1.5 * p[1]!;

/**
 * The red over green the volume holds round the script's wall where the lamp's light bounces (cells between it and the
 * pillar's place, up its east face): the lamp is red, the sun's and the sky's bounce near grey, so red over green is the
 * lamp's bounce. Summed over the faces of the cells holding light.
 */
function lampBounce(cells: readonly VolumeCell[]): { red: number; n: number } {
  let red = 0;
  let n = 0;
  for (const c of cells) {
    if (!c.faces.some((f) => f !== null)) continue;
    n++;
    for (const f of c.faces) if (f !== null) red += Math.max(0, f[0]! - f[1]!);
  }
  return { red, n };
}

/**
 * The voxel light volume (the store `volume`), on the hut the probe checks use, with a stone stub in it (the test kit's
 * pieces at its edges) and the blue box on its floor: the store off, the shut hut, its stub's kit pieces and the box by
 * the flat term; switched to the volume and settled, all three darker (sky occluded: the walls by their 0.5 m cells,
 * the kit pieces by the cells beside the stub, the box mostly by the 1 m level); the volume's cells read back from the
 * GPU round the hut against the CPU's rule (which cells hold light), at 0.5 m and at 1 m, a cell over the roof under
 * open sky against the sky term, cells inside the shut hut near none; the roof opened, brighter once settled again; the
 * floor repainted green under the open roof, the walls greener by its bounce than over the plaster floor (the open
 * picture). Then outside, the hut dug: the box 1.7 m over the pad, in the open, about as bright by the volume as by the
 * flat term (the coarse levels' sky); the script's wall built and a red lamp east of it, the pillar built between them
 * takes the lamp's bounce off the cells up the wall's lit face, dug again it comes back. Off again, the picture is the
 * store-off one.
 */
export async function voxelVolumeLightChecks(o: FarLightSetup): Promise<void> {
  const { ids, away } = o;
  const { control, counter, rel, place, still } = driver(o);
  const hook = async <T>(f: string, arg?: unknown): Promise<T> => (await o.page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first().evaluate((_, a) => {
    const l = (window as unknown as { __tlVoxelPlay: { light: Record<string, (x?: unknown) => unknown> } }).__tlVoxelPlay.light;
    return l[a.f]!(a.arg);
  }, { f, arg })) as T;
  let last: VolumeProgress | null = null;
  const settled = async (what: string): Promise<number> => {
    const t0 = Date.now();
    try {
      await expect.poll(async () => {
        last = await hook<VolumeProgress | null>('progress');
        return last !== null && last.settled && last.texelsWritten > 0 && last.waiting === 0;
      }, { timeout: 60_000, intervals: [250], message: `${what}: the light volume settles` }).toBe(true);
    } catch (e) {
      throw new Error(`${String(e).slice(0, 300)}; the last reading: ${JSON.stringify(last)}; ${JSON.stringify(await hook('volume')).slice(0, 1200)}`);
    }
    return Date.now() - t0;
  };
  const counted = async (cmd: string, name: string): Promise<void> => {
    const n = await counter(name);
    await control(cmd);
    await expect.poll(() => counter(name), { timeout: 10_000 }).toBe(n + 1);
  };
  const staleSoon = async (what: string): Promise<void> => {
    await expect.poll(async () => (await hook<VolumeProgress | null>('progress'))?.staleUnits ?? 0, { timeout: 10_000, intervals: [50], message: `${what} makes bricks stale` }).toBeGreaterThan(0);
  };
  expect(await hook<string>('store')).toBe('off');
  await place(ids.lamp, away);
  const offBefore = await still('volume-off-before');
  const eye = rel(0, 2.2, 9.5);
  // The box mid-room, 1.2–2 m up and 0.8 m or more from the walls, floor and ceiling: no 0.5 m cell beside its faces in
  // view holds light, so it reads the 1 m level.
  const box = rel(0.8, 1.6, 6.5);
  await counted('hut', 'hutBuilt');
  await counted('hutstone', 'stubBuilt');
  await place(o.camera, eye);
  await place(ids.blue, box);
  const hutOff = await still('volume-hut-off');
  await hook('setStore', 'volume');
  const litMs = await settled('the store switched');
  const shut = await still('volume-hut-shut');
  // The cells round the hut read back from the GPU, the CPU's rule beside each: 0.5 m, then 1 m.
  const pts: number[][] = [];
  for (let x = -3; x <= 3; x += 0.5) for (let y = -0.5; y <= 4; y += 0.5) for (let z = 1.5; z <= 11; z += 0.5) pts.push(rel(x + 0.25, y + 0.25, z + 0.25));
  const cells = (await hook<VolumeCell[] | null>('volumeCells', pts)) ?? [];
  const updated = cells.filter((c) => c.updates > 0);
  const holdsGpu = updated.filter((c) => c.faces.some((f) => f !== null)).length;
  const differ = updated.filter((c) => c.holds !== c.faces.some((f) => f !== null));
  const coarse = (await hook<VolumeCell[] | null>('volumeCells', { points: pts, level: 1 })) ?? [];
  const coarseUpdated = coarse.filter((c) => c.updates > 0);
  const coarseHolds = coarseUpdated.filter((c) => c.faces.some((f) => f !== null)).length;
  const coarseDiffer = coarseUpdated.filter((c) => c.holds !== c.faces.some((f) => f !== null));
  const [inside, roof] = (await hook<VolumeCell[] | null>('volumeCells', [rel(0.25, 0.75, 6.25), rel(0.25, 3.75, 6.25)])) ?? [];
  const [midRoom] = (await hook<VolumeCell[] | null>('volumeCells', { points: [rel(0, 1.5, 7)], level: 1 })) ?? [];
  const sky = ((await hook<{ skyUp: number[] } | null>('volume'))?.skyUp ?? [0, 0, 0]) as number[];
  await place(ids.blue, away);
  const t0 = Date.now();
  await counted('unstone', 'stubDug');
  await counted('hutopen', 'hutOpened');
  await staleSoon('the opened roof');
  await settled('the hut opened');
  const openMs = Date.now() - t0;
  const open = await still('volume-hut-open');
  // The floor repainted green under the open roof: the walls' bounce takes its colour (against the open picture's
  // plaster floor).
  await counted('hutgreen', 'hutGreen');
  await staleSoon('the repainted floor');
  await settled('the floor green');
  const green = await still('volume-hut-green');
  const plain = open;
  const stats = await hook('volume');
  // Outside: the hut gone, the box 1.7 m over the pad in the open, by the volume; a red lamp east of the script's
  // wall (the pillar built between them, then dug: the lamp's bounce up the wall's lit face).
  await place(o.camera, o.cameraAt);
  await counted('unhut', 'hutDug');
  const boxOut = rel(-1.9, 1.7, -0.75);
  await place(ids.blue, boxOut);
  await settled('the hut dug');
  const outVolume = await still('volume-box-out');
  await place(ids.blue, away);
  await counted('wall', 'wallBuilt');
  await place(ids.lamp, rel(-0.75, 1.25, -1.5));
  await settled('the wall and the lamp');
  const facePts: number[][] = [];
  // The cells between the wall and the pillar's place, where its shadow falls on the wall (z −2 … −1, up to 3 m).
  for (let y = 0; y < 3; y += 0.5) for (let z = -2; z < -1; z += 0.5) facePts.push(rel(-2.25, y + 0.25, z + 0.25));
  const bounce = async (): Promise<{ red: number; n: number }> => lampBounce((await hook<VolumeCell[] | null>('volumeCells', facePts)) ?? []);
  const lit = await bounce();
  const tBuild = Date.now();
  await counted('pillar', 'pillarBuilt');
  await staleSoon('the pillar built');
  await settled('the pillar built between the lamp and the wall');
  const builtMs = Date.now() - tBuild;
  const shaded = await bounce();
  const tDig = Date.now();
  await counted('unpillar', 'pillarDug');
  await staleSoon('the pillar dug');
  await settled('the pillar dug');
  const dugMs = Date.now() - tDig;
  const relit = await bounce();
  // The store off: the box outside by the flat term, then the picture as before.
  await hook('setStore', 'off');
  await expect.poll(() => hook('volume'), { timeout: 10_000 }).toBeNull();
  await place(ids.lamp, away);
  await counted('unwall', 'wallDug');
  await place(ids.blue, boxOut);
  const outOff = await still('volume-box-out-off');
  await place(ids.blue, away);
  const offAfter = await still('volume-off-after');
  const same = changedPixels(offBefore, offAfter, () => true, 20);
  const walls = { off: meanLum(hutOff, WALL_ROWS), shut: meanLum(shut, WALL_ROWS), open: meanLum(open, WALL_ROWS) };
  const tint = { green: greenOverRed(green, green), plain: greenOverRed(plain, green) };
  // The box and the kit pieces where the store-off pictures show them, read there in the volume's.
  const boxMask = maskOf(hutOff, blueBox);
  const kitMask = maskOf(hutOff, magenta);
  const boxIn = { off: meanOver(hutOff, boxMask), volume: meanOver(shut, boxMask) };
  const kit = { off: meanOver(hutOff, kitMask), volume: meanOver(shut, kitMask) };
  const outMask = maskOf(outOff, blueBox);
  const boxOpen = { off: meanOver(outOff, outMask), volume: meanOver(outVolume, outMask) };
  const chunkOf = (p: readonly number[]): string => p.map((v) => Math.floor(v / 16)).join(',');
  const across = chunkOf(rel(-1.75, 1, -1.5)) !== chunkOf(rel(-2.25, 1, -1.5));
  console.log(`[voxel-play] light volume: settled ${litMs} ms after the switch (${JSON.stringify(stats).slice(0, 900)}); hut walls off ${walls.off.toFixed(1)}, shut ${walls.shut.toFixed(1)}, open ${walls.open.toFixed(1)} (roof opened → settled ${openMs} ms); walls' green/red over the green floor ${tint.green.ratio.toFixed(4)} against ${tint.plain.ratio.toFixed(4)} over plaster (${tint.green.n} px); cells round the hut ${cells.length}, updated ${updated.length}, holding light on the GPU ${holdsGpu}, differing from the CPU's rule ${differ.length}; 1 m cells updated ${coarseUpdated.length}, holding ${coarseHolds}, differing ${coarseDiffer.length}; inside the shut hut ${JSON.stringify(inside?.faces)}, its 1 m cell mid-room ${JSON.stringify(midRoom?.faces)}; over its roof ${JSON.stringify(roof?.faces)} against the sky's ${JSON.stringify(sky)}; off before and after ${same} px apart`);
  console.log(`[voxel-play] light volume readers: the blue box in the shut hut ${boxIn.volume.lum.toFixed(1)} against ${boxIn.off.lum.toFixed(1)} by the flat term (${boxIn.off.n} px); the kit pieces on the stub ${kit.volume.lum.toFixed(1)} against ${kit.off.lum.toFixed(1)} (${kit.off.n} px); the box 1.7 m over the pad ${boxOpen.volume.lum.toFixed(1)} against ${boxOpen.off.lum.toFixed(1)} (${boxOpen.off.n} px)`);
  console.log(`[voxel-play] light volume edit: the lamp's red bounce up the wall's face ${lit.red.toFixed(3)} (${lit.n} cells), the pillar built ${shaded.red.toFixed(3)} (settled ${builtMs} ms after the command), dug ${relit.red.toFixed(3)} (${dugMs} ms); the pillar and the face's cells ${across ? 'in two chunks' : 'in one chunk'}`);
  expect(updated.length, 'cells round the hut were updated').toBeGreaterThan(200);
  expect(holdsGpu, 'cells round the hut hold light on the GPU').toBeGreaterThan(100);
  expect(differ.length, JSON.stringify(differ.slice(0, 3))).toBe(0);
  expect(coarseHolds, '1 m cells round the hut hold light on the GPU').toBeGreaterThan(20);
  expect(coarseDiffer.length, JSON.stringify(coarseDiffer.slice(0, 3))).toBe(0);
  expect(inside?.holds, 'the cell over the shut hut floor holds light').toBe(true);
  expect(Math.max(...(inside?.faces ?? []).map(clum)), 'inside the shut hut the volume holds next to no light').toBeLessThan(VOLUME_DARK_SHARE * clum(sky));
  expect(midRoom?.holds, "the 1 m cell in the shut hut's middle holds light").toBe(true);
  expect(Math.max(...(midRoom?.faces ?? []).map(clum)), "the 1 m cell in the shut hut's middle holds next to no light").toBeLessThan(VOLUME_DARK_SHARE * clum(sky));
  expect(clum(roof?.faces[2] ?? null), "over the roof, the up face holds about the sky's light").toBeGreaterThan(VOLUME_SKY_SHARE[0] * clum(sky));
  expect(clum(roof?.faces[2] ?? null), "over the roof, the up face holds about the sky's light").toBeLessThan(VOLUME_SKY_SHARE[1] * clum(sky));
  expect(walls.shut, 'the shut hut is darker inside by the volume than by the flat ambient term').toBeLessThan(HUT_DARK_SHARE * walls.off);
  expect(boxIn.off.n, 'the blue box is in view inside').toBeGreaterThan(100);
  expect(boxIn.volume.lum, 'the moving box inside reads the volume: darker than by the flat term').toBeLessThan(HUT_DARK_SHARE * boxIn.off.lum);
  expect(kit.off.n, 'the kit pieces are in view inside').toBeGreaterThan(50);
  expect(kit.volume.lum, 'the kit pieces inside read the volume: darker than by the flat term').toBeLessThan(HUT_DARK_SHARE * kit.off.lum);
  expect(boxOpen.off.n, 'the blue box is in view over the pad').toBeGreaterThan(100);
  expect(boxOpen.volume.lum, 'the box in the open is lit by the sky the coarse levels hold').toBeGreaterThan(VOLUME_OPEN_SHARE * boxOpen.off.lum);
  expect(walls.open, 'the roof opened, the hut is brighter inside').toBeGreaterThan(HUT_OPEN_FACTOR * walls.shut);
  expect(tint.green.n, 'the walls are in view').toBeGreaterThan(5000);
  expect(tint.green.ratio, "the walls take the green floor's bounce").toBeGreaterThan(VOLUME_TINT_FACTOR * tint.plain.ratio);
  expect(lit.n, 'cells up the wall hold light').toBeGreaterThan(10);
  expect(lit.red, "the lamp's bounce reaches the wall's face").toBeGreaterThan(0);
  expect(shaded.red, "the pillar built between them takes the lamp's bounce off").toBeLessThan(VOLUME_EDIT_SHADED_SHARE * lit.red);
  expect(relit.red, 'dug again, the bounce comes back').toBeGreaterThan(VOLUME_EDIT_BACK_SHARE * lit.red);
  expect(same, 'switched off, the picture is the store-off one').toBeLessThan(CACHE_SAME_MAX_PX);
}

/** The resolve pass's voxel texels against its CPU twin's (the page's `__tlVoxelPlay.light.resolveCheck`). */
interface ResolveCheck {
  readonly rays: number;
  readonly voxelHits: number;
  readonly resolved: number;
  readonly lit: number;
  readonly mismatches: number;
  readonly sceneDiffers: number;
  readonly examples: unknown[];
}

/** Rows of the hut's inside picture showing its walls (the upper part: the far wall and the sides above the floor). */
const WALL_ROWS = 0.4;

/** The mean brightness of a picture's upper `rows` share. */
function meanLum(img: Png, rows: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < Math.floor(img.height * rows); y++) for (let x = 0; x < img.width; x++) {
    sum += lum(img.pixel(x, y));
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/** The mean brightness of the pixels `test` takes, and how many. */
function meanOf(img: Png, test: (p: readonly number[]) => boolean): { lum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const p = img.pixel(x, y);
    if (!test(p)) continue;
    sum += lum(p);
    n++;
  }
  return { lum: n === 0 ? 0 : sum / n, n };
}

/**
 * The live probes over the voxels (the store the cache): a hut built by the script on the pad (plaster walls and roof
 * round a room 4 × 2.5 × 7.5 m, a plaster floor slab), the camera put inside it looking at its far wall, the blue box on
 * its floor. Shut, then its roof opened by an edit (the probes stale where it changed, lit again), then shut again.
 * Pictures once the cache and probes settle; the readings go back for the checks after the store-off picture. The
 * bounce's colour is not checked: the floor dug from plaster to the pad's grass moved the walls' red over green by
 * under 1 either way (the plan's results).
 */
async function probeHutChecks(o: FarLightSetup, settled: (what: string) => Promise<void>, hook: <T>(f: string, arg?: unknown) => Promise<T>): Promise<{ eye: number[]; box: number[]; shut: Png; resolve: ResolveCheck | null; walls: { shut: number; open: number }; openMs: number; probes: unknown }> {
  const { ids, away } = o;
  const { control, counter, rel, place, still } = driver(o);
  const eye = rel(0, 2.2, 9.5);
  const box = rel(1, 0.8, 6);
  await control('hut');
  await expect.poll(() => counter('hutBuilt'), { timeout: 10_000 }).toBe(1);
  await place(o.camera, eye);
  await place(ids.blue, box);
  await settled('the hut shut');
  const shut = await still('probe-hut-shut');
  const probes = (await hook<CacheStats | null>('cache'))?.probes ?? null;
  const t0 = Date.now();
  await control('hutopen');
  await expect.poll(() => counter('hutOpened'), { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await hook<CacheStats | null>('cache'))?.probes?.stale ?? 0, { timeout: 10_000, intervals: [50], message: 'the opened roof makes probes stale' }).toBeGreaterThan(0);
  await settled('the hut opened');
  const openMs = Date.now() - t0;
  const open = await still('probe-hut-open');
  // The probe rays' resolve on the GPU against its CPU twin over the same table: 1,200 rays round the eye in the hut.
  const resolve = await hook<ResolveCheck | null>('resolveCheck', eye);
  await control('hutshut');
  await expect.poll(() => counter('hutShut'), { timeout: 10_000 }).toBe(1);
  await place(ids.blue, away);
  await place(o.camera, o.cameraAt);
  return { eye, box, shut, resolve, walls: { shut: meanLum(shut, WALL_ROWS), open: meanLum(open, WALL_ROWS) }, openMs, probes };
}

/**
 * Pixels the pillar keeps the lamp's light off (wall or grass): red the lamp adds there without the pillar (`openLamp` −
 * `openDark`) of at least `minAdd`, of which the view with the pillar keeps less than `keep`; the pillar's own pixels
 * (where the two dark views differ) left out.
 */
function pillarShadowed(pillarDark: Png, pillarLamp: Png, openDark: Png, openLamp: Png, minAdd: number, keep: number): number {
  let n = 0;
  for (let y = 0; y < openDark.height; y++) for (let x = 0; x < openDark.width; x++) {
    const a = pillarDark.pixel(x, y);
    const b = openDark.pixel(x, y);
    if (Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 30) continue;
    const add = openLamp.pixel(x, y)[0]! - b[0]!;
    const kept = pillarLamp.pixel(x, y)[0]! - a[0]!;
    if (add >= minAdd && kept < keep * add) n += 1;
  }
  return n;
}

/**
 * The pillar edited under the lit lamp: of the pixels it shadows (as `pillarShadowed` finds them from the four
 * pictures taken before the edits), how many `pillarEdit` (built while lit, settled) still shows lit (the red the
 * lamp adds kept at `LAMP_KEEP` of it or more), and how many `openEdit` (dug again, settled) shows lit again (at
 * least 1 − `LAMP_KEEP` of it).
 */
function editRelit(pillarDark: Png, pillarLamp: Png, openDark: Png, openLamp: Png, pillarEdit: Png, openEdit: Png): { shadow: number; stillLit: number; litAgain: number } {
  let shadow = 0;
  let stillLit = 0;
  let litAgain = 0;
  for (let y = 0; y < openDark.height; y++) for (let x = 0; x < openDark.width; x++) {
    const a = pillarDark.pixel(x, y);
    const b = openDark.pixel(x, y);
    if (Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 30) continue;
    const add = openLamp.pixel(x, y)[0]! - b[0]!;
    if (add < LAMP_ADD_MIN || pillarLamp.pixel(x, y)[0]! - a[0]! >= LAMP_KEEP * add) continue;
    shadow += 1;
    if (pillarEdit.pixel(x, y)[0]! - a[0]! >= LAMP_KEEP * add) stillLit += 1;
    if (openEdit.pixel(x, y)[0]! - b[0]! >= (1 - LAMP_KEEP) * add) litAgain += 1;
  }
  return { shadow, stillLit, litAgain };
}

/** Pixels to which `lit` adds at least `min` red over `dark`. */
function redAdded(dark: Png, lit: Png, min: number): number {
  let n = 0;
  for (let y = 0; y < dark.height; y++) for (let x = 0; x < dark.width; x++) if (lit.pixel(x, y)[0]! - dark.pixel(x, y)[0]! >= min) n += 1;
  return n;
}

/**
 * The cache checks' bounds, from the readings of the first green run (high tier, the preview's 670 × 253 picture): the
 * lamp adds red ≥ 30 to 28,835 pixels by the cache (bound 8,000); the pillar keeps it off 554 pixels behind it (bound
 * 250); the cache's picture differs from the store-off one in 1,793 pixels (bound 500: the cache's traced soft shadows
 * and texels for the per-pixel light and atlas shadow); off again, the same picture to 0 pixels (bound 40). The cache
 * lit 29.5 s after the switch (351 chunks charted in the 1 ms slice).
 */
const CACHE_LIT_MIN_PX = 8000;
const CACHE_SHADOW_MIN_PX = 250;
const CACHE_CHANGED_MIN_PX = 500;
const CACHE_SAME_MAX_PX = 40;
/**
 * The pillar edited under the lit lamp (set before its first run, not from a reading): of the pixels it shadows, at
 * most a fifth may stay lit once built and the light settled (an edit's marks relight what it can shadow; a few at
 * the shadow's soft edge may keep some light), and at least seven tenths are lit again once it is dug.
 */
const EDIT_STILL_LIT_SHARE = 0.2;
const EDIT_LIT_AGAIN_SHARE = 0.7;

/**
 * The live probes' bounds, from the readings of the first green run (high tier, the preview's 670 × 253 picture): the
 * shut hut's walls 6.4 by the probes against 118.9 by the flat ambient term (share 0.05; bound 0.5), the blue box in it
 * 5.7 against 19.1 (0.30); the roof opened, its walls 77.4 (12 ×; bound 3). The GPU and CPU resolve find a voxel hit's texel in whole
 * numbers, so they agree exactly (an f32 / f64 place differed by a row at 15 of 1,200 before).
 */
const HUT_DARK_SHARE = 0.5;
const HUT_OPEN_FACTOR = 3;
const RESOLVE_MISMATCH_MAX = 0;

/**
 * The light volume's bounds, set before its first run (not from a reading): a cell in the shut hut holds under a
 * twentieth of the open sky's light on its brightest face (no light reaches it but by the walls' 0.5 m plaster); the
 * up face of a cell over the roof within 0.6–1.3 of the sky's light facing up (rays past 24 m count as the sky, and a
 * hill or the far field may close a little of it); the walls' green over red at least 2 % up over a green floor in the
 * open hut than over plaster.
 */
const VOLUME_DARK_SHARE = 0.05;
const VOLUME_SKY_SHARE: readonly [number, number] = [0.6, 1.3];
const VOLUME_TINT_FACTOR = 1.02;
/**
 * Set before the first run (not from a reading): the box 1.7 m over the open pad keeps at least 0.7 of its brightness by
 * the flat term (the sun is per pixel on both; the volume's sky over it is open but for the ground below); the pillar
 * built between the lamp and the wall leaves at most 0.7 of the lamp's red bounce up the wall's face (it shades the
 * part of the face behind it), dug again at least 0.8 comes back (32 rays a face: noise).
 */
const VOLUME_OPEN_SHARE = 0.7;
const VOLUME_EDIT_SHADED_SHARE = 0.7;
const VOLUME_EDIT_BACK_SHARE = 0.8;
