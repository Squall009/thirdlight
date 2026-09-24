/**
 * Shared GLB realization path (packet 26) — `dependencies.md` §3 additions row:
 * "the GLB realization/resource-owner helpers + an injected byte resolver: the
 * adapter accepts **bytes or a resolver function**, never a token/URL/fetch;
 * GLTFLoader/AnimationClip preview helpers".
 *
 * One resource-owner path is shared by model instances and by asset inspection:
 *
 *   descriptor + bytes|resolver
 *        │  (cancellable, stale-discarding, structured failures)
 *        ▼
 *   GlbLoaderPort.load ──► LoadedGlb (one hierarchy + clips + its ownership)
 *        ▼
 *   PreparedVisualResource  ── owns every loader-created resource, the release
 *        │                      refcount and the ownership ledger
 *        ├─ createInstance() ─► ModelInstance (one entity holder per placement,
 *        │                      independent transform + independent animation state)
 *        └─ ModelInstance.createPreviewController() ─► local material/animation
 *                                                       preview state only
 *
 * Non-goals (normative for this packet): this module never mutates the M1
 * runtime's simulation state or the authoring scene (no second scene-mutation
 * engine); it never reads a clock (the host owns the frame loop and drives
 * `AssetPreviewController.update(dt)`), never fetches, and holds no token, URL
 * or session state. It has no runtime dependency on the M1 instantiate path:
 * `runtime.md` §6 stays the only frame-order authority and M2 runtime snapshots
 * arrive in packet 29 (production Play wiring in packet 35).
 *
 * `three-adapter` may import `runtime`/`three` only (dependencies.md §4.1/§4.3):
 * the descriptor type below is a *structural* copy of the approved
 * project-model §18.4/§19.1 delivery facts — the adapter imports no
 * project-model type. Every public call returns a result object and never
 * throws across the module edge.
 */
import * as THREE from 'three';
import { adapterError, type AdapterError, type AdapterErrorCode } from './errors';
import { mergeOwnership, OwnershipLedger, type ResourceOwnership } from './ownership';
import { applyTransformToObject3D, type AdapterQuat, type AdapterVec3 } from './sync';
import { applyLodGroups, applyVertexColorMode, keepOnlyPiece, modelPieces, pieceBounds, pieceCollider2D, stripCollisionNodes, type VertexColorMode } from './pieces';

/**
 * The approved visual descriptor: the immutable, path-free per-version facts a
 * placement or an inspection resolves through (project-model §18.4/§19.1:
 * `assetId`, `version`, `sourceDigest`, `sourceByteLength`). The adapter adds
 * no field that could carry a path, URL or credential.
 */
export interface AssetVersionDescriptor {
  readonly assetId: string;
  readonly version: number;
  /** 64 lowercase hex — the immutable source blob name/digest. */
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
}

/**
 * Where the bytes come from. EXACTLY ONE of:
 *  - `bytes`: bytes the caller already obtained through the authenticated read
 *    path (sessions.md §16.1) — the adapter copies nothing and fetches nothing;
 *  - `resolver`: an injected async closure the caller owns (the editor's
 *    authenticated transport). It receives only the descriptor facts and an
 *    `AbortSignal`; it never receives a token from this package.
 *
 * There is deliberately no `url`/`token`/`path` variant: the renderer gets no
 * token (sessions.md §16.1) and `three-adapter → workspace|backend|protocol`
 * stays forbidden (dependencies.md §4.3).
 */
export type AssetByteSource =
  | {
      readonly kind: 'bytes';
      readonly descriptor: AssetVersionDescriptor;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'resolver';
      readonly descriptor: AssetVersionDescriptor;
      readonly resolve: (signal: AbortSignal) => Promise<Uint8Array>;
    };

/** A source whose bytes the caller already has. */
export function suppliedBytes(descriptor: AssetVersionDescriptor, bytes: Uint8Array): AssetByteSource {
  return { kind: 'bytes', descriptor, bytes };
}

/** A source backed by an injected async resolver (never a URL/fetch here). */
export function injectedResolver(
  descriptor: AssetVersionDescriptor,
  resolve: (signal: AbortSignal) => Promise<Uint8Array>,
): AssetByteSource {
  return { kind: 'resolver', descriptor, resolve };
}

/** Why a loader port refused the bytes (mapped to a stable `ERROR_CODES` row). */
export type VisualLoadFailureReason =
  | 'unsupported_extension'
  | 'invalid_image'
  | 'invalid_clip'
  | 'corrupt'
  | 'missing';

/** A structured loader failure (port authors return this, not a raw error). */
export interface VisualLoadFailure {
  readonly reason: VisualLoadFailureReason;
  /** ≤ 256 chars, log-safe (never a path or credential). */
  readonly message: string;
}

/** Create a structured loader failure. */
export function visualLoadFailure(reason: VisualLoadFailureReason, message: string): VisualLoadFailure {
  return { reason, message };
}

function isVisualLoadFailure(value: unknown): value is VisualLoadFailure {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { reason?: unknown; message?: unknown };
  return (
    typeof v.message === 'string' &&
    (v.reason === 'unsupported_extension' ||
      v.reason === 'invalid_image' ||
      v.reason === 'invalid_clip' ||
      v.reason === 'corrupt' ||
      v.reason === 'missing')
  );
}

