/**
 * Stored copies drawn by the GPU renderer ground cover draws with: rule
 * scatter's baked copies (trees, rocks) and the instance brush's hand-placed
 * sets. Their places come from the data (a copy texture), not from a hash,
 * but the draw is cover's: one draw per mesh of the model and level, its
 * vertex stage placing each instance from a list of blocks the page writes
 * per frame (`cover-gpu.ts`'s placement hook applies it), choosing the
 * copy's level of detail by its own distance and size and thinning it with
 * distance by its rank. The page does no per-copy work to draw.
 *
 * Per frame (when the view or the set changed) the page lists, per draw, the
 * blocks of copies (`copies-prepare.ts`) whose levels it may draw: a block's
 * sphere and its copies' smallest and largest scale bound the levels its
 * copies take, so a block far from every switch point is listed in one
 * level's draw only. Each list holds the blocks the view sees first, then the
 * other candidates (a shadow map needs casters off screen), then, for the
 * most detailed level, every other block (a cached static shadow map draws
 * every copy at that level and is not drawn again as the view moves). Which
 * part a pass draws is chosen right before it (`onBeforeRender`).
 *
 * Levels switch exactly at their distance (no hysteresis: nothing remembers
 * a copy's last level, and a still view shows no flicker). A rule's
 * `shadowDistance` draws its copies near the eye again into the moving
 * shadow map only (shadow-only draws, culled past the distance).
 *
 * Every draw of every set shares one vertex stage: what differs per draw
 * (its textures, eye, level, distances) is bound per object, so the sets of
 * a scene build one program per material and vertex layout, as the CPU
 * instance sets did.
 *
 * Copies keep an identity only where something asks for one: a ray picks a
 * copy, an editor writes one (`setCopies`), the diagnostics count them. Those
 * walk the copies on the page when asked, never per frame.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { RenderObjectRefreshType } from 'three';
import { NodeMaterial, TextureNode, type NodeBuilder } from 'three/webgpu';
import { INSTANCE_FLOATS } from '@thirdlight/runtime';

import { PAINT_SLOT_ATTRIBUTE, setGpuCopyColumns } from './attribute-instancing';
import { CUTAWAY_LAYER } from './block-cutaway-view';
import { BLOCK_FLOATS, COPY_ROW, COPY_TEXEL_FLOATS, COPY_TEXELS, copyDensityAt, copyRank, copyLevel, measureBlock, prepareCopies, writeCopyTexels, type PreparedCopies } from './copies-prepare';
import { COVER_DRAW_KEY, installCoverPlacement, type CoverPlacement } from './cover-gpu';
import { disposeSharingGeometry } from './dispose';
import type { N } from './effects-tsl';
import { INSTANCE_SET_KEY, instanceSetPlan, type BuiltInstanceSet, type InstancePlanOptions, type InstanceSetOptions, type InstanceSetPlan, type InstanceSetStats } from './instancing';
import { TAN_HALF_REFERENCE } from './instance-lod';
import { LodTuning } from './lod-switch';
import { KEEP_MATERIAL_KEY } from './material-keys';
import { PAINT_MESH_KEY, PAINT_STREAM_KEY } from './vertex-paint-draw';
import { maxScaleOf, SphereSide, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, type CullView, type ViewCullable } from './view-cull';
import type { ModelInstance } from './visual';

const TSL: N = TSLTyped;
const { Fn, abs, float, instanceIndex, int, ivec2, length, max, modelWorldMatrix, normalLocal, normalize, positionLocal, positionPrevious, select, uint, uniform, vec3, vec4 } = TSL;

/** `mesh.userData[GPU_COPIES_KEY]`: the draw's state its vertex stage binds ({@link CopyDraw}). */
export const GPU_COPIES_KEY = '__tlGpuCopies';
/** The marker attribute of a copies draw's geometry: its program is its own (the source's position, never read under this name). */
const GPU_COPIES_ATTRIBUTE = 'tlGpuCopies';
/** Entries a row of a draw's list texture holds. */
const LIST_ROW = 1024;
/**
 * Texels a list's header takes before its entries: copies per block, reach
 * (m) and world scale; the level it draws, the group's level count, whether
 * the last level culls and how the level is decided; the switch distances
 * (two texels); the density falloff.
 */
export const LIST_HEADER = 5;
/** Levels of detail a copy's model may have in one LOD group (two vec4s of switch distances). */
const MAX_LEVELS = 8;
/** A switch distance never reached (a level the model does not have). */
const NEVER = 3.4e38;

