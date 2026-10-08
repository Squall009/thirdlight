/**
 * Rule scatter — models placed by rules over terrain and block layers alike
 * (trees, rocks: anything with collision or identity), baked into stored
 * copies per terrain tile or block chunk.
 *
 * A scatter rule names a model, a density and the conditions where it
 * grows: the conditions material rules have (height, slope, cavity, noise,
 * block types and cell metadata, `surface-rules.ts`), the share of material
 * layers the ground shows, a spacing between copies and named regions kept
 * clear. The surface is asked the same way on both sources
 * ({@link ScatterSurface}: a world point's ground, slope, normal and layer
 * shares), so one rule dresses a block area and the terrain around it alike.
 *
 * Where copies may go is a world grid of `1 / density` m² cells, one
 * candidate per cell jittered by a hash of the rule and the cell (the
 * instance brush's grid). A candidate is kept where its ground meets the
 * conditions with a probability equal to how well it meets them, and where
 * no kept candidate within the spacing has a higher priority (a hash too).
 * Every decision reads only the candidate's surroundings, so baking a
 * rectangle again gives exactly the copies a whole bake gives there: an edit
 * bakes again only around what it changed.
 *
 * Hand edits are kept apart from the rules, as hand paint is kept apart
 * from material rules: a brush stroke adds the rule's candidate cells under
 * it to the cell's `added` list (copies there whatever the conditions) or
 * moves them to `erased` (no copy there whatever the conditions). A bake
 * reads both, so the hand's work survives every bake and its copies follow
 * the ground when it is sculpted.
 *
 * Copies are stored in the source's frame (world less the object's
 * position), 10 floats each — position, rotation quaternion, scale — the
 * instance buffers' layout, and drawn as instance sets.
 *
 * Pure and deterministic: hashes are integer arithmetic; baking runs where
 * the project is edited (the backend), never per frame.
 */
import type { ModelErrorV2 } from './errors';
import { brushHash, copyRotation } from './instance-brush';
import { INSTANCE_DENSITY_SIZE_MIN, MAX_INSTANCE_CHUNK_SIZE } from './model-lod';
import { canonicalRuleRange, ruleConditionsAt, ruleRangeAt, validateRuleConditions, validateRuleRange, SURFACE_RULE_BLOCK_LAYERS, SURFACE_RULE_CAVITY_RADIUS, SURFACE_RULE_LAYER_MAX, type RuleConditions, type RuleRange, type SurfacePoint } from './surface-rules';
import { ID_RE } from './validate';
import { decodeBase64, encodeBase64 } from './png-decode';

/** A layer-share condition: the share (0-1) the ground shows of material `layer`. */
export interface ScatterLayerCondition extends RuleRange {
  layer: number;
}

export interface ScatterRule extends RuleConditions {
  /** Names the rule: its copies, hand edits and stored entries (1-32 of A-Z a-z 0-9 _ -). Part of its jitter, so two rules never share candidates. */
  id: string;
  /** The model placed (a model asset, one piece of it optionally). */
  asset: { assetId: string; piece?: string };
  /** Candidates per m² (each kept where the conditions hold fully). */
  density: number;
  /** No two of the rule's copies closer than this across the ground (m; absent: 0). */
  spacing?: number;
  /** Random uniform scale between these (absent: [1, 1]). */
  scale?: [number, number];
  /** Random turn about up, 0 to this many degrees (absent: 360). */
  yaw?: number;
  /** How far each copy leans to the ground's normal: 0 upright, 1 along it (absent: 0). */
  align?: number;
  /** Metres each copy is lowered into the ground (absent: 0). */
  sink?: number;
  /** Picks the jitter, scale and turn with the id (absent: 0). */
  seed?: number;
  /** Every listed layer's share must hold (absent: any ground). */
  layers?: ScatterLayerCondition[];
  /** Named block-layer regions kept clear (their columns, across the ground). */
  exclude?: string[];
  /** Drawing, as an instance set's: the copies cast the key light's shadow (absent: false — the foliage policy's default). */
  castShadow?: boolean;
  /**
   * With `castShadow`: only copies within this many metres of the camera
   * cast, into the moving shadow map (absent: every copy casts, into the
   * cached static map).
   */
  shadowDistance?: number;
  /** A soft dark disc of this radius (m, at the copy's scale) on the ground under each copy, near the camera: a contact shadow without a shadow map (absent: none). */
  blobShadow?: number;
  /** Drawing: the chunk size (m) the copies are culled and given levels of detail by (absent: {@link SCATTER_CHUNK_METERS_DEFAULT}). */
  chunkSize?: number;
  /** Drawing: the density falloff by screen size (as an instance set's; absent: none). */
  densityStart?: number;
  densityEnd?: number;
  densityMin?: number;
  /** Drawing: each copy picks its own level of detail (absent: true for scatter, whose chunks are large). */
  lodPerCopy?: boolean;
  /**
   * Drawing: a copy smaller on screen than this (the share of the view's
   * height its model covers, as the model's own levels switch: a larger copy
   * switches that much farther) is an octahedral impostor — one quad showing
   * the model from the side it is seen from, baked from the model once per
   * page — instead of its meshes (absent: its meshes all the way).
   */
  impostorSize?: number;
  /** Each copy carries the colliders of its model's `_COL` (absent: false; not with `cover`). */
  collide?: boolean;
  /**
   * Ground cover (grass, pebbles, small flowers): never stored — made near
   * the camera while the game runs, from the same rule and ground, thinning
   * out to nothing at `coverDistance` (absent: false, stored copies).
   */
  cover?: boolean;
  /** Ground cover: metres from the camera it reaches (absent: {@link SCATTER_COVER_DISTANCE_DEFAULT}). */
  coverDistance?: number;
}

