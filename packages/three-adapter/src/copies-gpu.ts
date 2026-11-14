/**
 * Stored copies drawn on the GPU: rule scatter's baked copies (trees, rocks)
 * and the instance brush's hand-placed sets. One draw per mesh of the model
 * and level; their places come from the data (a copy texture), not from a
 * hash.
 *
 * - **WebGPU: rows of the culled-instance table.** At its first draw a set
 *   asks the scene's table (`occlusion-instances.ts`) to take it: its copies
 *   are then picked in compute every frame (level with hysteresis and a
 *   cross-fade, thinning, frustum, and the depth pyramid where occlusion
 *   culling runs; `copy-rows.ts`, `copy-rows-select.ts`) and its draws read
 *   their lists through indirect draws (`copy-rows-draw.ts`). The page only
 *   hides the draws no copy can reach now, and picks the blocks' levels of a
 *   set whose blocks draw one level each.
 * - **WebGL 2 (no compute): the vertex stage.** Per frame (when the view or
 *   the set changed) the page lists, per draw, the blocks of copies
 *   (`copies-prepare.ts`) whose levels it may draw, and the vertex stage
 *   places each instance, chooses the copy's level by its own distance and
 *   size (the shared screen-size rule, without hysteresis) and thins it by
 *   its rank (`cover-gpu.ts`'s placement hook applies it). Each list holds the
 *   blocks the view sees first, then the other candidates (a shadow map needs
 *   casters off screen), then, for the most detailed level, every other block
 *   (a cached static shadow map draws every copy at that level). Which part a
 *   pass draws is chosen right before it (`onBeforeRender`).
 *
 * A rule's `shadowDistance` draws its copies near the eye again into the
 * moving shadow map only (shadow-only draws, culled past the distance).
 *
 * Every draw of every set shares one vertex stage per path: what differs per
 * draw (its textures or rows, eye, level, distances) is bound per object, so
 * the sets of a scene build one program per material and vertex layout.
 *
 * Copies keep an identity only where something asks for one: a ray picks a
 * copy, an editor writes one (`setCopies`), the diagnostics count them. Those
 * walk the copies on the page when asked, never per frame.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { RenderObjectRefreshType } from 'three';
import { NodeMaterial, StorageBufferAttribute, type NodeBuilder } from 'three/webgpu';
import { INTERACTOR_DEFAULTS, INSTANCE_FLOATS } from '@thirdlight/project-model';
import { lodLevelOf, lodLevelStep } from '@thirdlight/shared';

import { CULLED_COPIES_KEY, INSTANCE_CULLER_KEY, PAINT_SLOT_ATTRIBUTE, setGpuCopyColumns } from './attribute-instancing';
import { buildDrawsCopyRows, COPY_ROW_KEY, COPY_ROWS_ATTRIBUTE, installCopyRows, rowsColumn, rowsIndex, rowsPlacement, type CopyRowDraw } from './copy-rows-draw';
import type { CopyRowsMesh, CopyRowsSource } from './copy-rows';
import { type CopyCamera, type CopyRowBinding, type InstanceOcclusion } from './occlusion-instances';
import { vertexReachOf } from './vertex-reach';
import { CUTAWAY_LAYER } from './block-cutaway-view';
import { BLOCK_FLOATS, COPY_ROW, COPY_TEXEL_FLOATS, COPY_TEXELS, copyDensityAt, copyDensitySteps, copyRank, measureBlock, prepareCopies, writeCopyTexels, type PreparedCopies } from './copies-prepare';
import { COVER_DRAW_KEY, installCoverPlacement, type CoverPlacement } from './cover-gpu';
import { COPY_ROW_FLOATS } from './copy-rows-rule';
import { disposeSharingGeometry } from './dispose';
import type { N } from './effects-tsl';
import { TSL_SCALAR_OPS } from './field-ops';
import { INSTANCE_SET_KEY, instanceSetPlan, type BuiltInstanceSet, type InstancePlanOptions, type InstanceSetOptions, type InstanceSetPlan, type InstanceSetStats } from './instancing';
import { TAN_HALF_REFERENCE } from './instance-lod';
import { lodSwitchesOf, LodTuning, pickLodLevel, type LodSwitch } from './lod-switch';
import { KEEP_MATERIAL_KEY } from './material-keys';
import { setCopyBend, setCopyRoot } from './node-materials';
import { PAINT_COPIES_KEY, PAINT_MESH_KEY, PAINT_STREAM_KEY } from './vertex-paint-draw';
import { maxScaleOf, SphereSide, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, type CullView, type ViewCullable } from './view-cull';
import { addRefreshRule, type NeedsRefresh } from './observer-refresh';
import { texelTexture } from './texel-texture-node';
import type { ModelInstance } from './visual';
import type { WarmDraw } from './program-warmer';

const TSL: N = TSLTyped;
const { Fn, Loop, abs, float, instanceIndex, int, ivec2, length, max, modelWorldMatrix, normalLocal, normalize, positionLocal, positionPrevious, select, uint, uniform, vec3, vec4 } = TSL;

/** `mesh.userData[GPU_COPIES_KEY]`: the draw's state its vertex stage binds ({@link CopyDraw}). */
export const GPU_COPIES_KEY = '__tlGpuCopies';
/** The marker attribute of a copies draw's geometry: its program is its own (the source's position, never read under this name). */
const GPU_COPIES_ATTRIBUTE = 'tlGpuCopies';
/** Entries a row of a draw's list texture holds. */
const LIST_ROW = 1024;
/**
 * Texels a list's header starts with: copies per block, reach (m), world
 * scale and how readily the copies give way to subjects; the level it
 * draws, the group's level count, whether the last level culls and how the
 * level is decided; the density falloff. The group's switch distances
 * follow, four a texel, as many as its model has levels; then the entries.
 */
const LIST_FIXED_HEADER = 3;
/** Texels before a list's entries for a LOD group of `levels` levels. */
const listHeaderTexels = (levels: number): number => LIST_FIXED_HEADER + Math.ceil(levels / 4);
/**
 * How long a row draw stays shown after no block could reach its level (ms): longer than a level's cross-fade and
 * than the table's read-back of its lists' counts, which keeps it shown while the GPU still counts copies there.
 */
const COPY_ROW_SHOWN_MS = 1500;
/** A switch distance never reached (a slot past the model's levels). */
const NEVER = 3.4e38;

const floatTexture = (data: Float32Array, width: number, height: number): THREE.DataTexture => {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
};

/**
 * What a draw binds before it has data (never read: its list is empty). One
 * each: three keys a texture uniform by its texture, so two nodes built with
 * the same one would share one binding.
 */
const NO_COPIES = floatTexture(new Float32Array(4), 1, 1);
const NO_LIST = floatTexture(new Float32Array(4), 1, 1);
/** A row draw's pools before it has any (never read: it draws nothing then). */
const NO_STORAGE = new StorageBufferAttribute(new Uint32Array(4), 1);

/** One draw's per-object inputs (vec4s, so a draw updates a handful of uniforms). */
interface CopyDraw {
  readonly set: GpuCopySet;
  readonly list: CopyList;
  readonly local: THREE.Matrix4;
}

const drawOf = (object: THREE.Object3D | null | undefined): CopyDraw | undefined => object?.userData[GPU_COPIES_KEY] as CopyDraw | undefined;
const copiesTexture: N = texelTexture(NO_COPIES);
const listTexture: N = texelTexture(NO_LIST);
const ZERO4 = new THREE.Vector4(0, 0, 0, 0);
const IDENTITY = new THREE.Matrix4();
/**
 * The view's eye (world xyz) and metres → level units (w: over its zoom and
 * the project's bias): one value for every draw of the frame, so a moving
 * view refreshes no draw's own bindings.
 */
