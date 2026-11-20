/**
 * Voxel shadows read from Play's pixels (voxel-world.e2e.ts's Play test drives them): a script-built wall's sun
 * shadow, a moving box in it, a red lamp's shadow of the wall, a moving box's shadow on the voxel grass. Pixels read
 * with png.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { changedPixels, decodePng } from './png';
import { expect, test, type Page } from './pw';
import { LIGHTING_TIER_SETTINGS } from '@thirdlight/project-model';
import { cellBlotch } from '../../tools/voxel-bench/lighting-cameras';
import { placeholderPng } from '../../tools/voxel-bench/texture-sets';

/** What the checks drive: the editor page with Play running, the play session, the character's stand (metres), the test objects' ids and where they wait, and the project API. */
/** The Play camera's pitch down (radians) and vertical field of view (degrees): the hut's pictures are projected with them. */
export const PLAY_PITCH = (35 * Math.PI) / 180;
export const PLAY_FOV_Y_DEG = 60;
/** Where the camera stands in the hut (from the world's anchor), looking down it along −z. */
const HUT_EYE = [0, 2.2, 9.5] as const;

export interface ShadowCheckSetup {
  readonly page: Page;
  readonly psid: string;
  readonly at: readonly number[];
  readonly ids: { readonly blue: string; readonly mover: string; readonly lamp: string; readonly spot: string; readonly panel: string };
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

/** The light volume's progress and a cell read back (the page's `__tlVoxelPlay.light.progress` / `volumeCells`). */
interface VolumeProgress {
  readonly texelsWritten: number;
  readonly staleUnits: number;
  readonly waiting: number;
  readonly settled: boolean;
}
/** A level-0 brick's lamp list as the page reads it back (the GPU's beside the CPU's rule). */
interface VolumeLampList {
  readonly brick: number[];
  readonly kept: boolean;
  readonly pending: boolean;
  readonly gpu: { listed: number[]; total: number } | null;
  readonly cpu: { listed: number[]; total: number };
  readonly at: number[][];
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

/** Pixels clearly green (green over red and blue by 25 of 255). */
function greenPixels(img: Png): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const p = img.pixel(x, y);
    if (p[1]! > p[0]! + 25 && p[1]! > p[2]! + 25) n++;
  }
  return n;
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
 * picture; the near grid texture replaced under the hut's drawn chunks just before the repaint, which shows). In the
 * shut hut a spot and an area panel bounce, and taken out leave next to nothing of it. Then outside, the hut dug: the box 1.7 m over the pad, in the open, about as bright by the volume as by the
 * flat term (the coarse levels' sky); the script's wall built and a red lamp east of it, the pillar built between them
 * takes the lamp's bounce off the cells up the wall's lit face; the lamp lists of the bricks
 * round the lamp and the wall read back from the GPU (level 0 and 1 m) equal the CPU's rule, and the bricks up the
 * wall's face list the lamp (the bounce is lit through them). Off again, the picture is the store-off one.
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
  // The tier's store (the Play test runs at high): the volume where the tier has it on; the store-off pictures are
  // taken by switching it off, as a bench compares the stores on one page.
  await expect.poll(() => hook<string>('store'), { timeout: 10_000, message: "the tier's lighting store" }).toBe(LIGHTING_TIER_SETTINGS.high.voxelLightVolume.enabled ? 'volume' : 'off');
  await hook('setStore', 'off');
  await expect.poll(() => hook('volume'), { timeout: 10_000 }).toBeNull();
  await place(ids.lamp, away);
  const offBefore = await still('volume-off-before');
  const eye = rel(...HUT_EYE);
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
  // In the shut hut: a red spot mid-room aimed at its east wall, and a blue panel under the ceiling at its south end.
  const typed = await lightTypeChecks(o, hook, settled, staleSoon);
  // Still shut, both taken out: a glowing strip painted on the south wall, then painted back.
  const glow = await glowChecks(o, hook, settled, staleSoon, counted, still, shut);
  const t0 = Date.now();
  await counted('unstone', 'stubDug');
  await counted('hutopen', 'hutOpened');
  await staleSoon('the opened roof');
  await settled('the hut opened');
  const openMs = Date.now() - t0;
  const refine = await refiningCheck(o, hook);
  const open = await still('volume-hut-open');
  // The near grid texture replaced under draws made before it (the hut's chunks are drawn; the old texture is
  // disposed two frames on), then the floor repainted green under the open roof: the floor shows green, so those draws
  // read the new texture; and the walls' bounce takes its colour (against the open picture's plaster floor).
  const grown = await o.page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first().evaluate(() => (window as unknown as { __tlVoxelPlay: { growGrids(): Record<string, number> } }).__tlVoxelPlay.growGrids());
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
  const faceCells = async (): Promise<VolumeCell[]> => (await hook<VolumeCell[] | null>('volumeCells', facePts)) ?? [];
  const litCells = await faceCells();
  const lit = lampBounce(litCells);
  // The lamp lists of the bricks round the lamp and up the wall's face (a brick every 2 m), read back from the GPU.
  const lampAt = rel(-0.75, 1.25, -1.5);
  const brickPts: number[][] = [...facePts];
  for (let x = -6; x <= 4; x += 2) for (let y = -0.5; y <= 4; y += 2) for (let z = -7; z <= 4; z += 2) brickPts.push(rel(x + 0.25, y + 0.25, z + 0.25));
  const lists = (await hook<VolumeLampList[] | null>('volumeLamps', brickPts)) ?? [];
  const listsKept = lists.filter((l) => l.kept && !l.pending);
  const listsLit = listsKept.filter((l) => (l.gpu?.listed.length ?? 0) > 0);
  const listsDiffer = listsKept.filter((l) => JSON.stringify(l.gpu) !== JSON.stringify(l.cpu));
  const listsLamp = (l: VolumeLampList): boolean => l.at.some((p) => Math.hypot(p[0]! - lampAt[0]!, p[1]! - lampAt[1]!, p[2]! - lampAt[2]!) < 0.05);
  const faceBricks = new Set(facePts.map((p) => p.map((v) => Math.floor(v / 2)).join(',')));
  const faceLists = listsKept.filter((l) => faceBricks.has(l.brick.join(',')));
  // The 1 m level's bricks there too (a hit past the level-0 window is lit by the finest coarse brick's list).
  const listsCoarse = ((await hook<VolumeLampList[] | null>('volumeLamps', { points: brickPts, level: 1 })) ?? []).filter((l) => l.kept && !l.pending);
  const listsCoarseDiffer = listsCoarse.filter((l) => JSON.stringify(l.gpu) !== JSON.stringify(l.cpu));
  const tBuild = Date.now();
  await counted('pillar', 'pillarBuilt');
  await staleSoon('the pillar built');
  await settled('the pillar built between the lamp and the wall');
  const builtMs = Date.now() - tBuild;
  const shadedCells = await faceCells();
  const shaded = lampBounce(shadedCells);
  const tDig = Date.now();
  await counted('unpillar', 'pillarDug');
  await staleSoon('the pillar dug');
  await settled('the pillar dug');
  const dugMs = Date.now() - tDig;
  const relitCells = await faceCells();
  const relit = lampBounce(relitCells);
  // Dug again, the face's cells hold what they held before the pillar was built (nothing left of its shadow).
  const pillarResidue = cellsApart(relitCells, litCells) / Math.max(cellsApart(shadedCells, litCells), 1e-6);
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
  const floorGreen = greenPixels(green) - greenPixels(plain);
  // The box and the kit pieces where the store-off pictures show them, read there in the volume's.
  const boxMask = maskOf(hutOff, blueBox);
  const kitMask = maskOf(hutOff, magenta);
  const boxIn = { off: meanOver(hutOff, boxMask), volume: meanOver(shut, boxMask) };
  const kit = { off: meanOver(hutOff, kitMask), volume: meanOver(shut, kitMask) };
  const outMask = maskOf(outOff, blueBox);
  const boxOpen = { off: meanOver(outOff, outMask), volume: meanOver(outVolume, outMask) };
  const chunkOf = (p: readonly number[]): string => p.map((v) => Math.floor(v / 16)).join(',');
  const across = chunkOf(rel(-1.75, 1, -1.5)) !== chunkOf(rel(-2.25, 1, -1.5));
  console.log(`[voxel-play] light volume: settled ${litMs} ms after the switch (${JSON.stringify(stats).slice(0, 900)}); hut walls off ${walls.off.toFixed(1)}, shut ${walls.shut.toFixed(1)}, open ${walls.open.toFixed(1)} (roof opened → settled ${openMs} ms); grids grown to ${JSON.stringify(grown)} regions before the floor's repaint, green floor px ${floorGreen}; walls' green/red over the green floor ${tint.green.ratio.toFixed(4)} against ${tint.plain.ratio.toFixed(4)} over plaster (${tint.green.n} px); cells round the hut ${cells.length}, updated ${updated.length}, holding light on the GPU ${holdsGpu}, differing from the CPU's rule ${differ.length}; 1 m cells updated ${coarseUpdated.length}, holding ${coarseHolds}, differing ${coarseDiffer.length}; inside the shut hut ${JSON.stringify(inside?.faces)}, its 1 m cell mid-room ${JSON.stringify(midRoom?.faces)}; over its roof ${JSON.stringify(roof?.faces)} against the sky's ${JSON.stringify(sky)}; off before and after ${same} px apart`);
  console.log(`[voxel-play] light volume readers: the blue box in the shut hut ${boxIn.volume.lum.toFixed(1)} against ${boxIn.off.lum.toFixed(1)} by the flat term (${boxIn.off.n} px); the kit pieces on the stub ${kit.volume.lum.toFixed(1)} against ${kit.off.lum.toFixed(1)} (${kit.off.n} px); the box 1.7 m over the pad ${boxOpen.volume.lum.toFixed(1)} against ${boxOpen.off.lum.toFixed(1)} (${boxOpen.off.n} px)`);
  console.log(`[voxel-play] light volume lamp lists: ${lists.length} bricks round the lamp, ${listsKept.length} kept, ${listsLit.length} listing a lamp, ${listsDiffer.length} differing from the CPU's rule (${JSON.stringify(listsDiffer.slice(0, 2))}); up the wall's face ${faceLists.length} bricks, ${faceLists.filter(listsLamp).length} listing the red lamp (${JSON.stringify(lampAt)}); 1 m level ${listsCoarse.length} kept, ${listsCoarse.filter(listsLamp).length} listing it, ${listsCoarseDiffer.length} differing (${JSON.stringify(listsCoarseDiffer.slice(0, 2))}; the first lists ${JSON.stringify(faceLists[0]?.at)}); most reaching one ${Math.max(0, ...lists.map((l) => l.cpu.total))}`);
  console.log(`[voxel-play] light volume light types: the spot's red bounce on the west wall's cells: faces looking at the wall it lights ${typed.front.toFixed(3)} (${typed.frontN} faces), at the wall behind it ${typed.behind.toFixed(3)} (ratio ${typed.ratio.toFixed(3)}; settled ${typed.litMs} ms); the panel's blue bounce on the faces looking down at the floor it lights ${typed.panel.toFixed(3)} (${typed.panelN} faces; before it was placed ${typed.panelBefore.toFixed(3)}), with both taken out ${typed.panelOff.toFixed(3)} (settled ${typed.offMs} ms), the spot's then ${typed.frontOff.toFixed(3)} (before it came ${typed.frontBefore.toFixed(3)}); the cells then against before the lights came ${(typed.residue * 100).toFixed(2)} % of what the lights moved them`);
  console.log(`[voxel-play] light volume glow mask: the volume's values (green) plain ${(glow.values[String(GLOW_MAT)]?.[1] ?? 0).toFixed(5)}, masked ${(glow.values[String(GLOW_MASKED_MAT)]?.[1] ?? 0).toFixed(5)} (ratio ${((glow.values[String(GLOW_MASKED_MAT)]?.[1] ?? 0) / Math.max(glow.values[String(GLOW_MAT)]?.[1] ?? 0, 1e-9)).toFixed(4)} against the mask's mean ${GLOW_MASK_SHARE}); glowing px a column over the plain part ${glow.pxPlain.toFixed(1)}, over the masked part ${glow.pxMasked.toFixed(1)} (ratio ${(glow.pxMasked / Math.max(glow.pxPlain, 1)).toFixed(3)}); the cells at their foot, green looking up: plain ${glow.nearPlain.toFixed(4)}, masked ${glow.nearMasked.toFixed(4)} (ratio ${(glow.nearMasked / Math.max(glow.nearPlain, 1e-9)).toFixed(3)}); the far wall's green ${glow.north[1]!.toFixed(4)} (a whole strip of the plain one read 0.40)`);
  console.log(`[voxel-play] light volume glow: the strip's pixels ${glow.px} px greener than the shut hut's, their green ${glow.green.toFixed(1)} against the material's grey 128; the cells along the north wall facing it: rgb ${glow.north.map((v) => v.toFixed(4)).join(', ')} (before ${glow.northBefore.map((v) => v.toFixed(4)).join(', ')}); at its foot looking up ${glow.foot.map((v) => v.toFixed(4)).join(', ')}: red over green ${glow.rg.toFixed(4)} against the glow's ${GLOW_RG.toFixed(4)}, green over blue ${glow.gb.toFixed(3)} against its ${(1 / 0.2158605001138992).toFixed(3)}; settled ${glow.litMs} ms after the paint, ${glow.offMs} ms after it was painted back; the far wall's green then against before ${(glow.residue * 100).toFixed(2)} % of what the glow moved it`);
  console.log(`[voxel-play] light volume edit: the lamp's red bounce up the wall's face ${lit.red.toFixed(3)} (${lit.n} cells), the pillar built ${shaded.red.toFixed(3)} (settled ${builtMs} ms after the command), dug ${relit.red.toFixed(3)} (${dugMs} ms), its cells against before it was built ${(pillarResidue * 100).toFixed(2)} % of what the pillar moved them; the pillar and the face's cells ${across ? 'in two chunks' : 'in one chunk'}`);
  console.log(`[voxel-play] light volume refining: the open hut's cells' neighbour difference at its settle ${refine.settled.mean.toFixed(4)} (${refine.settled.pairs} pairs, bricks at ${refine.settledUpdates} updates), refined ${refine.refined.mean.toFixed(4)} (${refine.refined.pairs} pairs, bricks at ${refine.refinedUpdates} updates, ${refine.ms} ms later): ratio ${(refine.refined.mean / Math.max(refine.settled.mean, 1e-9)).toFixed(3)}`);
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
  expect(Object.keys(grown).length, 'the near grids were grown').toBeGreaterThan(0);
  expect(floorGreen, 'repainted after the grid texture was replaced, the floor shows green').toBeGreaterThan(GRID_FLOOR_GREEN_MIN_PX);
  expect(tint.green.n, 'the walls are in view').toBeGreaterThan(5000);
  expect(tint.green.ratio, "the walls take the green floor's bounce").toBeGreaterThan(VOLUME_TINT_FACTOR * tint.plain.ratio);
  expect(listsKept.length, 'bricks round the lamp are kept with their lists built').toBeGreaterThan(20);
  expect(listsLit.length, 'bricks round the lamp list a lamp').toBeGreaterThan(10);
  expect(listsDiffer.length, "the GPU's lamp lists equal the CPU's rule").toBe(0);
  expect(faceLists.length, "the wall face's bricks are kept").toBeGreaterThan(0);
  expect(listsCoarse.filter(listsLamp).length, "the 1 m level's bricks round the lamp list it").toBeGreaterThan(0);
  expect(listsCoarseDiffer.length, "the GPU's 1 m lamp lists equal the CPU's rule").toBe(0);
  expect(faceLists.every(listsLamp), "the wall face's bricks list the red lamp").toBe(true);
  expect(lit.n, 'cells up the wall hold light').toBeGreaterThan(10);
  expect(lit.red, "the lamp's bounce reaches the wall's face").toBeGreaterThan(VOLUME_LAMP_BOUNCE_MIN);
  expect(shaded.red, "the pillar built between them takes the lamp's bounce off").toBeLessThan(VOLUME_EDIT_SHADED_SHARE * lit.red);
  expect(relit.red, 'dug again, the bounce comes back').toBeGreaterThan(VOLUME_EDIT_BACK_SHARE * lit.red);
  expect(pillarResidue, 'dug again, the cells hold what they held before the pillar was built').toBeLessThan(VOLUME_RESIDUE_SHARE);
  expect(refine.settled.pairs, 'the open hut holds cells side by side').toBeGreaterThan(200);
  expect(refine.refinedUpdates, 'refined while nothing changes').toBeGreaterThanOrEqual(VOLUME_REFINED_UPDATES);
  expect(refine.refined.mean, 'refined, the cells beside each other differ less than at their first settle').toBeLessThan(VOLUME_REFINED_SHARE * refine.settled.mean);
  expect(same, 'switched off, the picture is the store-off one').toBeLessThan(OFF_SAME_MAX_PX);
  expect(typed.frontN, "faces looking at the spot's wall hold light").toBeGreaterThan(5);
  expect(typed.front, "the spot's bounce off the wall it lights").toBeGreaterThan(VOLUME_SPOT_BOUNCE_MIN);
  expect(typed.ratio, 'the wall behind the spot, outside its cone, bounces far less than the wall it lights').toBeLessThan(VOLUME_SPOT_BEHIND_SHARE);
  expect(typed.panelN, "faces looking at the panel's floor hold light").toBeGreaterThan(5);
  expect(typed.panel, "the area light's bounce off the floor it lights").toBeGreaterThan(VOLUME_PANEL_BOUNCE_MIN);
  expect(typed.panelBefore, 'before the area light is placed, no blue bounce on the floor').toBeLessThan(VOLUME_PANEL_OFF_SHARE * typed.panel);
  expect(typed.panelOff, "the area light taken out, its bounce is gone once the bricks settle again").toBeLessThan(VOLUME_GONE_SHARE * typed.panel);
  expect(typed.frontOff - typed.frontBefore, "the spot taken out, its bounce is gone once the bricks settle again").toBeLessThan(VOLUME_GONE_SHARE * typed.front);
  expect(typed.residue, 'the lights taken out, the cells are back near what they held before the lights came').toBeLessThan(VOLUME_RESIDUE_SHARE);
  expect(glow.px, 'the glowing strip draws brighter in the shut hut').toBeGreaterThan(GLOW_MIN_PX);
  // The masked half: the volume's one value is the plain one's × the mask's mean (the same grey drawn under it); it
  // draws glowing only over its mask's share, and the cells before it hold about that share of the plain half's light.
  const plainValue = glow.values[String(GLOW_MAT)]?.[1] ?? 0;
  const maskedValue = glow.values[String(GLOW_MASKED_MAT)]?.[1] ?? 0;
  expect(plainValue, 'the plain glow has its value in the volume').toBeGreaterThan(0);
  expect(Math.abs(maskedValue / plainValue - GLOW_MASK_SHARE), "the masked glow's value is the plain one's × the mask's mean").toBeLessThan(GLOW_MASK_VALUE_TOLERANCE);
  expect(glow.pxPlain, "the strip's plain part draws its glow over its height").toBeGreaterThan(GLOW_MIN_COLUMN_PX);
  expect(Math.abs(glow.pxMasked / glow.pxPlain - GLOW_MASK_SHARE), "the masked part glows over its mask's share of the plain part's height").toBeLessThan(GLOW_MASK_PX_TOLERANCE);
  expect(glow.nearMasked / glow.nearPlain, "the cells before the masked half hold less of the glow than before the plain half").toBeLessThan(GLOW_MASK_NEAR_RANGE[1]);
  expect(glow.nearMasked / glow.nearPlain, "the cells before the masked half hold about the mask's share of the plain half's glow").toBeGreaterThan(GLOW_MASK_NEAR_RANGE[0]);
  expect(glow.green, "the strip's pixels are brighter than its grey alone").toBeGreaterThan(GLOW_ALBEDO_GREEN);
  expect(glow.north[1], "the far wall's cells hold the strip's glow").toBeGreaterThan(GLOW_LIT_FACTOR * Math.max(glow.northBefore[1]!, 1e-4));
  // Red over green (the panel's fading blue lies under the strip: its blue is not the glow's alone).
  expect(glow.rg, "the cells at the strip's foot hold the glow's colour (red over green)").toBeGreaterThan(GLOW_RG / 2);
  expect(glow.rg, "the cells at the strip's foot hold the glow's colour (red over green)").toBeLessThan(GLOW_RG * 2);
  expect(glow.residue, "the strip painted back, the far wall's cells are back near what they held before").toBeLessThan(VOLUME_RESIDUE_SHARE);
}

/**
 * The glowing test material with a glow mask (a voxel id the world does not use): the same glow as the plain one on a
 * texture set of a flat grey albedo (128, under a white tint: the plain one's #808080 drawn) and an ORM whose A is
 * the mask, 1 over the lower {@link GLOW_MASK_SHARE} of each 0.5 m tile and 0 above it, so on the strip (one tile high)
 * a band along its foot glows. Painted on the strip's last 0.75 m at +x, beside the plain material.
 */
export const GLOW_MASKED_MAT = 41;
export const GLOW_MASK_SHARE = 0.4;
const GLOW_MASK_SIDE = 256;
const GLOW_MASK_FOLDER = 'assets/glow-mask';

/** The masked material's two maps written into the project's `assets/glow-mask` folder (imported by the caller), and its record from their asset ids. */
export function glowMaskFiles(projectDir: string): { folder: string; files: { albedo: string; orm: string }; material: (ids: { albedo: string; orm: string }) => Record<string, unknown> } {
  const n = GLOW_MASK_SIDE;
  const albedo = new Uint8Array(n * n * 4).map((_, i) => (i % 4 === 3 ? 255 : 128));
  // Row 0 is the image's top: the mask's rows from the foot up.
  const orm = new Uint8Array(n * n * 4).map((_, i) => [255, 204, 0][i % 4] ?? (1 - (Math.floor(i / 4 / n) + 0.5) / n < GLOW_MASK_SHARE ? 255 : 0));
  const dir = join(projectDir, ...GLOW_MASK_FOLDER.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'glow-albedo.png'), placeholderPng(albedo, n));
  writeFileSync(join(dir, 'glow-orm.png'), placeholderPng(orm, n));
  return {
    folder: GLOW_MASK_FOLDER,
    files: { albedo: `${GLOW_MASK_FOLDER}/glow-albedo.png`, orm: `${GLOW_MASK_FOLDER}/glow-orm.png` },
    material: (ids) => ({ materialId: 'mat-glow-masked-voxel', name: 'Glow, masked (voxel)', shader: 'standard', params: { color: '#ffffff', emissive: '#20ff80', emissiveIntensity: 4 }, textures: {}, voxel: { id: GLOW_MASKED_MAT, use: 'construction', tileMetres: 0.5, surfaces: { wall: { albedo: ids.albedo, orm: ids.orm } } } }),
  };
}

