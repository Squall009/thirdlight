/**
 * Bounded glTF 2.0 GLB inspection — project-model.md §18.7/§18.8, the M2
 * import profile.
 *
 * `inspectGlb(bytes, options)` runs the §18.7.2 normative validation order and
 * stops at the first failing step, returning an `ImportProposal` with
 * `status: "rejected"` and that step's diagnostics (earlier steps' diagnostics
 * are never re-reported). A step may report several independent diagnostics;
 * at most `M2_GLTF_MAX_DIAGNOSTICS` are returned plus the true count.
 *
 * Purity (dependencies.md §4.1/§4.3): bytes in, proposal out. No I/O, no
 * Node built-ins, no `three`/GLTFLoader (the profile *is* the inspector), no
 * cache writes, no asset-ID decisions, no plugin registry, no URL fetch —
 * external/`data:` URIs are rejected, never resolved. The result is
 * deep-frozen validated data.
 *
 * Determinism (§18.8.3): for fixed `(bytes, profile, recipeVersion,
 * toolchain, job values)` the result is byte-identical. The only clock reads
 * are the injected job port's `now()` calls for the bounded timeout, and no
 * wall-clock value is ever persisted in the proposal.
 */

import type { AssetMetrics, ImportRecipe } from '@thirdlight/project-model';

import { decodedImageBytes, detectImageMime, imageDimensions, type ImportImageMime } from './images';
import { decodeMeshopt, MeshoptError, type MeshoptFilter, type MeshoptMode } from './meshopt';
import { escapePointer, strictJsonParse } from './json';
import {
  ANIMATION_PROFILE_MAX_CLIPS,
  ANIMATION_PROFILE_MAX_CLIP_MS,
  ANIMATION_PROFILE_MAX_TRACKS,
  ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP,
  ANIMATION_PROFILE_MAX_TRACK_TIMES,
  ANIMATION_ROLE_KEYS,
  ANIMATION_ROLE_NAME_CHARS,
  M2_GLTF_DECODED_GEOMETRY_BYTES,
  M2_GLTF_DECODED_IMAGE_BYTES,
  M2_GLTF_EXTENSION_ALLOWLIST,
  M2_GLTF_IMAGE_BYTES,
  M2_GLTF_INSPECTION_ENTRIES,
  M2_GLTF_INSPECTION_NAME_CHARS,
  M2_GLTF_INSPECTION_TIMEOUT_MS,
  M2_GLTF_JSON_CHUNK_BYTES,
  M2_GLTF_MAX_DIAGNOSTICS,
  M2_GLTF_PROFILE_LIMITS,
  M2_GLTF_SOURCE_BYTES,
  M2_GLTF_TOOLCHAIN,
  M2_GLTF_TOTAL_DECODED_BYTES,
  MODEL_MAX_MORPH_TARGETS,
  MODEL_MAX_SKIN_JOINTS,
  MODEL_MAX_SKINS,
} from './limits';
import { canonicalJsonText, sha256Hex, sha256HexOfText } from './sha256';
import type {
  AudioImportProposal,
  ImportDiagnostic,
  ImportDiagnosticCode,
  ImportInspection,
  ImportJobPort,
  ImportLimitName,
  ImportLimits,
  ImportMetadataFacts,
  ImportOptions,
  ImportProposal,
  PcmWavRecipe,
  PrepareImportOptions,
} from './types';

// --- small value helpers -----------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const COMPONENT_SIZES: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const UNSIGNED_COMPONENTS = new Set([5121, 5123, 5125]);

const ATTRIBUTE_ALLOWLIST = new Set([
  'POSITION',
  'NORMAL',
  'TANGENT',
  'TEXCOORD_0',
  'TEXCOORD_1',
  'COLOR_0',
  'JOINTS_0',
  'WEIGHTS_0',
]);

const ANIMATION_PATHS = new Set(['translation', 'rotation', 'scale', 'weights']);

const ANIMATION_OUTPUT_TYPES: Readonly<Record<string, string>> = {
  translation: 'VEC3',
  rotation: 'VEC4',
  scale: 'VEC3',
  weights: 'SCALAR',
};

const INTERPOLATIONS = new Set(['LINEAR', 'STEP', 'CUBICSPLINE']);

const CORE_MATERIAL_FIELDS = new Set([
  'name',
  'pbrMetallicRoughness',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
  'emissiveFactor',
  'alphaMode',
  'alphaCutoff',
  'doubleSided',
  'extensions',
]);

const CORE_PBR_FIELDS = new Set([
  'baseColorFactor',
  'baseColorTexture',
  'metallicFactor',
  'roughnessFactor',
  'metallicRoughnessTexture',
]);

const SAMPLER_FILTERS = new Set([9728, 9729, 9984, 9985, 9986, 9987]);

/** The glTF object kinds an `extensions` member can sit on. */
type ExtensionPlace =
  | 'root'
  | 'buffer'
  | 'bufferView'
  | 'accessor'
  | 'mesh'
  | 'primitive'
  | 'material'
  | 'textureInfo'
  | 'texture'
  | 'animation'
  | 'node'
  | 'scene';

/**
 * Where each allowlisted extension may carry an object. An allowlisted
 * extension in any other place is refused: it would be ignored there, and
 * ignoring an extension changes what the file means (§18.8.1).
 * `KHR_mesh_quantization` is a declaration only (it widens attribute types).
 */
const EXTENSION_PLACES: Readonly<Record<string, readonly ExtensionPlace[]>> = {
  EXT_meshopt_compression: ['buffer', 'bufferView'],
  EXT_texture_webp: ['texture'],
  KHR_draco_mesh_compression: ['primitive'],
  KHR_texture_basisu: ['texture'],
  KHR_materials_clearcoat: ['material'],
  KHR_materials_emissive_strength: ['material'],
  KHR_materials_ior: ['material'],
  KHR_materials_sheen: ['material'],
  KHR_materials_specular: ['material'],
  KHR_materials_transmission: ['material'],
  KHR_materials_unlit: ['material'],
  KHR_materials_volume: ['material'],
  KHR_mesh_quantization: [],
  KHR_texture_transform: ['textureInfo'],
};

/** The image containers a texture may use, by where it references the image. */
const CORE_TEXTURE_MIMES = new Set(['image/png', 'image/jpeg']);
const SAMPLER_WRAPS = new Set([33071, 33648, 10497]);

// --- diagnostics -------------------------------------------------------------

interface DiagExtra {
  readonly found?: unknown;
  readonly expected?: string;
  readonly limit?: ImportLimitName;
  readonly role?: string;
  readonly clipIndex?: number;
  readonly clips?: number;
  readonly roles?: readonly string[];
  readonly matches?: number;
  readonly nodeIndex?: number;
  readonly nodeName?: string;
}

function diag(
  code: ImportDiagnosticCode,
  path: string,
  message: string,
  extra: DiagExtra = {},
): ImportDiagnostic {
  const out: {
    code: ImportDiagnosticCode;
    path: string;
    message: string;
    found?: unknown;
    expected?: string;
    limit?: ImportLimitName;
    role?: string;
    clipIndex?: number;
    clips?: number;
    roles?: readonly string[];
    matches?: number;
    nodeIndex?: number;
    nodeName?: string;
  } = {
    code,
    path,
    message,
  };
  if (extra.found !== undefined) out.found = extra.found;
  if (extra.expected !== undefined) out.expected = extra.expected;
  if (extra.limit !== undefined) out.limit = extra.limit;
  if (extra.role !== undefined) out.role = extra.role;
  if (extra.clipIndex !== undefined) out.clipIndex = extra.clipIndex;
  if (extra.clips !== undefined) out.clips = extra.clips;
  if (extra.roles !== undefined) out.roles = extra.roles;
  if (extra.matches !== undefined) out.matches = extra.matches;
  if (extra.nodeIndex !== undefined) out.nodeIndex = extra.nodeIndex;
  if (extra.nodeName !== undefined) out.nodeName = extra.nodeName;
  return out;
}

/** JSON-Pointer path helper (`/meshes/0/primitives/1/attributes/POSITION`). */
function ptr(...tokens: (string | number)[]): string {
  let out = '';
  for (const t of tokens) out += `/${escapePointer(String(t))}`;
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(value) as T;
}

/** §8 `suggestedDisplayName`: 1–128 chars, no control characters, never an id. */
export function sanitizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') return '';
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
    if (out.length >= M2_GLTF_INSPECTION_NAME_CHARS) break;
  }
  return out.trim();
}

// --- injected job port -------------------------------------------------------

/** The resolved job identity shared by the GLB and WAV inspectors. */
export interface ResolvedJob {
  readonly now: () => number;
  readonly isCancelled: () => boolean;
  readonly proposalId: string;
  readonly stageId: string;
  readonly expiresAt: string;
  readonly timeoutMs: number;
  readonly suggestedDisplayName: string;
}

const RE_PROPOSAL_ID = /^p-[0-9a-f]{32}$/;

export function resolveImportJob(
  job: ImportJobPort | undefined,
  options: { readonly displayName?: string },
  sourceDigest: string,
): ResolvedJob {
  if (job === undefined) {
    // Pure inspection mode: no clock, no cancellation, deterministic identity
    // derived from the source digest (the proposal is non-authoritative and is
    // never persisted, §18.1/§18.4).
    return {
      now: () => 0,
      isCancelled: () => false,
      proposalId: `p-${sha256HexOfText(`thirdlight.import-proposal|${sourceDigest}`).slice(0, 32)}`,
      stageId: '',
      expiresAt: '',
      timeoutMs: M2_GLTF_INSPECTION_TIMEOUT_MS,
      suggestedDisplayName: sanitizeDisplayName(options.displayName),
    };
  }
  if (typeof job !== 'object' || job === null) {
    throw new TypeError('inspectGlb: job must be an object implementing ImportJobPort');
  }
  const proposalId = job.proposalId();
  if (typeof proposalId !== 'string' || !RE_PROPOSAL_ID.test(proposalId)) {
    throw new TypeError("inspectGlb: job.proposalId() must be 'p-' + 32 lowercase hex");
  }
  const stageId = job.stageId();
  if (typeof stageId !== 'string' || stageId.length === 0) {
    throw new TypeError('inspectGlb: job.stageId() must be a non-empty string');
  }
  const expiresAt = job.expiresAt();
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) {
    throw new TypeError('inspectGlb: job.expiresAt() must be a non-empty timestamp string');
  }
  const timeoutMs = job.timeoutMs ?? M2_GLTF_INSPECTION_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('inspectGlb: job.timeoutMs must be a positive finite number');
  }
  const name = job.suggestedDisplayName ?? options.displayName;
  return {
    now: () => job.now(),
    isCancelled: () => job.isCancelled(),
    proposalId,
    stageId,
    expiresAt,
    timeoutMs,
    suggestedDisplayName: sanitizeDisplayName(name),
  };
}

// --- options -----------------------------------------------------------------

function resolveToolchain(options: ImportOptions): Readonly<Record<string, string>> {
  const tc = options.toolchain;
  if (!isPlainObject(tc)) throw new TypeError('inspectGlb: toolchain must be an object');
  const names = Object.keys(tc).sort();
  if (names.length !== 1 || names[0] !== 'three') {
    throw new TypeError(
      "inspectGlb: the M2 toolchain must name exactly the pinned loader line ('three')",
    );
  }
  if (tc['three'] !== M2_GLTF_TOOLCHAIN.three) {
    throw new TypeError(
      `inspectGlb: toolchain.three must be the pinned value '${M2_GLTF_TOOLCHAIN.three}'`,
    );
  }
  return { three: M2_GLTF_TOOLCHAIN.three };
}

// --- role-aware animation profile (presentation.md §41.3) ---------------------

/** The caller-validated role mapping the proposal is checked against. */
interface ResolvedAnimation {
  readonly entityId: string;
  readonly roles: Readonly<Record<'idle' | 'run' | 'airborne', { readonly clipIndex: number; readonly clipName: string }>>;
}

const RE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate the supplied animated-profile request. Malformed *options* are a
 * caller programming error (stage 1–2 binding-field validation is the model's,
 * per §41.3.2), so they throw `TypeError` like every other option here; the
 * stages the pipeline does own (3–6 and A1–A6) report diagnostics.
 */
