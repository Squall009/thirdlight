/**
 * Terrains follow the splines and edit layers that shape them.
 *
 * A terrain tile a spline or an edit layer (`terrain-layers.ts`: stamps,
 * erosion) reaches keeps two forms: `base`, as sculpted and painted by
 * hand, and `data`, with the layer stack applied over it, the material rules
 * baked with the splines' paint and the scatter baked clear of their bands.
 * Every edit of the hand-made tile goes to `base` and makes `data` again; a
 * spline or layer added, moved, changed or removed makes `data` again from
 * `base` where it reached before and reaches now. A tile nothing reaches any
 * more drops its `base`.
 *
 * What a spline change re-bakes is the band round the curve, before and
 * after, as boxes along it about {@link SPLINE_REBAKE_PIECE} metres long —
 * not the box round a whole road, which for a long diagonal one would be
 * most of the terrain.
 *
 * Pure: the host reads tile blobs (`TerrainTileRead`) and publishes what this
 * plans.
 */
import {
  BlockGrid,
  SplineScatterBands,
  SurfaceRuleSet,
  TerrainField,
  TerrainLayerStack,
  TerrainSamples,
  TerrainSplineLayer,
  bakeTerrainRules,
  bakeTerrainScatter,
  flatTerrainTile,
  regionExcluder,
  scatterReach,
  splineScatterReach,
  storedScatterRules,
  terrainBakeMargin,
  terrainFlatStep,
  terrainLayerChangeRects,
  terrainScatterSurface,
  terrainSplineInputs,
  terrainSplineReach,
  terrainTileKey,
  terrainTileRect,
  terrainTileSize,
  type BlockLayerComponent,
  type Heightmap,
  type ScatterCell,
  type ScatterRect,
  type SplineComponent,
  type TerrainComponent,
  type TerrainSplineInput,
  type TerrainTile,
} from '@thirdlight/project-model';

import { layerDataOf } from './block-ops';
import { sceneRegionLayers, scatterBakeTooLarge } from './scatter-ops';
import { fieldValue, type CommandError } from './errors';
import type { SceneDocument } from './types';
import type { TerrainScatterRead, TerrainTileRead } from './terrain-ops';

/** Metres of curve one re-bake box covers. */
export const SPLINE_REBAKE_PIECE = 64;

type SceneEntity = { id: string; components: Record<string, unknown> };

function positionOf(e: SceneEntity): [number, number, number] {
  const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/**
 * World (x, z) on any block layer's cells (a column holding a cell): where
 * splines never change a terrain. Each layer's grid is built on first ask.
 */
export function blockedArea(scene: SceneDocument): ((x: number, z: number) => boolean) | null {
  const layers = (scene.entities as unknown as SceneEntity[]).filter((e) => e.components['blockLayer'] !== undefined);
  if (layers.length === 0) return null;
  const grids: ({ grid: BlockGrid; origin: [number, number, number]; cw: number; cd: number } | null)[] = [];
  return (x, z) => {
    for (let i = 0; i < layers.length; i++) {
      if (grids[i] === undefined) {
        const e = layers[i]!;
        const comp = e.components['blockLayer'] as BlockLayerComponent;
        const data = layerDataOf(scene, e.id);
        grids[i] = data === null ? null : { grid: BlockGrid.from(comp, data), origin: positionOf(e), cw: comp.cellSize[0], cd: comp.cellSize[2] };
      }
      const g = grids[i];
      if (g === null || g === undefined) continue;
      const cx = Math.floor((x - g.origin[0]) / g.cw);
      const cz = Math.floor((z - g.origin[2]) / g.cd);
      if (g.grid.columnTop(cx, cz, true) !== null) return true;
    }
    return false;
  };
}

/**
 * Boxes along a curve covering everything within `reach` metres of it, a
 * box about {@link SPLINE_REBAKE_PIECE} metres of curve (`segments`: only
 * those segments).
 */
export function splineBandRects(input: TerrainSplineInput, reach: number, segments?: readonly number[]): ScatterRect[] {
  if (reach <= 0) return [];
  const c = input.curve;
  const out: ScatterRect[] = [];
  for (const s of segments ?? Array.from({ length: c.segments }, (_, i) => i)) {
    if (s < 0 || s >= c.segments) continue;
    // A metre more than the reach: the curve between two frames 4 m apart bulges past their box by millimetres.
    out.push(...boxesAlong(c.segmentFrames(s, SPLINE_REBAKE_PIECE / 16), reach + 1));
  }
  return out;
}

function boxesAlong(frames: readonly { x: number; z: number }[], reach: number): ScatterRect[] {
  const out: ScatterRect[] = [];
  for (let k = 0; k === 0 || k + 1 < frames.length; k += 16) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (let j = k; j <= Math.min(frames.length - 1, k + 16); j++) {
      const f = frames[j]!;
      x0 = Math.min(x0, f.x);
      z0 = Math.min(z0, f.z);
      x1 = Math.max(x1, f.x);
      z1 = Math.max(z1, f.z);
    }
    out.push([x0 - reach, z0 - reach, x1 + reach, z1 + reach]);
  }
  return out;
}

