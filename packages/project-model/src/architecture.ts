/**
 * The `architecture` component: generated architecture stored as the
 * parameters it is made from, never as meshes. Elements are built from two
 * primitives and fills:
 * - `sweep`: a 2D profile swept along a path (walls, mouldings, rails,
 *   frames), mitred at corners, cut by openings;
 * - `repeat`: something placed along a path every so many metres (columns
 *   made from other elements once and stamped, or a kit model's copies);
 * - `fill`: a closed path filled (flat, coffered, barrel and groin vaults;
 *   flat, gable, hip and mansard roofs).
 * Paths are polylines with optional arcs (`bulges`) or a smooth curve
 * through their points (the spline component's curve), open or closed,
 * with the offset and chamfer operators applied in that order.
 *
 * Every face wears a row of a trim sheet: a profile names a slot per
 * segment and a fill names its slot; the row table comes from the trim
 * material the element's material slot is dressed with
 * (`materials: {"architecture": id}`), so swapping the sheet restyles the
 * geometry without touching the parameters.
 *
 * Points are metres from the object's position (no rotation or scale, as a
 * spline or a terrain is placed). Absent optional fields mean the defaults
 * below; `baked` is written by an export that ships the generated meshes
 * (`architecture_ship_meshes`), never by the editor.
 *
 * Pure.
 */
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';

/** Bounds of one component's values: coordinates and sizes, so a request cannot ask for unbounded geometry. */
export const ARCHITECTURE_LIMITS = Object.freeze({
  /** Metres either way for a point. */
  coordinate: 100_000,
  /** Metres for sizes, offsets and heights. */
  distanceMax: 1000,
  /** The finest spacing between repeated copies and between samples on arcs and curves (metres). */
  stepMin: 0.05,
  /** The smallest cell of a fill's tessellation (metres). */
  cellMin: 0.1,
  /** Chunk sides (metres). */
  chunkMin: 4,
  chunkMax: 1024,
  /** Points of one profile. */
  profilePoints: 256,
  /** Storeys of one outline and steps of one stair (their metres stay within `distanceMax` either way). */
  storeys: 1000,
  /** Elements one repeated piece is made of (a piece is made once and stamped, so it stays small). */
  pieceElements: 16,
  /** The largest bulge: tan of a quarter of the arc's angle (1 = a half circle; 2.4 is about 270°). */
  bulgeMax: 2.4,
});

/** The material slot elements wear unless they name another (`materials: {"architecture": id}` or `{"*": id}`). */
export const ARCHITECTURE_MATERIAL_SLOT = 'architecture';
/** Metres a chunk side covers: what one worker job makes and one draw per material shows. */
export const ARCHITECTURE_CHUNK_DEFAULT = 16;
/** Metres between samples on arcs and curves. */
export const ARCHITECTURE_STEP_DEFAULT = 0.5;
/** Vertex AO: how dark a right-angled inside corner gets (0–1) and how far (m) the darkening reaches. */
export const ARCHITECTURE_AO_DEFAULTS = Object.freeze({ strength: 0.6, radius: 0.5 });
/** Metres from the camera past which the far level (no detail elements, no chamfers) is drawn. */
export const ARCHITECTURE_LOD_DISTANCE_DEFAULT = 40;
/** The material slot an opening's pane (glass) wears: a second material, so the walls stay one draw per chunk. */
export const ARCHITECTURE_PANE_MATERIAL_SLOT = 'glass';

export const ARCHITECTURE_ELEMENT_KINDS = ['sweep', 'repeat', 'fill'] as const;
export type ArchitectureElementKind = (typeof ARCHITECTURE_ELEMENT_KINDS)[number];
export const ARCHITECTURE_FILL_SHAPES = ['flat', 'coffered', 'barrel', 'groin', 'gable', 'hip', 'mansard'] as const;
export type ArchitectureFillShape = (typeof ARCHITECTURE_FILL_SHAPES)[number];
/** Fills that need a rectangular path (four corners at right angles). */
export const ARCHITECTURE_RECT_FILLS: readonly ArchitectureFillShape[] = ['barrel', 'groin', 'gable', 'hip', 'mansard'];

/** A path: points with straight segments, arcs or a smooth curve; open or closed. */
export interface ArchitecturePath {
  /** Metres from the object's position. */
  points: [number, number, number][];
  /** Back from the last point to the first (absent: false). */
  closed?: boolean;
  /** Per segment (point i to i+1; closed: also last to first): an arc bulging to the right of travel when positive, the left when negative, as tan of a quarter of its angle (1 = a half circle; absent or 0: straight). */
  bulges?: number[];
  /** A smooth curve through the points (Hermite with Catmull-Rom tangents, as a spline) instead of straight segments (absent: false; bulges are then ignored). */
  curve?: boolean;
  /** Metres between samples on arcs and the curve (absent: {@link ARCHITECTURE_STEP_DEFAULT}). */
  step?: number;
  /** The offset operator: metres to the right of travel, corners mitred (absent: 0). */
  offset?: number;
  /** The chamfer operator: metres cut off each sharp corner (absent: 0). */
  chamfer?: number;
}

/** A 2D cross-section: [across, up] metres in the path's frame, across to the right of travel. */
export interface ArchitectureProfile {
  /** Faces look to the right of the direction from one point to the next (a wall drawn bottom to top faces +across). */
  points: [number, number][];
  /** The trim row slot each segment wears (one per segment; "" leaves the segment open). */
  slots: string[];
  /** Back from the last point to the first (absent: false). */
  closed?: boolean;
  /** Normals averaged at inner points, for round mouldings drawn with many points (absent: false, hard edges). */
  smooth?: boolean;
  /** The chamfer operator: metres cut off each corner (absent: 0; the far level keeps the sharp corners). */
  chamfer?: number;
  /** A closed profile swept along an open path is closed at both ends with faces of this slot (absent: open ends). */
  cap?: string;
}

/** A kit model placed by the generator (copies of it are instances). */
export interface ArchitectureModelRef {
  assetId: string;
  piece?: string;
}

/** An opening cut through a sweep: a door, window or arch. */
export interface ArchitectureOpening {
  id: string;
  /** Metres along the path to the opening's middle. */
  at: number;
  width: number;
  /** Heights (m, in the profile's up) of the opening's sill and head. */
  bottom: number;
  top: number;
  /** The slot the reveals wear (absent: `frame`). */
  reveal?: string;
  /** A profile swept round the opening on the outer face, mitred at its corners (absent: none). */
  frame?: string;
  /** Faces the frame goes on (absent: outer). */
  frameSides?: 'outer' | 'inner' | 'both';
  /** A kit model placed at the opening instead of its reveals and frame (the hole is still cut). */
  model?: ArchitectureModelRef;
  /** A room's storey the opening is in (outlines only; absent: 0, the ground storey). */
  storey?: number;
  /** A pane (glass) fills the hole, on the {@link ARCHITECTURE_PANE_MATERIAL_SLOT} material slot (absent: false). */
  pane?: boolean;
}