const REASON_TO_CODE: Readonly<Record<VisualLoadFailureReason, AdapterErrorCode>> = {
  unsupported_extension: 'asset_extension_unsupported',
  invalid_image: 'asset_image_invalid',
  invalid_clip: 'asset_clip_invalid',
  corrupt: 'asset_corrupt',
  missing: 'asset_missing',
};

/**
 * The injected loader port. The adapter binds to no concrete loader at this
 * layer: the real GLTFLoader-backed port lives on the
 * `@thirdlight/three-adapter/gltf-loader` subpath (so the export/preview bundle
 * graphs stay free of the loader until packets 35/36 need it), and tests inject
 * a synthetic port. A port must not fetch, hold a token or read a path.
 */
export interface GlbLoaderPort {
  load(
    bytes: Uint8Array,
    options: { readonly signal: AbortSignal; readonly descriptor: AssetVersionDescriptor },
  ): Promise<LoadedGlb>;
}

/**
 * One parsed GLB. The port owns everything it created: `dispose()` must release
 * exactly the resources declared in `ownership`, once, and every
 * `createInstance()` result must reference only resources owned by this load
 * (shared with `root` or disposed here) — the adapter counts the declaration
 * and never walks the graph itself.
 */
export interface LoadedGlb {
  /** The single internal hierarchy, preserved verbatim (never flattened). */
  readonly root: THREE.Object3D;
  readonly animations: readonly THREE.AnimationClip[];
  /** A fresh instance of `root` (shared geometry/material/texture allowed). */
  createInstance(): THREE.Object3D;
  /** Release everything this load owns beyond the hierarchy (once). */
  dispose(): void;
  /** What `dispose()` releases (counted by the resource ledger). */
  readonly ownership?: {
    readonly geometries?: number;
    readonly materials?: number;
    readonly textures?: number;
    readonly listeners?: number;
    readonly objectUrls?: number;
  };
}

/** One validated clip, as the preview controller reports it (read-only facts). */
export interface VisualClipInfo {
  readonly index: number;
  readonly name: string;
  readonly durationSeconds: number;
  readonly trackCount: number;
}

/** Options for one preparation. */
export interface PrepareVisualOptions {
  readonly loader: GlbLoaderPort;
}

/** Lifecycle of one load handle. */
export type VisualResourceState = 'pending' | 'ready' | 'failed' | 'cancelled' | 'stale';

/** Result of one preparation. */
export type PrepareVisualResult =
  | { readonly ok: true; readonly resource: PreparedVisualResource }
  | { readonly ok: false; readonly error: AdapterError };

/** A handle on one in-flight load: await `result`, or `cancel()` it. */
export interface VisualResourceHandle {
  readonly descriptor: AssetVersionDescriptor;
  /** Never rejects; a cancelled/superseded load resolves `ok:false` with the
   *  matching code after releasing anything a late completion produced. */
  readonly result: Promise<PrepareVisualResult>;
  state(): VisualResourceState;
  /** Cancel the load; a late completion is discarded and released. */
  cancel(): void;
}

/** Read-only diagnostics of one prepared resource (packet 26 convention). */
export interface VisualResourceDiagnostics {
  readonly descriptor: AssetVersionDescriptor;
  readonly state: 'ready' | 'disposed';
  /** Live model instances (the shared resources stay owned until this is 0). */
  readonly instances: number;
  readonly clips: number;
  readonly ownership: ResourceOwnership;
}

/** The shared resource owner: one per `(assetId, version, digest)`. */
export interface PreparedVisualResource {
  readonly descriptor: AssetVersionDescriptor;
  readonly clips: readonly VisualClipInfo[];
  /**
   * Create one model instance: a single entity-level `Group` whose only child
   * is the preserved GLB hierarchy (the GLB's own root transform stays
   * internal). Instances are independent in transform and animation state and
   * share this resource's geometry/material/texture ownership.
   */
  createInstance(options?: CreateInstanceOptions):
    | { readonly ok: true; readonly instance: ModelInstance }
    | { readonly ok: false; readonly error: AdapterError };
  /** The file's pieces (top-level nodes grouped by `<piece>_LOD<n>`/`<piece>_COL`). */
  pieces(): readonly { readonly name: string; readonly lods: number; readonly hasCollider: boolean; readonly skinned: boolean }[];
  /** The 2D collider polygon from a piece's `_COL` node (null piece = the file's single `_COL`). */
  collider2D(piece: string | null): [number, number][] | null;
  /** A piece's (or the whole file's) LOD0 bounds in the file's root space. */
  bounds(piece: string | null): THREE.Box3;
  diagnostics(): VisualResourceDiagnostics;
  ownership(): ResourceOwnership;
  /** Retire the resource: no new instances; shared resources are released when
   *  the last live instance is gone. Idempotent. */
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
}

/** How an instance is built from the file. */
export interface CreateInstanceOptions {
  /** Keep only this piece (absent: the whole file). */
  readonly piece?: string;
  /** COLOR_0 as shader data (default) or as a base-colour tint. */
  readonly vertexColors?: VertexColorMode;
}

/** Preview-only material modes (local to one instance; never authored state). */
export type PreviewMaterialMode = 'asset' | 'wireframe' | 'normals';

