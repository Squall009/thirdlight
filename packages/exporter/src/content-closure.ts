/**
 * The shared content/gameplay closure builder (export.md, sessions.md,
 * dependencies.md `exporter` row: "the shared manifest/closure builder").
 *
 * ONE implementation composes the immutable runtime-content manifest and the
 * declared artifact bytes for both delivery paths:
 *
 *   - the play path (`backend/play-content.ts` → `buildPlayContent`) wraps this
 *     closure and adds the prebuilt play bundle as `game.js`;
 *   - the export path (`export.ts` → `exportProjectM3`) wraps it and writes the
 *     declared artifacts into the export output tree.
 *
 * All authoring reads go through the INJECTED workspace service (the exporter
 * and the backend never touch files directly — no second authority), and the
 * behavior compilation goes through the INJECTED compiler port (the
 * structural `ContentClosureCompilerPort` below — the real
 * `@thirdlight/behavior-build` compiler is supplied by the backend, so this
 * package keeps its allowed node-side edge set, dependencies.md).
 *
 * No evaluation of project source happens here: `compile` is a pure
 * bytes-in/bytes-out call on the injected compiler; the returned behavior
 * bytes are linked into the bundle by the caller.
 */
import type { BlockType, CellField, SaveSchema } from '@thirdlight/project-model';
import { dialogueForRuntime, type DialogueDocument, type DialogueSettings, type DialogueSpeaker } from '@thirdlight/project-model';
import type { GameMode } from '@thirdlight/project-model';
import type { EventCue, GameShell, TimelineAsset } from '@thirdlight/project-model';
import type { AnimatorController, EnvironmentConfig, PrefabDefinition, InputConfig, LightingMap, MaterialDef, UiDocument, UiTheme } from '@thirdlight/project-model';
import { animatorsForRuntime, effectsForRuntime, type EffectDef, materialFunctionsForRuntime, materialsForRuntime, type GraphDocument, captureContentViewV3, captureManifestV5, restampManifestV5, type CatalogFile, dependencyTables, scanDependencies, M3_ENGINE_PINS, resolveMediaIdentityV3, sha256Hex, type GameplaySettings, type ManifestAssetInputV2, type ManifestAssetInputV5, type ManifestBehaviorInput, type MediaBlock, type RuntimeContentManifestV5, type ManifestSceneRow, physicsDimensionOf, resolveRequiredModules, materialsInUse, resolveMaterialInstances, loadableAssetIds, loadableResourceIds, loadableRows, scriptLibraryContainerText, scriptLibraryDigest, type ScriptLibrary } from '@thirdlight/project-model';
import { playChecks, projectWideRoots, startDrawSet, type MissingPlayFile, type PlayCheck, type SceneV4 } from '@thirdlight/project-model';
import { ASSET_QUERY_PAGE_MAX, audioLoadOf, MODEL_RIG_LIMITS, readModelRig, textureStreamingOf, type AudioLoadType, type ManifestMipPart, type ModelRig } from '@thirdlight/project-model';
import type { BlobFile, WorkspaceService } from '@thirdlight/workspace';

/** The injected compiler port (structural; no behavior-build edge). */
export interface ContentClosureCompilerPort {
  /** The pinned engine module table the compiler compiles against. */
  readonly pinnedModules: unknown;
  compile(input: {
    behaviorId: string;
    declaration: unknown;
    containerBytes: Uint8Array;
    pinnedModules: unknown;
    /** The script libraries the source's `@lib/<id>` imports link. */
    libraries?: readonly { libraryId: string; containerBytes: Uint8Array }[];
    /** `bundle` re-derives the bundled form (checking a record published in that form). */
    libraryLinking?: 'shared' | 'bundle';
  }): Promise<
    | {
        ok: true;
        outputBytes: Uint8Array;
        outputDigest: string;
        /** The output's source map (JSON text). */
        sourceMap?: string;
        /** The shared library modules the output imports. */
        libraryModules?: readonly ClosureLibraryModule[];
      }
    | { ok: false; reason: string; diagnostics?: readonly unknown[] }
  >;
  /**
   * Play builds only (exports never pass it): the Play debug
   * build of a visual script — the same graph compiled with the debugger's
   * recording (trace, wire values, locals) — used instead of the ordinary
   * module after that one was verified; null keeps the ordinary module (not
   * a visual script, or its graph no longer generates the published source).
   */
  debugVariant?(input: { behaviorId: string; sourceDigest: string; row: Readonly<Record<string, unknown>> }): Promise<{ outputBytes: Uint8Array; outputDigest: string } | null>;
}

/** One shared script library module a compiled behavior imports. */
export interface ClosureLibraryModule {
  libraryId: string;
  sourceDigest: string;
  outputBytes: Uint8Array;
  outputDigest: string;
  sourceMap: string;
}

/**
 * What a compiled output's positions map back to (Play only uses
 * it; nothing of it is served or exported): a behavior's or a library's
 * source map, by the output's digest.
 */
export interface ClosureSourceMap {
  outputDigest: string;
  behaviorId?: string;
  libraryId?: string;
  sourceMap: string;
}

/** One declared artifact of the closure (path relative to the artifact root). */
export interface ClosureArtifact {
  path: string;
  bytes: Uint8Array;
  digest: string;
  contentType: string;
}

/**
 * One declared artifact found on disk but not read (a Play build's assets
 * and instance buffers): the host serves it from its file, which the
 * workspace verifies while it is sent.
 */
export interface ClosureFileArtifact {
  path: string;
  digest: string;
  byteLength: number;
  contentType: string;
  /** Where the workspace found it (backend-internal; `real` is a host path). */
  file: BlobFile;
}

/** A streamed texture of the closure: its whole KTX2's digest and its parts, in file order. */
export interface ClosureStreamedTexture {
  assetId: string;
  digest: string;
  parts: readonly ClosureFileArtifact[];
}

/** One reachable source-bearing behavior of the closure. */
export interface ClosureBehavior {
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  apiVersion: number;
  declaration: unknown;
  ownedTransforms: readonly string[];
  requiredModules: readonly string[];
  /** The compiled output bytes linked as a static bundle input. */
  outputBytes: Uint8Array;
}

export interface ContentClosureError {
  code: string;
  cls: 'validation' | 'conflict' | 'internal' | 'unavailable';
  message: string;
  reason?: string;
  sourceDigest?: string;
  found?: string;
  expected?: string;
  /** Every asset whose file is missing (a refusal names them all, not the first). */
  missingFiles?: readonly MissingPlayFile[];
}

/** The workspace's codes for an asset whose bytes are not on disk (its file, its import cache entry or its stored blob). */
const MISSING_CODES: ReadonlySet<string> = new Set(['asset_source_missing', 'blob_missing']);

/** The bytes a placeholder stands in with for a missing asset (null: none for this kind). */
export type ClosurePlaceholderMaker = (asset: { readonly assetId: string; readonly kind: string; readonly bounds?: unknown }) => Uint8Array | null;

const DIGEST_RE = /^[0-9a-f]{64}$/;
/** One page of the behavior query (its largest). */
const BEHAVIOR_PAGE = ASSET_QUERY_PAGE_MAX;