interface ElementBase {
  id: string;
  /** The material slot (absent: {@link ARCHITECTURE_MATERIAL_SLOT}). */
  material?: string;
  /** Detail: left out of the far level (mouldings, bevels; absent: false). */
  detail?: boolean;
  /** Colliders (absent: true, but false for detail elements). */
  collide?: boolean;
}

export interface ArchitectureSweep extends ElementBase {
  kind: 'sweep';
  path: ArchitecturePath;
  /** A profile name from the component's `profiles`. */
  profile: string;
  openings?: ArchitectureOpening[];
  /**
   * A room's wall (absent: false): where rooms on one outline set share a
   * wall it is made once, and on a block layer (`layer`) it blocks grid
   * walks across the cell edges it stands on and takes the layer's wall paint.
   */
  wall?: boolean;
  /** Colliders: a box under each level face of the profile (stairs, terraces) instead of the profile's bounds (absent: false). */
  stepped?: boolean;
  /** Per path segment (its index as text): the profile's slots worn along it instead (one per profile segment; absent: the profile's). */
  segmentSlots?: Record<string, string[]>;
}

export interface ArchitectureRepeat extends ElementBase {
  kind: 'repeat';
  path: ArchitecturePath;
  /** Metres between copies along the path. */
  spacing: number;
  /** Metres from the path's start to the first copy (absent: 0) and the last place one may stand (absent: the end). */
  start?: number;
  end?: number;
  /** Also a copy at every sharp corner of the path (absent: false). */
  corners?: boolean;
  /** Copies turn to face along the path, their +X along it (absent: true). */
  align?: boolean;
  /** [across, up] metres from the path (absent: on it). */
  offset?: [number, number];
  /** Degrees each copy turns about up past facing along (absent: 0). */
  yaw?: number;
  /** Seeded variation per copy: degrees of turn and metres of shift along, either way (absent: none). */
  jitter?: { yaw?: number; along?: number };
  /** What is repeated: elements made once in the copy's frame and stamped, or a kit model's copies. */
  piece: { elements: (ArchitectureSweep | ArchitectureFill)[] } | { model: ArchitectureModelRef };
}

export interface ArchitectureFill extends ElementBase {
  kind: 'fill';
  /** A closed path (its points' heights are averaged into the fill's base). */
  path: ArchitecturePath;
  shape: ArchitectureFillShape;
  /** The slot the surface wears. */
  slot: string;
  /** The slot beams, ridges and gable ends wear (absent: `slot`). */
  trimSlot?: string;
  /** Metres above the path the surface (a ceiling's, a vault's springing, a roof's eaves) lies (absent: 0). */
  height?: number;
  /** Metres a vault or roof rises above `height` (absent: half the span for a vault, a quarter for a roof). */
  rise?: number;
  /** Which way a flat or coffered surface faces (absent: up for flat, down for coffered and vaults; roofs face out). */
  face?: 'up' | 'down';
  /** The vault's or ridge's axis: along the longer or the shorter side (absent: long). */
  axis?: 'long' | 'short';
  /** Metres between coffer beams (absent: 1.5) and their depth (absent: 0.2). */
  cell?: number;
  depth?: number;
  /** Metres a roof's eaves reach past the path (absent: 0). */
  overhang?: number;
  /** Mansard: the lower slope's height share of the rise (absent: 0.7) and metres it steps in (absent: a sixth of the span). */
  breakRise?: number;
  inset?: number;
  /** Closed paths cut out of a flat or coffered fill (stairwells; absent: none). */
  holes?: ArchitecturePath[];
}

export type ArchitectureElement = ArchitectureSweep | ArchitectureRepeat | ArchitectureFill;

/** A segment or corner of a sweep (or a repeat's copy) made by a kit model instead. */
export interface ArchitectureOverride {
  /** The element's id. */
  element: string;
  /** The path segment (point i to i+1) replaced; or */
  segment?: number;
  /** the corner at point i, replaced `reach` metres either side (absent: 0.5). */
  corner?: number;
  reach?: number;
  model: ArchitectureModelRef;
  /** A segment's model is stretched along to the segment's length (made 1 m long along +X; absent: true). */
  stretch?: boolean;
}

/** A flight of stairs in a room: steps from the foot's middle to the head's (object frame), as wide as given. */
export interface ArchitectureStair {
  id: string;
  /** The middle of the bottom step's front edge and of the top step's back edge (metres from the object). */
  from: [number, number, number];
  to: [number, number, number];
  width: number;
  /** How many steps (absent: the rise in steps of about {@link ARCHITECTURE_STAIR_RISER} m). */
  steps?: number;
}

/** A hole in a room's floor slab (a stairwell, a shaft). */
export interface ArchitectureFloorHole {
  /** The storey whose floor it is cut in (absent: 0). */
  storey?: number;
  /** A closed path (metres from the object; heights ignored). */
  path: ArchitecturePath;
}

/**
 * An outline drawn on the object and the preset that styles it: the preset's
 * style graph makes its elements from the outline at load (`arch-style.ts`),
 * so restyling swaps the preset and never touches the outline.
 *
 * A closed outline is a room (drawn with its inside to the right of travel):
 * its walls (the style's sweeps marked `wall`) are shared with the rooms
 * beside it, each side styled by its own room; the room may have storeys,
 * an outside preset, holes in its floors and stairs (`arch-rooms.ts`). An
 * open outline is a run: a rail, a fence, a pipe.
 */
export interface ArchitectureOutline {
  /** Unique among the component's outlines; the generated elements' ids start with it. */
  id: string;
  path: ArchitecturePath;
  /** An architecture preset (a project's graph or one of the engine's starters): a room's inside. */
  preset: string;
  /** Doors, windows and arches the style's sweeps that take openings cut (their frames: the style's, unless named). */
  openings?: ArchitectureOpening[];
  /** A room's outside: the preset whose wall faces and trims dress the walls' outer side (absent: the inside preset's own). */
  outside?: string;
  /** A room's storeys, stacked (absent: 1). */
  storeys?: number;
  /** Metres from one storey's floor to the next (absent: the top of the room's walls). */
  storeyHeight?: number;
  /** Holes in the room's floors (absent: none; stairs cut their own). */
  holes?: ArchitectureFloorHole[];
  /** Stairs in the room (absent: none). */
  stairs?: ArchitectureStair[];
  /** A room of a building (its id): its walls on the footprint are the building's, and the building furnishes it (absent: none). */
  building?: string;
  /** The room's type a building's furnishing set places props by (absent: none). */
  roomType?: string;
}

/** Metres a step rises when a stair names no step count. */
export const ARCHITECTURE_STAIR_RISER = 0.18;