/** The rule fields in canonical order. */
export const SCATTER_RULE_FIELDS: readonly string[] = Object.freeze([
  'id', 'asset', 'density', 'spacing', 'scale', 'yaw', 'align', 'sink', 'seed',
  'height', 'slope', 'cavity', 'noise', 'layers', 'blocks', 'meta', 'exclude',
  'castShadow', 'shadowDistance', 'blobShadow', 'chunkSize', 'densityStart', 'densityEnd', 'densityMin', 'lodPerCopy', 'impostorSize', 'collide', 'cover', 'coverDistance',
]);

/** Bounds of a rule's values (dimensions of a value, not counts). */
export const SCATTER_LIMITS = Object.freeze({
  idLength: 32,
  density: Object.freeze({ min: 0.0001, max: 100 }),
  spacingMax: 100,
  scale: Object.freeze({ min: 0.01, max: 100 }),
  sinkMax: 100,
  regionName: 64,
  coverDistance: Object.freeze({ min: 1, max: 1000 }),
  shadowDistance: Object.freeze({ min: 1, max: 10_000 }),
  blobShadow: Object.freeze({ min: 0.05, max: 100 }),
  /** A screen size, as the density falloff's. */
  impostorSize: Object.freeze({ min: INSTANCE_DENSITY_SIZE_MIN, max: 1 }),
});

/** How far (m) from the camera blob shadows are drawn (thinning out over the last part). */
export const SCATTER_BLOB_DISTANCE = 60;

/**
 * The foliage policy's near ring (m): how close to the camera scatter that
 * casts should cast (`shadowDistance`) and foliage should sway (a foliage
 * material's `windDistance`) — what the editor writes when either is turned
 * on (absent in data: the earlier behaviour, everywhere).
 */
export const FOLIAGE_NEAR_METRES = 40;

/** How far (m) ground cover reaches from the camera when its rule says nothing. */
export const SCATTER_COVER_DISTANCE_DEFAULT = 40;

/** The rules whose copies are stored (baked into tiles and chunks). */
export function storedScatterRules(rules: readonly ScatterRule[] | undefined): ScatterRule[] {
  return (rules ?? []).filter((r) => r.cover !== true);
}

/** The ground cover rules (made near the camera at run time, never stored). */
export function coverScatterRules(rules: readonly ScatterRule[] | undefined): ScatterRule[] {
  return (rules ?? []).filter((r) => r.cover === true);
}

/** The chunk size (m) a scatter rule's copies are drawn in when it sets none: few draws, culled inside each (view-cull). */
export const SCATTER_CHUNK_METERS_DEFAULT = 2048;

/**
 * Candidates one command may look at (a per-request bound like the brushes'
 * dabs: a bake of a large area at a high density is split by area or
 * belongs in ground cover, which is never stored).
 */
export const SCATTER_BAKE_MAX_CANDIDATES = 33_554_432;

/** Floats per stored copy (the instance buffers' layout). */
export const SCATTER_COPY_FLOATS = 10;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

