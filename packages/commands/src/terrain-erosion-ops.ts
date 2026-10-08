/**
 * `editTerrain` erode: hydraulic and thermal erosion over a rectangle, kept
 * as an erosion edit layer (`terrain-layers.ts`).
 *
 * The run reads the ground as the layers below the erosion layer make it
 * (the hand-made tiles, stamps, earlier erosion layers), over the rectangle
 * and a margin round it, erodes that grid (`erodeGrid`, deterministic) and
 * stores the difference it made inside the rectangle, faded in over its
 * border, per tile as the layer's blobs. Running it again over the same
 * place replaces that place's difference (it reads the ground below, not
 * its own result), so a run repeated gives the same ground inside the
 * border, where it blends with what the layer held. The host then
 * combines the rectangle again (`planTerrainSplineRebake`): heights, rules
 * and scatter there.
 *
 * The erosion itself is the slow part (seconds for a large rectangle): the
 * host can run it on a worker first (`erosionInput` gives the grid, the
 * worker erodes it) and hand the eroded heights to `planErosion`; without
 * them it runs here.
 *
 * Pure: the host reads tiles and blobs.
 */
import {
  EROSION_FADE_SAMPLES,
  EROSION_MARGIN_SAMPLES,
  EROSION_MAX_SAMPLES,
  erodeGrid,
  flatTerrainTile,
  terrainFlatStep,
  terrainHeightOf,
  terrainTileKey,
  validateErosionSettings,
  type ErosionGrid,
  type ErosionSettings,
  type ModelErrorV2,
  type ScatterRect,
  type TerrainComponent,
  type TerrainErosionLayer,
  type TerrainLayer,
  type TerrainTile,
} from '@thirdlight/project-model';

import { componentMissing, entityNotFound, fieldValue, type CommandError } from './errors';
import { TerrainLayerUnread, terrainSplineContext, type TerrainLayerReads } from './terrain-spline-ops';
import type { SceneDocument } from './types';
import type { TerrainTileRead } from './terrain-ops';

/** The layer an erode writes when it names none. */
export const EROSION_LAYER_ID_DEFAULT = 'erosion';