export const ARCHITECTURE_ROOF_SHAPES = ['flat', 'gable', 'hip', 'mansard'] as const;
export type ArchitectureRoofShape = (typeof ARCHITECTURE_ROOF_SHAPES)[number];
/** The trim slot a roof wears when it names none (the starter row layout has no roof row; a sheet with one names it). */
export const ARCHITECTURE_ROOF_SLOT_DEFAULT = 'upper_wall';
/** Metres a building's eaves reach past its walls when its roof names no overhang. */
export const ARCHITECTURE_ROOF_OVERHANG_DEFAULT = 0.3;
/** An opening of a building's ground storey whose sill is at most this high over the floor (metres) is a door, linked to the interior when that is a scene of its own. */
export const ARCHITECTURE_DOOR_SILL_MAX = 0.05;
/** Metres in front of a door, on its side, where one arriving through it stands. */
export const ARCHITECTURE_DOOR_SPAWN_DISTANCE = 1;

/** A building's roof over its top storey, on its footprint. */
export interface ArchitectureRoof {
  shape: ArchitectureRoofShape;
  /** The slot the roof wears (absent: {@link ARCHITECTURE_ROOF_SLOT_DEFAULT}) and its gable ends (absent: `slot`). */
  slot?: string;
  trimSlot?: string;
  /** Metres the roof rises over its eaves (absent: half the footprint's deepest inset, a quarter of a rectangle's width). */
  rise?: number;
  /** Metres the eaves reach past the walls (absent: {@link ARCHITECTURE_ROOF_OVERHANG_DEFAULT}). */
  overhang?: number;
  /** The ridge along the longer or shorter side (absent: long). */
  axis?: 'long' | 'short';
  /** Mansard: the lower slope's share of the rise and metres it steps in. */
  breakRise?: number;
  inset?: number;
}

/**
 * Where a building's interior is made when it is a scene of its own: that
 * scene (not the building's) gets the interior at the building's place
 * moved by `offset`, made by the build from this definition, so its walls,
 * openings and storeys are the exterior's.
 */
export interface ArchitectureBuildingInterior {
  scene: string;
  /** Metres from the building's place to its interior's (absent: none: the interior stands where the building does). */
  offset?: [number, number, number];
}

/**
 * A building: a room outline (its footprint, drawn with the inside to the
 * right of travel) with storeys, an inside preset (`preset`), a facade
 * (`outside`), doors and windows (`openings`), stairs and floor holes, plus
 * a roof over its top storey. One definition makes the exterior and the
 * interior, so windows, doors and storey heights match on both sides. The
 * interior is made in place (absent `interior`: cut-aways show it) or in a
 * scene of its own, its doors linked to the exterior's both ways.
 */
export interface ArchitectureBuilding extends ArchitectureOutline {
  /** The roof over the top storey (absent: none). */
  roof?: ArchitectureRoof;
  /** The interior is a scene of its own (absent: in place). */
  interior?: ArchitectureBuildingInterior;
  /** A room program (a `room-program` graph) splitting the footprint into rooms at load (absent: one room; outlines naming the building as theirs replace it). */
  program?: string;
  /** A furnishing set (a `furnishing-set` graph) placing props and lights in the building's rooms at load (absent: none). */
  furnishing?: string;
  /** The seed of the floor plan and the furnishing (absent: 0). */
  layoutSeed?: number;
  /** Props pinned by hand: they stay where they are when the plan or furnishing is made again (absent: none). */
  pins?: ArchitecturePin[];
}

/** A prop pinned in a building: a generated prop kept (same id) or one put there by hand. */
export interface ArchitecturePin {
  id: string;
  model: ArchitectureModelRef;
  /** Its foot (metres from the object). */
  position: [number, number, number];
  /** Degrees about +Y turning its front (+Z) toward +X. */
  facing: number;
  /** Its footprint, width along its X and depth along its Z (metres; absent: half a metre square). */
  size?: [number, number];
}

/**
 * What a building's interior made into another scene carries (written by
 * the build and the editor's view, never stored): the scene and the object
 * the building is drawn on. Its one building is made as the interior.
 */
export interface ArchitectureInteriorOf {
  scene: string;
  entity: string;
}

/** A painted world mask: soft dabs [x, z, radius, weight] in metres from the object (its value at a point: the strongest dab there). */
export interface ArchitectureMask {
  points: [number, number, number, number][];
}

/**
 * A block layer's wall paint as the generator reads it (made by the
 * expansion from the layer the rooms are drawn on, never stored): the
 * layer's cell size, where the object's frame lies in the layer's
 * (layer-local = object-local + `offset`), and the wall paint of the
 * layer's chunks ("cx,cz" → `BlockChunk.wallPaint`).
 */
export interface ArchitecturePaint {
  cellSize: readonly number[];
  offset: readonly number[];
  chunks: Readonly<Record<string, string>>;
  /** A short hash of each chunk's wall paint (what the chunks' cache keys take instead of the bytes). */
  hashes?: Readonly<Record<string, string>>;
}

export interface ArchitectureComponent {
  elements: ArchitectureElement[];
  /** Named profiles the sweeps use. */
  profiles?: Record<string, ArchitectureProfile>;
  overrides?: ArchitectureOverride[];
  /** Outlines styled by presets (absent: none). */
  outlines?: ArchitectureOutline[];
  /** Buildings: room outlines with a roof whose interior may be a scene of its own (absent: none). */
  buildings?: ArchitectureBuilding[];
  /** Painted masks presets read by name to vary a parameter across the level (absent: none). */
  masks?: Record<string, ArchitectureMask>;
  /** Metres a chunk side covers (absent: {@link ARCHITECTURE_CHUNK_DEFAULT}). */
  chunkSize?: number;
  /** The seed of jitter and variation (absent: 0). */
  seed?: number;
  /** Vertex AO baked by the generator (absent: {@link ARCHITECTURE_AO_DEFAULTS}; strength 0: none). */
  ao?: { strength?: number; radius?: number };
  /** Metres to the far level (absent: {@link ARCHITECTURE_LOD_DISTANCE_DEFAULT}). */
  lodDistance?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** SHA-256 of the generated meshes a build ships (written by the export; absent: generated at load). */
  baked?: string;
  /**
   * The block layer (its object's id) the rooms and runs are drawn on
   * (absent: none): their points snap to its cells, cell-aligned walls block
   * its grid walks and openings let them through, rooms are regions of its
   * grid queries, and its wall paint shows on the generated faces.
   */
  layer?: string;
  /** The layer's wall paint, put here by the expansion (never stored). */
  paint?: ArchitecturePaint;
  /** This object is a building's interior made into its own scene (written by the build, never stored by the editor). */
  interiorOf?: ArchitectureInteriorOf;
}

