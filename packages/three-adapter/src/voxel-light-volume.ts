/**
 * The voxel light volume (a candidate store for voxel worlds' soft light,
 * `?voxelLight=volume`, WebGPU only): light kept in the open cells that touch
 * a surface, six values a cell (voxel-light-volume-layout.ts), round the
 * camera, updated in compute (voxel-light-volume-wgsl.ts) and read by the
 * voxel surfaces in place of the flat ambient term.
 *
 * - **Where it is kept.** A window of 2 m bricks follows the camera
 *   (`CameraWindow` across, the eye's height up, lowered to keep the ground
 *   under a high eye in it); a brick is kept where it holds an open cell next
 *   to a solid one (by the walk's blocks the draw batches bring), and takes a
 *   slot of the pool (an r32uint texture three owns, written by the pass and
 *   read by the surfaces). The window's index (a slot a brick, wrapped) is a
 *   texture written from here.
 * - **Coarse levels for open air.** Three more windows of bricks of 1, 2 and
 *   4 m cells (a clipmap, each reaching twice as far) in the same pool and
 *   index: a coarse cell holds light wherever no level-0 cell in it stops
 *   light; a coarse brick is kept near what is solid (by the same rule over
 *   its level-0 bricks), so a point in a room's middle or over a field finds
 *   light where it has no 0.5 m cell round it.
 * - **What is stale.** A brick that comes into its window or is kept anew
 *   (no light yet); the bricks a changed block's changed bricks can reach by
 *   a ray; the sun or the sky changed; the bricks a ray can reach a lamp's
 *   light from (its reach and the rays' past it) when a lamp came, went,
 *   moved or changed. A brick a change reaches starts again from nothing,
 *   its rays from the start of their sequence, so once settled it holds what
 *   a volume started with the new light holds: nothing of a light that went.
 *   While changes keep coming (a light or an edit within a second of the
 *   last: a blend of looks, a moving lamp, a brush stroke) the bricks farther
 *   than two from an edit keep half their history, so the light follows
 *   smoothly, and start again from nothing once the changes stop. A brick
 *   settles after `VOLUME_SETTLE_UPDATES` updates.
 * - **Pacing.** Stale bricks nearest the eye first, as many a frame as the
 *   live light's share of the tier's GPU frame (`gpuPassBudgetMs`: the
 *   lighting row less the shadow maps') holds by the pass's measured ms a
 *   brick (voxel-light-volume-pacing.ts: its timestamps taken wide, the wait
 *   for the pool to be readable inside them). With room left, or nothing
 *   stale, settled bricks are refined (voxel-light-volume-refine.ts: the
 *   view in front first): a stale dispatch is filled to its size, and with
 *   nothing stale a dispatch of that size runs on the share of frames the
 *   live light's idle share holds (`gpuPassIdleBudgetMs`), until each brick
 *   has had `VOLUME_HISTORY_UPDATES` updates: then nothing is dispatched
 *   until something changes. A brick
 *   goes into the index the frame after its first update. The CPU's share
 *   (windows, keeping, marks) runs within the lighting preparation slice. Hidden by the GPU
 *   measurement under `lighting`. The pool is made once at its size (see
 *   {@link POOL_SLOTS}); bricks past it wait for a slot.
 * - **The lamps.** The clustered lights' record of the page's lamps
 *   (voxel-light-volume-lamps.ts; point, spot and area lights, lit at a hit
 *   as the per-pixel light lights them): a table of those whose reach meets
 *   the windows, and a list per kept brick of every level of those reaching it,
 *   built in compute when the table changes and for slots taken or given up;
 *   a ray's hit is lit by the list of the level-0 brick holding the open cell
 *   in front of it, else of the finest coarse brick holding it with a slot,
 *   else (no kept brick of any level holds it) by the whole table.
 * - **The colours bounced.** Each kept level-0 brick's open cells carry the
 *   mean colour of the solid cells across their faces (voxel-light-volume-
 *   colours.ts: a look's tint times its albedo texture's mean for the side
 *   seen, measured once on the GPU as the surfaces get their arrays; a white
 *   look before that bounces the grey the live probes bounce), and beside
 *   them the glow of the cells across their faces (a material's record's glow
 *   × its mean colour; a glow texture written only where some cell glows): a
 *   ray that meets a surface sees its glow added to its bounce. A record edit
 *   that changes what a material bounces or gives off ({@link
 *   VoxelLightVolume.looksChanged}) rewrites the cells beside it and marks
 *   what their light reaches.
 * - **The read** ({@link VoxelVolumeLight}'s node, built after every light
 *   the volume does not hold): every lit draw's pixel (voxel surfaces, kit
 *   pieces, props, moving objects; not a material that says otherwise) reads
 *   the eight cells round the point half a cell off it along its normal,
 *   trilinearly, only those holding light counted, level 0 first and the
 *   coarse levels for what it left, evaluates their ambient cubes with its
 *   normal, and takes that in place of the held ambient and hemisphere light
 *   and the environment's diffuse light; where no level holds light (past the
 *   windows, not lit yet) it keeps the flat term, faded by the weight found.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { frameSliceMs, residentBytes, threadProfiler } from '@thirdlight/shared';
import { gpuPassBudgetMs, gpuPassIdleBudgetMs, levelFrameBudget, MEMORY_BUDGET_BY_TIER, type QualityLevelConfig } from '@thirdlight/project-model';
import { VOXEL_SIZE_M, type WalkBlockView, type WalkBlockWire, type WalkTable } from '@thirdlight/voxel';

import type { N } from './effects-tsl';
import { TSL_SCALAR_OPS } from './field-ops';
import { CameraWindow } from './camera-window';
import { gpuPassHides } from './gpu-pass-hides';
import { gpuTextureOf, uploadTextureRegion, type RegionTextureRenderer } from './region-texture';
import { KEPT_IRRADIANCE, isProbeHeld, markProbeHeld } from './probe-lighting';
import { SkyProbe } from './surface-probe-sky';
import { BOUNCE_ALBEDO, SH_E0, SH_E1 } from './surface-probes';
import { VolumeBounceSource, VolumeColourCache, volumeCellColour, volumeCellGlow, volumeColourRgb, type VolumeBounceMeans } from './voxel-light-volume-colours';
import { VolumeLookWatch } from './voxel-light-volume-looks';
import { volumeReferenceFace, volumeRoomCells, type VolumeCheckCell, type VolumeLightWorld, type VolumeReferenceCounts } from './voxel-light-volume-reference';
import { texelTexture } from './texel-texture-node';
import type { VoxelMaterialLook } from './voxel-surface';
import type { VoxelWalkGpu } from './voxel-walk-gpu';
import { GPU_BUFFER_USAGE, GPU_MAP_READ, grownGpuBuffer, type GpuBuffer, type GpuEncoder, type GpuTexture } from './tracer-gpu';
import type { ClusterLights } from './cluster-build';
import { NO_VOLUME_LAMPS, VolumeLampLists, volumeLampSet, type VolumeLampListCounts, type VolumeLampListJob, type VolumeLampSet } from './voxel-light-volume-lamps';
import { ambientCubeSteps, VOLUME_ALBEDO_WIDTH, VOLUME_BLOCK_BRICKS, VOLUME_BRICK_TEXELS, VOLUME_BRICK_VOLUME, VOLUME_BRICKS_PER_ROW, VOLUME_FACES, VOLUME_FULL_WEIGHT, VOLUME_HISTORY_UPDATES, volumeBlendWeight, volumeFilterShare, VOLUME_INDEX_ROW_BASE, VOLUME_INDEX_ROWS, VOLUME_INDEX_WIDTH, VOLUME_LAMP_FLOATS, VOLUME_LAMP_LIST_ENTRIES, VOLUME_LAMP_LIST_WORDS, VOLUME_LEFT_MIN, VOLUME_LEVEL_WINDOWS, VOLUME_LEVELS, VOLUME_POOL_WIDTH, VOLUME_READ_OFFSET_CELLS, VOLUME_WINDOW_BRICKS, VOLUME_WORD, volumeBlockBrick, volumeBlockBricks, volumeBrickKey, volumeBrickLamps, volumeCellM, volumeChangedBricks, volumeDecode, volumeLevelBrickKept, volumeLevelCellHolds, volumeLevelIndexTexel, volumePoolTexel, VOLUME_READ_KEY, volumeMarkBoxes, type VolumeBlockBricks } from './voxel-light-volume-layout';
import { VolumePacing } from './voxel-light-volume-pacing';
import { VolumeIndexRows, VolumeRefiner, volumeNearestFirst } from './voxel-light-volume-refine';
import { VolumeHistory, VolumePendingChanges } from './voxel-light-volume-changes';
import { VOLUME_LIST_WORDS, VOLUME_PARAM_COARSE, VOLUME_PARAM_FLOATS, volumeUpdateWgsl } from './voxel-light-volume-wgsl';

const TSL: N = TSLTyped;
const { If, float, int, ivec2, luminance, max, mix, normalWorld, normalWorldGeometry, positionWorld, renderGroup, select, smoothstep, uint, uniform, vec3 } = TSL;

/** Updates a brick takes to settle (each blends 1 / its count in: the mean of this many estimates). */
export const VOLUME_SETTLE_UPDATES = 8;
/** Rays a face casts an update. */
export const VOLUME_RAYS = 4;
/** Metres a ray goes before it counts as reaching the sky, and a walk toward the sun before the sun counts as seen. */
export const VOLUME_RAY_REACH_M = 24;
export const VOLUME_SUN_REACH_M = 48;
/** Bricks an update a frame before the pass's cost is known. */
const START_BRICKS = 32;
/** Frames between looks at the scene's lamps (a walk of the scene graph). */
const LAMP_LOOK_FRAMES = 15;
/** A change within this many frames of the last one continues it (two looks at the lamps: a lamp moved each look). */
const CHANGES_CONTINUE_FRAMES = 2 * LAMP_LOOK_FRAMES;
/**
 * Slots the pool is made with (29 MiB; within the tier's budget, never more): the most the town's windows were seen to
 * keep is ~12 k. It is made once and never replaced: lit draws made before a replaced texture kept reading the old one
 * (three keeps one binding per program and refreshes only the first draw's group), so a pool grown by copy left the
 * chunks drawn before it reading nothing. Bricks past it wait for a slot to free, nearest first.
 */