/** Local preview state (not an animation system, not persisted). */
export interface PreviewState {
  readonly playing: boolean;
  readonly clipIndex: number | null;
  readonly timeSeconds: number;
  readonly durationSeconds: number;
  readonly clipCount: number;
  readonly materialMode: PreviewMaterialMode;
}

export type PreviewResult = { readonly ok: true } | { readonly ok: false; readonly error: AdapterError };

/**
 * Local material/animation preview controller for ONE model instance.
 *
 * It is a *preview* surface: play/pause/scrub drive a private
 * `THREE.AnimationMixer` rooted at the instance, and the material modes swap in
 * this controller's own override materials. Neither touches the resource's
 * materials, another instance, the runtime or the authoring scene. The host
 * owns the frame loop and calls `update(dt)` — this controller installs no loop
 * and reads no clock.
 */
export interface AssetPreviewController {
  clips(): readonly VisualClipInfo[];
  state(): PreviewState;
  /** Select the clip to preview (0-based, bounds-checked). */
  selectClip(index: number): PreviewResult;
  /** Start playing the selected clip (selecting clip 0 when none is). */
  play(): PreviewResult;
  pause(): PreviewResult;
  /** Position the selected clip in seconds (finite, clamped to its duration). */
  scrub(seconds: number): PreviewResult;
  /** Advance the local preview clock; the host owns the frame loop. */
  update(deltaSeconds: number): PreviewResult;
  setMaterialMode(mode: PreviewMaterialMode): PreviewResult;
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
}

/** One model instance: an entity-level holder for the preserved GLB hierarchy. */
export interface ModelInstance {
  readonly descriptor: AssetVersionDescriptor;
  /** The entity-level holder (one `Group`); the GLB hierarchy is its child. */
  readonly root: THREE.Object3D;
  /** The preserved GLB hierarchy inside `root` (read-only use). */
  readonly glbRoot: THREE.Object3D;
  clips(): readonly VisualClipInfo[];
  /** The loaded clips of this resource (packet 53: the role controller's
   *  stage 3 / stage 5–6 re-check input, presentation.md §41.3.6 rule 7). */
  animationClips(): readonly THREE.AnimationClip[];
  /** Copy the entity transform into `root` (the adapter's single transform-applying helper). */
  setTransform(position: AdapterVec3, rotation: AdapterQuat, scale: AdapterVec3): void;
  /** Create this instance's local preview controller. */
  createPreviewController():
    | { readonly ok: true; readonly controller: AssetPreviewController }
    | { readonly ok: false; readonly error: AdapterError };
  /** Release this instance (mixers/controllers and the resource's instance
   *  reference); shared resources stay owned by the resource. Idempotent. */
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
}

/** The §18.7.2 step-1 source bound (defensive copy: the adapter imports no asset-pipeline constant). */
export const VISUAL_SOURCE_BYTES_MAX = 33_554_432;

/**
 * Packet 53 (presentation.md §41.6 mixer row): role controllers are tracked
 * per instance so `ModelInstance.dispose()` releases each one exactly once
 * (idempotence makes the controller's own `dispose()` path a no-op on the
 * second release). Internal module surface — not part of the public exports;
 * `animation.ts` attaches/detaches, the instance handle disposes.
 */
export type RoleControllerHandle = {
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
};

const roleControllers = new WeakMap<ModelInstance, Set<RoleControllerHandle>>();
const instanceDisposed = new WeakSet<ModelInstance>();

/** Attach a role controller to its instance (the mixer row's disposer link). */
export function trackRoleController(instance: ModelInstance, controller: RoleControllerHandle): void {
  let set = roleControllers.get(instance);
  if (set === undefined) {
    set = new Set();
    roleControllers.set(instance, set);
  }
  set.add(controller);
}

/** Detach a role controller after it disposed itself (idempotent). */
export function untrackRoleController(instance: ModelInstance, controller: RoleControllerHandle): void {
  roleControllers.get(instance)?.delete(controller);
}

/** The attach guard: creating a role controller for a disposed instance is `asset_disposed`. */
export function roleControllerAttachError(instance: ModelInstance): AdapterError | null {
  return instanceDisposed.has(instance) ? adapterError('asset_disposed', 'the model instance is disposed') : null;
}

/** Bounded clip validation (project-model §18.6 animation caps: 64 clips / 4096 channels). */
const CLIP_LIMIT = 64;
const CLIP_TRACK_LIMIT = 4096;
const CLIP_TRACK_TIMES_LIMIT = 65_536;
const CLIP_TOTAL_TIMES_LIMIT = 1_000_000;