/** The component's fields in canonical order. */
export const ARCHITECTURE_FIELDS: readonly string[] = Object.freeze(['elements', 'profiles', 'overrides', 'outlines', 'buildings', 'masks', 'chunkSize', 'seed', 'ao', 'lodDistance', 'castShadow', 'receiveShadow', 'baked', 'layer', 'interiorOf']);
const PATH_FIELDS = ['points', 'closed', 'bulges', 'curve', 'step', 'offset', 'chamfer'];
const PROFILE_FIELDS = ['points', 'slots', 'closed', 'smooth', 'chamfer', 'cap'];
const BASE_FIELDS = ['id', 'kind', 'material', 'detail', 'collide'];
const SWEEP_FIELDS = [...BASE_FIELDS, 'path', 'profile', 'openings', 'wall', 'stepped', 'segmentSlots'];
const REPEAT_FIELDS = [...BASE_FIELDS, 'path', 'spacing', 'start', 'end', 'corners', 'align', 'offset', 'yaw', 'jitter', 'piece'];
const FILL_FIELDS = [...BASE_FIELDS, 'path', 'shape', 'slot', 'trimSlot', 'height', 'rise', 'face', 'axis', 'cell', 'depth', 'overhang', 'breakRise', 'inset', 'holes'];
const OPENING_FIELDS = ['id', 'at', 'width', 'bottom', 'top', 'reveal', 'frame', 'frameSides', 'model', 'storey', 'pane'];
const OVERRIDE_FIELDS = ['element', 'segment', 'corner', 'reach', 'model', 'stretch'];
const OUTLINE_FIELDS = ['id', 'path', 'preset', 'openings', 'outside', 'storeys', 'storeyHeight', 'holes', 'stairs', 'building', 'roomType'];
const STAIR_FIELDS = ['id', 'from', 'to', 'width', 'steps'];
const BUILDING_FIELDS = [...OUTLINE_FIELDS.filter((k) => k !== 'building'), 'roof', 'interior', 'program', 'furnishing', 'layoutSeed', 'pins'];
const PIN_FIELDS = ['id', 'model', 'position', 'facing', 'size'];
const ROOF_FIELDS = ['shape', 'slot', 'trimSlot', 'rise', 'overhang', 'axis', 'breakRise', 'inset'];
/** An outline id leaves room for the generated elements' suffixes within the id syntax's 64 characters. */
const OUTLINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): boolean => finite(v) && v >= lo && v <= hi;
const vec = (v: unknown, n: number, lo: number, hi: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => within(x, lo, hi));
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
function only(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k);
}
function num(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[], lo: number, hi: number, what: string): void {
  if (v[key] !== undefined && !within(v[key], lo, hi)) err(errors, 'field_value', `${path}/${key}`, `${key} is ${what}`, v[key]);
}
function bool(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[]): void {
  if (v[key] !== undefined && typeof v[key] !== 'boolean') err(errors, 'field_type', `${path}/${key}`, `${key} is true or false`, v[key]);
}
function oneOf(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[], values: readonly string[]): void {
  if (v[key] !== undefined && !values.includes(v[key] as string)) err(errors, 'field_value', `${path}/${key}`, `${key} is ${values.join(', ')}`, v[key]);
}
function slotName(v: unknown, allowEmpty: boolean): boolean {
  return typeof v === 'string' && ((allowEmpty && v === '') || ID_RE.test(v));
}

function validatePath(p: unknown, path: string, errors: ModelErrorV2[], closedRequired: boolean): void {
  const L = ARCHITECTURE_LIMITS;
  if (!isObj(p)) return err(errors, 'field_type', path, 'a path is {points, closed?, bulges?, curve?, step?, offset?, chamfer?}', p);
  only(p, PATH_FIELDS, path, errors, 'path');
  const pts = p['points'];
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every((q) => vec(q, 3, -L.coordinate, L.coordinate))) {
    err(errors, 'field_value', `${path}/points`, `points is a list of at least 2 [x, y, z] metres from the object, within ±${L.coordinate}`, Array.isArray(pts) ? pts.length : pts);
  }
  bool(p, 'closed', path, errors);
  bool(p, 'curve', path, errors);
  const closed = p['closed'] === true;
  if (closedRequired && !closed) err(errors, 'field_value', `${path}/closed`, 'a fill\'s path is closed', p['closed']);
  if (closed && Array.isArray(pts) && pts.length < 3) err(errors, 'field_value', `${path}/closed`, 'a closed path has at least 3 points', pts.length);
  const b = p['bulges'];
  if (b !== undefined) {
    const segs = Array.isArray(pts) ? (closed ? pts.length : pts.length - 1) : 0;
    if (!Array.isArray(b) || b.length !== segs || !b.every((x) => within(x, -L.bulgeMax, L.bulgeMax))) err(errors, 'field_value', `${path}/bulges`, `bulges has one number per segment (${segs}), each within ±${L.bulgeMax}`, b);
  }
  num(p, 'step', path, errors, L.stepMin, 100, `${L.stepMin}-100 metres`);
  num(p, 'offset', path, errors, -L.distanceMax, L.distanceMax, `metres within ±${L.distanceMax}`);
  num(p, 'chamfer', path, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
}

function validateModel(m: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(m)) return err(errors, 'field_type', path, 'a model is {assetId, piece?}', m);
  only(m, ['assetId', 'piece'], path, errors, 'model');
  if (!isId(m['assetId'])) err(errors, 'field_value', `${path}/assetId`, 'assetId names a model asset', m['assetId']);
  if (m['piece'] !== undefined && !(typeof m['piece'] === 'string' && m['piece'].length >= 1 && m['piece'].length <= 128)) err(errors, 'field_value', `${path}/piece`, 'piece is 1-128 characters: a named piece of the file', m['piece']);
}

/** A sweep's (or an outline's) openings. */
function validateOpenings(ops: unknown, path: string, errors: ModelErrorV2[], profiles: Record<string, unknown> | null): void {
  const L = ARCHITECTURE_LIMITS;
  const hasProfiles = profiles !== null;
  if (ops === undefined) return;
  if (!Array.isArray(ops)) return err(errors, 'field_type', path, 'openings is a list', ops);
  const seen = new Set<string>();
  ops.forEach((o, i) => {
    const p = `${path}/${i}`;
    if (!isObj(o)) return err(errors, 'field_type', p, 'an opening is {id, at, width, bottom, top, reveal?, frame?, frameSides?, model?}', o);
    only(o, OPENING_FIELDS, p, errors, 'opening');
    if (!isId(o['id']) || seen.has(o['id'])) err(errors, 'field_value', `${p}/id`, 'id is unique within the element (id syntax)', o['id']);
    else seen.add(o['id']);
    if (!within(o['at'], 0, L.coordinate)) err(errors, 'field_value', `${p}/at`, 'at is metres along the path', o['at']);
    if (!within(o['width'], 0.01, L.distanceMax)) err(errors, 'field_value', `${p}/width`, `width is 0.01-${L.distanceMax} metres`, o['width']);
    if (!within(o['bottom'], -L.distanceMax, L.distanceMax)) err(errors, 'field_value', `${p}/bottom`, 'bottom is metres up the profile', o['bottom']);
    if (!within(o['top'], -L.distanceMax, L.distanceMax) || !(finite(o['bottom']) && (o['top'] as number) > o['bottom'])) err(errors, 'field_value', `${p}/top`, 'top is metres up the profile, above bottom', o['top']);
    if (o['reveal'] !== undefined && !slotName(o['reveal'], true)) err(errors, 'field_value', `${p}/reveal`, 'reveal names a trim slot ("" for none)', o['reveal']);
    if (o['frame'] !== undefined && (!isId(o['frame']) || (hasProfiles && profiles![o['frame']] === undefined))) err(errors, 'field_value', `${p}/frame`, 'frame names one of the component\'s profiles', o['frame']);
    oneOf(o, 'frameSides', p, errors, ['outer', 'inner', 'both']);
    if (o['model'] !== undefined) validateModel(o['model'], `${p}/model`, errors);
    count(o, 'storey', p, errors, 0, L.storeys - 1);
    bool(o, 'pane', p, errors);
  });
}