/** Validate a scatter rule list; `blocks`: a block layer's (layers 0-3, block conditions allowed). */
export function validateScatterRules(value: unknown, path: string, errors: ModelErrorV2[], blocks: boolean): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_type', path, 'scatter is a list of rules {id, asset: {assetId, piece?}, density, …conditions}', value);
    return;
  }
  const L = SCATTER_LIMITS;
  const layerMax = blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : SURFACE_RULE_LAYER_MAX;
  const ids = new Set<string>();
  value.forEach((r, i) => {
    const p = `${path}/${i}`;
    if (!isObj(r)) return err(errors, 'field_type', p, 'a scatter rule is an object {id, asset, density, …}', r);
    for (const k of Object.keys(r)) if (!SCATTER_RULE_FIELDS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown scatter rule field "${k}"`, k);
    const id = r['id'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) err(errors, 'field_value', `${p}/id`, `id is 1-${L.idLength} of A-Z a-z 0-9 _ -`, id);
    else if (ids.has(id)) err(errors, 'field_value', `${p}/id`, `scatter rule "${id}" is listed twice`, id);
    else ids.add(id);
    const asset = r['asset'];
    if (!isObj(asset) || typeof asset['assetId'] !== 'string' || !ID_RE.test(asset['assetId'])) err(errors, 'field_value', `${p}/asset`, 'asset is {assetId, piece?}: the model placed', asset);
    else {
      for (const k of Object.keys(asset)) if (k !== 'assetId' && k !== 'piece') err(errors, 'field_unexpected', `${p}/asset/${k}`, `unknown asset field "${k}"`, k);
      const piece = asset['piece'];
      if (piece !== undefined && !(typeof piece === 'string' && piece.length >= 1 && piece.length <= 128)) err(errors, 'field_value', `${p}/asset/piece`, 'piece is a model piece name (1-128 characters)', piece);
    }
    const d = r['density'];
    if (!(finite(d) && d >= L.density.min && d <= L.density.max)) err(errors, 'field_value', `${p}/density`, `density is ${L.density.min}-${L.density.max} candidates per m²`, d);
    const num = (k: string, lo: number, hi: number, what: string): void => {
      const v = r[k];
      if (v !== undefined && !(finite(v) && v >= lo && v <= hi)) err(errors, 'field_value', `${p}/${k}`, `${k} is ${lo}-${hi} (${what})`, v);
    };
    num('spacing', 0, L.spacingMax, 'metres between copies');
    num('yaw', 0, 360, 'degrees of random turn');
    num('align', 0, 1, '0 upright, 1 along the normal');
    num('sink', -L.sinkMax, L.sinkMax, 'metres into the ground');
    num('chunkSize', 1, MAX_INSTANCE_CHUNK_SIZE, 'metres');
    num('densityStart', INSTANCE_DENSITY_SIZE_MIN, 1, 'a screen size');
    num('densityEnd', INSTANCE_DENSITY_SIZE_MIN, 1, 'a screen size');
    num('densityMin', 0, 1, 'the share drawn where copies are smallest');
    num('coverDistance', L.coverDistance.min, L.coverDistance.max, 'metres ground cover reaches from the camera');
    num('shadowDistance', L.shadowDistance.min, L.shadowDistance.max, 'metres from the camera the copies cast within');
    num('blobShadow', L.blobShadow.min, L.blobShadow.max, 'metres of the disc under each copy');
    num('impostorSize', L.impostorSize.min, L.impostorSize.max, 'the screen size below which a copy is an impostor');
    if (r['impostorSize'] !== undefined && r['cover'] === true) err(errors, 'field_unexpected', `${p}/impostorSize`, 'ground cover never draws far enough for impostors (it thins out near the camera)', r['impostorSize']);
    if (r['shadowDistance'] !== undefined && r['castShadow'] !== true) err(errors, 'field_unexpected', `${p}/shadowDistance`, 'shadowDistance belongs to a rule whose copies cast (castShadow: true)', r['shadowDistance']);
    if (r['cover'] === true && r['collide'] === true) err(errors, 'field_value', `${p}/collide`, 'ground cover carries no colliders (it is made near the camera, never stored)', true);
    if (r['coverDistance'] !== undefined && r['cover'] !== true) err(errors, 'field_unexpected', `${p}/coverDistance`, 'coverDistance belongs to a ground cover rule (cover: true)', r['coverDistance']);
    const sc = r['scale'];
    if (sc !== undefined && !(Array.isArray(sc) && sc.length === 2 && sc.every((v) => finite(v) && v >= L.scale.min && v <= L.scale.max) && (sc[0] as number) <= (sc[1] as number))) {
      err(errors, 'field_value', `${p}/scale`, `scale is [min, max] with ${L.scale.min} ≤ min ≤ max ≤ ${L.scale.max}`, sc);
    }
    if (r['seed'] !== undefined && !Number.isSafeInteger(r['seed'])) err(errors, 'field_value', `${p}/seed`, 'seed is a whole number', r['seed']);
    for (const k of ['castShadow', 'lodPerCopy', 'collide', 'cover']) if (r[k] !== undefined && typeof r[k] !== 'boolean') err(errors, 'field_type', `${p}/${k}`, `${k} is true or false`, r[k]);
    validateRuleConditions(r, p, errors, blocks);
    const layers = r['layers'];
    if (layers !== undefined) {
      if (!Array.isArray(layers)) err(errors, 'field_type', `${p}/layers`, 'layers is a list of {layer, min?, max?, fade?} (shares 0-1)', layers);
      else
        layers.forEach((c, k) => {
          const q = `${p}/layers/${k}`;
          if (!isObj(c)) return err(errors, 'field_type', q, 'a layer condition is {layer, min?, max?, fade?}', c);
          validateRuleRange(layers as unknown as Record<string, unknown>, String(k), `${p}/layers`, errors, (v, w) => {
            if (!(Number.isInteger(v['layer']) && (v['layer'] as number) >= 0 && (v['layer'] as number) <= layerMax)) err(errors, 'field_value', `${w}/layer`, `layer is 0-${layerMax}`, v['layer']);
          }, ['layer']);
        });
    }
    const ex = r['exclude'];
    if (ex !== undefined && !(Array.isArray(ex) && ex.every((n) => typeof n === 'string' && n.length >= 1 && n.length <= L.regionName))) err(errors, 'field_value', `${p}/exclude`, 'exclude is a list of block-layer region names', ex);
  });
}

/** Rules in canonical form (fields in order, defaults left out). */
export function canonicalScatterRules(rules: readonly ScatterRule[]): ScatterRule[] {
  return rules.map((r) => {
    const out: ScatterRule = { id: r.id, asset: { assetId: r.asset.assetId, ...(r.asset.piece !== undefined ? { piece: r.asset.piece } : {}) }, density: r.density };
    if (r.spacing !== undefined && r.spacing > 0) out.spacing = r.spacing;
    if (r.scale !== undefined && !(r.scale[0] === 1 && r.scale[1] === 1)) out.scale = [r.scale[0], r.scale[1]];
    if (r.yaw !== undefined && r.yaw !== 360) out.yaw = r.yaw;
    if (r.align !== undefined && r.align !== 0) out.align = r.align;
    if (r.sink !== undefined && r.sink !== 0) out.sink = r.sink;
    if (r.seed !== undefined && r.seed !== 0) out.seed = r.seed;
    const height = canonicalRuleRange(r.height);
    if (height !== undefined) out.height = height;
    const slope = canonicalRuleRange(r.slope);
    if (slope !== undefined) out.slope = slope;
    const cavity = canonicalRuleRange(r.cavity, ['radius']);
    if (cavity !== undefined) out.cavity = cavity;
    const noise = canonicalRuleRange(r.noise, ['scale', 'seed']);
    if (noise !== undefined) out.noise = noise;
    if (r.layers !== undefined && r.layers.length > 0) out.layers = r.layers.map((c) => ({ layer: c.layer, ...canonicalRuleRange(c) }));
    if (r.blocks !== undefined) out.blocks = [...r.blocks];
    if (r.meta !== undefined) out.meta = { ...r.meta };
    if (r.exclude !== undefined && r.exclude.length > 0) out.exclude = [...r.exclude];
    if (r.castShadow === true) out.castShadow = true;
    if (r.shadowDistance !== undefined) out.shadowDistance = r.shadowDistance;
    if (r.blobShadow !== undefined) out.blobShadow = r.blobShadow;
    if (r.chunkSize !== undefined) out.chunkSize = r.chunkSize;
    if (r.densityStart !== undefined) out.densityStart = r.densityStart;
    if (r.densityEnd !== undefined) out.densityEnd = r.densityEnd;
    if (r.densityMin !== undefined) out.densityMin = r.densityMin;
    if (r.lodPerCopy !== undefined) out.lodPerCopy = r.lodPerCopy;
    if (r.impostorSize !== undefined) out.impostorSize = r.impostorSize;
    if (r.collide === true) out.collide = true;
    if (r.cover === true) out.cover = true;
    if (r.coverDistance !== undefined) out.coverDistance = r.coverDistance;
    return out;
  });
}

/** The model assets a rule list places. */
export function scatterRuleAssets(rules: readonly ScatterRule[] | undefined): string[] {
  return [...new Set((rules ?? []).map((r) => r.asset.assetId))];
}

// ---- the surface ------------------------------------------------------------------------

/** The ground at a point as scatter rules read it (world metres; the object may be reused by the surface's next answer). */
export interface ScatterGround extends SurfacePoint {
  /** The ground's unit normal. */
  nx: number;
  ny: number;
  nz: number;
  /** The share (0-1) the ground shows of material layer `layer`. */
  layer(layer: number): number;
}

/** What scatter reads of a terrain or a block layer. */
export interface ScatterSurface {
  /** The (highest) ground at world point (x, z), or null where there is none. */
  at(x: number, z: number): ScatterGround | null;
  /** Whether world point (x, z) lies in one of the named regions (absent: no regions). */
  excluded?(x: number, z: number, names: readonly string[]): boolean;
}

/** A world XZ rectangle [x0, z0, x1, z1]: a point is inside when x0 ≤ x < x1 and z0 ≤ z < z1. */
export type ScatterRect = [number, number, number, number];

/** Metres around a changed point whose copies a bake may decide differently: the farthest a rule reads (spacing, cavity). */
export function scatterReach(rules: readonly ScatterRule[]): number {
  let reach = 0;
  for (const r of rules) reach = Math.max(reach, (r.spacing ?? 0) + (r.cavity !== undefined ? (r.cavity.radius ?? SURFACE_RULE_CAVITY_RADIUS) : 0));
  return reach;
}

// ---- stored copies ------------------------------------------------------------------------

/** One rule's copies in one tile or chunk, and its hand edits there. */
export interface ScatterCopies {
  /** The copies (10 floats each, the source's frame), by candidate cell (z, then x). */
  copies: Float32Array;
  /** Each copy's candidate cell (ix, iz): its address, the same through every bake that keeps it. */
  cells: Int32Array;
  /** Candidate cells the hand added (a copy there whatever the conditions), sorted. */
  added: Int32Array;
  /** Candidate cells the hand erased (no copy there whatever the conditions), sorted. */
  erased: Int32Array;
}

/** A tile's or chunk's scatter: each rule's copies by rule id. */
export type ScatterCell = Map<string, ScatterCopies>;

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F32 = new Float32Array(0);

/** The candidate grid of a rule: cell size (m) and the seed its hashes use. */
function gridOf(rule: ScatterRule): { size: number; seed: number } {
  // The id is part of the seed: two rules of one density never share their candidates.
  let h = rule.seed ?? 0;
  for (let i = 0; i < rule.id.length; i++) h = Math.imul(h ^ rule.id.charCodeAt(i), 0x01000193);
  return { size: 1 / Math.sqrt(rule.density), seed: h | 0 };
}

const cellKey = (ix: number, iz: number): string => `${ix},${iz}`;

/** Sorted (z, then x) pairs of a key set. */
function pairsOf(keys: Iterable<string>): Int32Array {
  const list = [...keys].map((k) => k.split(',').map(Number) as [number, number]);
  list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = new Int32Array(list.length * 2);
  list.forEach(([x, z], i) => {
    out[i * 2] = x;
    out[i * 2 + 1] = z;
  });
  return out;
}

function keysOf(pairs: Int32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < pairs.length; i += 2) out.add(cellKey(pairs[i]!, pairs[i + 1]!));
  return out;
}

const inside = (r: ScatterRect, x: number, z: number): boolean => x >= r[0] && x < r[2] && z >= r[1] && z < r[3];

/**
 * One rule's decisions over a bake: each candidate's ground and whether the
 * conditions keep it, computed once (a candidate is asked again by every
 * neighbour within the spacing).
 */
class RulePlacer {
  readonly size: number;
  private readonly seed: number;
  private readonly spacing: number;
  private readonly reachCells: number;
  private readonly blocks: ReadonlySet<string> | null;
  private readonly decided = new Map<string, number>();
  /** Candidates looked at so far (the per-request bound). */
  looked = 0;

  constructor(
    readonly rule: ScatterRule,
    private readonly surface: ScatterSurface,
    private readonly added: ReadonlySet<string>,
    private readonly erased: ReadonlySet<string>,
  ) {
    const g = gridOf(rule);
    this.size = g.size;
    this.seed = g.seed;
    this.spacing = rule.spacing ?? 0;
    this.reachCells = Math.ceil(this.spacing / this.size);
    this.blocks = rule.blocks !== undefined ? new Set(rule.blocks) : null;
  }

  /** The candidate's point across the ground. */
  point(ix: number, iz: number): [number, number] {
    return [(ix + brushHash(this.seed, ix, iz, 0)) * this.size, (iz + brushHash(this.seed, ix, iz, 1)) * this.size];
  }

  /** 1: the hand put a copy here; 0.5: the conditions keep it; 0: no copy (before spacing). */
  private wanted(ix: number, iz: number): number {
    const key = cellKey(ix, iz);
    const known = this.decided.get(key);
    if (known !== undefined) return known;
    this.looked += 1;
    let out = 0;
    if (!this.erased.has(key)) {
      const [x, z] = this.point(ix, iz);
      const g = this.surface.at(x, z);
      if (g !== null && g.ny > MIN_NORMAL_Y) {
        if (this.added.has(key)) out = 1;
        else if (this.rule.exclude === undefined || this.surface.excluded?.(x, z, this.rule.exclude) !== true) {
          let f = ruleConditionsAt(this.rule, g, this.blocks, (r) => g.cavity(r));
          for (const c of this.rule.layers ?? []) if (f > 0) f *= ruleRangeAt(c, g.layer(c.layer));
          if (f > 0 && brushHash(this.seed, ix, iz, 4) < f) out = 0.5;
        }
      }
    }
    this.decided.set(key, out);
    return out;
  }

  /** Whether the candidate gets a copy: wanted, and (unless the hand added it) no wanted neighbour within the spacing ranks higher. */
  keeps(ix: number, iz: number): boolean {
    const w = this.wanted(ix, iz);
    if (w === 0) return false;
    if (w === 1 || this.spacing <= 0) return true;
    const [x, z] = this.point(ix, iz);
    const mine = brushHash(this.seed, ix, iz, 5);
    const k = this.reachCells;
    const gap = this.spacing * this.spacing;
    for (let dz = -k; dz <= k; dz++) {
      for (let dx = -k; dx <= k; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = ix + dx;
        const nz = iz + dz;
        const [px, pz] = this.point(nx, nz);
        if ((px - x) ** 2 + (pz - z) ** 2 >= gap) continue;
        const theirs = this.wanted(nx, nz);
        if (theirs === 0) continue;
        if (theirs === 1) return false;
        const p = brushHash(this.seed, nx, nz, 5);
        if (p > mine || (p === mine && (nz < iz || (nz === iz && nx < ix)))) return false;
      }
    }
    return true;
  }

  /** The copy at a kept candidate (10 floats in the source's frame), or null when its ground is gone. */
  copy(ix: number, iz: number, origin: readonly number[], out: number[]): boolean {
    const [x, z] = this.point(ix, iz);
    const g = this.surface.at(x, z);
    if (g === null) return false;
    const r = this.rule;
    const sc = r.scale ?? [1, 1];
    const s = sc[0] + brushHash(this.seed, ix, iz, 2) * (sc[1] - sc[0]);
    const q = copyRotation(g.nx, g.ny, g.nz, r.align ?? 0, brushHash(this.seed, ix, iz, 3) * (r.yaw ?? 360));
    out.push(x - origin[0]!, g.y - (r.sink ?? 0) - origin[1]!, z - origin[2]!, q[0], q[1], q[2], q[3], s, s, s);
    return true;
  }
}

/** A surface steeper than this (normal Y) takes no copy (a wall). */
const MIN_NORMAL_Y = 0.05;

/** The candidate cells of a grid whose points may fall in `r` (cells overlapping it). */
function cellRange(size: number, r: ScatterRect): [number, number, number, number] {
  return [Math.floor(r[0] / size), Math.floor(r[1] / size), Math.floor(r[2] / size), Math.floor(r[3] / size)];
}

export interface ScatterBakeResult {
  cell: ScatterCell;
  /** Candidates looked at (the per-request bound counts them). */
  looked: number;
}

/**
 * Bake the stored rules over the tile or chunk whose world XZ box is
 * `bounds`: within `rect` (null: all of it) its copies are made again from
 * the rules, the ground and its hand edits; outside it they stay as `prev`
 * holds them. `origin` is the source object's position. Rules no longer
 * listed lose their entries (hand edits included).
 */
export function bakeScatterCell(rules: readonly ScatterRule[], surface: ScatterSurface, prev: ScatterCell | null, bounds: ScatterRect, rect: ScatterRect | null, origin: readonly number[]): ScatterBakeResult {
  const cell: ScatterCell = new Map();
  let looked = 0;
  const area: ScatterRect | null = rect === null ? bounds : [Math.max(bounds[0], rect[0]), Math.max(bounds[1], rect[1]), Math.min(bounds[2], rect[2]), Math.min(bounds[3], rect[3])];
  const empty = area[0] >= area[2] || area[1] >= area[3];
  for (const rule of rules) {
    const before = prev?.get(rule.id);
    const added = before !== undefined ? keysOf(before.added) : new Set<string>();
    const erased = before !== undefined ? keysOf(before.erased) : new Set<string>();
    const placer = new RulePlacer(rule, surface, added, erased);
    // Kept from before: the copies whose candidate lies outside the area baked.
    const rows: { iz: number; ix: number; at: number; from: Float32Array | null }[] = [];
    const made: number[] = [];
    if (before !== undefined) {
      for (let i = 0; i < before.cells.length / 2; i++) {
        const ix = before.cells[i * 2]!;
        const iz = before.cells[i * 2 + 1]!;
        if (!empty && rect !== null) {
          const [x, z] = placer.point(ix, iz);
          if (inside(area, x, z)) continue;
        } else if (rect === null) continue;
        rows.push({ iz, ix, at: i * SCATTER_COPY_FLOATS, from: before.copies });
      }
    }
    if (!empty) {
      const [x0, z0, x1, z1] = cellRange(placer.size, area);
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const [x, z] = placer.point(ix, iz);
          if (!inside(area, x, z) || !placer.keeps(ix, iz)) continue;
          const at = made.length;
          if (placer.copy(ix, iz, origin, made)) rows.push({ iz, ix, at, from: null });
        }
      }
    }
    looked += placer.looked;
    rows.sort((a, b) => a.iz - b.iz || a.ix - b.ix);
    const copies = new Float32Array(rows.length * SCATTER_COPY_FLOATS);
    const cells = new Int32Array(rows.length * 2);
    const fresh = Float32Array.from(made);
    rows.forEach((r, i) => {
      copies.set((r.from ?? fresh).subarray(r.at, r.at + SCATTER_COPY_FLOATS), i * SCATTER_COPY_FLOATS);
      cells[i * 2] = r.ix;
      cells[i * 2 + 1] = r.iz;
    });
    const out: ScatterCopies = { copies, cells, added: before?.added ?? EMPTY_I32, erased: before?.erased ?? EMPTY_I32 };
    if (out.cells.length > 0 || out.added.length > 0 || out.erased.length > 0) cell.set(rule.id, out);
  }
  return { cell, looked };
}

/** One brush stroke on one rule's copies: `paint` puts copies on the candidates under it, `erase` takes them off. */
export interface ScatterStroke {
  rule: string;
  mode: 'paint' | 'erase';
  /** World points (x, z) the stroke touched. */
  dabs: [number, number][];
  /** Metres. */
  radius: number;
}

/**
 * The hand edits a stroke makes to a tile's or chunk's entry of its rule
 * (`bounds`: its world XZ box): the rule's candidate cells under the dabs
 * whose point lies in the box are added (paint) or erased; the copies follow
 * with the next bake over the stroke's rectangle ({@link scatterStrokeRect}).
 * Returns the entry's new hand lists, or null when the stroke changes none.
 */
export function strokeScatterEdits(prev: ScatterCopies | undefined, rule: ScatterRule, stroke: ScatterStroke, bounds: ScatterRect): { added: Int32Array; erased: Int32Array } | null {
  const added = prev !== undefined ? keysOf(prev.added) : new Set<string>();
  const erased = prev !== undefined ? keysOf(prev.erased) : new Set<string>();
  const placer = new RulePlacer(rule, { at: () => null }, added, erased);
  const r = stroke.radius;
  let changed = false;
  for (const [dx, dz] of stroke.dabs) {
    const [x0, z0, x1, z1] = cellRange(placer.size, [dx - r, dz - r, dx + r, dz + r]);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const [x, z] = placer.point(ix, iz);
        if ((x - dx) ** 2 + (z - dz) ** 2 > r * r || !inside(bounds, x, z)) continue;
        const key = cellKey(ix, iz);
        if (stroke.mode === 'paint') {
          if (erased.delete(key)) changed = true;
          if (!added.has(key)) {
            added.add(key);
            changed = true;
          }
        } else {
          if (added.delete(key)) changed = true;
          if (!erased.has(key)) {
            erased.add(key);
            changed = true;
          }
        }
      }
    }
  }
  return changed ? { added: pairsOf(added), erased: pairsOf(erased) } : null;
}

/** The world rectangle a stroke's bake covers: its dabs' reach grown by the rule's spacing. */
export function scatterStrokeRect(stroke: ScatterStroke, reach: number): ScatterRect {
  let r: ScatterRect = [Infinity, Infinity, -Infinity, -Infinity];
  const g = stroke.radius + reach;
  for (const [x, z] of stroke.dabs) r = [Math.min(r[0], x - g), Math.min(r[1], z - g), Math.max(r[2], x + g), Math.max(r[3], z + g)];
  return r;
}

/** A copy of a cell with one rule's hand lists replaced (entries without copies or edits are dropped). */
export function withScatterEdits(cell: ScatterCell | null, rule: string, edits: { added: Int32Array; erased: Int32Array }): ScatterCell {
  const out: ScatterCell = new Map(cell ?? []);
  const before = out.get(rule);
  out.set(rule, { copies: before?.copies ?? EMPTY_F32, cells: before?.cells ?? EMPTY_I32, added: edits.added, erased: edits.erased });
  return out;
}

/** Whether two cells hold the same copies and edits. */
export function sameScatterCell(a: ScatterCell | null, b: ScatterCell | null): boolean {
  const ea = a === null || a.size === 0 ? null : encodeScatterCell(a);
  const eb = b === null || b.size === 0 ? null : encodeScatterCell(b);
  if (ea === null || eb === null) return ea === eb;
  return ea.length === eb.length && ea.every((v, i) => v === eb[i]);
}

/** Copies a cell holds over all its rules. */
export function scatterCellCopies(cell: ScatterCell | null): number {
  let n = 0;
  for (const c of cell?.values() ?? []) n += c.cells.length / 2;
  return n;
}

// ---- bytes --------------------------------------------------------------------------------

/** The payload layout this engine writes and reads. */
export const SCATTER_CELL_LAYOUT = 1;
/** The first bytes of a terrain tile's scatter blob ("TLSC", `binary-container.ts`'s header). */
export const SCATTER_BLOB_MAGIC = Object.freeze([0x54, 0x4c, 0x53, 0x43]);

/**
 * A cell as bytes: the layout, the rule count, then per rule (by id) its
 * id, the counts of copies, added and erased cells, the copies (float32),
 * their cells, the added and the erased cells (int32), little-endian.
 * Equal cells are equal bytes. Null: an empty cell (nothing to store).
 */
export function encodeScatterCell(cell: ScatterCell): Uint8Array | null {
  const ids = [...cell.keys()].filter((id) => {
    const c = cell.get(id)!;
    return c.cells.length > 0 || c.added.length > 0 || c.erased.length > 0;
  });
  ids.sort();
  if (ids.length === 0) return null;
  let size = 4;
  for (const id of ids) {
    const c = cell.get(id)!;
    size += 1 + id.length + 12 + c.copies.length * 4 + c.cells.length * 4 + c.added.length * 4 + c.erased.length * 4;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint8(0, SCATTER_CELL_LAYOUT);
  v.setUint16(2, ids.length, true);
  let o = 4;
  for (const id of ids) {
    const c = cell.get(id)!;
    out[o++] = id.length;
    for (let i = 0; i < id.length; i++) out[o++] = id.charCodeAt(i);
    v.setUint32(o, c.cells.length / 2, true);
    v.setUint32(o + 4, c.added.length / 2, true);
    v.setUint32(o + 8, c.erased.length / 2, true);
    o += 12;
    for (const f of c.copies) {
      v.setFloat32(o, f, true);
      o += 4;
    }
    for (const list of [c.cells, c.added, c.erased]) {
      for (const k of list) {
        v.setInt32(o, k, true);
        o += 4;
      }
    }
  }
  return out;
}

/** A cell back from its bytes (throws a short message when malformed). */
export function decodeScatterCell(bytes: Uint8Array): ScatterCell {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (o: number, n: number): void => {
    if (o + n > bytes.length) throw new Error('scatter binary: the data ends early');
  };
  need(0, 4);
  if (bytes[0] !== SCATTER_CELL_LAYOUT) throw new Error(`scatter binary: layout ${bytes[0]} is not one this engine reads (${SCATTER_CELL_LAYOUT})`);
  const rules = v.getUint16(2, true);
  const cell: ScatterCell = new Map();
  let o = 4;
  for (let r = 0; r < rules; r++) {
    need(o, 1);
    const len = bytes[o++]!;
    need(o, len + 12);
    let id = '';
    for (let i = 0; i < len; i++) id += String.fromCharCode(bytes[o++]!);
    if (!ID_PATTERN.test(id)) throw new Error('scatter binary: a rule id is malformed');
    const n = v.getUint32(o, true);
    const a = v.getUint32(o + 4, true);
    const e = v.getUint32(o + 8, true);
    o += 12;
    need(o, n * SCATTER_COPY_FLOATS * 4 + (n + a + e) * 8);
    const copies = new Float32Array(n * SCATTER_COPY_FLOATS);
    for (let i = 0; i < copies.length; i++, o += 4) copies[i] = v.getFloat32(o, true);
    const ints = (count: number): Int32Array => {
      const out = new Int32Array(count * 2);
      for (let i = 0; i < out.length; i++, o += 4) out[i] = v.getInt32(o, true);
      return out;
    };
    cell.set(id, { copies, cells: ints(n), added: ints(a), erased: ints(e) });
  }
  if (o !== bytes.length) throw new Error(`scatter binary: ${bytes.length - o} bytes past the rules it names`);
  return cell;
}

/** Bytes a decoded cell takes in memory. */
export function scatterCellBytes(cell: ScatterCell | null): number {
  let n = 0;
  for (const c of cell?.values() ?? []) n += c.copies.byteLength + c.cells.byteLength + c.added.byteLength + c.erased.byteLength;
  return n;
}

/** A block chunk's scatter as its stored text (base64 of the cell's bytes; absent: none). */
export function encodeChunkScatter(cell: ScatterCell | null): string | undefined {
  const bytes = cell === null ? null : encodeScatterCell(cell);
  return bytes === null ? undefined : encodeBase64(bytes);
}

/** A block chunk's stored scatter (null: none, or not readable — `chunkScatterError` says why). */
export function decodeChunkScatter(text: string | undefined): ScatterCell | null {
  if (text === undefined) return null;
  const bytes = decodeBase64(text);
  if (bytes === null) return null;
  try {
    return decodeScatterCell(bytes);
  } catch {
    return null;
  }
}

/** Why a chunk's `scatter` is not one (null: it is). */
export function chunkScatterError(v: unknown): string | null {
  if (typeof v !== 'string') return 'scatter is base64 of the chunk\'s scatter (each rule\'s copies and hand edits)';
  const bytes = decodeBase64(v);
  if (bytes === null) return 'scatter is base64 text';
  try {
    decodeScatterCell(bytes);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}