/** What a spline input changes on terrain, for telling two scenes apart (null: nothing). */
function signature(s: SplineComponent, position: readonly number[]): string | null {
  if (s.terrain === undefined && s.scatter === undefined) return null;
  return JSON.stringify([position, s.points, s.closed ?? false, s.width ?? null, s.terrain ?? null, s.scatter ?? null]);
}

function splinesOf(scene: SceneDocument): Map<string, { sig: string; entity: SceneEntity }> {
  const out = new Map<string, { sig: string; entity: SceneEntity }>();
  for (const e of scene.entities as unknown as SceneEntity[]) {
    const s = e.components['spline'] as SplineComponent | undefined;
    if (s === undefined) continue;
    const sig = signature(s, positionOf(e));
    if (sig !== null) out.set(e.id, { sig, entity: e });
  }
  return out;
}

/** The boxes a spline's terrain change and scatter band reach (`segments`: only those). */
function reachRects(entity: SceneEntity, segments?: readonly number[]): ScatterRect[] {
  const [input] = terrainSplineInputs([entity]);
  if (input === undefined) return [];
  const reach = Math.max(terrainSplineReach(input.terrain, input.curve.maxWidth), splineScatterReach(input.scatter, input.curve.maxWidth));
  return splineBandRects(input, reach, segments);
}

/**
 * The segments a change of points moved, when only points changed and their
 * count stayed (null: the whole curve changed). A point moves the segments
 * on either side of it and, through the smooth tangents of its neighbours,
 * one more each way.
 */
function movedSegments(a: SceneEntity, b: SceneEntity): number[] | null {
  const x = a.components['spline'] as SplineComponent;
  const y = b.components['spline'] as SplineComponent;
  if (x.points.length !== y.points.length || (x.closed ?? false) !== (y.closed ?? false) || JSON.stringify(positionOf(a)) !== JSON.stringify(positionOf(b))) return null;
  if (JSON.stringify([x.width, x.terrain, x.scatter]) !== JSON.stringify([y.width, y.terrain, y.scatter])) return null;
  const n = x.points.length;
  const segs = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(x.points[i]) === JSON.stringify(y.points[i])) continue;
    for (let s = i - 2; s <= i + 1; s++) segs.add((x.closed ?? false) ? (s + n) % n : s);
  }
  return [...segs].sort((p, q) => p - q);
}

/** A terrain whose place or tile grid changed: every spline over it shapes it again. */
function terrainMoved(before: SceneEntity | undefined, after: SceneEntity): boolean {
  if (before === undefined) return true;
  const a = before.components['terrain'] as TerrainComponent | undefined;
  const b = after.components['terrain'] as TerrainComponent;
  if (a === undefined) return true;
  return JSON.stringify(positionOf(before)) !== JSON.stringify(positionOf(after)) || a.tileSamples !== b.tileSamples || a.spacing !== b.spacing || a.heightRange[0] !== b.heightRange[0] || a.heightRange[1] !== b.heightRange[1];
}