const POOL_SLOTS = 16384;
/** Bytes a slot takes on the GPU (its faces, its colours, its glows and its lamp list). */
const SLOT_BYTES = (VOLUME_BRICK_TEXELS + 2 * VOLUME_BRICK_VOLUME + VOLUME_LAMP_LIST_WORDS) * 4;
/** The largest 2D texture side the pool may take (WebGPU's default limit). */
const MAX_TEXTURE_ROWS = 8192;

const VOLUME_SPAN = threadProfiler.span('voxel light volume', 'lighting');
/**
 * What a batch's chunks and walk blocks ask of the volume as the batch is shown (inside the batch's own span): the
 * grids and cells as they were kept; what changed is found in the volume's slice of later frames.
 */
const VOLUME_GRIDS_SPAN = threadProfiler.span('voxel light volume grids', 'lighting');
const VOLUME_WALK_SPAN = threadProfiler.span('voxel light volume walk changes', 'lighting');

/** The part of a `GPUDevice` the volume calls. */
export interface VolumeDevice {
  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBuffer;
  createShaderModule(desc: { code: string; label?: string }): unknown;
  createComputePipeline(desc: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuEncoder & { resolveQuerySet?(q: unknown, first: number, count: number, dst: GpuBuffer, offset: number): void };
  createQuerySet?(desc: { type: string; count: number }): unknown;
  readonly features?: { has(name: string): boolean };
  readonly queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView): void; submit(list: unknown[]): void };
}

/** What the volume reads of the page. */
export interface VoxelLightVolumeDeps {
  readonly scene: THREE.Scene;
  readonly renderer: RegionTextureRenderer;
  readonly device: VolumeDevice;
  /** The world whose walk the rays take, and its walk on the GPU (null: none yet). */
  walk(): VoxelWalkGpu | null;
  level(): QualityLevelConfig | null;
  look(material: number): VoxelMaterialLook;
  /** The top of what is solid under (x, z) (null: none known). */
  ground(x: number, z: number): number | null;
  /** The page's lamps as the clustered lights gathered them last (absent or null: none). */
  lamps?(): ClusterLights | null;
  /** False: the volume is lit but no surface reads it (`?surfaceRead=0`, a comparison of what reading costs and changes). */
  readonly read?: boolean;
}

interface Brick {
  /** Its level (0: the 0.5 m cells beside surfaces; 1–3 the coarse levels) and place in bricks of that level. */
  readonly level: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** Its pool slot (−1: none free within the budget yet). */
  slot: number;
  updates: number;
  /** Updates it has had since kept (never reset: its next rays are the next points of its faces' sequence). */
  samples: number;
  /** Its index entry is written (after its first update was listed). */
  published: boolean;
}

/** How far the volume's light has caught up. */
export interface VoxelVolumeProgress {
  /** Cell faces written by updates so far. */
  readonly texelsWritten: number;
  /** Bricks not settled. */
  readonly staleUnits: number;
  /** Blocks waiting to be looked at and kept bricks waiting for a slot. */
  readonly waiting: number;
  readonly probesSettled: boolean;
  readonly probesStale: number;
  /** Nothing stale: every kept brick past its first settle (the light caught up with every change). */
  readonly settled: boolean;
  /** Settled, and every kept brick refined to its whole history: the update has stopped. */
  readonly refined: boolean;
}

/** One cell as read back from the pool (a check against the CPU's rules). */
export interface VoxelVolumeCell {
  readonly cell: readonly number[];
  /** Its brick is kept, has a slot, has been updated (times). */
  readonly kept: boolean;
  readonly slot: number;
  readonly updates: number;
  /** The CPU's rule: it holds light. */
  readonly holds: boolean;
  /** The six faces' light (null: the word 0). */
  readonly faces: readonly (readonly number[] | null)[];
}

/** A level-0 brick's lamp list as read back from the GPU, beside the CPU's rule for it (a check of the build). */
export interface VoxelVolumeLampList {
  readonly brick: readonly number[];
  /** Its brick is kept and holds a slot; a build of its list is still waiting (the table changed or the slot is new). */
  readonly kept: boolean;
  readonly slot: number;
  readonly pending: boolean;
  /** The lamps listed (table indices) and the count reaching it, on the GPU (null: no slot) and by the CPU's rule. */
  readonly gpu: { readonly listed: readonly number[]; readonly total: number } | null;
  readonly cpu: { readonly listed: readonly number[]; readonly total: number };
  /** The places of the lamps the GPU lists (x, y, z). */
  readonly at: readonly (readonly number[])[];
}

/** One way the reference is run (a page hook's check): its rays, bounces, reaches, and which colours it bounces. */
export interface VolumeReferenceVariant {
  readonly name: string;
  readonly rays: number;
  readonly bounces: number;
  readonly reach?: number;
  readonly sunReach?: number;
  /** The colour a hit bounces: its open cell's (the mean of the cells across its faces, as the update reads it) or its own face's (the material and side it shows). */
  readonly albedo: 'cells' | 'faces';
  /** The looks' colours alone (a textured white look the default grey), or times their texture means. */
  readonly colours: 'looks' | 'textures';
  /** Texture means by voxel id (wall, floor, ceiling linear rgb; absent: those measured). */
  readonly means?: Readonly<Record<string, readonly [readonly number[] | null, readonly number[] | null, readonly number[] | null]>>;
}

export class VoxelLightVolume {
  readonly light: VoxelVolumeLight;
  /** Each level's window across (the camera-following helper, a texel a brick of that level). */
  private readonly wins = VOLUME_LEVEL_WINDOWS.map((d, l) => new CameraWindow({ texels: d[0], cellM: brickM(l) }));
  /** Each level's window corner brick (NaN until the first follow). */
  private readonly origins = VOLUME_LEVEL_WINDOWS.map(() => [NaN, NaN, NaN]);
  private readonly bricks = new Map<number, Brick>();
  private readonly stale = new Set<Brick>();
  private readonly blocks = new Map<string, VolumeBlockBricks | null>();
  /** Level-0 blocks (bx, by, bz) whose bricks are to be looked at again. */
  private readonly toLook = new Map<string, readonly [number, number, number]>();
  /** Coarse bricks (level, bx, by, bz) to be looked at again, by key. */
  private readonly toLookCoarse = new Map<number, readonly [number, number, number, number]>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  /** Kept bricks waiting for a slot (the pool full). */
  private readonly waitingSlots = new Set<Brick>();
  private readonly index = new VolumeIndexRows<Brick>();
  /** Level-0 chunks' shader grids (the colours), by `cx,cy,cz`: the grid, or its one entry. */
  private readonly chunkCells = new Map<string, Uint16Array | number>();
  /** Chunks whose grid changed (by `cx,cy,cz`; the grid the volume last saw, undefined: none) and walk blocks whose cells did (`bx,by,bz`; their cells before): looked at in the volume's slice. */
  private readonly gridChanges = new VolumePendingChanges<Uint16Array | number | undefined>();
  private readonly walkChanges = new VolumePendingChanges<WalkBlockView | null>();
  private readonly albedoDirty = new Set<Brick>();
  /** The colours and glows written, and record edits held against what each voxel id gave before. */
  private readonly looks = new VolumeLookWatch();
  private readonly sky = new SkyProbe();
  /** The albedo textures' mean colours by voxel id (none until measured). */
  private readonly bounce = new VolumeBounceSource();
  private skyVersion = -1;
  private readonly sunWas = [0, 0, 0, 0];
  private lamps: VolumeLampSet = NO_VOLUME_LAMPS;
  /** The lamp table changed since the lists were built: every level-0 brick's list is built again. */
  private lampsChanged = false;
  /** Every level's window's slot + 1 of each kept brick (as the pool's index, but written as slots are taken), and its rows to upload. */
  private readonly lampSlots = new Uint32Array(VOLUME_INDEX_WIDTH * VOLUME_INDEX_ROWS);
  private readonly lampSlotsDirty = new Set<number>();
  /** Slots whose lamp list is built (a brick) or cleared (null) at the next build. */
  private readonly listJobs = new Map<number, Brick | null>();
  private frames = 0;
  /** What a change of light or an edit does to the bricks it reaches (from nothing; half while changes continue). */
  private readonly history = new VolumeHistory<Brick>(VOLUME_SETTLE_UPDATES, CHANGES_CONTINUE_FRAMES, (b) => this.markStale(b));
  /** Which settled bricks are refined next while nothing changes. */
  private readonly refiner = new VolumeRefiner<Brick>();
  private hidden = false;
  private readonly gpu: VolumeGpu;
  private readonly offs: Array<() => void> = [];
  private readonly heldHere = new Set<THREE.Light>();
  private scannedChildren = -1;
  private disposed = false;
  /** Bricks updated a frame, by the measured cost of one. */
  private readonly pacing = new VolumePacing(START_BRICKS);
  /** The last dispatches timed: bricks of each level listed, the pass's ms and the wide reading's (diagnostics). */
  private readonly timings: number[][] = [];
  readonly stats = { updates: 0, bricksUpdated: 0, idleUpdated: 0, lastIdle: 0, texelsWritten: 0, marks: 0, lookedBlocks: 0, lookedCoarse: 0, frameMs: 0, lastBricks: 0, lastMs: 0, timedBricks: 0, timedMs: 0, shrunk: 0, settledAt: null as number | null, staleSince: performance.now() };

  constructor(private readonly deps: VoxelLightVolumeDeps) {
    this.gpu = new VolumeGpu(deps.device, deps.renderer, this.slotBudget());
    this.light = new VoxelVolumeLight(this.gpu, deps.read !== false);
    // What the looks give the volume now: a later record edit is held against it.
    this.looksChanged();
    // The held lights are marked before the light joins: the programs its joining builds again take them as held.
    if (this.light.read) this.holdAmbient(true);
    deps.scene.add(this.light);
    this.offs.push(
      // Present while it exists, as the cache's pass: a moving eye makes bricks stale between windows, so a reading taken
      // only while some are stale at the start missed the orbit's update.
      gpuPassHides.register({ category: 'lighting', name: 'voxel light volume', present: () => true, hide: (h) => (this.hidden = h) }),
      // Its GPU bytes are held against the two stores it replaces (the surface cache's, then the probes'); the grids kept for its colours are a share of the chunks drawn.
      residentBytes.register('surfaceCache', () => Math.min(this.gpu.bytes, this.budgets().surfaceCache)),
      residentBytes.register('probes', () => Math.max(0, this.gpu.bytes - this.budgets().surfaceCache)),
      residentBytes.register('voxelStream', () => this.pageBytes),
    );
  }

