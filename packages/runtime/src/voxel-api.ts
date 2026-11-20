/**
 * `ctx.voxels`: what scripts read and change of the scenes' voxel worlds.
 *
 * Scripts work in world metres; which cells and chunks that means stays
 * inside the engine. A world's cell (0, 0, 0) starts at the world origin and
 * a cell is `VOXEL_SIZE_M` on each side.
 *
 * Reads are of the world as the game sees it (its runtime changes over the
 * world's files). A cell whose chunk is not loaded reads `null`, never air:
 * a game that needs ground there waits for it (`whenResident`, answered in
 * `waits` at a later step, as every answer that takes time is). Changes go to
 * the running game only (dropped when the game quits or a run restarts);
 * the edited cells read their new values at once, in the same step, and
 * their meshes, colliders and shader data change together in one swap a
 * few frames later, reported in `changes` at the next step.
 *
 * Saves are the game's own bytes: `save()` makes a voxel save of the
 * game's changes (only the fields the game marks saved, each changed chunk
 * against the world's files it was made on), answered in `saves` at a later
 * step; the game keeps the bytes in its own save (as text in a save
 * document) and gives them back to `restore`, which puts them in place of
 * the running game's changes. Where the world's files changed since (a
 * re-exported world), the game says what wins; each such chunk is reported
 * in `mismatches`.
 *
 * Rings: where a world loads, collides and draws each detail level is its
 * `voxelWorld` object's (metres), scaled by the quality level the player
 * runs (the level's voxel ring scale, or the scene's own distances for that
 * level). `setRings` changes the scene's distances while the game runs (an
 * indoor part small, the open land large); the quality level still applies
 * on top. The change is applied without a reload: the levels drawn change
 * in one swap, chunks past the new load ring go and those inside it load,
 * and the relief ring (`levels.relief`) is planned again, its sections
 * swapping together.
 *
 * Rays: `raycast` walks the world's occupancy cell face by cell face to the
 * first voxel that stops it (a body, or what blocks light), on into the
 * coarser levels and the far field past the full-detail ring.
 *
 * Regions: `regionAt` names the open region a cell is in (connected open
 * cells, stitched across chunks as they load), whether it is enclosed, its
 * volume and whether the cell is under open sky; door and window openings
 * are portals between regions, so a house's room is its own region. A room
 * is an enclosed region (its openings are its only ways out); the outdoors
 * is the region under the sky. Its box, its surface against solid voxels and
 * a mean free path (4 V / S, the mean distance between two reflections in a
 * room, what a reverb's decay is set from) size it for sound; `portalsOf`
 * lists its doors and windows and the regions each leads to. The answers are
 * kept as the regions are stitched: a query reads them, it walks nothing.
 *
 * Paths: `findPath` asks for a way a walker can go from one point to
 * another over the world's voxels (standing on what supports, a step up or
 * down of one cell, through doors as tall as it), `reach` for every place
 * within a walking distance; each is answered at a later step in `paths` or
 * `reaches`, served in the order asked within the path-finding share of a
 * step, so many questions at once never stall one. A path that runs into
 * chunks not loaded yet answers `unknown` with the way to where the known
 * world ends, never `unreachable`. Props and doors are not in the walk: a
 * game steers round its moving obstacles itself.
 *
 * Materials: a voxel names its material by id; `materialOf(id)` and
 * `materialAt(x, y, z)` answer with the material record that id is (its name,
 * use and kit, its physics resolved against its profile, and the game's own
 * data), as the build ships it, for game logic such as footsteps or how much
 * a block takes to break. The engine itself reads none of it: chunk
 * colliders keep one friction (a triangle-mesh collider has no friction per
 * triangle).
 */
import type { VoxelMaterialInfo } from '@thirdlight/project-model';
import { cellInWorld, MATERIAL_ID_MAX, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness, VOXEL_ROLE_COUNT, VOXEL_SIZE_M, WETNESS_MAX, type OpenPortalInfo, type OpenRegionInfo, type VoxelRecord, type WalkHit, type WalkRay } from '@thirdlight/voxel';

export type { VoxelMaterialInfo };

/** A voxel as scripts read and write it. */
export interface VoxelValue {
  /** Material id (0: air). */
  readonly material: number;
  /** Role (0: air): what the voxel is to meshing and collision (ground, wall, beam, …). */
  readonly role: number;
  /** Fill level, 0 (empty) to 15 (full). */
  readonly shape: number;
  /** Wetness, 0 (dry) to 7. */
  readonly wetness: number;
}