/**
 * The glowing test material's colour (#20ff80 in linear light): red over green. Set before the first run (not from a
 * reading): its strip draws at least 200 px greener than the shut hut, their green over its grey's 128 (the albedo
 * alone, with no light in the hut); the far wall's cells' green at least ten times what it was before the paint.
 */
const GLOW_RG = 0.014443843;
const GLOW_MIN_PX = 200;
const GLOW_ALBEDO_GREEN = 128;
const GLOW_LIT_FACTOR = 10;
/** The plain glowing material's voxel id (voxel-world.e2e.ts's `GLOW_MATERIAL`, on the strip's −x half). */
export const GLOW_MAT = 40;
/** The masked value's ratio to the plain one against the mask's mean: the means' pass reads the GPU's ORM array (BC7 keeps a 0/255 mask exactly). */
const GLOW_MASK_VALUE_TOLERANCE = 0.02;
/**
 * The masked part's glowing pixels a column over the plain part's against the mask's share: the strip lies at the
 * picture's top edge, a column of it 27 px high, the mask's 0.4 drawn 9 px (a hand run before the check: 0.33).
 */
const GLOW_MASK_PX_TOLERANCE = 0.15;
/** The plain part's columns glow over more than this many pixels (27 in a hand run). */
const GLOW_MIN_COLUMN_PX = 12;
/**
 * The cell at the masked part's foot over the one at the plain part's (each sees both parts, the plain one 0.5 m off
 * the first): a hand run before the check read 0.57; without the mask both glow whole (1).
 */
