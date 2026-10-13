/**
 * The block editor's edits of a block layer's own settings, as data: a
 * region cut away or not, the theme the layer (or one region) shows, and a
 * region renamed or deleted — the layer's cut-aways, themes and walk start
 * follow it (or let it go) — and the layer's bounds grown or shrunk. Each gives the component one `setComponent`
 * stores; null when nothing changes.
 *
 * Pure.
 */
import type { BlockCutaway, BlockLayerComponent } from '@thirdlight/project-model';
import { BLOCK_LIMITS } from '@thirdlight/project-model/limits';

/** The layer with a region cut away in the game (or not): `cutaway.regions`, an empty cut-away stored as none. */
export function withCutaway(c: BlockLayerComponent, regionId: string, on: boolean): BlockLayerComponent {
  const cut = c.cutaway ?? {};
  const regions = (cut.regions ?? []).filter((x) => x.region !== regionId);
  if (on) regions.push({ region: regionId });
  const cutaway: BlockCutaway = { ...cut, regions };
  if (regions.length === 0) delete cutaway.regions;
  return { ...c, cutaway };
}

/** Whether a region is cut away in the game. */
export const isCutAway = (c: BlockLayerComponent, regionId: string): boolean => c.cutaway?.regions?.some((x) => x.region === regionId) === true;

/** The theme a layer shows over all of it (region null) or over one region ('' : none there). */
export function withTheme(c: BlockLayerComponent, regionId: string | null, theme: string): BlockLayerComponent {
  const kits = (c.kits ?? []).filter((k) => (k.region ?? null) !== regionId);
  if (theme !== '') kits.push({ kit: theme, ...(regionId !== null ? { region: regionId } : {}) });
  return { ...c, kits };
}

/** The theme shown over the layer (region null) or a region ('': none). */
export const themeOf = (c: BlockLayerComponent, regionId: string | null): string => (c.kits ?? []).find((k) => (k.region ?? null) === regionId)?.kit ?? '';

/**
 * A region renamed (`to`) or deleted (null): the layer's cut-aways, themes
 * and walk that name it follow it, or let it go. Null: nothing names it.
 */
export function withRegionFollowed(c: BlockLayerComponent, from: string, to: string | null): BlockLayerComponent | null {
  const regions = (c.cutaway?.regions ?? []).flatMap((r) => {
    if (r.region === from || r.when === from) return to === null ? [] : [{ region: r.region === from ? to : r.region, ...(r.when !== undefined ? { when: r.when === from ? to : r.when } : {}) }];
    return [r];
  });
  const kits = (c.kits ?? []).flatMap((k) => (k.region !== from ? [k] : to === null ? [] : [{ kit: k.kit, region: to }]));
  const walkFollows = c.walk?.from === from;
  if (JSON.stringify(regions) === JSON.stringify(c.cutaway?.regions ?? []) && JSON.stringify(kits) === JSON.stringify(c.kits ?? []) && !walkFollows) return null;
  const next: BlockLayerComponent = { ...c, kits };
  if (walkFollows) {
    const { from: _from, ...rest } = c.walk!;
    const walk = to === null ? rest : { ...rest, from: to };
    // A walk left with nothing is removed (null takes a component's optional field away).
    next.walk = (Object.keys(walk).length > 0 ? walk : null) as BlockLayerComponent['walk'];
  }
  if (c.cutaway !== undefined) {
    const cutaway: BlockCutaway = { ...c.cutaway, regions };
    if (regions.length === 0) delete cutaway.regions;
    next.cutaway = cutaway;
  }
  return next;
}

type Vec3 = [number, number, number];

/**
 * The layer with new bounds in cells (max exclusive), or a plain refusal:
 * whole cells, max above min on every axis, within the coordinate range and
 * the largest layer `BLOCK_LIMITS` allows. Cells outside the new bounds are
 * not dropped here: the backend refuses bounds that leave a cell outside, so
 * shrinking never deletes blocks silently.
 */
export function withBounds(c: BlockLayerComponent, min: readonly number[], max: readonly number[]): { ok: true; component: BlockLayerComponent | null } | { ok: false; message: string } {
  const lo = [0, 1, 2].map((i) => Math.round(min[i] ?? Number.NaN)) as Vec3;
  const hi = [0, 1, 2].map((i) => Math.round(max[i] ?? Number.NaN)) as Vec3;
  if ([...lo, ...hi].some((v) => !Number.isFinite(v))) return { ok: false, message: 'Bounds need a whole number of cells on every side.' };
  const reach = [BLOCK_LIMITS.coordinateXZ, BLOCK_LIMITS.coordinateY, BLOCK_LIMITS.coordinateXZ];
  if ([0, 1, 2].some((i) => Math.abs(lo[i]!) > reach[i]! || Math.abs(hi[i]!) > reach[i]!)) return { ok: false, message: `Bounds stay within ±${BLOCK_LIMITS.coordinateXZ} cells across and ±${BLOCK_LIMITS.coordinateY} up.` };
  if ([0, 1, 2].some((i) => hi[i]! <= lo[i]!)) return { ok: false, message: 'Each side must be at least one cell: the far edge beyond the near one.' };
  const span = [BLOCK_LIMITS.layerWidth, BLOCK_LIMITS.layerHeight, BLOCK_LIMITS.layerWidth];
  if ([0, 1, 2].some((i) => hi[i]! - lo[i]! > span[i]!)) return { ok: false, message: `A layer is at most ${BLOCK_LIMITS.layerWidth} × ${BLOCK_LIMITS.layerHeight} × ${BLOCK_LIMITS.layerWidth} cells.` };
  const same = [0, 1, 2].every((i) => lo[i] === c.bounds.min[i] && hi[i] === c.bounds.max[i]);
  return { ok: true, component: same ? null : { ...c, bounds: { min: lo, max: hi } } };
}

/** The bounds grown by `cells` on every side across (x and z; negative shrinks), up and down left alone. */
export function boundsGrown(c: BlockLayerComponent, cells: number): { min: Vec3; max: Vec3 } {
  const { min, max } = c.bounds;
  return { min: [min[0] - cells, min[1], min[2] - cells], max: [max[0] + cells, max[1], max[2] + cells] };
}
