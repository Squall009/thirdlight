/**
 * `exportProject(ctx)` — the M1 standalone export pipeline (export.md §2/§3/§4).
 *
 * Reads the current authoring state through the INJECTED workspace service
 * (never touches the authoring files itself, never opens a second authority),
 * constructs + re-validates the runtime snapshot (runtime.md §2), freezes it,
 * builds the export bundle (the SAME runtime as play mode — export.md §5.1,
 * pinned esbuild options §5.3), then runs the validation pipeline in order
 * (§4 steps 1–6: scene/snapshot validity, revision re-read, output path,
 * bundle graph, forbidden-content scan, output writes) before atomically
 * replacing the target tree. Any failure ⇒ a structured error, the temp
 * directory is removed, and the previous output (if any) is untouched.
 *
 * Pure Node, no Node-builtin imports (dependencies.md §4.1: the exporter's
 * `node` edge is empty) — ALL filesystem/path I/O goes through the injected
 * `ExportFs` facade (the backend, which is allowed `node:fs`/`node:path`,
 * supplies it). `esbuild` is the one external runtime dependency (§7) and
 * returns the built bytes in memory (`write: false`), so the scan runs over
 * in-memory bytes.
 */

import { build, version as esbuildVersion } from 'esbuild';
import { validateScene, type ModelError, type Scene } from '@thirdlight/project-model';
import type { Entity, WorkspaceService } from '@thirdlight/workspace';

import { canonicalDocument } from './canonical';
import {
  clip,
  type ExportError,
  type ExportErrorCode,
  type ExportErrorClass,
  type ExportResult,
} from './errors';
import { checkBundleGraph } from './graph';
import { publishTree, resolveExportTarget } from './export-io';
import { exportProjectM2 } from './export-m2';
import { exportProjectM3 } from './export-m3';
import { readCapturedScene } from './scene-read';
import type { ExportContext, ExportFs } from './export-types';
import { scanExportFiles, type ScanFile } from './scan';

// ---- public types (dependencies.md §3: `exportProject(ctx) → result`) ----------

export type { ExportContext, ExportFs } from './export-types';

// ---- constants ------------------------------------------------------------------

/** export.md §5.3 — the pinned esbuild 0.28.2 option set (normative). */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
} as const;

/**
 * export.md §5.4.1 binding 3 — the reference full-core three bundle entry,
 * built with the same pinned option set to re-verify the recorded-exception
 * table against the current install.
 *
 * The contract's entry is the full-core import of `three`. Under the pinned
 * esbuild 0.28.2 (IIFE output), a BARE `import * as THREE from 'three';` with
 * the namespace unused is elided to a 15-byte empty IIFE (verified
 * 2026-09-18) — so the namespace is referenced (`console.log(THREE.REVISION)`)
 * to materialize the full-core bundle the binding describes. Recorded
 * 2026-09-18: the emitted bundle is 1,777,839 bytes and re-scans to EXACTLY
 * the table's counts (fetch( 3, process. 3, http:// 3, https:// 23,
 * XMLHttpRequest 3; file:///WebSocket/__dirname/node:/api/v1///mcp 0) —
 * consistent with the contract's re-measurement note (its 1,777,857-byte
 * figure; the TABLE counts are the binding record).
 */
const REFERENCE_ENTRY = "import * as THREE from 'three'; console.log(THREE.REVISION);";

/** The M1 export's fixed demonstration module (export.md §5.1). */
const DEMO_MODULE = 'thirdlight.demo:box-motion';

/** meta.json `engineVersion` (the M1 baseline — project-model §6/§7). */
const ENGINE_VERSION = '0.1.0';

/**
 * The minimal export page (export.md §3): `<canvas id="game">` + the relative
 * module script + a small HUD line for the snapshotId and renderer backend
 * (filled at RUNTIME by the bundle — §7: no dynamic build-time content).
 * Relative references only (no absolute paths, no http(s)://, no file://).
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

const BUNDLE_NAME = 'js/main.js';

// ---- helpers ----------------------------------------------------------------------

function fail(code: ExportErrorCode, cls: ExportErrorClass, message: string, detail?: ExportError['detail']): ExportResult {
  return { ok: false, error: { code, cls, message: clip(message), detail } };
}

function clipErrors(errors: readonly ModelError[], total: number): NonNullable<ExportError['detail']> {
  return { errors: errors.slice(0, 10), errorTotal: total };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[k]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The UTC second at completion (project-model §7.2 format). */
function utcSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readJsonStringField(fs: ExportFs, path: string, field: string): string | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(fs.read(path))) as Record<string, unknown>;
    return typeof obj[field] === 'string' ? (obj[field] as string) : null;
  } catch {
    return null;
  }
}

/** The recorded registry integrity of `node_modules/three` in the lockfile. */
function readLockfileIntegrity(fs: ExportFs, lockfile: string): string | null {
  try {
    const lock = JSON.parse(new TextDecoder().decode(fs.read(lockfile))) as {
      packages?: Record<string, { integrity?: string }>;
    };
    const three = lock.packages?.['node_modules/three'];
    return three !== undefined && typeof three.integrity === 'string' ? three.integrity : null;
  } catch {
    return null;
  }
}

/** The runtime.md §2 boundary re-validation of the CONSTRUCTED snapshot. */
function revalidateSnapshot(snap: unknown): string | null {
  if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) return 'snapshot must be an object';
  const s = snap as Record<string, unknown>;
  const keys = Object.keys(s);
  const expected = new Set(['snapshotId', 'projectId', 'revision', 'scene']);
  for (const k of keys) {
    if (!expected.has(k)) return `unknown snapshot field "${k}" (strict shape)`;
  }
  for (const k of expected) {
    if (!(k in s)) return `snapshot field "${k}" is missing`;
  }
  const { snapshotId, projectId, revision, scene } = s as { snapshotId: unknown; projectId: unknown; revision: unknown; scene: unknown };
  if (typeof snapshotId !== 'string' || typeof projectId !== 'string' || projectId.length === 0) return 'snapshotId/projectId must be non-empty strings';
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return 'revision must be a non-negative integer';
  if (snapshotId !== `${projectId}@r${revision}`) return 'snapshotId must equal <projectId>@r<revision>';
  if (typeof scene !== 'object' || scene === null || Array.isArray(scene)) return 'scene must be a scene document';
  const sc = scene as Partial<Scene>;
  if (typeof sc.revision !== 'number' || sc.revision !== revision) return 'scene.revision must equal the snapshot revision';
  return null;
}

// ---- the pipeline -----------------------------------------------------------------

/**
 * The M1 pipeline (storageVersion 1 / schemaVersion 1 projects) — unchanged
 * from packet 12 except for the extracted shared target/publication helpers.
 */
