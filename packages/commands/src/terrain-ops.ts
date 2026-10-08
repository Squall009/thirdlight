/**
 * `editTerrain`: one edit of a terrain's tiles — a sculpt stroke (raise,
 * lower, smooth, flatten, noise), a ramp, a paint stroke, a holes stroke, a
 * heightmap import or a block layer converted — as one command and one undo.
 *
 * The tiles are blobs, so this runs like an instance-brush stroke: the host
 * reads the tiles the edit reaches, plans it here (`planTerrainEdit`, pure:
 * the same brush cores the editor's preview runs), encodes and publishes the
 * tiles it changed (content-addressed: the old ones stay, so undo just
 * points back at them) and hands the new digests to the command
 * (`PreparedTerrainEdit`), which stores them as a `setComponent terrain`
 * change. The editor's strokes and MCP's are the same op.
 *
 * Points are world metres (x, z; ramp ends and flatten heights also y); the
 * terrain is placed by its object's position only.
 */
import {
  BRUSH_FALLOFFS,
  HEIGHTMAP_FORMATS,
  TERRAIN_BRUSH_LIMITS,
  TERRAIN_LAYER_MAX,
  TERRAIN_SCULPT_KINDS,
  TERRAIN_TILE_COORD_MAX,
  TerrainSamples,
  SurfaceRuleSet,
  bakeTerrainRules,
  blockLayerToTerrain,
  canonicalSurfaceRules,
  terrainBakeMargin,
  terrainBakeRect,
  validateSurfaceRules,
  flatTerrainTile,
  holeTerrain,
  importHeightmap,
  paintTerrain,
  rampTerrain,
  sculptTerrain,
  terrainDabSamples,
  terrainFlatStep,
  terrainTileKey,
  terrainTileSize,
  type BlockLayerComponent,
  type BrushFalloff,
  type Heightmap,
  type HeightmapFormat,
  type ModelErrorV2,
  type SurfaceRule,
  type TerrainComponent,
  type TerrainSculptKind,
  type TerrainTile,
  type TerrainTileRef,
  TerrainField,
  bakeTerrainScatter,
  canonicalScatterRules,
  regionExcluder,
  scatterReach,
  scatterStrokeRect,
  storedScatterRules,
  strokeScatterEdits,
  terrainChangedSamples,
  terrainScatterSurface,
  terrainTileRect,
  validateScatterRules,
  withScatterEdits,
  type ScatterCell,
  type ScatterRect,
  type ScatterRule,
  type ErosionSettings,
} from '@thirdlight/project-model';

import { blockTypesOf, layerDataOf } from './block-ops';
import { combinedTile, putCombined, terrainSplineContext, TerrainLayerUnread, type TerrainLayerReads, type TerrainSplineContext } from './terrain-spline-ops';
import { erodeArgsError } from './terrain-erosion-ops';
import { sceneRegionLayers, scatterBakeTooLarge, scatterRuleOf } from './scatter-ops';
import { applySetComponent, type OpInput } from './content-ops';
import { componentMissing, entityNotFound, fieldMissing, fieldUnexpected, fieldValue, noChangeContent, type CommandError } from './errors';
import type { OpOutcome } from './ops';
import type { ContentDocument, SceneDocument } from './types';

export type EditTerrainKind = TerrainSculptKind | 'ramp' | 'paint' | 'holes' | 'import' | 'fromBlocks' | 'bake' | 'scatter' | 'erode';
export const EDIT_TERRAIN_KINDS: readonly EditTerrainKind[] = [...TERRAIN_SCULPT_KINDS, 'ramp', 'paint', 'holes', 'import', 'fromBlocks', 'bake', 'scatter', 'erode'];

