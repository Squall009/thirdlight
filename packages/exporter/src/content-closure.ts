/**
 * The shared M2 content/gameplay closure builder (packet 36; export.md §2/§4,
 * sessions.md §17.1.3, dependencies.md §3 `exporter` row: "the shared
 * manifest/closure builder").
 *
 * ONE implementation composes the immutable runtime-content manifest and the
 * declared artifact bytes for both delivery paths:
 *
 *   - the play path (`backend/play-content.ts` → `buildPlayContent`) wraps this
 *     closure and adds the prebuilt play bundle as `game.js`;
 *   - the export path (`export.ts` → the M2 pipeline) wraps it and writes the
 *     declared artifacts into the export output tree.
 *
 * All authoring reads go through the INJECTED workspace service (the exporter
 * and the backend never touch files directly — no second authority), and the
 * behavior compilation goes through the INJECTED packet-33 compiler port (the
 * structural `ContentClosureCompilerPort` below — the real
 * `@thirdlight/behavior-build` compiler is supplied by the backend, so this
 * package keeps its allowed node-side edge set, dependencies.md §4.1).
 *
 * No evaluation of project source happens here: `compile` is a pure
 * bytes-in/bytes-out call on the injected compiler; the returned behavior
 * bytes are linked into the bundle by the caller.
 */
import type { AnimatorController, EnvironmentConfig, PrefabDefinition, GameFlow, InputConfig, LightingMap, MaterialDef } from '@thirdlight/project-model';
import { animatorsForRuntime, effectsForRuntime, type EffectDef, materialFunctionsForRuntime, materialsForRuntime, type GraphDocument, captureContentViewV3, captureManifestV2, M3_ENGINE_PINS, resolveMediaIdentityV3, sha256Hex, type GameConfig, type GameplaySettings, type ManifestAssetInputV2, type ManifestBehaviorInput, type MediaBlock, type RuntimeContentManifestV2, type ManifestSceneRow, physicsDimensionOf, resolveRequiredModules } from '@thirdlight/project-model';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The injected packet-33 compiler port (structural; no behavior-build edge). */
export interface ContentClosureCompilerPort {
  /** The pinned engine module table the compiler compiles against. */
  readonly pinnedModules: unknown;
  compile(input: {
    behaviorId: string;
    declaration: unknown;
    containerBytes: Uint8Array;
    pinnedModules: unknown;
  }): Promise<
    | { ok: true; outputBytes: Uint8Array; outputDigest: string }
    | { ok: false; reason: string; diagnostics?: readonly unknown[] }
  >;
  /**
   * Phase 19.2, Play builds only (exports never pass it): the Play debug
   * build of a visual script — the same graph compiled with the debugger's
   * recording (trace, wire values, locals) — used instead of the ordinary
   * module after that one was verified; null keeps the ordinary module (not
   * a visual script, or its graph no longer generates the published source).
   */
  debugVariant?(input: { behaviorId: string; sourceDigest: string; row: Readonly<Record<string, unknown>> }): Promise<{ outputBytes: Uint8Array; outputDigest: string } | null>;
}