const viewEye = new THREE.Vector4(0, 0, 0, 1);
const uEye: N = uniform(viewEye);

/**
 * Whether the pass is a cached static shadow map's (1) or not (0); and on the
 * way the draw's textures are bound (its set's copies, its list). Everything
 * else a draw reads is its list's header: a draw updates two uniforms.
 */
const uStatic: N = uniform(0).onObjectUpdate(({ object, camera }: { object: THREE.Object3D; camera?: THREE.Camera | null }) => {
  const d = drawOf(object);
  copiesTexture.value = d?.set.texture ?? NO_COPIES;
  listTexture.value = d?.list.texture ?? NO_LIST;
  return camera?.userData[STATIC_SHADOW_CAMERA_KEY] === true ? 1 : 0;
});
const uLocal: N = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }: { object: THREE.Object3D }) => drawOf(object)?.local ?? IDENTITY);

/** This instance's copy: its texels, slot and whether it is drawn by this draw (vertex stage). */
function copyNodes(): { kept: N; pos: N; quat: N; scale: N; paint: N; slot: N; bend: N } {
  // The list's header (its first row's first texels): see `writeHeader`.
  const head = (i: number): N => listTexture.load(ivec2(i, 0));
  const h0 = head(0);
  const uLevel = head(1);
  const uDensity = head(2);
  const distanceTexels = uint(uLevel.y).add(3).div(4);
  const B = uint(h0.x);
  const idx = uint(instanceIndex);
  const b = idx.div(B);
  const k = idx.sub(b.mul(B));
  const e = b.add(uint(LIST_FIXED_HEADER)).add(distanceTexels);
  const entry = listTexture.load(ivec2(int(e.mod(uint(LIST_ROW))), int(e.div(uint(LIST_ROW)))));
  const slot = uint(entry.x).add(k);
  const col = int(slot.mod(uint(COPY_ROW))).mul(COPY_TEXELS);
  const row = int(slot.div(uint(COPY_ROW)));
  const t0 = copiesTexture.load(ivec2(col, row));
  const t1 = copiesTexture.load(ivec2(col.add(1), row));
  const t2 = copiesTexture.load(ivec2(col.add(2), row));
  const world = modelWorldMatrix.mul(vec4(t0.xyz, 1)).xyz;
  const metres = length(world.sub(uEye.xyz));
  // Vars, so the copy's reads are made once before the level loop rather than in it.
  const d = metres.mul(uEye.w).toVar();
  const s = max(max(abs(t2.x), abs(t2.y)), abs(t2.z)).mul(h0.z).toVar();
  const isStatic = uStatic.greaterThan(0.5);
  // The shared screen-size rule (`lodLevelStep`), switch by switch; this path keeps no level per copy (no hysteresis).
  const reached = float(0).toVar();
  const open = float(1).toVar();
  Loop({ start: uint(1), end: uint(uLevel.y), type: 'uint', condition: '<' }, ({ i }: { i: N }) => {
    const at = listTexture.load(ivec2(int(i.div(4)).add(LIST_FIXED_HEADER), 0));
    const m = i.mod(4);
    const switchAt = select(m.equal(0), at.x, select(m.equal(1), at.y, select(m.equal(2), at.z, at.w)));
    const acc = lodLevelStep(TSL_SCALAR_OPS, { level: reached, open }, d, switchAt.mul(s), float(0));
    reached.assign(acc.level);
    open.assign(acc.open);
  });
  const level = select(isStatic, float(0), reached);
  const last = uLevel.y.sub(1);
  const culled = uLevel.z.greaterThan(0.5).and(level.greaterThanEqual(last));
  // Mode 0: the copy's own level is the draw's; 1: every listed copy not past its cull size (a mesh outside the levels, or
  // the list's blocks are at its level).
  const mine = select(uLevel.w.greaterThan(0.5), culled.not(), abs(level.sub(uLevel.x)).lessThan(0.5).and(culled.not()));
  // The rule of `copyDensityAt` (a static map keeps every copy).
  const share = copyDensitySteps(TSL_SCALAR_OPS, d, uDensity.x.mul(s), uDensity.y.mul(s), uDensity.z);
  const thins = uDensity.w.greaterThan(0.5).and(isStatic.not());
  const keep = select(thins, t0.w.lessThan(share), float(1).greaterThan(0));
  const kept = float(k).lessThan(entry.y).and(mine).and(keep).and(metres.lessThanEqual(h0.y)).and(s.greaterThan(0));
  return { kept, pos: t0.xyz, quat: t1, scale: t2.xyz, paint: t2.w, slot, bend: h0.w };
}

/** `v` turned by unit quaternion `q`. */
const rotate = (q: N, v: N): N => {
  const t = TSL.cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(TSL.cross(q.xyz, t));
};

/** A scale safe to divide by (a copy shrunk to nothing is not drawn anyway). */
const safeScale = (s: N): N => select(abs(s).lessThan(1e-6), vec3(1), s);

/** The placement every copies draw shares: the copy's matrix times the mesh's place in the model, or nothing when not kept. */
const copiesPlacement: CoverPlacement = {
  place: Fn((builder: NodeBuilder) => {
    const c = copyNodes();
    setCopyRoot(builder, c.pos);
    setCopyBend(builder, c.bend);
    const p = uLocal.mul(vec4(positionLocal, 1)).xyz;
    positionLocal.assign(select(c.kept, rotate(c.quat, p.mul(c.scale)).add(c.pos), c.pos));
    const b = builder as unknown as { needsPreviousData?: () => boolean; hasGeometryAttribute?: (name: string) => boolean };
    // Velocity passes: the copies stand still (their previous place is this one).
    if (b.needsPreviousData?.() === true) {
      const pp = uLocal.mul(vec4(positionPrevious, 1)).xyz;
      positionPrevious.assign(select(c.kept, rotate(c.quat, pp.mul(c.scale)).add(c.pos), c.pos));
    }
    if (b.hasGeometryAttribute?.('normal') !== false) normalLocal.assign(normalize(rotate(c.quat, normalize(uLocal.mul(vec4(normalLocal, 0)).xyz).div(safeScale(c.scale)))));
  }, 'void') as unknown as () => void,
};

/** Column `i` of the copy's matrix as an instance set's columns hold it (column 0's w: the paint slot); zero when not kept. */
function copyColumn(i: number): N {
  const c = copyNodes();
  if (i === 3) return vec4(c.pos, 1);
  const axis = i === 0 ? vec3(c.scale.x, 0, 0) : i === 1 ? vec3(0, c.scale.y, 0) : vec3(0, 0, c.scale.z);
  const col = select(c.kept, rotate(c.quat, axis), vec3(0));
  return vec4(col, i === 0 ? c.paint : float(0));
}

/** What a copies draw's render object last bound (its set's revision and its textures' versions). */
const boundSeen = new WeakMap<object, { set: GpuCopySet; revision: number; copies: number; list: THREE.Texture; listVersion: number }>();

/**
 * A full refresh whenever what a copies draw binds changed since its last
 * draw, else three's own answer: three updates an object's uniforms and
 * bindings only when its observer sees a change it knows of, and a draw's
 * eye, lists and copies are none of those.
 */