/**
 * The world boxes each terrain of `after` must shape again after a change
 * from `before` (by terrain id): where a spline that shapes terrain or keeps
 * scatter clear was added, removed, moved or changed, before and after;
 * where its edit layers changed; a terrain moved or re-gridded, under every
 * spline. Empty: nothing to do.
 */
export function splineRebakeRects(before: SceneDocument, after: SceneDocument): Map<string, ScatterRect[]> {
  const a = splinesOf(before);
  const b = splinesOf(after);
  const rects: ScatterRect[] = [];
  for (const [id, x] of a) {
    const y = b.get(id);
    if (y?.sig === x.sig) continue;
    // Only points moved: the segments they moved, before and after; else the whole curve, before and after.
    const segs = y !== undefined ? movedSegments(x.entity, y.entity) : null;
    rects.push(...reachRects(x.entity, segs ?? undefined));
    if (y !== undefined) rects.push(...reachRects(y.entity, segs ?? undefined));
  }
  for (const [id, y] of b) if (!a.has(id)) rects.push(...reachRects(y.entity));
  const out = new Map<string, ScatterRect[]>();
  const beforeById = new Map((before.entities as unknown as SceneEntity[]).map((e) => [e.id, e]));
  for (const e of after.entities as unknown as SceneEntity[]) {
    if (e.components['terrain'] === undefined) continue;
    const moved = terrainMoved(beforeById.get(e.id), e) && (b.size > 0 || (beforeById.get(e.id)?.components['terrain'] as TerrainComponent | undefined)?.tiles.some((t) => t.base !== undefined) === true);
    const all = moved ? [...b.values()].flatMap((x) => reachRects(x.entity)) : [];
    const list = [...rects, ...all];
    // Its edit layers changed (stamps, erosion, their order, switch or strength): where they reach, before and after.
    const was = beforeById.get(e.id)?.components['terrain'] as TerrainComponent | undefined;
    const now = e.components['terrain'] as TerrainComponent;
    const size = terrainTileSize(now);
    const o = positionOf(e);
    const splineReach = (): ScatterRect[] => [...b.values()].flatMap((x) => reachRects(x.entity));
    if (JSON.stringify(was?.layers ?? []) !== JSON.stringify(now.layers ?? [])) list.push(...terrainLayerChangeRects(was?.layers, now.layers, (x, z) => terrainTileRect(o, size, x, z), splineReach));
    // A terrain moved or re-gridded under world-placed stamps: everything its layers reach now.
    else if ((now.layers?.length ?? 0) > 0 && terrainMoved(beforeById.get(e.id), e)) list.push(...terrainLayerChangeRects(undefined, now.layers, (x, z) => terrainTileRect(o, size, x, z), splineReach));
    if (moved && (e.components['terrain'] as TerrainComponent).tiles.some((t) => t.base !== undefined)) {
      // Tiles shaped where the terrain was: their hand-made form comes back where no spline reaches now.
      const comp = e.components['terrain'] as TerrainComponent;
      const size = terrainTileSize(comp);
      const o = positionOf(e);
      for (const t of comp.tiles) if (t.base !== undefined) list.push(terrainTileRect(o, size, t.x, t.z));
    }
    if (list.length > 0) out.set(e.id, list);
  }
  return out;
}

/**
 * What the host reads for a terrain's edit layers: a stamp's shape (a
 * texture asset's first channel; null: none) and an erosion blob's steps.
 */
export interface TerrainLayerReads {
  heightmap(asset: string): Heightmap | null;
  delta(digest: string): { ok: true; delta: Int16Array } | { ok: false; error: CommandError };
}

/** Thrown inside a combine when a layer's blob cannot be read; the planners turn it into their refusal. */
export class TerrainLayerUnread extends Error {
  constructor(readonly error: CommandError) {
    super(error.message);
  }
}