const GLOW_MASK_NEAR_RANGE = [0.35, 0.8] as const;

/**
 * A glowing strip in the shut hut, the spot and the panel just taken out (the test material, 3 × 0.5 m along the south
 * wall at 1 m): its pixels against the shut hut's picture (the same camera, no lamp in it), and read back from the GPU
 * the cells along the north wall 7 m off (their faces looking south at it) and those on the floor at its foot (their
 * faces looking up). The spot (red) and the panel (blue) leave a little of their light, still fading: the far wall's
 * glow and what is left after it is painted back are read in green (which neither has), the glow's colour where it is
 * strongest (at its foot). Painted back to plaster and settled again, the far wall's green against before.
 */
async function glowChecks(
  o: FarLightSetup,
  hook: <T>(f: string, arg?: unknown) => Promise<T>,
  settled: (what: string) => Promise<number>,
  staleSoon: (what: string) => Promise<void>,
  counted: (cmd: string, name: string) => Promise<void>,
  still: (name: string) => Promise<Png>,
  shut: Png,
): Promise<{ px: number; green: number; north: number[]; northBefore: number[]; foot: number[]; gb: number; rg: number; litMs: number; offMs: number; residue: number; pxPlain: number; pxMasked: number; nearPlain: number; nearMasked: number; values: Record<string, number[] | null> }> {
  const { rel } = driver(o);
  // The cells at the strip's foot (on the floor against the wall: the volume keeps cells beside a surface) under the
  // plain part (x 0 … 0.5) and under the masked part (x 1 … 1.5): their up faces look at it.
  const nearPts = [rel(0.25, 0.75, 2.75), rel(1.25, 0.75, 2.75)];
  const northPts: number[][] = [];
  for (let x = -1.5; x < 1.5; x += 0.5) for (let y = 0.5; y < 2.5; y += 0.5) northPts.push(rel(x + 0.25, y + 0.25, 9.75));
  const footPts: number[][] = [];
  for (let x = -1.5; x < 1.5; x += 0.5) footPts.push(rel(x + 0.25, 0.75, 2.75));
  const read = async (): Promise<VolumeCell[]> => (await hook<VolumeCell[] | null>('volumeCells', [...northPts, ...footPts])) ?? [];
  // A face's light (`face` 0 … 5) summed over the cells holding light.
  const faceSum = (cells: readonly VolumeCell[], face: number): number[] => {
    const sum = [0, 0, 0];
    for (const c of cells) for (let k = 0; k < 3; k++) sum[k]! += c.faces[face]?.[k] ?? 0;
    return sum;
  };
  const before = await read();
  await counted('hutglow', 'hutGlow');
  await staleSoon('the glowing strip');
  const litMs = await settled('the glowing strip');
  const lit = await read();
  const near = (await hook<VolumeCell[] | null>('volumeCells', nearPts)) ?? [];
  // Each glowing material's one value the volume uses (glow × the mean of what it draws: the masked one's mask mean).
  const values = ((await hook<{ glowValues?: Record<string, number[] | null> } | null>('volume'))?.glowValues ?? {}) as Record<string, number[] | null>;
  const pic = await still('volume-hut-glow');
  await counted('hutunglow', 'hutUnglow');
  await staleSoon('the strip painted back');
  const offMs = await settled('the strip painted back');
  const after = await read();
  let px = 0;
  let green = 0;
  // Glowing pixels a column: the plain part's (x 0.15 … 0.6) glow over the strip's height, the masked part's (x 0.9 …
  // 1.35) over its mask's share of it; the columns from the hut camera's projection of the strip's face.
  const columns = new Array<number>(pic.width).fill(0);
  for (let y = 0; y < pic.height; y++) for (let x = 0; x < pic.width; x++) {
    const p = pic.pixel(x, y);
    const q = shut.pixel(x, y);
    if (p[1]! - q[1]! > 40 && p[1]! > p[0]! + 40) {
      px++;
      green += p[1]!;
      columns[x]!++;
    }
  }
  const f = pic.height / 2 / Math.tan((PLAY_FOV_Y_DEG * Math.PI) / 360);
  const columnOf = (x: number): number => {
    // The strip's face (z 2.5, y 1.25) in the camera's frame: pitched down by PLAY_PITCH about x.
    const dy = 1.25 - HUT_EYE[1];
    const dz = 2.5 - HUT_EYE[2];
    const depth = -(dy * Math.sin(PLAY_PITCH) + dz * Math.cos(PLAY_PITCH));
    return Math.round(pic.width / 2 + (f * (x - HUT_EYE[0])) / depth);
  };
  const span = (a: number, b: number): number[] => columns.slice(columnOf(a), columnOf(b) + 1);
  const plainCols = span(0.15, 0.6);
  const maskedCols = span(0.9, 1.35);
  const nearGreen = (cells: readonly VolumeCell[]): number => cells.reduce((n, c) => n + (c.faces[2]?.[1] ?? 0), 0);
  const n = northPts.length;
  // Faces looking south (−z: 5) on the far wall; looking up (+y: 2) at the strip's foot.
  const north = faceSum(lit.slice(0, n), 5);
  const northBefore = faceSum(before.slice(0, n), 5);
  const foot = faceSum(lit.slice(n), 2);
  const northAfter = faceSum(after.slice(0, n), 5);
  return {
    px,
    green: px === 0 ? 0 : green / px,
    north,
    northBefore,
    foot,
    gb: foot[1]! / Math.max(foot[2]!, 1e-9),
    rg: foot[0]! / Math.max(foot[1]!, 1e-9),
    litMs,
    offMs,
    residue: Math.abs(northAfter[1]! - northBefore[1]!) / Math.max(north[1]! - northBefore[1]!, 1e-6),
    pxPlain: plainCols.length === 0 ? 0 : plainCols.reduce((a, b) => a + b, 0) / plainCols.length,
    pxMasked: maskedCols.length === 0 ? 0 : maskedCols.reduce((a, b) => a + b, 0) / maskedCols.length,
    nearPlain: nearGreen(near.slice(0, 1)),
    nearMasked: nearGreen(near.slice(1)),
    values,
  };
}