function refreshOnCopiesChange(base: NeedsRefresh): NeedsRefresh {
  return (renderObject, frame) => {
    const refresh = base(renderObject, frame);
    const d = drawOf(renderObject.object);
    if (d === undefined) return refresh;
    const was = boundSeen.get(renderObject);
    if (was !== undefined && was.set === d.set && was.revision === d.set.revision && was.copies === d.set.texture.version && was.list === d.list.texture && was.listVersion === d.list.texture.version) return refresh;
    const now = { set: d.set, revision: d.set.revision, copies: d.set.texture.version, list: d.list.texture, listVersion: d.list.texture.version };
    if (was === undefined) boundSeen.set(renderObject, now);
    else Object.assign(was, now);
    return RenderObjectRefreshType.FULL;
  };
}

let installed = false;

/** Teach the node materials to draw copies sets (idempotent). */
export function installGpuCopies(): void {
  if (installed) return;
  installed = true;
  installCoverPlacement();
  installCopyRows();
  addRefreshRule('gpu-copies', (needs, builder) => (drawOf((builder as unknown as { object?: THREE.Object3D | null }).object) !== undefined && !buildDrawsCopyRows(builder) ? refreshOnCopiesChange(needs) : null));
  // A set adopted by the culled-instance table reads its copies as the table's rows (WebGPU); else from its texture.
  setGpuCopyColumns({
    has: (builder) => drawOf((builder as unknown as { object?: THREE.Object3D | null }).object) !== undefined,
    column: (i) => Fn((builder: NodeBuilder) => (buildDrawsCopyRows(builder) ? rowsColumn(i) : copyColumn(i)))(),
    index: () => Fn((builder: NodeBuilder) => (buildDrawsCopyRows(builder) ? rowsIndex() : copyNodes().slot))(),
  });
}

/** A list of blocks one or more draws (meshes of one level) share. */
interface CopyList {
  /** The LOD group and level it draws (group -1: the meshes outside every group, drawn unless the copy is culled). */
  readonly group: number;
  readonly level: number;
  /** Copies past this many metres are not listed or drawn (a near-shadow list; else infinite). */
  readonly reach: number;
  /** A cached static shadow map draws every block from it (the most detailed level of a set's own draws). */
  readonly staticAll: boolean;
  /** How its vertex stage decides a copy's level: 0 its own is the list's, 1 every listed copy drawn unless past its cull size (the list holds its blocks). */
  readonly mode: number;
  /** Texels before its entries (`listHeaderTexels`). */
  readonly header: number;
  data: Float32Array;
  texture: THREE.DataTexture;
  /** Blocks the view sees, candidates (seen or not), and all listed (with the rest for a static map). */
  nView: number;
  nCand: number;
  nAll: number;
  /** Copies in the blocks the view sees (diagnostics). */
  copiesInView: number;
  /** Drawn as table rows: shown until then (ms; a fade out of its level may still be running). */
  shownUntil: number;
}

/** How a copies set is made: an instance set's options, its copies prepared ahead (a worker's), and a shadow-only draw near the eye. */
export interface GpuCopySetOptions extends InstanceSetOptions, InstancePlanOptions {
  /**
   * Each copy takes its own level by its own distance and size (else each
   * block of copies one level, picked at its centre for its copies' mean
   * size: a block across a switch point is listed once, not in two draws).
   */
  readonly lodPerCopy?: boolean;
  readonly preparedCopies?: PreparedCopies;
  /** Also draw the copies within this many metres of the eye into the moving shadow maps only (shadow-only draws). */
  readonly shadowDistance?: number;
  /** How readily a foliage material's copies give way to the view's subjects (a scatter rule's `bendAway`; absent: 1). */
  readonly bendAway?: number;
}

/** A built copies set: an instance set's surface, culled once a frame through its draws. */
export interface GpuCopySetHandle extends BuiltInstanceSet {
  /** The shadow-only draws near the eye (empty without a `shadowDistance`). */
  readonly nearShadows: readonly THREE.Mesh[];
  /** The draws its own (not the near shadows'). */
  readonly drawMeshes: readonly THREE.Mesh[];
  /**
   * Its own draws held for a precompile (program-warmer.ts): a level no copy draws at yet has its program built
   * too. `built` holds the keys of the programs built so far (a set's draws share theirs with every set of the
   * same material and layout).
   */
  warmDraw(built: Set<string>): WarmDraw;
}

const scratchV = new THREE.Vector3();
const scratchM = new THREE.Matrix4();
const scratchQ = new THREE.Quaternion();
const scratchS = new THREE.Vector3();
const scratchP = new THREE.Vector3();
const scratchSphere = new THREE.Sphere();

/** Copies drawn on the GPU (see the module's header). */
export class GpuCopySet {
  readonly group = new THREE.Group();
  readonly texture: THREE.DataTexture;
  /** Eye (world xyz) and metres → level units; the density factors; copies per block; the world scale. */
  readonly eye = new THREE.Vector4();
  readonly density = new THREE.Vector4(0, 0, 1, 0);
  readonly block: number;
  worldScale = 1;
  /** Bumped whenever what its draws bind changed (the eye, a copy, the world scale): their render objects refresh. */
  revision = 0;
  private readonly plan: InstanceSetPlan;
  private readonly prepared: PreparedCopies;
  private readonly slotOf: Int32Array;
  /** Each slot's block. */
  private readonly blockOf: Int32Array;
  /** Whether each copy picks its own level; else each block's level per LOD group (-1: none yet) and its copies' mean scale. */
  private readonly perCopy: boolean;
  private readonly blockLevels: Int16Array;
  /** Each LOD group's switches as the block picks read them. */
  private readonly switches: readonly (readonly LodSwitch[])[];
  private readonly blockMean: Float32Array;
  private readonly lists: CopyList[] = [];
  private readonly draws: { mesh: THREE.Mesh; list: CopyList; part: InstanceSetPlan['parts'][number]; near: boolean; geometry: THREE.InstancedBufferGeometry; binding: CopyRowBinding; row: CopyRowDraw }[] = [];
  /**
   * The culled-instance table drawing this set's copies as its rows (WebGPU: picked in compute, every copy at its
   * own level), asked at the first draw; null: drawn by the vertex stage from the lists below (WebGL 2, or no table).
   */
  private table: InstanceOcclusion | null = null;
  private adoptTried = false;
  /** The view culler culled the set since the table last asked whether it is shown (it is in the scene). */
  private culledSinceAsked = false;
  /** What the table reads of this set (its source). */
  private readonly rowsSource: CopyRowsSource;
  /** The farthest a model's point lies from its origin at scale 1 (most detailed level). */
  private readonly reach: number;
  private readonly tuning: LodTuning;
  private view: CullView | null = null;
  private stamp = -1;
  private tuningRevision = -1;
  private readonly world = new Float64Array(16).fill(Number.NaN);
  private dirty = true;
  private disposed = false;
  private statsCache: { key: string; stats: InstanceSetStats } | null = null;
  private scratch: { near: Float32Array; seen: Uint8Array; lo: Int16Array; hi: Int16Array } | null = null;
  /** What the view culler calls once a frame for all of the set's draws. */
  private readonly culler: ViewCullable = { cull: (view) => this.cull(view) };