/** The voxel `set` writes: shape absent is full, wetness absent is dry. */
export interface VoxelWrite {
  readonly material: number;
  readonly role: number;
  readonly shape?: number;
  readonly wetness?: number;
}

/** What `paint` changes: material and wetness only (shader data; meshes and colliders stand). */
export interface VoxelPaint {
  readonly material?: number;
  readonly wetness?: number;
}

/**
 * Where a read or change applies, in world metres: the cell holding a
 * point, every cell a box touches, or every cell whose centre lies within a
 * ball.
 */
export type VoxelRegion =
  | { readonly at: readonly [number, number, number] }
  | { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  | { readonly center: readonly [number, number, number]; readonly radius: number };

/** A field of a voxel (what a save keeps of a change is chosen by field). */
export type VoxelField = 'material' | 'role' | 'shape' | 'wetness';

/**
 * What wins where a save was made on other world files than the running
 * game's (a re-exported world changed the chunk): the player's changed
 * cells over the new files (`save`), or the new files alone (`base`).
 */
export type VoxelMismatchChoice = 'save' | 'base';

/** Why a change was not made (nothing was written). */
export type VoxelRefusal = 'no_world' | 'not_resident' | 'invalid';

/** A change or restore not made, and why. */
export interface VoxelRefused {
  readonly ok: false;
  readonly reason: VoxelRefusal;
  readonly message: string;
}

/** A change's answer: its id (named again by its entry in `changes`) and the cells it changed (0: it changed nothing). */
export type VoxelEditResult = { readonly ok: true; readonly edit: number; readonly cells: number } | VoxelRefused;

/** A restore's answer: its id (named again in `changes` once the loaded pieces it changed are swapped in) and the save's changed pieces. */
export type VoxelRestoreResult = { readonly ok: true; readonly edit: number; readonly chunks: number } | VoxelRefused;

/** What stops a ray (`raycast`): a voxel drawn as a body (`solid`), or one that blocks light (`light`). */
export interface VoxelRayOptions {
  readonly stop?: 'solid' | 'light';
}

/** Where a ray met the world. */
export interface VoxelRayHit {
  /** Metres from the origin to where the ray enters the voxel. */
  readonly distance: number;
  /** That point (world metres). */
  readonly point: readonly [number, number, number];
  /** The centre of the voxel hit (world metres): `get`, `dig` and `set` at it act on that voxel. */
  readonly at: readonly [number, number, number];
  /** The face entered, as its outward normal (0, 0, 0: the ray started inside). */
  readonly normal: readonly [number, number, number];
  /** The voxel (null: met in the coarser levels or the far field, which hold no single voxel). */
  readonly voxel: VoxelValue | null;
  /** Met in the far field or a coarser level than full detail. */
  readonly far: boolean;
}

/**
 * What a region is to a game: a `room` (enclosed: complete, nothing of it under open sky, not at the world's edge),
 * the `outdoors` (some cell of it under open sky), a `portal` (a door or window opening between regions), or
 * `unknown` (it reaches space not loaded yet, or the world's edge: not a room, not known to be outdoors).
 */
export type VoxelRegionKind = 'room' | 'outdoors' | 'portal' | 'unknown';

/**
 * The open region a cell is in (`regionAt`): connected open cells (not drawn as a body: air, liquid, rails and
 * posts; joined across cell faces, never by an edge alone), or a portal (the cells of a door or window opening,
 * which separate the regions either side of it).
 */
export interface VoxelRegionInfo {
  /** The region's id: the same while the region does not change (it is joined or split by an edit, or grows as chunks load). */
  readonly id: number;
  /** The cell is in an opening (a portal between regions), not in a region. */
  readonly portal: boolean;
  /**
   * Nothing of the region is under open sky, it reaches no space that is not loaded yet, and not the world's
   * edge: a room whose openings are its only ways out. A region reaching a chunk not loaded is never enclosed.
   */
  readonly enclosed: boolean;
  /** The region reaches no space that is not loaded yet (false: it may continue there). */
  readonly complete: boolean;
  /** The region's volume in m³ (the loaded part of it while not complete). */
  readonly volume: number;
  /** This cell is under open sky: no solid voxel above it in its column (as far as the world is loaded). */
  readonly sky: boolean;
  /** Some cell of the region is under open sky. */
  readonly seesSky: boolean;
  /** A region: the portals (openings) on its boundary; a portal: the regions it joins. */
  readonly portals: number;
  /** A room, the outdoors, a portal, or not known yet ({@link VoxelRegionKind}). */
  readonly kind: VoxelRegionKind;
  /** The box its cells fill (world metres; the loaded part while not complete). */
  readonly bounds: VoxelBox;
  /** Its surface against solid voxels in m² (cell faces of 0.25 m²; door and window openings are not surface). */
  readonly surface: number;
  /**
   * Its mean free path in metres, 4 × volume / surface: the mean distance sound travels between two reflections in
   * it (Sabine's room estimate; 0 with no surface). A 4 × 3 × 5 m room: 2.55 m.
   */
  readonly meanFreePath: number;
}

/** A door or window opening (`portalsOf`): its box and the regions it joins. */
export interface VoxelPortalInfo {
  /** The portal's id (its cells read as this in `regionAt`, with `portal` true). */
  readonly id: number;
  /** The box its opening cells fill (world metres). */
  readonly bounds: VoxelBox;
  /** Its opening's area across: the cells it holds × 0.125 m³ (its volume, m³). */
  readonly volume: number;
  /** The regions it joins (ids, ascending): a door between a room and the outdoors names both. */
  readonly regions: readonly number[];
}

/** A walk's hit as scripts read it. */
export function voxelRayHit(ray: WalkRay, hit: WalkHit): VoxelRayHit {
  const s = VOXEL_SIZE_M;
  const point = ray.origin.map((o, a) => o + ray.dir[a]! * hit.t) as [number, number, number];
  const at = hit.cell.map((c) => (c + 0.5) * s) as [number, number, number];
  const r = hit.record;
  const voxel = r === null ? null : Object.freeze({ material: valueMaterial(r), role: valueRole(r), shape: valueShape(r), wetness: valueWetness(r) });
  return Object.freeze({ distance: hit.t, point: Object.freeze(point), at: Object.freeze(at), normal: Object.freeze([hit.normal[0] + 0, hit.normal[1] + 0, hit.normal[2] + 0] as [number, number, number]), voxel, far: hit.far || hit.level > 0 });
}

/** A box in world metres. */
export interface VoxelBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A box of cells (min and max inclusive) in world metres. */
export function cellBoxMetres(min: readonly number[], max: readonly number[]): VoxelBox {
  const s = VOXEL_SIZE_M;
  return Object.freeze({ min: Object.freeze([min[0]! * s, min[1]! * s, min[2]! * s] as [number, number, number]), max: Object.freeze([(max[0]! + 1) * s, (max[1]! + 1) * s, (max[2]! + 1) * s] as [number, number, number]) });
}

/** A stitched region's summary as scripts read it (`cellSky`: the queried cell is under open sky). */
export function voxelRegionInfo(info: OpenRegionInfo, cellSky: boolean): VoxelRegionInfo {
  const s = VOXEL_SIZE_M;
  const volume = info.cells * s * s * s;
  const surface = info.faces * s * s;
  const kind: VoxelRegionKind = info.portal ? 'portal' : info.enclosed ? 'room' : info.sky ? 'outdoors' : 'unknown';
  return Object.freeze({ id: info.id, portal: info.portal, enclosed: info.enclosed, complete: info.complete, volume, sky: cellSky, seesSky: info.sky, portals: info.portals, kind, bounds: cellBoxMetres(info.min, info.max), surface, meanFreePath: surface > 0 ? (4 * volume) / surface : 0 });
}

/** A stitched portal as scripts read it. */
export function voxelPortalInfo(p: OpenPortalInfo): VoxelPortalInfo {
  const s = VOXEL_SIZE_M;
  return Object.freeze({ id: p.id, bounds: cellBoxMetres(p.min, p.max), volume: p.cells * s * s * s, regions: p.regions });
}

/** How a path or reach query walks (`findPath`, `reach`), in metres. */
export interface VoxelWalkOptions {
  /**
   * The walker's height (default 2 m, at most 8): it goes only where that much is free over the floor (whole 0.5 m
   * cells, rounded up). Its footprint is one cell: a walker up to 0.25 m in radius.
   */
  readonly height?: number;
  /** The deepest drop it walks off a ledge (default 0: it never drops; whole cells, rounded down; with its height at most 8 m). */
  readonly maxDrop?: number;
  /** At most this many places searched (default: no bound): past it the answer is `partial`, the way to where it got closest. */
  readonly maxNodes?: number;
}

/**
 * How a path query ended: `found` (the cheapest way, or within a few per cent of it on a long path), `partial` (its
 * `maxNodes` was spent: the way to where it got closest), `unreachable` (every way out of the start is known and none
 * reaches the end), `unknown` (it ran into chunks not loaded yet: the way to where the known world ends nearest the
 * end, or no world loaded).
 */
export type VoxelPathStatus = 'found' | 'partial' | 'unreachable' | 'unknown';

/** A `findPath` answered (in `ctx.voxels.paths` at a later step). */
export interface VoxelPathAnswer {
  /** The id `findPath` returned. */
  readonly path: number;
  readonly world: string;
  readonly status: VoxelPathStatus;
  /** Why nothing was walked: no place to stand near the start (`from`) or the end (`to`), a malformed point or option (`invalid`), no voxel world loaded (`no_world`). */
  readonly reason?: 'from' | 'to' | 'invalid' | 'no_world';
  /**
   * Its way as waypoints (world metres), start to end: each the middle of a standing cell at its floor, where the way
   * turns (a straight run is one segment; corners are kept, not pulled tight).
   */
  readonly points: readonly (readonly [number, number, number])[];
  /** Its length (m) along the cells walked. */
  readonly length: number;
  /** Places searched for it, steps it was served over and its ms in them. */
  readonly searched: number;
  readonly steps: number;
  readonly ms: number;
}

/** A `reach` answered (in `ctx.voxels.reaches` at a later step): the places a walker can stand within the distance. */
export interface VoxelReachAnswer {
  /** The id `reach` returned. */
  readonly reach: number;
  readonly world: string;
  /** `found`: every way within the distance is known; `unknown`: some way may go on into chunks not loaded yet; `unreachable`: no place to stand near the start. */
  readonly status: 'found' | 'unreachable' | 'unknown';
  readonly reason?: 'from' | 'invalid' | 'no_world';
  /** The places (standing cells of 0.5 × 0.5 m) and the floor area they cover (m²). */
  readonly count: number;
  readonly area: number;
  /** The box of the places (their cells, world metres; null: none). */
  readonly bounds: VoxelBox | null;
  /** Each place's middle at its floor (world metres), when asked for (`points: true`), else null. */
  readonly points: readonly (readonly [number, number, number])[] | null;
  readonly searched: number;
  readonly steps: number;
  readonly ms: number;
}

/** A change whose meshes, colliders and shader data were swapped in. */
export interface VoxelChange {
  readonly world: string;
  /** The id the change's call answered with. */
  readonly edit: number;
  /** The world's pieces whose derived data the swap replaced (each one's box). */
  readonly chunks: readonly VoxelBox[];
  /** Only material or wetness changed: the shader data was replaced, meshes and colliders stand. */
  readonly shaderOnly: boolean;
}

/** A change to a world's distances in metres (each group and field optional; what is left out stays). */
export interface VoxelRingChange {
  /** Where chunks load (`loadRadius`, `loadHeight`) and how far past it they stay (`unloadRadius`, `unloadHeight`). */
  readonly ring?: { readonly loadRadius?: number; readonly unloadRadius?: number; readonly loadHeight?: number; readonly unloadHeight?: number };
  /** Where loaded chunks have colliders round a focus. */
  readonly collision?: { readonly radius?: number; readonly height?: number };
  /** Where level 0 (full detail, with the kit pieces) and level 1 are drawn, past level 1 level 2; within `relief` (0: none) surfaces are drawn with relief. */
  readonly levels?: { readonly level0?: number; readonly level1?: number; readonly relief?: number };
}

/** The distances a world streams with now (metres, after the quality level), the level they are for and its memory budget. */
export interface VoxelRings {
  readonly ring: { readonly loadRadius: number; readonly unloadRadius: number; readonly loadHeight: number; readonly unloadHeight: number };
  readonly collision: { readonly radius: number; readonly height: number };
  readonly levels: { readonly level0: number; readonly level1: number; readonly relief: number };
  /** The quality level (null: the page has not reported one yet; the scene's own distances apply). */
  readonly quality: string | null;
  /** The stream memory budget in bytes (null: the host's). */
  readonly budgetBytes: number | null;
  /** Relief lattice steps a cell within `levels.relief` (the quality level's; 0: no relief). */
  readonly reliefSteps: number;
}

/** A ring change's answer: the distances now in use, or why nothing changed. */
export type VoxelRingsResult = { readonly ok: true; readonly rings: VoxelRings } | VoxelRefused;

/** One voxel world of the loaded scenes. */
export interface BehaviorVoxelWorld {
  /** The world's name (its `voxelWorld` component's `world`). */
  readonly name: string;
  /**
   * The voxel at a world position, or null where the world is not loaded there (never air for that).
   * @graphPure
   * @graphNode Voxel at
   */
  get(x: number, y: number, z: number): VoxelValue | null;
  /**
   * How much of the light a cell at a world position blocks, 0 (open) to 1 (solid): the world's own voxels joined
   * with the props marked `affectsLighting` standing in it (never part of the voxels, never saved). Null where the
   * world is not loaded there, or the cell's piece is not built yet.
   * @graphPure
   * @graphNode Light coverage at
   */
  coverageAt(x: number, y: number, z: number): number | null;
  /**
   * The first voxel a ray meets from `origin` along `direction` (metres; any length) within `maxDistance` metres,
   * or null. The ray steps from cell face to cell face (never between two cells that touch only by an edge); past
   * the full-detail ring it continues through the coarser levels and the far field drawn, so a ray toward a
   * distant mountain still meets it (`far`, cells of 2 m and more there). What stops it is `options.stop`:
   * `solid` (default: a voxel drawn as a body, what a pick hits) or `light` (one that blocks light: half covered or
   * more). Liquid, openings and air never stop it; where nothing is loaded it passes as through air.
   * @graphNode skip a ray's origin and direction are points, which a graph input cannot take yet
   */
  raycast(origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance: number, options?: VoxelRayOptions): VoxelRayHit | null;
  /**
   * The open region the cell at a world position is in: its id, whether it is enclosed, its volume (m³), whether the
   * cell is under open sky, and its portals (door and window openings). Null where the cell is solid, or the world
   * is not loaded there or its regions are not stitched yet (a moment after a chunk arrives or an edit lands).
   * @graphNode skip a region is an object, which a graph output cannot take yet
   */
  regionAt(x: number, y: number, z: number): VoxelRegionInfo | null;
  /**
   * The portals (door and window openings) of a region by its id (`regionAt`'s), each with its box and the regions
   * it joins; of a portal's id, that portal. Empty when the id is not a region now (an edit split or joined it).
   * @graphNode skip a portal list is a list of objects, which a graph output cannot take yet
   */
  portalsOf(regionId: number): readonly VoxelPortalInfo[];
  /**
   * Asks for a way a walker can go from `from` to `to` (world metres: where it stands or its middle; the standing
   * place under it, to 2 m, or beside it, is taken). Returns the query's id, answered in `ctx.voxels.paths` at a
   * later step: its waypoints, length and how it ended. Walks over standing places (free cells on what supports, as
   * tall as the walker), one cell (0.5 m) up or down a step (stairs), round corners (never across one); through
   * doorways, not props.
   * @graphNode skip a path's points are a list, which a graph output cannot take yet
   */
  findPath(from: readonly [number, number, number], to: readonly [number, number, number], options?: VoxelWalkOptions): number;
  /**
   * Asks for every place a walker can stand within `maxDistance` metres walked from `from`. Returns the query's id,
   * answered in `ctx.voxels.reaches` at a later step: how many, their box and floor area (with `points: true`, each
   * place's middle at its floor).
   * @graphNode skip a reach's answer is an object, which a graph output cannot take yet
   */
  reach(from: readonly [number, number, number], maxDistance: number, options?: VoxelWalkOptions & { readonly points?: boolean }): number;
  /**
   * The material record of the voxel at a world position (null where the world is not loaded there, the cell is air,
   * or its id has no material record in the build).
   * @graphNode skip a material record is an object, which a graph output cannot take yet
   */
  materialAt(x: number, y: number, z: number): VoxelMaterialInfo | null;
  /**
   * The material record a voxel material id is (null: no material in the build has that id).
   * @graphNode skip a material record is an object, which a graph output cannot take yet
   */
  materialOf(id: number): VoxelMaterialInfo | null;
  /**
   * Write a voxel into every cell of a region (readable at once; meshes and colliders follow in one swap).
   * @graphNode skip a region is a point, a box or a ball, which a graph input cannot take yet
   */
  set(region: VoxelRegion, voxel: VoxelWrite): VoxelEditResult;
  /**
   * Empty every cell of a region to air.
   * @graphNode skip a region is a point, a box or a ball, which a graph input cannot take yet
   */
  dig(region: VoxelRegion): VoxelEditResult;
  /**
   * Change the material or wetness of the non-air cells of a region, keeping their shape and role (only shader data changes).
   * @graphNode skip a region is a point, a box or a ball, which a graph input cannot take yet
   */
  paint(region: VoxelRegion, paint: VoxelPaint): VoxelEditResult;
  /**
   * Whether every cell of a region is loaded (reads give values, changes are accepted).
   * @graphNode skip a region is a point, a box or a ball, which a graph input cannot take yet
   */
  isResident(region: VoxelRegion): boolean;
  /**
   * Waits for every cell of a region to be loaded: returns the wait's id, answered in `ctx.voxels.waits`
   * at a later step's start (resident, or not when the world unloaded first).
   * @graphNode skip a region is a point, a box or a ball, which a graph input cannot take yet
   */
  whenResident(region: VoxelRegion): number;
  /**
   * Which fields of the game's changes a save keeps (the world's `savedFields` until set; each run starts
   * with them again). False when the list names something else.
   * @graphNode skip a field list is a list of names, which a graph input cannot take yet
   */
  setSavedFields(fields: readonly VoxelField[]): boolean;
  /**
   * The distances the world streams with now (metres, the quality level applied).
   * @graphNode skip the distances are an object, which a graph output cannot take yet
   */
  rings(): VoxelRings;
  /**
   * Change the world's distances while the game runs (merged into its scene's; null: back to the scene's own).
   * Applied without a reload: the levels drawn change in one swap, chunks past a smaller load ring go.
   * @graphNode skip the distances are an object, which a graph input cannot take yet
   */
  setRings(change: VoxelRingChange | null): VoxelRingsResult;
  /**
   * Make a save of the game's changes to the world: returns the save's id, answered in `ctx.voxels.saves`
   * at a later step with the save's bytes (and the same as text for a save document).
   * @graphNode Save voxel changes
   */
  save(): number;
  /**
   * Restore a save (its bytes, or its text) in place of the game's changes: loaded cells read it at once,
   * the rest as they load. `onMismatch`: what wins where the world's files changed since the save.
   * @graphNode skip a save is bytes, which a graph input cannot take
   */
  restore(save: Uint8Array | string, onMismatch: VoxelMismatchChoice): VoxelRestoreResult;
}

/**
 * The voxel worlds of the loaded scenes (`ctx.voxels`). Its own reads and
 * changes act on the first world loaded; `world(name)` reaches the others.
 */
export interface BehaviorVoxels extends Omit<BehaviorVoxelWorld, 'name'> {
  /** The loaded worlds' names, in load order. */
  worlds(): readonly string[];
  /**
   * A loaded world by name (null: no loaded scene names it).
   * @graphNode skip a world handle; the voxel nodes act on the first world loaded
   */
  world(name: string): BehaviorVoxelWorld | null;
  /** The changes swapped in since the previous step, every world's, in swap order. */
  readonly changes: readonly VoxelChange[];
  /** The `whenResident` waits answered at this step's start. */
  readonly waits: readonly VoxelWaitAnswer[];
  /** The saves (`save()`) answered at this step's start. */
  readonly saves: readonly VoxelSaveAnswer[];
  /** The paths (`findPath`) answered at this step's start, in the order asked. */
  readonly paths: readonly VoxelPathAnswer[];
  /** The reaches (`reach`) answered at this step's start, in the order asked. */
  readonly reaches: readonly VoxelReachAnswer[];
  /** The restored chunks found made on other world files than now, since the previous step, and whether the save was kept there. */
  readonly mismatches: readonly VoxelMismatch[];
}

/** A `save()` answered. */
export interface VoxelSaveAnswer {
  readonly save: number;
  readonly world: string;
  readonly ok: boolean;
  /** The save (null when it failed): give it back to `restore`. */
  readonly bytes: Uint8Array | null;
  /** The same bytes as base64 text, for a save document (which holds JSON only); `restore` takes it too. */
  readonly text: string | null;
  /** The changed pieces of the world it holds. */
  readonly chunks: number;
  /** Why it failed. */
  readonly message?: string;
}

/** A restored piece of the world whose files changed since its save. */
export interface VoxelMismatch {
  readonly world: string;
  readonly chunk: VoxelBox;
  /** True: the player's cells were kept over the new files (`save`); false: the new files stand (`base`). */
  readonly kept: boolean;
}

/** A `whenResident` wait's answer. */
export interface VoxelWaitAnswer {
  readonly wait: number;
  /** True: the region is loaded; false: its world unloaded first (or the region was not one). */
  readonly resident: boolean;
}

/** A region's cells (inclusive bounds) and, for a ball, which of them it holds. */
export interface RegionCells {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Absent: every cell of the bounds. */
  readonly holds?: (x: number, y: number, z: number) => boolean;
}

const finite3 = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const cellOf = (m: number): number => Math.floor(m / VOXEL_SIZE_M);
/** The last cell a box edge at `m` touches (a box ending exactly on a cell face does not reach into the next cell). */
const lastCellOf = (m: number): number => Math.ceil(m / VOXEL_SIZE_M) - 1;

/** The cells of a region (null: malformed, or reaching outside the world). */
export function regionCells(region: VoxelRegion): RegionCells | null {
  if (typeof region !== 'object' || region === null) return null;
  let out: RegionCells;
  if ('at' in region) {
    if (!finite3(region.at)) return null;
    const [x, y, z] = region.at.map(cellOf) as [number, number, number];
    out = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
  } else if ('min' in region) {
    if (!finite3(region.min) || !finite3(region.max)) return null;
    const lo = region.min.map(cellOf);
    const hi = region.max.map((m, i) => Math.max(lo[i]!, lastCellOf(m)));
    if (region.max.some((m, i) => m < region.min[i]!)) return null;
    out = { minX: lo[0]!, minY: lo[1]!, minZ: lo[2]!, maxX: hi[0]!, maxY: hi[1]!, maxZ: hi[2]! };
  } else if ('center' in region) {
    const r = region.radius;
    if (!finite3(region.center) || typeof r !== 'number' || !(r >= 0) || !Number.isFinite(r)) return null;
    const [cx, cy, cz] = region.center;
    const r2 = r * r;
    const s = VOXEL_SIZE_M;
    // A cell is in the ball when its centre is.
    const holds = (x: number, y: number, z: number): boolean => {
      const dx = (x + 0.5) * s - cx;
      const dy = (y + 0.5) * s - cy;
      const dz = (z + 0.5) * s - cz;
      return dx * dx + dy * dy + dz * dz <= r2;
    };
    out = { minX: cellOf(cx - r), minY: cellOf(cy - r), minZ: cellOf(cz - r), maxX: cellOf(cx + r), maxY: cellOf(cy + r), maxZ: cellOf(cz + r), holds };
  } else return null;
  return cellInWorld(out.minX, out.minY, out.minZ) && cellInWorld(out.maxX, out.maxY, out.maxZ) ? out : null;
}

/** Every cell of a region, x y z flat. */
export function regionCellList(r: RegionCells): number[] {
  const out: number[] = [];
  for (let x = r.minX; x <= r.maxX; x++) for (let z = r.minZ; z <= r.maxZ; z++) for (let y = r.minY; y <= r.maxY; y++) if (r.holds === undefined || r.holds(x, y, z)) out.push(x, y, z);
  return out;
}

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A script's voxel as the record it writes (null: a field out of range). */
export function writeRecord(v: VoxelWrite): VoxelRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const shape = v.shape ?? SHAPE_FULL;
  const wetness = v.wetness ?? 0;
  if (!intIn(v.material, 0, MATERIAL_ID_MAX) || !intIn(v.role, 0, VOXEL_ROLE_COUNT - 1) || !intIn(shape, 0, SHAPE_FULL) || !intIn(wetness, 0, WETNESS_MAX)) return null;
  return { material: v.material, role: v.role, shape, wetness };
}

/** Whether a paint names only material and wetness, in range, and at least one of them. */
export function validPaint(p: VoxelPaint): boolean {
  if (typeof p !== 'object' || p === null || (p.material === undefined && p.wetness === undefined)) return false;
  return (p.material === undefined || intIn(p.material, 1, MATERIAL_ID_MAX)) && (p.wetness === undefined || intIn(p.wetness, 0, WETNESS_MAX));
}