/** `editTerrain` args (which keys a kind takes: `EDIT_TERRAIN_KEYS`). */
export interface EditTerrainArgs {
  entityId: string;
  kind: EditTerrainKind;
  /** Brush kinds: the stroke's points (world x, z). */
  dabs?: [number, number][];
  /** Metres (a ramp: half its width). */
  radius?: number;
  /** raise, lower, noise: metres at the centre; the others: the blend at the centre (0–1]. */
  strength?: number;
  falloff?: BrushFalloff;
  /** flatten: the world height levelled to. */
  height?: number;
  /** noise: the size of its bumps (metres) and its seed. */
  scale?: number;
  seed?: number;
  /** ramp: its two ends (world x, y, z). */
  from?: [number, number, number];
  to?: [number, number, number];
  /** paint: the material layer painted (0–255). */
  layer?: number;
  /** paint: take hand paint back toward the baked layers; holes: fill holes back; scatter: take the rule's copies off. */
  erase?: boolean;
  /** scatter: the scatter rule whose copies the stroke puts on (or, with erase, takes off). */
  rule?: string;
  /** import: the staged file, its form, (raw16) its size and byte order, the tile it starts at, and the heights its 0 and 65535 stand for (metres above the terrain object; absent: the terrain's range). */
  stageId?: string;
  format?: HeightmapFormat;
  size?: [number, number];
  byteOrder?: 'little' | 'big';
  at?: [number, number];
  range?: [number, number];
  /** fromBlocks: the block layer object converted. */
  source?: string;
  /** bake: the material rules set and baked (absent: the terrain's own baked again — unless only `scatter` is given; empty: none, every sample layer 0 again). */
  rules?: SurfaceRule[];
  /** bake: the scatter rules set and baked (absent: the terrain's own baked again; empty: none, their copies and hand edits gone). */
  scatter?: ScatterRule[];
  /** erode: the erosion layer written (absent: "erosion"), the world box [x0, z0, x1, z1], the runs (and `seed`). */
  layerId?: string;
  rect?: [number, number, number, number];
  hydraulic?: ErosionSettings['hydraulic'];
  thermal?: ErosionSettings['thermal'];
}

const BRUSH_KEYS = ['dabs', 'radius', 'strength', 'falloff'];
/** The keys each kind takes (besides entityId and kind). */
export const EDIT_TERRAIN_KEYS: Readonly<Record<EditTerrainKind, readonly string[]>> = Object.freeze({
  raise: BRUSH_KEYS,
  lower: BRUSH_KEYS,
  smooth: BRUSH_KEYS,
  flatten: [...BRUSH_KEYS, 'height'],
  noise: [...BRUSH_KEYS, 'scale', 'seed'],
  ramp: ['from', 'to', 'radius', 'strength', 'falloff'],
  paint: [...BRUSH_KEYS, 'layer', 'erase'],
  holes: ['dabs', 'radius', 'erase'],
  import: ['stageId', 'format', 'size', 'byteOrder', 'at', 'range'],
  fromBlocks: ['source'],
  bake: ['rules', 'scatter'],
  scatter: ['dabs', 'radius', 'rule', 'erase'],
  erode: ['layerId', 'rect', 'hydraulic', 'thermal', 'seed'],
});