/** The splines and edit layers over a terrain, ready to shape it. */
export interface TerrainSplineContext {
  readonly layer: TerrainSplineLayer;
  /** The whole stack (stamps, erosion, the splines in their place). */
  readonly stack: TerrainLayerStack;
  readonly bands: SplineScatterBands;
  /** Whether layers take part at all (any reaches it, or any tile still has its hand-made form beside). */
  readonly layered: boolean;
  /** Whether any spline paints. */
  readonly paints: boolean;
}

export function terrainSplineContext(scene: SceneDocument, comp: TerrainComponent, origin: readonly number[], reads?: TerrainLayerReads, deltas?: ReadonlyMap<string, Int16Array>): TerrainSplineContext {
  const inputs = terrainSplineInputs(scene.entities as unknown as SceneEntity[]);
  const layer = new TerrainSplineLayer(inputs, comp, origin, blockedArea(scene));
  const bands = new SplineScatterBands(inputs);
  const shapes = new Map<string, Heightmap | null>();
  const read = new Map<string, Int16Array>(deltas ?? []);
  const sources = reads === undefined && deltas === undefined
    ? null
    : {
        heightmap: (asset: string): Heightmap | null => {
          if (!shapes.has(asset)) shapes.set(asset, reads?.heightmap(asset) ?? null);
          return shapes.get(asset)!;
        },
        delta: (digest: string): Int16Array => {
          let d = read.get(digest);
          if (d !== undefined) return d;
          const got = reads?.delta(digest) ?? { ok: false as const, error: fieldValue('/args', digest, 'an erosion blob', 'a terrain\'s erosion layer is read through the project host') };
          if (!got.ok) throw new TerrainLayerUnread(got.error);
          read.set(digest, (d = got.delta));
          return d;
        },
      };
  const stack = new TerrainLayerStack(comp, origin, layer, sources);
  return { layer, stack, bands, layered: !stack.empty || comp.tiles.some((t) => t.base !== undefined), paints: layer.inputs.some((i) => i.terrain?.paint !== undefined) };
}

/**
 * The combined tile of a hand-made one (heights through the layer stack;
 * holes and paint the hand's; baked weights as `data` has them until the
 * bake).
 */
export function combinedTile(ctx: TerrainSplineContext, tx: number, tz: number, authored: TerrainTile, data: TerrainTile | undefined): TerrainTile {
  return { samples: authored.samples, heights: ctx.stack.heights(tx, tz, authored.heights), weights: data?.weights ?? authored.weights, holes: authored.holes, paint: authored.paint };
}

