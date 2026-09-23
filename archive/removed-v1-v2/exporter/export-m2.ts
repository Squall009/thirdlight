/**
 * `exportProjectM2` — the M2 standalone content/gameplay export pipeline
 * (packet 36; export.md §2–§7, sessions.md §17.1/§17.5, dependencies.md §4.2).
 *
 * Composes the complete M2 closure from ONE captured authoring state through
 * the INJECTED workspace service + packet-33 compiler:
 *
 *   shared runtime + input + platformer + physics-rapier + three-adapter/GLTFLoader
 *   + the compiled behavior outputs (static bundle inputs)
 *   + every reachable asset as a relative `content/sha256/<digest>` artifact
 *   + the canonical manifest + scene document + `meta.json` v2
 *
 * and validates it (export.md §4 steps 1–6, 5a/5b/5c):
 * scene/snapshot validity, the revision re-read, the output-target rule, the
 * exact M2 bundle graph, the format-aware scans (GLB container, JS text with
 * the §5.4.1 counts, relative closure), the manifest self-identity
 * (`buildId` recomputation), the closure rule (every declared artifact present
 * and every present artifact declared) and the atomic publication.
 *
 * A failure writes nothing: the temp directory is removed and the previous
 * output tree is byte-untouched.
 */
import { build, version as esbuildVersion } from 'esbuild';
import {
  canonicalJsonText,
  digestBytes,
  digestEmittedClosure,
  sha256HexOfText,
  validateSceneV2,
  type RuntimeContentManifest,
} from '@thirdlight/project-model';

import { canonicalDocument } from './canonical';
import type { ContentClosureCompilerPort } from './content-closure';
import { buildContentClosure, type ContentClosure } from './content-closure';
import { BEHAVIOR_TRUST_NOTICE_TEXT } from './export-page';
import { buildM2Bundle, PINNED_OPTIONS } from './export-bundle';
import { assertRelativeClosure, scanGlbContainer, scanM2TextBundle, type ScanPatterns } from './export-content-scan';
import { publishTree, resolveExportTarget, type TreeFile } from './export-io';
import type { ExportContext } from './export-types';
import { clip, type ExportError, type ExportResult } from './errors';
import { checkBundleGraphM2 } from './graph';
import { readCapturedScene } from './scene-read';

/** M2 `meta.json.schemaVersion` (export.md §6). */
const M2_SCHEMA_VERSION = 2;
const ENGINE_VERSION = '0.1.0';
const BUNDLE_NAME = 'js/main.js';
const SCENE_NAME = 'scene.json';
const MANIFEST_NAME = 'manifest.json';
const META_NAME = 'meta.json';

/**
 * The minimal M2 export page (export.md §3): `<canvas id="game">` + the
 * relative module script + the HUD line. The trust notice panel is injected by
 * the bootstrap before it starts when the manifest declares behaviors
 * (export.md §6).
 */
const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Thirdlight Export</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0e1015; }
      #game { width: 100vw; height: 100vh; display: block; }
      #hud { position: fixed; top: 8px; left: 8px; font: 12px/1.4 system-ui, sans-serif; color: #9aa4b2; }
      #hud.error { color: #f87171; }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <div id="hud">loading</div>
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
      version: typeof obj['version'] === 'string' ? obj['version'] : '',
      license: typeof obj['license'] === 'string' ? obj['license'] : 'private',
      source: 'npm',
    };
  } catch {
    return { id, version: '', license: 'unknown', source: 'npm' };
  }
}

/** The §5.4.1 binding 3 reference full-core three entry (unchanged from M1). */
const REFERENCE_ENTRY = "import * as THREE from 'three'; console.log(THREE.REVISION);";

/** The pinned Rapier compat probe entry (re-measures the physics row). */
const RAPIER_PROBE_ENTRY = "import { createPhysicsPort } from '@thirdlight/physics-rapier'; console.log(typeof createPhysicsPort);";