function abortedError(reason: 'cancel' | 'stale'): AdapterError {
  return reason === 'stale'
    ? adapterError('asset_load_stale', 'the load was superseded by a newer load for this asset; its late completion was discarded')
    : adapterError('asset_load_cancelled', 'the load was cancelled; a late completion is discarded and released');
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** Validate the descriptor + source pair before any work (first failing step only). */
function validateSource(source: AssetByteSource | null | undefined): AdapterError | null {
  if (typeof source !== 'object' || source === null) {
    return adapterError('asset_source_invalid', 'no asset byte source was supplied');
  }
  const d = source.descriptor as AssetVersionDescriptor | undefined;
  if (typeof d !== 'object' || d === null) {
    return adapterError('asset_source_invalid', 'the asset byte source carries no version descriptor');
  }
  if (typeof d.assetId !== 'string' || d.assetId.length === 0 || d.assetId.length > 128) {
    return adapterError('asset_source_invalid', 'descriptor.assetId is missing or out of bounds');
  }
  if (!Number.isInteger(d.version) || d.version < 1 || d.version > 32) {
    return adapterError('asset_source_invalid', 'descriptor.version must be an integer in 1..32');
  }
  if (typeof d.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(d.sourceDigest)) {
    return adapterError('asset_source_invalid', 'descriptor.sourceDigest must be 64 lowercase hex characters');
  }
  if (!Number.isInteger(d.sourceByteLength) || d.sourceByteLength < 1 || d.sourceByteLength > VISUAL_SOURCE_BYTES_MAX) {
    return adapterError('asset_source_invalid', `descriptor.sourceByteLength must be an integer in 1..${VISUAL_SOURCE_BYTES_MAX}`);
  }
  if (source.kind === 'bytes') {
    if (!(source.bytes instanceof Uint8Array)) {
      return adapterError('asset_source_invalid', 'the bytes source carries no Uint8Array');
    }
    return null;
  }
  if (source.kind === 'resolver') {
    if (typeof source.resolve !== 'function') {
      return adapterError('asset_source_invalid', 'the resolver source carries no resolver function');
    }
    return null;
  }
  return adapterError('asset_source_invalid', 'the asset byte source is neither supplied bytes nor an injected resolver');
}

/** A track's key times: three.js stores them in a typed array (`KeyframeTrack#times`). */
function timesOf(track: unknown): ArrayLike<number> | null {
  if (typeof track !== 'object' || track === null) return null;
  const times = (track as { times?: unknown }).times;
  if (Array.isArray(times)) return times as number[];
  if (ArrayBuffer.isView(times) && !(times instanceof DataView)) return times as unknown as ArrayLike<number>;
  return null;
}

/** Validate the clips of one loaded GLB (bounded; first failure only). */
function validateClips(animations: readonly THREE.AnimationClip[]): AdapterError | null {
  if (!Array.isArray(animations)) {
    return adapterError('asset_corrupt', 'the loader result carries no animation clip list');
  }
  if (animations.length > CLIP_LIMIT) {
    return adapterError('asset_clip_invalid', `the loaded model carries ${animations.length} clips (max ${CLIP_LIMIT})`);
  }
  let totalTimes = 0;
  for (const [index, clip] of animations.entries()) {
    const clipLike = clip as Partial<THREE.AnimationClip> | undefined;
    if (typeof clipLike !== 'object' || clipLike === null || !Array.isArray(clipLike.tracks)) {
      return adapterError('asset_clip_invalid', `clip ${index} has no track list`);
    }
    if (typeof clipLike.duration !== 'number' || !Number.isFinite(clipLike.duration) || clipLike.duration < 0) {
      return adapterError('asset_clip_invalid', `clip ${index} has a non-finite duration`);
    }
    if (clipLike.tracks.length > CLIP_TRACK_LIMIT) {
      return adapterError('asset_clip_invalid', `clip ${index} carries ${clipLike.tracks.length} tracks (max ${CLIP_TRACK_LIMIT})`);
    }
    for (const track of clipLike.tracks) {
      const times = timesOf(track);
      if (times === null) {
        return adapterError('asset_clip_invalid', `clip ${index} carries a track without a time array`);
      }
      if (times.length === 0 || times.length > CLIP_TRACK_TIMES_LIMIT) {
        return adapterError('asset_clip_invalid', `clip ${index} carries a track with ${times.length} key times`);
      }
      totalTimes += times.length;
      if (totalTimes > CLIP_TOTAL_TIMES_LIMIT) {
        return adapterError('asset_clip_invalid', 'the loaded model carries too many animation key times');
      }
      let previous = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < times.length; i += 1) {
        const time = times[i];
        if (typeof time !== 'number' || !Number.isFinite(time) || time < previous) {
          return adapterError('asset_clip_invalid', `clip ${index} carries non-finite or non-monotonic key times`);
        }
        previous = time;
      }
    }
  }
  return null;
}

function clipInfos(animations: readonly THREE.AnimationClip[]): readonly VisualClipInfo[] {
  return animations.map((clip, index) => ({
    index,
    name: typeof clip.name === 'string' ? clip.name.slice(0, 128) : '',
    durationSeconds: clip.duration,
    trackCount: clip.tracks.length,
  }));
}

/** Module-private state shared by a resource, its instances and its controllers. */
interface ResourceInternals {
  isDisposed(): boolean;
}

interface CreateResourceHooks {
  readonly onInstanceCreated: () => void;
  readonly onInstanceDisposed: () => void;
}

