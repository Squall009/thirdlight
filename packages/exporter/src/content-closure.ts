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
import {
  captureManifest,
  captureContentViewV3,
  captureManifestV2,
  capturedViewDigest,
  M3_ENGINE_PINS,
  requiredModuleIds,
  resolveMediaIdentityV3,
  sha256Hex,
  type CaptureManifestResult,
  type GameConfig,
  type GameplaySettings,
  type ManifestAssetInput,
  type ManifestAssetInputV2,
  type ManifestBehaviorInput,
  type MediaBlock,
  type RuntimeContentManifest,
  type RuntimeContentManifestV2,
} from '@thirdlight/project-model';
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

export interface ContentClosureInput {
  /** The injected workspace service (types-only edge). */
  service: WorkspaceService;
  /** The injected behavior compiler (packet 33). */
  compiler: ContentClosureCompilerPort;
  projectId: string;
  revision: number;
  /** UTC second at capture (project-model §7.2). */
  capturedAt: string;
  /** The captured scene block (`{schemaVersion, sceneId, revision, entities}`). */
  scene: { schemaVersion: number; sceneId: string; revision: number; entities: ReadonlyArray<Record<string, unknown>> };
  demo: boolean;
  /**
   * The ALREADY-captured content view (the injected captured snapshot): when
   * supplied, the closure uses it instead of reading the view again, so one
   * captured revision can never mix with a later read (sessions.md §17.1.3).
   */
  capturedView?: {
    assets: readonly { assetId: string; version: number; sourceDigest: string; sourceByteLength: number; importRecipe: unknown }[];
    contentDigest: string;
  };
}

export interface ContentClosure {
  manifest: RuntimeContentManifest;
  manifestBytes: Uint8Array;
  buildId: string;
  contentDigest: string;
  snapshotId: string;
  sceneDigest: string;
  moduleIds: readonly string[];
  /** The reachable asset artifacts (`content/sha256/<digest>`), sorted by path. */
  assetArtifacts: readonly ClosureArtifact[];
  /** The reachable behavior artifacts (`behaviors/<outputDigest>.js`), sorted. */
  behaviorArtifacts: readonly ClosureArtifact[];
  /** The reachable behaviors in manifest order (ascending `behaviorId`). */
  behaviors: readonly ClosureBehavior[];
  /** Every manifest-declared artifact path, sorted and deduplicated. */
  declaredPaths: readonly string[];
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

export type ContentClosureResult = { ok: true; closure: ContentClosure } | { ok: false; error: ContentClosureError };

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

/**
 * Build the declared artifact closure for one captured revision. Pure
 * derivation + verified injected reads; no authoritative write, no project
 * source evaluation, no clock read (the caller supplies `capturedAt`).
 */
export async function buildContentClosure(input: ContentClosureInput): Promise<ContentClosureResult> {
  const { service, compiler, projectId } = input;

  // 1. The captured content view (project-model §19) — the reachable asset
  //    versions at this revision. A `storageVersion` 1 project has no v2
  //    content block (the caller decides the M1 path before reaching here).
  let capturedAssets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; importRecipe: unknown }>;
  let contentDigest: string;
  if (input.capturedView !== undefined) {
    capturedAssets = input.capturedView.assets;
    contentDigest = input.capturedView.contentDigest;
  } else {
    const viewRes = service.captureContentView(projectId);
    if (!viewRes.ok) {
      if (viewRes.error.reason === 'version_combination_unsupported') {
        // A `storageVersion` 1 project has no v2 content block: the captured
        // view is the empty view (the M1-style snapshot — no assets, no
        // behaviors). Packet-35 compatibility, unchanged.
        capturedAssets = [];
        contentDigest = capturedViewDigest({ projectId, revision: input.revision, assets: [] });
      } else {
        return { ok: false, error: fromCommandError(viewRes.error) };
      }
    } else {
      capturedAssets = viewRes.view.assets.map((a) => ({
        assetId: a.assetId,
        version: a.version,
        sourceDigest: a.sourceDigest,
        sourceByteLength: a.sourceByteLength,
        importRecipe: a.importRecipe,
      }));
      contentDigest = viewRes.view.contentDigest;
    }
  }

  // 2. The declared asset bytes (verified digest-addressed reads; the bytes
  //    are copied verbatim, never re-encoded).
  const assetArtifacts: ClosureArtifact[] = [];
  const assets: ManifestAssetInput[] = [];
  for (const a of capturedAssets) {
    const read = service.readBlob(projectId, { assetId: a.assetId, version: a.version });
    if (!read.ok) return { ok: false, error: fromCommandError(read.error) };
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
    if (!DIGEST_RE.test(read.digest)) {
      return { ok: false, error: { code: 'asset_digest_mismatch', cls: 'unavailable', message: 'a blob read returned a malformed digest' } };
    }
    assetArtifacts.push({
      path: `content/sha256/${read.digest}`,
      bytes: read.bytes,
      digest: read.digest,
      contentType: 'model/gltf-binary',
    });
    assets.push({
      assetId: a.assetId,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      importRecipe: a.importRecipe,
    });
  }

  // 3. The reachable source-bearing behaviors, recompiled deterministically
  //    from the immutable container blob through the injected compiler; the
  //    recorded outputDigest is an assertion, never a substitute.
  const compiledBehaviors = await compileReachableBehaviors(service, compiler, projectId);
  if (!compiledBehaviors.ok) return compiledBehaviors;
  const { behaviorArtifacts, behaviorInputs, behaviors } = compiledBehaviors;

  // 4. The required engine modules for this snapshot's module set.
  const moduleIds = requiredModuleIds(input.scene, input.demo, behaviors.length > 0);