/**
 * The refining while nothing changes, in the open hut just settled: the hut's cells in view (every 0.5 m inside its walls) read
 * back, their same-face neighbours' brightness apart (`cellBlotch`), then again once every brick there holding light
 * has had {@link VOLUME_REFINED_UPDATES} updates (polled; the update refines the bricks round the eye first).
 */
async function refiningCheck(o: FarLightSetup, hook: <T>(f: string, arg?: unknown) => Promise<T>): Promise<{ settled: { mean: number; pairs: number }; refined: { mean: number; pairs: number }; settledUpdates: number; refinedUpdates: number; ms: number }> {
  const { rel } = driver(o);
  const pts: number[][] = [];
  // In front of the camera (it stands at z 9.5 looking down the hut): the refining takes what is in view first.
  for (let x = -2; x < 2; x += 0.5) for (let y = 0.5; y < 3; y += 0.5) for (let z = 2.5; z < 8.5; z += 0.5) pts.push(rel(x + 0.25, y + 0.25, z + 0.25));
  const read = async (): Promise<VolumeCell[]> => ((await hook<VolumeCell[] | null>('volumeCells', pts)) ?? []).filter((c) => c.faces.some((f) => f !== null));
  const least = (cells: readonly VolumeCell[]): number => Math.min(...cells.map((c) => c.updates));
  const first = await read();
  const t0 = Date.now();
  let last = first;
  await expect.poll(async () => {
    last = await read();
    return last.length > 0 ? least(last) : 0;
  }, { timeout: 60_000, intervals: [500], message: 'the open hut is refined' }).toBeGreaterThanOrEqual(VOLUME_REFINED_UPDATES);
  return { settled: cellBlotch(first), refined: cellBlotch(last), settledUpdates: least(first), refinedUpdates: least(last), ms: Date.now() - t0 };
}