  /** The tier's surface cache and probe budgets (bytes; the volume holds their sum). */
  private budgets(): { surfaceCache: number; probes: number } {
    const tier = this.deps.level()?.lighting ?? 'low';
    const e = MEMORY_BUDGET_BY_TIER[tier].entries;
    return { surfaceCache: e.find((x) => x.id === 'surfaceCache')?.bytes ?? 0, probes: e.find((x) => x.id === 'probes')?.bytes ?? 0 };
  }

  /** Slots the budget holds (and the pool's largest texture). */
  private slotBudget(): number {
    const b = this.budgets();
    return Math.min(Math.floor((b.surfaceCache + b.probes) / SLOT_BYTES), MAX_TEXTURE_ROWS * VOLUME_BRICKS_PER_ROW);
  }

  /** Bytes on the page: the bricks' records, the index, the blocks' bits and the grids kept. */
  get pageBytes(): number {
    let cells = 0;
    for (const c of this.chunkCells.values()) if (typeof c !== 'number') cells += c.byteLength;
    return this.bricks.size * 48 + this.index.words.byteLength + this.blocks.size * 2 * 64 + cells;
  }

  /** A level-0 chunk's shader grid arrived (its draw or its shader data; null and −1: it went). */
  chunkGrid(cx: number, cy: number, cz: number, cells: Uint16Array | null, solid: number): void {
    threadProfiler.begin(VOLUME_GRIDS_SPAN);
    const key = `${cx},${cy},${cz}`;
    const was = this.chunkCells.get(key);
    if (cells === null && solid < 0) this.chunkCells.delete(key);
    else this.chunkCells.set(key, cells !== null ? cells.slice() : solid);
    this.gridChanges.add(key, was);
    threadProfiler.end(VOLUME_GRIDS_SPAN);
  }

  /**
   * A chunk's grid changed since the volume last saw `was`: a material changed where the walk saw nothing change (a
   * repaint) makes what its bounce reaches stale, and its bricks' colours are made again.
   */
  private gridChanged(key: string, was: Uint16Array | number | undefined): void {
    const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
    const next = this.chunkCells.get(key);
    if (was !== undefined && next !== undefined) {
      const box = changedCells(was, next);
      if (box !== null) this.markBoxes([[box[0].map((v, a) => Math.floor((v + [cx, cy, cz][a]! * 32) / 4)), box[1].map((v, a) => Math.floor((v + [cx, cy, cz][a]! * 32) / 4))]]);
    }
    const B = VOLUME_BLOCK_BRICKS;
    for (let x = 0; x < B; x++) for (let y = 0; y < B; y++) for (let z = 0; z < B; z++) {
      const b = this.bricks.get(volumeBrickKey(cx * B + x, cy * B + y, cz * B + z, 0));
      if (b !== undefined && b.slot >= 0) this.albedoDirty.add(b);
    }
  }

  /**
   * Before a batch's walk blocks go into the table: the level-0 blocks' cells as they were, to find what changed (a
   * block still waiting to be looked at keeps the cells of its first change).
   */
  beforeWalk(table: WalkTable, wires: readonly WalkBlockWire[]): Map<string, WalkBlockView | null> {
    threadProfiler.begin(VOLUME_WALK_SPAN);
    const was = new Map<string, WalkBlockView | null>();
    for (const w of wires) {
      const key = `${w.bx},${w.by},${w.bz}`;
      if (w.level === 0 && !this.walkChanges.has(key)) was.set(key, table.viewCopy(0, w.bx, w.by, w.bz, 'light'));
    }
    threadProfiler.end(VOLUME_WALK_SPAN);
    return was;
  }

  /** After them: the blocks' bits are read again when next needed, and what changed waits for the volume's slice. */
  afterWalk(_table: WalkTable, was: Map<string, WalkBlockView | null>): void {
    threadProfiler.begin(VOLUME_WALK_SPAN);
    for (const [key, before] of was) {
      this.blocks.delete(key);
      this.walkChanges.add(key, before);
    }
    threadProfiler.end(VOLUME_WALK_SPAN);
  }

