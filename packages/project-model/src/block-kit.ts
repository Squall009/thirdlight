/**
 * Kit swaps — one layout, several looks: a dungeon and its burnt or ruined
 * state share their cells, and a layer (or a region of it) shows the other
 * kit without one cell being rewritten.
 *
 * A block type says what it becomes under each kit (`kits`: kit name → the
 * block type shown instead, and optionally the look). A kit is every type's
 * entry under one name, so a project's kits are the names its types use. A
 * layer names the kits it shows (`blockLayer.kits`): one for the whole layer
 * and one per region at most; a region's kit wins over the layer's where it
 * swaps a block, and a later region over an earlier one where regions
 * overlap. Scripts change the same list at run time (`ctx.grid.setKit`).
 *
 * The swap is resolved where a look is needed, never stored: meshing (on the
 * page and in the mesh workers), collision, connected pieces, live blocks and
 * `ctx.grid` reads see the layer through a `BlockKitView` (`block-kit-view.ts`), so the page
 * and the workers mesh the same bytes, saves keep the authored cells, and
 * taking the kit off brings the layer back exactly. A swapped type keeps the
 * layout: the same placement (cell or edge) and the same footprint, checked
 * with the content. The cell keeps its rotation, metadata and (where the
 * target can slope) its corner heights; its look is the swap's, else the
 * cell's own when the target has it, else one picked by the target's weights
 * (a connected target resolves its pieces from the swapped neighbours).
 *
 * Pure data and pure functions.
 */
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';
import { BLOCK_LIMITS, REGION_ID_RE, type BlockLayerComponent, type BlockType } from './block-layers';

/** What a block type shows under one kit. */
export interface BlockKitSwap {
  /** The block type drawn instead (the same placement and footprint). */
  block: string;
  /** The look it shows (absent: the cell's own look when the target has it, else one picked by the target's weights). */
  variant?: number;
  /** Per look of this type (index: the cell's variant, or the one its weights pick): the target's look shown. Wins over `variant`. */
  variants?: number[];
}

/** One kit a layer shows: over the whole layer, or over one of its regions. */
export interface BlockLayerKit {
  kit: string;
  /** The region it covers (absent: the whole layer). */
  region?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const err = (errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void => {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
};
const variantIndex = (v: unknown): boolean => isInt(v) && v >= 0 && v < BLOCK_LIMITS.variants;

// ---- block types' kits -------------------------------------------------------------------

/** The shape of a type's `kits` (the targets are checked with the content). */
export function validateBlockTypeKits(v: unknown, p: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) return err(errors, 'field_type', p, 'kits is an object (kit name → {block, variant?, variants?})', v);
  for (const [name, swap] of Object.entries(v)) {
    const sp = `${p}/${name}`;
    if (!ID_RE.test(name)) err(errors, 'id_invalid', sp, 'a kit name uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', name);
    if (!isPlainObject(swap)) {
      err(errors, 'field_type', sp, 'a kit swap is {block, variant?, variants?}', swap);
      continue;
    }
    for (const k of Object.keys(swap)) if (k !== 'block' && k !== 'variant' && k !== 'variants') err(errors, 'field_unexpected', `${sp}/${k}`, `unknown kit swap field "${k}"`, k);
    if (typeof swap['block'] !== 'string' || !ID_RE.test(swap['block'])) err(errors, 'id_invalid', `${sp}/block`, 'block is a block type id', swap['block']);
    if (swap['variant'] !== undefined && !variantIndex(swap['variant'])) err(errors, 'field_value', `${sp}/variant`, `variant is an index 0-${BLOCK_LIMITS.variants - 1}`, swap['variant']);
    const vs = swap['variants'];
    if (vs !== undefined && (!Array.isArray(vs) || vs.length < 1 || vs.length > BLOCK_LIMITS.variants || !vs.every(variantIndex))) {
      err(errors, 'field_value', `${sp}/variants`, `variants is 1-${BLOCK_LIMITS.variants} look indices (0-${BLOCK_LIMITS.variants - 1}), one per look of this block`, vs);
    }
  }
}

/** The stored form: kit names sorted, empty fields left out (null: no kits). */
export function canonicalBlockTypeKits(kits: Readonly<Record<string, BlockKitSwap>> | undefined): Record<string, BlockKitSwap> | null {
  if (kits === undefined) return null;
  const names = Object.keys(kits).sort();
  if (names.length === 0) return null;
  const out: Record<string, BlockKitSwap> = {};
  for (const name of names) {
    const s = kits[name]!;
    out[name] = { block: s.block, ...(s.variant !== undefined ? { variant: s.variant } : {}), ...(s.variants !== undefined ? { variants: [...s.variants] } : {}) };
  }
  return out;
}

/** The content's rules: a swap names a block type of the same placement and footprint, and looks the target has. */
export function composeBlockTypeKits(t: BlockType, path: string, types: ReadonlyMap<string, BlockType>, errors: ModelErrorV2[]): void {
  for (const [name, s] of Object.entries(t.kits ?? {})) {
    const sp = `${path}/kits/${name}`;
    const o = types.get(s.block);
    if (o === undefined) {
      err(errors, 'reference_missing', `${sp}/block`, 'a kit swap names a block type of content.blockTypes', s.block);
      continue;
    }
    if ((o.placement === 'edge') !== (t.placement === 'edge')) err(errors, 'field_value', `${sp}/block`, t.placement === 'edge' ? `"${s.block}" fills cells; an edge piece swaps to an edge piece` : `"${s.block}" is an edge piece; a cell block swaps to a cell block`, s.block);
    const f = t.footprint ?? [1, 1, 1];
    const g = o.footprint ?? [1, 1, 1];
    if (f[0] !== g[0] || f[1] !== g[1] || f[2] !== g[2]) err(errors, 'field_value', `${sp}/block`, `a kit keeps the layout: "${s.block}" covers ${g.join(' × ')} cells, "${t.blockId}" ${f.join(' × ')}`, s.block);
    if (s.variant !== undefined && s.variant >= o.variants.length) err(errors, 'field_value', `${sp}/variant`, `block "${o.blockId}" has ${o.variants.length} variant(s)`, s.variant);
    (s.variants ?? []).forEach((v, i) => {
      if (v >= o.variants.length) err(errors, 'field_value', `${sp}/variants/${i}`, `block "${o.blockId}" has ${o.variants.length} variant(s)`, v);
    });
  }
}

/** Every kit name the block types use, sorted (a project's kits). */
export function blockKitNames(types: Iterable<Pick<BlockType, 'kits'>>): string[] {
  const out = new Set<string>();
  for (const t of types) for (const k of Object.keys(t.kits ?? {})) out.add(k);
  return [...out].sort();
}

// ---- a layer's kits ----------------------------------------------------------------------

/** The shape of a layer's `kits`: kit names and region ids, one kit per region and one for the whole layer at most. */
export function validateLayerKits(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  // A kit per region and one for the layer: as many as a layer has regions, plus one.
  if (!Array.isArray(v) || v.length > BLOCK_LIMITS.regions + 1) return err(errors, 'field_value', path, `kits is a list of at most ${BLOCK_LIMITS.regions + 1} {kit, region?}`, Array.isArray(v) ? v.length : v);
  const seen = new Set<string>();
  v.forEach((k, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(k)) return err(errors, 'field_type', p, 'a layer kit is {kit, region?}', k);
    for (const key of Object.keys(k)) if (key !== 'kit' && key !== 'region') err(errors, 'field_unexpected', `${p}/${key}`, `unknown layer kit field "${key}"`, key);
    if (typeof k['kit'] !== 'string' || !ID_RE.test(k['kit'])) err(errors, 'id_invalid', `${p}/kit`, 'kit is a kit name (the id syntax)', k['kit']);
    const region = k['region'];
    if (region !== undefined && (typeof region !== 'string' || !REGION_ID_RE.test(region))) return err(errors, 'id_invalid', `${p}/region`, 'region is a region id (1-64 letters, digits, "_", "." or "-")', region);
    const key = typeof region === 'string' ? region : '';
    if (seen.has(key)) err(errors, 'id_duplicate', p, region === undefined ? 'the whole layer shows one kit' : 'a region shows one kit', region ?? k['kit']);
    seen.add(key);
  });
}