/** The host's result: the terrain's new value and what the edit did. */
export interface PreparedTerrainEdit {
  entityId: string;
  value: TerrainComponent;
  /** Tiles whose data changed and tiles the edit added ([x, z]). */
  touched: [number, number][];
  added: [number, number][];
  /** Samples (cells for holes) changed; heights clamped to the range by an import or conversion. */
  changed: number;
  clamped?: number;
  /** Tiles whose scatter changed ([x, z]). */
  scatter?: [number, number][];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

export function validateEditTerrainArgs(args: Record<string, unknown>): { ok: true; args: EditTerrainArgs } | { ok: false; error: CommandError } {
  const bad = (key: string, expected: string, message: string): { ok: false; error: CommandError } => ({ ok: false, error: fieldValue(`/args/${key}`, args[key], expected, message) });
  if (args['entityId'] === undefined) return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  if (typeof args['entityId'] !== 'string') return bad('entityId', 'an entity id', 'entityId names the terrain object');
  const kind = args['kind'] as EditTerrainKind;
  if (!EDIT_TERRAIN_KINDS.includes(kind)) return bad('kind', EDIT_TERRAIN_KINDS.join(', '), `kind is one of ${EDIT_TERRAIN_KINDS.join(', ')}`);
  const keys = EDIT_TERRAIN_KEYS[kind];
  for (const k of Object.keys(args)) if (k !== 'entityId' && k !== 'kind' && !keys.includes(k)) return { ok: false, error: fieldUnexpected(`/args/${k}`, k, ['entityId', 'kind', ...keys].join(', '), `${kind} takes ${keys.join(', ')}`) };
  const L = TERRAIN_BRUSH_LIMITS;
  const brushed = keys.includes('dabs');
  if (brushed) {
    const dabs = args['dabs'];
    if (!Array.isArray(dabs) || dabs.length < 1 || dabs.length > L.dabs || !dabs.every((d) => point(d, 2))) return bad('dabs', `1-${L.dabs} [x, z] world points`, 'dabs are the stroke\'s points, [x, z] in world metres');
  }
  if (keys.includes('radius')) {
    const r = args['radius'];
    if (!finite(r) || r <= 0 || r > L.radiusMax) return bad('radius', `metres in (0, ${L.radiusMax}]`, 'radius is the brush radius in metres');
  }
  if (keys.includes('strength')) {
    const s = args['strength'];
    const metres = kind === 'raise' || kind === 'lower' || kind === 'noise';
    if (!finite(s) || s <= 0 || s > (metres ? L.heightStrengthMax : 1)) return bad('strength', metres ? `metres in (0, ${L.heightStrengthMax}]` : '(0, 1]', metres ? 'strength is the metres a dab moves the ground at its centre' : 'strength is the blend a dab makes at its centre, in (0, 1]');
  }
  if (args['falloff'] !== undefined && !BRUSH_FALLOFFS.includes(args['falloff'] as BrushFalloff)) return bad('falloff', BRUSH_FALLOFFS.join(', '), `falloff is ${BRUSH_FALLOFFS.join(', ')}`);
  if (kind === 'flatten' && !finite(args['height'])) return bad('height', 'a world height (metres)', 'flatten levels to height (world metres)');
  if (args['scale'] !== undefined && (!finite(args['scale']) || (args['scale'] as number) <= 0 || (args['scale'] as number) > L.noiseScaleMax)) return bad('scale', `metres in (0, ${L.noiseScaleMax}]`, 'scale is the size of the noise\'s bumps in metres');
  if (args['seed'] !== undefined && !Number.isSafeInteger(args['seed'])) return bad('seed', 'a whole number', 'seed is a whole number');
  if (kind === 'ramp') {
    for (const k of ['from', 'to'] as const) if (!point(args[k], 3)) return bad(k, '[x, y, z] world metres', `${k} is a ramp end, [x, y, z] in world metres`);
  }
  if (kind === 'paint' && !(Number.isInteger(args['layer']) && (args['layer'] as number) >= 0 && (args['layer'] as number) <= TERRAIN_LAYER_MAX)) return bad('layer', `0-${TERRAIN_LAYER_MAX}`, 'layer is the material layer painted');
  if (args['erase'] !== undefined && typeof args['erase'] !== 'boolean') return bad('erase', 'true or false', 'erase is true or false');
  if (kind === 'import') {
    if (typeof args['stageId'] !== 'string') return bad('stageId', 'the stage of an uploaded heightmap', 'import reads an uploaded file: stageId names its stage');
    if (!HEIGHTMAP_FORMATS.includes(args['format'] as HeightmapFormat)) return bad('format', HEIGHTMAP_FORMATS.join(', '), 'format is png16 (a 16-bit greyscale PNG) or raw16 (16-bit samples, no header)');
    if (args['size'] !== undefined && !(Array.isArray(args['size']) && args['size'].length === 2 && args['size'].every((v) => Number.isInteger(v) && v >= 2))) return bad('size', '[width, height] samples', 'size is the RAW heightmap\'s width and height in samples');
    if (args['size'] !== undefined && args['format'] !== 'raw16') return bad('size', 'only with raw16', 'a PNG names its own size');
    if (args['byteOrder'] !== undefined && args['byteOrder'] !== 'little' && args['byteOrder'] !== 'big') return bad('byteOrder', 'little, big', 'byteOrder is little or big');
    if (args['at'] !== undefined && !(Array.isArray(args['at']) && args['at'].length === 2 && args['at'].every((v) => Number.isInteger(v) && Math.abs(v as number) <= TERRAIN_TILE_COORD_MAX))) return bad('at', '[x, z] tile coordinates', 'at is the tile the heightmap\'s first sample lies on');
    if (args['range'] !== undefined && !(point(args['range'], 2) && (args['range'] as number[])[0]! < (args['range'] as number[])[1]!)) return bad('range', '[low, high] metres', 'range is the heights 0 and 65535 stand for (metres above the terrain object)');
  }
  if (kind === 'fromBlocks' && typeof args['source'] !== 'string') return bad('source', 'a block layer object id', 'source names the block layer converted');
  if (args['rules'] !== undefined) {
    const errors: ModelErrorV2[] = [];
    validateSurfaceRules(args['rules'], '/args/rules', errors, false);
    if (errors.length > 0) return { ok: false, error: fieldValue(errors[0]!.path, (errors[0] as { found?: unknown }).found, 'material rules', errors[0]!.message) };
  }
  if (args['scatter'] !== undefined) {
    const errors: ModelErrorV2[] = [];
    validateScatterRules(args['scatter'], '/args/scatter', errors, false);
    if (errors.length > 0) return { ok: false, error: fieldValue(errors[0]!.path, (errors[0] as { found?: unknown }).found, 'scatter rules', errors[0]!.message) };
  }
  if (kind === 'scatter' && typeof args['rule'] !== 'string') return bad('rule', 'a scatter rule id', 'rule names the scatter rule whose copies the stroke edits');
  if (kind === 'erode') {
    const e = erodeArgsError(args);
    if (e !== null) return { ok: false, error: e };
  }
  return { ok: true, args: args as unknown as EditTerrainArgs };
}

type SceneEntity = { id: string; components: Record<string, unknown> };

/** A tile's data as the host read it (decoded), or why not. */
export type TerrainTileRead = (digest: string) => { ok: true; tile: TerrainTile } | { ok: false; error: CommandError };
/** A tile's scatter as the host read it (decoded), or why not. */
export type TerrainScatterRead = (digest: string) => { ok: true; cell: ScatterCell } | { ok: false; error: CommandError };

/** The edit planned: the tiles it changed or added (data), the component's tiles before, and the counts. */
export interface TerrainEditPlan {
  entityId: string;
  component: TerrainComponent;
  /** Every tile the edit wrote, by "x,z" (its new data). */
  tiles: Map<string, TerrainTile>;
  /** A bake's rules for the component (an empty list: none). */
  rules?: SurfaceRule[];
  /** Every tile whose scatter the edit changed, by "x,z" (null: none left). */
  scatter: Map<string, ScatterCell | null>;
  /** Every tile whose hand-made form beside its splines' changed, by "x,z" (null: no spline reaches it any more). */
  bases: Map<string, TerrainTile | null>;
  /** A bake's scatter rules for the component (an empty list: none). */
  scatterRules?: ScatterRule[];
  added: [number, number][];
  changed: number;
  clamped?: number;
}

function positionOf(e: SceneEntity): [number, number, number] {
  const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/**
 * Plan an edit (pure). `read` gives the data of a tile blob; `heightmap` is
 * the import's decoded file (the host reads and decodes the stage). An
 * error is a refusal; `no_change` when the edit changes nothing.
 */
export function planTerrainEdit(scene: SceneDocument, content: ContentDocument | undefined, args: EditTerrainArgs, read: TerrainTileRead, heightmap?: Heightmap, readScatter?: TerrainScatterRead, layers?: TerrainLayerReads): { ok: true; plan: TerrainEditPlan } | { ok: false; error: CommandError } {
  if (args.kind === 'erode') return { ok: false, error: fieldValue('/args', undefined, 'an erosion the host prepared', 'editTerrain erode runs through the project host (planErosion)') };
  try {
    return planEdit(scene, content, args, read, heightmap, readScatter, layers);
  } catch (e) {
    if (e instanceof TerrainLayerUnread) return { ok: false, error: e.error };
    throw e;
  }
}

function planEdit(scene: SceneDocument, content: ContentDocument | undefined, args: EditTerrainArgs, read: TerrainTileRead, heightmap: Heightmap | undefined, readScatter: TerrainScatterRead | undefined, layers: TerrainLayerReads | undefined): { ok: true; plan: TerrainEditPlan } | { ok: false; error: CommandError } {
  const entities = scene.entities as unknown as SceneEntity[];
  const entity = entities.find((e) => e.id === args.entityId);
  if (entity === undefined) return { ok: false, error: entityNotFound(args.entityId) };
  const comp = entity.components['terrain'] as TerrainComponent | undefined;
  if (comp === undefined) return { ok: false, error: componentMissing(args.entityId, 'terrain') };
  const origin = positionOf(entity);
  const size = terrainTileSize(comp);
  const sp = comp.spacing;
  const local = (x: number, z: number): [number, number] => [x - origin[0], z - origin[2]];
  // The local box (metres) the edit reads: tiles overlapping it are loaded.
  let box: [number, number, number, number] | null = null;
  const grow = (x0: number, z0: number, x1: number, z1: number): void => {
    box = box === null ? [x0, z0, x1, z1] : [Math.min(box[0], x0), Math.min(box[1], z0), Math.max(box[2], x1), Math.max(box[3], z1)];
  };
  const r = args.radius ?? 0;
  if (args.dabs !== undefined) for (const [x, z] of args.dabs) grow(...local(x - r - sp, z - r - sp), ...local(x + r + sp, z + r + sp));
  if (args.kind === 'ramp') {
    const [ax, , az] = args.from!;
    const [bx, , bz] = args.to!;
    grow(...local(Math.min(ax, bx) - r - sp, Math.min(az, bz) - r - sp), ...local(Math.max(ax, bx) + r + sp, Math.max(az, bz) + r + sp));
  }
  let sourceLayer: { component: BlockLayerComponent; origin: [number, number, number] } | null = null;
  if (args.kind === 'fromBlocks') {
    const src = entities.find((e) => e.id === args.source);
    if (src === undefined) return { ok: false, error: entityNotFound(args.source!) };
    const bl = src.components['blockLayer'] as BlockLayerComponent | undefined;
    if (bl === undefined) return { ok: false, error: componentMissing(args.source!, 'blockLayer') };
    sourceLayer = { component: bl, origin: positionOf(src) };
    const [cw] = bl.cellSize;
    const lo = sourceLayer.origin;
    grow(...local(lo[0] + bl.bounds.min[0]! * cw!, lo[2] + bl.bounds.min[2]! * cw!), ...local(lo[0] + bl.bounds.max[0]! * cw!, lo[2] + bl.bounds.max[2]! * cw!));
  }
  if (args.kind === 'import') {
    if (heightmap === undefined) return { ok: false, error: fieldValue('/args/stageId', args.stageId, 'a heightmap the host read', 'editTerrain import runs through the project host, which reads the uploaded file') };
    const at = args.at ?? [0, 0];
    grow(at[0] * size, at[1] * size, (at[0] + Math.max(1, Math.ceil((heightmap.width - 1) / (comp.tileSamples - 1)))) * size, (at[1] + Math.max(1, Math.ceil((heightmap.height - 1) / (comp.tileSamples - 1)))) * size);
  }
  // Material rules: a bake's, else the terrain's (baked again where the edit moves the ground; their reach is read too).
  // A bake naming only scatter rules leaves the material as it is.
  const bakesMaterial = args.kind === 'bake' && (args.rules !== undefined || args.scatter === undefined);
  const rules = bakesMaterial ? canonicalSurfaceRules(args.rules ?? comp.rules ?? []) : comp.rules;
  const ruleSet = args.kind === 'bake' && !bakesMaterial ? null : rules !== undefined && (rules.length > 0 || bakesMaterial) ? new SurfaceRuleSet(rules) : null;
  const margin = ruleSet !== null ? terrainBakeMargin(ruleSet, sp) : 0;
  // Scatter rules: a bake's, else the terrain's (baked again around what the edit changed: the reach read is twice theirs).
  // (The rules a bake stores; ground cover among them is made at run time, never baked.)
  const scatterRules = args.kind === 'bake' && args.scatter !== undefined ? canonicalScatterRules(args.scatter) : (comp.scatter ?? []);
  const storedRules = storedScatterRules(scatterRules);
  const scatterBakes = storedRules.length > 0 || (args.kind === 'bake' && args.scatter !== undefined);
  let strokeRule: ScatterRule | null = null;
  if (args.kind === 'scatter') {
    const found = scatterRuleOf(storedScatterRules(comp.scatter), args.rule);
    if (!found.ok) return found;
    strokeRule = found.rule;
  }
  const scatterMargin = scatterBakes ? 2 * (scatterReach(storedRules) + 2 * sp) : 0;
  const reached = box as [number, number, number, number] | null;
  if ((ruleSet !== null || scatterBakes) && reached !== null) {
    const [bx0, bz0, bx1, bz1] = reached;
    const g = (margin + 1) * sp + scatterMargin;
    box = [bx0 - g, bz0 - g, bx1 + g, bz1 + g];
  }
  // The splines and edit layers over the terrain: edits go to the hand-made tiles, the layers are applied over them again.
  const splines = terrainSplineContext(scene, comp, origin, layers);
  // The tiles under the box (with data: read; without: flat), and, beside splines, their hand-made forms.
  const loaded = new Map<string, TerrainTile>();
  const authored = new Map<string, TerrainTile>();
  const b = box as [number, number, number, number] | null;
  const flat = terrainFlatStep(comp.heightRange);
  for (const ref of comp.tiles) {
    if (b !== null && (ref.x * size > b[2] || (ref.x + 1) * size < b[0] || ref.z * size > b[3] || (ref.z + 1) * size < b[1])) continue;
    const key = terrainTileKey(ref.x, ref.z);
    if (ref.data === undefined) loaded.set(key, flatTerrainTile(comp.tileSamples, flat));
    else {
      const got = read(ref.data);
      if (!got.ok) return got;
      if (got.tile.samples !== comp.tileSamples) return { ok: false, error: fieldValue('/args/entityId', args.entityId, 'tiles of the terrain\'s size', `tile [${ref.x}, ${ref.z}] holds ${got.tile.samples} samples a side, the terrain ${comp.tileSamples}`) };
      loaded.set(key, got.tile);
    }
    if (ref.base === undefined) authored.set(key, loaded.get(key)!);
    else {
      const got = read(ref.base);
      if (!got.ok) return got;
      authored.set(key, got.tile);
    }
  }
  // A per-request bound: the samples all dabs may cover together (nothing caps the terrain itself).
  const reach = (args.dabs?.length ?? 0) * terrainDabSamples(r, sp);
  if (reach > TERRAIN_BRUSH_LIMITS.samples) return { ok: false, error: fieldValue('/args/dabs', args.dabs?.length, `dabs covering at most ${TERRAIN_BRUSH_LIMITS.samples} samples`, `the stroke covers about ${reach} samples (radius over spacing, times the dabs): split it or use a smaller radius`) };
  const s = new TerrainSamples(comp, splines.layered ? authored : loaded);
  const falloff = args.falloff ?? 'smooth';
  let changed = 0;
  let clamped: number | undefined;
  const dabsLocal = (args.dabs ?? []).map(([x, z]) => local(x, z));
  switch (args.kind) {
    case 'raise':
    case 'lower':
    case 'smooth':
    case 'flatten':
    case 'noise':
      for (const at of dabsLocal) {
        changed += sculptTerrain(s, {
          kind: args.kind,
          at,
          radius: r,
          strength: args.strength!,
          falloff,
          ...(args.height !== undefined ? { height: args.height - origin[1] } : {}),
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        });
      }
      break;
    case 'ramp': {
      const [ax, ay, az] = args.from!;
      const [bx, by, bz] = args.to!;
      changed = rampTerrain(s, { from: [ax - origin[0], ay - origin[1], az - origin[2]], to: [bx - origin[0], by - origin[1], bz - origin[2]], radius: r, strength: args.strength!, falloff });
      break;
    }
    case 'paint':
      for (const at of dabsLocal) changed += paintTerrain(s, { at, radius: r, strength: args.strength!, falloff, layer: args.layer!, ...(args.erase === true ? { erase: true } : {}) });
      break;
    case 'holes':
      for (const at of dabsLocal) changed += holeTerrain(s, { at, radius: r, ...(args.erase === true ? { erase: true } : {}) });
      break;
    case 'import':
      changed = importHeightmap(s, heightmap!, args.at ?? [0, 0], args.range ?? [comp.heightRange[0], comp.heightRange[1]]).samples;
      break;
    case 'fromBlocks': {
      const r2 = blockLayerToTerrain(s, { component: sourceLayer!.component, data: layerDataOf(scene, args.source!), types: new Map((content !== undefined ? blockTypesOf(content) : []).map((t) => [t.blockId, t])), origin: sourceLayer!.origin }, origin);
      changed = r2.samples + r2.holes;
      clamped = r2.clamped;
      break;
    }
    case 'bake':
      break;
  }
  // Beside splines: the tiles the edit wrote, their splines applied again (what is drawn); else the edited tiles themselves.
  const c = splines.layered ? combineEdited(splines, comp, loaded, s) : s;
  // The rules baked (with the splines' paint over them): everywhere for a bake, else around the samples whose height the edit changed.
  let rulesChanged = false;
  const bakeSet = ruleSet ?? (splines.layered && (splines.paints || args.kind === 'bake') ? null : undefined);
  if (bakeSet !== undefined) {
    const written = new Map<string, TerrainTile>();
    for (const key of c.touched) written.set(key, c.all().get(key)!);
    const rect = args.kind === 'bake' ? null : terrainBakeRect(loaded, written, comp.tileSamples - 1, margin);
    const over = splines.layered ? { paint: (tx: number, tz: number) => splines.layer.paint(tx, tz), base: (tx: number, tz: number) => s.tile(tx, tz) } : {};
    if (args.kind === 'bake' || rect !== null) changed += bakeTerrainRules(c, bakeSet, origin, rect, over);
    if (args.kind === 'bake') rulesChanged = JSON.stringify(rules) !== JSON.stringify(comp.rules ?? []);
  }
  const tiles = new Map<string, TerrainTile>();
  for (const key of c.touched) tiles.set(key, c.all().get(key)!);
  // The hand-made forms of the tiles the edit wrote: kept where a spline or layer reaches, dropped where none does.
  const bases = new Map<string, TerrainTile | null>();
  if (splines.layered) {
    const hadBase = new Set(comp.tiles.filter((t) => t.base !== undefined).map((t) => terrainTileKey(t.x, t.z)));
    for (const key of s.touched) {
      const [tx, tz] = key.split(',').map(Number) as [number, number];
      if (splines.stack.reaches(tx, tz)) bases.set(key, s.all().get(key)!);
      else if (hadBase.has(key)) bases.set(key, null);
    }
  }
  const known = new Set(comp.tiles.map((t) => terrainTileKey(t.x, t.z)));
  const addedTiles = [...tiles.keys()].filter((k) => !known.has(k)).map((k) => k.split(',').map(Number) as [number, number]);
  // The scatter baked: everywhere for a bake, else over what the edit changed (the ground, or a stroke's rule) grown by the reach.
  const scatter = new Map<string, ScatterCell | null>();
  let scatterRulesChanged = false;
  if (scatterBakes) {
    const r = bakeScatterOf(comp, origin, c, loaded, tiles, storedRules, args, strokeRule, scene, readScatter, splines);
    if (!r.ok) return r;
    for (const [k, v] of r.cells) scatter.set(k, v);
    if (args.kind === 'bake' && args.scatter !== undefined) scatterRulesChanged = JSON.stringify(scatterRules) !== JSON.stringify(comp.scatter ?? []);
  }
  if (changed === 0 && addedTiles.length === 0 && !rulesChanged && scatter.size === 0 && !scatterRulesChanged && bases.size === 0) return { ok: false, error: { ...noChangeContent(), message: args.kind === 'scatter' ? 'the stroke changes no copy of the rule' : 'the edit changes no sample of the terrain' } };
  return {
    ok: true,
    plan: {
      entityId: args.entityId,
      component: comp,
      tiles,
      scatter,
      bases,
      added: addedTiles,
      changed,
      ...(clamped !== undefined && clamped > 0 ? { clamped } : {}),
      ...(bakesMaterial ? { rules: rules! } : {}),
      ...(args.kind === 'bake' && args.scatter !== undefined ? { scatterRules } : {}),
    },
  };
}

/**
 * The drawn tiles after an edit of the hand-made ones: each tile the edit
 * wrote, the splines applied over it again (the rest as stored).
 */
function combineEdited(splines: TerrainSplineContext, comp: TerrainComponent, loaded: ReadonlyMap<string, TerrainTile>, s: TerrainSamples): TerrainSamples {
  const c = new TerrainSamples(comp, loaded);
  for (const key of s.touched) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    putCombined(c, tx, tz, combinedTile(splines, tx, tz, s.all().get(key)!, loaded.get(key)));
  }
  return c;
}

/**
 * Bake a terrain's scatter for an edit: a bake everywhere; a scatter stroke
 * its hand edits, then over the stroke grown by the rule's reach; any other
 * edit over the samples it changed grown by the rules' reach.
 */
function bakeScatterOf(
  comp: TerrainComponent,
  origin: [number, number, number],
  s: TerrainSamples,
  loaded: ReadonlyMap<string, TerrainTile>,
  written: ReadonlyMap<string, TerrainTile>,
  rules: readonly ScatterRule[],
  args: EditTerrainArgs,
  strokeRule: ScatterRule | null,
  scene: SceneDocument,
  readScatter: TerrainScatterRead | undefined,
  splines: TerrainSplineContext,
): { ok: true; cells: Map<string, ScatterCell | null> } | { ok: false; error: CommandError } {
  const size = terrainTileSize(comp);
  const n = comp.tileSamples - 1;
  const sp = comp.spacing;
  const reach = scatterReach(rules) + 2 * sp;
  let rect: ScatterRect | null = null;
  if (args.kind === 'scatter') rect = scatterStrokeRect({ rule: args.rule!, mode: args.erase === true ? 'erase' : 'paint', dabs: args.dabs!, radius: args.radius! }, scatterReach([strokeRule!]) + 2 * sp);
  else if (args.kind !== 'bake') {
    const changed = terrainChangedSamples(loaded, written, n);
    if (changed === null) return { ok: true, cells: new Map() };
    rect = [origin[0] + changed[0] * sp - reach, origin[2] + changed[1] * sp - reach, origin[0] + changed[2] * sp + reach, origin[2] + changed[3] * sp + reach];
  }
  // The tiles the bake may write (every tile the edit read, and those it made).
  const keys = [...s.all().keys()];
  const coords = keys.map((k) => k.split(',').map(Number) as [number, number]);
  const tooLarge = scatterBakeTooLarge(rules, rect, keys.length * size * size);
  if (tooLarge !== null) return { ok: false, error: tooLarge };
  // Each tile's scatter now (read only where the bake reaches).
  const refs = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t]));
  const prev = new Map<string, ScatterCell>();
  for (const [x, z] of coords) {
    const digest = refs.get(terrainTileKey(x, z))?.scatter;
    if (digest === undefined) continue;
    const b = terrainTileRect(origin, size, x, z);
    if (rect !== null && (rect[0] >= b[2] || rect[2] <= b[0] || rect[1] >= b[3] || rect[3] <= b[1])) continue;
    if (readScatter === undefined) return { ok: false, error: fieldValue('/args', undefined, 'an edit the host prepared', 'the terrain\'s scatter is read through the project host') };
    const got = readScatter(digest);
    if (!got.ok) return got;
    prev.set(terrainTileKey(x, z), got.cell);
  }
  // A stroke's hand edits first (each tile keeps the cells whose point lies on it); changes are told against what is stored.
  const stored = new Map(prev);
  if (args.kind === 'scatter') {
    const stroke = { rule: args.rule!, mode: args.erase === true ? ('erase' as const) : ('paint' as const), dabs: args.dabs!, radius: args.radius! };
    for (const [x, z] of coords) {
      const key = terrainTileKey(x, z);
      const edits = strokeScatterEdits(prev.get(key)?.get(stroke.rule), strokeRule!, stroke, terrainTileRect(origin, size, x, z));
      if (edits !== null) prev.set(key, withScatterEdits(prev.get(key) ?? null, stroke.rule, edits));
    }
  }
  // The ground: every tile the edit read, as it is after the edit.
  const field = new TerrainField({ ...comp, tiles: coords.map(([x, z]) => ({ x, z, data: '' })) }, origin, s.all());
  const surface = terrainScatterSurface(field, regionExcluder(sceneRegionLayers(scene)), splines.bands.empty ? undefined : (x, z, rule) => splines.bands.cleared(x, z, rule));
  const baked = bakeTerrainScatter(rules, surface, origin, size, coords, prev, rect, stored);
  return { ok: true, cells: baked.cells };
}