  /** Walk blocks that changed, looked at while `more()` says so (one at least): their bricks looked at again and what their changed bricks reach marked. */
  private walkChanged(table: WalkTable, more: () => boolean): void {
    const boxes: Array<readonly [readonly number[], readonly number[]]> = [];
    this.walkChanges.drain(more, (key, before) => {
      const [bx, by, bz] = key.split(',').map(Number) as [number, number, number];
      const after = table.view(0, bx, by, bz, 'light');
      this.blocks.delete(key);
      const changed = volumeChangedBricks(before, after);
      if (changed.length === 0) return;
      // The block and those beside it (their bricks along its faces may be kept or not now).
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 1) this.toLook.set(`${bx + dx},${by + dy},${bz + dz}`, [bx + dx, by + dy, bz + dz]);
      // The coarse bricks over it and one brick round (a coarse brick is kept by what its neighbours hold too).
      for (let level = 1; level < VOLUME_LEVELS; level++) {
        const per = VOLUME_BLOCK_BRICKS >> level || 1;
        const c0 = [bx, by, bz].map((v) => Math.floor((v * VOLUME_BLOCK_BRICKS) / (1 << level)) - 1);
        for (let x = 0; x < per + 2; x++) for (let y = 0; y < per + 2; y++) for (let z = 0; z < per + 2; z++) this.lookCoarseLater(level, c0[0]! + x, c0[1]! + y, c0[2]! + z);
      }
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      const base = [bx * VOLUME_BLOCK_BRICKS, by * VOLUME_BLOCK_BRICKS, bz * VOLUME_BLOCK_BRICKS];
      for (const bi of changed) {
        const l = volumeBlockBrick(bi);
        for (let a = 0; a < 3; a++) {
          const v = base[a]! + l[a]!;
          if (v < lo[a]!) lo[a] = v;
          if (v > hi[a]!) hi[a] = v;
        }
      }
      boxes.push([lo, hi]);
    });
    this.markBoxes(boxes);
  }

  /**
   * Bricks a ray from which can reach the level-0 bricks lo … hi of any box are stale (those near a box from nothing,
   * the rest by the history rule), in one pass over the kept bricks (a batch's walk changes: a flight's start takes out
   * the blocks of the whole level-0 ring at once), the same as marking them one after another (`volumeMarkBoxes`). A
   * coarse brick is measured in its own bricks (the box's bricks of that level; near: the next brick).
   * `later`: a light's change (bricks that kept history while it continued start from nothing once it stops).
   */
  private markBoxes(list: ReadonlyArray<readonly [readonly number[], readonly number[]]>, later = false): void {
    if (list.length === 0) return;
    this.stats.marks += list.length;
    const continuing = this.history.change(this.frames);
    // Those beside an edit start from nothing whatever comes after (their cells may have turned solid or open).
    for (const b of volumeMarkBoxes(this.bricks.values(), list, MARK_REACH, VOLUME_SETTLE_UPDATES)) {
      if (b.updates === 0) this.history.restart(b);
      else this.history.marked(b, continuing, later);
    }
  }

  /** Every kept brick stale (`full`: from nothing; else as a change reaching all of them: the sun or the sky changed). */
  markAll(full: boolean): void {
    const continuing = full ? false : this.history.change(this.frames);
    for (const b of this.bricks.values()) {
      if (full) this.history.restart(b);
      else this.history.marked(b, continuing);
    }
    this.stats.marks++;
  }

  /** A block's brick bits (cached; null: the walk does not know it, open air). */
  private blockBits(bx: number, by: number, bz: number): VolumeBlockBricks | null {
    const key = `${bx},${by},${bz}`;
    let b = this.blocks.get(key);
    if (b === undefined) {
      const t = this.deps.walk()?.table ?? null;
      const v = t === null ? null : t.view(0, bx, by, bz, 'light');
      b = v === null ? null : volumeBlockBricks(v);
      this.blocks.set(key, b);
    }
    return b;
  }

  private readonly lookup = (bx: number, by: number, bz: number): VolumeBlockBricks | null => this.blockBits(bx, by, bz);

  /** The frame's share: the windows, keeping, the lights looked at, the update listed and dispatched. */
  frame(): void {
    if (this.disposed) return;
    const walk = this.deps.walk();
    const eye = this.light.eye;
    if (walk === null || walk.buffers() === null || !Number.isFinite(eye[0]!)) return;
    threadProfiler.begin(VOLUME_SPAN);
    const t0 = performance.now();
    this.frames++;
    for (let level = 0; level < VOLUME_LEVELS; level++) this.follow(level, eye);
    const slice = frameSliceMs('surfacePrepare');
    const more = (): boolean => performance.now() - t0 < slice;
    // What batches changed first (it may queue blocks to look at), then the looks.
    if (this.walkChanges.size > 0) this.walkChanged(walk.table, more);
    if (this.gridChanges.size > 0) this.gridChanges.drain(more, (key, was) => this.gridChanged(key, was));
    if (this.looks.waiting > 0) {
      // The bricks beside a material a record edit changed: written again, and what their light reaches marked.
      this.looks.drain(more, this.chunkCells, (lo, hi) => {
        for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
          const b = this.bricks.get(volumeBrickKey(x, y, z, 0));
          if (b !== undefined && b.slot >= 0) this.albedoDirty.add(b);
        }
        this.markBoxes([[lo, hi]]);
      });
    }
    this.look(more);
    if (this.light.read) this.holdAmbient();
    this.lights();
    this.history.frame(this.frames);
    if (this.albedoDirty.size > 0) {
      this.looks.write(this.albedoDirty, this.chunkCells, this.deps.look, this.bounce.means, this.gpu);
      this.gpu.glowing = this.looks.glowing;
      this.albedoDirty.clear();
    }
    this.index.publish();
    this.index.flush((words, rows) => this.gpu.writeIndex(words, rows));
    if (!this.hidden) this.buildLampLists();
    if (!this.hidden && (this.stale.size > 0 || !this.refiner.refined)) this.update(walk, eye);
    if (this.stale.size === 0 && this.lookWaiting() === 0 && this.stats.settledAt === null) this.stats.settledAt = performance.now();
    if (this.stale.size > 0) this.stats.settledAt = null;
    this.stats.frameMs = performance.now() - t0;
    threadProfiler.end(VOLUME_SPAN);
  }

  /** Level-0 blocks and coarse bricks waiting to be looked at, changes from batches waiting for the volume's slice, and bricks waiting to start again once changes stop. */
  private lookWaiting(): number {
    return this.toLook.size + this.toLookCoarse.size + this.walkChanges.size + this.gridChanges.size + this.looks.waiting + this.history.waiting;
  }

  /** A level's window onto the eye: a move drops the bricks that leave and queues what enters (level 0 by blocks). */
  private follow(level: number, eye: readonly number[]): void {
    const [W, H, D] = VOLUME_LEVEL_WINDOWS[level]!;
    const m = brickM(level);
    const origin = this.origins[level]!;
    const ey = Math.floor(eye[1]! / m);
    const win = this.wins[level]!;
    win.follow(eye[0]!, eye[2]!);
    const ox = Math.round(win.originX / m);
    const oz = Math.round(win.originZ / m);
    // Up: centred on the eye, lowered to keep the ground under a high eye in the window (the eye stays in it).
    const g = this.deps.ground(eye[0]!, eye[2]!);
    let oy = ey - (H >> 1);
    const margin = level === 0 ? 2 : 1;
    if (g !== null) {
      const gb = Math.floor(g / m);
      if (gb - margin < oy) oy = Math.max(gb - margin, ey - H + margin);
    }
    // Up and down by whole steps past a margin, so an eye bobbing in place does not move it.
    if (Number.isFinite(origin[1]!) && Math.abs(oy - origin[1]!) <= margin) oy = origin[1]!;
    if (ox === origin[0] && oy === origin[1] && oz === origin[2]) return;
    const was = [...origin];
    origin[0] = ox;
    origin[1] = oy;
    origin[2] = oz;
    this.gpu.setOrigin(level, origin);
    // Bricks that left: their slots go back, their index entries are cleared (the wrapped slot is another place's now).
    for (const [key, b] of this.bricks) if (b.level === level && !this.inWindow(level, b.bx, b.by, b.bz)) this.drop(key, b);
    const inOld = (x0: number, y0: number, z0: number, n: number): boolean => Number.isFinite(was[0]!) && x0 >= was[0]! && x0 + n <= was[0]! + W && y0 >= was[1]! && y0 + n <= was[1]! + H && z0 >= was[2]! && z0 + n <= was[2]! + D;
    if (level > 0) {
      for (let x = ox; x < ox + W; x++) for (let y = oy; y < oy + H; y++) for (let z = oz; z < oz + D; z++) if (!inOld(x, y, z, 1)) this.lookCoarseLater(level, x, y, z);
      return;
    }
    // Level 0: the blocks over the window's new part.
    const blocks = (o: readonly number[], a: number, n: number): [number, number] => [Math.floor(o[a]! / VOLUME_BLOCK_BRICKS), Math.floor((o[a]! + n - 1) / VOLUME_BLOCK_BRICKS)];
    const [x0, x1] = blocks(origin, 0, W);
    const [y0, y1] = blocks(origin, 1, H);
    const [z0, z1] = blocks(origin, 2, D);
    const B = VOLUME_BLOCK_BRICKS;
    for (let bx = x0; bx <= x1; bx++) for (let by = y0; by <= y1; by++) for (let bz = z0; bz <= z1; bz++) if (!inOld(bx * B, by * B, bz * B, B)) this.toLook.set(`${bx},${by},${bz}`, [bx, by, bz]);
  }

  private lookCoarseLater(level: number, bx: number, by: number, bz: number): void {
    this.toLookCoarse.set(volumeBrickKey(bx, by, bz, level), [level, bx, by, bz]);
  }

  private inWindow(level: number, bx: number, by: number, bz: number): boolean {
    const o = this.origins[level]!;
    const d = VOLUME_LEVEL_WINDOWS[level]!;
    return bx >= o[0]! && by >= o[1]! && bz >= o[2]! && bx < o[0]! + d[0] && by < o[1]! + d[1] && bz < o[2]! + d[2];
  }

  private drop(key: number, b: Brick): void {
    this.bricks.delete(key);
    this.stale.delete(b);
    this.history.forget(b);
    this.albedoDirty.delete(b);
    this.waitingSlots.delete(b);
    this.index.forget(b);
    if (b.slot >= 0) {
      this.setLampSlot(b, 0);
      this.listJobs.set(b.slot, null);
      this.giveSlot(b.slot);
    }
    // A published brick's entry is cleared wherever it lies: its wrapped place is the same however the window moved.
    if (b.published) this.index.set(b, 0);
  }

  /** Blocks and coarse bricks queued are looked at while `more()` says so (one at least): their bricks kept or dropped. */
  private look(more: () => boolean): void {
    let first = true;
    for (const [key, [bx, by, bz]] of this.toLook) {
      if (!first && !more()) return;
      first = false;
      this.toLook.delete(key);
      this.stats.lookedBlocks++;
      this.lookBlock(bx, by, bz);
    }
    let n = 0;
    for (const [key, [level, bx, by, bz]] of this.toLookCoarse) {
      // Coarse bricks are cheap to look at: the clock is read every 64.
      if ((n++ & 63) === 63 && !more()) return;
      this.toLookCoarse.delete(key);
      this.stats.lookedCoarse++;
      this.lookBrick(level, bx, by, bz, this.keeps(level, bx, by, bz));
    }
  }

  /** Whether a brick is kept: in its level's window and beside what stops light. */
  private keeps(level: number, bx: number, by: number, bz: number): boolean {
    return this.inWindow(level, bx, by, bz) && volumeLevelBrickKept(this.lookup, level, bx, by, bz);
  }

  private lookBlock(bx: number, by: number, bz: number): void {
    const B = VOLUME_BLOCK_BRICKS;
    // A block with nothing solid in it or its six neighbours keeps nothing: its 512 bricks are skipped.
    const any = (x: number, y: number, z: number): boolean => this.blockBits(x, y, z)?.some.some((w) => w !== 0) ?? false;
    const near = any(bx, by, bz) || any(bx + 1, by, bz) || any(bx - 1, by, bz) || any(bx, by + 1, bz) || any(bx, by - 1, bz) || any(bx, by, bz + 1) || any(bx, by, bz - 1);
    for (let x = 0; x < B; x++) for (let y = 0; y < B; y++) for (let z = 0; z < B; z++) {
      const gx = bx * B + x;
      const gy = by * B + y;
      const gz = bz * B + z;
      this.lookBrick(0, gx, gy, gz, near && this.keeps(0, gx, gy, gz));
    }
  }

  /** A brick kept (made, with a slot and from nothing, if it was not) or dropped. */
  private lookBrick(level: number, bx: number, by: number, bz: number, keep: boolean): void {
    const key = volumeBrickKey(bx, by, bz, level);
    const had = this.bricks.get(key);
    if (!keep) {
      if (had !== undefined) this.drop(key, had);
      return;
    }
    if (had !== undefined) return;
    const b: Brick = { level, bx, by, bz, slot: this.takeSlot(), updates: 0, samples: 0, published: false };
    if (b.slot >= 0) this.slotTaken(b);
    if (b.slot < 0) this.waitingSlots.add(b);
    // Coarse bricks' bounces read the level-0 cells' colours at their hits: they have none of their own.
    else if (level === 0) this.albedoDirty.add(b);
    this.bricks.set(key, b);
    this.markStale(b);
  }

  /** A brick to be updated toward its settle (nothing is refined while it waits). */
  private markStale(b: Brick): void {
    this.stale.add(b);
    this.refiner.changed();
  }

  /** A slot set free: a brick waiting for one takes it (from nothing), else it is kept for the next. */
  private giveSlot(slot: number): void {
    const w = this.waitingSlots.values().next();
    if (w.done === true) {
      this.freeSlots.push(slot);
      return;
    }
    const b = w.value;
    this.waitingSlots.delete(b);
    b.slot = slot;
    b.updates = 0;
    b.samples = 0;
    this.slotTaken(b);
    if (b.level === 0) this.albedoDirty.add(b);
  }

  /** A brick took a slot: its lamp list is built for it and its place in the lamp lists' index set. */
  private slotTaken(b: Brick): void {
    this.setLampSlot(b, b.slot + 1);
    this.listJobs.set(b.slot, b);
  }

  /** A brick's entry in the lamp lists' window index (its slot + 1, or 0) and its row marked for upload. */
  private setLampSlot(b: Brick, value: number): void {
    const i = this.index.place(b.level, b.bx, b.by, b.bz);
    this.lampSlots[i] = value;
    this.lampSlotsDirty.add(Math.floor(i / VOLUME_INDEX_WIDTH));
  }

  /** The lamp lists built for what changed (every brick's when the table did), before the update reads them. */
  private buildLampLists(): void {
    const lists = this.gpu.lamps;
    if (this.lampSlotsDirty.size > 0) {
      lists.writeSlots(this.lampSlots, this.lampSlotsDirty);
      this.lampSlotsDirty.clear();
    }
    const full = this.lampsChanged;
    if (full) for (const b of this.bricks.values()) if (b.slot >= 0) this.listJobs.set(b.slot, b);
    this.lampsChanged = false;
    if (this.listJobs.size > 0) {
      const jobs: VolumeLampListJob[] = [];
      for (const [slot, b] of this.listJobs) jobs.push({ slot, level: b?.level ?? 0, brick: b === null ? null : [b.bx, b.by, b.bz] });
      this.listJobs.clear();
      lists.build(jobs, full);
    }
    lists.count();
  }

  /** A free slot (−1: the pool is full; the brick waits for one). */
  private takeSlot(): number {
    const s = this.freeSlots.pop();
    if (s !== undefined) return s;
    if (this.nextSlot >= this.gpu.capacity) return -1;
    return this.nextSlot++;
  }

  /** On a page whose voxel worlds the volume lights, the scene's ambient and hemisphere lights are held by it (its sky holds their light). */
  private holdAmbient(now = false): void {
    // Looked at again when the scene's top level changed (lights are placed there), before a new light's programs build.
    if (!now && this.deps.scene.children.length === this.scannedChildren) return;
    this.scannedChildren = this.deps.scene.children.length;
    for (const o of this.deps.scene.children) {
      const l = o as THREE.Light & { isAmbientLight?: boolean; isHemisphereLight?: boolean };
      if ((l.isAmbientLight !== true && l.isHemisphereLight !== true) || this.heldHere.has(l) || isProbeHeld(l)) continue;
      markProbeHeld(l, true);
      this.heldHere.add(l);
    }
  }

  /** The sun, the sky and the lamps as the update reads them; a change marks what it reaches. */
  private lights(): void {
    const scene = this.deps.scene;
    this.sky.update(this.deps.renderer, scene);
    if (this.sky.version !== this.skyVersion) {
      this.skyVersion = this.sky.version;
      this.gpu.setSky(this.sky.coefficients);
      if (this.bricks.size > 0) this.markAll(false);
    }
    const sun = keyLight(scene);
    const s = this.gpu.sun;
    if (sun === null) s.fill(0);
    else {
      const d = new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
      s[0] = d.x;
      s[1] = d.y;
      s[2] = d.z;
      s[3] = sun.intensity > 0 && sun.visible ? 1 : 0;
      s[4] = sun.color.r * sun.intensity;
      s[5] = sun.color.g * sun.intensity;
      s[6] = sun.color.b * sun.intensity;
    }
    // Compared in 64 bits (the pass's copy is 32): a sun turned by a hundredth of a degree, or its light changed by a
    // hundredth, marks everything; an unlit sun's direction is not looked at.
    const w = this.sunWas;
    const lit = sun === null || !sun.visible ? 0 : sun.intensity * (sun.color.r + sun.color.g + sun.color.b);
    const dir = sun === null ? null : new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
    const turned = lit > 0 && dir !== null && dir.x * w[0]! + dir.y * w[1]! + dir.z * w[2]! < Math.cos((0.01 * Math.PI) / 180);
    if (turned || Math.abs(lit - w[3]!) > 0.01 * Math.max(w[3]!, 1e-3)) {
      if (dir !== null && lit > 0) {
        w[0] = dir.x;
        w[1] = dir.y;
        w[2] = dir.z;
      }
      w[3] = lit;
      if (this.bricks.size > 0) this.markAll(false);
    }
    if (this.frames % LAMP_LOOK_FRAMES !== 1) return;
    const next = volumeLampSet(this.deps.lamps?.() ?? null, windowBox(this.origins));
    if (next.key === this.lamps.key) return;
    // What a ray can reach the changed lamps' light from is stale (their reach, and the rays' past it: a cell outside a
    // lamp's reach bounces its light from a hit inside; with the reach alone the shut hut's spot left 16 % of its bounce
    // on the far wall's cells), and every brick's list is built again.
    const was = new Map(this.lamps.spheres.map((sp, i) => [this.lamps.data.subarray(i * VOLUME_LAMP_FLOATS, (i + 1) * VOLUME_LAMP_FLOATS).join(), sp] as const));
    const now = new Set(next.spheres.map((_, i) => next.data.subarray(i * VOLUME_LAMP_FLOATS, (i + 1) * VOLUME_LAMP_FLOATS).join()));
    const changed = [...[...was].filter(([k]) => !now.has(k)).map(([, sp]) => sp), ...next.spheres.filter((_, i) => !was.has(next.data.subarray(i * VOLUME_LAMP_FLOATS, (i + 1) * VOLUME_LAMP_FLOATS).join()))];
    this.lamps = next;
    this.gpu.lamps.setLamps(next);
    this.lampsChanged = true;
    this.markBoxes(changed.map((sp) => [[0, 1, 2].map((a) => Math.floor((sp[a]! - sp[3]!) / brickM(0))), [0, 1, 2].map((a) => Math.floor((sp[a]! + sp[3]!) / brickM(0)))] as const), true);
  }

  /**
   * The looks changed (a material record edit): each voxel id whose bounce colours or glow the volume reads changed is
   * looked for in the chunks' grids in the volume's slice, the cells beside it written again and what their light
   * reaches marked. The ms it took on this thread.
   */
  looksChanged(): number {
    const t0 = performance.now();
    this.looks.changed(this.deps.look, this.bounce.means, this.chunkCells.keys());
    return performance.now() - t0;
  }

  /**
   * The surfaces' albedo array and each voxel id's wall, floor and ceiling layer (null: none): its layers' mean colours
   * are measured once on the GPU, and from then on a textured look bounces its tint times its texture's mean (every
   * brick's colours made again, the light started again as for a change of the sun).
   */
  setBounceTextures(albedo: THREE.Texture | null, layers: ReadonlyMap<number, readonly [number, number, number]> | null): void {
    this.bounce.measure(this.deps.device, albedo === null ? null : gpuTextureOf(this.deps.renderer, albedo), albedo?.colorSpace === THREE.SRGBColorSpace, layers, () => {
      if (this.disposed) return;
      // Every brick is written again below: the looks as they read now are the ones held from here.
      this.looks.forget();
      this.looksChanged();
      for (const b of this.bricks.values()) if (b.level === 0 && b.slot >= 0) this.albedoDirty.add(b);
      if (this.bricks.size > 0) this.markAll(false);
    });
  }

  /**
   * Bricks listed for this frame's update and the pass dispatched: stale ones nearest the eye first, as many as the live
   * light's share holds; with room left, settled bricks refined (as many as its share while idle holds).
   */
  private update(walk: VoxelWalkGpu, eye: readonly number[]): void {
    const level = this.deps.level();
    const fb = level === null ? null : levelFrameBudget(level);
    const budget = fb === null ? 0 : gpuPassBudgetMs(fb, 'lighting');
    if (fb === null || budget <= 0) return;
    const n = this.pacing.bricks(budget);
    const list: Brick[] = [];
    if (this.stale.size > 0) {
      for (const bucket of volumeNearestFirst(this.stale, eye)) {
        for (const b of bucket) {
          if (list.length >= n) break;
          list.push(b);
        }
        if (list.length >= n) break;
      }
    }
    const stale = list.length;
    // With stale work under the share, refining fills the dispatch to it; with none, a dispatch of the same size on the
    // share of frames the idle share holds.
    const idle = stale > 0 ? n - stale : this.refiner.idleFrame(gpuPassIdleBudgetMs(fb, 'lighting') / budget) ? n : 0;
    if (idle > 0) this.refiner.take(() => this.bricks.values(), (b) => b.slot >= 0 && b.updates < VOLUME_HISTORY_UPDATES && !this.stale.has(b) && this.bricks.get(volumeBrickKey(b.bx, b.by, b.bz, b.level)) === b, eye, this.light.forward, idle, list);
    if (list.length === 0) return;
    const words = new Int32Array(list.length * VOLUME_LIST_WORDS);
    const f = new Float32Array(words.buffer);
    list.forEach((b, k) => {
      const o = k * VOLUME_LIST_WORDS;
      words[o] = b.bx;
      words[o + 1] = b.by;
      words[o + 2] = b.bz;
      words[o + 3] = b.slot;
      f[o + 4] = volumeBlendWeight(b.updates);
      words[o + 5] = b.samples;
      words[o + 6] = b.level;
      f[o + 7] = volumeFilterShare(b.updates);
    });
    const count = list.length;
    const byLevel = [0, 0, 0, 0];
    for (const b of list) byLevel[b.level]!++;
    this.gpu.dispatch(walk, words, count, this.frames, (ms) => {
      this.stats.lastMs = ms;
      this.timings.push([...byLevel, Number(ms.toFixed(3))]);
      if (this.timings.length > 16) this.timings.shift();
      this.stats.timedMs += ms;
      this.stats.timedBricks += count;
      this.pacing.read(count, ms);
    });
    for (const b of list) {
      if (b.updates === 0) this.index.firstUpdate(b);
      b.updates++;
      b.samples++;
      if (b.updates >= VOLUME_SETTLE_UPDATES) this.stale.delete(b);
    }
    this.stats.updates++;
    this.stats.bricksUpdated += list.length;
    this.stats.idleUpdated += list.length - stale;
    this.stats.lastBricks = list.length;
    this.stats.lastIdle = list.length - stale;
    this.stats.texelsWritten += list.length * VOLUME_BRICK_TEXELS;
  }

  /** How far the light has caught up (cheap: read every frame by a bench). */
  progress(): VoxelVolumeProgress {
    const settled = this.stale.size === 0 && this.lookWaiting() === 0 && this.bricks.size > 0;
    return { texelsWritten: this.stats.texelsWritten, staleUnits: this.stale.size, waiting: this.lookWaiting() + this.waitingSlots.size, probesSettled: settled, probesStale: 0, settled, refined: settled && this.refiner.refined };
  }

  /** What the volume holds now (diagnostics, benches, checks). */
  diagnostics(): Record<string, unknown> {
    const b = this.budgets();
    const levels = VOLUME_LEVEL_WINDOWS.map((d, l) => ({ cellM: volumeCellM(l), window: d.map((n) => n * brickM(l)), kept: 0, stale: 0, origin: [...this.origins[l]!] }));
    for (const k of this.bricks.values()) levels[k.level]!.kept++;
    for (const k of this.stale) levels[k.level]!.stale++;
    return {
      store: 'volume',
      kept: this.bricks.size,
      levels,
      slots: this.gpu.capacity,
      slotsUsed: this.nextSlot - this.freeSlots.length,
      stale: this.stale.size,
      waiting: this.lookWaiting() + this.waitingSlots.size,
      settled: this.progress().settled,
      origin: [...this.origins[0]!],
      perFrame: this.pacing.msPerBrick === null ? START_BRICKS : null,
      msPerBrick: this.pacing.msPerBrick,
      timings: this.timings,
      raysPerFace: VOLUME_RAYS,
      settleUpdates: VOLUME_SETTLE_UPDATES,
      historyUpdates: VOLUME_HISTORY_UPDATES,
      refined: this.progress().refined,
      refining: this.refiner.ordered,
      lamps: this.lamps.count,
      // Where a hit has no list (no kept brick of any level holds it with one: it loops over the whole table): past every
      // window (lamps whose reach goes past the windows' box), or a brick waiting for a slot.
      lampLists: { entries: VOLUME_LAMP_LIST_ENTRIES, bytes: this.gpu.lamps.bytes, ...this.gpu.lamps.stats, counts: this.gpu.lamps.lastCounts satisfies VolumeLampListCounts | null, lampsPastWindows: lampsPast(this.lamps, windowBox(this.origins)), waitingForSlot: this.waitingSlots.size },
      sun: [...this.gpu.sun],
      gpuBytes: this.gpu.bytes,
      pageBytes: this.pageBytes,
      budgetBytes: b.surfaceCache + b.probes,
      chunkGrids: this.chunkCells.size,
      // The sky's light on a surface facing up and down with nothing over it (the SH's irradiance), to check open cells by.
      skyUp: [0, 1, 2].map((k) => this.sky.coefficients[k]! * SH_E0 + this.sky.coefficients[3 + k]! * SH_E1),
      skyDown: [0, 1, 2].map((k) => this.sky.coefficients[k]! * SH_E0 - this.sky.coefficients[3 + k]! * SH_E1),
      looksChanged: this.looks.edits,
      looksChangedIds: this.looks.lastIds,
      glowing: this.looks.glowing,
      ...this.stats,
    };
  }

  /**
   * The volume's light in the scene's lights or out of them (a measurement: with it out, no lit program holds the
   * volume's node, so what the programs cost with it in is told from what the store's own work costs).
   */
  setLightShown(on: boolean): void {
    this.light.visible = on;
  }

  /** Every kept brick stale from nothing (a bench keeping the pass at work to measure it). */
  relightAll(): void {
    this.markAll(true);
  }

  /** Cells of `level` read back from the pool with the CPU's rule beside each (null: no walk yet). */
  async cells(points: readonly (readonly number[])[], level = 0): Promise<VoxelVolumeCell[] | null> {
    const t = this.deps.walk()?.table ?? null;
    if (t === null) return null;
    const src = t.source();
    const wanted = points.map((p) => {
      const c = [0, 1, 2].map((a) => Math.floor(p[a]! / volumeCellM(level)));
      const b = this.bricks.get(volumeBrickKey(c[0]! >> 2, c[1]! >> 2, c[2]! >> 2, level)) ?? null;
      return { c, b };
    });
    const rows = new Set<number>();
    for (const w of wanted) if (w.b !== null && w.b.slot >= 0) for (let f = 0; f < VOLUME_FACES; f++) rows.add(volumePoolTexel(w.b.slot, cellOf(w.c), f)[1]);
    const read = await this.gpu.readRows([...rows]);
    return wanted.map(({ c, b }) => {
      const faces: (number[] | null)[] = [];
      for (let f = 0; f < VOLUME_FACES; f++) {
        if (b === null || b.slot < 0) {
          faces.push(null);
          continue;
        }
        const [x, y] = volumePoolTexel(b.slot, cellOf(c), f);
        const word = read.get(y)?.[x] ?? 0;
        faces.push(word === 0 ? null : volumeDecode(word));
      }
      return { cell: c, kept: b !== null, slot: b?.slot ?? -1, updates: b?.updates ?? 0, holds: volumeLevelCellHolds(src, level, c[0]!, c[1]!, c[2]!), faces };
    });
  }

  /**
   * The lamp lists of the bricks of `level` holding `points` (metres) read back from the GPU, the CPU's rule for each
   * beside it (null: no walk yet).
   */
  async lampLists(points: readonly (readonly number[])[], level = 0): Promise<VoxelVolumeLampList[] | null> {
    if (this.deps.walk() === null) return null;
    const seen = new Map<number, Brick | [number, number, number]>();
    for (const p of points) {
      const c = [0, 1, 2].map((a) => Math.floor(p[a]! / brickM(level))) as [number, number, number];
      const key = volumeBrickKey(c[0], c[1], c[2], level);
      if (!seen.has(key)) seen.set(key, this.bricks.get(key) ?? c);
    }
    const slots = [...seen.values()].filter((b): b is Brick => !Array.isArray(b) && b.slot >= 0).map((b) => b.slot);
    const lamps = this.lamps;
    const pendingAll = this.lampsChanged;
    const read = await this.gpu.lamps.readSlots(slots);
    return [...seen.values()].map((b) => {
      const brick = Array.isArray(b) ? b : [b.bx, b.by, b.bz];
      const slot = Array.isArray(b) ? -1 : b.slot;
      const gpu = slot >= 0 ? (read.get(slot) ?? null) : null;
      const at = (gpu?.listed ?? []).map((i) => [...lamps.data.subarray(i * VOLUME_LAMP_FLOATS, i * VOLUME_LAMP_FLOATS + 3)]);
      return { brick, kept: slot >= 0, slot, pending: pendingAll || this.listJobs.has(slot), gpu, cpu: volumeBrickLamps(lamps.data, lamps.count, brick[0]!, brick[1]!, brick[2]!, undefined, level), at };
    });
  }

  /**
   * The CPU reference beside the volume (a check, seconds of page time): at the cells of the room round `eye` (or the
   * cells given; `grid`: the floor's cells on a grid of that step within that span), each cell face's light read back
   * from the GPU and the path-traced reference's for each variant (its rays, bounces, reaches and colours), with where
   * its rays ended.
   */
  async reference(o: { eye?: readonly number[]; cells?: readonly VolumeCheckCell[]; grid?: { step: number; span: number }; variants: readonly VolumeReferenceVariant[] }): Promise<unknown> {
    const t = this.deps.walk()?.table ?? null;
    if (t === null) return null;
    const src = t.source();
    const cells = o.cells ?? (o.eye === undefined ? [] : volumeRoomCells(src, o.eye, 12, o.grid?.step, o.grid?.span));
    const gpu = await this.cells(cells.map((c) => c.cell.map((v) => (v + 0.5) * VOXEL_SIZE_M)));
    const entry = (x: number, y: number, z: number): number => {
      const g = this.chunkCells.get(`${x >> 5},${y >> 5},${z >> 5}`);
      if (g === undefined) return 0;
      return typeof g === 'number' ? g : g[(((x & 31) + 1) * 34 + ((z & 31) + 1)) * 34 + ((y & 31) + 1)]!;
    };
    const out = [];
    for (const [i, c] of cells.entries()) {
      const variants: Record<string, unknown> = {};
      for (const v of o.variants) {
        const means: VolumeBounceMeans | null = v.colours === 'looks' ? null : v.means === undefined ? this.bounce.means : new Map(Object.entries(v.means).map(([k, m]) => [Number(k), m] as const));
        const colours = new VolumeColourCache(this.deps.look, means);
        const albedo = (air: readonly number[], face: number): readonly number[] => {
          if (v.albedo === 'cells') {
            const [x, y, z] = air as [number, number, number];
            const g = this.chunkCells.get(`${x >> 5},${y >> 5},${z >> 5}`);
            return volumeColourRgb(g === undefined || typeof g === 'number' ? 0 : volumeCellColour(g, [x >> 5, y >> 5, z >> 5], x, y, z, colours));
          }
          const axis = face >> 1;
          const sgn = (face & 1) === 1 ? -1 : 1;
          const s = [...air];
          s[axis]! -= sgn;
          const e = entry(s[0]!, s[1]!, s[2]!);
          return volumeColourRgb(e === 0 ? 0 : colours.word(e, axis !== 1 ? 0 : sgn > 0 ? 1 : 2));
        };
        const glow = (air: readonly number[], face: number): readonly number[] => {
          const [x, y, z] = air as [number, number, number];
          if (v.albedo === 'cells') {
            const g = this.chunkCells.get(`${x >> 5},${y >> 5},${z >> 5}`);
            return volumeDecode(g === undefined || typeof g === 'number' ? 0 : volumeCellGlow(g, [x >> 5, y >> 5, z >> 5], x, y, z, colours));
          }
          const s = [x, y, z];
          s[face >> 1]! -= (face & 1) === 1 ? -1 : 1;
          const e = entry(s[0]!, s[1]!, s[2]!);
          return e === 0 ? [0, 0, 0] : (colours.glow(e) ?? [0, 0, 0]);
        };
        const world: VolumeLightWorld = { src, sky: this.sky.coefficients, sun: this.gpu.sun, lamps: this.lamps.data, lampCount: this.lamps.count, albedo, glow };
        const counts: VolumeReferenceCounts = { rays: 0, sky: 0, lost: 0, hits: 0, past: 0, sunLit: 0 };
        const t0 = performance.now();
        const rgb = volumeReferenceFace(world, c.cell, c.face, { rays: v.rays, bounces: v.bounces, updateReach: VOLUME_RAY_REACH_M, ...(v.reach !== undefined ? { reach: v.reach } : {}), ...(v.sunReach !== undefined ? { sunReach: v.sunReach } : {}) }, counts);
        variants[v.name] = { rgb: rgb.map((x) => Number(x.toPrecision(4))), counts, ms: Math.round(performance.now() - t0) };
      }
      out.push({ ...c, gpu: gpu?.[i]?.faces[c.face] ?? null, updates: gpu?.[i]?.updates ?? 0, variants });
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    for (const l of this.heldHere) markProbeHeld(l, false);
    this.heldHere.clear();
    this.light.removeFromParent();
    this.sky.dispose();
    this.gpu.dispose();
    this.bricks.clear();
    this.stale.clear();
    this.chunkCells.clear();
    this.gridChanges.clear();
    this.walkChanges.clear();
  }
}