/** Write a combined tile into `c` where it differs from what `c` holds (or add it). */
export function putCombined(c: TerrainSamples, tx: number, tz: number, t: TerrainTile): void {
  const cur = c.tile(tx, tz);
  const same = (a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean => {
    if (a === b) return true;
    if (a === null || b === null || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  if (cur !== undefined && same(cur.heights, t.heights) && same(cur.holes, t.holes) && same(cur.paint, t.paint) && same(cur.weights, t.weights)) return;
  const w = cur !== undefined ? c.writable(tx, tz)! : c.addTile(tx, tz);
  w.heights = t.heights === cur?.heights ? t.heights.slice() : t.heights;
  w.holes = t.holes?.slice() ?? null;
  w.paint = t.paint?.slice() ?? null;
  w.weights = t.weights?.slice() ?? null;
}

/** What a spline re-bake of one terrain plans: tiles (combined), hand-made forms (null: dropped), scatter. */
export interface TerrainSplinePlan {
  entityId: string;
  component: TerrainComponent;
  tiles: Map<string, TerrainTile>;
  bases: Map<string, TerrainTile | null>;
  scatter: Map<string, ScatterCell | null>;
  /** Samples whose heights or layers changed. */
  changed: number;
}

/** World boxes as global sample boxes of a terrain, grown by `margin` samples. */
function sampleRects(rects: readonly ScatterRect[], origin: readonly number[], sp: number, margin: number): [number, number, number, number][] {
  return rects.map((r) => [Math.floor((r[0] - origin[0]!) / sp) - margin, Math.floor((r[1] - origin[2]!) / sp) - margin, Math.ceil((r[2] - origin[0]!) / sp) + margin, Math.ceil((r[3] - origin[2]!) / sp) + margin]);
}

/**
 * Shape one terrain again over `rects` (world boxes): heights from the
 * hand-made tiles through the splines, the rules (and the splines' paint)
 * baked there, the scatter baked there clear of the bands. Null: nothing
 * changes.
 */
export function planTerrainSplineRebake(scene: SceneDocument, entityId: string, rects: readonly ScatterRect[], read: TerrainTileRead, readScatter: TerrainScatterRead, layers?: TerrainLayerReads, deltas?: ReadonlyMap<string, Int16Array>): { ok: true; plan: TerrainSplinePlan | null } | { ok: false; error: CommandError } {
  try {
    return rebake(scene, entityId, rects, read, readScatter, layers, deltas);
  } catch (e) {
    if (e instanceof TerrainLayerUnread) return { ok: false, error: e.error };
    throw e;
  }
}

function rebake(scene: SceneDocument, entityId: string, rects: readonly ScatterRect[], read: TerrainTileRead, readScatter: TerrainScatterRead, layers: TerrainLayerReads | undefined, deltas: ReadonlyMap<string, Int16Array> | undefined): { ok: true; plan: TerrainSplinePlan | null } | { ok: false; error: CommandError } {
  const entity = (scene.entities as unknown as SceneEntity[]).find((e) => e.id === entityId);
  const comp = entity?.components['terrain'] as TerrainComponent | undefined;
  if (entity === undefined || comp === undefined) return { ok: true, plan: null };
  const origin = positionOf(entity);
  const size = terrainTileSize(comp);
  const n = comp.tileSamples - 1;
  const sp = comp.spacing;
  const ctx = terrainSplineContext(scene, comp, origin, layers, deltas);
  const rules = comp.rules;
  const ruleSet = rules !== undefined && rules.length > 0 ? new SurfaceRuleSet(rules) : null;
  const margin = ruleSet !== null ? terrainBakeMargin(ruleSet, sp) : 1;
  const stored = storedScatterRules(comp.scatter);
  const sReach = stored.length > 0 ? scatterReach(stored) + 2 * sp : 0;
  const grow = (r: ScatterRect, m: number): ScatterRect => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
  const overlaps = (r: ScatterRect, x: number, z: number): boolean => {
    const b = terrainTileRect(origin, size, x, z);
    return !(r[0] > b[2] || r[2] < b[0] || r[1] > b[3] || r[3] < b[1]);
  };
  // The tiles the shaped boxes touch, and those around them the bakes read.
  const readBox = (margin + 1) * sp + 2 * sReach;
  const shaped = new Set<string>();
  const loaded = new Map<string, TerrainTile>();
  const authored = new Map<string, TerrainTile>();
  const flat = terrainFlatStep(comp.heightRange);
  for (const ref of comp.tiles) {
    if (!rects.some((r) => overlaps(grow(r, readBox), ref.x, ref.z))) continue;
    const key = terrainTileKey(ref.x, ref.z);
    let data: TerrainTile;
    if (ref.data === undefined) data = flatTerrainTile(comp.tileSamples, flat);
    else {
      const got = read(ref.data);
      if (!got.ok) return got;
      data = got.tile;
    }
    loaded.set(key, data);
    if (ref.base === undefined) authored.set(key, data);
    else {
      const got = read(ref.base);
      if (!got.ok) return got;
      authored.set(key, got.tile);
    }
    if (rects.some((r) => overlaps(r, ref.x, ref.z))) shaped.add(key);
  }
  if (loaded.size === 0) return { ok: true, plan: null };
  const c = new TerrainSamples(comp, loaded);
  const s = new TerrainSamples(comp, authored);
  for (const key of shaped) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    putCombined(c, tx, tz, combinedTile(ctx, tx, tz, authored.get(key)!, loaded.get(key)));
  }
  let changed = 0;
  // The rules and the splines' paint, over the boxes grown by the rules' reach.
  if (ruleSet !== null || ctx.paints || comp.tiles.some((t) => t.base !== undefined)) {
    const over = { paint: (tx: number, tz: number) => ctx.layer.paint(tx, tz), base: (tx: number, tz: number) => s.tile(tx, tz) };
    for (const r of sampleRects(rects, origin, sp, margin)) changed += bakeTerrainRules(c, ruleSet, origin, r, over);
  }
  // The hand-made forms (a re-bake never changes them): stored beside where a spline or layer reaches now, dropped where none does.
  const bases = new Map<string, TerrainTile | null>();
  for (const key of shaped) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const had = comp.tiles.find((t) => t.x === tx && t.z === tz)?.base !== undefined;
    const reaches = ctx.stack.reaches(tx, tz);
    if (reaches && !had) bases.set(key, authored.get(key)!);
    else if (!reaches && had) bases.set(key, null);
  }
  const tiles = new Map<string, TerrainTile>();
  for (const key of c.touched) tiles.set(key, c.all().get(key)!);
  // Where a tile drops its hand-made form its data must be exactly that form again.
  for (const [key, b] of bases) if (b === null && !tiles.has(key)) tiles.set(key, c.all().get(key)!);
  // The scatter, clear of the bands, over the boxes grown by its reach.
  const scatter = new Map<string, ScatterCell | null>();
  if (stored.length > 0) {
    const coords = [...c.all().keys()].map((k) => k.split(',').map(Number) as [number, number]);
    const tooLarge = scatterBakeTooLarge(stored, null, rects.reduce((a, r) => a + (r[2] - r[0] + 2 * sReach) * (r[3] - r[1] + 2 * sReach), 0));
    if (tooLarge !== null) return { ok: false, error: tooLarge };
    const refs = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t]));
    const current = new Map<string, ScatterCell>();
    const original = new Map<string, ScatterCell>();
    for (const [x, z] of coords) {
      const digest = refs.get(terrainTileKey(x, z))?.scatter;
      if (digest === undefined) continue;
      const got = readScatter(digest);
      if (!got.ok) return got;
      current.set(terrainTileKey(x, z), got.cell);
      original.set(terrainTileKey(x, z), got.cell);
    }
    const field = new TerrainField({ ...comp, tiles: coords.map(([x, z]) => ({ x, z, data: '' })) }, origin, c.all());
    const surface = terrainScatterSurface(field, regionExcluder(sceneRegionLayers(scene)), ctx.bands.empty ? undefined : (x, z, rule) => ctx.bands.cleared(x, z, rule));
    const touched = new Set<string>();
    for (const r of rects) {
      const baked = bakeTerrainScatter(stored, surface, origin, size, coords, current, grow(r, sReach), current);
      for (const [k, cell] of baked.cells) {
        touched.add(k);
        if (cell === null) current.delete(k);
        else current.set(k, cell);
      }
    }
    for (const k of touched) {
      const now = current.get(k) ?? null;
      const was = original.get(k) ?? null;
      if (now === was) continue;
      scatter.set(k, now);
    }
  }
  if (tiles.size === 0 && bases.size === 0 && scatter.size === 0) return { ok: true, plan: null };
  if (tiles.size > 0 && changed === 0) changed = tiles.size;
  return { ok: true, plan: { entityId, component: comp, tiles, bases, scatter, changed } };
}

/** The refusal when a spline's terrain would need a tile the host cannot read. */
export function splineTileUnread(digest: string): CommandError {
  return fieldValue('/args', digest, 'a stored terrain tile', 'a terrain tile the splines shape cannot be read');
}
