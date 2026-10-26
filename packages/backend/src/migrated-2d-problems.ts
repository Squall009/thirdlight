/**
 * What the upgrade of a former 2D project converted and the game team has
 * not looked at yet (each scene's `migratedFrom2D` notes) goes to the
 * project's problems, one line per kind of conversion naming the objects and
 * the field to check. The notes live in the scene files, so the lines come
 * back in every backend run until each item is saved again; a line that
 * changed (an object settled) is withdrawn and logged again with what is
 * left, so Problems never shows the old and the new line together.
 *
 * Checked when the project loads and, while it has notes, after each change.
 */
import { MIGRATED_2D_PROBLEM, migrated2DProblemLines, type WorkspaceService } from '@thirdlight/workspace';

export interface Migrated2DProblemChecker {
  loaded(projectId: string): void;
  changed(projectId: string): void;
}

export function createMigrated2DProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  withdrawProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): Migrated2DProblemChecker {
  /** Per project: the lines last logged (empty: no notes, nothing to check after changes). */
  const last = new Map<string, Set<string>>();
  const check = (projectId: string): void => {
    try {
      const captured = deps.service.readCapturedV3(projectId);
      if (!captured.ok) return;
      const before = last.get(projectId);
      const now = new Set(migrated2DProblemLines(captured.read.scenes ?? []));
      for (const line of before ?? []) if (!now.has(line)) deps.withdrawProblem(projectId, MIGRATED_2D_PROBLEM, line);
      for (const line of now) if (before?.has(line) !== true) deps.recordProblem(projectId, MIGRATED_2D_PROBLEM, line);
      last.set(projectId, now);
    } catch (e) {
      deps.logStartup(`2D upgrade check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    // Once per backend run (the Problems query calls it each time): a restart lists what is still open again.
    loaded(projectId) {
      if (!last.has(projectId)) check(projectId);
    },
    changed(projectId) {
      if (deps.closed() || (last.get(projectId)?.size ?? 0) === 0) return;
      check(projectId);
    },
  };
}