/** An erode's args (beside `entityId` and `kind`). */
export interface ErodeArgs {
  entityId: string;
  /** The erosion layer written (absent: {@link EROSION_LAYER_ID_DEFAULT}; made on top of the others, under the splines, when missing). */
  layerId?: string;
  /** World box [x0, z0, x1, z1]. */
  rect: [number, number, number, number];
  hydraulic?: ErosionSettings['hydraulic'];
  thermal?: ErosionSettings['thermal'];
  seed?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check an erode's own args (null: fine). */
export function erodeArgsError(args: Record<string, unknown>): CommandError | null {
  const rect = args['rect'];
  if (!(Array.isArray(rect) && rect.length === 4 && rect.every(finite) && (rect[0] as number) < (rect[2] as number) && (rect[1] as number) < (rect[3] as number))) return fieldValue('/args/rect', rect, '[x0, z0, x1, z1] world metres', 'rect is the world box eroded (x0 < x1, z0 < z1)');
  if (args['layerId'] !== undefined && !(typeof args['layerId'] === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(args['layerId']))) return fieldValue('/args/layerId', args['layerId'], 'a layer id', 'layerId names the erosion layer written');
  const errors: ModelErrorV2[] = [];
  validateErosionSettings({ ...(args['hydraulic'] !== undefined ? { hydraulic: args['hydraulic'] } : {}), ...(args['thermal'] !== undefined ? { thermal: args['thermal'] } : {}), ...(args['seed'] !== undefined ? { seed: args['seed'] } : {}) }, '/args', errors);
  if (errors.length > 0) return fieldValue(errors[0]!.path, (errors[0] as { found?: unknown }).found, 'erosion settings', errors[0]!.message);
  return null;
}

/** The grid an erode reads, and where it lies. */
export interface ErosionInput {
  entityId: string;
  component: TerrainComponent;
  origin: [number, number, number];
  layerId: string;
  /** The layers after the run (the erosion layer made when missing, its settings the run's). */
  layers: TerrainLayer[];
  settings: ErosionSettings;
  /** The grid's first sample (global indices). */
  gx0: number;
  gz0: number;
  /** The rectangle's samples (global, inclusive). */
  samples: [number, number, number, number];
  grid: ErosionGrid;
  /** The tiles the rectangle's samples lie on (their hand-made forms, read). */
  tiles: Map<string, TerrainTile>;
}

type SceneEntity = { id: string; components: Record<string, unknown> };

/**
 * Read what an erode erodes: the ground below its layer over the rectangle
 * and its margin, as metres (NaN where no tile is). The grid's heights are
 * the input; `planErosion` takes them eroded (or erodes them itself).
 */
export function erosionInput(scene: SceneDocument, args: ErodeArgs, read: TerrainTileRead, reads: TerrainLayerReads | undefined): { ok: true; input: ErosionInput } | { ok: false; error: CommandError } {
  try {
    return readInput(scene, args, read, reads);
  } catch (e) {
    if (e instanceof TerrainLayerUnread) return { ok: false, error: e.error };
    throw e;
  }
}

function readInput(scene: SceneDocument, args: ErodeArgs, read: TerrainTileRead, reads: TerrainLayerReads | undefined): { ok: true; input: ErosionInput } | { ok: false; error: CommandError } {
  const entity = (scene.entities as unknown as SceneEntity[]).find((e) => e.id === args.entityId);
  if (entity === undefined) return { ok: false, error: entityNotFound(args.entityId) };
  const comp = entity.components['terrain'] as TerrainComponent | undefined;
  if (comp === undefined) return { ok: false, error: componentMissing(args.entityId, 'terrain') };
  const p = (entity.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
  const origin: [number, number, number] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  const n = comp.tileSamples - 1;
  const sp = comp.spacing;
  const [x0, z0, x1, z1] = args.rect;
  const sx0 = Math.ceil((x0 - origin[0]) / sp);
  const sz0 = Math.ceil((z0 - origin[2]) / sp);
  const sx1 = Math.floor((x1 - origin[0]) / sp);
  const sz1 = Math.floor((z1 - origin[2]) / sp);
  if (sx1 - sx0 < 2 || sz1 - sz0 < 2) return { ok: false, error: fieldValue('/args/rect', args.rect, `a box at least 3 samples (${3 * sp} m) a side`, 'the box is too small to erode') };
  const count = (sx1 - sx0 + 1) * (sz1 - sz0 + 1);
  if (count > EROSION_MAX_SAMPLES) return { ok: false, error: fieldValue('/args/rect', args.rect, `a box of at most ${EROSION_MAX_SAMPLES} samples`, `the box holds ${count} samples: erode it in parts`) };
  const settings: ErosionSettings = { ...(args.hydraulic !== undefined ? { hydraulic: args.hydraulic } : {}), ...(args.thermal !== undefined ? { thermal: args.thermal } : {}), ...(args.seed !== undefined ? { seed: args.seed } : {}) };
  const layerId = args.layerId ?? EROSION_LAYER_ID_DEFAULT;
  const list = comp.layers ?? [];
  const found = list.find((l) => l.id === layerId);
  if (found !== undefined && found.kind !== 'erosion') return { ok: false, error: fieldValue('/args/layerId', layerId, 'an erosion layer', `layer "${layerId}" is a ${found.kind} layer`) };
  const layers: TerrainLayer[] = found === undefined ? [...list, { id: layerId, kind: 'erosion', settings }] : list.map((l) => (l.id === layerId ? { ...(l as TerrainErosionLayer), settings } : l));
  const m = EROSION_MARGIN_SAMPLES;
  const gx0 = sx0 - m;
  const gz0 = sz0 - m;
  const cols = sx1 - sx0 + 1 + 2 * m;
  const rows = sz1 - sz0 + 1 + 2 * m;
  const heights = new Float64Array(cols * rows).fill(Number.NaN);
  const ctx = terrainSplineContext(scene, { ...comp, layers }, origin, reads);
  const flat = terrainFlatStep(comp.heightRange);
  const tiles = new Map<string, TerrainTile>();
  const refs = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t]));
  // Every tile under the grid: the ground below the layer, laid into the grid.
  const tx0 = Math.floor(gx0 / n);
  const tz0 = Math.floor(gz0 / n);
  const tx1 = Math.floor((gx0 + cols - 1) / n);
  const tz1 = Math.floor((gz0 + rows - 1) / n);
  for (let tz = tz0; tz <= tz1; tz++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const ref = refs.get(terrainTileKey(tx, tz));
      if (ref === undefined) continue;
      const digest = ref.base ?? ref.data;
      let authored: TerrainTile;
      if (digest === undefined) authored = flatTerrainTile(comp.tileSamples, flat);
      else {
        const got = read(digest);
        if (!got.ok) return got;
        authored = got.tile;
      }
      const below = ctx.stack.heights(tx, tz, authored.heights, layerId);
      const S = n + 1;
      for (let j = 0; j < S; j++) {
        const gz = tz * n + j - gz0;
        if (gz < 0 || gz >= rows) continue;
        for (let i = 0; i < S; i++) {
          const gx = tx * n + i - gx0;
          if (gx < 0 || gx >= cols) continue;
          heights[gz * cols + gx] = terrainHeightOf(comp.heightRange, below[j * S + i]!);
        }
      }
      if (tx * n <= sx1 && (tx + 1) * n >= sx0 && tz * n <= sz1 && (tz + 1) * n >= sz0) tiles.set(terrainTileKey(tx, tz), authored);
    }
  if (tiles.size === 0) return { ok: false, error: fieldValue('/args/rect', args.rect, 'a box over the terrain\'s tiles', 'the box holds no tile of the terrain') };
  const grid: ErosionGrid = { cols, rows, spacing: sp, heights, region: [m, m, m + sx1 - sx0, m + sz1 - sz0] };
  return { ok: true, input: { entityId: args.entityId, component: comp, origin, layerId, layers, settings, gx0, gz0, samples: [sx0, sz0, sx1, sz1], grid, tiles } };
}