interface Counts {
  fetch: number;
  process: number;
  http: number;
  https: number;
  xhr: number;
  ws: number;
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

function countsOf(text: string): Counts {
  return {
    fetch: countOccurrences(text, 'fetch('),
    process: countOccurrences(text, 'process.'),
    http: countOccurrences(text, 'http://'),
    https: countOccurrences(text, 'https://'),
    xhr: countOccurrences(text, 'XMLHttpRequest'),
    ws: countOccurrences(text, 'WebSocket'),
  };
}

/** Build one probe bundle (stdin entry, pinned §5.3 options). */
async function probeBundle(ctx: ExportContext, contents: string, sourcefile: string): Promise<Uint8Array | null> {
  try {
    const r = await build({
      ...PINNED_OPTIONS,
      stdin: { contents, resolveDir: ctx.repoRoot, sourcefile },
      write: false,
    });
    return r.outputFiles?.[0]?.contents ?? null;
  } catch {
    return null;
  }
}

/**
 * The M2 pipeline. `capturedView` is the ONE content-view read taken by the
 * dispatcher (the injected captured snapshot); every other read goes through
 * the injected workspace service.
 */
export async function exportProjectM2(
  ctx: ExportContext,
  capturedView: { assets: readonly { assetId: string; version: number; sourceDigest: string; sourceByteLength: number; importRecipe: unknown }[]; contentDigest: string },
  m2BootstrapEntry: string,
  compiler: ContentClosureCompilerPort,
): Promise<ExportResult> {
  // ---- step 1: the captured scene validates (project-model §12/§18) ------------

  const read = readCapturedScene(ctx);
  if (!read.ok) return { ok: false, error: read.error };
  const { entities, revision, sceneId, cameraId } = read.captured;
  const sceneDoc = { schemaVersion: 2, sceneId, revision, entities } as unknown as {
    schemaVersion: number;
    sceneId: string;
    revision: number;
    entities: ReadonlyArray<Record<string, unknown>>;
  };
  const sceneCheck = validateSceneV2(sceneDoc);
  if (!sceneCheck.ok) {
    return fail('export_scene_invalid', 'validation', 'the v2 scene document fails validation', {
      errors: sceneCheck.errors.slice(0, 10),
      errorTotal: sceneCheck.errors.length,
    });
  }
  // The emitted scene document is the digest input of `manifest.sceneDigest`
  // (sessions.md §17.1.1: SHA-256 of the canonical scene bytes). It is written
  // verbatim so the exported page can verify it; the raw captured entities are
  // used so the digest matches the play path's capture of the same revision.
  const sceneBytes = new TextEncoder().encode(canonicalJsonText(sceneDoc));
  const sceneDigest = digestBytes(sceneBytes);

  // ---- the shared closure (manifest + declared artifact bytes) -----------------

  const now = ctx.now ?? (() => Date.now());
  const capturedAt = utcSeconds(now());
  const closureResult = await buildContentClosure({
    service: ctx.service,
    compiler,
    projectId: ctx.projectId,
    revision,
    capturedAt,
    demo: false,
    scene: sceneDoc,
    capturedView: { assets: capturedView.assets, contentDigest: capturedView.contentDigest },
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
  const closure: ContentClosure = closureResult.closure;
  if (sceneDigest !== closure.manifest.sceneDigest) {
    return fail('export_manifest_invalid', 'internal', 'the derived sceneDigest does not match the emitted scene document digest');
  }

  // ---- the M2 bundle build (between steps 1 and 2) ----------------------------

  if (ctx.m2BootstrapEntry !== undefined) void ctx.m2BootstrapEntry;
  const built = await buildM2Bundle({ bootstrapEntry: m2BootstrapEntry, closure });
  if (!built.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'the M2 export bundle build failed (resolution/boundary defect)', {
      modules: built.modules.slice(0, 8),
    });
  }

  // The §5.4.1 binding 3 reference build + the pinned Rapier compat probe
  // (re-measured against the current install before the real bundle is judged).
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
  if (reRead.revision !== revision) {
    return fail('export_snapshot_mismatch', 'conflict', 'the authoring revision advanced during the export — re-export', {
      frozenRevision: revision,
      currentRevision: reRead.revision,
    });
  }

  // ---- step 3: the output target ----------------------------------------------

  const resolved = resolveExportTarget(ctx, revision);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { exportRootReal, dirName } = resolved;

  // ---- step 4: the exact M2 bundle import graph --------------------------------

  const graph = checkBundleGraphM2(built.metafile, m2BootstrapEntry);
  if (!graph.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the M2 export bundle graph', {
      modules: graph.forbidden.slice(0, 8),
    });
  }