/** One declared artifact of the closure (path relative to the artifact root). */
export interface ClosureArtifact {
  path: string;
  bytes: Uint8Array;
  digest: string;
  contentType: string;
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
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

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
// M3 shared closure builder (packet 58; delivery.md §2/§3, export.md §3)
// ---------------------------------------------------------------------------

/** The MIME type of one declared asset artifact by kind (export.md §6.3). */
const ASSET_CONTENT_TYPE: Record<'model' | 'audio' | 'texture' | 'music', string> = {
  model: 'model/gltf-binary',
  audio: 'audio/wav',
  // Phase 9.4: PNG/JPEG/WebP; the runtime decodes by magic bytes.
  texture: 'image/x-texture',
  // Phase 9.10: Ogg Vorbis/Opus, MP3 or WAV; the browser decodes it.
  music: 'audio/x-music',
};

export interface ContentClosureM3Input {
  /** The injected workspace service (types-only edge). */
  service: WorkspaceService;
  /** The injected behavior compiler (packet 33). */
  compiler: ContentClosureCompilerPort;
  projectId: string;
  revision: number;
  /** UTC second at capture (project-model §7.2). */
  capturedAt: string;
  /** The captured v3 scene document (the acknowledged state's scene half). */
  scene: unknown;
  /** The captured v3 content block (the acknowledged state's content half). */
  content: unknown;
  /**
   * Phase 12 (c), a v4 project: every scene (index order). Each becomes an
   * artifact `scenes/<sceneId>.json` the game loads at start or on demand;
   * `scene` is then the start scenes merged into one runtime scene.
   */
  scenes?: readonly unknown[];
  /** Phase 12 (c): the scenes the game starts with. */
  startScenes?: readonly string[];
}

export interface ContentClosureM3 {
  manifest: RuntimeContentManifestV2;
  manifestBytes: Uint8Array;
  buildId: string;
  contentDigest: string;
  snapshotId: string;
  sceneDigest: string;
  /** The emitted `scene.json` bytes (the `manifest.sceneDigest` input). */
  sceneBytes: Uint8Array;
  moduleIds: readonly string[];
  /** The resolved six-key settings (registry order) the composition consumes. */
  settings: GameplaySettings;
  /** The frozen `content.game` block (or null). */
  game: GameConfig | null;
  /** The resolved media identity (cues + animation rows). */
  media: MediaBlock;
  /** The reachable asset artifacts (`content/sha256/<digest>`), sorted by path. */
  assetArtifacts: readonly ClosureArtifact[];
  /** The reachable behavior artifacts (`behaviors/<outputDigest>.js`), sorted. */
  behaviorArtifacts: readonly ClosureArtifact[];
  /** Phase 12 (c): one artifact per scene of a v4 project (`scenes/<sceneId>.json`). */
  sceneArtifacts: readonly ClosureArtifact[];
  /** Phase 12 (c): the instance-set buffers (`content/sha256/<digest>`). */
  bufferArtifacts: readonly ClosureArtifact[];
  behaviors: readonly ClosureBehavior[];
  /** Every manifest-declared artifact path, sorted and deduplicated. */
  declaredPaths: readonly string[];
}

/**
 * Recompile every reachable source-bearing behavior from its immutable
 * container blob through the injected compiler (the recorded outputDigest is
 * an assertion, never a substitute). Shared by the M2 and M3 closures.
 */
async function compileReachableBehaviors(
  service: WorkspaceService,
  compiler: ContentClosureCompilerPort,
  projectId: string,
): Promise<
  | { ok: true; behaviorArtifacts: ClosureArtifact[]; behaviorInputs: ManifestBehaviorInput[]; behaviors: ClosureBehavior[] }
  | { ok: false; error: ContentClosureError }
> {
  const behaviorQuery = service.query({ op: 'queryBehaviors', projectId, args: { includeDeclaration: true, limit: 128, offset: 0 } });
  if (!behaviorQuery.ok) return { ok: false, error: fromCommandError(behaviorQuery.error) };
  const behaviorRows = (behaviorQuery as unknown as { behaviors: Array<Record<string, unknown>> }).behaviors;
  const behaviorArtifacts: ClosureArtifact[] = [];
  const behaviorInputs: ManifestBehaviorInput[] = [];
  const behaviors: ClosureBehavior[] = [];
  for (const row of behaviorRows) {
    const source = row['source'] as Record<string, unknown> | null | undefined;
    if (source === null || source === undefined) continue;
    const behaviorId = String(row['behaviorId']);
    const sourceDigest = String(source['sourceDigest']);
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
    if (compiled.outputDigest !== source['outputDigest']) {
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
    // Phase 19.2: a Play build may swap in the visual script's debug build (never an export: no debugVariant there).
    let outputBytes = compiled.outputBytes;
    let outputDigest = compiled.outputDigest;
    if (compiler.debugVariant !== undefined) {
      const variant = await compiler.debugVariant({ behaviorId, sourceDigest, row }).catch(() => null);
      if (variant !== null) {
        outputBytes = variant.outputBytes;
        outputDigest = variant.outputDigest;
      }
    }
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

  return { ok: true, behaviorArtifacts, behaviorInputs, behaviors };
}

/**
 * `buildContentClosureM3(input)` — the M3 shared closure builder (packet 58):
 * ONE captured input (the single acknowledged envelope read's v3 scene +
 * content halves) → the v2 manifest + the declared artifact bytes, for BOTH
 * delivery hosts (the preview/play path and the export path — delivery.md §3).
 *
 * It derives the captured v3 content view and the media identity (project-model,
 * the single pure owner), reads every reachable asset's immutable bytes through
 * the injected service (digest-verified), and assembles the v2 manifest
 * (self-identifying `buildId`, the resolved settings / frozen game / media
 * identity hash-bound through it — delivery.md §2.4).
 *
 * Source-bearing behaviors are recompiled and declared like the M2 closure;
 * the game host links them as runtime modules.
 *
 * Pure derivation + verified injected reads; no authoritative write, no
 * project source evaluation, no clock read (the caller supplies `capturedAt`).
 */
export async function buildContentClosureM3(input: ContentClosureM3Input): Promise<{ ok: true; closure: ContentClosureM3 } | { ok: false; error: ContentClosureError }> {
  const { service, projectId } = input;

  // 1. The captured v3 content view (project-model §19 v3) — reachable
  //    kind-tagged assets, the resolved settings, the frozen game, contentDigest.
  const viewRes = captureContentViewV3(input.scene, input.content, { projectId, revision: input.revision }, input.scenes);
  if (!viewRes.ok) {
    const e = viewRes.errors[0]!;
    return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
  }
  const view = viewRes.normalized;

  // 2. The media identity (delivery.md §2.3, the C35-2 rationale).
  const mediaRes = resolveMediaIdentityV3(input.scene, input.content, input.scenes);
  if (!mediaRes.ok) {
    const e = mediaRes.errors[0]!;
    return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
  }
  const media = mediaRes.normalized;

  // 3. The required engine modules, derived from the declared dependencies
  //    (the game block, the referenced content, what each behavior requires).
  //    An unresolved dependency refuses the build here, before any compile.
  const declaredBehaviors = service.query({ op: 'queryBehaviors', projectId, args: { includeDeclaration: false, limit: 128, offset: 0 } });
  if (!declaredBehaviors.ok) return { ok: false, error: fromCommandError(declaredBehaviors.error) };
  const behaviorDeps = ((declaredBehaviors as unknown as { behaviors: Array<Record<string, unknown>> }).behaviors ?? [])
    .filter((row) => row['source'] !== null && row['source'] !== undefined)
    .map((row) => ({
      behaviorId: String(row['behaviorId']),
      requiredModules: (((row['source'] as Record<string, unknown>)['requiredModules'] as string[] | undefined) ?? []),
    }));
  // A v4 project: the modules every scene needs (a scene loaded later too).
  // Phase 14.1: and every prefab a script may spawn (a spawned model needs the loader).
  const prefabDefs = input.scenes !== undefined ? ((input.content as { prefabs?: PrefabDefinition[] } | null)?.prefabs ?? []) : [];
  const moduleScene = input.scenes !== undefined
    ? { entities: [...input.scenes.flatMap((sc) => ((sc as { entities?: Record<string, unknown>[] }).entities ?? [])), ...prefabDefs.flatMap((d) => d.entities as unknown as Record<string, unknown>[])] }
    : (input.scene as { entities?: Record<string, unknown>[] });
  // Phase 23.0: the project's physics dimension picks the 2D or 3D backend.
  const modulesRes = resolveRequiredModules({ scene: moduleScene, game: view.game, behaviors: behaviorDeps, physicsDimension: physicsDimensionOf((input.content as { settings?: unknown } | null)?.settings) });
  if (!modulesRes.ok) {
    return { ok: false, error: { code: 'module_unresolved', cls: 'validation', reason: 'module_unresolved', message: modulesRes.message.slice(0, 256) } };
  }
  const moduleIds = modulesRes.moduleIds;

  // 4. The reachable source-bearing behaviors (compiled like the M2 closure);
  //    the game host links them as runtime modules.
  const compiledBehaviors = await compileReachableBehaviors(service, input.compiler, projectId);
  if (!compiledBehaviors.ok) return compiledBehaviors;
  const { behaviorArtifacts, behaviorInputs, behaviors } = compiledBehaviors;

  // 5. The declared asset bytes (verified digest-addressed reads, kind-aware MIME).
  const assetArtifacts: ClosureArtifact[] = [];
  const assets: ManifestAssetInputV2[] = [];
  for (const a of view.assets) {
    const read = service.readBlob(projectId, { assetId: a.assetId, version: a.version });
    if (!read.ok) {
      // A file referenced in place that changed or went missing: the message
      // names it; the reason keeps the workspace code through the closed
      // export/play error sets.
      const e = read.error;
      const referenced = e.code === 'asset_source_changed' || e.code === 'asset_source_missing';
      return { ok: false, error: fromCommandError(referenced && e.reason === undefined ? { ...e, reason: e.code } : e) };
    }
    if (read.digest !== a.sourceDigest || read.byteLength !== a.sourceByteLength) {
      return {
        ok: false,
        error: {
          code: 'asset_digest_mismatch',
          cls: 'unavailable',
          reason: 'asset_digest_mismatch',
          message: `asset ${a.assetId}@${a.version} no longer matches the captured view`,
          found: read.digest,
          expected: a.sourceDigest,
        },
      };
    }
    assetArtifacts.push({
      path: `content/sha256/${read.digest}`,
      bytes: read.bytes,
      digest: read.digest,
      contentType: ASSET_CONTENT_TYPE[a.kind],
    });
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
      ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
      ...(a.bounds !== undefined ? { bounds: a.bounds } : {}),
    });
  }

  // 5b. Phase 12 (c): every scene of a v4 project as its own artifact, and the
  //     instance-set buffers (verified digest-addressed reads).
  const sceneArtifacts: ClosureArtifact[] = [];
  const sceneRows: ManifestSceneRow[] = [];
  const bufferArtifacts: ClosureArtifact[] = [];
  if (input.scenes !== undefined) {
    const start = new Set(input.startScenes ?? []);
    const buffers = new Map<string, number>();
    for (const doc of input.scenes) {
      const sc = doc as { sceneId: string; entities: { components: { instances?: { buffer: string; count: number } } }[] };
      const bytes = new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
      const digest = sha256Hex(bytes);
      const path = `scenes/${sc.sceneId}.json`;
      sceneArtifacts.push({ path, bytes, digest, contentType: 'application/json' });
      sceneRows.push({ sceneId: sc.sceneId, path, digest, byteLength: bytes.length, start: start.has(sc.sceneId) });
      for (const e of sc.entities) {
        const inst = e.components.instances;
        if (inst !== undefined) buffers.set(inst.buffer, inst.count * 40);
      }
    }
    for (const [digest, byteLength] of [...buffers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const read = service.readSourceBlob(projectId, { digest });
      if (!read.ok) return { ok: false, error: fromCommandError(read.error) };
      if (read.byteLength !== byteLength) {
        return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', reason: 'instances_buffer', message: `instance buffer ${digest.slice(0, 12)}… holds ${read.byteLength} bytes, not ${byteLength} (count × 40)` } };
      }
      bufferArtifacts.push({ path: `content/sha256/${digest}`, bytes: read.bytes, digest, contentType: 'application/octet-stream' });
    }
  }

  // 6. The emitted scene bytes + sceneDigest (the manifest's sceneDigest input).
  const sceneDoc = input.scene;
  const sceneBytes = new TextEncoder().encode(`${JSON.stringify(sceneDoc, null, 2)}\n`);
  const sceneDigest = sha256Hex(sceneBytes);

  // 7. The v2 manifest (pure derivation) + self-identifying buildId.
  const captured = captureManifestV2({
    projectId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    sceneDigest,
    contentDigest: view.contentDigest,
    assets,
    behaviors: behaviorInputs,
    settings: view.settings,
    game: view.game,
    // Phase 12 (b): the tag registry rides in the manifest (scripts query by tag).
    tags: ((input.content as { tags?: { bit: number; name: string }[] } | null)?.tags ?? []),
    // Phase 9.4: project materials and the environment (the renderer's; bound by the buildId).
    // Phase 18.3: graph materials carry their graphs and parameters (the runtime compiles them to TSL), and the
    // manifest the material functions they call — without editor-only graph text (comments, groups).
    ...((input.content as { materials?: MaterialDef[] } | null)?.materials !== undefined ? { materials: materialsForRuntime((input.content as { materials: MaterialDef[] }).materials) } : {}),
    ...((input.content as { materials?: MaterialDef[] } | null)?.materials !== undefined
      ? { materialFunctions: materialFunctionsForRuntime((input.content as { materials: MaterialDef[] }).materials, (input.content as { graphs?: GraphDocument[] }).graphs ?? []) }
      : {}),
    // Phase 20.2: the visual effects (particle system graphs without editor-only text); the runtime's executors compile them.
    ...((input.content as { effects?: EffectDef[] } | null)?.effects !== undefined ? { effects: effectsForRuntime((input.content as { effects: EffectDef[] }).effects) } : {}),
    ...((input.content as { environment?: EnvironmentConfig } | null)?.environment !== undefined ? { environment: (input.content as { environment: EnvironmentConfig }).environment } : {}),
    // Phase 9.6: the scenes' bakes (lightmap atlases are texture assets, captured above).
    ...((input.content as { lighting?: LightingMap } | null)?.lighting !== undefined ? { lighting: (input.content as { lighting: LightingMap }).lighting } : {}),
    // Phase 9.10: the game flow (the game host runs levels, lives and menus from it).
    ...((input.content as { flow?: GameFlow } | null)?.flow !== undefined ? { flow: (input.content as { flow: GameFlow }).flow } : {}),
    // Phase 9.8: the input actions (the game's input binding reads them).
    ...((input.content as { input?: InputConfig } | null)?.input !== undefined ? { input: (input.content as { input: InputConfig }).input } : {}),
    // Phase 9.7: the animator controllers (the game's runtime steps them); phase 16.2: without the editor-only graph layout.
    ...((input.content as { animators?: AnimatorController[] } | null)?.animators !== undefined ? { animators: animatorsForRuntime((input.content as { animators: AnimatorController[] }).animators) } : {}),
    // Phase 14.1: a v4 game's prefabs (scripts spawn them at run time).
    ...(prefabDefs.length > 0 ? { prefabs: prefabDefs } : {}),
    ...(input.scenes !== undefined ? { scenes: sceneRows, buffers: bufferArtifacts.map((b) => ({ digest: b.digest, byteLength: b.bytes.length })) } : {}),
    media,
    moduleIds,
    enginePins: M3_ENGINE_PINS,
  });
  if (!captured.ok) {
    return { ok: false, error: { code: 'export_manifest_invalid', cls: 'validation', message: captured.error.message, reason: captured.error.reason } };
  }

  assetArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviorArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviors.sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  const declaredPaths = [...new Set([...assetArtifacts.map((a) => a.path), ...behaviorArtifacts.map((a) => a.path), ...sceneArtifacts.map((a) => a.path), ...bufferArtifacts.map((a) => a.path)])].sort();
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
      settings: view.settings,
      game: view.game,
      media,
      assetArtifacts,
      behaviorArtifacts,
      sceneArtifacts,
      bufferArtifacts,
      behaviors,
      declaredPaths,
    },
  };
}
