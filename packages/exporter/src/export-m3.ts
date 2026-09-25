/**
 * `exportProjectM3` — the M3 standalone content/gameplay export pipeline
 * (packet 58; delivery.md §2/§3/§5, export.md §2–§7).
 *
 * Composes the complete M3 closure from ONE captured authoring state (the
 * single acknowledged envelope read — delivery.md §2.6 "one capture, one
 * read") through the INJECTED workspace service:
 *
 *   the v2 runtime-content manifest (self-identifying `buildId`, the resolved
 *   six-key `settings` / frozen `game` / media identity hash-bound through it)
 *   + the canonical v3 scene document
 *   + every reachable asset as a relative `content/sha256/<digest>` artifact
 *   (model → `model/gltf-binary`, audio → `audio/wav`)
 *   + the M3 bundle (the single shared production composition — `game-host`)
 *   + `meta.json` v2
 *
 * and validates it: the v3 scene/content validity, the revision re-read, the
 * output-target rule, the exact M3 bundle graph, the format-aware scans (GLB
 * container, WAV container, JS text with the §5.4 forbidden patterns, relative
 * closure), the manifest self-identity (`buildId` recomputation), the closure
 * rule (every declared artifact present and every present artifact declared)
 * and the atomic publication.
 *
 * A failure writes nothing: the temp directory is removed and the previous
 * output tree is byte-untouched. Source-bearing behaviors ship as separate
 * `behaviors/<outputDigest>.js` modules the bootstrap imports.
 */
import { DECODER_LICENSES, decoderFiles, decodersNeeded } from './decoders';
import { build, version as esbuildVersion } from 'esbuild';
import {
  canonicalJsonText,
  digestBytes,
  digestEmittedClosure,
  sha256HexOfText,
  type RuntimeContentManifestV2,
} from '@thirdlight/project-model';

import { canonicalDocument } from './canonical';
import type { ContentClosureCompilerPort } from './content-closure';
import { buildContentClosureM3, type ContentClosureM3 } from './content-closure';
import { buildM3Bundle, PINNED_OPTIONS, THREE_WEBGPU_ONLY_PLUGIN } from './export-bundle';
import { assertRelativeClosure, scanGlbContainer, scanImageContainer, scanMusicContainer, scanWavContainer, textPatternCounts, type ScanPatterns } from './export-content-scan';
import { publishTree, resolveExportTarget, type TreeFile } from './export-io';
import type { ExportContext } from './export-types';
import { clip, type ExportError, type ExportResult } from './errors';
import { checkBundleGraphM3 } from './graph';

const M3_SCHEMA_VERSION = 2;
const ENGINE_VERSION = '0.1.0';
const BUNDLE_NAME = 'js/main.js';
const SCENE_NAME = 'scene.json';
const MANIFEST_NAME = 'manifest.json';
const META_NAME = 'meta.json';

/** The minimal M3 export page (export.md §3): `<canvas id="game">` + the HUD
 * root + the relative module script. The HUD is the host-owned DOM. */
const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Thirdlight Export</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: #0e1015; }
      #game { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
      #hud, #hud-root { position: fixed; top: 8px; left: 8px; font: 12px/1.4 system-ui, sans-serif; color: #9aa4b2; }
      #hud.error { color: #f87171; }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <div id="hud">loading</div>
    <div id="hud-root"></div>
    <script src="./js/main.js" type="module"></script>
  </body>