function fromCommandError(e: {
  code: string;
  cls: string;
  message: string;
  reason?: string;
  hint?: string;
  found?: unknown;
  expected?: unknown;
}): ContentClosureError {
  const cls = e.cls === 'conflict' || e.cls === 'internal' || e.cls === 'unavailable' ? e.cls : 'validation';
  return {
    code: e.code,
    cls,
    message: e.message.slice(0, 256),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// The shared closure builder
// ---------------------------------------------------------------------------

/** The MIME type of one declared asset artifact by kind. */
const ASSET_CONTENT_TYPE: Record<'model' | 'audio' | 'texture' | 'font', string> = {
  model: 'model/gltf-binary',
  // Ogg Vorbis/Opus, MP3, WAV or FLAC; the browser decodes it.
  audio: 'audio/x-audio',
  // PNG/JPEG/WebP; the runtime decodes by magic bytes.
  texture: 'image/x-texture',
  // TTF, OTF, WOFF2 or WOFF; the page loads it through FontFace by its bytes.
  font: 'font/x-font',
};

export interface ContentClosureM3Input {
  /** The injected workspace service (types-only edge). */
  service: WorkspaceService;
  /** The injected behavior compiler. */
  compiler: ContentClosureCompilerPort;
  projectId: string;
  revision: number;
  /** UTC second at capture. */
  capturedAt: string;
  /** The captured v3 scene document (the acknowledged state's scene half). */
  scene: unknown;
  /** The captured v3 content block (the acknowledged state's content half). */
  content: unknown;
  /**
   * A v4 project: every scene (index order). Each becomes an
   * artifact `scenes/<sceneId>.json` the game loads at start or on demand;
   * `scene` is then the start scenes merged into one runtime scene.
   */
  scenes?: readonly unknown[];
  /** The scenes the game starts with. */
  startScenes?: readonly string[];
  /**
   * Where the build's time goes (Play's start timings). The
   * caller's clock: the closure itself reads none, and the output never
   * depends on it. Stages: view, behaviors, assets, scenes, rigs, manifest.
   */
  timings?: { readonly now: () => number; readonly add: (stage: string, ms: number) => void };
  /**
   * SHA-256 (lowercase hex) for the scene files' bytes — a
   * host's native hash (the backend's), else project-model's portable one.
   * The digests are the same either way.
   */
  sha256?: (bytes: Uint8Array) => string;
  /**
   * Find the assets and instance buffers on disk instead of reading them
   * (Play: the page reads each file when it needs it, served from disk).
   * They are then `assetFiles` and `bufferFiles`, and `assetArtifacts` and
   * `bufferArtifacts` are empty. An export reads them (default).
   */
  locate?: boolean;
  /**
   * A build made ahead of a Play, in the background: it gives the event loop
   * back between its stages so requests meanwhile are not held for the whole
   * build (the output is the same).
   */
  background?: boolean;
  /**
   * Play: an asset whose file is missing and that the start scenes and the
   * project-wide blocks do not draw ships as a placeholder made here (a
   * scene loaded later shows it in the asset's place). Absent (an export),
   * or a missing file the start draws: the build refuses, naming every
   * missing file.
   */
  placeholders?: ClosurePlaceholderMaker;
  /** The scenes the start loads when they are not only `startScenes` (a Play started in another scene). */
  drawnScenes?: readonly string[];
}

export interface ContentClosureM3 {
  manifest: RuntimeContentManifestV5;
  manifestBytes: Uint8Array;
  buildId: string;
  contentDigest: string;
  snapshotId: string;
  sceneDigest: string;
  /** The emitted `scene.json` bytes (the `manifest.sceneDigest` input). */
  sceneBytes: Uint8Array;
  moduleIds: readonly string[];
  /** The missing files placeholders stand in for (Play only). */
  placeholders: readonly MissingPlayFile[];
  /** The start's warnings (scene rules checked before a start, not per command; a refusing one fails the build instead). */
  checks: readonly PlayCheck[];
  /** The resolved six-key settings (registry order) the composition consumes. */
  settings: GameplaySettings;
  /** The resolved media identity (the animation rows; no cue slots). */
  media: MediaBlock;
  /** The reachable asset artifacts (`content/sha256/<digest>`), sorted by path. */
  assetArtifacts: readonly ClosureArtifact[];
  /** The reachable behavior artifacts (`behaviors/<outputDigest>.js`), sorted. */
  behaviorArtifacts: readonly ClosureArtifact[];
  /** One artifact per scene of a v4 project (`scenes/<sceneId>.json`). */
  sceneArtifacts: readonly ClosureArtifact[];
  /** The instance-set buffers (`content/sha256/<digest>`). */
  bufferArtifacts: readonly ClosureArtifact[];
  /** With `locate`: the reachable asset artifacts found on disk, not read (sorted by path). */
  assetFiles: readonly ClosureFileArtifact[];
  /** With `locate`: the instance-set buffers found on disk. */
  bufferFiles: readonly ClosureFileArtifact[];
  /**
   * With `locate`: the streamed textures, each shipped as its parts (the
   * KTX2 cut by mip level, in file order) instead of its whole file.
   */
  streamedTextures: readonly ClosureStreamedTexture[];
  /** The decoders the shipped assets need, from their records (a model's used extensions, a KTX2 texture). */
  decoders: readonly ('draco' | 'basis')[];
  /**
   * The manifest's content files (`content/sha256/<digest>`,
   * JSON: materials, material functions, UI documents, dialogue, the buffer
   * table), in `contentFiles` order.
   */
  contentFileArtifacts: readonly ClosureArtifact[];
  /** The shared script library modules (`libraries/<outputDigest>.js`), by library id. */
  libraryArtifacts: readonly ClosureArtifact[];
  /** The compiled outputs' source maps (Play maps error and log locations with them; never served). */
  sourceMaps: readonly ClosureSourceMap[];
  behaviors: readonly ClosureBehavior[];
  /** Every manifest-declared artifact path, sorted and deduplicated. */
  declaredPaths: readonly string[];
}

/**
 * Recompile every reachable source-bearing behavior from its immutable
 * container blob through the injected compiler (the recorded outputDigest is
 * an assertion, never a substitute).
 */
async function compileReachableBehaviors(
  service: WorkspaceService,
  compiler: ContentClosureCompilerPort,
  projectId: string,
  behaviorRows: ReadonlyArray<Record<string, unknown>>,
  scriptLibraries: readonly ScriptLibrary[] = [],
): Promise<
  | { ok: true; behaviorArtifacts: ClosureArtifact[]; behaviorInputs: ManifestBehaviorInput[]; behaviors: ClosureBehavior[]; libraryArtifacts: ClosureArtifact[]; libraryRows: ManifestLibraryInput[]; sourceMaps: ClosureSourceMap[] }
  | { ok: false; error: ContentClosureError }
> {
  const behaviorArtifacts: ClosureArtifact[] = [];
  const behaviorInputs: ManifestBehaviorInput[] = [];
  const behaviors: ClosureBehavior[] = [];
  // The shared library modules the compiled behaviors import (one each, by output digest).
  const libraryModules = new Map<string, ClosureLibraryModule>();
  const sourceMaps: ClosureSourceMap[] = [];
  // The script libraries (canonical containers), built once for every behavior of the build.
  const libraryInputs = scriptLibraries.map((l) => ({ libraryId: l.libraryId, containerBytes: new TextEncoder().encode(scriptLibraryContainerText(l)) }));
  const libraryDigests = new Map(scriptLibraries.map((l) => [l.libraryId, scriptLibraryDigest(l)] as const));
  for (const row of behaviorRows) {
    const source = row['source'] as Record<string, unknown> | null | undefined;
    if (source === null || source === undefined) continue;
    const behaviorId = String(row['behaviorId']);
    const sourceDigest = String(source['sourceDigest']);
    // A behavior compiled against another version of a library than the project's is stale.
    const pins = (source['libraries'] as { libraryId: string; sourceDigest: string }[] | undefined) ?? [];
    const stale = pins.find((p) => libraryDigests.get(p.libraryId) !== p.sourceDigest);
    if (stale !== undefined) {
      return {
        ok: false,
        error: {
          code: 'export_build_unavailable',
          cls: 'unavailable',
          reason: 'behavior_library_stale',
          message: `behavior ${behaviorId} was published against another version of the script library "${stale.libraryId}" (republish it)`.slice(0, 256),
          sourceDigest,
        },
      };
    }
    const sourceRead = service.readSourceBlob(projectId, { digest: sourceDigest });
    if (!sourceRead.ok) {
      return { ok: false, error: fromCommandError(sourceRead.error) };
    }
    let compiled: Awaited<ReturnType<ContentClosureCompilerPort['compile']>>;
    try {
      compiled = await compiler.compile({
        behaviorId,
        declaration: row['declaration'],
        containerBytes: sourceRead.bytes,
        pinnedModules: compiler.pinnedModules,
        ...(pins.length > 0 ? { libraries: libraryInputs } : {}),
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'export_build_unavailable',
          cls: 'unavailable',
          reason: 'behavior_compile_threw',
          message: (e instanceof Error ? e.message : String(e)).slice(0, 256),
        },
      };
    }
    if (!compiled.ok) {
      return {
        ok: false,
        error: {
          code: 'export_build_unavailable',
          cls: 'unavailable',
          reason: 'behavior_compile_failed',
          message: compiled.reason.slice(0, 256),
          sourceDigest,
        },
      };
    }
    // A record published in the bundled form recorded the bundled output. It is
    // still an assertion: the bundled form must re-derive to it; the build then ships the shared form.
    let bundledRecord = false;
    if (compiled.outputDigest !== source['outputDigest'] && pins.length > 0) {
      const legacy = await compiler
        .compile({ behaviorId, declaration: row['declaration'], containerBytes: sourceRead.bytes, pinnedModules: compiler.pinnedModules, libraries: libraryInputs, libraryLinking: 'bundle' })
        .catch(() => null);
      bundledRecord = legacy !== null && legacy.ok && legacy.outputDigest === source['outputDigest'];
    }
    if (compiled.outputDigest !== source['outputDigest'] && !bundledRecord) {
      return {
        ok: false,
        error: {
          code: 'export_build_unavailable',
          cls: 'unavailable',
          reason: 'behavior_output_digest_mismatch',
          message: `behavior ${behaviorId} recompiled to a different outputDigest`,
          sourceDigest,
          found: compiled.outputDigest,
          expected: String(source['outputDigest']),
        },
      };
    }
    // A Play build may swap in the visual script's debug build (never an export: no debugVariant there).
    let outputBytes = compiled.outputBytes;
    let outputDigest = compiled.outputDigest;
    if (compiler.debugVariant !== undefined) {
      const variant = await compiler.debugVariant({ behaviorId, sourceDigest, row }).catch(() => null);
      if (variant !== null) {
        outputBytes = variant.outputBytes;
        outputDigest = variant.outputDigest;
      }
    }
    for (const m of compiled.libraryModules ?? []) {
      if (!libraryModules.has(m.outputDigest)) {
        libraryModules.set(m.outputDigest, m);
        sourceMaps.push({ outputDigest: m.outputDigest, libraryId: m.libraryId, sourceMap: m.sourceMap });
      }
    }
    if (compiled.sourceMap !== undefined && outputDigest === compiled.outputDigest) sourceMaps.push({ outputDigest, behaviorId, sourceMap: compiled.sourceMap });
    const ownedTransforms = (source['ownedTransforms'] as string[] | undefined) ?? [];
    const requiredModules = (source['requiredModules'] as string[] | undefined) ?? [];
    behaviorArtifacts.push({
      path: `behaviors/${outputDigest}.js`,
      bytes: outputBytes,
      digest: outputDigest,
      contentType: 'text/javascript; charset=utf-8',
    });
    behaviorInputs.push({
      behaviorId,
      sourceDigest,
      sourceByteLength: Number(source['sourceByteLength']),
      manifestDigest: String(source['manifestDigest']),
      outputDigest: outputDigest,
      outputByteLength: outputBytes.length,
      apiVersion: 1,
      declaration: row['declaration'],
      ownedTransforms,
      requiredModules,
    });
    behaviors.push({
      behaviorId,
      sourceDigest,
      sourceByteLength: Number(source['sourceByteLength']),
      manifestDigest: String(source['manifestDigest']),
      outputDigest: outputDigest,
      outputByteLength: outputBytes.length,
      apiVersion: 1,
      declaration: row['declaration'],
      ownedTransforms,
      requiredModules,
      outputBytes,
    });
  }

  const shared = [...libraryModules.values()].sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : a.outputDigest < b.outputDigest ? -1 : 1));
  const libraryArtifacts: ClosureArtifact[] = shared.map((m) => ({ path: `libraries/${m.outputDigest}.js`, bytes: m.outputBytes, digest: m.outputDigest, contentType: 'text/javascript; charset=utf-8' }));
  const libraryRows: ManifestLibraryInput[] = shared.map((m) => ({ libraryId: m.libraryId, sourceDigest: m.sourceDigest, outputDigest: m.outputDigest, outputByteLength: m.outputBytes.length }));
  return { ok: true, behaviorArtifacts, behaviorInputs, behaviors, libraryArtifacts, libraryRows, sourceMaps };
}