/** The box (metres, low and high corners) every level's window covers, from each level's corner brick. */
function windowBox(origins: readonly (readonly number[])[]): [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  VOLUME_LEVEL_WINDOWS.forEach((d, l) => {
    const o = origins[l]!;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, o[a]! * brickM(l));
      hi[a] = Math.max(hi[a]!, (o[a]! + d[a]!) * brickM(l));
    }
  });
  return [lo, hi];
}

/** Lamps of a table whose reach goes past the box lo … hi (the windows': their light there is in no list). */
function lampsPast(lamps: VolumeLampSet, [lo, hi]: readonly [readonly number[], readonly number[]]): number {
  return lamps.spheres.filter(([x, y, z, r]) => [x!, y!, z!].some((v, a) => v - r! < lo[a]! || v + r! > hi[a]!)).length;
}

/** Metres a brick of `level` spans. */
function brickM(level: number): number {
  return volumeCellM(level) * 4;
}

/** A ray's reach in each level's bricks: how far a change marks bricks stale. */
const MARK_REACH: readonly number[] = VOLUME_LEVEL_WINDOWS.map((_, l) => Math.ceil(VOLUME_RAY_REACH_M / brickM(l)));

function cellOf(c: readonly number[]): number {
  return (c[0]! & 3) + 4 * ((c[1]! & 3) + 4 * (c[2]! & 3));
}