</html>
`;

function fail(code: ExportError['code'], cls: ExportError['cls'], message: string, detail?: ExportError['detail']): ExportResult {
  return { ok: false, error: { code, cls, message: clip(message), ...(detail !== undefined ? { detail } : {}) } };
}

function utcSeconds(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readJsonStringField(ctx: ExportContext, path: string, field: string): string {
  try {
    const obj = JSON.parse(new TextDecoder().decode(ctx.fs.read(path))) as Record<string, unknown>;
    return typeof obj[field] === 'string' ? (obj[field] as string) : '';
  } catch {
    return '';
  }
}

function readLockfileIntegrity(ctx: ExportContext): string | null {
  try {
    const lock = JSON.parse(new TextDecoder().decode(ctx.fs.read(ctx.lockfile))) as {
      packages?: Record<string, { integrity?: string }>;
    };
    const three = lock.packages?.['node_modules/three'];
    return three !== undefined && typeof three.integrity === 'string' ? three.integrity : null;
  } catch {
    return null;
  }
}

/** The license + version of one installed package (the §6 `licenses` rows). */
function installedPackage(ctx: ExportContext, packageJsonPath: string, id: string): { id: string; version: string; license: string; source: string } {
  try {
    const obj = JSON.parse(new TextDecoder().decode(ctx.fs.read(packageJsonPath))) as Record<string, unknown>;
    return {
      id,
      version: typeof obj['version'] === 'string' ? (obj['version'] as string) : '',
      license: typeof obj['license'] === 'string' ? (obj['license'] as string) : 'private',
      source: 'npm',
    };
  } catch {
    return { id, version: '', license: 'unknown', source: 'npm' };
  }
}

/**
 * The §5.4.1 binding 3 reference three entry: the three build the engine
 * links — phase 17.4: the WebGPU build (`three/webgpu`, the full core
 * re-exported) and TSL; `three` resolves to `three/webgpu` like in the bundle.
 */
const REFERENCE_ENTRY = "import * as WEBGPU from 'three/webgpu'; import * as TSL from 'three/tsl'; console.log(WEBGPU.REVISION, Object.keys(TSL).length);";

/** The pinned Rapier compat probe entry (re-measures the physics row). */
const RAPIER_PROBE_ENTRY = "import { createPhysicsPort } from '@thirdlight/physics-rapier'; console.log(typeof createPhysicsPort);";

/** Build one probe bundle (stdin entry, pinned §5.3 options). */
async function probeBundle(ctx: ExportContext, contents: string, sourcefile: string): Promise<Uint8Array | null> {
  try {
    const r = await build({
      ...PINNED_OPTIONS,
      stdin: { contents, resolveDir: ctx.repoRoot, sourcefile },
      write: false,
      plugins: [THREE_WEBGPU_ONLY_PLUGIN as never],
    });
    return r.outputFiles?.[0]?.contents ?? null;
  } catch {
    return null;
  }
}

/**
 * The M3 pipeline. The single captured envelope read (scene + content halves)
 * is taken by the dispatcher through the injected workspace service; every
 * other read goes through the injected service too.
 */
export async function exportProjectM3(
  ctx: ExportContext,
  captured: { scene: unknown; content: unknown; revision: number; scenes?: readonly unknown[]; startScenes?: readonly string[] },
  m3BootstrapEntry: string,
  compiler: ContentClosureCompilerPort,
): Promise<ExportResult> {
  const now = ctx.now ?? (() => Date.now());
  const capturedAt = utcSeconds(now());

  // ---- the shared M3 closure (manifest + declared artifact bytes) -----------

  const closureResult = await buildContentClosureM3({
    service: ctx.service,
    compiler,
    projectId: ctx.projectId,
    revision: captured.revision,
    capturedAt,
    scene: captured.scene,
    content: captured.content,
    ...(captured.scenes !== undefined ? { scenes: captured.scenes, startScenes: captured.startScenes ?? [] } : {}),
  });
  if (!closureResult.ok) {
    const e = closureResult.error;
    const code: ExportError['code'] =
      e.code === 'export_manifest_invalid'
        ? 'export_manifest_invalid'
        : e.code === 'export_build_unavailable'
          ? 'export_build_unavailable'
          : 'export_scene_invalid';
    return fail(code, e.cls === 'unavailable' ? 'unavailable' : e.cls === 'conflict' ? 'conflict' : 'validation', e.message, {
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    });
  }
  const closure: ContentClosureM3 = closureResult.closure;

  // ---- the M3 bundle build ----------------------------------------------------

  const built = await buildM3Bundle({ bootstrapEntry: m3BootstrapEntry, closure });
  if (!built.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'the M3 export bundle build failed (resolution/boundary defect)', {
      modules: built.modules.slice(0, 8),
    });
  }

  // The §5.4.1 binding 3 reference build + the pinned Rapier compat probe.
  const referenceBytes = await probeBundle(ctx, REFERENCE_ENTRY, 'three-reference-entry.ts');
  const rapierBytes = await probeBundle(ctx, RAPIER_PROBE_ENTRY, 'rapier-compat-probe.ts');
  if (referenceBytes === null) {
    return fail('export_bundle_forbidden_content', 'internal', 'the §5.4.1 reference three bundle could not be built (binding 3 fails closed)');
  }
  if (rapierBytes === null) {
    return fail('export_bundle_forbidden_content', 'internal', 'the pinned Rapier compat probe could not be built (the physics row fails closed)');
  }

  // ---- step 2: the authoring revision is unchanged -----------------------------

  const reRead = ctx.service.query({ op: 'queryProject', projectId: ctx.projectId });
  if (reRead.ok === false) {
    return fail('export_scene_invalid', 'validation', `the project no longer loads after the build: ${reRead.error.message}`, {
      errors: [reRead.error],
      errorTotal: 1,
    });
  }
  if (!('manifest' in reRead)) {
    return fail('export_scene_invalid', 'validation', 'inconsistent queryProject result (re-read)');
  }
  if (reRead.revision !== captured.revision) {
    return fail('export_snapshot_mismatch', 'conflict', 'the authoring revision advanced during the export — re-export', {
      frozenRevision: captured.revision,
      currentRevision: reRead.revision,
    });
  }

  // ---- step 3: the output target ----------------------------------------------

  const resolved = resolveExportTarget(ctx, captured.revision);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { exportRootReal, dirName } = resolved;

  // ---- step 4: the exact M3 bundle import graph --------------------------------

  const graph = checkBundleGraphM3(built.metafile, m3BootstrapEntry);
  if (!graph.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the M3 export bundle graph', {
      modules: graph.forbidden.slice(0, 8),
    });
  }

  // ---- step 5a: the manifest self-identity + the closure rule ------------------

  const manifestBytes = closure.manifestBytes;
  const parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RuntimeContentManifestV2;
  const recomputed = sha256HexOfText(`${JSON.stringify(manifestWithoutBuildId(parsedManifest), null, 2)}\n`);
  if (recomputed !== parsedManifest.buildId || parsedManifest.buildId !== closure.buildId) {
    return fail('export_manifest_invalid', 'internal', 'the manifest buildId does not match its own canonical bytes');
  }
  const declaredManifestPaths = new Set<string>([...closure.assetArtifacts, ...closure.behaviorArtifacts, ...closure.sceneArtifacts, ...closure.bufferArtifacts].map((a) => a.path));
  if (declaredManifestPaths.size !== closure.declaredPaths.length) {
    return fail('export_manifest_invalid', 'internal', 'the manifest declares a duplicate artifact path');
  }

  // ---- step 5b/5c: format-aware validation of every emitted artifact ----------

  const patterns: ScanPatterns = {
    authoringOrigin: ctx.authoringOrigin,
    previewOrigin: ctx.previewOrigin,
    tokenValues: ctx.tokenValues,
    locatorValues: [],
  };
  for (const asset of closure.assetArtifacts) {
    const container =
      asset.contentType === 'model/gltf-binary' ? scanGlbContainer(asset.bytes) : asset.contentType === 'image/x-texture' ? scanImageContainer(asset.bytes) : asset.contentType === 'audio/x-music' ? scanMusicContainer(asset.bytes) : scanWavContainer(asset.bytes);
    if (!container.ok) {
      return fail('scan_forbidden_content', 'internal', `a declared asset artifact fails container validation (${container.code})`, {
        hits: [{ pattern: container.code, byteOffset: container.offset ?? -1, context: `content/sha256/${asset.digest}` }],
      });
    }
    if (digestBytes(asset.bytes) !== asset.digest) {
      return fail('scan_forbidden_content', 'internal', `the emitted asset artifact bytes do not match its digest (${asset.path})`);
    }
  }
  // Behavior modules are shipped as separate files: same forbidden-content rule as the bundle.
  for (const b of closure.behaviorArtifacts) {
    const bc = textPatternCounts(new TextDecoder().decode(b.bytes), patterns);
    if (bc.a + bc.b + bc.c + bc.e + bc.g + bc.i !== 0 || digestBytes(b.bytes) !== b.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in behavior module ${b.path}`);
    }
  }
  // Phase 12 (c): scene files are text (the same forbidden-content and relative-closure
  // rules as scene.json); instance buffers are plain float data checked by digest.
  for (const sc of closure.sceneArtifacts) {
    const sceneCounts = textPatternCounts(new TextDecoder().decode(sc.bytes), patterns);
    if (sceneCounts.a + sceneCounts.b + sceneCounts.c + sceneCounts.e + sceneCounts.g + sceneCounts.i !== 0 || digestBytes(sc.bytes) !== sc.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in scene file ${sc.path}`);
    }
  }
  for (const b of closure.bufferArtifacts) {
    if (digestBytes(b.bytes) !== b.digest || b.bytes.length % 40 !== 0) {
      return fail('scan_forbidden_content', 'internal', `an instance buffer does not match its digest or size (${b.path})`);
    }
  }
  const bundleText = new TextDecoder().decode(built.bytes);
  const counts = textPatternCounts(bundleText, patterns);
  // The §5.4 forbidden patterns must be zero in the M3 bundle (the exact
  // §5.4.1 count re-measurement against the current three + game-host install
  // is the 58/60 re-measurement step — the forbidden-pattern gate is the
  // binding security check here).
  if (counts.a + counts.b + counts.c + counts.e + counts.g + counts.i !== 0) {
    return fail(
      'export_bundle_forbidden_content',
      'internal',
      `forbidden content in the M3 export bundle (a=${counts.a} b=${counts.b} c=${counts.c} e=${counts.e} g=${counts.g} i=${counts.i})`,
      { reason: `counts=${JSON.stringify(counts)}` },
    );
  }
  const textFiles = [
    { name: 'index.html', text: INDEX_HTML },
    { name: MANIFEST_NAME, text: new TextDecoder().decode(manifestBytes) },
    { name: SCENE_NAME, text: new TextDecoder().decode(closure.sceneBytes) },
  ];
  const relative = assertRelativeClosure(textFiles, patterns);
  if (!relative.ok) {
    return fail('scan_forbidden_content', 'internal', 'an emitted text artifact contains an absolute/remote reference', {
      hits: relative.hits.slice(0, 4),
    });
  }

  // ---- the output tree + meta.json v2 -----------------------------------------

  // three's Draco/Basis decoders ship only when a shipped GLB needs them.
  const decoders = decodersNeeded(closure.assetArtifacts);
  const threeDir = ctx.fs.join(ctx.threePackageJson, '..');
  const decoderArtifacts = decoderFiles(decoders, threeDir, (p) => ctx.fs.read(p), (...p) => ctx.fs.join(...p)).map((f) => ({
    ...f,
    digest: digestBytes(f.bytes),
  }));

  const indexBytes = new TextEncoder().encode(INDEX_HTML);
  const assetBytes = closure.assetArtifacts.reduce((n, a) => n + a.bytes.length, 0);
  const behaviorBytes = closure.behaviorArtifacts.reduce((n, a) => n + a.bytes.length, 0);
  const extraArtifacts = [...closure.sceneArtifacts, ...closure.bufferArtifacts];
  const closureEntries = [
    { path: 'index.html', digest: digestBytes(indexBytes), byteLength: indexBytes.length },
    { path: BUNDLE_NAME, digest: digestBytes(built.bytes), byteLength: built.bytes.length },
    { path: MANIFEST_NAME, digest: digestBytes(manifestBytes), byteLength: manifestBytes.length },
    { path: SCENE_NAME, digest: closure.sceneDigest, byteLength: closure.sceneBytes.length },
    ...[...closure.assetArtifacts, ...closure.behaviorArtifacts, ...extraArtifacts].map((a) => ({ path: a.path, digest: a.digest, byteLength: a.bytes.length })),
    ...decoderArtifacts.map((a) => ({ path: a.path, digest: a.digest, byteLength: a.bytes.length })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outputDigest = digestEmittedClosure(closureEntries);

  const licenses = [
    installedPackage(ctx, ctx.threePackageJson, 'three'),
    installedPackage(ctx, ctx.typescriptPackageJson, 'typescript'),
    { id: 'esbuild', version: esbuildVersion, license: 'MIT', source: 'npm' },
    { id: '@dimforge/rapier2d-compat', version: readJsonStringField(ctx, ctx.fs.join(ctx.repoRoot, 'node_modules/@dimforge/rapier2d-compat/package.json'), 'version'), license: 'Apache-2.0', source: 'npm' },
    ...decoders.map((d) => ({ id: DECODER_LICENSES[d].id, version: readJsonStringField(ctx, ctx.threePackageJson, 'version'), license: DECODER_LICENSES[d].license, source: 'npm' })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const sceneEntities = (captured.scene as { entities?: unknown[] })?.entities ?? [];
  const meta = {
    schemaVersion: M3_SCHEMA_VERSION,
    type: 'thirdlight-export',
    engineVersion: ENGINE_VERSION,
    projectId: ctx.projectId,
    snapshotId: closure.snapshotId,
    revision: captured.revision,
    exportedAt: utcSeconds(now()),
    dependencies: {
      three: readJsonStringField(ctx, ctx.threePackageJson, 'version'),
      typescript: readJsonStringField(ctx, ctx.typescriptPackageJson, 'version'),
      esbuild: esbuildVersion,
      // Phase 15.3: the project's step rate (the fixed_step_hz setting; absent: 120).
      runtime: { fixedStepHz: parsedManifest.settings.fixed_step_hz ?? 120, modules: [...closure.moduleIds] },
    },
    scene: {
      entityCount: sceneEntities.length,
      cameraId: null,
    },
    behaviors: closure.behaviors.map((b) => ({ behaviorId: b.behaviorId, sourceDigest: b.sourceDigest, outputDigest: b.outputDigest })),
    behaviorTrust: { acknowledgedSourceDigests: closure.behaviors.map((b) => b.sourceDigest).sort() },
    manifest: {
      manifestVersion: parsedManifest.manifestVersion,
      snapshotId: parsedManifest.snapshotId,
      revision: parsedManifest.revision,
      contentDigest: parsedManifest.contentDigest,
      buildId: parsedManifest.buildId,
      buildOptionsDigest: parsedManifest.buildOptionsDigest,
      // Packet 58: the manifest block gains the three M3 digests (copies of the
      // manifest's own hash-bound fields).
      gameDigest: parsedManifest.gameDigest,
      settingsDigest: parsedManifest.settingsDigest,
      mediaDigest: parsedManifest.mediaDigest,
    },
    licenses,
    artifacts: {
      assets: { count: closure.assetArtifacts.length, bytes: assetBytes },
      behaviors: { count: closure.behaviorArtifacts.length, bytes: behaviorBytes },
      total: { count: closure.assetArtifacts.length + closure.behaviorArtifacts.length, bytes: assetBytes + behaviorBytes },
    },
    outputDigest,
  };
  const metaBytes = canonicalDocument(meta);

  const files: TreeFile[] = [
    { name: 'index.html', bytes: indexBytes },
    { name: BUNDLE_NAME, bytes: built.bytes },
    { name: MANIFEST_NAME, bytes: manifestBytes },
    { name: SCENE_NAME, bytes: closure.sceneBytes },
    ...[...closure.assetArtifacts, ...closure.behaviorArtifacts, ...extraArtifacts].map((a) => ({ name: a.path, bytes: a.bytes })),
    ...decoderArtifacts.map((a) => ({ name: a.path, bytes: a.bytes })),
    { name: META_NAME, bytes: metaBytes },
  ];

  // ---- step 6: atomic publication ---------------------------------------------

  const published = publishTree(ctx.fs, exportRootReal, dirName, files);
  if (!published.ok) return { ok: false, error: published.error };

  return {
    ok: true,
    outputDir: dirName,
    snapshotId: closure.snapshotId,
    revision: captured.revision,
    files: published.files,
    scanHits: 0,
    schemaVersion: M3_SCHEMA_VERSION,
    buildId: closure.buildId,
    contentDigest: parsedManifest.contentDigest,
    outputDigest,
  };
}

/** The manifest document without `buildId` (the `buildId` preimage object). */
function manifestWithoutBuildId(manifest: RuntimeContentManifestV2): Record<string, unknown> {
  const without: Record<string, unknown> = {};
  const keys = [
    'manifestVersion', 'type', 'projectId', 'revision', 'snapshotId', 'capturedAt', 'sceneDigest', 'contentDigest',
    'gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'tags', 'materials', 'materialFunctions', 'effects', 'environment', 'lighting', 'animators', 'prefabs', 'input', 'flow', 'scenes', 'buffers', 'assets', 'media', 'behaviors', 'modules',
    'enginePins', 'recipes', 'toolchain', 'buildOptionsDigest',
  ];
  for (const k of keys) without[k] = (manifest as unknown as Record<string, unknown>)[k];
  return without;
}