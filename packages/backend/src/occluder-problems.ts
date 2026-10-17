/**
 * Occluder stand-ins that are ignored (`model_occluder_ignored`): a model's
 * `<piece>_OCC` node with a vertex outside its piece's LOD0 bounds (or a
 * piece with no geometry to hold it) is never drawn, since it could hide
 * what is seen beside the model (project-model `model-occluders.ts`; the
 * adapter drops the node by the same rule when it makes the model).
 *
 * Checked when the project loads and a moment after a model is imported or
 * re-imported; a model's line goes to the project's problems
 * (`tl_diagnostics`, the editor's Problems) when it appears or changes. A
 * file is read only when it names an `_OCC` node, and its result is kept by
 * its digest, so a check re-reads only new files.
 */
import { modelOccluderProblem, modelOccluderReport } from '@thirdlight/project-model/model-occluders';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The change types that can bring a model with stand-ins in. */
const RELEVANT = new Set(['publishAsset', 'importAssets', 'importResources']);
/** How long after the last relevant change a check runs (an import of many files settles first). */
const SETTLE_MS = 250;
/** Files' results kept (one per digest; the oldest go first). */
const CACHE_MAX = 1024;

interface Asset {
  assetId: string;
  kind?: string;
  displayName?: string;
  currentVersion?: number;
}

/** One model's ignored stand-ins: its problem line. */
export interface OccluderProblemRow {
  readonly assetId: string;
  readonly version: number;
  readonly message: string;
}

/** The problem lines of a model file's stand-ins (empty: none ignored), or why it could not be read. */
export function occluderProblemLines(bytes: Uint8Array): string[] {
  const report = modelOccluderReport(bytes);
  if (typeof report === 'string') return [];
  return report.flatMap((c) => {
    const line = modelOccluderProblem(c);
    return line === null ? [] : [line];
  });
}

/** Every model of a project whose stand-ins are ignored (null: the project cannot be read). */
export function occluderProblems(service: Pick<WorkspaceService, 'readCapturedV3' | 'readBlob'>, projectId: string, cache: Map<string, string[]> = new Map()): OccluderProblemRow[] | null {
  const captured = service.readCapturedV3(projectId);
  if (!captured.ok) return null;
  const rows: OccluderProblemRow[] = [];
  for (const a of ((captured.read.content as { assets?: Asset[] } | null)?.assets ?? [])) {
    if ((a.kind ?? 'model') !== 'model' || a.currentVersion === undefined) continue;
    const blob = service.readBlob(projectId, { assetId: a.assetId, version: a.currentVersion });
    // A missing file is the missing-files check's report.
    if (!blob.ok) continue;
    let lines = cache.get(blob.digest);
    if (lines === undefined) {
      lines = occluderProblemLines(blob.bytes);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(blob.digest, lines);
    }
    if (lines.length === 0) continue;
    const named = a.displayName !== undefined ? `"${a.displayName}" (${a.assetId})` : a.assetId;
    rows.push({ assetId: a.assetId, version: a.currentVersion, message: `${named} v${a.currentVersion}: ${lines.join(' ')}` });
  }
  return rows;
}

export interface OccluderProblemChecker {
  loaded(projectId: string): void;
  changed(projectId: string, change: unknown): void;
}

export function createOccluderProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3' | 'readBlob'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): OccluderProblemChecker {
  /** Per project: model → the line last logged. */
  const last = new Map<string, Map<string, string>>();
  const cache = new Map<string, string[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = (projectId: string): void => {
    const rows = occluderProblems(deps.service, projectId, cache);
    if (rows === null) return;
    const before = last.get(projectId);
    const now = new Map<string, string>();
    for (const r of rows) {
      now.set(r.assetId, r.message);
      if (before?.get(r.assetId) !== r.message) deps.recordProblem(projectId, 'model_occluder_ignored', r.message);
    }
    last.set(projectId, now);
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`occluder check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    loaded(projectId) {
      if (!last.has(projectId)) safeCheck(projectId);
    },
    changed(projectId, change) {
      const type = (change as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !RELEVANT.has(type) || deps.closed()) return;
      const old = timers.get(projectId);
      if (old !== undefined) clearTimeout(old);
      const t = setTimeout(() => {
        timers.delete(projectId);
        if (!deps.closed()) safeCheck(projectId);
      }, SETTLE_MS);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
  };
}