/** The colour of one face's light over another channel's, summed over the cells holding light (`face` 0 … 5, `ch` 0 … 2). */
function faceExcess(cells: readonly VolumeCell[], face: number, ch: number, other: number): { sum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const c of cells) {
    const f = c.faces[face];
    if (f === null || f === undefined) continue;
    n++;
    sum += Math.max(0, f[ch]! - f[other]!);
  }
  return { sum, n };
}

/**
 * The light types the volume bounces besides points, in the shut hut (no sky inside to speak of): a red spot mid-room
 * aimed at the east wall 2 m off (20°, a soft edge of 0.2), and a blue rect panel 1 × 0.5 m under the ceiling at the
 * south end shining down. The cells along the west wall (behind the spot): their +x faces look at the lit east wall and
 * hold its red bounce; their −x faces look at the west wall beside them, outside the cone, which a lamp lit as a point
 * lights directly from 2.3 m (brighter than the far wall's bounce); with the cone, only light bounced twice reaches it.
 * The panel's blue bounce on the down faces of the cells over the floor under it, none before it is placed. Both taken
 * out and settled again (what is left is logged).
 */
async function lightTypeChecks(
  o: FarLightSetup,
  hook: <T>(f: string, arg?: unknown) => Promise<T>,
  settled: (what: string) => Promise<number>,
  staleSoon: (what: string) => Promise<void>,
): Promise<{ front: number; frontN: number; behind: number; ratio: number; panel: number; panelN: number; panelBefore: number; panelOff: number; frontOff: number; frontBefore: number; litMs: number; offMs: number; residue: number }> {
  const { ids, away } = o;
  const { rel, place } = driver(o);
  // The open cells along the west wall (the hut's dug box lands a cell west of its metres here: cells by both walls hold light).
  const westPts: number[][] = [];
  for (let y = 1; y < 2.5; y += 0.5) for (let z = 7.5; z < 9; z += 0.5) westPts.push(rel(-2.25, y + 0.25, z + 0.25));
  const floorPts: number[][] = [];
  for (let x = -1; x < 1; x += 0.5) for (let z = 3; z < 5; z += 0.5) floorPts.push(rel(x + 0.25, 0.75, z + 0.25));
  const read = async (pts: number[][]): Promise<VolumeCell[]> => (await hook<VolumeCell[] | null>('volumeCells', pts)) ?? [];
  const before = [...(await read(floorPts)), ...(await read(westPts))];
  const panelBefore = faceExcess(before.slice(0, floorPts.length), 3, 2, 1);
  // The plaster's own red over green along the west wall before the spot came (what the spot's check stands on).
  const frontBefore = faceExcess(before.slice(floorPts.length), 0, 0, 1);
  await place(ids.spot, rel(0, 1.75, 8.25));
  await place(ids.panel, rel(0, 2.9, 4));
  await staleSoon('the spot and the panel');
  const litMs = await settled('the spot and the panel in the shut hut');
  // +x faces (0) look east at the lit wall; −x faces (1) at the west wall behind the spot; down faces (3) at the floor.
  const west = await read(westPts);
  const front = faceExcess(west, 0, 0, 1);
  const behind = faceExcess(west, 1, 0, 1);
  const lit = [...(await read(floorPts)), ...(await read(westPts))];
  const panel = faceExcess(lit.slice(0, floorPts.length), 3, 2, 1);
  await place(ids.spot, away);
  await place(ids.panel, away);
  await staleSoon('the spot and the panel taken out');
  const offMs = await settled('the spot and the panel taken out');
  const after = [...(await read(floorPts)), ...(await read(westPts))];
  const panelOff = faceExcess(after.slice(0, floorPts.length), 3, 2, 1);
  const frontOff = faceExcess(after.slice(floorPts.length), 0, 0, 1);
  // Before the lights came the volume had settled from nothing in the same hut: what is left of their light is how far
  // the cells after they went lie from those, against how far their light moved them.
  return { front: front.sum, frontN: front.n, behind: behind.sum, ratio: behind.sum / Math.max(front.sum, 1e-6), panel: panel.sum, panelN: panel.n, panelBefore: panelBefore.sum, panelOff: panelOff.sum, frontOff: frontOff.sum, frontBefore: frontBefore.sum, litMs, offMs, residue: cellsApart(after, before) / Math.max(cellsApart(lit, before), 1e-6) };
}