/**
 * The terrain's tiles after the edit, from the new tiles' digests (null: the
 * tile is flat and bare again, stored without data), their new scatter
 * blobs' (null: no scatter left on it) and their new hand-made forms' beside
 * splines (null: none any more).
 */
export function terrainTilesAfter(c: TerrainComponent, digests: ReadonlyMap<string, string | null>, scatter: ReadonlyMap<string, string | null> = new Map(), bases: ReadonlyMap<string, string | null> = new Map()): TerrainTileRef[] {
  const out: TerrainTileRef[] = [];
  const seen = new Set<string>();
  const ref = (x: number, z: number, data: string | null, sc: string | null, base: string | null): TerrainTileRef => ({ x, z, ...(data !== null ? { data } : {}), ...(sc !== null ? { scatter: sc } : {}), ...(base !== null ? { base } : {}) });
  for (const t of c.tiles) {
    const key = terrainTileKey(t.x, t.z);
    seen.add(key);
    const d = digests.has(key) ? digests.get(key)! : (t.data ?? null);
    const sc = scatter.has(key) ? scatter.get(key)! : (t.scatter ?? null);
    const b = bases.has(key) ? bases.get(key)! : (t.base ?? null);
    out.push(ref(t.x, t.z, d, sc, b));
  }
  for (const key of new Set([...digests.keys(), ...scatter.keys(), ...bases.keys()])) {
    if (seen.has(key)) continue;
    const [x, z] = key.split(',').map(Number) as [number, number];
    out.push(ref(x, z, digests.get(key) ?? null, scatter.get(key) ?? null, bases.get(key) ?? null));
  }
  out.sort((a, b) => a.z - b.z || a.x - b.x);
  return out;
}