/** Every behavior record, page by page (a project has any number of them). */
function allBehaviorRows(service: WorkspaceService, projectId: string, includeDeclaration: boolean): { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: ContentClosureError } {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; ) {
    const q = service.query({ op: 'queryBehaviors', projectId, args: { includeDeclaration, limit: BEHAVIOR_PAGE, offset } });
    if (!q.ok) return { ok: false, error: fromCommandError(q.error) };
    const page = q as unknown as { behaviors: Array<Record<string, unknown>>; total?: number };
    for (const r of page.behaviors) rows.push(r);
    offset += page.behaviors.length;
    if (page.behaviors.length < BEHAVIOR_PAGE || typeof page.total !== 'number' || offset >= page.total) return { ok: true, rows };
  }
}

/** One manifest `libraries` row input. */
type ManifestLibraryInput = { libraryId: string; sourceDigest: string; outputDigest: string; outputByteLength: number };

/**
 * What a closure derives from the captured project alone — the
 * content view, the media identity, the scene files and their digests, the
 * instance buffers and the start scenes' merged file — kept for the next
 * build of the same capture. A Play of an unchanged project (the same
 * revision, the same captured objects) then serializes and hashes nothing
 * again; any change is a new capture (new objects) and derives everything.
 * Only frozen inputs are remembered (the workspace's captured reads are
 * deep-frozen), so a remembered input can never have changed.
 */
interface DerivedCapture {
  readonly projectId: string;
  readonly revision: number;
  readonly startScenes: string;
  /** The identities the derivation came from (each scene's fields, the merged scene's fields and entities). */
  readonly identities: readonly unknown[];
  readonly view: CapturedView;
  readonly media: MediaBlock;
  readonly sceneArtifacts: readonly ClosureArtifact[];
  readonly sceneRows: readonly ManifestSceneRow[];
  /** The instance buffers the scenes name (read or located per build). */
  readonly buffers: readonly { digest: string; byteLength: number }[];
  readonly sceneBytes: Uint8Array;
  readonly sceneDigest: string;
  /** Each scene's dependencies (the asset ids it needs), once derived. */
  sceneDependencies?: ReadonlyMap<string, readonly string[]>;
  /**
   * The catalog a build of this capture made, and what else it was made from
   * (the shipped files' digests, the compiled scripts, the modules): a later
   * build with the same `key` re-stamps its manifest instead of making the
   * catalog again (a second Play of an unchanged project).
   */
  catalog?: { readonly key: string; readonly manifest: RuntimeContentManifestV5; readonly files: readonly CatalogFile[] };
}
type CapturedView = Extract<ReturnType<typeof captureContentViewV3>, { ok: true }>['normalized'];

/** One remembered derivation per captured content object (a changed project has a new one). */
const derivedCaptures = new WeakMap<object, DerivedCapture>();

/**
 * Each shipped asset's catalog input, by its view row (the same object while
 * its record is unchanged) and what else it was made from: a build after an
 * edit hands the manifest the same frozen inputs for unchanged assets, whose
 * entries and shard files are then not made again.
 */