  // ---- step 5a: the manifest self-identity + the closure rule ------------------

  const manifestBytes = closure.manifestBytes;
  const parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RuntimeContentManifest;
  const recomputed = sha256HexOfText(`${JSON.stringify(manifestWithoutBuildId(parsedManifest), null, 2)}\n`);
  if (recomputed !== parsedManifest.buildId || parsedManifest.buildId !== closure.buildId) {
    return fail('export_manifest_invalid', 'internal', 'the manifest buildId does not match its own canonical bytes');
  }
  const declaredManifestPaths = new Set<string>([
    ...closure.assetArtifacts.map((a) => a.path),
    ...closure.behaviorArtifacts.map((a) => a.path),
  ]);
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
    const glb = scanGlbContainer(asset.bytes);
    if (!glb.ok) {
      return fail('scan_forbidden_content', 'internal', `a declared asset artifact fails GLB container validation (${glb.code})`, {
        hits: [{ pattern: glb.code, byteOffset: glb.offset ?? -1, context: `content/sha256/${asset.digest}` }],
      });
    }
    if (digestBytes(asset.bytes) !== asset.digest) {
      return fail('scan_forbidden_content', 'internal', `the emitted asset artifact bytes do not match its digest (${asset.path})`);
    }
  }
  for (const behavior of closure.behaviorArtifacts) {
    if (digestBytes(behavior.bytes) !== behavior.digest) {
      return fail('scan_forbidden_content', 'internal', `the emitted behavior artifact bytes do not match its digest (${behavior.path})`);
    }
  }
  const bundleText = new TextDecoder().decode(built.bytes);
  const textScan = scanM2TextBundle({
    bundleText,
    patterns,
    referenceText: new TextDecoder().decode(referenceBytes),
    threeIdentity: { version: readJsonStringField(ctx, ctx.threePackageJson, 'version'), integrity: readLockfileIntegrity(ctx) },
    rapierCounts: countsOf(new TextDecoder().decode(rapierBytes)),
    declaredAssetPaths: closure.assetArtifacts.map((a) => a.path),
    declaredExtraFetches: 1,
    engineOwnText: BEHAVIOR_TRUST_NOTICE_TEXT,
    gltfLoader: closure.moduleIds.includes('thirdlight.three-adapter:gltf-loader'),
  });
  if (!textScan.ok) {
    return fail(
      'export_bundle_forbidden_content',
      'internal',
      `forbidden content in the M2 export bundle (${textScan.scanHits} hit(s) outside the recorded-exception scope)`,
      {
        hits: textScan.hits.slice(0, 4),
        reason: `counts=${JSON.stringify(textScan.counts)} expected=${JSON.stringify(textScan.expected)}${textScan.binding.reason !== undefined ? ` binding=${textScan.binding.reason}` : ''}`,
      },
    );
  }
  const textFiles = [
    { name: 'index.html', text: INDEX_HTML },
    { name: MANIFEST_NAME, text: new TextDecoder().decode(manifestBytes) },
    { name: SCENE_NAME, text: new TextDecoder().decode(sceneBytes) },
  ];
  const relative = assertRelativeClosure(textFiles, patterns);
  if (!relative.ok) {
    return fail('scan_forbidden_content', 'internal', 'an emitted text artifact contains an absolute/remote reference', {
      hits: relative.hits.slice(0, 4),
    });
  }

  // ---- the output tree + meta.json v2 -----------------------------------------

  const indexBytes = new TextEncoder().encode(INDEX_HTML);
  const behaviorRows = closure.behaviors.map((b) => ({
    behaviorId: b.behaviorId,
    sourceDigest: b.sourceDigest,
    sourceByteLength: b.sourceByteLength,
    manifestDigest: b.manifestDigest,
    outputDigest: b.outputDigest,
    outputByteLength: b.outputByteLength,
    apiVersion: b.apiVersion,
    enginePins: (closure.manifest.enginePins as ReadonlyArray<Record<string, unknown>>).map((p) => ({ ...p })),
  }));
  const assetBytes = closure.assetArtifacts.reduce((n, a) => n + a.bytes.length, 0);
  const behaviorBytes = closure.behaviorArtifacts.reduce((n, a) => n + a.bytes.length, 0);

  // Every emitted file except meta.json contributes to `outputDigest`
  // (meta.json carries `exportedAt` and the digest itself).
  const closureEntries = [
    { path: 'index.html', digest: digestBytes(indexBytes), byteLength: indexBytes.length },
    { path: BUNDLE_NAME, digest: digestBytes(built.bytes), byteLength: built.bytes.length },
    { path: MANIFEST_NAME, digest: digestBytes(manifestBytes), byteLength: manifestBytes.length },
    { path: SCENE_NAME, digest: sceneDigest, byteLength: sceneBytes.length },
    ...closure.assetArtifacts.map((a) => ({ path: a.path, digest: a.digest, byteLength: a.bytes.length })),
    ...closure.behaviorArtifacts.map((a) => ({ path: a.path, digest: a.digest, byteLength: a.bytes.length })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outputDigest = digestEmittedClosure(closureEntries);

  const licenses = [
    installedPackage(ctx, ctx.threePackageJson, 'three'),
    installedPackage(ctx, ctx.typescriptPackageJson, 'typescript'),
    { id: 'esbuild', version: esbuildVersion, license: 'MIT', source: 'npm' },
    { id: '@dimforge/rapier2d-compat', version: readJsonStringField(ctx, ctx.fs.join(ctx.repoRoot, 'node_modules/@dimforge/rapier2d-compat/package.json'), 'version'), license: 'Apache-2.0', source: 'npm' },
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const meta = {
    schemaVersion: M2_SCHEMA_VERSION,
    type: 'thirdlight-export',
    engineVersion: ENGINE_VERSION,
    projectId: ctx.projectId,
    snapshotId: closure.snapshotId,
    revision,
    exportedAt: utcSeconds(now()),
    dependencies: {
      three: readJsonStringField(ctx, ctx.threePackageJson, 'version'),
      typescript: readJsonStringField(ctx, ctx.typescriptPackageJson, 'version'),
      esbuild: esbuildVersion,
      runtime: { fixedStepHz: 120, modules: [...closure.moduleIds] },
    },
    scene: {
      entityCount: entities.length,
      cameraId,
      boxCount: entities.filter((e) => e.components.box !== undefined).length,
    },
    behaviors: behaviorRows,
    behaviorTrust: { acknowledgedSourceDigests: closure.behaviors.map((b) => b.sourceDigest).sort() },
    manifest: {
      manifestVersion: parsedManifest.manifestVersion,
      snapshotId: parsedManifest.snapshotId,
      revision: parsedManifest.revision,
      contentDigest: parsedManifest.contentDigest,
      buildId: parsedManifest.buildId,
      buildOptionsDigest: parsedManifest.buildOptionsDigest,
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
    { name: SCENE_NAME, bytes: sceneBytes },
    ...closure.assetArtifacts.map((a) => ({ name: a.path, bytes: a.bytes })),
    ...closure.behaviorArtifacts.map((a) => ({ name: a.path, bytes: a.bytes })),
    { name: META_NAME, bytes: metaBytes },
  ];

  // ---- step 6: atomic publication ---------------------------------------------

  const published = publishTree(ctx.fs, exportRootReal, dirName, files);
  if (!published.ok) return { ok: false, error: published.error };

  return {
    ok: true,
    outputDir: dirName,
    snapshotId: closure.snapshotId,
    revision,
    files: published.files,
    scanHits: 0,
    schemaVersion: M2_SCHEMA_VERSION,
    buildId: closure.buildId,
    contentDigest: parsedManifest.contentDigest,
    outputDigest,
  };
}

/** The manifest document without `buildId` (the `buildId` preimage object). */
function manifestWithoutBuildId(manifest: RuntimeContentManifest): Record<string, unknown> {
  const without: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'buildId') continue;
    without[k] = v;
  }
  return without;
}