/** Store the host's planned tiles on the terrain (a `setComponent terrain` change: one undo restores the old digests). */
export function applyEditTerrain(input: OpInput, args: EditTerrainArgs, prepared: PreparedTerrainEdit | undefined): OpOutcome {
  if (prepared === undefined || prepared.entityId !== args.entityId) {
    return { ok: false, error: fieldValue('/args', undefined, 'an edit the host prepared', 'editTerrain runs through the project host, which reads and writes the terrain\'s tiles') };
  }
  // A bake stores the rules it baked with the tiles (an empty list: none).
  const v = prepared.value;
  const extra: Record<string, unknown> = {};
  if (args.kind === 'bake') {
    if (args.rules !== undefined || args.scatter === undefined) extra['rules'] = v.rules !== undefined && v.rules.length > 0 ? v.rules : null;
    if (args.scatter !== undefined) extra['scatter'] = v.scatter !== undefined && v.scatter.length > 0 ? v.scatter : null;
  }
  // An erode stores its layer's new differences (and the layer, made when missing).
  if (args.kind === 'erode') extra['layers'] = v.layers !== undefined && v.layers.length > 0 ? v.layers : null;
  return applySetComponent(input, { entityId: args.entityId, component: 'terrain', value: { tiles: v.tiles, ...extra } as never });
}