function resolveAnimation(options: ImportOptions): ResolvedAnimation | null {
  const animation = options.animation;
  if (animation === undefined) return null;
  if (!isPlainObject(animation)) throw new TypeError('inspectGlb: options.animation must be an object');
  if (animation['entityId'] !== undefined && typeof animation['entityId'] !== 'string') {
    throw new TypeError('inspectGlb: options.animation.entityId must be a string');
  }
  const roles = animation['roles'];
  if (!isPlainObject(roles)) throw new TypeError('inspectGlb: options.animation.roles must be an object');
  const keys = Object.keys(roles);
  for (const role of ANIMATION_ROLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(roles, role)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role} is required`);
    }
  }
  for (const k of keys) {
    if (!(ANIMATION_ROLE_KEYS as readonly string[]).includes(k)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${k} is not a role key`);
    }
  }
  const resolved: Record<string, { clipIndex: number; clipName: string }> = {};
  for (const role of ANIMATION_ROLE_KEYS) {
    const binding = roles[role];
    if (!isPlainObject(binding)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role} must be an object`);
    }
    const clipIndex = binding['clipIndex'];
    if (typeof clipIndex !== 'number' || !Number.isSafeInteger(clipIndex) || clipIndex < 0) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role}.clipIndex must be a non-negative integer`);
    }
    const clipName = binding['clipName'];
    if (
      typeof clipName !== 'string' ||
      clipName.length === 0 ||
      clipName.length > ANIMATION_ROLE_NAME_CHARS ||
      RE_CONTROL_CHARS.test(clipName)
    ) {
      throw new TypeError(
        `inspectGlb: options.animation.roles.${role}.clipName must be 1-${ANIMATION_ROLE_NAME_CHARS} characters without control characters`,
      );
    }
    resolved[role] = { clipIndex, clipName };
  }
  return {
    entityId: typeof animation['entityId'] === 'string' ? animation['entityId'] : '',
    roles: resolved as ResolvedAnimation['roles'],
  };
}

// --- the pipeline ------------------------------------------------------------

interface PrimitiveRef {
  readonly path: string;
  readonly attributes: ReadonlyMap<string, number>;
  readonly indices: number | null;
  readonly material: number | null;
}

interface AccessorInfo {
  readonly count: number;
  readonly type: string;
  readonly componentType: number;
  readonly byteLength: number;
}