export async function exportProjectM1(ctx: ExportContext): Promise<ExportResult> {
  // ---- step 1: the project loads and the scene/snapshot validate --------------

  const read = readCapturedScene(ctx);
  if (!read.ok) return { ok: false, error: read.error };
  const { entities, revision: frozenRevision, manifest } = read.captured;

  // Reconstruct the scene document (project-model §8 canonical order) and
  // validate/normalize it (project-model §12).
  const sceneDoc: Scene = { schemaVersion: 1, sceneId: read.captured.sceneId, revision: frozenRevision, entities };
  const vres = validateScene(sceneDoc);
  if (!vres.ok) {
    return fail('export_scene_invalid', 'validation', 'the scene document fails validation', clipErrors(vres.errors, vres.errors.length));
  }
  const normalizedScene = vres.normalized;

  // Construct + re-validate the runtime snapshot (runtime.md §2 boundary),
  // then FREEZE it for the whole export. (The authoritative runtime
  // re-validation also runs at export-page load — the page's bootstrap
  // `instantiateRuntime` on `./snapshot.json`.)
  const snapshot = deepFreeze({
    snapshotId: `${ctx.projectId}@r${frozenRevision}`,
    projectId: ctx.projectId,
    revision: frozenRevision,
    scene: normalizedScene,
  });
  const snapshotProblem = revalidateSnapshot(snapshot);
  if (snapshotProblem !== null) {
    return fail('export_scene_invalid', 'validation', `constructed snapshot fails the runtime.md §2 boundary: ${snapshotProblem}`);
  }

  // ---- bundle build (between steps 1 and 2; defects surface at 4/5) -----------

  let mainBytes: Uint8Array | null = null;
  let metafile: { inputs: Record<string, unknown> } | null = null;
  let buildError: string[] | null = null;
  try {
    const r = await build({ ...PINNED_OPTIONS, entryPoints: [ctx.bootstrapEntry], write: false, metafile: true });
    mainBytes = r.outputFiles?.[0]?.contents ?? null;
    metafile = (r.metafile as { inputs: Record<string, unknown> } | undefined) ?? null;
  } catch (e) {
    // A build failure is a build/boundary defect (export.md §4: its defects
    // surface at steps 4/5): report it as a forbidden-graph result with the
    // offending module names (≤ 8) extracted from the esbuild messages.
    const names: string[] = [];
    const failure = e as { errors?: Array<{ id?: string; location?: { file?: string }; text?: string }> };
    for (const er of failure?.errors ?? []) {
      const name = er.id ?? er.location?.file ?? er.text ?? '';
      if (name !== '' && !names.includes(name)) names.push(name);
      if (names.length >= 8) break;
    }
    if (names.length === 0) names.push(e instanceof Error ? e.message : String(e));
    buildError = names;
  }
  if (mainBytes === null || mainBytes.length === 0 || metafile === null) {
    return fail(
      'export_bundle_graph_forbidden',
      'internal',
      'the export bundle build failed (resolution/boundary defect)',
      { modules: (buildError ?? ['(no module names)']).slice(0, 8) },
    );
  }

  // The §5.4.1 binding 3 reference build (same pinned options; the exact
  // contract entry) — re-verifies the recorded table before the real bundle
  // is judged. A failed reference build fails the binding closed.
  let referenceBytes: Uint8Array | null = null;
  try {
    const ref = await build({
      ...PINNED_OPTIONS,
      stdin: { contents: REFERENCE_ENTRY, resolveDir: ctx.repoRoot, sourcefile: 'three-reference-entry.ts' },
      write: false,
    });
    referenceBytes = ref.outputFiles?.[0]?.contents ?? null;
  } catch {
    referenceBytes = null;
  }

  // ---- step 2: the authoring revision is unchanged ------------------------------

  const qp2 = ctx.service.query({ op: 'queryProject', projectId: ctx.projectId });
  if (qp2.ok === false) {
    return fail('export_scene_invalid', 'validation', `the project no longer loads after the build: ${qp2.error.message}`, {
      errors: [qp2.error],
      errorTotal: 1,
    });
  }
  if (!('manifest' in qp2)) {
    return fail('export_scene_invalid', 'validation', 'inconsistent queryProject result (re-read)');
  }
  if (qp2.revision !== frozenRevision) {
    return fail('export_snapshot_mismatch', 'conflict', 'the authoring revision advanced during the export — re-export', {
      frozenRevision,
      currentRevision: qp2.revision,
    });
  }

  // ---- step 3: the output target is under <exportRoot>, outside source trees ----

  const resolved = resolveExportTarget(ctx, frozenRevision);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { exportRootReal, dirName } = resolved;

  // ---- step 4: the bundle import graph is exactly the allowed set --------------

  const graph = checkBundleGraph(metafile, ctx.bootstrapEntry);
  if (!graph.ok) {
    return fail('export_bundle_graph_forbidden', 'internal', 'forbidden modules in the export bundle graph', {
      modules: graph.forbidden.slice(0, 8),
    });
  }

  // ---- step 5: the forbidden-content scan on every emitted byte ----------------

  const indexHtmlBytes = new TextEncoder().encode(INDEX_HTML);
  const snapshotBytes = canonicalDocument(snapshot);
  const threeVersion = readJsonStringField(ctx.fs, ctx.threePackageJson, 'version') ?? '';
  const typescriptVersion = readJsonStringField(ctx.fs, ctx.typescriptPackageJson, 'version') ?? '';
  const meta = {
    schemaVersion: 1,
    type: 'thirdlight-export',
    engineVersion: ENGINE_VERSION,
    projectId: ctx.projectId,
    snapshotId: `${ctx.projectId}@r${frozenRevision}`,
    revision: frozenRevision,
    exportedAt: utcSeconds(),
    dependencies: {
      three: threeVersion,
      typescript: typescriptVersion,
      esbuild: esbuildVersion,
      runtime: { fixedStepHz: 120, modules: [DEMO_MODULE] },
    },
    scene: {
      entityCount: entities.length,
      cameraId: read.captured.cameraId,
      boxCount: entities.filter((e) => e.components.box !== undefined).length,
    },
  };
  const metaBytes = canonicalDocument(meta);

  const files: ScanFile[] = [
    { name: 'index.html', bytes: indexHtmlBytes },
    { name: BUNDLE_NAME, bytes: mainBytes },
    { name: 'snapshot.json', bytes: snapshotBytes },
    { name: 'meta.json', bytes: metaBytes },
  ];
  const scan = scanExportFiles(
    files,
    { authoringOrigin: ctx.authoringOrigin, previewOrigin: ctx.previewOrigin, tokenValues: ctx.tokenValues },
    BUNDLE_NAME,
    { version: threeVersion, integrity: readLockfileIntegrity(ctx.fs, ctx.lockfile) },
    referenceBytes,
  );
  if (!scan.ok) {
    return fail('export_bundle_forbidden_content', 'internal', `forbidden content in the export output (${scan.scanHits} hits outside the recorded-exception scope)`, {
      hits: scan.hits.slice(0, 4),
      reason: scan.binding.reason,
    });
  }

  // ---- step 6: output writes (temp dir + atomic replacement) --------------------

  const published = publishTree(ctx.fs, exportRootReal, dirName, files);
  if (!published.ok) return { ok: false, error: published.error };
  const sizes = published.files;
  return {
    ok: true,
    outputDir: dirName,
    snapshotId: `${ctx.projectId}@r${frozenRevision}`,
    revision: frozenRevision,
    files: sizes,
    scanHits: scan.scanHits,
  };
}
// ---- the pipeline dispatcher (packet 36) --------------------------------------

