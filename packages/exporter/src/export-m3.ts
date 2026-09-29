/**
 * `exportProjectM3` — the standalone content/gameplay export pipeline.
 *
 * Composes the complete closure from ONE captured authoring state (the
 * single acknowledged envelope read — "one capture, one read") through the
 * INJECTED workspace service:
 *
 *   the v2 runtime-content manifest (self-identifying `buildId`, the resolved
 *   six-key `settings` / frozen `game` / media identity hash-bound through it)
 *   + the canonical v3 scene document
 *   + every reachable asset as a relative `content/sha256/<digest>` artifact
 *   (model → `model/gltf-binary`, audio → `audio/wav`)
 *   + the bundle (the single shared production composition — `game-host`)
 *   + `meta.json` v2
 *
 * and validates it: the v3 scene/content validity, the revision re-read, the
 * output-target rule, the exact bundle graph, the format-aware scans (GLB
 * container, WAV container, JS text with the forbidden patterns, relative
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
  MANIFEST_KEYS_V2,
  sha256HexOfText,
  type RuntimeContentManifestV2,
} from '@thirdlight/project-model';

import { canonicalDocument } from './canonical';
import type { ContentClosureCompilerPort } from './content-closure';
import { buildContentClosureM3, type ContentClosureM3 } from './content-closure';
import { buildM3Bundle, buildSimWorkerBundle, PINNED_OPTIONS, THREE_WEBGPU_ONLY_PLUGIN } from './export-bundle';
import { assertRelativeClosure, scanAssetContainer, textPatternCounts, type ScanPatterns } from './export-content-scan';
import { publishTree, resolveExportTarget, type TreeFile } from './export-io';
import type { ExportContext } from './export-types';
import { clip, type ExportError, type ExportResult } from './errors';
import { checkBundleGraphM3 } from './graph';

const M3_SCHEMA_VERSION = 2;
const ENGINE_VERSION = '0.1.0';
const BUNDLE_NAME = 'js/main.js';
/** The simulation worker (runtime + physics + scripts off the page's main thread). */
const WORKER_BUNDLE_NAME = 'js/sim-worker.js';
/** The 3D physics backend (rapier3d), emitted only for a project whose physics_dimension is 3. */
const PHYSICS_3D_BUNDLE_NAME = 'js/physics-3d.js';
/** The module that marks a 3D project's physics. */
const PHYSICS_3D_MODULE = 'thirdlight.physics-rapier:3d';
const SCENE_NAME = 'scene.json';
const MANIFEST_NAME = 'manifest.json';
const META_NAME = 'meta.json';

/** The minimal export page: `<canvas id="game">` + the HUD
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

/** The license + version of one installed package (the `licenses` rows). */
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
 * The binding-3 reference three entry: the three build the engine
 * links — the WebGPU build (`three/webgpu`, the full core
 * re-exported) and TSL; `three` resolves to `three/webgpu` like in the bundle.
 */
const REFERENCE_ENTRY = "import * as WEBGPU from 'three/webgpu'; import * as TSL from 'three/tsl'; console.log(WEBGPU.REVISION, Object.keys(TSL).length);";

/** The pinned Rapier compat probe entry (re-measures the physics row). */
const RAPIER_PROBE_ENTRY = "import { createPhysicsPort } from '@thirdlight/physics-rapier'; console.log(typeof createPhysicsPort);";
/** The pinned Rapier 3D compat probe entry (a 3D project's physics row). */
const RAPIER_3D_PROBE_ENTRY = "import { createPhysicsPort3D } from '@thirdlight/physics-rapier/3d'; console.log(typeof createPhysicsPort3D);";

/** The installed rapier3d-compat package.json the 3D bundle linked (from its metafile: the physics-rapier package's own pin). */
function linkedPackageJson(metafile: { inputs: Record<string, unknown> }, pkg: string): string | null {
  for (const key of Object.keys(metafile.inputs ?? {})) {
    const p = key.replace(/\\/g, '/');
    const i = p.lastIndexOf(`node_modules/${pkg}/`);
    if (i >= 0) return `${p.slice(0, i)}node_modules/${pkg}/package.json`;
  }
  return null;
}