/** The sum over two reads of the same cells of how far each face's light (every channel) lies apart. */
function cellsApart(a: readonly VolumeCell[], b: readonly VolumeCell[]): number {
  let sum = 0;
  a.forEach((c, i) => {
    for (let f = 0; f < 6; f++) for (let k = 0; k < 3; k++) sum += Math.abs((c.faces[f]?.[k] ?? 0) - (b[i]?.faces[f]?.[k] ?? 0));
  });
  return sum;
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

/**
 * The hut's bounds, set from the first green run of the live probes over voxels (high tier, the preview's 670 × 253
 * picture): the shut hut's walls 6.4 against 118.9 by the flat ambient term (share 0.05; bound 0.5), the blue box in
 * it 5.7 against 19.1 (0.30); the roof opened, its walls 77.4 (12 ×; bound 3). Store off before and after: the same
 * picture to 0 pixels (bound 40).
 */
const HUT_DARK_SHARE = 0.5;
const HUT_OPEN_FACTOR = 3;
const OFF_SAME_MAX_PX = 40;

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
 * part of the face behind it).
 */
const VOLUME_OPEN_SHARE = 0.7;
const VOLUME_EDIT_SHADED_SHARE = 0.7;
/** Dug again, at least this share of the lamp's bounce up the wall's face comes back (32 rays a face: noise). */
const VOLUME_EDIT_BACK_SHARE = 0.8;
/**
 * The open hut's cells refined while nothing changes: their bricks past this many updates (four times the first settle's
 * rays), their same-face neighbours' brightness apart by at most this share of what it was at their first settle
 * (set before the first run; the bench's room cells went 0.66 → 0.35 refined to 24–33).
 */