/**
 * `exportProject(ctx)` — the export operation (sessions.md §6.3). The
 * delivery pipeline is chosen by the CAPTURED authoring state, never by
 * configuration:
 *
 *   - a `storageVersion` 2 project (the workspace's `captureContentView`
 *     succeeds) exports as an **M2** export: the shared runtime-content
 *     manifest closure, the statically linked behavior outputs, the declared
 *     GLB artifacts and `meta.json` schemaVersion 2 (export.md §3/§5/§6);
 *   - a `storageVersion` 1 project (`version_combination_unsupported`) keeps
 *     the M1 pipeline exactly as accepted at packet 12 (schemaVersion 1,
 *     `snapshot.json`, demo-on bundle) — the M1 regression is unchanged.
 */
export async function exportProject(ctx: ExportContext): Promise<ExportResult> {
  const canCaptureContent = ctx.compiler !== undefined && typeof ctx.service.captureContentView === 'function';
  if (!canCaptureContent) return exportProjectM1(ctx);

  // M3 (storageVersion 3) — the single acknowledged envelope read
  // (delivery.md §2.6). A v1/v2 project is `version_combination_unsupported`
  // here and falls through to the M2/M1 pipeline below (byte-stable).
  if (typeof ctx.service.readCapturedV3 === 'function') {
    const v3 = ctx.service.readCapturedV3(ctx.projectId);
    if (v3.ok) {
      if (ctx.m3BootstrapEntry === undefined || ctx.compiler === undefined) {
        return {
          ok: false,
          error: {
            code: 'export_build_unavailable',
            cls: 'unavailable',
            message: 'an M3 project requires the M3 bundle entry and the injected behavior compiler',
            detail: { reason: 'm3_capability_missing' },
          },
        };
      }
      return exportProjectM3(
        ctx,
        { scene: v3.read.scene, content: v3.read.content, revision: v3.read.revision },
        ctx.m3BootstrapEntry,
        ctx.compiler,
      );
    }
    if (v3.error.reason !== 'version_combination_unsupported') {
      return {
        ok: false,
        error: {
          code: 'export_scene_invalid',
          cls: 'validation',
          message: `the captured v3 read failed: ${v3.error.message}`.slice(0, 256),
          detail: { errors: [v3.error], errorTotal: 1 },
        },
      };
    }
    // Not a v3 project — fall through to the M2/M1 pipeline.
  }

  const view = ctx.service.captureContentView(ctx.projectId);
  if (view.ok) {
    if (ctx.m2BootstrapEntry === undefined || ctx.compiler === undefined) {
      return {
        ok: false,
        error: {
          code: 'export_build_unavailable',
          cls: 'unavailable',
          message: 'an M2 project requires the M2 bundle entry and the injected behavior compiler',
          detail: { reason: 'm2_capability_missing' },
        },
      };
    }
    return exportProjectM2(ctx, view.view, ctx.m2BootstrapEntry, ctx.compiler);
  }
  if (view.error.reason === 'version_combination_unsupported') {
    return exportProjectM1(ctx);
  }
  return {
    ok: false,
    error: {
      code: 'export_scene_invalid',
      cls: 'validation',
      message: `the captured content view failed: ${view.error.message}`.slice(0, 256),
      detail: { errors: [view.error], errorTotal: 1 },
    },
  };
}