  constructor(
    template: ModelInstance,
    count: number,
    floats: Float32Array,
    readonly name: string,
    private readonly options: GpuCopySetOptions,
  ) {
    installGpuCopies();
    this.plan = instanceSetPlan(template, options);
    this.tuning = options.tuning ?? new LodTuning();
    const paint = options.paint;
    const chunking = { ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}), ...(options.copiesPerChunk !== undefined ? { copiesPerChunk: options.copiesPerChunk } : {}) };
    this.prepared = options.preparedCopies ?? prepareCopies(floats, count, chunking, paint !== undefined ? (copy) => paint.slotOf(copy) + 1 : undefined);
    const p = this.prepared;
    this.block = p.block;
    this.slotOf = new Int32Array(p.count);
    p.order.forEach((copy, slot) => (this.slotOf[copy] = slot));
    this.perCopy = options.lodPerCopy === true;
    const nb = p.blocks.length / BLOCK_FLOATS;
    this.blockMean = new Float32Array(nb);
    for (let b = 0; b < nb; b += 1) {
      let sum = 0;
      const first = p.blocks[b * BLOCK_FLOATS + 6]!;
      const n = p.blocks[b * BLOCK_FLOATS + 7]!;
      for (let slot = first; slot < first + n; slot += 1) sum += Math.max(Math.abs(p.texels[slot * COPY_TEXEL_FLOATS + 8]!), Math.abs(p.texels[slot * COPY_TEXEL_FLOATS + 9]!), Math.abs(p.texels[slot * COPY_TEXEL_FLOATS + 10]!));
      this.blockMean[b] = n > 0 ? sum / n : 0;
    }
    this.blockLevels = new Int16Array(nb * Math.max(1, this.plan.groups.length)).fill(-1);
    this.switches = this.plan.groups.map((g) => lodSwitchesOf(g.distances));
    this.blockOf = new Int32Array(p.count);
    for (let b = 0; b < p.blocks.length / BLOCK_FLOATS; b++) this.blockOf.fill(b, p.blocks[b * BLOCK_FLOATS + 6]!, p.blocks[b * BLOCK_FLOATS + 6]! + p.blocks[b * BLOCK_FLOATS + 7]!);
    this.texture = floatTexture(p.texels, COPY_ROW * COPY_TEXELS, p.texels.length / (COPY_ROW * COPY_TEXEL_FLOATS));
    this.group.name = name;
    // The model's reach from its origin (its blocks' spheres grow by it, times each copy's scale).
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const part of this.plan.parts) {
      if (part.level !== 0) continue;
      const g = part.mesh.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      box.union(b.copy(g.boundingBox!).applyMatrix4(part.local));
    }
    this.reach = box.isEmpty() ? 0 : Math.max(box.min.length(), box.max.length(), Math.hypot(box.max.x, box.min.y, box.min.z), Math.hypot(box.min.x, box.max.y, box.max.z), Math.hypot(box.min.x, box.min.y, box.max.z), Math.hypot(box.max.x, box.max.y, box.min.z), Math.hypot(box.max.x, box.min.y, box.max.z), Math.hypot(box.min.x, box.max.y, box.min.z));
    const dens = this.plan.density;
    if (dens !== null && this.plan.radius > 0) this.density.set(this.plan.radius / (TAN_HALF_REFERENCE * dens.start), this.plan.radius / (TAN_HALF_REFERENCE * dens.end), dens.min, 1);
    const blocks = p.blocks.length / BLOCK_FLOATS;
    const listOf = (group: number, level: number, reach: number, staticAll: boolean, mode: number): CopyList => {
      let l = this.lists.find((x) => x.group === group && x.level === level && x.reach === reach);
      if (l === undefined) {
        const header = listHeaderTexels(this.groupOf(group)?.distances.length ?? 1);
        const rows = Math.max(1, Math.ceil((header + blocks) / LIST_ROW));
        const data = new Float32Array(rows * LIST_ROW * 4);
        this.lists.push((l = { group, level, reach, staticAll, mode, header, data, texture: floatTexture(data, LIST_ROW, rows), nView: 0, nCand: 0, nAll: 0, copiesInView: 0, shownUntil: 0 }));
        this.writeHeader(l);
      }
      return l;
    };
    const makeDraw = (part: InstanceSetPlan['parts'][number], near: boolean): void => {
      const group = part.lod;
      const level = group >= 0 ? part.level : 0;
      const reach = near ? options.shadowDistance! : Number.POSITIVE_INFINITY;
      // Near shadows draw every copy in reach at the most detailed level (a shadow-only pass: no level to pick).
      const mode = near || !this.perCopy || group < 0 ? 1 : 0;
      const list = listOf(group, level, reach, !near && (group < 0 || level === 0), mode);
      const source = part.mesh.geometry;
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.name = source.name;
      for (const [n, a] of Object.entries(source.attributes)) geometry.setAttribute(n, a);
      if (source.index !== null) geometry.setIndex(source.index);
      for (const gr of source.groups) geometry.addGroup(gr.start, gr.count, gr.materialIndex);
      geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
      const position = source.getAttribute('position');
      geometry.setAttribute(GPU_COPIES_ATTRIBUTE, position);
      // A painted mesh's draw reads its stream (a program of its own, as the CPU sets' painted draws).
      const meshKey = part.mesh.userData[PAINT_MESH_KEY] as string | undefined;
      const stream = meshKey === undefined ? undefined : paint?.stream(meshKey);
      if (stream !== undefined) geometry.setAttribute(PAINT_SLOT_ATTRIBUTE, position);
      geometry.instanceCount = 0;
      const mesh = new THREE.Mesh(geometry, part.mesh.material);
      mesh.name = part.mesh.name;
      mesh.frustumCulled = false;
      mesh.castShadow = near;
      mesh.receiveShadow = !near;
      if (near) mesh.layers.set(CUTAWAY_LAYER);
      if (part.mesh.userData[KEEP_MATERIAL_KEY] === true) mesh.userData[KEEP_MATERIAL_KEY] = true;
      if (stream !== undefined) {
        mesh.userData[PAINT_STREAM_KEY] = stream;
        // Its slot marker is the mesh's position (it only keys the program): the painted copies are read from their texels.
        mesh.userData[PAINT_COPIES_KEY] = (): number => this.paintedCopies();
      }
      const draw: CopyDraw = { set: this, list, local: part.local.clone() };
      mesh.userData[GPU_COPIES_KEY] = draw;
      mesh.userData[COVER_DRAW_KEY] = copiesPlacement;
      // Culled through the set (one listing a frame for all its draws); the frame probe reads the copies the view sees once per list.
      const firstOfList = !this.draws.some((x) => x.list === list);
      const firstOfSet = this.draws.length === 0;
      const set = this;
      mesh.userData[VIEW_CULL_KEY] = {
        cull: (): boolean => false,
        group: this.culler,
        get inView(): number {
          return set.table !== null ? (firstOfSet ? set.table.copySets.inViewOf(set.rowsSource) : 0) : firstOfList ? list.copiesInView : 0;
        },
      };
      mesh.userData[INSTANCE_SET_KEY] = true;
      const binding: CopyRowBinding = { mode: 0, list: 0, row: null };
      const pools = { matrices: NO_STORAGE, slots: NO_STORAGE, lists: NO_STORAGE, visible: NO_STORAGE, counts: NO_STORAGE };
      const row: CopyRowDraw = { binding, local: draw.local, bend: options.bendAway ?? INTERACTOR_DEFAULTS.ruleBend, pools: () => {
          // One object, refreshed in place: asked for every draw every frame.
          const t = this.table;
          if (t === null || binding.row === null) return null;
          pools.matrices = binding.row.matrices;
          pools.slots = binding.row.slots;
          pools.lists = binding.row.lists;
          const extra = t.copyBuffers();
          pools.visible = extra.state;
          pools.counts = extra.counts;
          return pools;
        } };
      mesh.onBeforeRender = (_r, scene, camera) => {
        if (this.table === null && !this.adoptTried) this.adopt(scene);
        if (this.table !== null && binding.row !== null) {
          this.table.drawCopies(binding.row, geometry, this.cameraKind(camera), binding);
          return;
        }
        geometry.instanceCount = this.blocksFor(list, camera, mesh) * this.block;
      };
      // A ray picks the copies of the most detailed level's meshes (one hit per copy and mesh).
      // A ray picks a copy once, through whichever of the set's own draws is shown (the most detailed level's meshes test it).
      mesh.raycast = near ? () => undefined : (raycaster, hits) => this.raycastFrom(mesh, raycaster, hits);
      this.group.add(mesh);
      this.draws.push({ mesh, list, part, near, geometry, binding, row });
    };
    for (const part of this.plan.parts) makeDraw(part, false);
    if (options.shadowDistance !== undefined) for (const part of this.plan.parts) if (part.mesh.userData[KEEP_MATERIAL_KEY] !== true && (part.lod < 0 || part.level === 0)) makeDraw(part, true);
    this.updateBounds();
    this.rowsSource = this.makeRowsSource();
  }

  /** What the culled-instance table reads of this set (copy-rows.ts). */
  private makeRowsSource(): CopyRowsSource {
    const set = this;
    const p = this.prepared;
    const groups = this.plan.groups.map((g) => ({ distances: g.distances, culls: g.culls }));
    const meshes: CopyRowsMesh[] = this.draws.map((d) => ({ mesh: d.mesh, group: d.part.lod, level: d.part.lod >= 0 ? d.part.level : 0, near: d.near, staticAll: d.list.staticAll }));
    return {
      count: p.count,
      groups,
      meshes,
      get copiesVersion() {
        return set.revision;
      },
      writeCopies: (target, at) => {
        for (let slot = 0; slot < p.count; slot += 1) {
          const t = slot * COPY_TEXEL_FLOATS;
          const o = (at + slot) * COPY_ROW_FLOATS;
          for (let k = 0; k < 12; k += 1) target[o + k] = p.texels[t + k]!;
          target[o + 12] = Math.max(Math.abs(p.texels[t + 8]!), Math.abs(p.texels[t + 9]!), Math.abs(p.texels[t + 10]!));
          // Its block's place among the blocks' levels (block-major, a level per group), where blocks pick for their copies.
          target[o + 13] = set.blockOf[slot]! * Math.max(1, groups.length);
          target[o + 14] = 0;
          target[o + 15] = 1;
        }
        return null;
      },
      get world() {
        return set.draws[0]!.mesh.matrixWorld;
      },
      modelReach: this.reach,
      get density() {
        const d = set.density;
        return d.w > 0.5 ? { from: d.x, to: d.y, min: d.z } : null;
      },
      nearReach: this.options.shadowDistance ?? null,
      blockLevels: () => (set.perCopy ? null : set.blockLevels),
      tuning: this.tuning,
      vertexReach: () => {
        let r = 0;
        for (const d of set.draws) {
          const v = vertexReachOf(d.mesh);
          if (v === null) return null;
          r = Math.max(r, v);
        }
        return r;
      },
      // In the scene this frame: the view culler (which hears what the render graph attaches) culled it since asked.
      shown: () => {
        const was = set.culledSinceAsked;
        set.culledSinceAsked = false;
        return !set.disposed && was;
      },
      released: () => set.unadopt(),
    };
  }

  /** The scene's culled-instance table takes the set's draws as its rows, if there is one that can (asked at the first draw). */
  private adopt(scene: THREE.Scene | null): void {
    this.adoptTried = true;
    const host = scene?.userData[INSTANCE_CULLER_KEY] as Partial<InstanceOcclusion> | undefined;
    if (typeof host?.adoptCopies !== 'function' || !host.adoptCopies(this.rowsSource)) return;
    const table = host as InstanceOcclusion;
    this.table = table;
    for (const d of this.draws) {
      d.binding.row = table.copySets.rowOf(this.rowsSource, d.mesh);
      // Its own program (the marker keys it) reads the table's pools; built at this, the draw's first, draw.
      d.geometry.setAttribute(COPY_ROWS_ATTRIBUTE, d.geometry.getAttribute('position'));
      d.mesh.userData[COVER_DRAW_KEY] = rowsPlacement;
      d.mesh.userData[COPY_ROW_KEY] = d.row;
      d.mesh.userData[CULLED_COPIES_KEY] = d.binding.row;
    }
    this.dirty = true;
  }

  /** The table let the set go (disposed): its draws draw from its lists again (their programs built again). */
  private unadopt(): void {
    if (this.table === null) return;
    this.table = null;
    this.adoptTried = false;
    for (const d of this.draws) {
      d.binding.row = null;
      d.geometry.deleteAttribute(COPY_ROWS_ATTRIBUTE);
      d.geometry.indirect = null;
      d.mesh.userData[COVER_DRAW_KEY] = copiesPlacement;
      delete d.mesh.userData[COPY_ROW_KEY];
      delete d.mesh.userData[CULLED_COPIES_KEY];
      for (const m of Array.isArray(d.mesh.material) ? d.mesh.material : [d.mesh.material]) m.needsUpdate = true;
    }
    this.dirty = true;
  }

  /** Which kind of camera a pass draws a row with: a cached static shadow map's, the view's (as culled), another's. */
  private cameraKind(camera: THREE.Camera): CopyCamera {
    if (camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) return 'static';
    return this.view !== null && this.view.stamp === this.stamp && this.view.is(camera) ? 'view' : 'other';
  }

  /** The copies with paint (their texels' paint slot is set): diagnostics. */
  paintedCopies(): number {
    const p = this.prepared;
    let n = 0;
    for (let slot = 0; slot < p.count; slot += 1) if (p.texels[slot * COPY_TEXEL_FLOATS + 11]! > 0) n += 1;
    return n;
  }

  /**
   * Every draw's bounds are the set's (its blocks' spheres grown by the
   * model): what frames, fits and tests a draw as a whole (an editor framing
   * the set, a box round the scene) sees all of its copies.
   */
  private updateBounds(): void {
    const bl = this.prepared.blocks;
    const box = new THREE.Box3();
    for (let o = 0; o < bl.length; o += BLOCK_FLOATS) {
      if (bl[o + 5] === 0) continue;
      const r = bl[o + 3]! + this.reach * bl[o + 5]!;
      box.expandByPoint(scratchV.set(bl[o]! - r, bl[o + 1]! - r, bl[o + 2]! - r));
      box.expandByPoint(scratchV.set(bl[o]! + r, bl[o + 1]! + r, bl[o + 2]! + r));
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    for (const d of this.draws) {
      d.geometry.boundingBox = box.clone();
      d.geometry.boundingSphere = sphere.clone();
    }
  }

  get count(): number {
    return this.prepared.count;
  }

  /** The chunks its copies were cut into (their blocks culled on their own). */
  get chunks(): number {
    return this.prepared.chunks;
  }

  get meshes(): THREE.Mesh[] {
    return this.draws.filter((d) => !d.near).map((d) => d.mesh);
  }

  get nearShadows(): THREE.Mesh[] {
    return this.draws.filter((d) => d.near).map((d) => d.mesh);
  }

  /** Its hidden own draws shown for a precompile (their instance count is worked out per draw: an empty list draws none); released, culled again. */
  warmDraw(built: Set<string>): WarmDraw {
    // What three keys a copies draw's program by besides the scene (no mesh of its own: a draw of one instance).
    const keyOf = (m: THREE.Mesh): string => `${(m.material as THREE.Material).uuid}|${Object.keys(m.geometry.attributes).sort().join(',')}|${m.geometry.index !== null}|${m.castShadow}|${m.receiveShadow}`;
    // Drawn ones built their programs in the frame they were first drawn.
    const waiting = (): THREE.Mesh[] => this.draws.filter((d) => !d.near && !d.mesh.visible && !built.has(keyOf(d.mesh))).map((d) => d.mesh);
    let held: THREE.Mesh[] = [];
    return {
      wanted: () => {
        for (const d of this.draws) if (!d.near && d.mesh.visible) built.add(keyOf(d.mesh));
        held = waiting();
        return held.length > 0;
      },
      hold: () => {
        for (const m of held) m.visible = true;
      },
      release: () => {
        for (const m of held) built.add(keyOf(m));
        held = [];
        this.dirty = true;
        if (this.view !== null) this.cull(this.view);
      },
      alive: () => !this.disposed,
    };
  }

  /** The blocks a pass of `camera` draws from `list`. */
  private blocksFor(list: CopyList, camera: THREE.Camera, mesh: THREE.Mesh): number {
    if (camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) return list.staticAll && mesh.castShadow ? list.nAll : 0;
    // Another camera (a shadow map's) or the view moved since it was culled: every candidate (never too little).
    return this.view !== null && this.view.is(camera) ? list.nView : list.nCand;
  }

  /** List each draw's blocks for `view` (when the view, the set's place, the tuning or a copy changed). */
  cull(view: CullView): boolean {
    if (this.disposed) return false;
    this.culledSinceAsked = true;
    const first = this.draws[0]?.mesh;
    if (first === undefined) return false;
    const w = first.matrixWorld.elements;
    let same = !this.dirty && view === this.view && view.stamp === this.stamp && this.tuning.revision === this.tuningRevision;
    for (let k = 0; k < 16 && same; k += 1) if (this.world[k] !== w[k]) same = false;
    if (same) return false;
    this.view = view;
    this.stamp = view.stamp;
    this.tuningRevision = this.tuning.revision;
    this.dirty = false;
    for (let k = 0; k < 16; k += 1) this.world[k] = w[k]!;
    const ws = maxScaleOf(w);
    const toDistance = 1 / (view.zoom * this.tuning.bias);
    const ex = view.eye[0]!, ey = view.eye[1]!, ez = view.eye[2]!;
    this.eye.set(ex, ey, ez, toDistance);
    viewEye.copy(this.eye);
    const bl = this.prepared.blocks;
    const nb = bl.length / BLOCK_FLOATS;
    const groups = this.plan.groups;
    const G = Math.max(1, groups.length);
    let changed = false;
    // Drawn as the table's rows, every copy picks its own level (in compute): the page only hides the draws no copy
    // can reach now (a level and its neighbours, for the project's hysteresis and a fade under way).
    const rows = this.table !== null;
    const perCopy = this.perCopy;
    if (!perCopy) this.pickBlockLevels(w, ws, toDistance);
    // Each block once: its nearest and farthest metres from the eye, whether the view sees it, and (per copy) the levels
    // its copies may take in each group; the lists then only compare.
    const sc = this.cullScratch(nb, G);
    for (let b = 0; b < nb; b += 1) {
      const o = b * BLOCK_FLOATS;
      const cx = bl[o]!, cy = bl[o + 1]!, cz = bl[o + 2]!;
      const wx = w[0]! * cx + w[4]! * cy + w[8]! * cz + w[12]!;
      const wy = w[1]! * cx + w[5]! * cy + w[9]! * cz + w[13]!;
      const wz = w[2]! * cx + w[6]! * cy + w[10]! * cz + w[14]!;
      const r = (bl[o + 3]! + this.reach * bl[o + 5]!) * ws;
      const dc = Math.hypot(wx - ex, wy - ey, wz - ez);
      sc.near[b] = Math.max(0, dc - r);
      sc.seen[b] = view.camera === null || view.side(wx, wy, wz, r) !== SphereSide.Outside ? 1 : 0;
      if (!perCopy) continue;
      for (let g = 0; g < groups.length; g += 1) {
        const dist = groups[g]!.distances;
        sc.lo[b * G + g] = lodLevelOf(dist, sc.near[b]! * toDistance, bl[o + 5]! * ws);
        sc.hi[b * G + g] = lodLevelOf(dist, (dc + r) * toDistance, bl[o + 4]! * ws);
      }
    }
    const fades = this.density.w > 0.5 && this.density.z <= 0;
    for (const list of this.lists) {
      const gi = Math.max(0, list.group);
      const g = groups[gi];
      const last = (g?.distances.length ?? 1) - 1;
      const culls = g?.culls === true;
      // A near-shadow list (a finite reach) takes every block in reach: its draws are the most detailed level's.
      const levelled = g !== undefined && list.reach === Number.POSITIVE_INFINITY;
      const candidate = (b: number): boolean => {
        if (sc.near[b]! > list.reach || bl[b * BLOCK_FLOATS + 5]! <= 0) return false;
        // A falloff down to no copies (a blob disc's) ends the set: a block wholly past it draws nothing.
        if (fades && sc.near[b]! * toDistance >= this.density.y * bl[b * BLOCK_FLOATS + 5]! * ws) return false;
        if (!levelled) return true;
        if (!perCopy) {
          const at = this.blockLevels[b * groups.length + gi]!;
          return list.group < 0 ? !(culls && at === last) : at === list.level && !(culls && at === last);
        }
        const lo = sc.lo[b * G + gi]!;
        const hi = sc.hi[b * G + gi]!;
        return list.group < 0 ? !(culls && lo === last) : lo <= list.level && list.level <= hi && !(culls && list.level === last);
      };
      if (rows) {
        // Shown while some block may hold a copy it draws (the selection pass lists the copies themselves), for a while
        // after (a copy fading out of the level, the counts' read-back catching up), and while the GPU last counted
        // copies in its list (a copy the project's hysteresis holds at a coarser level than its distance says).
        let any = false;
        for (let b = 0; b < nb && !any; b += 1) any = candidate(b);
        const now = performance.now();
        if (any) list.shownUntil = now + COPY_ROW_SHOWN_MS;
        const counted = this.draws.some((d) => d.list === list && d.binding.row !== null && d.binding.row.output.front + d.binding.row.output.back > 0);
        list.nCand = any || counted || now < list.shownUntil ? 1 : 0;
        list.nAll = list.staticAll ? nb : list.nCand;
        continue;
      }
      // Seen candidates from the front, unseen ones after them, the rest (a static map's) last.
      let n = 0;
      let inView = 0;
      for (let b = 0; b < nb; b += 1) {
        if (sc.seen[b] !== 1 || !candidate(b)) continue;
        n = this.writeEntry(list, n, b);
        inView += bl[b * BLOCK_FLOATS + 7]!;
      }
      const nView = n;
      for (let b = 0; b < nb; b += 1) if (sc.seen[b] !== 1 && candidate(b)) n = this.writeEntry(list, n, b);
      const nCand = n;
      if (list.staticAll) for (let b = 0; b < nb; b += 1) if (!candidate(b)) n = this.writeEntry(list, n, b);
      if (list.texture.needsUpdate || n !== list.nAll || nView !== list.nView || nCand !== list.nCand) changed = true;
      list.nView = nView;
      list.nCand = nCand;
      list.nAll = n;
      list.copiesInView = inView;
    }
    if (ws !== this.worldScale) {
      this.worldScale = ws;
      for (const list of this.lists) this.writeHeader(list);
    }
    // A draw no pass needs leaves three's walks (a camera other than the view, or the view moved since, draws every candidate).
    for (const d of this.draws) d.mesh.visible = d.list.nCand > 0 || (d.list.staticAll && d.mesh.castShadow && d.list.nAll > 0);
    return changed;
  }

  /** The per-block arrays a cull fills (kept between frames: no garbage per frame). */
  private cullScratch(nb: number, groups: number): { near: Float32Array; seen: Uint8Array; lo: Int16Array; hi: Int16Array } {
    if (this.scratch === null || this.scratch.seen.length < nb) this.scratch = { near: new Float32Array(nb), seen: new Uint8Array(nb), lo: new Int16Array(nb * groups), hi: new Int16Array(nb * groups) };
    return this.scratch;
  }

  /** The LOD group a list's levels come from (a list outside every group: the first group's, for its cull size). */
  private groupOf(group: number): InstanceSetPlan['groups'][number] | undefined {
    return group >= 0 ? this.plan.groups[group] : this.plan.groups[0];
  }

  /** Write a list's header (its draws' constants: `LIST_FIXED_HEADER`, then its group's switch distances). */
  private writeHeader(list: CopyList): void {
    const g = this.groupOf(list.group);
    const distances = g?.distances ?? [0];
    const out = list.data;
    out.set([this.block, Math.min(list.reach, NEVER), this.worldScale, this.options.bendAway ?? INTERACTOR_DEFAULTS.ruleBend, list.level, distances.length, g?.culls === true ? 1 : 0, list.mode, this.density.x, this.density.y, this.density.z, this.density.w], 0);
    for (let k = 0; k < (list.header - LIST_FIXED_HEADER) * 4; k += 1) out[LIST_FIXED_HEADER * 4 + k] = k < distances.length ? distances[k]! : NEVER;
    list.texture.needsUpdate = true;
  }

  /**
   * Each block's level in every LOD group, picked at its centre for its
   * copies' mean size with the project's hysteresis, as a chunk of a CPU
   * instance set picks.
   */
  private pickBlockLevels(w: ArrayLike<number>, ws: number, toDistance: number): void {
    const bl = this.prepared.blocks;
    const groups = this.plan.groups;
    const hys = this.tuning.hysteresis;
    for (let b = 0; b < bl.length / BLOCK_FLOATS; b += 1) {
      const o = b * BLOCK_FLOATS;
      const cx = bl[o]!, cy = bl[o + 1]!, cz = bl[o + 2]!;
      const dc = Math.hypot(w[0]! * cx + w[4]! * cy + w[8]! * cz + w[12]! - this.eye.x, w[1]! * cx + w[5]! * cy + w[9]! * cz + w[13]! - this.eye.y, w[2]! * cx + w[6]! * cy + w[10]! * cz + w[14]! - this.eye.z) * toDistance;
      // Switch distances scale with the copies' size.
      const d = dc / (this.blockMean[b]! * ws);
      for (let g = 0; g < groups.length; g += 1) {
        const at = b * groups.length + g;
        this.blockLevels[at] = pickLodLevel(this.switches[g]!, d, this.blockLevels[at]!, hys);
      }
    }
  }

  /** Write block `b` as entry `n` of `list` (only when it differs: the texture is uploaded only then). */
  private writeEntry(list: CopyList, n: number, b: number): number {
    const o = b * BLOCK_FLOATS;
    const at = (list.header + n) * 4;
    const out = list.data;
    const bl = this.prepared.blocks;
    if (out[at] !== bl[o + 6] || out[at + 1] !== bl[o + 7]) {
      out[at] = bl[o + 6]!;
      out[at + 1] = bl[o + 7]!;
      list.texture.needsUpdate = true;
    }
    return n + 1;
  }

  /** Redraw copies at new transforms (a copy scaled to 0 is drawn as nothing); tells `moved` where their blocks were and are. */
  setCopies(changes: readonly { readonly index: number; readonly transform: readonly number[] }[]): void {
    const p = this.prepared;
    const touched = new Set<number>();
    const spheres: number[] = [];
    for (const { index, transform: t } of changes) {
      if (index < 0 || index >= p.count || t.length < INSTANCE_FLOATS) continue;
      const slot = this.slotOf[index]!;
      const block = this.blockOf[slot]!;
      if (!touched.has(block)) {
        touched.add(block);
        this.blockSphere(block, spheres);
      }
      const paintSlot = p.texels[slot * COPY_TEXEL_FLOATS + 11]!;
      writeCopyTexels(t, 0, copyRank(index), p.texels, slot, paintSlot);
    }
    if (touched.size === 0) return;
    for (const b of touched) {
      // A block keeps its sphere round every copy it drew (a copy shrunk to nothing leaves it as it was).
      const o = b * BLOCK_FLOATS;
      const was = p.blocks.slice(o, o + 6);
      measureBlock(p.texels, p.blocks, b);
      if (p.blocks[o + 5] === 0) p.blocks.set(was, o);
      this.blockSphere(b, spheres);
    }
    this.texture.needsUpdate = true;
    this.dirty = true;
    this.revision += 1;
    this.updateBounds();
    if (this.options.moved !== undefined && spheres.length > 0) this.options.moved(spheres);
  }

  setCopy(index: number, transform: readonly number[]): void {
    this.setCopies([{ index, transform }]);
  }

  /** Block `b`'s world sphere (with the model's reach) pushed onto `out`. */
  private blockSphere(b: number, out: number[]): void {
    const bl = this.prepared.blocks;
    const o = b * BLOCK_FLOATS;
    this.group.updateWorldMatrix(true, false);
    const w = this.group.matrixWorld;
    scratchSphere.center.set(bl[o]!, bl[o + 1]!, bl[o + 2]!);
    scratchSphere.radius = bl[o + 3]! + this.reach * bl[o + 5]!;
    scratchSphere.applyMatrix4(w);
    out.push(scratchSphere.center.x, scratchSphere.center.y, scratchSphere.center.z, scratchSphere.radius);
  }

  /** Copy `copy`'s matrix (in the set's frame) into `out`. */
  private copyMatrix(copy: number, out: THREE.Matrix4): THREE.Matrix4 {
    const t = this.slotOf[copy]! * COPY_TEXEL_FLOATS;
    const x = this.prepared.texels;
    return out.compose(scratchP.set(x[t]!, x[t + 1]!, x[t + 2]!), scratchQ.set(x[t + 4]!, x[t + 5]!, x[t + 6]!, x[t + 7]!), scratchS.set(x[t + 8]!, x[t + 9]!, x[t + 10]!));
  }

  /** Copy `index` as drawn now (position, quaternion, scale; in the set's frame), or null. */
  copyTransform(index: number): number[] | null {
    if (index < 0 || index >= this.prepared.count) return null;
    const t = this.slotOf[index]! * COPY_TEXEL_FLOATS;
    const x = this.prepared.texels;
    return [x[t]!, x[t + 1]!, x[t + 2]!, x[t + 4]!, x[t + 5]!, x[t + 6]!, x[t + 7]!, x[t + 8]!, x[t + 9]!, x[t + 10]!];
  }

  copyOf(mesh: THREE.Object3D, instanceId: number): number | null {
    return this.draws.some((d) => d.mesh === mesh) && instanceId >= 0 && instanceId < this.prepared.count ? instanceId : null;
  }

  copyBox(index: number): THREE.Box3 | null {
    if (index < 0 || index >= this.prepared.count) return null;
    this.group.updateWorldMatrix(true, false);
    const m = this.copyMatrix(index, new THREE.Matrix4()).premultiply(this.group.matrixWorld);
    const out = new THREE.Box3();
    const box = new THREE.Box3();
    for (const part of this.plan.parts) {
      if (part.lod >= 0 && part.level !== 0) continue;
      const g = part.mesh.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      out.union(box.copy(g.boundingBox!).applyMatrix4(scratchM.multiplyMatrices(m, part.local)));
    }
    return out.isEmpty() ? null : out;
  }

  /**
   * A ray against every copy shown (the most detailed level's meshes; a
   * sphere test first; the copy's index as `instanceId`), answered by the
   * first of the set's own draws that is shown (else its first), so a copy
   * is hit once whatever level it draws at now.
   */
  private raycastFrom(mesh: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
    const own = this.draws.filter((d) => !d.near);
    const answer = own.find((d) => d.mesh.visible)?.mesh ?? own[0]?.mesh;
    if (mesh !== answer) return;
    const p = this.prepared;
    const found: THREE.Intersection[] = [];
    const ws = maxScaleOf(mesh.matrixWorld.elements);
    const parts = this.plan.parts.filter((part) => part.lod < 0 || part.level === 0);
    const probes = parts.map((part) => new THREE.Mesh(part.mesh.geometry, part.mesh.material));
    for (let copy = 0; copy < p.count; copy += 1) {
      const t = this.slotOf[copy]! * COPY_TEXEL_FLOATS;
      const s = Math.max(Math.abs(p.texels[t + 8]!), Math.abs(p.texels[t + 9]!), Math.abs(p.texels[t + 10]!));
      if (s === 0) continue;
      scratchV.set(p.texels[t]!, p.texels[t + 1]!, p.texels[t + 2]!).applyMatrix4(mesh.matrixWorld);
      const r = this.reach * s * ws;
      if (raycaster.ray.distanceSqToPoint(scratchV) > r * r) continue;
      this.copyMatrix(copy, scratchM);
      parts.forEach((part, k) => {
        const probe = probes[k]!;
        probe.matrixWorld.multiplyMatrices(mesh.matrixWorld, scratchM).multiply(part.local);
        found.length = 0;
        probe.raycast(raycaster, found);
        for (const h of found) hits.push({ ...h, object: mesh, instanceId: copy });
      });
    }
  }

  /**
   * What the copies draw now for the view last culled (diagnostics only): a
   * block whose copies all take one level and none thins is counted whole,
   * the others copy by copy; kept until the view or a copy changes.
   */
  stats(): InstanceSetStats {
    const key = `${this.stamp}|${this.revision}|${this.texture.version}|${this.tuningRevision}`;
    if (this.statsCache !== null && this.statsCache.key === key) return this.statsCache.stats;
    const p = this.prepared;
    const g0 = this.plan.groups[0];
    const byLevel = new Array<number>(g0 !== undefined ? g0.distances.length : 1).fill(0);
    let culled = 0;
    let thinned = 0;
    let inView = 0;
    if (this.view === null) {
      byLevel[0] = p.count;
      return { copies: p.count, inView: 0, byLevel, culled: 0, thinned: 0 };
    }
    const w = this.world;
    const ws = this.worldScale;
    const toDistance = this.eye.w;
    const d = this.density;
    const thins = d.w > 0.5;
    const dist = g0?.distances ?? [0];
    const last = dist.length - 1;
    const cullsAt = g0?.culls === true ? last : -1;
    const seen = new Uint8Array(p.blocks.length / BLOCK_FLOATS);
    // The blocks the view saw: as listed, or (drawn as the table's rows) as the last cull found them.
    if (this.table !== null && this.scratch !== null) seen.set(this.scratch.seen.subarray(0, seen.length));
    else
      for (const list of this.lists) {
        if (list.reach !== Number.POSITIVE_INFINITY) continue;
        for (let n = 0; n < list.nView; n += 1) seen[this.blockOf[list.data[(list.header + n) * 4]!]!] = 1;
      }
    const bl = p.blocks;
    const count = (level: number, n: number, b: number): void => {
      if (level === cullsAt) culled += n;
      else {
        byLevel[level] = (byLevel[level] ?? 0) + n;
        if (seen[b] === 1) inView += n;
      }
    };
    for (let b = 0; b < bl.length / BLOCK_FLOATS; b += 1) {
      const o = b * BLOCK_FLOATS;
      const cx = bl[o]!, cy = bl[o + 1]!, cz = bl[o + 2]!;
      const dc = Math.hypot(w[0]! * cx + w[4]! * cy + w[8]! * cz + w[12]! - this.eye.x, w[1]! * cx + w[5]! * cy + w[9]! * cz + w[13]! - this.eye.y, w[2]! * cx + w[6]! * cy + w[10]! * cz + w[14]! - this.eye.z);
      const r = bl[o + 3]! * ws;
      const sLo = bl[o + 4]! * ws;
      const sHi = bl[o + 5]! * ws;
      // A block's own level (picked whole), else the range its copies' levels lie in.
      const own = !this.perCopy && g0 !== undefined ? Math.max(0, this.blockLevels[b * this.plan.groups.length]!) : -1;
      const lo = own >= 0 ? own : lodLevelOf(dist, Math.max(0, dc - r) * toDistance, sHi);
      const hi = own >= 0 ? own : lodLevelOf(dist, (dc + r) * toDistance, sLo);
      if (lo === hi && sLo > 0 && (!thins || (dc + r) * toDistance <= d.x * sLo)) {
        count(lo, bl[o + 7]!, b);
        continue;
      }
      for (let slot = bl[o + 6]!; slot < bl[o + 6]! + bl[o + 7]!; slot += 1) {
        const t = slot * COPY_TEXEL_FLOATS;
        const x = p.texels[t]!, y = p.texels[t + 1]!, z = p.texels[t + 2]!;
        const dd = Math.hypot(w[0]! * x + w[4]! * y + w[8]! * z + w[12]! - this.eye.x, w[1]! * x + w[5]! * y + w[9]! * z + w[13]! - this.eye.y, w[2]! * x + w[6]! * y + w[10]! * z + w[14]! - this.eye.z) * toDistance;
        const s = Math.max(Math.abs(p.texels[t + 8]!), Math.abs(p.texels[t + 9]!), Math.abs(p.texels[t + 10]!)) * ws;
        if (thins && p.texels[t + 3]! >= copyDensityAt(dd, d.x * s, d.y * s, d.z)) {
          thinned += 1;
          continue;
        }
        count(own >= 0 ? own : lodLevelOf(dist, dd, s), 1, b);
      }
    }
    const stats = { copies: p.count, inView, byLevel, culled, thinned };
    this.statsCache = { key, stats };
    return stats;
  }

  /** Copies in the blocks the view sees, summed over the most detailed draws (the frame probe's count). */
  copiesInView(): number {
    let n = 0;
    for (const list of this.lists) if (list.staticAll) n = Math.max(n, list.copiesInView);
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.table?.forgetCopies(this.rowsSource);
    this.table = null;
    this.group.removeFromParent();
    for (const d of this.draws) {
      delete d.mesh.userData[VIEW_CULL_KEY];
      d.mesh.removeFromParent();
      // The geometry shares the model's attributes and index, which a plain dispose would free on the GPU.
      disposeSharingGeometry(d.geometry, []);
    }
    for (const l of this.lists) l.texture.dispose();
    this.texture.dispose();
  }
}

/** Build a copies set of `template` for the first `count` copies of `floats` (the CPU instance set's surface, drawn on the GPU). */
export function buildGpuCopySet(template: ModelInstance, floats: Float32Array, count: number, name: string, options: GpuCopySetOptions = {}): GpuCopySetHandle {
  const set = new GpuCopySet(template, count, floats, name, options);
  return {
    group: set.group,
    get meshes() {
      return [...set.meshes, ...set.nearShadows];
    },
    get drawMeshes() {
      return set.meshes;
    },
    get nearShadows() {
      return set.nearShadows;
    },
    count: set.count,
    get chunks() {
      return set.chunks;
    },
    setCopy: (i, t) => set.setCopy(i, t),
    setCopies: (c) => set.setCopies(c),
    copyOf: (m, i) => set.copyOf(m, i),
    copyBox: (i) => set.copyBox(i),
    stats: () => set.stats(),
    warmDraw: (built) => set.warmDraw(built),
    dispose: () => set.dispose(),
  };
}
