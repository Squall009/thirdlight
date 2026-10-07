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
 *   + every reachable asset as a relative `content/sha256/<digest>` artifact,
 *   copied from where the workspace found it and hashed while copied (the
 *   export never holds the assets together; its memory does not grow with them)
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
 * The output is written into a temp directory under the export root as it is
 * produced and renamed into place at the end. A failure leaves nothing: the
 * temp directory is removed and the previous output tree is byte-untouched. Source-bearing behaviors ship as separate
 * `behaviors/<outputDigest>.js` modules the bootstrap imports.
 */
import { DECODER_LICENSES, decoderFiles, decodersNeeded } from './decoders';
import { build, version as esbuildVersion } from 'esbuild';
import {
  canonicalJsonText,
  digestBytes,
  digestEmittedClosure,
  fixedStepHzOf,
  isScatterBlob,
  isTerrainTileBlob,
  manifestBuildIdInputV5,
  physicsDimensionOf,
  type RuntimeContentManifestV5,
} from '@thirdlight/project-model';

import { canonicalDocument } from './canonical';
import type { ContentClosureCompilerPort } from './content-closure';
import { buildContentClosureM3, type ContentClosureM3 } from './content-closure';
import { blockDataText } from './block-chunk-data';
import { buildM3Bundle, buildSimWorkerBundle, EXPORT_BUILD_OPTIONS, THREE_WEBGPU_ONLY_PLUGIN, type M2BundleResult } from './export-bundle';
import { assertRelativeClosure, scanAssetContainer, scanWasmContainer, textPatternCounts, type ScanPatterns } from './export-content-scan';
import { openStaging, resolveExportTarget, type ExportStaging } from './export-io';
import type { ExportContext } from './export-types';
import { clip, type ExportError, type ExportResult } from './errors';
import { checkBundleGraphM3 } from './graph';

const M3_SCHEMA_VERSION = 2;
const ENGINE_VERSION = '0.1.0';
const BUNDLE_NAME = 'js/main.js';
/** The simulation worker (runtime + physics + scripts off the page's main thread). */
const WORKER_BUNDLE_NAME = 'js/sim-worker.js';
/** The block mesh worker (block chunks meshed off the frame), shipped when the game has block layers. */
const MESH_WORKER_BUNDLE_NAME = 'js/mesh-worker.js';
/** The 2D physics backend (rapier2d), emitted only for a project on the 2D plane. */
const PHYSICS_2D_BUNDLE_NAME = 'js/physics-2d.js';
/** The 3D physics backend (rapier3d), emitted only for a project whose physics_dimension is 3. */
const PHYSICS_3D_BUNDLE_NAME = 'js/physics-3d.js';
/** The module that marks a 3D project's physics. */
const PHYSICS_3D_MODULE = 'thirdlight.physics-rapier:3d';
const SCENE_NAME = 'scene.json';
const MANIFEST_NAME = 'manifest.json';
const META_NAME = 'meta.json';

/** One script of the export: its path, entry, the module ids its graph may name, and what its build gave. */
interface ExportScript {
  name: string;
  entry: string;
  what: string;
  moduleIds?: readonly string[];
  built: M2BundleResult;
}

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

/** The installed package.json of a package a bundle linked (from its metafile). */
function linkedPackageJson(metafile: { inputs: Record<string, unknown> }, pkg: string): string | null {
  for (const key of Object.keys(metafile.inputs ?? {})) {
    const p = key.replace(/\\/g, '/');
    const i = p.lastIndexOf(`node_modules/${pkg}/`);
    if (i >= 0) return `${p.slice(0, i)}node_modules/${pkg}/package.json`;
  }
  return null;
}

