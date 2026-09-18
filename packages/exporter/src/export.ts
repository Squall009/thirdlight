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
import { scanExportFiles, type ScanFile } from './scan';

// ---- public types (dependencies.md §3: `exportProject(ctx) → result`) ----------

/**
 * The injected IO facade (export.md §2 dependency-injection style — the
 * backend supplies it from its allowed `node:fs`/`node:path` edges). The
 * exporter never imports Node builtins itself.
 */
export interface ExportFs {
  join(...parts: string[]): string;
  realpath(p: string): string;
  isDirectory(p: string): boolean;
  exists(p: string): boolean;
  /** Recursive mkdir (node:fs.mkdirSync `{ recursive: true }`). */
  mkdir(p: string): void;
  write(p: string, data: Uint8Array): void;
  rename(from: string, to: string): void;
  /** Recursive, force (node:fs.rmSync). */
  rm(p: string): void;
  /** node:fs.mkdtempSync (prefix must end in `-`). */
  mkdtemp(prefix: string): string;
  read(p: string): Uint8Array;
}

export interface ExportContext {
  projectId: string;
  /**
   * The injected workspace service (types-only edge — the exporter never
   * constructs one; the backend passes its instance, export.md §2).
   */
  service: WorkspaceService;
  /** The injected IO facade (see `ExportFs`). */
  fs: ExportFs;
  /** The configured export root (sessions.md §13.7; `<exportRoot>`). */
  exportRoot: string;
  /** The engine repository tree (a forbidden export target). */
  repoRoot: string;
  /** The workspace data root (the authoring tree — a forbidden target). */
  authoringRoot: string;
  /** a — the configured authoring origin (scan pattern). */
  authoringOrigin: string;
  /** b — the configured preview origin (scan pattern). */
  previewOrigin: string;
  /** i — the configured admin/authoring token VALUES (scan pattern). */
  tokenValues: readonly string[];
  /** Absolute path of the export bundle entry (packages/exporter/src/export-bootstrap.ts). */
  bootstrapEntry: string;
  /** Absolute path of the installed three package.json (the §5.4.1 identity). */
  threePackageJson: string;
  /** Absolute path of the installed typescript package.json (meta.json dependencies). */
  typescriptPackageJson: string;
  /** Absolute path of the workspace lockfile (the recorded registry integrity). */
  lockfile: string;
}

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