/** A data texture read texel by texel as uploaded (no transform, no flip-Y uniform), its value bound per draw. */
class CopyTextureNode extends (TextureNode as unknown as new (value: THREE.Texture) => object) {
  setUpdateMatrix(): this {
    (this as unknown as { updateMatrix: boolean }).updateMatrix = false;
    return this;
  }
  setupUV(_builder: unknown, uvNode: N): N {
    return uvNode;
  }
}

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

/** One draw's per-object inputs (vec4s, so a draw updates a handful of uniforms). */
interface CopyDraw {
  readonly set: GpuCopySet;
  readonly list: CopyList;
  readonly local: THREE.Matrix4;
}

const drawOf = (object: THREE.Object3D | null | undefined): CopyDraw | undefined => object?.userData[GPU_COPIES_KEY] as CopyDraw | undefined;
const copiesTexture: N = TSL.nodeObject(new CopyTextureNode(NO_COPIES));
const listTexture: N = TSL.nodeObject(new CopyTextureNode(NO_LIST));
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
function copyNodes(): { kept: N; pos: N; quat: N; scale: N; paint: N; slot: N } {
  // The list's header (LIST_HEADER texels of its first row): see `writeHeader`.
  const head = (i: number): N => listTexture.load(ivec2(i, 0));
  const h0 = head(0);
  const uLevel = head(1);
  const uD0 = head(2);
  const uD1 = head(3);
  const uDensity = head(4);
  const B = uint(h0.x);
  const idx = uint(instanceIndex);
  const b = idx.div(B);
  const k = idx.sub(b.mul(B));
  const e = b.add(uint(LIST_HEADER));
  const entry = listTexture.load(ivec2(int(e.mod(uint(LIST_ROW))), int(e.div(uint(LIST_ROW)))));
  const slot = uint(entry.x).add(k);
  const col = int(slot.mod(uint(COPY_ROW))).mul(COPY_TEXELS);
  const row = int(slot.div(uint(COPY_ROW)));
  const t0 = copiesTexture.load(ivec2(col, row));
  const t1 = copiesTexture.load(ivec2(col.add(1), row));
  const t2 = copiesTexture.load(ivec2(col.add(2), row));
  const world = modelWorldMatrix.mul(vec4(t0.xyz, 1)).xyz;
  const metres = length(world.sub(uEye.xyz));
  const d = metres.mul(uEye.w);
  const s = max(max(abs(t2.x), abs(t2.y)), abs(t2.z)).mul(h0.z);
  const isStatic = uStatic.greaterThan(0.5);
  // The rule of `copyLevel`: the levels whose switch distance (times the scale) the copy reached.
  const ds = [uD0.y, uD0.z, uD0.w, uD1.x, uD1.y, uD1.z, uD1.w];
  let level: N = float(0);
  for (const at of ds) level = level.add(select(d.greaterThanEqual(at.mul(s)), float(1), float(0)));
  level = select(isStatic, float(0), level);
  const last = uLevel.y.sub(1);
  const culled = uLevel.z.greaterThan(0.5).and(level.greaterThanEqual(last));
  // Mode 0: the copy's own level is the draw's; 1: every listed copy not past its cull size (a mesh outside the levels, or
  // the list's blocks are at its level).
  const mine = select(uLevel.w.greaterThan(0.5), culled.not(), abs(level.sub(uLevel.x)).lessThan(0.5).and(culled.not()));
  // The rule of `copyDensityAt` (a static map keeps every copy).
  const from = uDensity.x.mul(s);
  const to = uDensity.y.mul(s);
  const share = select(d.lessThanEqual(from), float(1), select(d.greaterThanEqual(to).or(to.lessThanEqual(from)), uDensity.z, float(1).sub(float(1).sub(uDensity.z).mul(d.sub(from)).div(max(to.sub(from), 1e-9)))));
  const thins = uDensity.w.greaterThan(0.5).and(isStatic.not());
  const keep = select(thins, t0.w.lessThan(share), float(1).greaterThan(0));
  const kept = float(k).lessThan(entry.y).and(mine).and(keep).and(metres.lessThanEqual(h0.y)).and(s.greaterThan(0));
  return { kept, pos: t0.xyz, quat: t1, scale: t2.xyz, paint: t2.w, slot };
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
function refreshOnCopiesChange(base: (renderObject: { object: THREE.Object3D }, frame: unknown) => number): (renderObject: { object: THREE.Object3D }, frame: unknown) => number {
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
  const proto = NodeMaterial.prototype as unknown as { setupObserver?(builder: NodeBuilder): unknown };
  const observe = proto.setupObserver;
  if (typeof observe === 'function') {
    proto.setupObserver = function setupObserverOfCopies(this: unknown, builder: NodeBuilder): unknown {
      const observer = observe.call(this, builder) as { needsRefresh?: (renderObject: { object: THREE.Object3D }, frame: unknown) => number } | null;
      const object = (builder as unknown as { object?: THREE.Object3D | null }).object;
      if (observer !== null && typeof observer === 'object' && typeof observer.needsRefresh === 'function' && drawOf(object) !== undefined) observer.needsRefresh = refreshOnCopiesChange(observer.needsRefresh.bind(observer));
      return observer;
    };
  }
  setGpuCopyColumns({
    has: (builder) => drawOf((builder as unknown as { object?: THREE.Object3D | null }).object) !== undefined,
    column: (i) => copyColumn(i),
    index: () => copyNodes().slot,
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
  data: Float32Array;
  texture: THREE.DataTexture;
  /** Blocks the view sees, candidates (seen or not), and all listed (with the rest for a static map). */
  nView: number;
  nCand: number;
  nAll: number;
  /** Copies in the blocks the view sees (diagnostics). */
  copiesInView: number;
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
}

/** A built copies set: an instance set's surface, culled once a frame through its draws. */
export interface GpuCopySetHandle extends BuiltInstanceSet {
  /** The shadow-only draws near the eye (empty without a `shadowDistance`). */
  readonly nearShadows: readonly THREE.Mesh[];
  /** The draws its own (not the near shadows'). */
  readonly drawMeshes: readonly THREE.Mesh[];
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
  private readonly blockMean: Float32Array;
  private readonly lists: CopyList[] = [];
  private readonly draws: { mesh: THREE.Mesh; list: CopyList; part: InstanceSetPlan['parts'][number]; near: boolean; geometry: THREE.BufferGeometry }[] = [];
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
        const rows = Math.max(1, Math.ceil((LIST_HEADER + blocks) / LIST_ROW));
        const data = new Float32Array(rows * LIST_ROW * 4);
        this.lists.push((l = { group, level, reach, staticAll, mode, data, texture: floatTexture(data, LIST_ROW, rows), nView: 0, nCand: 0, nAll: 0, copiesInView: 0 }));
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
      if (stream !== undefined) mesh.userData[PAINT_STREAM_KEY] = stream;
      const draw: CopyDraw = { set: this, list, local: part.local.clone() };
      mesh.userData[GPU_COPIES_KEY] = draw;
      mesh.userData[COVER_DRAW_KEY] = copiesPlacement;
      // Culled through the set (one listing a frame for all its draws); the frame probe reads the copies the view sees once per list.
      const firstOfList = !this.draws.some((x) => x.list === list);
      mesh.userData[VIEW_CULL_KEY] = { cull: (): boolean => false, group: this.culler, get inView(): number { return firstOfList ? list.copiesInView : 0; } };
      mesh.userData[INSTANCE_SET_KEY] = true;
      mesh.onBeforeRender = (_r, _s, camera) => {
        geometry.instanceCount = this.blocksFor(list, camera, mesh) * this.block;
      };
      // A ray picks the copies of the most detailed level's meshes (one hit per copy and mesh).
      // A ray picks a copy once, through whichever of the set's own draws is shown (the most detailed level's meshes test it).
      mesh.raycast = near ? () => undefined : (raycaster, hits) => this.raycastFrom(mesh, raycaster, hits);
      this.group.add(mesh);
      this.draws.push({ mesh, list, part, near, geometry });
    };
    for (const part of this.plan.parts) makeDraw(part, false);
    if (options.shadowDistance !== undefined) for (const part of this.plan.parts) if (part.mesh.userData[KEEP_MATERIAL_KEY] !== true && (part.lod < 0 || part.level === 0)) makeDraw(part, true);
    this.updateBounds();
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

  /** The blocks a pass of `camera` draws from `list`. */
  private blocksFor(list: CopyList, camera: THREE.Camera, mesh: THREE.Mesh): number {
    if (camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) return list.staticAll && mesh.castShadow ? list.nAll : 0;
    // Another camera (a shadow map's) or the view moved since it was culled: every candidate (never too little).
    return this.view !== null && this.view.is(camera) ? list.nView : list.nCand;
  }

  /** List each draw's blocks for `view` (when the view, the set's place, the tuning or a copy changed). */
  cull(view: CullView): boolean {
    if (this.disposed) return false;
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
    if (!this.perCopy) this.pickBlockLevels(w, ws, toDistance);
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
      if (!this.perCopy) continue;
      for (let g = 0; g < groups.length; g += 1) {
        const dist = groups[g]!.distances;
        sc.lo[b * G + g] = copyLevel(dist, sc.near[b]! * toDistance, bl[o + 5]! * ws);
        sc.hi[b * G + g] = copyLevel(dist, (dc + r) * toDistance, bl[o + 4]! * ws);
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
        if (!this.perCopy) {
          const at = this.blockLevels[b * groups.length + gi]!;
          return list.group < 0 ? !(culls && at === last) : at === list.level && !(culls && at === last);
        }
        const lo = sc.lo[b * G + gi]!;
        return list.group < 0 ? !(culls && lo === last) : lo <= list.level && list.level <= sc.hi[b * G + gi]! && !(culls && list.level === last);
      };
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

  /** Write a list's header (its draws' constants: `LIST_HEADER`). */
  private writeHeader(list: CopyList): void {
    const g = list.group >= 0 ? this.plan.groups[list.group] : this.plan.groups[0];
    const distances = g?.distances ?? [0];
    const dv = (k: number): number => (k < distances.length ? distances[k]! : NEVER);
    list.data.set([this.block, Math.min(list.reach, NEVER), this.worldScale, 0, list.level, g !== undefined ? Math.min(distances.length, MAX_LEVELS) : 1, g?.culls === true ? 1 : 0, list.mode, dv(0), dv(1), dv(2), dv(3), dv(4), dv(5), dv(6), dv(7), this.density.x, this.density.y, this.density.z, this.density.w], 0);
    list.texture.needsUpdate = true;
  }

  /**
   * Each block's level in every LOD group, picked at its centre for its
   * copies' mean size with the project's hysteresis (the rule of
   * `pickLodLevel`, as a chunk of a CPU instance set picks).
   */
  private pickBlockLevels(w: ArrayLike<number>, ws: number, toDistance: number): void {
    const bl = this.prepared.blocks;
    const groups = this.plan.groups;
    const hys = this.tuning.hysteresis;
    for (let b = 0; b < bl.length / BLOCK_FLOATS; b += 1) {
      const o = b * BLOCK_FLOATS;
      const cx = bl[o]!, cy = bl[o + 1]!, cz = bl[o + 2]!;
      const dc = Math.hypot(w[0]! * cx + w[4]! * cy + w[8]! * cz + w[12]! - this.eye.x, w[1]! * cx + w[5]! * cy + w[9]! * cz + w[13]! - this.eye.y, w[2]! * cx + w[6]! * cy + w[10]! * cz + w[14]! - this.eye.z) * toDistance;
      const sc = this.blockMean[b]! * ws;
      for (let g = 0; g < groups.length; g += 1) {
        const dist = groups[g]!.distances;
        const at = b * groups.length + g;
        const current = this.blockLevels[at]!;
        let l = 1;
        for (; l < dist.length; l += 1) if (dc < dist[l]! * sc * (current === l ? 1 - hys : 1)) break;
        this.blockLevels[at] = l - 1;
      }
    }
  }

  /** Write block `b` as entry `n` of `list` (only when it differs: the texture is uploaded only then). */
  private writeEntry(list: CopyList, n: number, b: number): number {
    const o = b * BLOCK_FLOATS;
    const at = (LIST_HEADER + n) * 4;
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
    for (const list of this.lists) {
      if (list.reach !== Number.POSITIVE_INFINITY) continue;
      for (let n = 0; n < list.nView; n += 1) seen[this.blockOf[list.data[(LIST_HEADER + n) * 4]!]!] = 1;
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
      const lo = own >= 0 ? own : copyLevel(dist, Math.max(0, dc - r) * toDistance, sHi);
      const hi = own >= 0 ? own : copyLevel(dist, (dc + r) * toDistance, sLo);
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
        count(own >= 0 ? own : copyLevel(dist, dd, s), 1, b);
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
    dispose: () => set.dispose(),
  };
}