/** The chunk cells (0 … 31) whose shader entries differ between two grids (a grid or its one entry), as a box (null: none). */
function changedCells(a: Uint16Array | number, b: Uint16Array | number): [number[], number[]] | null {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? null : [[0, 0, 0], [31, 31, 31]];
  const side = 34;
  const at = (g: Uint16Array | number, i: number): number => (typeof g === 'number' ? g : g[i]!);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
    const i = ((x + 1) * side + (z + 1)) * side + (y + 1);
    if (at(a, i) === at(b, i)) continue;
    const c = [x, y, z];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, c[k]!);
      hi[k] = Math.max(hi[k]!, c[k]!);
    }
  }
  return lo[0] === Infinity ? null : [lo, hi];
}

/** The scene's key light: the first shadow-casting directional light at its top, else the first directional one. */
function keyLight(scene: THREE.Scene): THREE.DirectionalLight | null {
  let first: THREE.DirectionalLight | null = null;
  for (const o of scene.children) {
    const l = o as THREE.DirectionalLight;
    if (l.isDirectionalLight !== true) continue;
    if (l.castShadow) return l;
    first ??= l;
  }
  return first;
}

// ---------------------------------------------------------------------------------------------------------------
// The GPU side

/** The pool, the colours, the index and the update pass on three's device. */
class VolumeGpu {
  readonly pool: THREE.StorageTexture;
  readonly albedo: THREE.StorageTexture;
  /** The cells' glow words (as the colours: a word a cell, 0 none), read by the update only while {@link glowing}. */
  readonly glow: THREE.StorageTexture;
  /** Some kept cell glows: the update's rays read the glow words (none does: they are not read). */
  glowing = false;
  readonly indexTex: THREE.StorageTexture;
  readonly capacity: number;
  /** Toward the sun (xyz), on (w); its colour × intensity. */
  readonly sun = new Float32Array(7);
  private readonly skyCoefficients = new Float32Array(12);
  /** The lamp table and the lamp lists. */
  readonly lamps: VolumeLampLists;
  /** Each level's window corner brick (the update finds bricks' slots and lamp lists through them). */
  private readonly origins = VOLUME_LEVEL_WINDOWS.map(() => [0, 0, 0]);
  /** The update's pipelines, without and with the area lights' code (each made when first needed). */
  private readonly pipelines: [{ getBindGroupLayout(i: number): unknown } | null, { getBindGroupLayout(i: number): unknown } | null] = [null, null];
  private readonly params: GpuBuffer;
  private list: GpuBuffer | null = null;
  private bind: { group: unknown; key: readonly unknown[] } | null = null;
  private readonly query: unknown;
  private readonly stamps: GpuBuffer | null;
  private timing = false;
  /** The read's uniforms: each level's window corner brick (made once, given to the light's node). */
  readonly originNodes: N[] = VOLUME_LEVEL_WINDOWS.map(() => uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup));

  constructor(
    private readonly device: VolumeDevice,
    private readonly renderer: RegionTextureRenderer,
    budgetSlots: number,
  ) {
    this.capacity = Math.min(POOL_SLOTS, budgetSlots);
    this.lamps = new VolumeLampLists(device, this.capacity);
    this.pool = uintTexture(VOLUME_POOL_WIDTH, Math.ceil(this.capacity / VOLUME_BRICKS_PER_ROW), 'voxel light volume');
    this.albedo = uintTexture(VOLUME_ALBEDO_WIDTH, Math.ceil(this.capacity / VOLUME_BRICKS_PER_ROW), 'voxel light volume colours');
    this.glow = uintTexture(VOLUME_ALBEDO_WIDTH, Math.ceil(this.capacity / VOLUME_BRICKS_PER_ROW), 'voxel light volume glows');
    this.indexTex = uintTexture(VOLUME_INDEX_WIDTH, VOLUME_INDEX_ROWS, 'voxel light volume index');
    this.pipelineFor(false);
    this.params = device.createBuffer({ size: VOLUME_PARAM_FLOATS * 4, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume params' });
    const timed = device.features?.has('timestamp-query') === true && device.createQuerySet !== undefined;
    this.query = timed ? device.createQuerySet!({ type: 'timestamp', count: 2 }) : null;
    this.stamps = timed ? device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.QUERY_RESOLVE | GPU_BUFFER_USAGE.COPY_SRC, label: 'voxel light volume timestamps' }) : null;
    gpuTextureOf(renderer, this.pool);
    gpuTextureOf(renderer, this.albedo);
    gpuTextureOf(renderer, this.glow);
    gpuTextureOf(renderer, this.indexTex);
  }

  /** The update's pipeline with (`areas`) or without the area lights' code. */
  private pipelineFor(areas: boolean): { getBindGroupLayout(i: number): unknown } {
    const k = areas ? 1 : 0;
    const had = this.pipelines[k];
    if (had !== null) return had;
    const label = areas ? 'voxel light volume (area lights)' : 'voxel light volume';
    const device = this.device;
    const module = device.createShaderModule({ code: volumeUpdateWgsl(areas), label }) as { getCompilationInfo?(): Promise<{ messages: ReadonlyArray<{ type: string; lineNum: number; message: string }> }> };
    void module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) if (m.type === 'error') console.error(`${label} WGSL, line ${m.lineNum}: ${m.message}`);
    });
    const made = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
    this.pipelines[k] = made;
    return made;
  }

  /** GPU bytes: the pool, the colours, the glows, the index, the pass's buffers and the lamps' (the lists counted in the slots). */
  get bytes(): number {
    return this.capacity * SLOT_BYTES + INDEX_TEXELS * 4 + (this.list?.size ?? 0) + VOLUME_PARAM_FLOATS * 4 + this.lamps.bytes - this.lamps.lists.size;
  }

  setOrigin(level: number, o: readonly number[]): void {
    const own = this.origins[level]!;
    own[0] = o[0]!;
    own[1] = o[1]!;
    own[2] = o[2]!;
    (this.originNodes[level]!.value as THREE.Vector3).set(o[0]!, o[1]!, o[2]!);
  }

  setSky(c: Float32Array): void {
    this.skyCoefficients.set(c);
  }

  writeAlbedo(slot: number, words: Uint32Array): void {
    uploadTextureRegion(this.renderer, this.albedo, words, { x: (slot % VOLUME_BRICKS_PER_ROW) * VOLUME_BRICK_VOLUME, y: Math.floor(slot / VOLUME_BRICKS_PER_ROW), z: 0, width: VOLUME_BRICK_VOLUME, height: 1, depth: 1 }, 4);
  }

  writeGlow(slot: number, words: Uint32Array): void {
    uploadTextureRegion(this.renderer, this.glow, words, { x: (slot % VOLUME_BRICKS_PER_ROW) * VOLUME_BRICK_VOLUME, y: Math.floor(slot / VOLUME_BRICKS_PER_ROW), z: 0, width: VOLUME_BRICK_VOLUME, height: 1, depth: 1 }, 4);
  }

  writeIndex(index: Uint32Array, rows: Iterable<number>): void {
    const w = INDEX_WIDTH;
    for (const y of rows) uploadTextureRegion(this.renderer, this.indexTex, index.subarray(y * w, (y + 1) * w), { x: 0, y, z: 0, width: w, height: 1, depth: 1 }, 4);
  }

  /** The update of `count` listed bricks dispatched (its GPU ms given to `timed` once read, at most one reading in flight). */
  dispatch(walk: VoxelWalkGpu, words: Int32Array, count: number, frame: number, timed: (ms: number) => void): boolean {
    const wb = walk.buffers();
    if (wb === null) return false;
    const d = this.device;
    const STORAGE = GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST;
    this.list = grownGpuBuffer(d, this.list, Math.max(words.byteLength, 256), STORAGE, 'voxel light volume bricks');
    d.queue.writeBuffer(this.list, 0, words);
    const lamps = this.lamps;
    const p = new Float32Array(VOLUME_PARAM_FLOATS);
    const pi = new Int32Array(p.buffer);
    const pu = new Uint32Array(p.buffer);
    pi.set([this.origins[0]![0]!, this.origins[0]![1]!, this.origins[0]![2]!, count, VOLUME_WINDOW_BRICKS[0], VOLUME_WINDOW_BRICKS[1], VOLUME_WINDOW_BRICKS[2], VOLUME_RAYS], 0);
    p.set([this.sun[0]!, this.sun[1]!, this.sun[2]!, this.sun[3]!, this.sun[4]!, this.sun[5]!, this.sun[6]!, VOLUME_SUN_REACH_M], 8);
    for (let b = 0; b < 4; b++) p.set([this.skyCoefficients[b * 3]!, this.skyCoefficients[b * 3 + 1]!, this.skyCoefficients[b * 3 + 2]!, 0], 16 + b * 4);
    p.set([VOLUME_RAY_REACH_M, lamps.lampCount, BOUNCE_ALBEDO, frame], 32);
    pu.set([wb.maxLevel, this.glowing ? 1 : 0, VOLUME_INDEX_WIDTH, VOLUME_ALBEDO_WIDTH], 36);
    for (let l = 1; l < VOLUME_LEVELS; l++) pi.set([...this.origins[l]!, 0], VOLUME_PARAM_COARSE + (l - 1) * 4);
    d.queue.writeBuffer(this.params, 0, p);
    const pool = gpuTextureOf(this.renderer, this.pool) as { createView(): unknown } | null;
    const albedo = gpuTextureOf(this.renderer, this.albedo) as { createView(): unknown } | null;
    const glow = gpuTextureOf(this.renderer, this.glow) as { createView(): unknown } | null;
    const index = gpuTextureOf(this.renderer, this.indexTex) as { createView(): unknown } | null;
    if (pool === null || albedo === null || glow === null || index === null) return false;
    const pipeline = this.pipelineFor(lamps.hasAreas);
    const key = [wb.table, wb.pages, pool, albedo, glow, index, this.list, lamps.lampBuffer, pipeline];
    if (this.bind === null || this.bind.key.some((k, i) => k !== key[i])) {
      this.bind = {
        key,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.params } },
            { binding: 1, resource: { buffer: this.list } },
            { binding: 2, resource: { buffer: lamps.lampBuffer } },
            { binding: 3, resource: { buffer: wb.table } },
            { binding: 4, resource: { buffer: wb.pages } },
            { binding: 5, resource: pool.createView() },
            { binding: 6, resource: index.createView() },
            { binding: 7, resource: albedo.createView() },
            { binding: 8, resource: { buffer: lamps.lists } },
            { binding: 9, resource: { buffer: lamps.slots } },
            { binding: 10, resource: glow.createView() },
          ],
        }),
      };
    }
    const enc = d.createCommandEncoder();
    const time = this.query !== null && this.stamps !== null && !this.timing;
    const pass = enc.beginComputePass(time ? { label: 'voxel light volume', timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : { label: 'voxel light volume' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bind.group);
    (pass as unknown as { dispatchWorkgroups(x: number, y: number): void }).dispatchWorkgroups(count, VOLUME_FACES);
    pass.end();
    let read: GpuBuffer | null = null;
    if (time) {
      read = d.createBuffer({ size: 16, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume timestamps read' });
      enc.resolveQuerySet!(this.query, 0, 2, this.stamps!, 0);
      enc.copyBufferToBuffer(this.stamps!, 0, read, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    if (read !== null) {
      this.timing = true;
      const r = read;
      r.mapAsync(GPU_MAP_READ).then(
        () => {
          const t = new BigUint64Array(r.getMappedRange().slice(0));
          r.unmap();
          r.destroy();
          this.timing = false;
          const ms = Number(t[1]! - t[0]!) / 1e6;
          if (ms > 0) timed(ms);
        },
        () => {
          r.destroy();
          this.timing = false;
        },
      );
    }
    return true;
  }

  /** Whole pool rows read back (a check of what the pass wrote). */
  async readRows(rows: readonly number[]): Promise<Map<number, Uint32Array>> {
    const out = new Map<number, Uint32Array>();
    const pool = gpuTextureOf(this.renderer, this.pool) as GpuTexture | null;
    if (pool === null || rows.length === 0) return out;
    const d = this.device;
    const bytes = VOLUME_POOL_WIDTH * 4;
    const buf = d.createBuffer({ size: bytes * rows.length, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume read' });
    const enc = d.createCommandEncoder();
    rows.forEach((y, k) => enc.copyTextureToBuffer!({ texture: pool, origin: { x: 0, y, z: 0 } }, { buffer: buf, offset: k * bytes, bytesPerRow: bytes, rowsPerImage: 1 } as { buffer: GpuBuffer; bytesPerRow: number; rowsPerImage: number }, { width: VOLUME_POOL_WIDTH, height: 1, depthOrArrayLayers: 1 }));
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPU_MAP_READ);
    const all = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap();
    buf.destroy();
    rows.forEach((y, k) => out.set(y, all.subarray((k * bytes) / 4, ((k + 1) * bytes) / 4)));
    return out;
  }

  dispose(): void {
    for (const b of [this.params, this.list, this.stamps]) b?.destroy();
    this.lamps.dispose();
    (this.query as { destroy?(): void } | null)?.destroy?.();
    this.pool.dispose();
    this.albedo.dispose();
    this.glow.dispose();
    this.indexTex.dispose();
  }
}

/** The index texture's width and its texels (every level's window, stacked by rows). */
const INDEX_WIDTH = VOLUME_INDEX_WIDTH;
const INDEX_TEXELS = INDEX_WIDTH * VOLUME_INDEX_ROWS;

function uintTexture(width: number, height: number, name: string): THREE.StorageTexture {
  const t = new THREE.StorageTexture(width, height);
  t.format = THREE.RedIntegerFormat;
  t.type = THREE.UnsignedIntType;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// The read

/** The volume as a light of the scene: lit programs find its node among their lights (and are built again when it comes). */
export class VoxelVolumeLight extends THREE.Light {
  readonly isVoxelLightVolume = true;
  /** The eye of the last frame drawn (world metres; NaN before one) and the way it looks (unit). */
  readonly eye = [NaN, NaN, NaN];
  readonly forward = [0, 0, -1];
  constructor(readonly gpu: VolumeGpu, readonly read: boolean) {
    super(0xffffff, 0);
    this.name = 'voxel light volume';
  }
}

/** The light node of {@link VoxelVolumeLight}: the voxel surfaces' read, built after every light the volume does not hold. */
class VoxelVolumeLightNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'VoxelVolumeLightNode';
  }
  readonly isVoxelLightVolumeNode = true;
  private readonly pool: N;
  private readonly index: N;

  constructor(readonly light: VoxelVolumeLight) {
    super();
    this.pool = texelTexture(light.gpu.pool);
    this.index = texelTexture(light.gpu.indexTex);
    this.updateType = TSL.NodeUpdateType.RENDER;
  }

  update(frame: { camera?: THREE.Camera | null }): void {
    const c = frame.camera;
    if (c === null || c === undefined) return;
    const e = this.light.eye;
    e[0] = c.matrixWorld.elements[12]!;
    e[1] = c.matrixWorld.elements[13]!;
    e[2] = c.matrixWorld.elements[14]!;
    const m = c.matrixWorld.elements;
    const len = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
    this.light.forward[0] = -m[8]! / len;
    this.light.forward[1] = -m[9]! / len;
    this.light.forward[2] = -m[10]! / len;
  }

  setup(builder: N): void {
    const m = builder.material as { userData?: Record<string, unknown> } | undefined;
    // Every lit draw reads it (voxel surfaces, kit pieces, props, moving objects: one light for all) but one that says
    // not to: a screen-space shade whose pixel is not its geometry's (the far field's).
    if (!this.light.read || m?.userData?.[VOLUME_READ_KEY] === false || builder.renderer?.backend?.isWebGPUBackend !== true) return;
    const ctx = builder.context;
    const r = volumeReadLevels(this.pool, this.index, this.light.gpu.originNodes, positionWorld, normalWorldGeometry.normalize(), normalWorld);
    const w = r.weight;
    const replaced = ctx.irradiance.sub(KEPT_IRRADIANCE).add(ctx.iblIrradiance);
    const darker = luminance(r.light).div(max(luminance(replaced), float(1e-4))).clamp(0, 1);
    ctx.radiance.mulAssign(mix(float(1), darker, w));
    ctx.irradiance.assign(mix(ctx.irradiance, KEPT_IRRADIANCE.add(r.light), w));
    ctx.iblIrradiance.mulAssign(w.oneMinus());
  }
}

/** A pool word's light (TSL; the CPU twin is `volumeDecode`). */
function decodeNode(w: N): N {
  const scale = TSL.exp2(float(w.shiftRight(uint(27))).sub(VOLUME_WORD.expBias + VOLUME_WORD.mantissaBits));
  return vec3(float(w.bitAnd(uint(511))), float(w.shiftRight(uint(9)).bitAnd(uint(511))), float(w.shiftRight(uint(18)).bitAnd(uint(511)))).mul(scale);
}

/**
 * The surfaces' read of one level (TSL; the CPU reference is `volumeReadAt`): the light at `p` facing `n`, from the
 * eight cells of the level round the point half a cell off it along `ng`, and the weight of those holding light.
 */
function volumeRead(level: number, pool: N, index: N, origin: N, p: N, ng: N, n: N): { light: N; weight: N } {
  const cellM = volumeCellM(level);
  const win = VOLUME_LEVEL_WINDOWS[level]!;
  const tag = `tlVolume${level}`;
  const g = p.add(ng.mul(VOLUME_READ_OFFSET_CELLS * cellM)).div(cellM).sub(0.5);
  const i0 = g.floor().toVar(`${tag}Cell`);
  const f = g.sub(i0).toVar(`${tag}Frac`);
  const sum = vec3(0).toVar(`${tag}Sum`);
  const ws = float(0).toVar(`${tag}Weights`);
  const dims = vec3(win[0], win[1], win[2]);
  const fx = select(n.x.lessThan(0), uint(1), uint(0));
  const fy = select(n.y.lessThan(0), uint(3), uint(2));
  const fz = select(n.z.lessThan(0), uint(5), uint(4));
  const word = (base: N, face: N): N => {
    const i = base.add(face);
    return pool.load(ivec2(int(i.mod(uint(VOLUME_POOL_WIDTH))), int(i.div(uint(VOLUME_POOL_WIDTH))))).x;
  };
  for (let k = 0; k < 8; k++) {
    const pick = (a: 'x' | 'y' | 'z', bit: number): N => (((k >> bit) & 1) === 1 ? f[a] : f[a].oneMinus());
    const w = pick('x', 0).mul(pick('y', 1)).mul(pick('z', 2));
    If(w.greaterThan(1e-4), () => {
      const c = i0.add(vec3((k >> 0) & 1, (k >> 1) & 1, (k >> 2) & 1));
      const b = c.div(4).floor();
      const inside = b.greaterThanEqual(origin).all().and(b.lessThan(origin.add(dims)).all());
      If(inside, () => {
        const s = b.sub(dims.mul(b.div(dims).floor()));
        const slot = index.load(ivec2(int(s.x.add(s.z.mul(win[0]))), int(s.y).add(VOLUME_INDEX_ROW_BASE[level]!))).x;
        If(slot.greaterThan(uint(0)), () => {
          const l = c.sub(b.mul(4));
          const local = uint(l.x.add(l.y.mul(4)).add(l.z.mul(16)));
          const base = slot.sub(uint(1)).mul(uint(VOLUME_BRICK_TEXELS)).add(local.mul(uint(VOLUME_FACES))).toVar();
          const wx = word(base, fx).toVar();
          If(wx.notEqual(uint(0)), () => {
            const lx = decodeNode(wx);
            const ly = decodeNode(word(base, fy));
            const lz = decodeNode(word(base, fz));
            const e = ambientCubeSteps(TSL_SCALAR_OPS, n.x, n.y, n.z, [lx, lx, ly, ly, lz, lz]);
            sum.addAssign(e.mul(w));
            ws.addAssign(w);
          });
        });
      });
    });
  }
  return { light: sum.div(max(ws, float(1e-4))), weight: ws };
}

/**
 * The read over the levels (TSL; the CPU reference is `volumeReadLevels`): level 0, then each coarser level for what the
 * finer ones left (a level takes the smooth step of its weight to {@link VOLUME_FULL_WEIGHT} of what is left; a coarse
 * level is not read once less than {@link VOLUME_LEFT_MIN} is left, so a surface beside its 0.5 m cells reads only them).
 * Returns the light and the weight it holds (0: no level holds light here; the flat term stays).
 */
function volumeReadLevels(pool: N, index: N, origins: readonly N[], p: N, ng: N, n: N): { light: N; weight: N } {
  const acc = vec3(0).toVar('tlVolumeLight');
  const left = float(1).toVar('tlVolumeLeft');
  for (let level = 0; level < VOLUME_LEVELS; level++) {
    const read = (): void => {
      const r = volumeRead(level, pool, index, origins[level]!, p, ng, n);
      const a = smoothstep(float(0), float(VOLUME_FULL_WEIGHT), r.weight);
      acc.addAssign(r.light.mul(a.mul(left)));
      left.mulAssign(a.oneMinus());
    };
    if (level === 0) read();
    else If(left.greaterThan(VOLUME_LEFT_MIN), read);
  }
  const weight = left.oneMinus().toVar('tlVolumeWeight');
  return { light: acc.div(max(weight, float(1e-4))), weight };
}

/** Teach a renderer the volume's light. */
export function registerVoxelLightVolume(): void {
  VoxelVolumeLight.registerNode(VoxelVolumeLightNode as never);
}