function createInstanceHandle(
  descriptor: AssetVersionDescriptor,
  holder: THREE.Group,
  glbRoot: THREE.Object3D,
  clipInfo: readonly VisualClipInfo[],
  animations: readonly THREE.AnimationClip[],
  ledger: OwnershipLedger,
  internals: ResourceInternals,
  hooks: CreateResourceHooks,
): ModelInstance {
  let disposed = false;
  const controllers = new Set<AssetPreviewController>();

  const instance: ModelInstance = {
    descriptor,
    root: holder,
    glbRoot,
    clips: () => clipInfo,
    animationClips: () => animations,
    setTransform(position, rotation, scale) {
      // The adapter's single transform-applying helper (sync.ts) — no second
      // transform-math path (runtime.md §6).
      applyTransformToObject3D(holder, position, rotation, scale);
    },
    createPreviewController() {
      if (disposed) {
        return { ok: false as const, error: adapterError('asset_disposed', 'the model instance is disposed') };
      }
      const controller = createPreviewController(instance, clipInfo, animations, ledger, internals);
      controllers.add(controller);
      return { ok: true as const, controller };
    },
    dispose() {
      if (disposed) return { ok: true as const, alreadyDisposed: true as const };
      disposed = true;
      for (const controller of [...controllers]) {
        controller.dispose();
        controllers.delete(controller);
      }
      // Packet 53 (presentation.md §41.6): the tracked role controllers are
      // released exactly once here; each `dispose()` is idempotent and safe
      // mid-blend (§41.3.6 rule 8), so a controller already disposed by the
      // host is a no-op.
      for (const roleController of [...(roleControllers.get(instance) ?? [])]) {
        try {
          roleController.dispose();
        } catch {
          /* best effort: a controller disposal failure must not block the instance */
        }
      }
      roleControllers.delete(instance);
      instanceDisposed.add(instance);
      holder.remove(glbRoot);
      holder.removeFromParent();
      ledger.release('instance');
      hooks.onInstanceDisposed();
      return { ok: true as const };
    },
  };
  return instance;
}

function createPreviewController(
  instance: ModelInstance,
  clipInfo: readonly VisualClipInfo[],
  animations: readonly THREE.AnimationClip[],
  ledger: OwnershipLedger,
  internals: ResourceInternals,
): AssetPreviewController {
  let mixer: THREE.AnimationMixer | null = null;
  let action: THREE.AnimationAction | null = null;
  let clipIndex: number | null = null;
  let playing = false;
  let materialMode: PreviewMaterialMode = 'asset';
  let disposed = false;
  const overrides = new Map<PreviewMaterialMode, THREE.Material>();
  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  function invalid(): AdapterError | null {
    if (disposed) return adapterError('asset_disposed', 'the preview controller is disposed');
    if (internals.isDisposed()) return adapterError('asset_disposed', 'the prepared resource is disposed');
    return null;
  }

  function ensureMixer(): THREE.AnimationMixer {
    if (mixer === null) {
      mixer = new THREE.AnimationMixer(instance.root);
      ledger.allocate('mixer');
    }
    return mixer;
  }

  function select(index: number): AdapterError | null {
    if (!Number.isInteger(index) || index < 0 || index >= animations.length) {
      return adapterError('preview_invalid', `clip index ${String(index)} is out of range (0..${animations.length - 1})`);
    }
    if (clipIndex === index && action !== null) return null;
    const m = ensureMixer();
    if (action !== null) action.stop();
    action = m.clipAction(animations[index] as THREE.AnimationClip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    clipIndex = index;
    if (playing) action.play();
    m.update(0);
    return null;
  }

  function overrideMaterial(mode: PreviewMaterialMode): THREE.Material {
    const existing = overrides.get(mode);
    if (existing !== undefined) return existing;
    const material =
      mode === 'wireframe'
        ? new THREE.MeshBasicMaterial({ wireframe: true, color: 0x7fb2ff })
        : new THREE.MeshNormalMaterial();
    overrides.set(mode, material);
    ledger.allocate('material');
    return material;
  }

  function applyMaterialMode(mode: PreviewMaterialMode): void {
    if (mode === materialMode) return;
    if (mode === 'asset') {
      for (const [mesh, material] of originalMaterials) mesh.material = material;
      originalMaterials.clear();
    } else {
      const override = overrideMaterial(mode);
      instance.glbRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh !== true) return;
        if (!originalMaterials.has(mesh)) originalMaterials.set(mesh, mesh.material as THREE.Material | THREE.Material[]);
        mesh.material = override;
      });
    }
    materialMode = mode;
  }

  const controller: AssetPreviewController = {
    clips: () => clipInfo,
    state: () => ({
      playing,
      clipIndex,
      timeSeconds: action !== null ? action.time : 0,
      durationSeconds: clipIndex !== null ? (clipInfo[clipIndex]?.durationSeconds ?? 0) : 0,
      clipCount: clipInfo.length,
      materialMode,
    }),
    selectClip(index) {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      const err = select(index);
      if (err) return { ok: false, error: err };
      return { ok: true };
    },
    play() {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      if (clipInfo.length === 0) {
        return { ok: false, error: adapterError('preview_invalid', 'the model carries no animation clip to preview') };
      }
      if (action === null) {
        const err = select(clipIndex ?? 0);
        if (err) return { ok: false, error: err };
      }
      ensureMixer();
      if (action !== null) {
        action.paused = false;
        action.play();
      }
      playing = true;
      return { ok: true };
    },
    pause() {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      if (action !== null) action.paused = true;
      playing = false;
      return { ok: true };
    },
    scrub(seconds) {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      if (clipInfo.length === 0) {
        return { ok: false, error: adapterError('preview_invalid', 'the model carries no animation clip to scrub') };
      }
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        return { ok: false, error: adapterError('preview_invalid', 'scrub requires a finite, non-negative time in seconds') };
      }
      if (action === null) {
        const err = select(clipIndex ?? 0);
        if (err) return { ok: false, error: err };
      }
      const m = ensureMixer();
      const duration = clipIndex !== null ? (clipInfo[clipIndex]?.durationSeconds ?? 0) : 0;
      const at = Math.min(seconds, duration);
      // deltaTime 0 with an explicit action time applies the pose at `at`
      // whether the action is playing or paused.
      if (action !== null) action.time = at;
      m.update(0);
      return { ok: true };
    },
    update(deltaSeconds) {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      if (typeof deltaSeconds !== 'number' || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
        return { ok: false, error: adapterError('preview_invalid', 'update requires a finite, non-negative delta in seconds') };
      }
      if (!playing || mixer === null) return { ok: true };
      mixer.update(deltaSeconds);
      return { ok: true };
    },
    setMaterialMode(mode) {
      const bad = invalid();
      if (bad) return { ok: false, error: bad };
      if (mode !== 'asset' && mode !== 'wireframe' && mode !== 'normals') {
        return { ok: false, error: adapterError('preview_invalid', `unknown preview material mode '${String(mode)}'`) };
      }
      applyMaterialMode(mode);
      return { ok: true };
    },
    dispose() {
      if (disposed) return { ok: true, alreadyDisposed: true };
      disposed = true;
      playing = false;
      applyMaterialMode('asset');
      for (const material of overrides.values()) {
        try {
          material.dispose();
        } catch {
          /* best effort */
        }
        ledger.release('material');
      }
      overrides.clear();
      if (mixer !== null) {
        try {
          mixer.stopAllAction();
          mixer.uncacheRoot(instance.root);
        } catch {
          /* best effort */
        }
        ledger.release('mixer');
        mixer = null;
      }
      action = null;
      clipIndex = null;
      return { ok: true };
    },
  };
  return controller;
}