/** An optional whole number within [lo, hi]. */
function count(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[], lo: number, hi: number): void {
  if (v[key] !== undefined && !(Number.isInteger(v[key]) && (v[key] as number) >= lo && (v[key] as number) <= hi)) err(errors, 'field_value', `${path}/${key}`, `${key} is a whole number ${lo}-${hi}`, v[key]);
}

function validateElement(e: unknown, path: string, errors: ModelErrorV2[], profiles: Record<string, unknown> | null, ids: Set<string>, inPiece: boolean): void {
  const L = ARCHITECTURE_LIMITS;
  const hasProfiles = profiles !== null;
  if (!isObj(e)) return err(errors, 'field_type', path, 'an element is {id, kind: sweep|repeat|fill, …}', e);
  const kind = e['kind'];
  const kinds = inPiece ? ['sweep', 'fill'] : (ARCHITECTURE_ELEMENT_KINDS as readonly string[]);
  if (typeof kind !== 'string' || !kinds.includes(kind)) return err(errors, 'field_value', `${path}/kind`, `kind is ${kinds.join(', ')}`, kind);
  only(e, kind === 'sweep' ? SWEEP_FIELDS : kind === 'repeat' ? REPEAT_FIELDS : FILL_FIELDS, path, errors, kind);
  if (!isId(e['id'])) err(errors, 'field_value', `${path}/id`, 'id uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', e['id']);
  else if (ids.has(e['id'])) err(errors, 'field_value', `${path}/id`, `id "${e['id']}" is used twice`, e['id']);
  else ids.add(e['id']);
  if (e['material'] !== undefined && !isId(e['material'])) err(errors, 'field_value', `${path}/material`, 'material names a material slot (id syntax)', e['material']);
  bool(e, 'detail', path, errors);
  bool(e, 'collide', path, errors);
  validatePath(e['path'], `${path}/path`, errors, kind === 'fill');
  if (kind === 'sweep') {
    // The named profile must exist when the component lists its profiles (without any, the generator reports it).
    if (!isId(e['profile']) || (hasProfiles && profiles![e['profile']] === undefined)) err(errors, 'field_value', `${path}/profile`, 'profile names one of the component\'s profiles', e['profile']);
    validateOpenings(e['openings'], `${path}/openings`, errors, profiles);
    bool(e, 'wall', path, errors);
    bool(e, 'stepped', path, errors);
    const ss = e['segmentSlots'];
    if (ss !== undefined) {
      const ok = isObj(ss) && Object.entries(ss).every(([k, v]) => /^(0|[1-9][0-9]{0,5})$/.test(k) && Array.isArray(v) && v.length <= L.profilePoints && v.every((x) => slotName(x, true)));
      if (!ok) err(errors, 'field_value', `${path}/segmentSlots`, 'segmentSlots is {segment index: [a trim slot per profile segment]}', ss);
    }
  } else if (kind === 'repeat') {
    if (!within(e['spacing'], L.stepMin, L.distanceMax)) err(errors, 'field_value', `${path}/spacing`, `spacing is ${L.stepMin}-${L.distanceMax} metres between copies`, e['spacing']);
    num(e, 'start', path, errors, 0, L.coordinate, `0-${L.coordinate} metres`);
    num(e, 'end', path, errors, 0, L.coordinate, `0-${L.coordinate} metres`);
    bool(e, 'corners', path, errors);
    bool(e, 'align', path, errors);
    if (e['offset'] !== undefined && !vec(e['offset'], 2, -L.distanceMax, L.distanceMax)) err(errors, 'field_value', `${path}/offset`, `offset is [across, up] metres within ±${L.distanceMax}`, e['offset']);
    num(e, 'yaw', path, errors, -360, 360, '-360 to 360 degrees');
    const j = e['jitter'];
    if (j !== undefined) {
      if (!isObj(j)) err(errors, 'field_type', `${path}/jitter`, 'jitter is {yaw?, along?}', j);
      else {
        only(j, ['yaw', 'along'], `${path}/jitter`, errors, 'jitter');
        num(j, 'yaw', `${path}/jitter`, errors, 0, 180, '0-180 degrees');
        num(j, 'along', `${path}/jitter`, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
      }
    }
    const piece = e['piece'];
    if (!isObj(piece)) err(errors, 'field_type', `${path}/piece`, 'piece is {elements: [...]} or {model: {assetId, piece?}}', piece);
    else if (piece['model'] !== undefined) {
      only(piece, ['model'], `${path}/piece`, errors, 'piece');
      validateModel(piece['model'], `${path}/piece/model`, errors);
    } else {
      only(piece, ['elements'], `${path}/piece`, errors, 'piece');
      const els = piece['elements'];
      if (!Array.isArray(els) || els.length < 1 || els.length > L.pieceElements) err(errors, 'field_value', `${path}/piece/elements`, `elements is 1-${L.pieceElements} sweeps or fills made once and stamped`, els);
      else {
        const inner = new Set<string>();
        els.forEach((x, i) => validateElement(x, `${path}/piece/elements/${i}`, errors, profiles, inner, true));
      }
    }
  } else {
    if (typeof e['shape'] !== 'string' || !(ARCHITECTURE_FILL_SHAPES as readonly string[]).includes(e['shape'])) err(errors, 'field_value', `${path}/shape`, `shape is ${ARCHITECTURE_FILL_SHAPES.join(', ')}`, e['shape']);
    if (!isId(e['slot'])) err(errors, 'field_value', `${path}/slot`, 'slot names the trim row the surface wears', e['slot']);
    if (e['trimSlot'] !== undefined && !isId(e['trimSlot'])) err(errors, 'field_value', `${path}/trimSlot`, 'trimSlot names a trim row', e['trimSlot']);
    num(e, 'height', path, errors, -L.distanceMax, L.distanceMax, `metres within ±${L.distanceMax}`);
    num(e, 'rise', path, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
    oneOf(e, 'face', path, errors, ['up', 'down']);
    oneOf(e, 'axis', path, errors, ['long', 'short']);
    num(e, 'cell', path, errors, L.cellMin * 2, L.distanceMax, `${L.cellMin * 2}-${L.distanceMax} metres`);
    num(e, 'depth', path, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
    num(e, 'overhang', path, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
    num(e, 'breakRise', path, errors, 0.05, 0.95, '0.05-0.95 of the rise');
    num(e, 'inset', path, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
    const holes = e['holes'];
    if (holes !== undefined) {
      if (!Array.isArray(holes)) err(errors, 'field_type', `${path}/holes`, 'holes is a list of closed paths', holes);
      else holes.forEach((h, i) => validatePath(h, `${path}/holes/${i}`, errors, true));
      if (e['shape'] !== 'flat' && e['shape'] !== 'coffered') err(errors, 'field_value', `${path}/holes`, 'only a flat or coffered fill has holes', e['shape']);
    }
  }
}

/** A building's roof. */
function validateRoof(r: unknown, p: string, errors: ModelErrorV2[]): void {
  const L = ARCHITECTURE_LIMITS;
  if (r === undefined) return;
  if (!isObj(r)) return err(errors, 'field_type', p, 'a roof is {shape, slot?, rise?, overhang?, …}', r);
  only(r, ROOF_FIELDS, p, errors, 'roof');
  if (typeof r['shape'] !== 'string' || !(ARCHITECTURE_ROOF_SHAPES as readonly string[]).includes(r['shape'])) err(errors, 'field_value', `${p}/shape`, `shape is ${ARCHITECTURE_ROOF_SHAPES.join(', ')}`, r['shape']);
  for (const k of ['slot', 'trimSlot']) if (r[k] !== undefined && !isId(r[k])) err(errors, 'field_value', `${p}/${k}`, `${k} names a trim row`, r[k]);
  num(r, 'rise', p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
  num(r, 'overhang', p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
  oneOf(r, 'axis', p, errors, ['long', 'short']);
  num(r, 'breakRise', p, errors, 0.05, 0.95, '0.05-0.95 of the rise');
  num(r, 'inset', p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
}

/** A building's pinned props. */
function validatePins(pins: unknown, p: string, errors: ModelErrorV2[]): void {
  const L = ARCHITECTURE_LIMITS;
  if (pins === undefined) return;
  if (!Array.isArray(pins)) return err(errors, 'field_type', p, 'pins is a list of {id, model, position, facing, size?}', pins);
  const seen = new Set<string>();
  pins.forEach((pin, i) => {
    const q = `${p}/${i}`;
    if (!isObj(pin)) return err(errors, 'field_type', q, 'a pin is {id, model, position, facing, size?}', pin);
    only(pin, PIN_FIELDS, q, errors, 'pin');
    if (typeof pin['id'] !== 'string' || pin['id'].length < 1 || pin['id'].length > 128 || seen.has(pin['id'])) err(errors, 'field_value', `${q}/id`, 'id is 1-128 characters, unique among the building\'s pins', pin['id']);
    else seen.add(pin['id']);
    validateModel(pin['model'], `${q}/model`, errors);
    if (!vec(pin['position'], 3, -L.coordinate, L.coordinate)) err(errors, 'field_value', `${q}/position`, `position is [x, y, z] metres from the object within ±${L.coordinate}`, pin['position']);
    if (!within(pin['facing'], -360, 360)) err(errors, 'field_value', `${q}/facing`, 'facing is -360 to 360 degrees', pin['facing']);
    if (pin['size'] !== undefined && !vec(pin['size'], 2, 0.01, L.distanceMax)) err(errors, 'field_value', `${q}/size`, `size is [width, depth] metres 0.01-${L.distanceMax}`, pin['size']);
  });
}

/** A room's storeys, floor holes and stairs. */
function validateRoom(o: Record<string, unknown>, p: string, errors: ModelErrorV2[]): void {
  const L = ARCHITECTURE_LIMITS;
  if (o['outside'] !== undefined && !isId(o['outside'])) err(errors, 'field_value', `${p}/outside`, 'outside names an architecture preset', o['outside']);
  if (o['roomType'] !== undefined && !isId(o['roomType'])) err(errors, 'field_value', `${p}/roomType`, 'roomType names a room type (id syntax)', o['roomType']);
  count(o, 'storeys', p, errors, 1, L.storeys);
  num(o, 'storeyHeight', p, errors, 0.1, L.distanceMax, `0.1-${L.distanceMax} metres`);
  const holes = o['holes'];
  if (holes !== undefined) {
    if (!Array.isArray(holes)) err(errors, 'field_type', `${p}/holes`, 'holes is a list of {storey?, path}', holes);
    else
      holes.forEach((h, i) => {
        const q = `${p}/holes/${i}`;
        if (!isObj(h)) return err(errors, 'field_type', q, 'a hole is {storey?, path}', h);
        only(h, ['storey', 'path'], q, errors, 'hole');
        count(h, 'storey', q, errors, 0, L.storeys - 1);
        validatePath(h['path'], `${q}/path`, errors, true);
      });
  }
  const stairs = o['stairs'];
  if (stairs !== undefined) {
    if (!Array.isArray(stairs)) return err(errors, 'field_type', `${p}/stairs`, 'stairs is a list of {id, from, to, width, steps?}', stairs);
    const seen = new Set<string>();
    stairs.forEach((s, i) => {
      const q = `${p}/stairs/${i}`;
      if (!isObj(s)) return err(errors, 'field_type', q, 'a stair is {id, from, to, width, steps?}', s);
      only(s, STAIR_FIELDS, q, errors, 'stair');
      if (!isId(s['id']) || seen.has(s['id'])) err(errors, 'field_value', `${q}/id`, 'id is unique among the room\'s stairs (id syntax)', s['id']);
      else seen.add(s['id']);
      for (const k of ['from', 'to']) if (!vec(s[k], 3, -L.coordinate, L.coordinate)) err(errors, 'field_value', `${q}/${k}`, `${k} is [x, y, z] metres from the object`, s[k]);
      if (vec(s['from'], 3, -L.coordinate, L.coordinate) && vec(s['to'], 3, -L.coordinate, L.coordinate)) {
        const [a, b] = [s['from'] as number[], s['to'] as number[]];
        if (Math.abs(b[1]! - a[1]!) < 0.01 || Math.abs(b[0]! - a[0]!) + Math.abs(b[2]! - a[2]!) < 0.01) err(errors, 'field_value', `${q}/to`, 'a stair rises and runs (to differs from from in height and on the ground)', s['to']);
      }
      if (!within(s['width'], 0.1, L.distanceMax)) err(errors, 'field_value', `${q}/width`, `width is 0.1-${L.distanceMax} metres`, s['width']);
      count(s, 'steps', q, errors, 1, L.storeys);
    });
  }
}

export function validateArchitectureComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const L = ARCHITECTURE_LIMITS;
  if (!isObj(value)) return err(errors, 'field_type', path, 'architecture is an object { elements, profiles?, overrides?, … }', value);
  only(value, ARCHITECTURE_FIELDS, path, errors, 'architecture');
  const profiles = value['profiles'];
  const named: Record<string, unknown> = {};
  if (profiles !== undefined) {
    if (!isObj(profiles)) err(errors, 'field_type', `${path}/profiles`, 'profiles is {name: {points, slots, closed?, smooth?, chamfer?}}', profiles);
    else {
      for (const [name, pr] of Object.entries(profiles)) {
        const p = `${path}/profiles/${name}`;
        if (!ID_RE.test(name)) err(errors, 'field_value', p, 'a profile name uses the id syntax', name);
        if (!isObj(pr)) {
          err(errors, 'field_type', p, 'a profile is {points, slots, closed?, smooth?, chamfer?}', pr);
          continue;
        }
        named[name] = pr;
        only(pr, PROFILE_FIELDS, p, errors, 'profile');
        const pts = pr['points'];
        const ok = Array.isArray(pts) && pts.length >= 2 && pts.length <= L.profilePoints && pts.every((q) => vec(q, 2, -L.distanceMax, L.distanceMax));
        if (!ok) err(errors, 'field_value', `${p}/points`, `points is 2-${L.profilePoints} [across, up] metres`, Array.isArray(pts) ? pts.length : pts);
        bool(pr, 'closed', p, errors);
        bool(pr, 'smooth', p, errors);
        num(pr, 'chamfer', p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
        if (pr['cap'] !== undefined && !slotName(pr['cap'], false)) err(errors, 'field_value', `${p}/cap`, 'cap names the trim slot the ends wear', pr['cap']);
        const segs = Array.isArray(pts) ? (pr['closed'] === true ? pts.length : pts.length - 1) : 0;
        const slots = pr['slots'];
        if (!Array.isArray(slots) || slots.length !== segs || !slots.every((s) => slotName(s, true))) err(errors, 'field_value', `${p}/slots`, `slots names one trim row per segment (${segs}; "" for an open segment)`, slots);
      }
    }
  }
  const els = value['elements'];
  const ids = new Set<string>();
  if (!Array.isArray(els)) err(errors, 'field_type', `${path}/elements`, 'elements is a list of sweeps, repeats and fills', els);
  else els.forEach((e, i) => validateElement(e, `${path}/elements/${i}`, errors, profiles === undefined ? null : named, ids, false));
  const ovs = value['overrides'];
  if (ovs !== undefined) {
    if (!Array.isArray(ovs)) err(errors, 'field_type', `${path}/overrides`, 'overrides is a list', ovs);
    else {
      ovs.forEach((o, i) => {
        const p = `${path}/overrides/${i}`;
        if (!isObj(o)) return err(errors, 'field_type', p, 'an override is {element, segment? | corner?, reach?, model, stretch?}', o);
        only(o, OVERRIDE_FIELDS, p, errors, 'override');
        if (!isId(o['element']) || !ids.has(o['element'])) err(errors, 'field_value', `${p}/element`, 'element names one of the elements', o['element']);
        const hasSeg = o['segment'] !== undefined;
        const hasCorner = o['corner'] !== undefined;
        if (hasSeg === hasCorner) err(errors, 'field_value', p, 'an override names a segment or a corner (one of them)');
        for (const k of ['segment', 'corner']) if (o[k] !== undefined && !(Number.isInteger(o[k]) && (o[k] as number) >= 0 && (o[k] as number) < 1_000_000)) err(errors, 'field_value', `${p}/${k}`, `${k} is a point index`, o[k]);
        num(o, 'reach', p, errors, 0.01, L.distanceMax, `0.01-${L.distanceMax} metres`);
        validateModel(o['model'], `${p}/model`, errors);
        bool(o, 'stretch', p, errors);
      });
    }
  }
  const outlines = value['outlines'];
  if (outlines !== undefined) {
    if (!Array.isArray(outlines)) err(errors, 'field_type', `${path}/outlines`, 'outlines is a list of {id, path, preset, openings?}', outlines);
    else {
      const seen = new Set<string>();
      outlines.forEach((o, i) => {
        const p = `${path}/outlines/${i}`;
        if (!isObj(o)) return err(errors, 'field_type', p, 'an outline is {id, path, preset, openings?}', o);
        only(o, OUTLINE_FIELDS, p, errors, 'outline');
        if (typeof o['id'] !== 'string' || !OUTLINE_ID_RE.test(o['id']) || seen.has(o['id'])) err(errors, 'field_value', `${p}/id`, 'id is unique among the outlines (id syntax, at most 48 characters)', o['id']);
        else seen.add(o['id']);
        validatePath(o['path'], `${p}/path`, errors, false);
        if (!isId(o['preset'])) err(errors, 'field_value', `${p}/preset`, 'preset names an architecture preset', o['preset']);
        validateOpenings(o['openings'], `${p}/openings`, errors, profiles === undefined ? null : named);
        validateRoom(o, p, errors);
      });
    }
  }
  const buildings = value['buildings'];
  if (buildings !== undefined) {
    if (!Array.isArray(buildings)) err(errors, 'field_type', `${path}/buildings`, 'buildings is a list of {id, path, preset, roof?, interior?, …}', buildings);
    else {
      const taken = new Set(Array.isArray(outlines) ? outlines.map((o) => (isObj(o) ? o['id'] : undefined)) : []);
      buildings.forEach((b, i) => {
        const p = `${path}/buildings/${i}`;
        if (!isObj(b)) return err(errors, 'field_type', p, 'a building is {id, path, preset, roof?, interior?, …}', b);
        only(b, BUILDING_FIELDS, p, errors, 'building');
        if (typeof b['id'] !== 'string' || !OUTLINE_ID_RE.test(b['id']) || taken.has(b['id'])) err(errors, 'field_value', `${p}/id`, 'id is unique among the outlines and buildings (id syntax, at most 48 characters)', b['id']);
        else taken.add(b['id']);
        validatePath(b['path'], `${p}/path`, errors, true);
        if (!isId(b['preset'])) err(errors, 'field_value', `${p}/preset`, 'preset names an architecture preset (the inside)', b['preset']);
        validateOpenings(b['openings'], `${p}/openings`, errors, profiles === undefined ? null : named);
        validateRoom(b, p, errors);
        validateRoof(b['roof'], `${p}/roof`, errors);
        for (const k of ['program', 'furnishing']) if (b[k] !== undefined && !isId(b[k])) err(errors, 'field_value', `${p}/${k}`, `${k} names a ${k === 'program' ? 'room program' : 'furnishing set'} graph`, b[k]);
        if (b['layoutSeed'] !== undefined && !(Number.isInteger(b['layoutSeed']) && (b['layoutSeed'] as number) >= 0 && (b['layoutSeed'] as number) <= 0xffffffff)) err(errors, 'field_value', `${p}/layoutSeed`, 'layoutSeed is a whole number 0-4294967295', b['layoutSeed']);
        validatePins(b['pins'], `${p}/pins`, errors);
        const inn = b['interior'];
        if (inn !== undefined) {
          if (!isObj(inn)) err(errors, 'field_type', `${p}/interior`, 'interior is {scene, offset?}', inn);
          else {
            only(inn, ['scene', 'offset'], `${p}/interior`, errors, 'interior');
            if (!isId(inn['scene'])) err(errors, 'field_value', `${p}/interior/scene`, 'scene names the scene the interior is made in', inn['scene']);
            if (inn['offset'] !== undefined && !vec(inn['offset'], 3, -L.coordinate, L.coordinate)) err(errors, 'field_value', `${p}/interior/offset`, `offset is [x, y, z] metres within ±${L.coordinate}`, inn['offset']);
          }
        }
      });
    }
  }
  // A room naming its building names one of the component's buildings.
  if (Array.isArray(outlines)) {
    const owners = new Set(Array.isArray(buildings) ? buildings.map((b) => (isObj(b) ? b['id'] : undefined)) : []);
    outlines.forEach((o, i) => {
      if (isObj(o) && o['building'] !== undefined && !(typeof o['building'] === 'string' && owners.has(o['building']))) err(errors, 'field_value', `${path}/outlines/${i}/building`, 'building names one of the component\'s buildings', o['building']);
    });
  }
  const iof = value['interiorOf'];
  if (iof !== undefined) {
    if (!isObj(iof)) err(errors, 'field_type', `${path}/interiorOf`, 'interiorOf is {scene, entity}', iof);
    else {
      only(iof, ['scene', 'entity'], `${path}/interiorOf`, errors, 'interiorOf');
      if (!isId(iof['scene'])) err(errors, 'field_value', `${path}/interiorOf/scene`, 'scene names the scene the building stands in', iof['scene']);
      if (!isId(iof['entity'])) err(errors, 'field_value', `${path}/interiorOf/entity`, 'entity names the object the building is drawn on', iof['entity']);
    }
  }
  const masks = value['masks'];
  if (masks !== undefined) {
    if (!isObj(masks)) err(errors, 'field_type', `${path}/masks`, 'masks is {name: {points: [[x, z, radius, weight], …]}}', masks);
    else {
      for (const [name, m] of Object.entries(masks)) {
        const p = `${path}/masks/${name}`;
        if (!ID_RE.test(name)) err(errors, 'field_value', p, 'a mask name uses the id syntax', name);
        if (!isObj(m)) {
          err(errors, 'field_type', p, 'a mask is {points: [[x, z, radius, weight], …]}', m);
          continue;
        }
        only(m, ['points'], p, errors, 'mask');
        const pts = m['points'];
        const ok = Array.isArray(pts) && pts.every((q) => Array.isArray(q) && q.length === 4 && within(q[0], -L.coordinate, L.coordinate) && within(q[1], -L.coordinate, L.coordinate) && within(q[2], 0.01, L.distanceMax) && within(q[3], 0, 1));
        if (!ok) err(errors, 'field_value', `${p}/points`, `points is a list of [x, z, radius 0.01-${L.distanceMax}, weight 0-1] (metres from the object)`, Array.isArray(pts) ? pts.length : pts);
      }
    }
  }
  num(value, 'chunkSize', path, errors, L.chunkMin, L.chunkMax, `${L.chunkMin}-${L.chunkMax} metres`);
  if (value['seed'] !== undefined && !(Number.isInteger(value['seed']) && (value['seed'] as number) >= 0 && (value['seed'] as number) <= 0xffffffff)) err(errors, 'field_value', `${path}/seed`, 'seed is a whole number 0-4294967295', value['seed']);
  const ao = value['ao'];
  if (ao !== undefined) {
    if (!isObj(ao)) err(errors, 'field_type', `${path}/ao`, 'ao is {strength?, radius?}', ao);
    else {
      only(ao, ['strength', 'radius'], `${path}/ao`, errors, 'ao');
      num(ao, 'strength', `${path}/ao`, errors, 0, 1, '0-1');
      num(ao, 'radius', `${path}/ao`, errors, 0.01, 10, '0.01-10 metres');
    }
  }
  num(value, 'lodDistance', path, errors, 0, 100_000, '0-100000 metres');
  bool(value, 'castShadow', path, errors);
  bool(value, 'receiveShadow', path, errors);
  if (value['baked'] !== undefined && (typeof value['baked'] !== 'string' || !DIGEST_RE.test(value['baked']))) err(errors, 'field_value', `${path}/baked`, 'baked is the SHA-256 of the shipped meshes (64 lowercase hex), written by an export', value['baked']);
  if (value['layer'] !== undefined && (typeof value['layer'] !== 'string' || value['layer'].length < 1 || value['layer'].length > 128)) err(errors, 'field_value', `${path}/layer`, 'layer names the block layer object the rooms are drawn on', value['layer']);
}

/** The component in canonical form: fields in order; nested objects as given (validation fixed their fields). */
export function canonicalArchitecture(c: ArchitectureComponent): ArchitectureComponent {
  const src = c as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ARCHITECTURE_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  return out as unknown as ArchitectureComponent;
}

/** The material slots a component's elements wear (sorted; repeated pieces' elements too, and openings' panes). */
export function architectureMaterialSlots(c: Pick<ArchitectureComponent, 'elements'>): string[] {
  const out = new Set<string>();
  const visit = (e: ArchitectureElement, inherited: string): void => {
    const slot = e.material ?? inherited;
    if (e.kind === 'repeat') {
      if ('elements' in e.piece) for (const x of e.piece.elements) visit(x, slot);
    } else out.add(slot);
    if (e.kind === 'sweep' && (e.openings ?? []).some((o) => o.pane === true)) out.add(ARCHITECTURE_PANE_MATERIAL_SLOT);
  };
  for (const e of c.elements) visit(e, ARCHITECTURE_MATERIAL_SLOT);
  return [...out].sort();
}

/** The kit models an architecture component places (repeated pieces, overrides, openings). */
export function architectureModelAssets(c: Pick<ArchitectureComponent, 'elements' | 'overrides' | 'outlines' | 'buildings'> | undefined): string[] {
  const out = new Set<string>();
  for (const e of c?.elements ?? []) {
    if (e.kind === 'repeat' && 'model' in e.piece) out.add(e.piece.model.assetId);
    if (e.kind === 'sweep') for (const o of e.openings ?? []) if (o.model !== undefined) out.add(o.model.assetId);
  }
  for (const r of [...(c?.outlines ?? []), ...(c?.buildings ?? [])]) for (const o of r.openings ?? []) if (o.model !== undefined) out.add(o.model.assetId);
  for (const b of c?.buildings ?? []) for (const p of b.pins ?? []) out.add(p.model.assetId);
  for (const o of c?.overrides ?? []) out.add(o.model.assetId);
  return [...out];
}