class Inspector {
  private json: Record<string, unknown> = {};
  private jsonChunk: Uint8Array = new Uint8Array(0);
  private bin: Uint8Array = new Uint8Array(0);
  private bufferByteLength = 0;
  /** Validated bufferViews; `data` is the view's bytes (decoded when meshopt-compressed). */
  private bufferViews: { byteOffset: number; byteLength: number; buffer: number; compressed: boolean; data: Uint8Array }[] = [];
  /** Declared byteLength of each EXT_meshopt_compression fallback buffer (index > 0). */
  private fallbackBuffers = new Map<number, number>();
  private accessors: AccessorInfo[] = [];
  private primitives: PrimitiveRef[] = [];
  private imageDecodedBytes = 0;
  /** The detected container of each image (`null` = invalid), by index. */
  private imageMimes: (string | null)[] = [];
  /** `extensionsUsed` as declared (every extension object must be declared). */
  private declaredExtensions = new Set<string>();
  private clipDurationMs = 0;
  private startedAt = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly sourceDigest: string,
    private readonly recipe: ImportRecipe,
    private readonly job: ResolvedJob,
    private readonly animation: ResolvedAnimation | null,
  ) {}

  private limits(): ImportLimits {
    return {
      profile: 'gltf-glb',
      recipeVersion: 1,
      sourceBytes: M2_GLTF_SOURCE_BYTES,
      jsonChunkBytes: M2_GLTF_JSON_CHUNK_BYTES,
      imageBytes: M2_GLTF_IMAGE_BYTES,
      timeoutMs: this.job.timeoutMs,
      caps: M2_GLTF_PROFILE_LIMITS,
    };
  }

  private inspection(): ImportInspection {
    const names = (values: unknown): { list: string[]; truncated: boolean } => {
      const list: string[] = [];
      let truncated = false;
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value !== 'string') continue;
          if (list.length >= M2_GLTF_INSPECTION_ENTRIES) {
            truncated = true;
            break;
          }
          if (value.length > M2_GLTF_INSPECTION_NAME_CHARS) {
            list.push(value.slice(0, M2_GLTF_INSPECTION_NAME_CHARS));
            truncated = true;
          } else {
            list.push(value);
          }
        }
      }
      return { list, truncated };
    };
    const nodeNames = names(this.collection('nodes').map((n) => (isPlainObject(n) ? n['name'] : undefined)));
    const materialNames = names(
      this.collection('materials').map((m) => (isPlainObject(m) ? m['name'] : undefined)),
    );
    const clipNames = names(
      this.collection('animations').map((a) => (isPlainObject(a) ? a['name'] : undefined)),
    );
    const scenes = this.json['scenes'];
    return {
      nodeNames: nodeNames.list,
      materialNames: materialNames.list,
      clipNames: clipNames.list,
      sceneCount: Array.isArray(scenes) ? scenes.length : 0,
      truncated: nodeNames.truncated || materialNames.truncated || clipNames.truncated,
    };
  }

  /** `json[key]` as an array (absent/other types give `[]`). */
  private collection(key: string): unknown[] {
    const value = this.json[key];
    return Array.isArray(value) ? value : [];
  }

  /** The used, allowlisted extensions of this source (sorted, §18.5). */
  private usedExtensions(): string[] {
    const used = this.json['extensionsUsed'];
    if (!Array.isArray(used)) return [];
    const out = new Set<string>();
    for (const e of used) {
      if (typeof e === 'string' && M2_GLTF_EXTENSION_ALLOWLIST.includes(e)) out.add(e);
    }
    return [...out].sort();
  }

  private proposal(
    status: 'ok' | 'rejected',
    diagnostics: ImportDiagnostic[],
    metrics: AssetMetrics | null,
  ): ImportProposal {
    const base = {
      proposalId: this.job.proposalId,
      stageId: this.job.stageId,
      sourceDigest: this.sourceDigest,
      sourceByteLength: this.bytes.length,
      status,
      importRecipe: { ...this.recipe, extensions: this.usedExtensions() },
      suggestedDisplayName: this.job.suggestedDisplayName,
      inspection: this.inspection(),
      diagnostics: diagnostics.slice(0, M2_GLTF_MAX_DIAGNOSTICS),
      diagnosticCount: diagnostics.length,
      expiresAt: this.job.expiresAt,
      limits: this.limits(),
    };
    if (status === 'ok' && metrics !== null) {
      return deepFreeze({ ...base, kind: 'model' as const, metrics });
    }
    return deepFreeze(base);
  }

  private reject(diagnostics: ImportDiagnostic[]): ImportProposal {
    return this.proposal('rejected', diagnostics, null);
  }

  /** `null` = proceed; otherwise the timeout/cancellation rejection. */
  private guard(): ImportProposal | null {
    if (this.job.isCancelled()) {
      return this.reject([
        diag('asset_timeout', '', 'inspection cancelled by the caller', {
          expected: 'inspection to finish within the job budget',
        }),
      ]);
    }
    if (this.job.now() - this.startedAt > this.job.timeoutMs) {
      return this.reject([
        diag('asset_timeout', '', `inspection exceeded the ${this.job.timeoutMs} ms job limit`, {
          expected: 'inspection to finish within the job budget',
        }),
      ]);
    }
    return null;
  }

  run(): ImportProposal {
    this.startedAt = this.job.now();

    // 0 — injected job cancellation/deadline.
    let g = this.guard();
    if (g !== null) return g;

    // 1 — size.
    if (this.bytes.length < 1 || this.bytes.length > M2_GLTF_SOURCE_BYTES) {
      return this.reject([
        diag('asset_size_exceeded', '', `source must be 1-${M2_GLTF_SOURCE_BYTES} bytes`, {
          found: this.bytes.length,
          expected: `1 .. ${M2_GLTF_SOURCE_BYTES}`,
          limit: 'source_bytes',
        }),
      ]);
    }

    // 2 — container.
    g = this.guard();
    if (g !== null) return g;
    const container = this.checkContainer();
    if (container !== null) return this.reject(container);

    // 3 — chunk framing (also fills this.bin).
    g = this.guard();
    if (g !== null) return g;
    const framing = this.checkChunks();
    if (framing !== null) return this.reject(framing);

    // 4 — strict JSON.
    g = this.guard();
    if (g !== null) return g;
    const json = this.checkJson();
    if (json !== null) return this.reject(json);

    // 5 — glTF version and extensions.
    g = this.guard();
    if (g !== null) return g;
    const version = this.checkVersionAndExtensions();
    if (version !== null) return this.reject(version);

    // 6 — buffers.
    g = this.guard();
    if (g !== null) return g;
    const buffers = this.checkBuffers();
    if (buffers !== null) return this.reject(buffers);

    // 7 — bufferViews.
    g = this.guard();
    if (g !== null) return g;
    const bufferViews = this.checkBufferViews();
    if (bufferViews !== null) return this.reject(bufferViews);

    // 8 — accessors.
    g = this.guard();
    if (g !== null) return g;
    const accessors = this.checkAccessors();
    if (accessors !== null) return this.reject(accessors);

    // 9 — meshes and primitives.
    g = this.guard();
    if (g !== null) return g;
    const meshes = this.checkMeshes();
    if (meshes !== null) return this.reject(meshes);

    // 10 — materials.
    g = this.guard();
    if (g !== null) return g;
    const materials = this.checkMaterials();
    if (materials !== null) return this.reject(materials);

    // 11 — images.
    g = this.guard();
    if (g !== null) return g;
    const images = this.checkImages();
    if (images !== null) return this.reject(images);

    // 12 — textures and samplers.
    g = this.guard();
    if (g !== null) return g;
    const textures = this.checkTextures();
    if (textures !== null) return this.reject(textures);

    // 13 — animations.
    g = this.guard();
    if (g !== null) return g;
    const animations = this.checkAnimations();
    if (animations !== null) return this.reject(animations);

    // 14 — nodes and scenes.
    g = this.guard();
    if (g !== null) return g;
    const nodes = this.checkNodesAndScenes();
    if (nodes !== null) return this.reject(nodes);

    // 14b — skin and morph target caps (≤ 4 influences: only JOINTS_0/WEIGHTS_0 are allowed attributes).
    const rig = this.checkRigCaps();
    if (rig !== null) return this.reject(rig);

    // 15 — decoded limits.
    g = this.guard();
    if (g !== null) return g;
    const metrics = this.computeMetrics();
    const limits = checkMetricCaps(metrics, this.imageDecodedBytes);
    if (limits.length > 0) return this.reject(limits);

    // 16 — non-empty.
    g = this.guard();
    if (g !== null) return g;
    if (metrics.meshes === 0 || metrics.vertices === 0) {
      return this.reject([
        diag('asset_empty_model', ptr('meshes'), 'a model must carry geometry', {
          found: { meshes: metrics.meshes, vertices: metrics.vertices },
          expected: 'meshes >= 1 and vertices >= 1',
        }),
      ]);
    }

    // 16b — animated-model profile (presentation.md §41.3.2 stages 3–6 and
    // §41.3.3 A1–A6), only when the caller requested it. The accepted M2
    // proposal above is unchanged for every other caller.
    if (this.animation !== null) {
      g = this.guard();
      if (g !== null) return g;
      const profile = this.checkAnimationProfile(metrics);
      if (profile !== null) return this.reject(profile);
    }

    // 17 — accept.
    g = this.guard();
    if (g !== null) return g;
    return this.proposal('ok', [], metrics);
  }

  // --- steps ---------------------------------------------------------------

  private checkContainer(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    if (this.bytes.length < 12) {
      out.push(
        diag('asset_container_invalid', '', 'source is shorter than the 12-byte GLB header', {
          found: this.bytes.length,
          expected: 'a complete 12-byte GLB header',
        }),
      );
      return out;
    }
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const magic = dv.getUint32(0, true);
    const version = dv.getUint32(4, true);
    const declared = dv.getUint32(8, true);
    if (magic !== GLB_MAGIC) {
      out.push(
        diag('asset_container_invalid', '', 'GLB magic must be "glTF"', {
          found: `0x${magic.toString(16).padStart(8, '0')}`,
          expected: '0x46546c67 ("glTF")',
        }),
      );
    }
    if (version !== GLB_VERSION) {
      out.push(
        diag('asset_container_invalid', '', 'GLB container version must be 2', {
          found: version,
          expected: '2',
        }),
      );
    }
    if (declared !== this.bytes.length) {
      out.push(
        diag('asset_container_invalid', '', 'GLB declared length must equal the actual byte length', {
          found: { declared, actual: this.bytes.length },
          expected: 'declared length === actual byte length',
        }),
      );
    }
    return out.length > 0 ? out : null;
  }

  private checkChunks(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const len = this.bytes.length;
    const chunks: { type: number; dataStart: number; length: number }[] = [];
    let off = 12;
    while (off < len) {
      if (off + 8 > len) {
        out.push(
          diag('asset_container_invalid', '', 'chunk header is truncated', {
            found: len - off,
            expected: 'a complete 8-byte chunk header',
          }),
        );
        return out;
      }
      const chunkLength = dv.getUint32(off, true);
      const chunkType = dv.getUint32(off + 4, true);
      if (chunkLength % 4 !== 0) {
        out.push(
          diag('asset_container_invalid', '', 'chunk length must be a multiple of 4', {
            found: chunkLength,
            expected: 'chunk length % 4 === 0',
          }),
        );
        return out;
      }
      if (off + 8 + chunkLength > len) {
        out.push(
          diag('asset_container_invalid', '', 'chunk length overruns the declared container length', {
            found: { chunkLength, remaining: len - off - 8 },
            expected: 'chunk bytes exactly fill the declared container length',
          }),
        );
        return out;
      }
      chunks.push({ type: chunkType, dataStart: off + 8, length: chunkLength });
      off += 8 + chunkLength;
    }
    if (off !== len) {
      out.push(
        diag('asset_container_invalid', '', 'trailing bytes after the last chunk', {
          found: len - off,
          expected: 'no trailing bytes',
        }),
      );
      return out;
    }
    if (chunks.length !== 2) {
      out.push(
        diag('asset_container_invalid', '', 'GLB must carry exactly a JSON chunk and a BIN chunk', {
          found: chunks.length,
          expected: '2 chunks (JSON then BIN)',
        }),
      );
      return out;
    }
    const json = chunks[0] as { type: number; dataStart: number; length: number };
    const bin = chunks[1] as { type: number; dataStart: number; length: number };
    if (json.type !== CHUNK_JSON) {
      out.push(
        diag('asset_container_invalid', ptr(), 'chunk 0 must be the JSON chunk', {
          found: `0x${json.type.toString(16).padStart(8, '0')}`,
          expected: '0x4e4f534a ("JSON")',
        }),
      );
    }
    if (bin.type !== CHUNK_BIN) {
      out.push(
        diag('asset_container_invalid', ptr(), 'chunk 1 must be the BIN chunk', {
          found: `0x${bin.type.toString(16).padStart(8, '0')}`,
          expected: '0x004e4942 ("BIN\\0")',
        }),
      );
    }
    if (out.length > 0) return out;
    this.jsonChunk = this.bytes.subarray(json.dataStart, json.dataStart + json.length);
    this.bin = this.bytes.subarray(bin.dataStart, bin.dataStart + bin.length);
    return null;
  }

  private checkJson(): ImportDiagnostic[] | null {
    if (this.jsonChunk.length > M2_GLTF_JSON_CHUNK_BYTES) {
      return [
        diag('asset_json_invalid', '', 'the JSON chunk exceeds the profile cap', {
          found: this.jsonChunk.length,
          expected: `<= ${M2_GLTF_JSON_CHUNK_BYTES} bytes`,
          limit: 'json_chunk_bytes',
        }),
      ];
    }
    const parsed = strictJsonParse(this.jsonChunk);
    if (!parsed.ok) {
      const reason: Record<typeof parsed.reason, string> = {
        bom: 'the JSON chunk must not start with a byte-order mark',
        encoding: 'the JSON chunk is not valid UTF-8',
        syntax: 'the JSON chunk is not strict RFC 8259 JSON',
        duplicate: 'the JSON chunk repeats an object member name',
      };
      return [
        diag('asset_json_invalid', parsed.path, reason[parsed.reason], {
          expected: 'strict UTF-8 JSON with unique keys and an object root',
        }),
      ];
    }
    if (!isPlainObject(parsed.value)) {
      return [
        diag('asset_json_invalid', '', 'the glTF JSON root must be an object', {
          found: Array.isArray(parsed.value) ? 'array' : typeof parsed.value,
          expected: 'object',
        }),
      ];
    }
    this.json = parsed.value;
    return null;
  }

  private checkVersionAndExtensions(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const asset = this.json['asset'];
    if (!isPlainObject(asset)) {
      out.push(
        diag('asset_version_unsupported', ptr('asset'), 'glTF requires an asset object', {
          found: asset === undefined ? 'absent' : typeof asset,
          expected: 'an object with version "2.0"',
        }),
      );
      return out;
    }
    if (asset['version'] !== '2.0') {
      out.push(
        diag('asset_version_unsupported', ptr('asset', 'version'), 'only glTF 2.0 is in the M2 profile', {
          found: asset['version'],
          expected: '"2.0"',
        }),
      );
    }

    const used = this.json['extensionsUsed'];
    const required = this.json['extensionsRequired'];
    const usedList: string[] = [];
    if (used !== undefined) {
      if (!Array.isArray(used) || used.some((e) => typeof e !== 'string')) {
        out.push(
          diag('asset_extension_unsupported', ptr('extensionsUsed'), 'extensionsUsed must be an array of strings', {
            found: used,
            expected: 'an array of extension names',
          }),
        );
      } else {
        for (const e of used as string[]) usedList.push(e);
      }
    }
    const requiredList: string[] = [];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((e) => typeof e !== 'string')) {
        out.push(
          diag('asset_extension_unsupported', ptr('extensionsRequired'), 'extensionsRequired must be an array of strings', {
            found: required,
            expected: 'an array of extension names',
          }),
        );
      } else {
        for (const e of required as string[]) requiredList.push(e);
      }
    }

    if (out.length > 0) return out;

    for (const name of usedList) {
      if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
        out.push(
          diag(
            'asset_extension_unsupported',
            ptr('extensionsUsed'),
            `extension "${name}" in extensionsUsed is outside the effective allowlist`,
            { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
          ),
        );
      }
    }
    for (const name of requiredList) {
      if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
        out.push(
          diag(
            'asset_extension_unsupported',
            ptr('extensionsRequired'),
            `required extension "${name}" is outside the effective allowlist`,
            { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
          ),
        );
      } else if (!usedList.includes(name)) {
        out.push(
          diag(
            'asset_extension_unsupported',
            ptr('extensionsRequired'),
            `required extension "${name}" must be declared in extensionsUsed`,
            { found: name, expected: 'an allowlisted, declared extension' },
          ),
        );
      }
    }
    this.declaredExtensions = new Set(usedList);
    this.checkExtensionObject(this.json, '', out, 'root');
    return out.length > 0 ? out : null;
  }

  /**
   * §18.8.1: "Extensions are never silently ignored, because ignoring one
   * changes what the file means." Every `extensions` member the profile visits
   * must therefore be empty or allowlisted.
   */
  private checkExtensionObject(
    owner: Record<string, unknown>,
    path: string,
    out: ImportDiagnostic[],
    place: ExtensionPlace,
  ): void {
    const ext = owner['extensions'];
    if (ext === undefined) return;
    if (!isPlainObject(ext)) {
      out.push(
        diag('asset_extension_unsupported', `${path}/extensions`, 'extensions must be an object', {
          found: ext,
          expected: 'an object of allowlisted extensions',
        }),
      );
      return;
    }
    for (const name of Object.keys(ext)) {
      const epath = `${path}/extensions/${escapePointer(name)}`;
      if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
        out.push(
          diag(
            'asset_extension_unsupported',
            epath,
            `extension "${name}" is outside the effective allowlist`,
            { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
          ),
        );
        continue;
      }
      if (!(EXTENSION_PLACES[name] ?? []).includes(place)) {
        out.push(
          diag('asset_extension_unsupported', epath, `extension "${name}" is not supported on a ${place}`, {
            found: name,
            expected: `on ${(EXTENSION_PLACES[name] ?? []).join(' | ') || 'no object (a declaration only)'}`,
          }),
        );
        continue;
      }
      if (!this.declaredExtensions.has(name)) {
        out.push(
          diag('asset_extension_unsupported', epath, `extension "${name}" is used but not declared in extensionsUsed`, {
            found: name,
            expected: 'every used extension listed in extensionsUsed',
          }),
        );
        continue;
      }
      if (!isPlainObject(ext[name])) {
        out.push(
          diag('asset_extension_unsupported', epath, `extension "${name}" must be an object`, {
            found: typeof ext[name],
            expected: 'an object',
          }),
        );
      }
    }
  }

  private checkBuffers(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const buffers = this.json['buffers'];
    if (!Array.isArray(buffers) || buffers.length < 1) {
      out.push(
        diag('asset_buffer_invalid', ptr('buffers'), 'the profile requires one embedded buffer (plus EXT_meshopt_compression fallbacks)', {
          found: Array.isArray(buffers) ? buffers.length : buffers === undefined ? 'absent' : typeof buffers,
          expected: 'one buffer without uri',
        }),
      );
      return out;
    }
    // Buffers after the first can only be EXT_meshopt_compression fallbacks:
    // no data (no uri) — the compressed bufferViews decode into them.
    for (let i = 1; i < buffers.length; i++) {
      const fb = buffers[i];
      const fpath = ptr('buffers', i);
      const fext = isPlainObject(fb) && isPlainObject(fb['extensions']) ? fb['extensions']['EXT_meshopt_compression'] : undefined;
      const length = isPlainObject(fb) ? fb['byteLength'] : undefined;
      if (!isPlainObject(fb) || fb['uri'] !== undefined || !isPlainObject(fext) || fext['fallback'] !== true) {
        out.push(
          diag('asset_buffer_invalid', fpath, 'a second buffer is only allowed as an EXT_meshopt_compression fallback without uri', {
            found: isPlainObject(fb) ? Object.keys(fb) : typeof fb,
            expected: '{ byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } }',
          }),
        );
        continue;
      }
      this.checkExtensionObject(fb, fpath, out, 'buffer');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > M2_GLTF_DECODED_GEOMETRY_BYTES) {
        out.push(
          diag('asset_buffer_invalid', `${fpath}/byteLength`, 'a fallback buffer byteLength must be an integer within the decoded-geometry cap', {
            found: length,
            expected: `0 .. ${M2_GLTF_DECODED_GEOMETRY_BYTES}`,
          }),
        );
        continue;
      }
      this.fallbackBuffers.set(i, length);
    }
    if (out.length > 0) return out;
    const buffer = buffers[0];
    if (!isPlainObject(buffer)) {
      out.push(
        diag('asset_buffer_invalid', ptr('buffers', 0), 'buffer must be an object', {
          found: typeof buffer,
          expected: 'an object',
        }),
      );
      return out;
    }
    if (buffer['uri'] !== undefined) {
      out.push(
        diag('asset_uri_rejected', ptr('buffers', 0, 'uri'), 'buffers must be embedded in the BIN chunk; URIs are never fetched', {
          found: buffer['uri'],
          expected: 'no uri member',
        }),
      );
      return out;
    }
    const byteLength = buffer['byteLength'];
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      out.push(
        diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'buffer byteLength must be a non-negative integer', {
          found: byteLength,
          expected: 'a non-negative integer',
        }),
      );
      return out;
    }
    if (byteLength > this.bin.length) {
      out.push(
        diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'buffer byteLength exceeds the BIN chunk', {
          found: byteLength,
          expected: `<= ${this.bin.length}`,
        }),
      );
      return out;
    }
    if (this.bin.length - byteLength > 3) {
      out.push(
        diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'BIN chunk padding after the buffer must be at most 3 bytes', {
          found: this.bin.length - byteLength,
          expected: 'BIN chunk length - buffer byteLength <= 3',
        }),
      );
      return out;
    }
    this.bufferByteLength = byteLength;
    return null;
  }

  private checkBufferViews(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const raw = this.json['bufferViews'];
    if (raw !== undefined && !Array.isArray(raw)) {
      return [
        diag('asset_buffer_invalid', ptr('bufferViews'), 'bufferViews must be an array', {
          found: typeof raw,
          expected: 'an array',
        }),
      ];
    }
    const list = Array.isArray(raw) ? raw : [];
    const referencedByAccessor = accessorBufferViewReferences(this.json, list.length);
    for (let i = 0; i < list.length; i++) {
      const bv = list[i];
      const path = ptr('bufferViews', i);
      if (!isPlainObject(bv)) {
        out.push(diag('asset_buffer_invalid', path, 'bufferView must be an object', { found: typeof bv, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(bv, path, out, 'bufferView');
      const meshopt = isPlainObject(bv['extensions']) ? bv['extensions']['EXT_meshopt_compression'] : undefined;
      const bufferIndex = bv['buffer'] ?? 0;
      const bufferLength = bufferIndex === 0 ? this.bufferByteLength : typeof bufferIndex === 'number' ? this.fallbackBuffers.get(bufferIndex) : undefined;
      if (bufferLength === undefined || (bufferIndex !== 0 && meshopt === undefined)) {
        out.push(
          diag('asset_buffer_invalid', `${path}/buffer`, 'a bufferView must reference buffer 0, or a fallback buffer when it is EXT_meshopt_compression-compressed', {
            found: bufferIndex,
            expected: '0 (or a fallback buffer with EXT_meshopt_compression)',
          }),
        );
        continue;
      }
      const byteOffset = bv['byteOffset'] ?? 0;
      if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
        out.push(
          diag('asset_buffer_invalid', `${path}/byteOffset`, 'bufferView byteOffset must be a non-negative integer', {
            found: byteOffset,
            expected: 'a non-negative integer',
          }),
        );
        continue;
      }
      const byteLength = bv['byteLength'];
      if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1) {
        out.push(
          diag('asset_buffer_invalid', `${path}/byteLength`, 'bufferView byteLength must be a positive integer', {
            found: byteLength,
            expected: 'a positive integer',
          }),
        );
        continue;
      }
      // glTF 2.0 alignment: a bufferView consumed by accessors must start at a
      // 4-byte boundary (see the packet-24 contract-change request C24-2 for
      // the literal "byteOffset <= 3" wording in §18.7.2 step 7).
      if (referencedByAccessor.has(i) && byteOffset % 4 !== 0) {
        out.push(
          diag('asset_buffer_invalid', `${path}/byteOffset`, 'an accessor-backed bufferView must be 4-byte aligned', {
            found: byteOffset,
            expected: 'byteOffset % 4 === 0',
          }),
        );
        continue;
      }
      if (byteOffset + byteLength > bufferLength) {
        out.push(
          diag('asset_buffer_invalid', `${path}/byteLength`, 'bufferView range overruns its buffer', {
            found: { byteOffset, byteLength, bufferByteLength: bufferLength },
            expected: 'byteOffset + byteLength <= buffer byteLength',
          }),
        );
        continue;
      }
      const target = bv['target'];
      if (target !== undefined && target !== 34962 && target !== 34963) {
        out.push(
          diag('asset_buffer_invalid', `${path}/target`, 'bufferView target must be ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER', {
            found: target,
            expected: '34962 or 34963',
          }),
        );
        continue;
      }
      let data: Uint8Array;
      if (meshopt !== undefined) {
        const decoded = this.decodeMeshoptView(meshopt, byteLength, path, out);
        if (decoded === null) continue;
        data = decoded;
      } else {
        data = this.bin.subarray(byteOffset, byteOffset + byteLength);
      }
      this.bufferViews.push({ byteOffset, byteLength, buffer: bufferIndex as number, compressed: meshopt !== undefined, data });
    }
    return out.length > 0 ? out : null;
  }

  /** Decoded bytes of all meshopt views so far (bounded by the decoded-geometry cap). */
  private meshoptDecodedBytes = 0;

  /**
   * Decode one EXT_meshopt_compression bufferView (its compressed stream lives
   * in the BIN chunk) into exactly `byteLength` bytes, or report why not.
   */
  private decodeMeshoptView(ext: unknown, byteLength: number, path: string, out: ImportDiagnostic[]): Uint8Array | null {
    const epath = `${path}/extensions/EXT_meshopt_compression`;
    const bad = (message: string, found: unknown, expected: string): null => {
      out.push(diag('asset_buffer_invalid', epath, message, { found, expected }));
      return null;
    };
    if (!isPlainObject(ext)) return bad('EXT_meshopt_compression must be an object', typeof ext, 'an object');
    const { buffer, byteOffset = 0, byteLength: srcLength, byteStride, count, mode, filter = 'NONE' } = ext as Record<string, unknown>;
    if (buffer !== 0) return bad('the compressed stream must be in buffer 0 (the BIN chunk)', buffer, '0');
    if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) return bad('byteOffset must be a non-negative integer', byteOffset, '>= 0');
    if (typeof srcLength !== 'number' || !Number.isSafeInteger(srcLength) || srcLength < 1 || byteOffset + srcLength > this.bufferByteLength) {
      return bad('the compressed range must lie inside the BIN chunk', { byteOffset, byteLength: srcLength }, `byteOffset + byteLength <= ${this.bufferByteLength}`);
    }
    if (mode !== 'ATTRIBUTES' && mode !== 'TRIANGLES' && mode !== 'INDICES') return bad('mode must be ATTRIBUTES, TRIANGLES or INDICES', mode, 'ATTRIBUTES | TRIANGLES | INDICES');
    if (filter !== 'NONE' && filter !== 'OCTAHEDRAL' && filter !== 'QUATERNION' && filter !== 'EXPONENTIAL') {
      return bad('filter must be NONE, OCTAHEDRAL, QUATERNION or EXPONENTIAL', filter, 'NONE | OCTAHEDRAL | QUATERNION | EXPONENTIAL');
    }
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return bad('count must be a positive integer', count, '>= 1');
    if (typeof byteStride !== 'number' || !Number.isSafeInteger(byteStride) || byteStride < 1 || byteStride > 256) return bad('byteStride must be 1..256', byteStride, '1 .. 256');
    if (count * byteStride !== byteLength) return bad('count * byteStride must equal the bufferView byteLength', { count, byteStride, byteLength }, `${byteLength}`);
    this.meshoptDecodedBytes += byteLength;
    if (this.meshoptDecodedBytes > M2_GLTF_DECODED_GEOMETRY_BYTES) {
      out.push(
        diag('asset_limits_exceeded', epath, 'the meshopt-compressed data decodes past the decoded-geometry cap', {
          found: this.meshoptDecodedBytes,
          expected: `<= ${M2_GLTF_DECODED_GEOMETRY_BYTES}`,
          limit: 'decoded_bytes',
        }),
      );
      return null;
    }
    try {
      return decodeMeshopt(this.bin.subarray(byteOffset, byteOffset + srcLength), count, byteStride, mode as MeshoptMode, filter as MeshoptFilter);
    } catch (e) {
      if (!(e instanceof MeshoptError)) throw e;
      return bad(`the meshopt-compressed stream does not decode: ${e.message}`, mode, 'a valid EXT_meshopt_compression stream');
    }
  }

  /** Accessors a KHR_draco_mesh_compression primitive decodes into (they carry no bufferView). */
  private dracoAccessors(): Set<number> {
    const out = new Set<number>();
    for (const mesh of this.collection('meshes')) {
      if (!isPlainObject(mesh) || !Array.isArray(mesh['primitives'])) continue;
      for (const p of mesh['primitives']) {
        if (!isPlainObject(p) || !isPlainObject(p['extensions']) || !isPlainObject(p['extensions']['KHR_draco_mesh_compression'])) continue;
        if (isPlainObject(p['attributes'])) for (const v of Object.values(p['attributes'])) if (asIndex(v) !== null) out.add(v as number);
        if (asIndex(p['indices']) !== null) out.add(p['indices'] as number);
      }
    }
    return out;
  }

  private checkAccessors(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const draco = this.dracoAccessors();
    const raw = this.json['accessors'];
    if (raw !== undefined && !Array.isArray(raw)) {
      return [
        diag('asset_accessor_invalid', ptr('accessors'), 'accessors must be an array', {
          found: typeof raw,
          expected: 'an array',
        }),
      ];
    }
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const path = ptr('accessors', i);
      if (!isPlainObject(a)) {
        out.push(diag('asset_accessor_invalid', path, 'accessor must be an object', { found: typeof a, expected: 'an object' }));
        continue;
      }
      if (a['sparse'] !== undefined) {
        out.push(
          diag('asset_accessor_unsupported', `${path}/sparse`, 'sparse accessors are not in the M2 profile', {
            found: 'sparse',
            expected: 'a fully embedded accessor',
          }),
        );
        continue;
      }
      this.checkExtensionObject(a, path, out, 'accessor');
      const componentType = a['componentType'];
      const componentSize =
        typeof componentType === 'number' ? COMPONENT_SIZES[componentType] : undefined;
      if (typeof componentType !== 'number' || componentSize === undefined) {
        out.push(
          diag('asset_accessor_invalid', `${path}/componentType`, 'accessor componentType is not a glTF 2.0 component type', {
            found: componentType,
            expected: '5120, 5121, 5122, 5123, 5125 or 5126',
          }),
        );
        continue;
      }
      const type = a['type'];
      const components = typeof type === 'string' ? TYPE_COMPONENTS[type] : undefined;
      if (components === undefined) {
        out.push(
          diag('asset_accessor_invalid', `${path}/type`, 'accessor type is not a glTF 2.0 accessor type', {
            found: type,
            expected: 'SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3 or MAT4',
          }),
        );
        continue;
      }
      const count = a['count'];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
        out.push(
          diag('asset_accessor_invalid', `${path}/count`, 'accessor count must be a positive integer', {
            found: count,
            expected: 'count >= 1',
          }),
        );
        continue;
      }
      const bufferViewIndex = a['bufferView'];
      if (bufferViewIndex === undefined && draco.has(i)) {
        // Filled by the Draco decoder at load; its size is the declared count.
        this.accessors.push({ count, type: typeof type === 'string' ? type : 'SCALAR', componentType, byteLength: count * components * componentSize });
        continue;
      }
      const bv = typeof bufferViewIndex === 'number' ? this.bufferViews[bufferViewIndex] : undefined;
      if (bv === undefined) {
        out.push(
          diag('asset_accessor_invalid', `${path}/bufferView`, 'accessor must reference an existing embedded bufferView', {
            found: bufferViewIndex,
            expected: `0 .. ${this.bufferViews.length - 1}`,
          }),
        );
        continue;
      }
      const byteOffset = a['byteOffset'] ?? 0;
      if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
        out.push(
          diag('asset_accessor_invalid', `${path}/byteOffset`, 'accessor byteOffset must be a non-negative integer', {
            found: byteOffset,
            expected: 'a non-negative integer',
          }),
        );
        continue;
      }
      if (byteOffset % componentSize !== 0) {
        out.push(
          diag('asset_accessor_invalid', `${path}/byteOffset`, 'accessor byteOffset must be aligned to its component size', {
            found: byteOffset,
            expected: `byteOffset % ${componentSize} === 0`,
          }),
        );
        continue;
      }
      const elementBytes = components * componentSize;
      const accessorBytes = count * elementBytes;
      if (!Number.isSafeInteger(accessorBytes) || byteOffset + accessorBytes > bv.byteLength) {
        out.push(
          diag('asset_accessor_invalid', path, 'accessor byte range overruns its bufferView', {
            found: { count, elementBytes, byteOffset, bufferViewByteLength: bv.byteLength },
            expected: 'byteOffset + count * elementBytes <= bufferView byteLength',
          }),
        );
        continue;
      }
      this.accessors.push({
        count,
        type: typeof type === 'string' ? type : 'SCALAR',
        componentType,
        byteLength: accessorBytes,
      });
    }
    return out.length > 0 ? out : null;
  }

  private checkMeshes(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const meshes = this.json['meshes'];
    if (!Array.isArray(meshes) || meshes.length < 1) {
      return [
        diag('asset_mesh_invalid', ptr('meshes'), 'the M2 profile requires at least one mesh', {
          found: Array.isArray(meshes) ? meshes.length : meshes === undefined ? 'absent' : typeof meshes,
          expected: 'meshes.length >= 1',
        }),
      ];
    }
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const path = ptr('meshes', i);
      if (!isPlainObject(mesh)) {
        out.push(diag('asset_mesh_invalid', path, 'mesh must be an object', { found: typeof mesh, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(mesh, path, out, 'mesh');
      const primitives = mesh['primitives'];
      if (!Array.isArray(primitives)) {
        out.push(
          diag('asset_mesh_invalid', `${path}/primitives`, 'mesh primitives must be an array', {
            found: primitives === undefined ? 'absent' : typeof primitives,
            expected: 'an array',
          }),
        );
        continue;
      }
      for (let j = 0; j < primitives.length; j++) {
        const primitive = primitives[j];
        const ppath = ptr('meshes', i, 'primitives', j);
        if (!isPlainObject(primitive)) {
          out.push(
            diag('asset_mesh_invalid', ppath, 'primitive must be an object', { found: typeof primitive, expected: 'an object' }),
          );
          continue;
        }
        const before = out.length;
        this.checkExtensionObject(primitive, ppath, out, 'primitive');
        if (out.length > before) continue;
        const dracoExt = isPlainObject(primitive['extensions']) ? primitive['extensions']['KHR_draco_mesh_compression'] : undefined;
        if (isPlainObject(dracoExt)) {
          const dpath = `${ppath}/extensions/KHR_draco_mesh_compression`;
          const dbv = asIndex(dracoExt['bufferView']);
          const view = dbv === null ? undefined : this.bufferViews[dbv];
          const dattrs = dracoExt['attributes'];
          const prim = isPlainObject(primitive['attributes']) ? primitive['attributes'] : {};
          if (view === undefined || view.compressed || view.buffer !== 0) {
            out.push(diag('asset_primitive_unsupported', `${dpath}/bufferView`, 'the Draco stream must be an existing uncompressed bufferView in the BIN chunk', { found: dracoExt['bufferView'], expected: `0 .. ${this.bufferViews.length - 1}` }));
            continue;
          }
          if (!isPlainObject(dattrs) || Object.entries(dattrs).some(([name, id]) => asIndex(id) === null || prim[name] === undefined)) {
            out.push(diag('asset_primitive_unsupported', `${dpath}/attributes`, 'Draco attributes must map primitive attributes to Draco attribute ids', { found: dattrs, expected: 'an object of primitive attribute names → integer ids' }));
            continue;
          }
        }
        const mode = primitive['mode'] ?? 4;
        if (mode !== 4) {
          out.push(
            diag('asset_primitive_unsupported', `${ppath}/mode`, 'only triangle primitives (mode 4) are in the M2 profile', {
              found: mode,
              expected: '4',
            }),
          );
          continue;
        }
        const attributes = primitive['attributes'];
        if (!isPlainObject(attributes) || Object.keys(attributes).length === 0) {
          out.push(
            diag('asset_mesh_invalid', `${ppath}/attributes`, 'primitive attributes must be a non-empty object', {
              found: attributes === undefined ? 'absent' : typeof attributes,
              expected: 'an object with POSITION',
            }),
          );
          continue;
        }
        const attributeMap = new Map<string, number>();
        let attributeError = false;
        for (const name of Object.keys(attributes)) {
          if (!ATTRIBUTE_ALLOWLIST.has(name)) {
            out.push(
              diag('asset_primitive_unsupported', `${ppath}/attributes/${escapePointer(name)}`, `attribute "${name}" is not in the M2 profile`, {
                found: name,
                expected: `one of [${[...ATTRIBUTE_ALLOWLIST].join(', ')}]`,
              }),
            );
            attributeError = true;
            continue;
          }
          const index = asIndex(attributes[name]);
          if (index === null || this.accessors[index] === undefined) {
            out.push(
              diag('asset_accessor_invalid', `${ppath}/attributes/${escapePointer(name)}`, 'primitive attribute must reference an existing accessor', {
                found: attributes[name],
                expected: `0 .. ${this.accessors.length - 1}`,
              }),
            );
            attributeError = true;
            continue;
          }
          attributeMap.set(name, index);
        }
        if (attributeError) continue;
        if (!attributeMap.has('POSITION')) {
          out.push(
            diag('asset_mesh_invalid', `${ppath}/attributes`, 'every primitive must carry POSITION', {
              found: Object.keys(attributes),
              expected: 'POSITION present',
            }),
          );
          continue;
        }
        let indices: number | null = null;
        if (primitive['indices'] !== undefined) {
          const index = asIndex(primitive['indices']);
          const info = index === null ? undefined : this.accessors[index];
          if (index === null || info === undefined) {
            out.push(
              diag('asset_accessor_invalid', `${ppath}/indices`, 'primitive indices must reference an existing accessor', {
                found: primitive['indices'],
                expected: `0 .. ${this.accessors.length - 1}`,
              }),
            );
            continue;
          }
          if (!UNSIGNED_COMPONENTS.has(info.componentType) || info.type !== 'SCALAR') {
            out.push(
              diag('asset_accessor_unsupported', `${ppath}/indices`, 'primitive indices must be an unsigned SCALAR accessor', {
                found: { componentType: info.componentType, type: info.type },
                expected: 'UNSIGNED_BYTE/UNSIGNED_SHORT/UNSIGNED_INT SCALAR',
              }),
            );
            continue;
          }
          indices = index;
        }
        const material = primitive['material'];
        let materialIndex: number | null = null;
        if (material !== undefined) {
          const index = asIndex(material);
          if (index === null) {
            out.push(
              diag('asset_material_invalid', `${ppath}/material`, 'primitive material must be a material index', {
                found: material,
                expected: 'a non-negative integer',
              }),
            );
            continue;
          }
          materialIndex = index;
        }
        this.primitives.push({ path: ppath, attributes: attributeMap, indices, material: materialIndex });
      }
    }
    return out.length > 0 ? out : null;
  }

  private checkMaterials(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const raw = this.json['materials'];
    if (raw !== undefined && !Array.isArray(raw)) {
      return [
        diag('asset_material_invalid', ptr('materials'), 'materials must be an array', {
          found: typeof raw,
          expected: 'an array',
        }),
      ];
    }
    const materials = Array.isArray(raw) ? raw : [];
    for (const primitive of this.primitives) {
      if (primitive.material !== null && materials[primitive.material] === undefined) {
        out.push(
          diag('asset_material_invalid', `${primitive.path}/material`, 'primitive material must reference an existing material', {
            found: primitive.material,
            expected: `0 .. ${materials.length - 1}`,
          }),
        );
      }
    }
    const textureCount = this.collection('textures').length;
    const textureRef = (owner: Record<string, unknown>, path: string, key: string): void => {
      if (owner[key] === undefined) return;
      const ref = owner[key];
      if (!isPlainObject(ref)) {
        out.push(diag('asset_material_invalid', path, `${key} must be a texture reference object`, { found: typeof ref, expected: 'an object with index' }));
        return;
      }
      const index = asIndex(ref['index']);
      if (index === null || index >= textureCount) {
        out.push(
          diag('asset_material_invalid', `${path}/${key}/index`, 'texture reference must resolve to an existing texture', {
            found: ref['index'],
            expected: `0 .. ${textureCount - 1}`,
          }),
        );
      }
      this.checkExtensionObject(ref, `${path}/${key}`, out, 'textureInfo');
      const transform = isPlainObject(ref['extensions']) ? ref['extensions']['KHR_texture_transform'] : undefined;
      if (isPlainObject(transform)) {
        const tpath = `${path}/${key}/extensions/KHR_texture_transform`;
        for (const [field, size] of [['offset', 2], ['scale', 2]] as const) {
          const v = transform[field];
          if (v !== undefined && (!Array.isArray(v) || v.length !== size || !v.every(isFiniteNumber))) {
            out.push(diag('asset_material_invalid', `${tpath}/${field}`, `${field} must be ${size} finite numbers`, { found: v, expected: `[number, number]` }));
          }
        }
        if (transform['rotation'] !== undefined && !isFiniteNumber(transform['rotation'])) {
          out.push(diag('asset_material_invalid', `${tpath}/rotation`, 'rotation must be a finite number', { found: transform['rotation'], expected: 'a finite number' }));
        }
      }
    };
    for (let i = 0; i < materials.length; i++) {
      const material = materials[i];
      const path = ptr('materials', i);
      if (!isPlainObject(material)) {
        out.push(diag('asset_material_invalid', path, 'material must be an object', { found: typeof material, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(material, path, out, 'material');
      // Textures referenced from material extensions (specular, clearcoat,
      // sheen, transmission, volume …) resolve like core texture references.
      const mext = material['extensions'];
      if (isPlainObject(mext)) {
        for (const [name, body] of Object.entries(mext)) {
          if (!isPlainObject(body)) continue;
          for (const key of Object.keys(body)) {
            if (key.endsWith('Texture')) textureRef(body, `${path}/extensions/${escapePointer(name)}`, key);
          }
        }
      }
      for (const key of Object.keys(material)) {
        if (!CORE_MATERIAL_FIELDS.has(key)) {
          out.push(
            diag('asset_material_invalid', `${path}/${escapePointer(key)}`, `material field "${key}" is not a core PBR field of the M2 profile`, {
              found: key,
              expected: `one of [${[...CORE_MATERIAL_FIELDS].join(', ')}]`,
            }),
          );
        }
      }
      const alphaMode = material['alphaMode'] ?? 'OPAQUE';
      if (alphaMode !== 'OPAQUE' && alphaMode !== 'MASK' && alphaMode !== 'BLEND') {
        out.push(
          diag('asset_material_invalid', `${path}/alphaMode`, 'alphaMode must be OPAQUE, MASK or BLEND', {
            found: alphaMode,
            expected: 'OPAQUE | MASK | BLEND',
          }),
        );
      }
      if (material['alphaCutoff'] !== undefined && !isFiniteNumber(material['alphaCutoff'])) {
        out.push(
          diag('asset_material_invalid', `${path}/alphaCutoff`, 'alphaCutoff must be a finite number', {
            found: material['alphaCutoff'],
            expected: 'a finite number',
          }),
        );
      }
      if (material['doubleSided'] !== undefined && typeof material['doubleSided'] !== 'boolean') {
        out.push(
          diag('asset_material_invalid', `${path}/doubleSided`, 'doubleSided must be a boolean', {
            found: material['doubleSided'],
            expected: 'a boolean',
          }),
        );
      }
      if (material['emissiveFactor'] !== undefined) {
        checkUnitVector(material['emissiveFactor'], 3, `${path}/emissiveFactor`, out);
      }
      const pbr = material['pbrMetallicRoughness'];
      if (pbr !== undefined) {
        if (!isPlainObject(pbr)) {
          out.push(
            diag('asset_material_invalid', `${path}/pbrMetallicRoughness`, 'pbrMetallicRoughness must be an object', {
              found: typeof pbr,
              expected: 'an object',
            }),
          );
        } else {
          const ppath = `${path}/pbrMetallicRoughness`;
          for (const key of Object.keys(pbr)) {
            if (!CORE_PBR_FIELDS.has(key)) {
              out.push(
                diag('asset_material_invalid', `${ppath}/${escapePointer(key)}`, `pbrMetallicRoughness field "${key}" is not in the M2 profile`, {
                  found: key,
                  expected: `one of [${[...CORE_PBR_FIELDS].join(', ')}]`,
                }),
              );
            }
          }
          if (pbr['baseColorFactor'] !== undefined) checkUnitVector(pbr['baseColorFactor'], 4, `${ppath}/baseColorFactor`, out);
          for (const key of ['metallicFactor', 'roughnessFactor']) {
            const value = pbr[key];
            if (value === undefined) continue;
            if (!isFiniteNumber(value) || value < 0 || value > 1) {
              out.push(
                diag('asset_material_invalid', `${ppath}/${key}`, `${key} must be a finite factor in [0, 1]`, {
                  found: value,
                  expected: '0 <= value <= 1',
                }),
              );
            }
          }
          textureRef(pbr, ppath, 'baseColorTexture');
          textureRef(pbr, ppath, 'metallicRoughnessTexture');
        }
      }
      textureRef(material, path, 'normalTexture');
      textureRef(material, path, 'occlusionTexture');
      textureRef(material, path, 'emissiveTexture');
    }
    return out.length > 0 ? out : null;
  }

  private checkImages(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const raw = this.json['images'];
    if (raw !== undefined && !Array.isArray(raw)) {
      return [
        diag('asset_image_invalid', ptr('images'), 'images must be an array', {
          found: typeof raw,
          expected: 'an array',
        }),
      ];
    }
    const images = Array.isArray(raw) ? raw : [];
    let decoded = 0;
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const path = ptr('images', i);
      if (!isPlainObject(image)) {
        out.push(diag('asset_image_invalid', path, 'image must be an object', { found: typeof image, expected: 'an object' }));
        continue;
      }
      if (image['uri'] !== undefined) {
        out.push(
          diag('asset_uri_rejected', `${path}/uri`, 'images must be embedded bufferViews; URIs (including data:) are never fetched', {
            found: image['uri'],
            expected: 'no uri member',
          }),
        );
        continue;
      }
      const bufferViewIndex = asIndex(image['bufferView']);
      const bv = bufferViewIndex === null ? undefined : this.bufferViews[bufferViewIndex];
      if (bufferViewIndex === null || bv === undefined) {
        out.push(
          diag('asset_image_invalid', `${path}/bufferView`, 'every image must reference an embedded bufferView', {
            found: image['bufferView'],
            expected: `0 .. ${this.bufferViews.length - 1}`,
          }),
        );
        continue;
      }
      const mime = image['mimeType'];
      if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp' && mime !== 'image/ktx2') {
        out.push(
          diag('asset_image_invalid', `${path}/mimeType`, 'image mimeType must be image/png, image/jpeg, image/webp or image/ktx2', {
            found: mime,
            expected: 'image/png | image/jpeg | image/webp | image/ktx2',
          }),
        );
        continue;
      }
      if (bv.byteLength > M2_GLTF_IMAGE_BYTES) {
        out.push(
          diag('asset_image_invalid', path, 'image exceeds the per-image byte cap', {
            found: bv.byteLength,
            expected: `<= ${M2_GLTF_IMAGE_BYTES}`,
            limit: 'image_bytes',
          }),
        );
        continue;
      }
      const data = bv.data;
      const actualMime = detectImageMime(data);
      if (actualMime === null) {
        out.push(
          diag('asset_image_invalid', path, 'image bytes are not PNG, JPEG, WebP or KTX2', {
            found: [...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
            expected: 'a PNG, JPEG, WebP or KTX2 signature',
          }),
        );
        continue;
      }
      if (actualMime !== mime) {
        out.push(
          diag('asset_image_mime_mismatch', `${path}/mimeType`, 'the declared mimeType does not match the image magic bytes', {
            found: { declared: mime, actual: actualMime },
            expected: mime,
          }),
        );
        continue;
      }
      const dims = imageDimensions(data, actualMime as ImportImageMime);
      if (dims === null) {
        out.push(
          diag('asset_image_invalid', path, 'the image header is unreadable, so decoded bytes cannot be bounded', {
            found: 'unreadable header',
            expected: 'a readable PNG IHDR, JPEG frame header, WebP VP8/VP8L/VP8X header or a 2D Basis Universal KTX2 header',
          }),
        );
        continue;
      }
      this.imageMimes[i] = actualMime;
      decoded += decodedImageBytes(dims);
    }
    if (out.length > 0) return out;
    this.imageDecodedBytes = decoded;
    return null;
  }

  private checkTextures(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const samplersRaw = this.json['samplers'];
    if (samplersRaw !== undefined && !Array.isArray(samplersRaw)) {
      return [
        diag('asset_texture_invalid', ptr('samplers'), 'samplers must be an array', {
          found: typeof samplersRaw,
          expected: 'an array',
        }),
      ];
    }
    const samplers = Array.isArray(samplersRaw) ? samplersRaw : [];
    for (let i = 0; i < samplers.length; i++) {
      const sampler = samplers[i];
      const path = ptr('samplers', i);
      if (!isPlainObject(sampler)) {
        out.push(diag('asset_texture_invalid', path, 'sampler must be an object', { found: typeof sampler, expected: 'an object' }));
        continue;
      }
      for (const key of ['wrapS', 'wrapT'] as const) {
        const value = sampler[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !SAMPLER_WRAPS.has(value)) {
          out.push(
            diag('asset_texture_invalid', `${path}/${key}`, `${key} must be a glTF wrap enum`, {
              found: value,
              expected: '33071 (CLAMP) | 33648 (MIRRORED_REPEAT) | 10497 (REPEAT)',
            }),
          );
        }
      }
      for (const key of ['magFilter', 'minFilter'] as const) {
        const value = sampler[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !SAMPLER_FILTERS.has(value)) {
          out.push(
            diag('asset_texture_invalid', `${path}/${key}`, `${key} must be a glTF filter enum`, {
              found: value,
              expected: '9728 | 9729 | 9984 | 9985 | 9986 | 9987',
            }),
          );
        }
      }
    }
    const texturesRaw = this.json['textures'];
    if (texturesRaw !== undefined && !Array.isArray(texturesRaw)) {
      out.push(
        diag('asset_texture_invalid', ptr('textures'), 'textures must be an array', {
          found: typeof texturesRaw,
          expected: 'an array',
        }),
      );
      return out;
    }
    const textures = Array.isArray(texturesRaw) ? texturesRaw : [];
    const imageCount = this.collection('images').length;
    for (let i = 0; i < textures.length; i++) {
      const texture = textures[i];
      const path = ptr('textures', i);
      if (!isPlainObject(texture)) {
        out.push(diag('asset_texture_invalid', path, 'texture must be an object', { found: typeof texture, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(texture, path, out, 'texture');
      // A texture's image comes from `source` (PNG/JPEG) and/or from an
      // extension naming a source in its own container (EXT_texture_webp).
      const ext = isPlainObject(texture['extensions']) ? texture['extensions'] : {};
      const sources: { key: string; value: unknown; mimes: ReadonlySet<string> }[] = [];
      if (texture['source'] !== undefined) sources.push({ key: 'source', value: texture['source'], mimes: CORE_TEXTURE_MIMES });
      if (isPlainObject(ext['EXT_texture_webp'])) {
        sources.push({ key: 'extensions/EXT_texture_webp/source', value: ext['EXT_texture_webp']['source'], mimes: new Set(['image/webp']) });
      }
      if (isPlainObject(ext['KHR_texture_basisu'])) {
        sources.push({ key: 'extensions/KHR_texture_basisu/source', value: ext['KHR_texture_basisu']['source'], mimes: new Set(['image/ktx2']) });
      }
      if (sources.length === 0) {
        out.push(
          diag('asset_texture_invalid', `${path}/source`, 'texture source must resolve to an existing image', {
            found: texture['source'],
            expected: `0 .. ${imageCount - 1}`,
          }),
        );
      }
      for (const src of sources) {
        const source = asIndex(src.value);
        if (source === null || source >= imageCount) {
          out.push(
            diag('asset_texture_invalid', `${path}/${src.key}`, 'texture source must resolve to an existing image', {
              found: src.value,
              expected: `0 .. ${imageCount - 1}`,
            }),
          );
          continue;
        }
        const mime = this.imageMimes[source];
        if (mime !== undefined && mime !== null && !src.mimes.has(mime)) {
          out.push(
            diag('asset_texture_invalid', `${path}/${src.key}`, `a ${mime} image cannot be used from texture ${src.key}`, {
              found: mime,
              expected: [...src.mimes].join(' | '),
            }),
          );
        }
      }
      if (texture['sampler'] !== undefined) {
        const sampler = asIndex(texture['sampler']);
        if (sampler === null || samplers[sampler] === undefined) {
          out.push(
            diag('asset_texture_invalid', `${path}/sampler`, 'texture sampler must resolve to an existing sampler', {
              found: texture['sampler'],
              expected: `0 .. ${samplers.length - 1}`,
            }),
          );
        }
      }
    }
    return out.length > 0 ? out : null;
  }

  private checkAnimations(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const raw = this.json['animations'];
    if (raw !== undefined && !Array.isArray(raw)) {
      return [
        diag('asset_animation_invalid', ptr('animations'), 'animations must be an array', {
          found: typeof raw,
          expected: 'an array',
        }),
      ];
    }
    const animations = Array.isArray(raw) ? raw : [];
    const nodeCount = this.collection('nodes').length;
    let longestMs = 0;
    for (let i = 0; i < animations.length; i++) {
      const animation = animations[i];
      const path = ptr('animations', i);
      if (!isPlainObject(animation)) {
        out.push(
          diag('asset_animation_invalid', path, 'animation must be an object', { found: typeof animation, expected: 'an object' }),
        );
        continue;
      }
      this.checkExtensionObject(animation, path, out, 'animation');
      const samplersRaw = animation['samplers'];
      const channelsRaw = animation['channels'];
      if (!Array.isArray(samplersRaw) || !Array.isArray(channelsRaw)) {
        out.push(
          diag('asset_animation_invalid', path, 'animation must carry samplers and channels arrays', {
            found: { samplers: typeof samplersRaw, channels: typeof channelsRaw },
            expected: 'samplers[] and channels[]',
          }),
        );
        continue;
      }
      // Samplers: resolve accessors, read the input times, check strict order.
      const samplerInputs: { min: number; max: number }[] = [];
      let samplerError = false;
      for (let s = 0; s < samplersRaw.length; s++) {
        const sampler = samplersRaw[s];
        const spath = `${path}/samplers/${s}`;
        if (!isPlainObject(sampler)) {
          out.push(
            diag('asset_animation_invalid', spath, 'animation sampler must be an object', { found: typeof sampler, expected: 'an object' }),
          );
          samplerError = true;
          continue;
        }
        const interpolation = sampler['interpolation'] ?? 'LINEAR';
        if (typeof interpolation !== 'string' || !INTERPOLATIONS.has(interpolation)) {
          out.push(
            diag('asset_animation_invalid', `${spath}/interpolation`, 'interpolation must be LINEAR, STEP or CUBICSPLINE', {
              found: interpolation,
              expected: 'LINEAR | STEP | CUBICSPLINE',
            }),
          );
          samplerError = true;
        }
        const inputIndex = asIndex(sampler['input']);
        const outputIndex = asIndex(sampler['output']);
        const input = inputIndex === null ? undefined : this.accessors[inputIndex];
        const output = outputIndex === null ? undefined : this.accessors[outputIndex];
        if (input === undefined || input.type !== 'SCALAR' || input.componentType !== 5126) {
          out.push(
            diag('asset_animation_invalid', `${spath}/input`, 'animation input must be a SCALAR FLOAT accessor', {
              found: input === undefined ? sampler['input'] : { type: input.type, componentType: input.componentType },
              expected: 'SCALAR FLOAT (5126)',
            }),
          );
          samplerError = true;
          continue;
        }
        if (output === undefined) {
          out.push(
            diag('asset_animation_invalid', `${spath}/output`, 'animation output must reference an existing accessor', {
              found: sampler['output'],
              expected: `0 .. ${this.accessors.length - 1}`,
            }),
          );
          samplerError = true;
          continue;
        }
        const times = this.readFloats(inputIndex as number);
        let previous = -Infinity;
        let min = Infinity;
        let max = -Infinity;
        let orderError = false;
        for (const t of times) {
          if (!Number.isFinite(t) || t <= previous) {
            orderError = true;
            break;
          }
          previous = t;
          if (t < min) min = t;
          if (t > max) max = t;
        }
        if (orderError || times.length === 0) {
          out.push(
            diag('asset_animation_invalid', `${spath}/input`, 'animation input times must be finite and strictly increasing', {
              found: times.length === 0 ? 'empty' : 'not strictly increasing',
              expected: 'strictly increasing finite floats',
            }),
          );
          samplerError = true;
          continue;
        }
        samplerInputs.push({ min, max });
      }
      if (samplerError) continue;

      let channelError = false;
      for (let c = 0; c < channelsRaw.length; c++) {
        const channel = channelsRaw[c];
        const cpath = `${path}/channels/${c}`;
        if (!isPlainObject(channel)) {
          out.push(
            diag('asset_animation_invalid', cpath, 'animation channel must be an object', { found: typeof channel, expected: 'an object' }),
          );
          channelError = true;
          continue;
        }
        const samplerIndex = asIndex(channel['sampler']);
        const target = channel['target'];
        if (samplerIndex === null || samplerIndex >= samplersRaw.length) {
          out.push(
            diag('asset_animation_invalid', `${cpath}/sampler`, 'channel sampler must resolve to an existing sampler', {
              found: channel['sampler'],
              expected: `0 .. ${samplersRaw.length - 1}`,
            }),
          );
          channelError = true;
          continue;
        }
        if (!isPlainObject(target)) {
          out.push(
            diag('asset_animation_invalid', `${cpath}/target`, 'channel target must be an object', { found: typeof target, expected: 'an object' }),
          );
          channelError = true;
          continue;
        }
        const targetExt = target['extensions'];
        if (targetExt !== undefined) {
          const names = isPlainObject(targetExt) ? Object.keys(targetExt) : [];
          out.push(
            diag(
              names.includes('KHR_animation_pointer') ? 'asset_animation_invalid' : 'asset_extension_unsupported',
              `${cpath}/target/extensions`,
              names.includes('KHR_animation_pointer')
                ? 'KHR_animation_pointer is not in the M2 profile'
                : 'channel target extensions are not in the M2 profile',
              { found: names, expected: 'no target extensions' },
            ),
          );
          channelError = true;
          continue;
        }
        const nodeIndex = asIndex(target['node']);
        if (nodeIndex === null || nodeIndex >= nodeCount) {
          out.push(
            diag('asset_animation_invalid', `${cpath}/target/node`, 'channel target node must exist', {
              found: target['node'],
              expected: `0 .. ${nodeCount - 1}`,
            }),
          );
          channelError = true;
          continue;
        }
        const targetPath = target['path'];
        if (typeof targetPath !== 'string' || !ANIMATION_PATHS.has(targetPath)) {
          out.push(
            diag('asset_animation_invalid', `${cpath}/target/path`, 'channel target path must be translation, rotation, scale or weights', {
              found: targetPath,
              expected: 'translation | rotation | scale | weights',
            }),
          );
          channelError = true;
          continue;
        }
        const sampler = samplersRaw[samplerIndex];
        if (!isPlainObject(sampler)) {
          channelError = true;
          continue;
        }
        const outputIndex = asIndex(sampler['output']);
        const output = outputIndex === null ? undefined : this.accessors[outputIndex];
        const expectedType = ANIMATION_OUTPUT_TYPES[targetPath] as string;
        if (output === undefined || output.type !== expectedType) {
          out.push(
            diag('asset_animation_invalid', `${path}/samplers/${samplerIndex}/output`, 'animation output type must match the channel path', {
              found: output === undefined ? sampler['output'] : output.type,
              expected: expectedType,
            }),
          );
          channelError = true;
        }
      }
      if (channelError) continue;

      if (samplerInputs.length > 0) {
        let min = Infinity;
        let max = -Infinity;
        for (const s of samplerInputs) {
          if (s.min < min) min = s.min;
          if (s.max > max) max = s.max;
        }
        const ms = Math.round((max - min) * 1000);
        if (ms > longestMs) longestMs = ms;
      }
    }
    if (out.length > 0) return out;
    this.clipDurationMs = longestMs;
    return null;
  }

  /**
   * presentation.md §41.3.2 stages 3–6 and §41.3.3 A1–A6, in the contract
   * order, against this proposal's real clip list. Only reached when the
   * caller requested the animated profile (`options.animation`).
   */
  private checkAnimationProfile(metrics: AssetMetrics): ImportDiagnostic[] | null {
    const request = this.animation;
    if (request === null) return null;
    const roles = request.roles;
    const clips = metrics.animations;
    const names = this.clipNames();

    // stage 3 — range (pure: decidable from the version's clip count).
    for (const role of ANIMATION_ROLE_KEYS) {
      const binding = roles[role];
      if (binding.clipIndex >= clips) {
        return [
          diag('animation_role_out_of_range', `/roles/${role}/clipIndex`, `role "${role}" clipIndex must be below the version's clip count`, {
            found: binding.clipIndex,
            expected: `0 .. ${clips - 1}`,
            role,
            clipIndex: binding.clipIndex,
            clips,
          }),
        ];
      }
    }

    // stage 4 — duplicates (pure).
    const seen = new Map<number, string>();
    for (const role of ANIMATION_ROLE_KEYS) {
      const index = roles[role].clipIndex;
      const previous = seen.get(index);
      if (previous !== undefined) {
        return [
          diag('animation_role_duplicate', '/roles', 'two roles must not share a clipIndex', {
            found: index,
            expected: 'three distinct clip indices',
            clipIndex: index,
            roles: [previous, role],
          }),
        ];
      }
      seen.set(index, role);
    }

    // stage 5 — name agreement against the real clip list.
    for (const role of ANIMATION_ROLE_KEYS) {
      const binding = roles[role];
      const real = names[binding.clipIndex] as string;
      if (real !== binding.clipName) {
        return [
          diag('animation_role_mismatch', `/roles/${role}/clipName`, `role "${role}" clipName must equal the clip's real name`, {
            found: binding.clipName,
            expected: real,
            role,
          }),
        ];
      }
    }

    // stage 6 — ambiguity.
    for (const role of ANIMATION_ROLE_KEYS) {
      const binding = roles[role];
      let matches = 0;
      for (const name of names) if (name === binding.clipName) matches += 1;
      if (matches > 1) {
        return [
          diag('animation_role_ambiguous', `/roles/${role}/clipName`, 'the clip list must contain exactly one clip with this name', {
            found: binding.clipName,
            expected: 'exactly one clip with this name',
            role,
            matches,
          }),
        ];
      }
    }

    return this.checkAnimatedGlbProfile(roles);
  }

  /** presentation.md §41.3.3 A1–A6, in the stated order (fail-fast per check). */
  private checkAnimatedGlbProfile(
    roles: ResolvedAnimation['roles'],
  ): ImportDiagnostic[] | null {
    const animations = this.collection('animations');

    // A1 — clip count.
    if (animations.length < 1 || animations.length > ANIMATION_PROFILE_MAX_CLIPS) {
      return [
        diag('asset_limits_exceeded', ptr('animations'), `the animated profile allows 1-${ANIMATION_PROFILE_MAX_CLIPS} clips`, {
          found: animations.length,
          expected: `1 .. ${ANIMATION_PROFILE_MAX_CLIPS}`,
          limit: 'animation_clips',
        }),
      ];
    }

    // A2 — no skeletal animation (no `skins`, no JOINTS_0/WEIGHTS_0).
    const skins = this.collection('skins').length;
    if (skins > 0) {
      return [
        diag('animation_skin_unsupported', ptr('skins'), 'the animated profile has no skeletal animation', {
          found: skins,
          expected: 'no skins array',
        }),
      ];
    }
    const jointAttribute = this.findJointAttributePath();
    if (jointAttribute !== null) {
      return [
        diag('animation_skin_unsupported', jointAttribute, 'the animated profile has no JOINTS_0/WEIGHTS_0 attributes', {
          found: jointAttribute.slice(jointAttribute.lastIndexOf('/') + 1),
          expected: 'no skinning attributes',
        }),
      ];
    }

    // A3 — channels total and per clip.
    let totalChannels = 0;
    let maxChannelsPerClip = 0;
    let totalKeyframes = 0;
    for (const animation of animations) {
      if (!isPlainObject(animation)) continue;
      const channels = Array.isArray(animation['channels']) ? animation['channels'] : [];
      totalChannels += channels.length;
      if (channels.length > maxChannelsPerClip) maxChannelsPerClip = channels.length;
      // A4 — summed sampler `input` keyframe count over all clips.
      const samplers = Array.isArray(animation['samplers']) ? animation['samplers'] : [];
      for (const sampler of samplers) {
        if (!isPlainObject(sampler)) continue;
        const inputIndex = asIndex(sampler['input']);
        const input = inputIndex === null ? undefined : this.accessors[inputIndex];
        if (input !== undefined) totalKeyframes += input.count;
      }
    }
    if (
      totalChannels > ANIMATION_PROFILE_MAX_TRACKS ||
      maxChannelsPerClip > ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP
    ) {
      return [
        diag('asset_limits_exceeded', ptr('animations'), 'animation channels exceed the animated profile', {
          found: { channels: totalChannels, maxChannelsPerClip },
          expected: `<= ${ANIMATION_PROFILE_MAX_TRACKS} total, <= ${ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP} per clip`,
          limit: 'animation_tracks',
        }),
      ];
    }

    // A4 — keyframes.
    if (totalKeyframes > ANIMATION_PROFILE_MAX_TRACK_TIMES) {
      return [
        diag('asset_limits_exceeded', ptr('animations'), 'sampler input keyframes exceed the animated profile', {
          found: totalKeyframes,
          expected: `<= ${ANIMATION_PROFILE_MAX_TRACK_TIMES}`,
          limit: 'animation_track_times',
        }),
      ];
    }

    // A5 — longest clip duration (`metrics.clipDurationMs` covers it).
    if (this.clipDurationMs > ANIMATION_PROFILE_MAX_CLIP_MS) {
      return [
        diag('asset_limits_exceeded', ptr('animations'), 'clip duration exceeds the animated profile', {
          found: this.clipDurationMs,
          expected: `<= ${ANIMATION_PROFILE_MAX_CLIP_MS}`,
          limit: 'animation_clip_duration',
        }),
      ];
    }

    // A6 — no translation channel on a scene root node.
    return this.checkRootMotion(roles);
  }

  private clipNames(): string[] {
    return this.collection('animations').map((animation) =>
      isPlainObject(animation) && typeof animation['name'] === 'string' ? animation['name'] : '',
    );
  }

  /** The default scene's root node indices (the holder's own nodes, A6). */
  private rootNodeIndices(): Set<number> {
    const scenes = this.collection('scenes');
    const index = asIndex(this.json['scene']);
    const scene = index !== null && index < scenes.length ? scenes[index] : scenes[0];
    const out = new Set<number>();
    if (isPlainObject(scene) && Array.isArray(scene['nodes'])) {
      for (const value of scene['nodes']) {
        const node = asIndex(value);
        if (node !== null) out.add(node);
      }
    }
    return out;
  }

  /** The first `JOINTS_0`/`WEIGHTS_0` attribute path, or `null`. */
  private findJointAttributePath(): string | null {
    const meshes = this.collection('meshes');
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (!isPlainObject(mesh) || !Array.isArray(mesh['primitives'])) continue;
      const primitives = mesh['primitives'];
      for (let j = 0; j < primitives.length; j++) {
        const primitive = primitives[j];
        if (!isPlainObject(primitive)) continue;
        const attributes = primitive['attributes'];
        if (!isPlainObject(attributes)) continue;
        for (const name of ['JOINTS_0', 'WEIGHTS_0']) {
          if (Object.prototype.hasOwnProperty.call(attributes, name)) {
            return `${ptr('meshes', i, 'primitives', j, 'attributes')}/${name}`;
          }
        }
      }
    }
    return null;
  }

  /** A6: every offending root-translation channel, in clip/channel order. */
  private checkRootMotion(roles: ResolvedAnimation['roles']): ImportDiagnostic[] | null {
    const rootNodes = this.rootNodeIndices();
    if (rootNodes.size === 0) return null;
    const animations = this.collection('animations');
    const nodes = this.collection('nodes');
    const out: ImportDiagnostic[] = [];
    for (let i = 0; i < animations.length; i++) {
      const animation = animations[i];
      if (!isPlainObject(animation) || !Array.isArray(animation['channels'])) continue;
      const channels = animation['channels'];
      for (let c = 0; c < channels.length; c++) {
        const channel = channels[c];
        if (!isPlainObject(channel)) continue;
        const target = channel['target'];
        if (!isPlainObject(target) || target['path'] !== 'translation') continue;
        const nodeIndex = asIndex(target['node']);
        if (nodeIndex === null || !rootNodes.has(nodeIndex)) continue;
        const node = nodes[nodeIndex];
        const nodeName = isPlainObject(node) && typeof node['name'] === 'string' ? node['name'] : '';
        const role = ANIMATION_ROLE_KEYS.find((key) => roles[key].clipIndex === i);
        out.push(
          diag(
            'animation_root_motion',
            `${ptr('animations', i, 'channels', c, 'target')}/path`,
            'a channel must not animate a scene root node translation (root motion)',
            {
              found: nodeIndex,
              expected: 'no translation channel on a scene root node',
              ...(role === undefined ? {} : { role }),
              nodeIndex,
              nodeName,
            },
          ),
        );
      }
    }
    return out.length > 0 ? out : null;
  }

  /** Read an accessor's little-endian float32 values from the embedded BIN chunk. */
  private readFloats(index: number): number[] {
    const info = this.accessors[index];
    const accessor = this.collection('accessors')[index];
    if (info === undefined || !isPlainObject(accessor)) return [];
    const bufferViewIndex = asIndex(accessor['bufferView']);
    const bv = bufferViewIndex === null ? undefined : this.bufferViews[bufferViewIndex];
    if (bv === undefined) return [];
    const byteOffset = typeof accessor['byteOffset'] === 'number' ? accessor['byteOffset'] : 0;
    const view = new DataView(bv.data.buffer, bv.data.byteOffset, bv.data.byteLength);
    const out: number[] = [];
    for (let i = 0; i < info.count; i++) out.push(view.getFloat32(byteOffset + i * 4, true));
    return out;
  }

  /** Phase 9.7: ≤ MODEL_MAX_SKINS skins, ≤ MODEL_MAX_SKIN_JOINTS joints each, ≤ MODEL_MAX_MORPH_TARGETS morph targets per primitive. */
  private checkRigCaps(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const skins = this.collection('skins');
    if (skins.length > MODEL_MAX_SKINS) {
      out.push(diag('asset_limits_exceeded', ptr('skins'), `a model has at most ${MODEL_MAX_SKINS} skins`, { found: skins.length, expected: `<= ${MODEL_MAX_SKINS}`, limit: 'skins' }));
    }
    skins.forEach((skin, i) => {
      const joints = isPlainObject(skin) && Array.isArray(skin['joints']) ? skin['joints'].length : 0;
      if (joints > MODEL_MAX_SKIN_JOINTS) {
        out.push(diag('asset_limits_exceeded', ptr('skins', i, 'joints'), `a skin has at most ${MODEL_MAX_SKIN_JOINTS} joints`, { found: joints, expected: `<= ${MODEL_MAX_SKIN_JOINTS}`, limit: 'skin_joints' }));
      }
    });
    this.collection('meshes').forEach((mesh, m) => {
      const primitives = isPlainObject(mesh) && Array.isArray(mesh['primitives']) ? mesh['primitives'] : [];
      primitives.forEach((prim, p) => {
        const targets = isPlainObject(prim) && Array.isArray(prim['targets']) ? prim['targets'].length : 0;
        if (targets > MODEL_MAX_MORPH_TARGETS) {
          out.push(diag('asset_limits_exceeded', ptr('meshes', m, 'primitives', p, 'targets'), `a primitive has at most ${MODEL_MAX_MORPH_TARGETS} morph targets`, { found: targets, expected: `<= ${MODEL_MAX_MORPH_TARGETS}`, limit: 'morph_targets' }));
        }
      });
    });
    return out.length > 0 ? out.slice(0, M2_GLTF_MAX_DIAGNOSTICS) : null;
  }

  private checkNodesAndScenes(): ImportDiagnostic[] | null {
    const out: ImportDiagnostic[] = [];
    const rawNodes = this.json['nodes'];
    if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
      return [
        diag('asset_node_invalid', ptr('nodes'), 'nodes must be an array', {
          found: typeof rawNodes,
          expected: 'an array',
        }),
      ];
    }
    const nodes = Array.isArray(rawNodes) ? rawNodes : [];
    const childrenOf: number[][] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const path = ptr('nodes', i);
      childrenOf.push([]);
      if (!isPlainObject(node)) {
        out.push(diag('asset_node_invalid', path, 'node must be an object', { found: typeof node, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(node, path, out, 'node');
      const hasMatrix = node['matrix'] !== undefined;
      const hasTrs =
        node['translation'] !== undefined || node['rotation'] !== undefined || node['scale'] !== undefined;
      if (hasMatrix && hasTrs) {
        out.push(
          diag('asset_node_invalid', path, 'a node must carry either matrix or TRS, never both', {
            found: 'matrix and TRS',
            expected: 'one transform representation',
          }),
        );
      }
      if (hasMatrix) {
        const matrix = node['matrix'];
        if (
          !Array.isArray(matrix) ||
          matrix.length !== 16 ||
          matrix.some((v) => !isFiniteNumber(v))
        ) {
          out.push(
            diag('asset_node_invalid', `${path}/matrix`, 'node matrix must be 16 finite numbers', {
              found: Array.isArray(matrix) ? matrix.length : typeof matrix,
              expected: '16 finite numbers',
            }),
          );
        }
      }
      for (const key of ['translation', 'rotation', 'scale'] as const) {
        if (node[key] === undefined) continue;
        const expectedLength = key === 'rotation' ? 4 : 3;
        const value = node[key];
        if (
          !Array.isArray(value) ||
          value.length !== expectedLength ||
          value.some((v) => !isFiniteNumber(v))
        ) {
          out.push(
            diag('asset_node_invalid', `${path}/${key}`, `node ${key} must be ${expectedLength} finite numbers`, {
              found: Array.isArray(value) ? value.length : typeof value,
              expected: `${expectedLength} finite numbers`,
            }),
          );
        }
      }
      if (node['mesh'] !== undefined) {
        const meshIndex = asIndex(node['mesh']);
        if (meshIndex === null || meshIndex >= this.collection('meshes').length) {
          out.push(
            diag('asset_node_invalid', `${path}/mesh`, 'node mesh must resolve to an existing mesh', {
              found: node['mesh'],
              expected: `0 .. ${this.collection('meshes').length - 1}`,
            }),
          );
        }
      }
      const children = node['children'];
      if (children !== undefined) {
        if (!Array.isArray(children)) {
          out.push(
            diag('asset_node_invalid', `${path}/children`, 'node children must be an array', {
              found: typeof children,
              expected: 'an array of node indices',
            }),
          );
          continue;
        }
        for (let c = 0; c < children.length; c++) {
          const child = asIndex(children[c]);
          if (child === null || child >= nodes.length) {
            out.push(
              diag('asset_node_invalid', `${path}/children/${c}`, 'node child must resolve to an existing node', {
                found: children[c],
                expected: `0 .. ${nodes.length - 1}`,
              }),
            );
            continue;
          }
          if (child === i) {
            out.push(
              diag('asset_node_invalid', `${path}/children/${c}`, 'a node must not be its own child', {
                found: child,
                expected: 'a different node index',
              }),
            );
            continue;
          }
          (childrenOf[i] as number[]).push(child);
        }
      }
    }
    // Cycle detection over the child graph (iterative DFS with colours).
    const colour = new Uint8Array(nodes.length);
    for (let start = 0; start < nodes.length; start++) {
      if (colour[start] !== 0) continue;
      const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
      colour[start] = 1;
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as { node: number; next: number };
        const children = childrenOf[top.node] as number[];
        if (top.next >= children.length) {
          colour[top.node] = 2;
          stack.pop();
          continue;
        }
        const child = children[top.next] as number;
        top.next += 1;
        if (colour[child] === 1) {
          out.push(
            diag('asset_node_invalid', ptr('nodes', child), 'node hierarchy must not contain a cycle', {
              found: `nodes[${top.node}] -> nodes[${child}]`,
              expected: 'an acyclic hierarchy',
            }),
          );
          continue;
        }
        if (colour[child] === 0) {
          colour[child] = 1;
          stack.push({ node: child, next: 0 });
        }
      }
    }

    const rawScenes = this.json['scenes'];
    if (rawScenes !== undefined && !Array.isArray(rawScenes)) {
      out.push(
        diag('asset_scene_invalid', ptr('scenes'), 'scenes must be an array', {
          found: typeof rawScenes,
          expected: 'an array',
        }),
      );
      return out;
    }
    const scenes = Array.isArray(rawScenes) ? rawScenes : [];
    if (scenes.length < 1) {
      out.push(
        diag('asset_scene_invalid', ptr('scenes'), 'the M2 profile requires at least one scene', {
          found: scenes.length,
          expected: 'scenes.length >= 1',
        }),
      );
    }
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const path = ptr('scenes', i);
      if (!isPlainObject(scene)) {
        out.push(diag('asset_scene_invalid', path, 'scene must be an object', { found: typeof scene, expected: 'an object' }));
        continue;
      }
      this.checkExtensionObject(scene, path, out, 'scene');
      const nodesList = scene['nodes'];
      if (nodesList !== undefined) {
        if (!Array.isArray(nodesList)) {
          out.push(
            diag('asset_scene_invalid', `${path}/nodes`, 'scene nodes must be an array', {
              found: typeof nodesList,
              expected: 'an array of node indices',
            }),
          );
          continue;
        }
        for (let n = 0; n < nodesList.length; n++) {
          const index = asIndex(nodesList[n]);
          if (index === null || index >= nodes.length) {
            out.push(
              diag('asset_scene_invalid', `${path}/nodes/${n}`, 'scene node must resolve to an existing node', {
                found: nodesList[n],
                expected: `0 .. ${nodes.length - 1}`,
              }),
            );
          }
        }
      }
    }
    const sceneIndex = this.json['scene'];
    if (sceneIndex !== undefined) {
      const index = asIndex(sceneIndex);
      if (index === null || index >= scenes.length) {
        out.push(
          diag('asset_scene_invalid', ptr('scene'), 'scene must be a valid scene index', {
            found: sceneIndex,
            expected: `0 .. ${scenes.length - 1}`,
          }),
        );
      }
    }
    return out.length > 0 ? out : null;
  }

  private computeMetrics(): AssetMetrics {
    let primitives = 0;
    let vertices = 0;
    let triangles = 0;
    let decodedGeometry = 0;
    for (const primitive of this.primitives) {
      primitives += 1;
      let positionCount = 0;
      for (const [, accessorIndex] of primitive.attributes) {
        const info = this.accessors[accessorIndex] as AccessorInfo;
        decodedGeometry += info.byteLength;
      }
      const positionIndex = primitive.attributes.get('POSITION');
      if (positionIndex !== undefined) positionCount = (this.accessors[positionIndex] as AccessorInfo).count;
      vertices += positionCount;
      if (primitive.indices !== null) {
        const indices = this.accessors[primitive.indices] as AccessorInfo;
        decodedGeometry += indices.byteLength;
        triangles += Math.floor(indices.count / 3);
      } else {
        triangles += Math.floor(positionCount / 3);
      }
    }
    let animationChannels = 0;
    for (const animation of this.collection('animations')) {
      if (isPlainObject(animation) && Array.isArray(animation['channels'])) {
        animationChannels += animation['channels'].length;
      }
    }
    return {
      nodes: this.collection('nodes').length,
      meshes: this.collection('meshes').length,
      primitives,
      materials: this.collection('materials').length,
      images: this.collection('images').length,
      textures: this.collection('textures').length,
      vertices,
      triangles,
      animations: this.collection('animations').length,
      animationChannels,
      clipDurationMs: this.clipDurationMs,
      decodedGeometryBytes: decodedGeometry,
      decodedImageBytes: this.imageDecodedBytes,
    };
  }
}

function checkUnitVector(
  value: unknown,
  length: number,
  path: string,
  out: ImportDiagnostic[],
): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((v) => !isFiniteNumber(v) || v < 0 || v > 1)
  ) {
    out.push(
      diag('asset_material_invalid', path, `factor must be ${length} finite numbers in [0, 1]`, {
        found: value,
        expected: `${length} values in [0, 1]`,
      }),
    );
  }
}

/** BufferView indices referenced by any accessor (for the alignment rule). */
function accessorBufferViewReferences(
  json: Record<string, unknown>,
  bufferViewCount: number,
): Set<number> {
  const out = new Set<number>();
  const accessors = json['accessors'];
  if (!Array.isArray(accessors)) return out;
  for (const accessor of accessors) {
    if (!isPlainObject(accessor)) continue;
    const index = asIndex(accessor['bufferView']);
    if (index !== null && index < bufferViewCount) out.add(index);
  }
  return out;
}

/** §18.6/§18.7.2 step 15: compare metrics with every cap, in table order. */
function checkMetricCaps(metrics: AssetMetrics, imageDecodedBytes: number): ImportDiagnostic[] {
  const out: ImportDiagnostic[] = [];
  const cap = (name: ImportLimitName, value: number, limit: number, message: string): void => {
    if (value > limit) {
      out.push(
        diag('asset_limits_exceeded', '', message, {
          found: value,
          expected: `<= ${limit}`,
          limit: name,
        }),
      );
    }
  };
  cap('nodes', metrics.nodes, M2_GLTF_PROFILE_LIMITS['nodes'] as number, 'node count exceeds the M2 cap');
  cap('meshes', metrics.meshes, M2_GLTF_PROFILE_LIMITS['meshes'] as number, 'mesh count exceeds the M2 cap');
  cap('primitives', metrics.primitives, M2_GLTF_PROFILE_LIMITS['primitives'] as number, 'primitive count exceeds the M2 cap');
  cap('materials', metrics.materials, M2_GLTF_PROFILE_LIMITS['materials'] as number, 'material count exceeds the M2 cap');
  cap('images', metrics.images, M2_GLTF_PROFILE_LIMITS['images'] as number, 'image count exceeds the M2 cap');
  cap('textures', metrics.textures, M2_GLTF_PROFILE_LIMITS['textures'] as number, 'texture count exceeds the M2 cap');
  cap('vertices', metrics.vertices, M2_GLTF_PROFILE_LIMITS['vertices'] as number, 'vertex count exceeds the M2 cap');
  cap('triangles', metrics.triangles, M2_GLTF_PROFILE_LIMITS['triangles'] as number, 'triangle count exceeds the M2 cap');
  cap('animations', metrics.animations, M2_GLTF_PROFILE_LIMITS['animations'] as number, 'animation count exceeds the M2 cap');
  cap(
    'animation_channels',
    metrics.animationChannels,
    M2_GLTF_PROFILE_LIMITS['animation_channels'] as number,
    'animation channel count exceeds the M2 cap',
  );
  cap('clip_duration', metrics.clipDurationMs, M2_GLTF_PROFILE_LIMITS['clip_duration'] as number, 'clip duration exceeds the M2 cap');
  cap(
    'decoded_bytes',
    metrics.decodedGeometryBytes,
    M2_GLTF_DECODED_GEOMETRY_BYTES,
    'decoded geometry bytes exceed the M2 cap',
  );
  cap(
    'decoded_bytes',
    imageDecodedBytes,
    M2_GLTF_DECODED_IMAGE_BYTES,
    'decoded image pixel bytes exceed the M2 cap',
  );
  cap(
    'decoded_bytes',
    metrics.decodedGeometryBytes + imageDecodedBytes,
    M2_GLTF_TOTAL_DECODED_BYTES,
    'total decoded bytes exceed the M2 cap',
  );
  return out;
}

// --- public entry points -----------------------------------------------------

function prepare(bytes: Uint8Array, options: ImportOptions): ImportProposal {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('inspectGlb: bytes must be a Uint8Array');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('inspectGlb: options must be an object');
  }
  if (options.profile !== 'gltf-glb') {
    throw new TypeError("inspectGlb: unsupported profile (expected 'gltf-glb')");
  }
  if (options.recipeVersion !== 1) {
    throw new TypeError('inspectGlb: unsupported recipeVersion (expected 1)');
  }
  const toolchain = resolveToolchain(options);
  const animation = resolveAnimation(options);
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  const recipe: ImportRecipe = {
    profile: 'gltf-glb',
    recipeVersion: 1,
    toolchain: { three: toolchain['three'] as string },
    extensions: [],
  };
  return new Inspector(bytes, sourceDigest, recipe, job, animation).run();
}

/**
 * Bounded GLB inspection (project-model.md §18.7.2). Deterministic, pure and
 * total over hostile bytes: malformed input yields a `rejected` proposal with
 * ordered diagnostics, never an exception. Invalid *options* (a caller
 * programming error: unknown profile/recipe version, a non-pinned toolchain,
 * a malformed job identity) throw `TypeError`.
 */
export function inspectGlb(bytes: Uint8Array, options: ImportOptions): ImportProposal {
  return prepare(bytes, options);
}

/**
 * The job-bound preparation entry (packet 24: "over bytes and injected job
 * ports"): identical validation, but the injected job port is required, so the
 * proposal always carries a real job identity, a real bounded deadline and
 * caller cancellation.
 *
 * Contract note C24-1 (recorded in the packet-24 handoff): dependencies.md
 * §3's `asset-pipeline` row lists `inspectGlb(bytes, options)`; this entry is
 * the packet instruction's `prepareImport` and is proposed for addition to
 * that row.
 */
export function prepareImport(bytes: Uint8Array, options: PrepareImportOptions): ImportProposal {
  if (!isPlainObject(options) || !isPlainObject(options.job)) {
    throw new TypeError('prepareImport: options.job must be an ImportJobPort');
  }
  return prepare(bytes, options);
}

/** §18.5/§41.4.3 `recipeDigest` = SHA-256 of the canonical JSON of the recipe. */
export function importRecipeDigest(recipe: ImportRecipe | PcmWavRecipe): string {
  return sha256HexOfText(canonicalJsonText(recipe));
}

/**
 * The proposal's deterministic metadata digest: SHA-256 of the canonical JSON
 * of the proposal's persistable facts (`status`, `kind`, `sourceDigest`,
 * `sourceByteLength`, `importRecipe`, `metrics` when present). Job identity,
 * stage id, expiry, display name and the non-persistent `inspection` display
 * lists are deliberately excluded, so re-inspecting the same bytes yields the
 * same digest regardless of the job that carried them (§18.8.3).
 */
export function importMetadataDigest(
  proposal: ImportMetadataFacts | ImportProposal | AudioImportProposal,
): string {
  const metadata: Record<string, unknown> = {
    status: proposal.status,
    sourceDigest: proposal.sourceDigest,
    sourceByteLength: proposal.sourceByteLength,
    importRecipe: proposal.importRecipe,
  };
  if (proposal.kind !== undefined) metadata['kind'] = proposal.kind;
  if (proposal.metrics !== undefined) metadata['metrics'] = proposal.metrics;
  return sha256HexOfText(canonicalJsonText(metadata));
}