  // 5. The manifest (pure derivation) + `buildId`.
  const captured: CaptureManifestResult = captureManifest({
    projectId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    scene: input.scene,
    assets,
    behaviors: behaviorInputs,
    moduleIds,
  });
  if (!captured.ok) {
    return { ok: false, error: { code: 'export_manifest_invalid', cls: 'validation', message: captured.error.message } };
  }
  const manifest = captured.manifest;
  // The manifest's contentDigest is derived here from the captured view's own
  // facts (canonical JSON + SHA-256) and must equal the workspace's
  // independently computed view digest — a real cross-check of the two
  // canonical/digest implementations (no silent divergence).
  if (manifest['contentDigest'] !== contentDigest) {
    return {
      ok: false,
      error: {
        code: 'export_manifest_invalid',
        cls: 'internal',
        message: 'the derived contentDigest does not match the captured content view digest',
        found: String(manifest['contentDigest']),
        expected: contentDigest,
      },
    };
  }
  if (manifest['sceneDigest'] !== undefined && typeof manifest['sceneDigest'] !== 'string') {
    return { ok: false, error: { code: 'export_manifest_invalid', cls: 'internal', message: 'the derived sceneDigest is not a digest string' } };
  }
  assetArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviorArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviors.sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));

  const declaredPaths = [...new Set([...assetArtifacts.map((a) => a.path), ...behaviorArtifacts.map((a) => a.path)])].sort();
  return {
    ok: true,
    closure: {
      manifest,
      manifestBytes: captured.bytes,
      buildId: captured.buildId,
      contentDigest,
      snapshotId: `${projectId}@r${input.revision}`,
      sceneDigest: String(manifest['sceneDigest']),
      moduleIds,
      assetArtifacts,
      behaviorArtifacts,
      behaviors,
      declaredPaths,
    },
  };
}

// ---------------------------------------------------------------------------
// M3 shared closure builder (packet 58; delivery.md §2/§3, export.md §3)
// ---------------------------------------------------------------------------

/** The M3 shared-composition required module set (the gameplay session + controller). */
export const M3_REQUIRED_MODULE_IDS: readonly string[] = [
  'thirdlight.platformer-game:session',
  'thirdlight.platformer:controller',
];

/** The MIME type of one declared asset artifact by kind (export.md §6.3). */
const ASSET_CONTENT_TYPE: Record<'model' | 'audio', string> = {
  model: 'model/gltf-binary',
  audio: 'audio/wav',
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
    const outputBytes = compiled.outputBytes;
    const ownedTransforms = (source['ownedTransforms'] as string[] | undefined) ?? [];
    const requiredModules = (source['requiredModules'] as string[] | undefined) ?? [];
    behaviorArtifacts.push({
      path: `behaviors/${compiled.outputDigest}.js`,
      bytes: outputBytes,
      digest: compiled.outputDigest,
      contentType: 'text/javascript; charset=utf-8',
    });
    behaviorInputs.push({
      behaviorId,
      sourceDigest,
      sourceByteLength: Number(source['sourceByteLength']),
      manifestDigest: String(source['manifestDigest']),
      outputDigest: compiled.outputDigest,
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
      outputDigest: compiled.outputDigest,
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
  const viewRes = captureContentViewV3(input.scene, input.content, { projectId, revision: input.revision });
  if (!viewRes.ok) {
    const e = viewRes.errors[0]!;
    return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
  }
  const view = viewRes.normalized;

  // 2. The media identity (delivery.md §2.3, the C35-2 rationale).
  const mediaRes = resolveMediaIdentityV3(input.scene, input.content);
  if (!mediaRes.ok) {
    const e = mediaRes.errors[0]!;
    return { ok: false, error: { code: 'export_scene_invalid', cls: 'validation', message: e.message.slice(0, 256), reason: e.code } };
  }
  const media = mediaRes.normalized;

  // 3. The reachable source-bearing behaviors (compiled like the M2 closure);
  //    the game host links them as runtime modules.
  const compiledBehaviors = await compileReachableBehaviors(service, input.compiler, projectId);
  if (!compiledBehaviors.ok) return compiledBehaviors;
  const { behaviorArtifacts, behaviorInputs, behaviors } = compiledBehaviors;

  // 4. The declared asset bytes (verified digest-addressed reads, kind-aware MIME).
  const assetArtifacts: ClosureArtifact[] = [];
  const assets: ManifestAssetInputV2[] = [];
  for (const a of view.assets) {
    const read = service.readBlob(projectId, { assetId: a.assetId, version: a.version });
    if (!read.ok) return { ok: false, error: fromCommandError(read.error) };
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
    });
  }

  // 5. The emitted scene bytes + sceneDigest (the manifest's sceneDigest input).
  const sceneDoc = input.scene;
  const sceneBytes = new TextEncoder().encode(`${JSON.stringify(sceneDoc, null, 2)}\n`);
  const sceneDigest = sha256Hex(sceneBytes);

  // 6. The v2 manifest (pure derivation) + self-identifying buildId.
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
    media,
    moduleIds: M3_REQUIRED_MODULE_IDS,
    enginePins: M3_ENGINE_PINS,
  });
  if (!captured.ok) {
    return { ok: false, error: { code: 'export_manifest_invalid', cls: 'validation', message: captured.error.message, reason: captured.error.reason } };
  }

  assetArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviorArtifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  behaviors.sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  const declaredPaths = [...new Set([...assetArtifacts.map((a) => a.path), ...behaviorArtifacts.map((a) => a.path)])].sort();
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
      moduleIds: [...M3_REQUIRED_MODULE_IDS],
      settings: view.settings,
      game: view.game,
      media,
      assetArtifacts,
      behaviorArtifacts,
      behaviors,
      declaredPaths,
    },
  };
}