function createResource(descriptor: AssetVersionDescriptor, loaded: LoadedGlb, ledger: OwnershipLedger): PreparedVisualResource {
  const extras = loaded.ownership ?? {};
  const declared = {
    geometry: Math.max(0, Math.floor(extras.geometries ?? 0)),
    material: Math.max(0, Math.floor(extras.materials ?? 0)),
    texture: Math.max(0, Math.floor(extras.textures ?? 0)),
    listener: Math.max(0, Math.floor(extras.listeners ?? 0)),
    objectUrl: Math.max(0, Math.floor(extras.objectUrls ?? 0)),
  };
  ledger.allocate('geometry', declared.geometry);
  ledger.allocate('material', declared.material);
  ledger.allocate('texture', declared.texture);
  ledger.allocate('listener', declared.listener);
  ledger.allocate('objectUrl', declared.objectUrl);

  const clipInfo = clipInfos(loaded.animations);
  let disposed = false;
  let sharedReleased = false;
  let liveInstances = 0;

  function releaseShared(): void {
    if (sharedReleased) return;
    sharedReleased = true;
    try {
      loaded.dispose();
    } catch {
      /* best effort: a port's disposal failure must not throw across the edge */
    }
    ledger.release('geometry', declared.geometry);
    ledger.release('material', declared.material);
    ledger.release('texture', declared.texture);
    ledger.release('listener', declared.listener);
    ledger.release('objectUrl', declared.objectUrl);
  }

  const internals: ResourceInternals = { isDisposed: () => disposed };
  const hooks: CreateResourceHooks = {
    onInstanceCreated: () => {
      liveInstances += 1;
    },
    onInstanceDisposed: () => {
      liveInstances -= 1;
      if (disposed && liveInstances === 0) releaseShared();
    },
  };

  return {
    descriptor,
    clips: clipInfo,
    pieces() {
      return modelPieces(loaded.root).map((p) => ({
        name: p.name,
        lods: p.lods,
        hasCollider: p.collider !== null,
        skinned: p.nodes.some((n) => {
          let found = false;
          n.traverse((o) => {
            if ((o as THREE.SkinnedMesh).isSkinnedMesh === true) found = true;
          });
          return found;
        }),
      }));
    },
    collider2D(piece: string | null) {
      return pieceCollider2D(loaded.root, piece);
    },
    bounds(piece: string | null) {
      return pieceBounds(loaded.root, piece);
    },
    createInstance(options: CreateInstanceOptions = {}) {
      if (disposed) {
        return {
          ok: false as const,
          error: adapterError('asset_disposed', `asset ${descriptor.assetId} v${descriptor.version}: the prepared resource is disposed`),
        };
      }
      let glbRoot: THREE.Object3D;
      try {
        glbRoot = loaded.createInstance();
      } catch (e) {
        return { ok: false as const, error: adapterError('asset_corrupt', `the loader could not create an instance: ${messageOf(e)}`) };
      }
      if (typeof glbRoot !== 'object' || glbRoot === null || (glbRoot as { isObject3D?: boolean }).isObject3D !== true) {
        return { ok: false as const, error: adapterError('asset_corrupt', 'the loader returned a non-Object3D instance') };
      }
      if (options.piece !== undefined && !keepOnlyPiece(glbRoot, options.piece)) {
        return {
          ok: false as const,
          error: adapterError('model_piece_missing', `asset ${descriptor.assetId} v${descriptor.version} has no piece '${options.piece}'`),
        };
      }
      stripCollisionNodes(glbRoot);
      applyLodGroups(glbRoot);
      applyVertexColorMode(glbRoot, options.vertexColors ?? 'data');
      const holder = new THREE.Group();
      holder.name = `asset:${descriptor.assetId}@v${descriptor.version}`;
      holder.add(glbRoot);
      ledger.allocate('instance');
      hooks.onInstanceCreated();
      return {
        ok: true as const,
        instance: createInstanceHandle(descriptor, holder, glbRoot, clipInfo, loaded.animations, ledger, internals, hooks),
      };
    },
    diagnostics() {
      return {
        descriptor,
        state: disposed ? ('disposed' as const) : ('ready' as const),
        instances: liveInstances,
        clips: clipInfo.length,
        ownership: ledger.report(),
      };
    },
    ownership() {
      return ledger.report();
    },
    dispose() {
      if (disposed) return { ok: true as const, alreadyDisposed: true as const };
      disposed = true;
      if (liveInstances === 0) releaseShared();
      return { ok: true as const };
    },
  };
}

