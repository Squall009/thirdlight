/**
 * Vertex paint that no longer fits its model (`paint_mismatch`): checked
 * when the project loads and a moment after a change that can matter (a
 * reimport, paint set or removed, objects added or removed). An object's
 * line goes to the project's problems (`tl_diagnostics`, the editor's
 * Problems) when it appears or changes. The models' meshes are read once per
 * file (workspace `paintMismatches`), off the request's path.
 */
import { paintMismatches, type PaintMeshCache, type WorkspaceService } from '@thirdlight/workspace';

/** The change types that can make paint fit or stop fitting its model. */
const RELEVANT = new Set(['setComponent', 'removeComponent', 'createEntity', 'createEntities', 'pasteEntities', 'instantiatePrefab', 'updateEntity', 'publishAsset', 'importAssets', 'deleteAsset', 'createScene', 'deleteScene']);
/** How long after the last relevant change a check runs: a brush's strokes settle first. */
const SETTLE_MS = 250;

export interface PaintProblemChecker {
  loaded(projectId: string): void;
  changed(projectId: string, change: unknown): void;
}

export function createPaintProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3' | 'readBlob'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): PaintProblemChecker {
  /** Per project: object → the line last logged. */
  const last = new Map<string, Map<string, string>>();
  const caches = new Map<string, PaintMeshCache>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = (projectId: string): void => {
    let cache = caches.get(projectId);
    if (cache === undefined) caches.set(projectId, (cache = new Map()));
    const rows = paintMismatches(deps.service, projectId, cache);
    if (rows === null) return;
    const before = last.get(projectId);
    const now = new Map<string, string>();
    for (const r of rows) {
      const key = `${r.sceneId}\u0000${r.entityId}`;
      now.set(key, r.message);
      if (before?.get(key) !== r.message) deps.recordProblem(projectId, 'paint_mismatch', `${r.message} (scene "${r.sceneId}")`);
    }
    last.set(projectId, now);
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`vertex paint check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
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