/** Build one probe bundle (stdin entry, pinned options). */
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
 * The pipeline. The single captured envelope read (scene + content halves)
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

  // ---- the shared closure (manifest + declared artifact bytes) --------------

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

  // ---- the bundle build -------------------------------------------------------

  const built = await buildM3Bundle({ bootstrapEntry: m3BootstrapEntry, closure });
  if (!built.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'the M3 export bundle build failed (resolution/boundary defect)', {
      modules: built.modules.slice(0, 8),
    });
  }
  // The simulation worker bundle (next to the bootstrap: same directory, same rules).
  const workerEntry = ctx.fs.join(ctx.fs.join(m3BootstrapEntry, '..'), 'export-sim-worker.ts');
  const worker = await buildSimWorkerBundle(workerEntry, closure.moduleIds);
  if (!worker.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'the simulation worker bundle build failed (resolution/boundary defect)', {
      modules: worker.modules.slice(0, 8),
    });
  }

  // A 3D project's physics backend (next to the bootstrap: same directory, same rules).
  const threeD = closure.moduleIds.includes(PHYSICS_3D_MODULE);
  const physics3dEntry = ctx.fs.join(ctx.fs.join(m3BootstrapEntry, '..'), 'export-physics-3d.ts');
  const physics3d = threeD ? await buildSimWorkerBundle(physics3dEntry) : null;
  if (physics3d !== null && !physics3d.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'the 3D physics bundle build failed (resolution/boundary defect)', {
      modules: physics3d.modules.slice(0, 8),
    });
  }
  const rapier3dBytes = threeD ? await probeBundle(ctx, RAPIER_3D_PROBE_ENTRY, 'rapier3d-compat-probe.ts') : null;
  if (threeD && rapier3dBytes === null) {
    return fail('export_bundle_forbidden_content', 'internal', 'the pinned Rapier 3D compat probe could not be built (the 3D physics row fails closed)');
  }

  // The binding-3 reference build + the pinned Rapier compat probe.
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

  // ---- step 4: the exact bundle import graph -----------------------------------

  const graph = checkBundleGraphM3(built.metafile, m3BootstrapEntry, closure.moduleIds);
  if (!graph.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the M3 export bundle graph', {
      modules: graph.forbidden.slice(0, 8),
    });
  }
  const workerGraph = checkBundleGraphM3(worker.metafile, workerEntry, closure.moduleIds);
  if (!workerGraph.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the simulation worker bundle graph', {
      modules: workerGraph.forbidden.slice(0, 8),
    });
  }
  if (physics3d !== null && physics3d.ok) {
    const g3 = checkBundleGraphM3(physics3d.metafile, physics3dEntry, []);
    if (!g3.ok) return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the 3D physics bundle graph', { modules: g3.forbidden.slice(0, 8) });
  }

  // ---- step 5a: the manifest self-identity + the closure rule ------------------

  const manifestBytes = closure.manifestBytes;
  const parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RuntimeContentManifestV2;
  const recomputed = sha256HexOfText(`${JSON.stringify(manifestWithoutBuildId(parsedManifest), null, 2)}\n`);
  if (recomputed !== parsedManifest.buildId || parsedManifest.buildId !== closure.buildId) {
    return fail('export_manifest_invalid', 'internal', 'the manifest buildId does not match its own canonical bytes');
  }
  const declaredManifestPaths = new Set<string>([...closure.assetArtifacts, ...closure.behaviorArtifacts, ...closure.libraryArtifacts, ...closure.sceneArtifacts, ...closure.bufferArtifacts, ...closure.contentFileArtifacts].map((a) => a.path));
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
    const container = scanAssetContainer(asset.contentType, asset.bytes);
    if (!container.ok) {
      return fail('scan_forbidden_content', 'internal', `a declared asset artifact fails container validation (${container.code})`, {
        hits: [{ pattern: container.code, byteOffset: container.offset ?? -1, context: `content/sha256/${asset.digest}` }],
      });
    }
    if (digestBytes(asset.bytes) !== asset.digest) {
      return fail('scan_forbidden_content', 'internal', `the emitted asset artifact bytes do not match its digest (${asset.path})`);
    }
  }
  // Behavior modules (and the shared library modules they import) are shipped as
  // separate files: same forbidden-content rule as the bundle.
  for (const b of [...closure.behaviorArtifacts, ...closure.libraryArtifacts]) {
    const bc = textPatternCounts(new TextDecoder().decode(b.bytes), patterns);
    if (bc.a + bc.b + bc.c + bc.e + bc.g + bc.i !== 0 || digestBytes(b.bytes) !== b.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in behavior module ${b.path}`);
    }
  }
  // Scene files are text (the same forbidden-content and relative-closure
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
  // The manifest's content files are JSON text (the rules manifest.json's text had).
  for (const f of closure.contentFileArtifacts) {
    const c = textPatternCounts(new TextDecoder().decode(f.bytes), patterns);
    if (c.a + c.b + c.c + c.e + c.g + c.i !== 0 || digestBytes(f.bytes) !== f.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in manifest content file ${f.path}`);
    }
  }
  const bundleText = new TextDecoder().decode(built.bytes);
  const counts = textPatternCounts(bundleText, patterns);
  // The forbidden patterns must be zero in the bundle: this gate, not an exact
  // re-measurement of the recorded-exception counts, is the binding security
  // check here.
  if (counts.a + counts.b + counts.c + counts.e + counts.g + counts.i !== 0) {
    return fail(
      'export_bundle_forbidden_content',
      'internal',
      `forbidden content in the M3 export bundle (a=${counts.a} b=${counts.b} c=${counts.c} e=${counts.e} g=${counts.g} i=${counts.i})`,
      { reason: `counts=${JSON.stringify(counts)}` },
    );
  }
  // The worker bundle carries the same forbidden-pattern gate (the Rapier WASM is inlined: no URL).
  const workerCounts = textPatternCounts(new TextDecoder().decode(worker.bytes), patterns);
  if (workerCounts.a + workerCounts.b + workerCounts.c + workerCounts.e + workerCounts.g + workerCounts.i !== 0) {
    return fail(
      'export_bundle_forbidden_content',
      'internal',
      `forbidden content in the simulation worker bundle (a=${workerCounts.a} b=${workerCounts.b} c=${workerCounts.c} e=${workerCounts.e} g=${workerCounts.g} i=${workerCounts.i})`,
      { reason: `counts=${JSON.stringify(workerCounts)}` },
    );
  }
  // The 3D physics bundle carries the same gate (its WASM is inlined: no URL).
  if (physics3d !== null && physics3d.ok) {
    const c3 = textPatternCounts(new TextDecoder().decode(physics3d.bytes), patterns);
    if (c3.a + c3.b + c3.c + c3.e + c3.g + c3.i !== 0) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in the 3D physics bundle (a=${c3.a} b=${c3.b} c=${c3.c} e=${c3.e} g=${c3.g} i=${c3.i})`, { reason: `counts=${JSON.stringify(c3)}` });
    }
  }
  const textFiles = [
    { name: 'index.html', text: INDEX_HTML },
    { name: MANIFEST_NAME, text: new TextDecoder().decode(manifestBytes) },
    { name: SCENE_NAME, text: new TextDecoder().decode(closure.sceneBytes) },
    ...closure.contentFileArtifacts.map((f) => ({ name: f.path, text: new TextDecoder().decode(f.bytes) })),
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
  const extraArtifacts = [...closure.libraryArtifacts, ...closure.sceneArtifacts, ...closure.bufferArtifacts, ...closure.contentFileArtifacts];
  const closureEntries = [
    { path: 'index.html', digest: digestBytes(indexBytes), byteLength: indexBytes.length },
    { path: BUNDLE_NAME, digest: digestBytes(built.bytes), byteLength: built.bytes.length },
    { path: WORKER_BUNDLE_NAME, digest: digestBytes(worker.bytes), byteLength: worker.bytes.length },
    ...(physics3d !== null && physics3d.ok ? [{ path: PHYSICS_3D_BUNDLE_NAME, digest: digestBytes(physics3d.bytes), byteLength: physics3d.bytes.length }] : []),
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
    // A 3D project's backend (the version the 3D bundle linked).
    ...(physics3d !== null && physics3d.ok ? [{ id: '@dimforge/rapier3d-compat', version: rapier3dVersion(ctx, physics3d.metafile), license: 'Apache-2.0', source: 'npm' }] : []),
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
      // The project's step rate (the fixed_step_hz setting; absent: 120).
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
      // The manifest block carries the settings/media digests (copies of the
      // manifest's own hash-bound fields; no game digest).
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
    { name: WORKER_BUNDLE_NAME, bytes: worker.bytes },
    ...(physics3d !== null && physics3d.ok ? [{ name: PHYSICS_3D_BUNDLE_NAME, bytes: physics3d.bytes }] : []),
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

/** The rapier3d-compat version the 3D bundle linked ('' when unknown). */
function rapier3dVersion(ctx: ExportContext, metafile: { inputs: Record<string, unknown> }): string {
  const rel = linkedPackageJson(metafile, '@dimforge/rapier3d-compat');
  if (rel === null) return '';
  const path = rel.startsWith('/') ? rel : ctx.fs.join(ctx.repoRoot, rel);
  return readJsonStringField(ctx, path, 'version');
}

/** The manifest document without `buildId` (the `buildId` preimage object). */
function manifestWithoutBuildId(manifest: RuntimeContentManifestV2): Record<string, unknown> {
  const without: Record<string, unknown> = {};
  // The model's key order (one list; every key but buildId).
  const keys = MANIFEST_KEYS_V2.filter((k) => k !== 'buildId');
  for (const k of keys) without[k] = (manifest as unknown as Record<string, unknown>)[k];
  return without;
}