const VOLUME_REFINED_UPDATES = 32;
const VOLUME_REFINED_SHARE = 0.85;
/**
 * The lamp's red bounce summed over the wall face's cells (`bounce()`): 1,461–1,921 in every gate that logged it;
 * a third of the least, so a bounce that barely reaches the wall fails where "above 0" would pass.
 */
const VOLUME_LAMP_BOUNCE_MIN = 480;
/**
 * The spot's red bounce on the west wall's cells, faces looking at the wall it lights: 4.86 in the first run, bound a
 * third of it; the faces looking at the wall behind it hold 0.09 of that (bound a third; lit as a point it lights that
 * wall directly and the share is well over 1). The panel's blue bounce on the floor's faces: 109 in the first run,
 * bound a third; before it was placed 0 (bound a tenth of it lit).
 */
const VOLUME_SPOT_BOUNCE_MIN = 1.6;
const VOLUME_SPOT_BEHIND_SHARE = 0.33;
const VOLUME_PANEL_BOUNCE_MIN = 36;
const VOLUME_PANEL_OFF_SHARE = 0.1;
/** Green pixels the repainted floor adds to the hut's inside picture, at least (a floor drawn from the old grid shows none). */
const GRID_FLOOR_GREEN_MIN_PX = 500;
/**
 * What may be left of a light taken out of the volume, as a share of what it gave, once the bricks settle again: the
 * panel 2.9–3.0 %, the spot 7.8 % in two gate runs (keeping half the history left 53–55 %). What is left is not history
 * but the restarted cells' first update reading their neighbours' light before those restarted too (an eighth of the
 * mean).
 */
const VOLUME_GONE_SHARE = 0.12;
/**
 * How far the cells round the lights may lie from before the lights came, as a share of how far the lights moved them:
 * 9.3 % in the first gate run (a volume started from nothing reads its neighbours' light as they fill, so the two
 * settles differ by their bounces' order; keeping half the history leaves about half).
 */
const VOLUME_RESIDUE_SHARE = 0.2;

/** The room checks' setup: the far checks' own and two cameras over the hut, one cutting rooms away, one plain. */
export interface RoomCheckSetup extends FarLightSetup {
  readonly roofCameras: { readonly cut: string; readonly plain: string };
}

/** The middle of a picture (the share `f` of its width and height round its centre). */
function middle(img: Png, f: number): (x: number, y: number) => boolean {
  const x0 = img.width * (0.5 - f / 2);
  const x1 = img.width * (0.5 + f / 2);
  const y0 = img.height * (0.5 - f / 2);
  const y1 = img.height * (0.5 + f / 2);
  return (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
}

/** Pixels where `mask` holds and `test` does, and their mean brightness. */
function countOver(img: Png, mask: (x: number, y: number) => boolean, test: (p: readonly number[]) => boolean): { n: number; lum: number } {
  let n = 0;
  let s = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!mask(x, y)) continue;
    const p = img.pixel(x, y);
    if (!test(p)) continue;
    n++;
    s += lum(p);
  }
  return { n, lum: n === 0 ? 0 : s / n };
}

/**
 * Rooms from open regions in Play (WebGPU, the store off: not a lighting check): the script's hut (plaster walls and
 * roof round a 4.5 × 2.5 × 8 m room, a door of opening cells in its north wall, its floor repainted grass) read
 * through `ctx.voxels.regionAt`: a room of 90 m³ with its surface and mean free path, one portal joining it to the
 * pad, which is outdoors. Then cut-away: from a camera over the hut looking at the blue box on its floor (the
 * see-through subject, the camera's target), the middle of the picture shows the roof's plaster with the camera's
 * occlusion `none`, and the floor's green with `cutAway` (the roof and the walls over the box's top left out); the
 * floor stays in the roof's shadow (the roof still casts: no floor pixel as bright as the sunlit pad), and once the
 * roof is dug open the floor's sunlit patch shows. The box outside the hut: the two cameras' pictures are the same.
 */