const entryInputs = new WeakMap<object, { readonly shipped: string; readonly names: unknown; readonly needs: string; readonly input: ManifestAssetInputV5 }>();

/**
 * Each scene's dependencies per content object: a build after an edit of
 * other scenes (the same content, the same entity list) scans only the
 * scenes that changed.
 */
const sceneDependenciesOf = new WeakMap<object, Map<string, { readonly entities: unknown; readonly lighting: unknown; readonly dependencies: readonly string[] }>>();

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Derivations reused / made, and catalogs re-stamped instead of made (tests). */
export const closureCacheStats = { hits: 0, misses: 0, catalogHits: 0 };

/** The identities a derivation depends on, or null when an input is not frozen (never remembered). */
function captureIdentities(scene: unknown, scenes: readonly unknown[] | undefined): unknown[] | null {
  const out: unknown[] = [];
  const fields = (o: unknown, spread: string | null): boolean => {
    if (typeof o !== 'object' || o === null || !Object.isFrozen(o)) return false;
    for (const [k, v] of Object.entries(o)) {
      out.push(k);
      if (k === spread && Array.isArray(v)) {
        if (!Object.isFrozen(v)) return false;
        out.push(v.length);
        for (const e of v) {
          if (typeof e === 'object' && e !== null && !Object.isFrozen(e)) return false;
          out.push(e);
        }
      } else {
        if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) return false;
        out.push(v);
      }
    }
    return true;
  };
  // The merged start scene is a new object per capture; its entities are the scenes' own (frozen) objects.
  if (!fields(scene, 'entities')) return null;
  for (const sc of scenes ?? []) if (!fields(sc, null)) return null;
  return out;
}