/** Internal prepare hooks (the store uses them for supersession bookkeeping). */
interface PrepareInternal {
  /** Records every resource this load ever created (the store's ledger view). */
  onResource?: (resource: PreparedVisualResource) => void;
}

/** A load handle with the store's supersession marker (module-private widening). */
interface InternalHandle extends VisualResourceHandle {
  /** Mark this load superseded by a newer load for the same asset. */
  markStale(): void;
}

/**
 * Start one load. The returned handle never rejects: cancellation and stale
 * supersession are structured results, and anything a discarded late completion
 * produced is released immediately (no leak).
 */
export function prepareVisualResource(source: AssetByteSource, options: PrepareVisualOptions): VisualResourceHandle {
  const { markStale: _markStale, ...handle } = startVisualLoad(source, options);
  void _markStale;
  return handle;
}

function startVisualLoad(source: AssetByteSource, options: PrepareVisualOptions, internal?: PrepareInternal): InternalHandle {
  const descriptor: AssetVersionDescriptor =
    (source as { descriptor?: AssetVersionDescriptor } | null | undefined)?.descriptor ?? {
      assetId: '',
      version: 0,
      sourceDigest: '',
      sourceByteLength: 0,
    };
  const ledger = new OwnershipLedger();
  const abort = new AbortController();
  let state: VisualResourceState = 'pending';
  let cancelReason: 'cancel' | 'stale' = 'cancel';

  const result = run().catch((e: unknown) => {
    state = 'failed';
    return { ok: false as const, error: adapterError('asset_corrupt', `unexpected visual load failure: ${messageOf(e)}`) };
  });

  const handle: InternalHandle = {
    descriptor,
    result,
    state: () => state,
    cancel() {
      if (state !== 'pending') return;
      cancelReason = 'cancel';
      // The disposition is immediate; `result` settles once the resolver/loader
      // releases its await (the late completion is still discarded and freed).
      state = 'cancelled';
      abort.abort();
    },
    markStale() {
      if (state !== 'pending') return;
      cancelReason = 'stale';
      state = 'stale';
      abort.abort();
    },
  };

  async function run(): Promise<PrepareVisualResult> {
    const sourceError = validateSource(source);
    if (sourceError !== null) {
      state = 'failed';
      return { ok: false, error: sourceError };
    }
    const loader = options.loader as GlbLoaderPort | undefined;
    if (typeof loader !== 'object' || loader === null || typeof loader.load !== 'function') {
      state = 'failed';
      return { ok: false, error: adapterError('asset_source_invalid', 'no GLB loader port was injected') };
    }

    // --- step 1: bytes (supplied) or the injected resolver -------------------
    let bytes: Uint8Array;
    if (source.kind === 'bytes') {
      bytes = source.bytes;
    } else {
      try {
        bytes = await source.resolve(abort.signal);
      } catch (e) {
        if (isAbort(e) || abort.signal.aborted) {
          state = cancelReason === 'stale' ? 'stale' : 'cancelled';
          return { ok: false, error: abortedError(cancelReason) };
        }
        state = 'failed';
        return { ok: false, error: adapterError('asset_missing', `the asset resolver failed: ${messageOf(e)}`) };
      }
    }
    if (abort.signal.aborted) {
      state = cancelReason === 'stale' ? 'stale' : 'cancelled';
      return { ok: false, error: abortedError(cancelReason) };
    }
    if (!(bytes instanceof Uint8Array)) {
      state = 'failed';
      return { ok: false, error: adapterError('asset_corrupt', 'the resolver did not return bytes') };
    }
    if (bytes.byteLength !== descriptor.sourceByteLength) {
      state = 'failed';
      return {
        ok: false,
        error: adapterError(
          'asset_corrupt',
          `byte length ${bytes.byteLength} does not match the pinned descriptor (${descriptor.sourceByteLength})`,
        ),
      };
    }

    // --- step 2: the injected loader port ------------------------------------
    let loaded: LoadedGlb;
    try {
      loaded = await loader.load(bytes, { signal: abort.signal, descriptor });
    } catch (e) {
      if (isAbort(e) || abort.signal.aborted) {
        state = cancelReason === 'stale' ? 'stale' : 'cancelled';
        return { ok: false, error: abortedError(cancelReason) };
      }
      if (isVisualLoadFailure(e)) {
        state = 'failed';
        return { ok: false, error: adapterError(REASON_TO_CODE[e.reason], e.message) };
      }
      state = 'failed';
      return { ok: false, error: adapterError('asset_corrupt', `the loader rejected the bytes: ${messageOf(e)}`) };
    }

    // --- step 3: the loaded result must be a real hierarchy ------------------
    const loadedError = validateLoaded(loaded);
    if (loadedError !== null) {
      disposeQuietly(loaded);
      state = 'failed';
      return { ok: false, error: loadedError };
    }

    // --- step 4: count ownership, then honour a late cancellation ------------
    const resource = createResource(descriptor, loaded, ledger);
    internal?.onResource?.(resource);
    if (abort.signal.aborted) {
      // The completion arrived after cancel/supersede: discard it and release
      // everything it produced (no leak, nothing handed to the caller).
      resource.dispose();
      state = cancelReason === 'stale' ? 'stale' : 'cancelled';
      return { ok: false, error: abortedError(cancelReason) };
    }
    state = 'ready';
    return { ok: true, resource };
  }

  return handle;
}