export async function voxelRoomChecks(o: RoomCheckSetup): Promise<void> {
  const { ids, away, roofCameras } = o;
  const { control, counter, rel, place, still } = driver(o);
  const counted = async (cmd: string, name: string, args?: Record<string, unknown>): Promise<void> => {
    const n = await counter(name);
    await control(cmd, args);
    await expect.poll(() => counter(name), { timeout: 10_000 }).toBe(n + 1);
  };
  const t0 = Date.now();
  await counted('hut', 'hutBuilt');
  await counted('hutdoor', 'hutDoor');
  await counted('hutgreen', 'hutGreen');
  const gauges = async (): Promise<string> => {
    const c = ((await o.api(`play/${o.psid}/observe`)).json as { counters?: Record<string, number> }).counters ?? {};
    return ['hutKind', 'hutOut', 'hutPortals', 'hutPortalList', 'hutPortalJoins', 'hutVolume', 'hutSurface4', 'hutMfpCm'].map((k) => c[k] ?? 0).join(',');
  };
  // 4.5 × 2.5 × 8 m: 90 m³; 2 (4.5·2.5 + 4.5·8 + 2.5·8) = 134.5 m² less the door's 3 m² of opening (12 cell faces):
  // 131.5 m² (526 faces); 4 V / S = 2.74 m.
  await expect.poll(gauges, { timeout: 20_000, intervals: [100], message: 'the hut is a room with one portal to the outdoors' }).toBe('1,1,1,1,1,90,526,274');
  const roomMs = Date.now() - t0;
  // The box on the hut's floor, off its middle; the cameras 14 m over the hut, 3 m south, looking at it.
  await place(ids.blue, rel(1, 0.8, 6.25));
  const view = async (cam: string, name: string): Promise<Png> => {
    await counted('cam', 'camLive', { id: cam, target: ids.blue });
    const img = await still(name);
    await counted('uncam', 'camOff', { id: cam });
    return img;
  };
  const roomState = (): Promise<{ received: number; slots: ({ key: string; boxes: number[][] } | null)[] }> => o.page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first().evaluate(() => (window as unknown as { __tlVoxelPlay: { rooms(): { received: number; slots: ({ key: string; boxes: number[][] } | null)[] } } }).__tlVoxelPlay.rooms());
  const plain = await view(roofCameras.plain, 'rooms-roof-plain');
  await counted('cam', 'camLive', { id: roofCameras.cut, target: ids.blue });
  await expect.poll(async () => (await roomState()).slots[0] !== null, { timeout: 10_000, message: "the page has the subject's room" }).toBe(true);
  const room = (await roomState()).slots[0]!;
  const cut = await still('rooms-roof-cut');
  await counted('uncam', 'camOff', { id: roofCameras.cut });
  const mid = middle(plain, MIDDLE_SHARE);
  const notBlue = (p: readonly number[]): boolean => !blueBox(p);
  const roofGreen = countOver(plain, mid, (p) => grass(p) && notBlue(p));
  const cutGreen = countOver(cut, mid, (p) => grass(p) && notBlue(p));
  const midPx = countOver(plain, mid, () => true).n;
  // The pad in the sun round the hut (the picture's edges): what a sunlit floor pixel reads.
  const edge = (x: number, y: number): boolean => !middle(plain, 0.8)(x, y);
  const pad = countOver(cut, edge, grass);
  const sunlit = (img: Png): number => countOver(img, mid, (p) => grass(p) && lum(p) >= SUNLIT_SHARE * pad.lum).n;
  // The blue box on the floor: in the roof's shadow, or in the sun once the roof is dug open.
  const boxLum = (img: Png): number => countOver(img, mid, blueBox).lum;
  // The roof dug open over the middle of the room (the hut is no room then: nothing is cut), from the cut-away camera.
  await counted('hutopen', 'hutOpened');
  const opened = await view(roofCameras.cut, 'rooms-roof-opened');
  // Outdoors: the box on the pad 12 m east of the hut, nothing between it and the cameras (the hut out of its circle);
  // the two cameras draw the same.
  await place(ids.blue, rel(12, 0.8, 6.25));
  const outPlain = await view(roofCameras.plain, 'rooms-out-plain');
  const outCut = await view(roofCameras.cut, 'rooms-out-cut');
  const outDiff = changedPixels(outPlain, outCut, () => true, 30);
  await counted('unhut', 'hutDug');
  await place(ids.blue, away);
  console.log(`[voxel-play] rooms: the hut a room ${roomMs} ms after its build command (${await gauges()}); the page's room ${JSON.stringify(room)}; the middle's green ${roofGreen.n} of ${midPx} px with the roof drawn, ${cutGreen.n} cut away (floor lum ${cutGreen.lum.toFixed(1)}, the sunlit pad ${pad.lum.toFixed(1)}); floor pixels at least ${SUNLIT_SHARE} of the pad's: ${sunlit(cut)} under the cut roof, ${sunlit(opened)} with it dug open; the box ${boxLum(cut).toFixed(1)} under the cut roof, ${boxLum(opened).toFixed(1)} dug open; outdoors the cameras differ in ${outDiff} px`);
  expect(roofGreen.n, 'with the roof drawn the middle is plaster').toBeLessThan(ROOF_GREEN_MAX_SHARE * midPx);
  expect(cutGreen.n, 'with the roof cut away the middle is the floor').toBeGreaterThan(CUT_GREEN_MIN_SHARE * midPx);
  expect(sunlit(cut), 'the cut roof still shades the floor').toBeLessThan(SUNLIT_CUT_MAX_PX);
  expect(sunlit(opened), 'the roof dug open, the sun reaches the floor').toBeGreaterThan(SUNLIT_OPEN_MIN_PX);
  expect(boxLum(cut), 'the box under the cut roof is in its shadow').toBeLessThan(BOX_SHADED_SHARE * boxLum(opened));
  expect(outDiff, 'outdoors cut-away changes nothing').toBeLessThan(OUTDOORS_DIFF_MAX_PX);
}

/**
 * Bounds of the room checks, from the first run's readings (the preview's 670 × 253 picture, its middle 15 %: 3,838
 * px): green 8.9 % of the middle with the roof drawn, 94 % cut away; floor pixels at least 0.97 of the sunlit pad's
 * 78 under the cut roof and 1,154 dug open; the blue box 19.1 under the cut roof and 70.1 in the sun.
 */
const MIDDLE_SHARE = 0.15;
const ROOF_GREEN_MAX_SHARE = 0.3;
const CUT_GREEN_MIN_SHARE = 0.7;
const SUNLIT_SHARE = 0.97;
const SUNLIT_CUT_MAX_PX = 400;
const SUNLIT_OPEN_MIN_PX = 600;
const BOX_SHADED_SHARE = 0.6;
const OUTDOORS_DIFF_MAX_PX = 100;