function sameIdentities(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `buildContentClosureM3(input)` — the shared closure builder:
 * ONE captured input (the single acknowledged envelope read's v3 scene +
 * content halves) → the v2 manifest + the declared artifact bytes, for BOTH
 * delivery hosts (the preview/play path and the export path — delivery.md).
 *
 * It derives the captured v3 content view and the media identity (project-model,
 * the single pure owner), reads every reachable asset's immutable bytes through
 * the injected service (digest-verified), and assembles the v2 manifest
 * (self-identifying `buildId`, the resolved settings / media
 * identity hash-bound through it — delivery.md).
 *
 * Source-bearing behaviors are recompiled and declared; the game host links
 * them as runtime modules.
 *
 * Pure derivation + verified injected reads; no authoritative write, no
 * project source evaluation, no clock read (the caller supplies `capturedAt`).
 */
export async function buildContentClosureM3(input: ContentClosureM3Input): Promise<{ ok: true; closure: ContentClosureM3 } | { ok: false; error: ContentClosureError }> {
  const { service, projectId } = input;
  // Stage times on the caller's clock (none when it gives none).
  let stageAt = input.timings?.now() ?? 0;
  const stage = (name: string): void => {
    if (input.timings === undefined) return;
    const t = input.timings.now();
    input.timings.add(name, t - stageAt);
    stageAt = t;
  };

  const hash = input.sha256 ?? sha256Hex;
  // The scene rules a start needs (checked here, for Play and the export alike, not per command).
  const checks = input.scenes !== undefined ? playChecks(input.content as Record<string, unknown>, input.scenes as readonly SceneV4[], input.drawnScenes ?? input.startScenes ?? []) : [];
  const refused = checks.filter((c) => c.refuse);
  if (refused.length > 0) {
    return { ok: false, error: { code: 'play_check_refused', cls: 'validation', reason: refused[0]!.code, message: refused.map((c) => c.message).join('; ') } };
  }
  // The derivation of this very capture, when a build before this one made it.
  const contentKey = typeof input.content === 'object' && input.content !== null && Object.isFrozen(input.content) ? (input.content as object) : null;
  const identities = contentKey !== null ? captureIdentities(input.scene, input.scenes) : null;
  const startKey = (input.startScenes ?? []).join('\u0000');
  const remembered = contentKey !== null && identities !== null ? derivedCaptures.get(contentKey) : undefined;
  const derived = remembered !== undefined && remembered.projectId === projectId && remembered.revision === input.revision && remembered.startScenes === startKey && sameIdentities(remembered.identities, identities!) ? remembered : null;
  if (derived !== null) closureCacheStats.hits += 1;
  else closureCacheStats.misses += 1;

  // 1. The captured v3 content view (project-model) — reachable
  //    kind-tagged assets, the resolved settings, contentDigest.
  let view: CapturedView;
  let media: MediaBlock;
  if (derived !== null) {
    view = derived.view;
    media = derived.media;
  } else {
    // What scenes reference, and the loadable assets (an address or a label: a script may load them by name).
    const viewRes = captureContentViewV3(input.scene, input.content, { projectId, revision: input.revision }, input.scenes, loadableAssetIds(input.content), hash);
    if (!viewRes.ok) {
      const e = viewRes.errors[0]!;
      return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
    }
    view = viewRes.normalized;

    // 2. The media identity.
    const mediaRes = resolveMediaIdentityV3(input.scene, input.content, input.scenes);
    if (!mediaRes.ok) {
      const e = mediaRes.errors[0]!;
      return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
    }
    media = mediaRes.normalized;
  }

  // 3. The required engine modules, derived from the declared dependencies
  //    (the referenced content, what each behavior requires).
  //    An unresolved dependency refuses the build here, before any compile.
  // Every behavior with its source (its required modules, and what is compiled below).
  const declaredBehaviors = allBehaviorRows(service, projectId, true);
  if (!declaredBehaviors.ok) return declaredBehaviors;
  const behaviorDeps = declaredBehaviors.rows
    .filter((row) => row['source'] !== null && row['source'] !== undefined)
    .map((row) => ({
      behaviorId: String(row['behaviorId']),
      requiredModules: (((row['source'] as Record<string, unknown>)['requiredModules'] as string[] | undefined) ?? []),
    }));
  // A v4 project: the modules every scene needs (a scene loaded later too).
  // And every prefab a script may spawn (a spawned model needs the loader).
  const prefabDefs = input.scenes !== undefined ? ((input.content as { prefabs?: PrefabDefinition[] } | null)?.prefabs ?? []) : [];
  const moduleScene = input.scenes !== undefined
    ? { entities: [...input.scenes.flatMap((sc) => ((sc as { entities?: Record<string, unknown>[] }).entities ?? [])), ...prefabDefs.flatMap((d) => d.entities as unknown as Record<string, unknown>[])] }
    : (input.scene as { entities?: Record<string, unknown>[] });
  // The project's physics dimension picks the 2D or 3D backend.
  const modulesRes = resolveRequiredModules({ scene: moduleScene, behaviors: behaviorDeps, physicsDimension: physicsDimensionOf((input.content as { settings?: unknown } | null)?.settings) });
  if (!modulesRes.ok) {
    return { ok: false, error: { code: 'module_unresolved', cls: 'validation', reason: 'module_unresolved', message: modulesRes.message.slice(0, 256) } };
  }
  const moduleIds = modulesRes.moduleIds;

  stage('view');
  if (input.background === true) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  // 4. The reachable source-bearing behaviors (recompiled);
  //    the game host links them as runtime modules.
  const compiledBehaviors = await compileReachableBehaviors(service, input.compiler, projectId, declaredBehaviors.rows, ((input.content as { scriptLibraries?: ScriptLibrary[] }).scriptLibraries ?? []) as ScriptLibrary[]);
  if (!compiledBehaviors.ok) return compiledBehaviors;
  const { behaviorArtifacts, behaviorInputs, behaviors, libraryArtifacts, libraryRows, sourceMaps } = compiledBehaviors;
  stage('behaviors');

  // 5. The declared asset bytes (verified digest-addressed reads, kind-aware MIME), or, when the
  //    build only locates them, where each verified file is.
  const assetArtifacts: ClosureArtifact[] = [];
  const assetFiles: ClosureFileArtifact[] = [];
  const assets: ManifestAssetInputV2[] = [];
  const locate = input.locate === true;
  // The records by id, once (the rows below read each asset's own).
  const recordsById = new Map<string, { assetId: string; kind?: string; versions?: { version: number; metrics?: { durationMs?: unknown; format?: unknown }; importRecipe?: { extensions?: unknown } }[] }>();
  for (const r of ((input.content as { assets?: { assetId: string }[] } | null)?.assets ?? [])) recordsById.set(r.assetId, r);
  // Each audio version's recorded duration (the simulation computes script sounds' ends from it).
  const durationOf = (assetId: string, version: number): number | undefined => {
    const ms = recordsById.get(assetId)?.versions?.find((v) => v.version === version)?.metrics?.durationMs;
    return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 ? ms : undefined;
  };
  const audioLoadRowOf = (assetId: string): { loadType?: AudioLoadType; preload?: boolean } => {
    const rec = recordsById.get(assetId);
    return rec === undefined ? {} : audioLoadOf(rec as Parameters<typeof audioLoadOf>[0]);
  };
  /** The model bytes, for the rigs sockets are resolved on (read once below when the project uses sockets). */
  const modelBytes = new Map<string, Uint8Array>();
  const readError = (e: Parameters<typeof fromCommandError>[0] & { code: string; reason?: string }): ContentClosureError => {
    // A file referenced in place that changed or went missing: the message
    // names it; the reason keeps the workspace code through the closed
    // export/play error sets.
    const referenced = e.code === 'asset_source_changed' || e.code === 'asset_source_missing';
    return fromCommandError(referenced && e.reason === undefined ? { ...e, reason: e.code } : e);
  };
  const mismatch = (a: { assetId: string; version: number; sourceDigest: string }, found: string): ContentClosureError => ({
    code: 'asset_digest_mismatch',
    cls: 'unavailable',
    reason: 'asset_digest_mismatch',
    message: `asset ${a.assetId}@${a.version} no longer matches the captured view`,
    found,
    expected: a.sourceDigest,
  });
  const streamedTextures: ClosureStreamedTexture[] = [];
  const mipPartsOf = new Map<string, ManifestMipPart[]>();
  // What the catalog is made from besides the capture: each shipped file's digest (and its parts).
  const shippedKey: string[] = [];
  const located = locate ? service.locateBlobs(projectId, view.assets.map((a) => ({ assetId: a.assetId, version: a.version }))) : null;
  if (located !== null && !located.ok) return { ok: false, error: fromCommandError(located.error) };
  // Every missing file at once: a placeholder for each the start does not draw, else one refusal naming them all.
  const standIns = new Map<number, Uint8Array>();
  const placeholders: MissingPlayFile[] = [];
  if (located !== null && located.ok) {
    const missing = missingOfLocated(view.assets, located.results, input);
    if (missing.files.length > 0) {
      const made = missing.files.every((f) => !f.inStart) && input.placeholders !== undefined ? missing.indices.map((i) => input.placeholders!(view.assets[i]!)) : null;
      if (made === null || made.some((b) => b === null)) return { ok: false, error: missingError(missing.files, missing.first, input.placeholders !== undefined) };
      missing.indices.forEach((i, k) => standIns.set(i, made[k]!));
      placeholders.push(...missing.files);
    }
  }
  for (let i = 0; i < view.assets.length; i += 1) {
    const a = view.assets[i]!;
    const standIn = standIns.get(i);
    if (standIn !== undefined) {
      // The placeholder's own bytes and digest; the asset's material map, clips and streaming do not apply to it.
      const digest = hash(standIn);
      assetArtifacts.push({ path: `content/sha256/${digest}`, bytes: standIn, digest, contentType: ASSET_CONTENT_TYPE[a.kind] });
      shippedKey.push(digest);
      assets.push({
        assetId: a.assetId,
        kind: a.kind,
        version: a.version,
        sourceDigest: digest,
        sourceByteLength: standIn.length,
        recipe: a.recipe,
        metricsDigest: a.metricsDigest,
        ...(a.bounds !== undefined ? { bounds: a.bounds } : {}),
        ...(a.kind === 'audio' && durationOf(a.assetId, a.version) !== undefined ? { durationMs: durationOf(a.assetId, a.version)! } : {}),
        ...(a.kind === 'audio' ? audioLoadRowOf(a.assetId) : {}),
      });
      continue;
    }
    if (located !== null) {
      const at = located.ok ? located.results[i]! : null;
      if (at === null || !at.ok) return { ok: false, error: readError(at!.ok ? ({ code: 'internal', cls: 'internal', message: 'unreachable' } as never) : at!.error) };
      if (at.file.digest !== a.sourceDigest || at.file.byteLength !== a.sourceByteLength) return { ok: false, error: mismatch(a, at.file.digest) };
      // A streamed texture ships as its parts (the page reads the mip tail first, then the levels it needs).
      const rec = a.kind === 'texture' ? recordsById.get(a.assetId) : undefined;
      if (rec !== undefined && textureStreamingOf(rec as Parameters<typeof textureStreamingOf>[0])) {
        const cut = service.locateMipParts(projectId, at.file);
        if (!cut.ok) return { ok: false, error: fromCommandError(cut.error) };
        if (cut.parts !== null) {
          const parts = cut.parts.map((p) => ({ path: `content/sha256/${p.digest}`, digest: p.digest, byteLength: p.byteLength, contentType: 'application/octet-stream', file: p.file }));
          streamedTextures.push({ assetId: a.assetId, digest: at.file.digest, parts });
          mipPartsOf.set(a.assetId, cut.parts.map((p) => ({ digest: p.digest, byteLength: p.byteLength, offset: p.offset, levels: [...p.levels] })));
        }
      }
      if (!mipPartsOf.has(a.assetId)) assetFiles.push({ path: `content/sha256/${at.file.digest}`, digest: at.file.digest, byteLength: at.file.byteLength, contentType: ASSET_CONTENT_TYPE[a.kind], file: at.file });
      shippedKey.push(mipPartsOf.has(a.assetId) ? `${at.file.digest}:${mipPartsOf.get(a.assetId)!.map((p) => p.digest).join(',')}` : at.file.digest);
    } else {
      const read = service.readBlob(projectId, { assetId: a.assetId, version: a.version });
      if (!read.ok) return { ok: false, error: readError(read.error) };
      if (read.digest !== a.sourceDigest || read.byteLength !== a.sourceByteLength) return { ok: false, error: mismatch(a, read.digest) };
      if (a.kind === 'model') modelBytes.set(a.assetId, read.bytes);
      assetArtifacts.push({
        path: `content/sha256/${read.digest}`,
        bytes: read.bytes,
        digest: read.digest,
        contentType: ASSET_CONTENT_TYPE[a.kind],
      });
      shippedKey.push(read.digest);
    }
    assets.push({
      assetId: a.assetId,
      kind: a.kind,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipe: a.recipe,
      metricsDigest: a.metricsDigest,
      ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...(a.materials !== undefined ? { materials: { ...a.materials } } : {}),
      ...(a.textures !== undefined ? { textures: { ...a.textures } } : {}),
      ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
      ...(a.bounds !== undefined ? { bounds: a.bounds } : {}),
      ...(a.kind === 'audio' && durationOf(a.assetId, a.version) !== undefined ? { durationMs: durationOf(a.assetId, a.version)! } : {}),
      // How the game holds the file (the runtime's audio loading reads it).
      ...(a.kind === 'audio' ? audioLoadRowOf(a.assetId) : {}),
      ...(mipPartsOf.has(a.assetId) ? { mipParts: mipPartsOf.get(a.assetId)! } : {}),
    });
  }
  // The decoders the shipped assets need, from what their records say (the bytes are not read here):
  // a model's import recipe names the glTF extensions it uses (the view's recipe is only its profile and version).
  const decoders = new Set<'draco' | 'basis'>();
  for (const a of view.assets) {
    if (a.kind === 'model') {
      const used = recordsById.get(a.assetId)?.versions?.find((v) => v.version === a.version)?.importRecipe?.extensions;
      if (Array.isArray(used) && used.includes('KHR_draco_mesh_compression')) decoders.add('draco');
      if (Array.isArray(used) && used.includes('KHR_texture_basisu')) decoders.add('basis');
    } else if (a.kind === 'texture' && recordsById.get(a.assetId)?.versions?.find((v) => v.version === a.version)?.metrics?.format === 'ktx2') decoders.add('basis');
  }

  stage('assets');
  if (input.background === true) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  // 5b. Every scene of a v4 project as its own artifact, and the
  //     instance-set buffers (verified digest-addressed reads).
  const sceneArtifacts: ClosureArtifact[] = derived !== null ? [...derived.sceneArtifacts] : [];
  const sceneRows: ManifestSceneRow[] = derived !== null ? [...derived.sceneRows] : [];
  const bufferArtifacts: ClosureArtifact[] = [];
  const bufferFiles: ClosureFileArtifact[] = [];
  const buffers = new Map<string, number>(derived !== null ? derived.buffers.map((b) => [b.digest, b.byteLength] as const) : []);
  if (input.scenes !== undefined && derived === null) {
    const start = new Set(input.startScenes ?? []);
    for (const doc of input.scenes) {
      const sc = doc as { sceneId: string; entities: { components: { instances?: { buffer: string; count: number } } }[] };
      const bytes = new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
      const digest = hash(bytes);
      const path = `scenes/${sc.sceneId}.json`;
      sceneArtifacts.push({ path, bytes, digest, contentType: 'application/json' });
      sceneRows.push({ sceneId: sc.sceneId, path, digest, byteLength: bytes.length, start: start.has(sc.sceneId) });
      for (const e of sc.entities) {
        const inst = e.components.instances;
        if (inst !== undefined) buffers.set(inst.buffer, inst.count * 40);
      }
    }
  }
  for (const [digest, byteLength] of [...buffers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const badSize = (found: number): { ok: false; error: ContentClosureError } => ({ ok: false, error: { code: 'export_scene_invalid', cls: 'validation', reason: 'instances_buffer', message: `instance buffer ${digest.slice(0, 12)}… holds ${found} bytes, not ${byteLength} (count × 40)` } });
    if (locate) {
      const at = service.locateSourceBlob(projectId, digest);
      if (!at.ok) return { ok: false, error: fromCommandError(at.error) };
      if (at.file.byteLength !== byteLength) return badSize(at.file.byteLength);
      bufferFiles.push({ path: `content/sha256/${digest}`, digest, byteLength, contentType: 'application/octet-stream', file: at.file });
    } else {
      const read = service.readSourceBlob(projectId, { digest });
      if (!read.ok) return { ok: false, error: fromCommandError(read.error) };
      if (read.byteLength !== byteLength) return badSize(read.byteLength);
      bufferArtifacts.push({ path: `content/sha256/${digest}`, bytes: read.bytes, digest, contentType: 'application/octet-stream' });
    }
  }

  stage('scenes');
  if (input.background === true) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  // 5c. The model rigs, only when the project uses sockets (a socketAttach component in a scene
  //     or prefab, or a script that names ctx.sockets) — every other project's manifest stays byte-identical.
  let rigs: Record<string, ModelRig> | undefined;
  if (usesSockets(input.scenes, prefabDefs, [...behaviorArtifacts, ...libraryArtifacts])) {
    // A located build reads the models now (only a project with sockets needs their rigs).
    if (locate) {
      for (const a of view.assets) {
        if (a.kind !== 'model' || placeholders.some((p) => p.assetId === a.assetId)) continue;
        const read = service.readBlob(projectId, { assetId: a.assetId, version: a.version });
        if (!read.ok) return { ok: false, error: readError(read.error) };
        modelBytes.set(a.assetId, read.bytes);
      }
    }
    rigs = modelRigs(view.assets, modelBytes);
  }

  stage('rigs');
  // 6. The emitted scene bytes + sceneDigest (the manifest's sceneDigest input).
  const sceneBytes = derived !== null ? derived.sceneBytes : new TextEncoder().encode(`${JSON.stringify(input.scene, null, 2)}\n`);
  const sceneDigest = derived !== null ? derived.sceneDigest : hash(sceneBytes);
  let remember: DerivedCapture | null = null;
  if (derived === null && contentKey !== null && identities !== null) {
    remember = { projectId, revision: input.revision, startScenes: startKey, identities, view, media, sceneArtifacts: [...sceneArtifacts], sceneRows: [...sceneRows], buffers: [...buffers.entries()].map(([digest, byteLength]) => ({ digest, byteLength })), sceneBytes, sceneDigest };
    derivedCaptures.set(contentKey, remember);
  }

  // The catalog of the same capture made from the same files, scripts and modules is made once: re-stamped here.
  const memo = derived ?? remember;
  const catalogKey = [locate ? 'located' : 'read', shippedKey.join(' '), JSON.stringify(behaviorInputs), JSON.stringify(libraryRows), moduleIds.join(' '), rigs !== undefined ? 'rigs' : ''].join('\n');
  let captured: { manifest: RuntimeContentManifestV5; bytes: Uint8Array; buildId: string; files: readonly CatalogFile[] };
  if (memo?.catalog !== undefined && memo.catalog.key === catalogKey) {
    captured = { ...restampManifestV5(memo.catalog.manifest, input.capturedAt, hash), files: memo.catalog.files };
    closureCacheStats.catalogHits += 1;
  } else {
    // 6b. Only the materials the game uses (an object, a prefab, a shipped model's default
    //     mapping, a block type, an effect or a timeline names them), and the functions those call.
    const allMaterials = (input.content as { materials?: MaterialDef[] } | null)?.materials;
    const usedMaterials = allMaterials === undefined
      ? undefined
      : (() => {
          const entities = input.scenes !== undefined
            ? input.scenes.flatMap((sc) => ((sc as { entities?: { components?: unknown }[] }).entities ?? []))
            : ((input.scene as { entities?: { components?: unknown }[] } | null)?.entities ?? []);
          const used = materialsInUse({
            entities: [...entities, ...((input.content as { prefabs?: PrefabDefinition[] } | null)?.prefabs ?? []).flatMap((d) => d.entities as unknown as { components?: unknown }[])],
            assets: view.assets,
            blockTypes: (input.content as { blockTypes?: BlockType[] }).blockTypes ?? [],
            effects: (input.content as { effects?: EffectDef[] }).effects ?? [],
            timelines: (input.content as { timelines?: TimelineAsset[] }).timelines ?? [],
          });
          // A loadable material ships too (a script may load it by name).
          for (const id of loadableResourceIds(input.content, 'material')) used.add(id);
          // A named instance ships resolved (its chain's graph, parameters and values folded
          // in), so the runtime never sees an instance; its parents ship only when something names them.
          return resolveMaterialInstances(allMaterials).filter((m) => used.has(m.materialId));
        })();

    // 7. The v5 manifest and its catalog files (pure derivation) + self-identifying buildId.
    const content = input.content as Record<string, unknown>;
    const runtimeMaterials = usedMaterials !== undefined ? materialsForRuntime(usedMaterials) : undefined;
    const runtimeFunctions = usedMaterials !== undefined ? materialFunctionsForRuntime(usedMaterials, (content['graphs'] as GraphDocument[] | undefined) ?? []) : undefined;
    const runtimeEffects = content['effects'] !== undefined ? effectsForRuntime(content['effects'] as EffectDef[]) : undefined;
    const runtimeAnimators = content['animators'] !== undefined ? animatorsForRuntime(content['animators'] as AnimatorController[]) : undefined;
    // What each scene, each model and the project-wide blocks need of the shipped assets (the catalog's dependency lists).
    const tables = dependencyTables({ assets: view.assets, ...(runtimeMaterials !== undefined ? { materials: runtimeMaterials } : {}), ...(runtimeFunctions !== undefined ? { functions: runtimeFunctions } : {}), ...(runtimeEffects !== undefined ? { effects: runtimeEffects } : {}), ...(runtimeAnimators !== undefined ? { animators: runtimeAnimators } : {}), prefabs: prefabDefs });
    const lighting = content['lighting'] as LightingMap | undefined;
    const sceneDependencies = new Map<string, readonly string[]>(derived?.sceneDependencies ?? []);
    if (derived?.sceneDependencies === undefined) {
      const contentKey = typeof input.content === 'object' && input.content !== null && Object.isFrozen(input.content) ? input.content : null;
      let known = contentKey !== null ? sceneDependenciesOf.get(contentKey) : undefined;
      if (contentKey !== null && known === undefined) sceneDependenciesOf.set(contentKey, (known = new Map()));
      for (const doc of input.scenes ?? []) {
        const { sceneId, entities } = doc as { sceneId: string; entities: unknown };
        const before = known?.get(sceneId);
        if (before !== undefined && before.entities === entities && before.lighting === lighting?.[sceneId]) {
          sceneDependencies.set(sceneId, before.dependencies);
          continue;
        }
        const dependencies = scanDependencies(tables, [doc, lighting?.[sceneId]]);
        sceneDependencies.set(sceneId, dependencies);
        if (Object.isFrozen(entities)) known?.set(sceneId, { entities, lighting: lighting?.[sceneId], dependencies });
      }
      if (remember !== null) remember.sceneDependencies = sceneDependencies;
    }
    // (The speakers' portraits and blips; a line's voice is read when it plays.)
    const sharedDependencies = scanDependencies(tables, projectWideRoots(content, runtimeEffects ?? null));
    // Each shipped asset with its address and labels (scripts load it by them) and, for a model, the textures its material map draws with.
    const namesById = new Map<string, { address?: string; labels?: readonly string[] }>();
    for (const r of ((content['assets'] as { assetId: string; address?: string; labels?: readonly string[] }[] | undefined) ?? [])) if (r.address !== undefined || (r.labels?.length ?? 0) > 0) namesById.set(r.assetId, r);
    const entries: ManifestAssetInputV5[] = assets.map((a, i) => {
      const names = namesById.get(a.assetId);
      const needs = a.kind === 'model' && a.materials !== undefined ? scanDependencies(tables, [a.materials]).filter((id) => id !== a.assetId) : [];
      const row = view.assets[i]!;
      const known = entryInputs.get(row);
      const needsKey = needs.join(' ');
      if (known !== undefined && known.shipped === shippedKey[i] && known.names === names && known.needs === needsKey) return known.input;
      const made = deepFreeze({ ...a, ...(names?.address !== undefined ? { address: names.address } : {}), ...(names?.labels !== undefined && names.labels.length > 0 ? { labels: names.labels } : {}), ...(needs.length > 0 ? { dependencies: needs } : {}) });
      if (Object.isFrozen(row)) entryInputs.set(row, { shipped: shippedKey[i]!, names, needs: needsKey, input: made });
      return made;
    });
    const made = captureManifestV5({
      projectId,
      revision: input.revision,
      capturedAt: input.capturedAt,
      sceneDigest,
      contentDigest: view.contentDigest,
      assets: entries,
      // The catalog of what a script may load by address or label (what this build holds).
      loadable: loadableRows(input.content, { assets: new Set(assets.map((a) => a.assetId)) }),
      behaviors: behaviorInputs,
      // The shared script library modules the behaviors import.
      ...(libraryRows.length > 0 ? { libraries: libraryRows } : {}),
      settings: view.settings,
      // The tag registry (scripts query by tag).
      tags: ((content['tags'] as { bit: number; name: string }[] | undefined) ?? []),
      // Graph materials carry their graphs and parameters (the runtime compiles them to TSL), and the
      // material functions they call — without editor-only graph text (comments, groups). The used ones only (6b).
      ...(runtimeMaterials !== undefined ? { materials: runtimeMaterials } : {}),
      ...(runtimeFunctions !== undefined ? { materialFunctions: runtimeFunctions } : {}),
      // The visual effects (particle system graphs without editor-only text); the runtime's executors compile them.
      ...(runtimeEffects !== undefined ? { effects: runtimeEffects } : {}),
      ...(content['environment'] !== undefined ? { environment: content['environment'] as EnvironmentConfig } : {}),
      // The scenes' bakes (lightmap atlases are texture assets, captured above).
      ...(lighting !== undefined ? { lighting } : {}),
      // The project UI (the game host draws the documents; themes hold their shared styles).
      ...(content['uiThemes'] !== undefined ? { uiThemes: content['uiThemes'] as UiTheme[] } : {}),
      ...(content['uiDocuments'] !== undefined ? { uiDocuments: content['uiDocuments'] as UiDocument[] } : {}),
      // The compiled conversations, speakers and settings (the runtime's dialogue runner; only with conversations).
      ...(input.content !== null ? { dialogue: dialogueForRuntime(input.content as { dialogues?: DialogueDocument[]; speakers?: DialogueSpeaker[]; dialogueSettings?: DialogueSettings }) } : {}),
      // The game modes (the runtime switches them; the host reads their pause screens).
      ...(content['modes'] !== undefined ? { modes: content['modes'] as GameMode[] } : {}),
      // The timelines (the runtime plays them in the simulation step).
      ...(content['timelines'] !== undefined ? { timelines: content['timelines'] as TimelineAsset[] } : {}),
      // The event → cue table (the runtime plays its sounds through the audio intent log).
      ...(content['eventCues'] !== undefined ? { eventCues: content['eventCues'] as EventCue[] } : {}),
      // The game shell (the game host draws its screens and HUD; the runtime walks its scene list).
      ...(content['shell'] !== undefined ? { shell: content['shell'] as GameShell } : {}),
      // The input actions (the game's input binding reads them).
      ...(content['input'] !== undefined ? { input: content['input'] as InputConfig } : {}),
      // The named collision layers (the 3D physics world resolves colliders' and queries' layers with them).
      ...(((content['collisionLayers'] as string[] | undefined) ?? []).length > 0 ? { collisionLayers: content['collisionLayers'] as string[] } : {}),
      // The project save schema (the runtime builds and restores save documents with it; the host keeps the slots).
      ...(content['saveSchema'] !== undefined ? { saveSchema: content['saveSchema'] as SaveSchema } : {}),
      // The animator controllers (the game's runtime steps them), without the editor-only graph layout.
      ...(runtimeAnimators !== undefined ? { animators: runtimeAnimators } : {}),
      // The rigs sockets are resolved on (the runtime never loads a model).
      ...(rigs !== undefined ? { rigs } : {}),
      // A v4 game's prefabs (scripts spawn them at run time).
      ...(prefabDefs.length > 0 ? { prefabs: prefabDefs } : {}),
      // The block types and the cell metadata schema (the runtime and the renderer read them).
      ...(content['blockTypes'] !== undefined ? { blockTypes: content['blockTypes'] as BlockType[] } : {}),
      ...(content['cellFields'] !== undefined ? { cellFields: content['cellFields'] as CellField[] } : {}),
      // Every scene with what it needs; the scenes the game starts with; what the project-wide blocks need.
      ...(input.scenes !== undefined ? { scenes: sceneRows.map((r) => ({ ...r, dependencies: sceneDependencies.get(r.sceneId) ?? [] })), buffers: [...buffers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([digest, byteLength]) => ({ digest, byteLength })) } : {}),
      start: input.startScenes ?? [],
      dependencies: sharedDependencies,
      media,
      moduleIds,
      enginePins: M3_ENGINE_PINS,
      sha256: hash,
    });
    if (!made.ok) {
      return { ok: false, error: { code: 'export_manifest_invalid', cls: 'validation', message: made.error.message, reason: made.error.reason } };
    }
    captured = made;
    if (memo !== null) memo.catalog = { key: catalogKey, manifest: made.manifest, files: made.files };
  }

  stage('manifest');
  // The catalog's files (JSON, by digest): its root, the blocks, the entry shards, the scenes' dependency files.
  const contentFileArtifacts: ClosureArtifact[] = captured.files.map((f) => ({ path: f.path, bytes: f.bytes, digest: f.digest, contentType: 'application/json' }));
  assetArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assetFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviorArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviors.sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  const declaredPaths = [...new Set([...assetArtifacts.map((a) => a.path), ...assetFiles.map((a) => a.path), ...behaviorArtifacts.map((a) => a.path), ...libraryArtifacts.map((a) => a.path), ...sceneArtifacts.map((a) => a.path), ...bufferArtifacts.map((a) => a.path), ...bufferFiles.map((a) => a.path), ...streamedTextures.flatMap((t) => t.parts.map((p) => p.path)), ...contentFileArtifacts.map((a) => a.path)])].sort();
  return {
    ok: true,
    closure: {
      manifest: captured.manifest,
      manifestBytes: captured.bytes,
      buildId: captured.buildId,
      contentDigest: view.contentDigest,
      snapshotId: `${projectId}@r${input.revision}`,
      sceneDigest,
      sceneBytes,
      moduleIds,
      placeholders,
      checks,
      settings: view.settings,
      media,
      assetArtifacts,
      behaviorArtifacts,
      sceneArtifacts,
      bufferArtifacts,
      assetFiles,
      bufferFiles,
      streamedTextures,
      decoders: [...decoders].sort(),
      contentFileArtifacts,
      libraryArtifacts,
      sourceMaps,
      behaviors,
      declaredPaths,
    },
  };
}

/**
 * Whether a game uses sockets — an entity of a scene or a prefab
 * carries `socketAttach`, or a compiled script names `sockets` (the
 * `ctx.sockets` API; a false positive only ships the rigs).
 */
function usesSockets(scenes: readonly unknown[] | undefined, prefabs: readonly PrefabDefinition[], behaviorArtifacts: readonly ClosureArtifact[]): boolean {
  const has = (entities: unknown): boolean => Array.isArray(entities) && entities.some((e) => (e as { components?: Record<string, unknown> } | null)?.components?.['socketAttach'] !== undefined);
  if ((scenes ?? []).some((sc) => has((sc as { entities?: unknown }).entities))) return true;
  if (prefabs.some((d) => has(d.entities))) return true;
  const decoder = new TextDecoder();
  return behaviorArtifacts.some((b) => /\bsockets\b/.test(decoder.decode(b.bytes)));
}

/**
 * Every model's rig (nodes and node animation channels read from
 * its GLB), with the clips of animation-only files ("clips for" a model)
 * added to that model's rig. Within the engine's per-model key budget
 * (`MODEL_RIG_LIMITS`): clips past it are left out and the rig is marked
 * truncated. A file that cannot be read gets no rig (a socket on it warns).
 */
function modelRigs(assets: readonly { assetId: string; kind: string; clipsFor?: string }[], bytes: ReadonlyMap<string, Uint8Array>): Record<string, ModelRig> | undefined {
  const out: Record<string, ModelRig> = {};
  const sorted = [...assets].filter((a) => a.kind === 'model').sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const used = new Map<string, number>();
  for (const a of sorted) {
    if (a.clipsFor !== undefined) continue;
    const b = bytes.get(a.assetId);
    if (b === undefined) continue;
    const r = readModelRig(b, a.assetId, MODEL_RIG_LIMITS.keyNumbers);
    if (!r.ok) continue;
    used.set(a.assetId, r.keyNumbers);
    out[a.assetId] = r.rig;
  }
  for (const a of sorted) {
    if (a.clipsFor === undefined) continue;
    const rig = out[a.clipsFor];
    const b = bytes.get(a.assetId);
    if (rig === undefined || b === undefined) continue;
    const room = MODEL_RIG_LIMITS.keyNumbers - (used.get(a.clipsFor) ?? 0);
    const r = readModelRig(b, a.assetId, Math.max(0, room));
    if (!r.ok) continue;
    used.set(a.clipsFor, (used.get(a.clipsFor) ?? 0) + r.keyNumbers);
    const clips = [...rig.clips, ...r.rig.clips].slice(0, MODEL_RIG_LIMITS.clips * 4);
    out[a.clipsFor] = { nodes: rig.nodes, clips, ...(rig.truncated === true || r.rig.truncated === true ? { truncated: true as const } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The located assets whose bytes are missing, each marked by whether the
 * start draws it (the start scenes with their bakes, the project-wide
 * blocks), with the first one's error (the refusal keeps its code).
 */
function missingOfLocated(
  assets: readonly { assetId: string; kind: string }[],
  results: readonly ({ ok: true } | { ok: false; error: { code: string; path?: unknown } })[],
  input: ContentClosureM3Input,
): { files: MissingPlayFile[]; indices: number[]; first: Parameters<typeof fromCommandError>[0] | null } {
  const indices: number[] = [];
  let first: Parameters<typeof fromCommandError>[0] | null = null;
  results.forEach((r, i) => {
    if (r.ok || !MISSING_CODES.has(r.error.code)) return;
    indices.push(i);
    first ??= r.error as Parameters<typeof fromCommandError>[0];
  });
  if (indices.length === 0) return { files: [], indices, first };
  const scenes = input.scenes ?? [input.scene];
  const start = input.scenes !== undefined ? (input.drawnScenes ?? input.startScenes ?? []) : [String((input.scene as { sceneId?: unknown } | null)?.sceneId ?? '')];
  const drawn = startDrawSet(input.content, scenes, start);
  const files = indices.map((i): MissingPlayFile => {
    const a = assets[i]!;
    const e = (results[i] as { ok: false; error: { code: string; path?: unknown } }).error;
    // A stored blob's path is the project's own store, not a game-folder file.
    const path = typeof e.path === 'string' && !e.path.startsWith('sources/') ? e.path : null;
    return { assetId: a.assetId, kind: a.kind, path, inStart: drawn.has(a.assetId), code: e.code };
  });
  return { files, indices, first };
}

/** The refusal naming every missing file (the code is the first one's; `missingFiles` lists them all). */
function missingError(files: readonly MissingPlayFile[], first: Parameters<typeof fromCommandError>[0] | null, play: boolean): ContentClosureError {
  const e = first ?? { code: 'asset_source_missing', cls: 'not_found', message: '' };
  // As every read error of a file referenced in place: the reason keeps the workspace code through the closed export/play error sets.
  const base = fromCommandError(e.code === 'asset_source_missing' && e.reason === undefined ? { ...e, reason: e.code } : e);
  const name = (f: MissingPlayFile): string => f.path ?? f.assetId;
  const listed = files.slice(0, 4).map(name).join(', ');
  const drawn = files.filter((f) => f.inStart).length;
  const why = !play ? '' : drawn > 0 ? ` (${drawn} drawn by the start scenes)` : ' (no placeholder for this kind)';
  return {
    ...base,
    message: `${files.length} asset file${files.length === 1 ? ' is' : 's are'} missing${why}: ${listed}${files.length > 4 ? ', …' : ''}`.slice(0, 256),
    missingFiles: files,
  };
}