/** The stored form: the whole layer's first, then the regions' in their order (they decide where regions overlap); undefined: none. */
export function canonicalLayerKits(kits: readonly BlockLayerKit[] | undefined): BlockLayerKit[] | undefined {
  if (kits === undefined || kits.length === 0) return undefined;
  const whole = kits.filter((k) => k.region === undefined).map((k) => ({ kit: k.kit }));
  const regions = kits.filter((k) => k.region !== undefined).map((k) => ({ kit: k.kit, region: k.region! }));
  return [...whole, ...regions];
}

/** One kit over a part of a layer (null boxes: the whole layer). */
export interface KitZone {
  readonly kit: string;
  readonly boxes: readonly (readonly number[])[] | null;
}

/** The zones a layer's kits make: the whole layer's first, then each region that exists (a missing one makes none). */
export function kitZones(kits: readonly BlockLayerKit[] | undefined, regions: ReadonlyMap<string, readonly (readonly number[])[]>): KitZone[] {
  const out: KitZone[] = [];
  for (const k of canonicalLayerKits(kits) ?? []) {
    if (k.region === undefined) out.push({ kit: k.kit, boxes: null });
    else {
      const boxes = regions.get(k.region);
      if (boxes !== undefined) out.push({ kit: k.kit, boxes });
    }
  }
  return out;
}

/** The regions a layer's kits name that it does not have (they swap nothing). */
export function kitRegionsMissing(c: Pick<BlockLayerComponent, 'kits'>, regions: ReadonlySet<string>): string[] {
  return (c.kits ?? []).flatMap((k) => (k.region !== undefined && !regions.has(k.region) ? [k.region] : []));
}

/** Whether a swap changes what collides (another shape, boxes or solidity): only then does a kit change rebuild colliders. */
export function kitSwapCollides(from: BlockType, to: BlockType): boolean {
  return from.shape !== to.shape || JSON.stringify(from.boxes ?? null) !== JSON.stringify(to.boxes ?? null) || (from.solid ?? null) !== (to.solid ?? null) || (from.blocking ?? true) !== (to.blocking ?? true);
}

/** A layer's kits as a key: equal lists (in their stored form), equal keys. */
export function kitKey(kits: readonly BlockLayerKit[] | undefined): string {
  return JSON.stringify(canonicalLayerKits(kits) ?? []);
}