/** What an erode planned: its layer's new differences per tile (null: none left there), the layers after it and the box to combine again. */
export interface ErosionPlan {
  layerId: string;
  layers: TerrainLayer[];
  deltas: Map<string, Int16Array | null>;
  rect: ScatterRect;
  /** Samples whose difference changed. */
  changed: number;
}

/**
 * The erosion layer's new differences from the input and its eroded grid
 * (`eroded`: the same grid after `erodeGrid`, from a worker; absent: eroded
 * here). `old` reads the layer's stored difference of a tile.
 */
export function planErosion(input: ErosionInput, eroded: Float64Array | null, old: (digest: string) => { ok: true; delta: Int16Array } | { ok: false; error: CommandError }): { ok: true; plan: ErosionPlan } | { ok: false; error: CommandError } {
  const g = input.grid;
  let after = eroded;
  if (after === null) {
    const copy: ErosionGrid = { ...g, heights: g.heights.slice() };
    erodeGrid(copy, input.settings);
    after = copy.heights;
  }
  if (after.length !== g.heights.length) return { ok: false, error: fieldValue('/args', after.length, `${g.heights.length} heights`, 'the eroded grid does not match its input') };
  const comp = input.component;
  const n = comp.tileSamples - 1;
  const S = n + 1;
  const stepM = (comp.heightRange[1] - comp.heightRange[0]) / 65535;
  const [sx0, sz0, sx1, sz1] = input.samples;
  const layer = input.layers.find((l) => l.id === input.layerId) as TerrainErosionLayer;
  const stored = new Map((layer.tiles ?? []).map((t) => [terrainTileKey(t.x, t.z), t.data]));
  const F = EROSION_FADE_SAMPLES;
  const deltas = new Map<string, Int16Array | null>();
  let changed = 0;
  for (const key of input.tiles.keys()) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const digest = stored.get(key);
    let prev: Int16Array | null = null;
    if (digest !== undefined) {
      const got = old(digest);
      if (!got.ok) return got;
      prev = got.delta;
    }
    const d = prev !== null ? prev.slice() : new Int16Array(S * S);
    for (let j = 0; j < S; j++) {
      const gz = tz * n + j;
      if (gz < sz0 || gz > sz1) continue;
      for (let i = 0; i < S; i++) {
        const gx = tx * n + i;
        if (gx < sx0 || gx > sx1) continue;
        const at = (gz - input.gz0) * g.cols + (gx - input.gx0);
        const a = g.heights[at]!;
        const b = after[at]!;
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        // Faded in over the border, so the eroded rectangle meets the ground round it.
        const e = Math.min(gx - sx0, sx1 - gx, gz - sz0, sz1 - gz);
        const t = e >= F ? 1 : (e + 1) / (F + 1);
        const w = t * t * (3 - 2 * t);
        const now = Math.round((b - a) / stepM);
        const was = prev !== null ? prev[j * S + i]! : 0;
        const v = Math.max(-32768, Math.min(32767, Math.round(was + (now - was) * w)));
        if (v !== d[j * S + i]) {
          d[j * S + i] = v;
          changed++;
        }
      }
    }
    deltas.set(key, d.some((v) => v !== 0) ? d : null);
  }
  const sp = comp.spacing;
  const o = input.origin;
  const rect: ScatterRect = [o[0] + sx0 * sp, o[2] + sz0 * sp, o[0] + sx1 * sp, o[2] + sz1 * sp];
  return { ok: true, plan: { layerId: input.layerId, layers: input.layers, deltas, rect, changed } };
}