/** Build one probe bundle (stdin entry, the export's options without a map: a probe has no file). */
async function probeBundle(ctx: ExportContext, contents: string, sourcefile: string): Promise<Uint8Array | null> {
  try {
    const r = await build({
      ...EXPORT_BUILD_OPTIONS,
      sourcemap: false,
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
    // The assets and instance buffers are found on disk and copied into the output one at a
    // time, each checked against its digest while it is copied: the export never holds them.
    locate: true,
    // Block-layer cells ship as gzip-compressed binary chunk data (the page decodes gzip natively).
    ...(ctx.gzip !== undefined ? { gzip: ctx.gzip } : {}),
    // Per-layer texture slots ship as arrays assembled now: the game runs without the backend.
    ...(ctx.textureSlots !== undefined ? { textureSlots: ctx.textureSlots } : {}),
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
      ...(e.missingFiles !== undefined ? { missingFiles: e.missingFiles } : {}),
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
  // The workers and the physics backend, each its own script next to the bootstrap's (same directory, same rules).
  const here = ctx.fs.join(m3BootstrapEntry, '..');
  const read = (path: string): Uint8Array => ctx.fs.read(path);
  // The view's worker (block chunks meshed, terrain tiles packed), for a game with block layers or terrain (a scene or a prefab names one);
  // without it chunks mesh and tiles pack on the page.
  const decoder = new TextDecoder();
  const hasBlockLayers = [closure.sceneBytes, ...closure.sceneArtifacts.map((a) => a.bytes), ...closure.contentFileArtifacts.map((a) => a.bytes)].some((b) => {
    const text = decoder.decode(b);
    return text.includes('"blockLayer"') || text.includes('"tileSamples"');
  });
  // Only the physics engine the project's dimension uses: a game on the 2D plane ships rapier2d, a 3D game with physics rapier3d.
  const threeD = closure.moduleIds.includes(PHYSICS_3D_MODULE);
  const twoD = physicsDimensionOf(closure.manifest.settings) === 2;
  const planned: { name: string; entry: string; what: string; moduleIds?: readonly string[]; wasm?: true }[] = [
    { name: WORKER_BUNDLE_NAME, entry: ctx.fs.join(here, 'export-sim-worker.ts'), what: 'simulation worker', moduleIds: closure.moduleIds },
    ...(hasBlockLayers ? [{ name: MESH_WORKER_BUNDLE_NAME, entry: ctx.fs.join(here, 'export-mesh-worker.ts'), what: 'block mesh and terrain worker' }] : []),
    ...(twoD ? [{ name: PHYSICS_2D_BUNDLE_NAME, entry: ctx.fs.join(here, 'export-physics-2d.ts'), what: '2D physics', wasm: true as const }] : []),
    ...(threeD ? [{ name: PHYSICS_3D_BUNDLE_NAME, entry: ctx.fs.join(here, 'export-physics-3d.ts'), what: '3D physics', wasm: true as const }] : []),
  ];
  const scripts: ExportScript[] = [{ name: BUNDLE_NAME, entry: m3BootstrapEntry, what: 'M3 export', moduleIds: closure.moduleIds, built }];
  for (const s of planned) {
    const r = await buildSimWorkerBundle(s.entry, s.moduleIds, { name: s.name, ...(s.wasm === true ? { read } : {}) });
    if (!r.ok) return fail('export_bundle_graph_forbidden', 'internal', `the ${s.what} bundle build failed (resolution/boundary defect)`, { modules: r.modules.slice(0, 8) });
    if (s.wasm === true && r.wasm === null) return fail('export_bundle_graph_forbidden', 'internal', `the ${s.what} bundle linked no physics WASM`);
    scripts.push({ ...s, built: r });
  }
  const rapier3dBytes = threeD ? await probeBundle(ctx, RAPIER_3D_PROBE_ENTRY, 'rapier3d-compat-probe.ts') : null;
  if (threeD && rapier3dBytes === null) {
    return fail('export_bundle_forbidden_content', 'internal', 'the pinned Rapier 3D compat probe could not be built (the 3D physics row fails closed)');
  }

  // The binding-3 reference build + the pinned Rapier compat probe.
  const referenceBytes = await probeBundle(ctx, REFERENCE_ENTRY, 'three-reference-entry.ts');
  const rapierBytes = await probeBundle(ctx, RAPIER_PROBE_ENTRY, 'rapier-compat-probe.ts');
  if (referenceBytes === null) {
    return fail('export_bundle_forbidden_content', 'internal', 'the reference three bundle could not be built (binding 3 fails closed)');
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

  for (const sc of scripts) {
    const graph = checkBundleGraphM3(sc.built.metafile, sc.entry, sc.moduleIds ?? []);
    if (!graph.ok) return fail('export_bundle_graph_forbidden', 'internal', `forbidden modules in the ${sc.what} bundle graph`, { modules: graph.forbidden.slice(0, 8) });
  }

  // ---- step 5a: the manifest self-identity + the closure rule ------------------

  const manifestBytes = closure.manifestBytes;
  const parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RuntimeContentManifestV5;
  const preimage = manifestBuildIdInputV5(parsedManifest as unknown as Record<string, unknown>);
  const recomputed = preimage === null ? null : digestBytes(preimage);
  if (recomputed !== parsedManifest.buildId || parsedManifest.buildId !== closure.buildId) {
    return fail('export_manifest_invalid', 'internal', 'the manifest buildId does not match its own canonical bytes');
  }
  const declaredManifestPaths = new Set<string>([...closure.assetFiles, ...closure.behaviorArtifacts, ...closure.libraryArtifacts, ...closure.sceneArtifacts, ...closure.bufferFiles, ...closure.bufferArtifacts, ...closure.streamedTextures.flatMap((t) => t.parts), ...closure.contentFileArtifacts].map((a) => a.path));
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
  // The block layers' chunk data is the scene files' cells: their text (cell metadata) follows the same rules.
  // Terrain tiles are numbers only (heights, layer weights, holes), checked by digest like instance buffers; so are
  // their scatter blobs (copies and cells; the rule ids they carry are the scene file's, scanned with it).
  for (const b of closure.bufferArtifacts) {
    if (isTerrainTileBlob(b.bytes) || isScatterBlob(b.bytes)) {
      if (digestBytes(b.bytes) !== b.digest) return fail('export_bundle_forbidden_content', 'internal', `terrain tile ${b.path} does not match its digest`);
      continue;
    }
    let text: string;
    try {
      text = blockDataText(b.bytes, ctx.gzip);
    } catch (e) {
      return fail('export_scene_invalid', 'internal', `block chunk data ${b.path} does not read back: ${e instanceof Error ? e.message : String(e)}`);
    }
    const c = textPatternCounts(text, patterns);
    if (c.a + c.b + c.c + c.e + c.g + c.i !== 0 || digestBytes(b.bytes) !== b.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in block chunk data ${b.path}`);
    }
  }
  // Every script and its source map: the forbidden patterns must be zero. This
  // gate, not an exact re-measurement of the recorded-exception counts, is the
  // binding security check here (minified code keeps every string and call).
  for (const sc of scripts) {
    for (const [file, bytes] of [[sc.name, sc.built.bytes], [`${sc.name}.map`, sc.built.map]] as const) {
      const c = textPatternCounts(new TextDecoder().decode(bytes), patterns);
      if (c.a + c.b + c.c + c.e + c.g + c.i !== 0) {
        return fail('export_bundle_forbidden_content', 'internal', `forbidden content in ${file} (a=${c.a} b=${c.b} c=${c.c} e=${c.e} g=${c.g} i=${c.i})`, { reason: `counts=${JSON.stringify(c)}` });
      }
    }
    if (sc.built.wasm !== null) {
      const w = scanWasmContainer(sc.built.wasm, digestBytes(sc.built.wasm));
      if (!w.ok) return fail('scan_forbidden_content', 'internal', `the ${sc.what} WASM fails container validation (${w.code})`);
    }
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

  // ---- step 6: the output tree, written as it is produced ----------------------

  const opened = openStaging(ctx.fs, exportRootReal);
  if (!opened.ok) return { ok: false, error: opened.error };
  const staging = opened.staging;
  try {
    const written = await writeOutput(ctx, staging, closure, patterns, {
      index: new TextEncoder().encode(INDEX_HTML),
      scripts,
      manifestBytes,
      parsedManifest,
      captured,
      now,
    });
    if (!written.ok) {
      staging.abort();
      return written;
    }
    const published = staging.publish(dirName);
    if (!published.ok) return { ok: false, error: published.error };
    return {
      ok: true,
      outputDir: dirName,
      snapshotId: closure.snapshotId,
      revision: captured.revision,
      files: { ...staging.files },
      scanHits: 0,
      schemaVersion: M3_SCHEMA_VERSION,
      buildId: closure.buildId,
      contentDigest: parsedManifest.contentDigest,
      outputDigest: written.outputDigest,
      ...(closure.checks.length > 0 ? { warnings: closure.checks.map((c) => ({ code: c.code, message: c.message })) } : {}),
    };
  } catch (e) {
    staging.abort();
    return fail('export_output_not_writable', 'unavailable', `the export output writes failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Why a located file could not be copied (it changed or went missing since the build found it). */
function copyFailure(path: string, detail: string): ExportResult {
  return fail('export_build_unavailable', 'unavailable', `a shipped file changed or went missing while it was copied (${path}): ${detail}`, { reason: 'asset_source_changed' });
}

/**
 * Write the whole output into the staging directory: the page, the bundles,
 * the manifest and scene, the compiled scripts, the scene files and the
 * catalog's files (each text scanned before it is written), then every asset
 * and instance buffer copied from where the workspace found it — one file at
 * a time, hashed while copied (a file whose bytes are no longer the recorded
 * ones fails the export) and checked by its container format — then the
 * decoders the shipped files need and meta.json.
 */
async function writeOutput(
  ctx: ExportContext,
  staging: ExportStaging,
  closure: ContentClosureM3,
  patterns: ScanPatterns,
  parts: {
    index: Uint8Array;
    scripts: readonly ExportScript[];
    manifestBytes: Uint8Array;
    parsedManifest: RuntimeContentManifestV5;
    captured: { scene: unknown; revision: number };
    now: () => number;
  },
): Promise<ExportResult | { ok: true; outputDigest: string }> {
  const entries: { path: string; digest: string; byteLength: number }[] = [];
  const put = (name: string, bytes: Uint8Array, digest?: string): void => {
    staging.write(name, bytes);
    entries.push({ path: name, digest: digest ?? digestBytes(bytes), byteLength: bytes.length });
  };
  put('index.html', parts.index);
  // Each script, its source map and the WASM it fetches, side by side.
  for (const sc of parts.scripts) {
    put(sc.name, sc.built.bytes);
    put(`${sc.name}.map`, sc.built.map);
    if (sc.built.wasm !== null) put(sc.name.replace(/\.js$/, '.wasm'), sc.built.wasm);
  }
  put(MANIFEST_NAME, parts.manifestBytes);
  put(SCENE_NAME, closure.sceneBytes, closure.sceneDigest);
  for (const a of [...closure.behaviorArtifacts, ...closure.libraryArtifacts, ...closure.sceneArtifacts, ...closure.bufferArtifacts]) put(a.path, a.bytes, a.digest);
  // The catalog's files are JSON text (the rules manifest.json's text has), scanned one at a time.
  for (const f of closure.contentFileArtifacts) {
    const text = new TextDecoder().decode(f.bytes);
    const c = textPatternCounts(text, patterns);
    if (c.a + c.b + c.c + c.e + c.g + c.i !== 0 || digestBytes(f.bytes) !== f.digest) {
      return fail('export_bundle_forbidden_content', 'internal', `forbidden content in manifest content file ${f.path}`);
    }
    const relative = assertRelativeClosure([{ name: f.path, text }], patterns);
    if (!relative.ok) return fail('scan_forbidden_content', 'internal', 'an emitted text artifact contains an absolute/remote reference', { hits: relative.hits.slice(0, 4) });
    put(f.path, f.bytes, f.digest);
  }

  // The assets and instance buffers, copied from disk. One file is held at a time (its
  // container check needs the whole file); what it needs of the decoders is read from it.
  const decoders = new Set<'draco' | 'basis'>();
  let assetBytes = 0;
  const assetPaths = new Set(closure.assetFiles.map((a) => a.path));
  for (const a of [...closure.assetFiles, ...closure.bufferFiles]) {
    if (staging.files[a.path] !== undefined) continue; // the same bytes named twice (an asset and a buffer)
    const isAsset = assetPaths.has(a.path);
    const opened = ctx.service.openBlobFile(ctx.projectId, a.file);
    if (!opened.ok) return copyFailure(a.path, opened.error.code);
    const held: Uint8Array[] = [];
    // A buffer keeps only its first bytes: a terrain tile or its scatter says so in its header (an instance buffer has none).
    let head: Uint8Array | null = null;
    let n: number;
    try {
      n = await staging.writeChunks(a.path, opened.blob.chunks(), isAsset ? (chunk) => held.push(chunk) : (chunk) => void (head ??= chunk.slice(0, 16)));
    } catch (e) {
      opened.blob.close();
      return copyFailure(a.path, e instanceof Error ? e.message : String(e));
    }
    if (n !== a.byteLength) return copyFailure(a.path, `${n} bytes, the build found ${a.byteLength}`);
    if (isAsset) {
      const bytes = held.length === 1 ? held[0]! : concat(held, n);
      const container = scanAssetContainer(a.contentType, bytes);
      if (!container.ok) {
        return fail('scan_forbidden_content', 'internal', `a declared asset artifact fails container validation (${container.code})`, {
          hits: [{ pattern: container.code, byteOffset: container.offset ?? -1, context: a.path }],
        });
      }
      for (const d of decodersNeeded([{ bytes, contentType: a.contentType }])) decoders.add(d);
      assetBytes += n;
    } else if (n % 40 !== 0 && (head === null || !(isTerrainTileBlob(head) || isScatterBlob(head)))) {
      return fail('scan_forbidden_content', 'internal', `an instance buffer does not match its size (${a.path})`);
    }
    entries.push({ path: a.path, digest: a.digest, byteLength: n });
  }

  // A streamed texture's parts, copied from disk in file order; together they are
  // its KTX2, checked as one container (a part alone is not a file of any format).
  for (const t of closure.streamedTextures) {
    const held: Uint8Array[] = [];
    let total = 0;
    for (const p of t.parts) {
      const opened = ctx.service.openBlobFile(ctx.projectId, p.file);
      if (!opened.ok) return copyFailure(p.path, opened.error.code);
      const chunks: Uint8Array[] = [];
      let n: number;
      try {
        n = staging.files[p.path] !== undefined ? await drain(opened.blob.chunks(), (chunk) => chunks.push(chunk)) : await staging.writeChunks(p.path, opened.blob.chunks(), (chunk) => chunks.push(chunk));
      } catch (e) {
        opened.blob.close();
        return copyFailure(p.path, e instanceof Error ? e.message : String(e));
      }
      if (n !== p.byteLength) return copyFailure(p.path, `${n} bytes, the build found ${p.byteLength}`);
      held.push(...chunks);
      total += n;
      if (!entries.some((e) => e.path === p.path)) entries.push({ path: p.path, digest: p.digest, byteLength: n });
    }
    const whole = concat(held, total);
    const container = scanAssetContainer('image/x-texture', whole);
    if (!container.ok) {
      return fail('scan_forbidden_content', 'internal', `a declared asset artifact fails container validation (${container.code})`, {
        hits: [{ pattern: container.code, byteOffset: container.offset ?? -1, context: `${t.assetId} (streamed parts)` }],
      });
    }
    decoders.add('basis');
    assetBytes += total;
  }

  // three's Draco/Basis decoders ship only when a shipped file needs them.
  const needed = [...decoders].sort();
  const threeDir = ctx.fs.join(ctx.threePackageJson, '..');
  for (const f of decoderFiles(needed, threeDir, (p) => ctx.fs.read(p), (...p) => ctx.fs.join(...p))) put(f.path, f.bytes);

  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const outputDigest = digestEmittedClosure(entries);
  const parsedManifest = parts.parsedManifest;
  const behaviorBytes = closure.behaviorArtifacts.reduce((sum, b) => sum + b.bytes.length, 0);
  const licenses = [
    installedPackage(ctx, ctx.threePackageJson, 'three'),
    installedPackage(ctx, ctx.typescriptPackageJson, 'typescript'),
    { id: 'esbuild', version: esbuildVersion, license: 'MIT', source: 'npm' },
    // The physics engine shipped (the version its bundle linked).
    ...parts.scripts.flatMap((sc) => RAPIER_PACKAGES.filter((pkg) => linkedPackageJson(sc.built.metafile, pkg) !== null).map((pkg) => ({ id: pkg, version: linkedVersion(ctx, sc.built.metafile, pkg), license: 'Apache-2.0', source: 'npm' }))),
    ...needed.map((d) => ({ id: DECODER_LICENSES[d].id, version: readJsonStringField(ctx, ctx.threePackageJson, 'version'), license: DECODER_LICENSES[d].license, source: 'npm' })),
  ].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const sceneEntities = (parts.captured.scene as { entities?: unknown[] })?.entities ?? [];
  const meta = {
    schemaVersion: M3_SCHEMA_VERSION,
    type: 'thirdlight-export',
    engineVersion: ENGINE_VERSION,
    projectId: ctx.projectId,
    snapshotId: closure.snapshotId,
    revision: parts.captured.revision,
    exportedAt: utcSeconds(parts.now()),
    dependencies: {
      three: readJsonStringField(ctx, ctx.threePackageJson, 'version'),
      typescript: readJsonStringField(ctx, ctx.typescriptPackageJson, 'version'),
      esbuild: esbuildVersion,
      // The project's step rate (the fixed_step_hz setting, else the default).
      runtime: { fixedStepHz: fixedStepHzOf(parsedManifest.settings), modules: [...closure.moduleIds] },
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
      assets: { count: closure.assetFiles.length, bytes: assetBytes },
      behaviors: { count: closure.behaviorArtifacts.length, bytes: behaviorBytes },
      total: { count: closure.assetFiles.length + closure.behaviorArtifacts.length, bytes: assetBytes + behaviorBytes },
    },
    outputDigest,
  };
  staging.write(META_NAME, canonicalDocument(meta));
  return { ok: true, outputDigest };
}

function concat(parts: readonly Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The physics engines a bundle may link (each one's license row ships with it). */
const RAPIER_PACKAGES = ['@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat'] as const;

/** The version of a package a bundle linked ('' when unknown): the physics-rapier package's own pin. */
function linkedVersion(ctx: ExportContext, metafile: { inputs: Record<string, unknown> }, pkg: string): string {
  const rel = linkedPackageJson(metafile, pkg);
  if (rel === null) return '';
  const path = rel.startsWith('/') ? rel : ctx.fs.join(ctx.repoRoot, rel);
  return readJsonStringField(ctx, path, 'version');
}

/** Read a blob's chunks without writing them (a part two textures share, already staged). */
async function drain(chunks: AsyncIterable<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<number> {
  let n = 0;
  for await (const c of chunks) {
    onChunk(c);
    n += c.length;
  }
  return n;
}