function validateLoaded(loaded: LoadedGlb | null | undefined): AdapterError | null {
  if (typeof loaded !== 'object' || loaded === null) {
    return adapterError('asset_corrupt', 'the loader port resolved without a loaded GLB');
  }
  const root = loaded.root as { isObject3D?: boolean } | undefined;
  if (typeof root !== 'object' || root === null || root.isObject3D !== true) {
    return adapterError('asset_corrupt', 'the loader port resolved without an Object3D hierarchy');
  }
  if (typeof loaded.createInstance !== 'function' || typeof loaded.dispose !== 'function') {
    return adapterError('asset_corrupt', 'the loader port result is missing createInstance()/dispose()');
  }
  return validateClips(loaded.animations);
}

function disposeQuietly(loaded: LoadedGlb): void {
  try {
    loaded.dispose();
  } catch {
    /* best effort */
  }
}

/** Options for one load through the store. */
export type VisualResourceStoreOptions = PrepareVisualOptions;

/** The store's supersession behaviour: one live load/resource per `assetId`. */
export interface VisualResourceStore {
  /** Start a load. A pending load for the same `assetId` becomes stale, and a
   *  settled resource for the same `assetId` is retired (its shared resources
   *  are released when its last live instance is disposed). */
  load(source: AssetByteSource, options: VisualResourceStoreOptions): VisualResourceHandle;
  /** The currently settled resource for an asset (null when none). */
  current(assetId: string): PreparedVisualResource | null;
  /** Cancel every pending load and retire every resource. Idempotent. */
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true };
  /** Aggregate ownership over every resource this store ever created. */
  ownership(): ResourceOwnership;
}

/**
 * Create the per-session visual resource store that realizes reimport
 * correctly: a newer version of an asset supersedes the older one without ever
 * mixing the two, and a late completion of the superseded load is discarded.
 */
export function createVisualResourceStore(): VisualResourceStore {
  const latest = new Map<string, InternalHandle>();
  const pending = new Map<string, InternalHandle>();
  const resources = new Map<string, PreparedVisualResource>();
  /** Every resource this store ever created (live or retired), for the aggregate. */
  const created: PreparedVisualResource[] = [];
  let disposed = false;

  return {
    load(source, options) {
      const assetId = typeof source?.descriptor?.assetId === 'string' ? source.descriptor.assetId : '';
      if (disposed) {
        return {
          descriptor: (source as { descriptor?: AssetVersionDescriptor } | null | undefined)?.descriptor ?? {
            assetId: '',
            version: 0,
            sourceDigest: '',
            sourceByteLength: 0,
          },
          result: Promise.resolve({
            ok: false as const,
            error: adapterError('asset_disposed', 'the visual resource store is disposed'),
          }),
          state: () => 'failed' as const,
          cancel: () => undefined,
        };
      }
      // A newer load for the same asset supersedes the older one: the older
      // pending load is marked stale (its late completion is discarded), and a
      // settled older resource is retired (released when its instances are gone).
      pending.get(assetId)?.markStale();
      const previousResource = resources.get(assetId);
      if (previousResource !== undefined) {
        previousResource.dispose();
        resources.delete(assetId);
      }
      const handle = startVisualLoad(source, options, {
        onResource: (resource) => {
          created.push(resource);
        },
      });
      latest.set(assetId, handle);
      pending.set(assetId, handle);
      void handle.result.then((res) => {
        if (pending.get(assetId) === handle) pending.delete(assetId);
        if (!res.ok) return;
        if (disposed || latest.get(assetId) !== handle) {
          // The store no longer owns this resource: release it now (the
          // instance/refcount rules still apply inside the resource).
          res.resource.dispose();
          return;
        }
        const existing = resources.get(assetId);
        if (existing !== undefined && existing !== res.resource) existing.dispose();
        resources.set(assetId, res.resource);
      });
      return handle;
    },
    current(assetId) {
      return resources.get(assetId) ?? null;
    },
    dispose() {
      if (disposed) return { ok: true, alreadyDisposed: true };
      disposed = true;
      for (const handle of pending.values()) handle.cancel();
      pending.clear();
      latest.clear();
      for (const resource of resources.values()) resource.dispose();
      resources.clear();
      return { ok: true };
    },
    ownership() {
      // Every resource reports its own live ledger (a retired resource keeps
      // its final counters), so a disposal count test can prove balance.
      return mergeOwnership(created.map((resource) => resource.ownership()));
    },
  };
}