export async function exportProject(ctx: ExportContext): Promise<ExportResult> {
  // ---- step 1: the project loads and the scene/snapshot validate --------------

  const qp = ctx.service.query({ op: 'queryProject', projectId: ctx.projectId });
  if (qp.ok === false) {
    return fail(
      'export_scene_invalid',
      'validation',
      `project '${ctx.projectId}' does not load: ${qp.error.message}`,
      { errors: [qp.error], errorTotal: 1 },
    );
  }
  if (!('manifest' in qp)) {
    return fail('export_scene_invalid', 'validation', 'inconsistent queryProject result');
  }

  // All entities, in document order (paged; the M1 page bound is 1024).
  const entities: Entity[] = [];
  let offset = 0;
  const total = qp.scene.entityCount;
  while (offset < total) {
    const page = ctx.service.query({ op: 'queryEntities', projectId: ctx.projectId, args: { offset, limit: 1024 } });
    if (page.ok === false) {
      return fail('export_scene_invalid', 'validation', `queryEntities failed at offset ${offset}: ${page.error.message}`, {
        errors: [page.error],
        errorTotal: 1,
      });
    }
    if (!('total' in page)) {
      return fail('export_scene_invalid', 'validation', 'inconsistent queryEntities result');
    }
    if (page.total !== total) {
      return fail('export_scene_invalid', 'validation', `entity count changed mid-read (${total} → ${page.total})`);
    }
    entities.push(...page.entities);
    if (page.entities.length === 0) break;
    offset += page.entities.length;
  }
  if (entities.length !== total) {
    return fail('export_scene_invalid', 'validation', `entity read incomplete (${entities.length} of ${total})`);
  }

  // Reconstruct the scene document (project-model §8 canonical order).
  const sceneDoc: Scene = { schemaVersion: 1, sceneId: qp.scene.sceneId, revision: qp.revision, entities };
  const vres = validateScene(sceneDoc);
  if (!vres.ok) {
    return fail('export_scene_invalid', 'validation', 'the scene document fails validation', clipErrors(vres.errors, vres.errors.length));
  }
  const normalizedScene = vres.normalized;

  // Manifest cross-checks (workspace.md §4.3).
  const manifest = qp.manifest;
  if (manifest.id !== ctx.projectId) {
    return fail('export_scene_invalid', 'validation', `manifest id '${manifest.id}' does not match the queried project`);
  }
  if (manifest.scenes.length !== 1 || manifest.scenes[0].id !== qp.scene.sceneId || manifest.scenes[0].path !== 'scenes/main.json') {
    return fail('export_scene_invalid', 'validation', 'the manifest scene reference fails the M1 cross-check');
  }
  const cameraEntity = entities.find((e) => e.components.camera !== undefined);
  if ((cameraEntity?.id ?? '') !== qp.scene.cameraId) {
    return fail('export_scene_invalid', 'validation', 'the manifest/scene camera cross-check failed');
  }

  // Construct + re-validate the runtime snapshot (runtime.md §2 boundary),
  // then FREEZE it for the whole export. (The authoritative runtime
  // re-validation also runs at export-page load — the page's bootstrap
  // `instantiateRuntime` on `./snapshot.json`.)
  const frozenRevision = qp.revision;
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

  if (!ctx.fs.isDirectory(ctx.exportRoot)) {
    return fail('export_output_path_invalid', 'validation', 'the configured exportRoot is not a directory');
  }
  const dirName = `${ctx.projectId}@r${frozenRevision}`;
  if (!/^[A-Za-z0-9_-]+@r\d+$/.test(dirName)) {
    return fail('export_output_path_invalid', 'validation', 'the output directory name is not <projectId>@r<revision>');
  }
  let exportRootReal: string;
  let repoReal: string;
  let authoringReal: string;
  try {
    exportRootReal = ctx.fs.realpath(ctx.exportRoot);
    repoReal = ctx.fs.realpath(ctx.repoRoot);
    authoringReal = ctx.fs.realpath(ctx.authoringRoot);
  } catch (e) {
    return fail('export_output_path_invalid', 'validation', `cannot resolve the export paths: ${e instanceof Error ? e.message : String(e)}`);
  }
  const target = ctx.fs.join(exportRootReal, dirName);
  if (target.startsWith(repoReal + '/') || target === repoReal) {
    return fail('export_output_path_invalid', 'validation', 'the export target sits inside the engine repository tree');
  }
  if (target.startsWith(authoringReal + '/') || target === authoringReal) {
    return fail('export_output_path_invalid', 'validation', 'the export target sits inside a project authoring tree');
  }

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
      cameraId: qp.scene.cameraId,
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

  let tempDir = '';
  try {
    tempDir = ctx.fs.mkdtemp(ctx.fs.join(exportRootReal, '.export-tmp-'));
  } catch (e) {
    return fail('export_output_not_writable', 'unavailable', `cannot create the temp export dir: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    ctx.fs.mkdir(ctx.fs.join(tempDir, 'js'));
    for (const f of files) {
      ctx.fs.write(ctx.fs.join(tempDir, f.name), f.bytes);
    }
    // Atomic replacement: back up the previous tree, rename the temp tree
    // into place, remove the backup. A failure restores the previous tree.
    const backup = ctx.fs.join(exportRootReal, `.${dirName}.replacing`);
    if (ctx.fs.exists(backup)) ctx.fs.rm(backup);
    let backedUp = false;
    if (ctx.fs.exists(target)) {
      ctx.fs.rename(target, backup);
      backedUp = true;
    }
    try {
      ctx.fs.rename(tempDir, target);
    } catch (e) {
      if (backedUp) {
        try {
          ctx.fs.rename(backup, target);
        } catch {
          // The previous tree cannot be restored — report the failure; the
          // operator must re-export.
        }
      }
      throw e;
    }
    if (backedUp) ctx.fs.rm(backup);
  } catch (e) {
    try {
      if (tempDir !== '' && ctx.fs.exists(tempDir)) ctx.fs.rm(tempDir);
    } catch {
      // temp cleanup best-effort
    }
    return fail('export_output_not_writable', 'unavailable', `the export output writes failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sizes: Record<string, number> = {};
  for (const f of files) sizes[f.name] = f.bytes.length;
  return {
    ok: true,
    outputDir: dirName,
    snapshotId: `${ctx.projectId}@r${frozenRevision}`,
    revision: frozenRevision,
    files: sizes,
    scanHits: scan.scanHits,
  };
}