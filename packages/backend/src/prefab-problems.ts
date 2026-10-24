/**
 * Linked prefab copies that could not be assembled as stored — a prefab that
 * is gone, a nesting cycle, an override whose part or field the prefab no
 * longer has, a part id another object holds — go to the project's problems
 * (`tl_diagnostics`, the editor's Problems), one line per kind of problem
 * and prefab with the copies it concerns, when it appears or changes.
 *
 * Checked when the project loads and after a change that touches copies or
 * prefabs (the assembled read is kept per state, so a check is a read).
 */
import type { ScenePrefabProblem, WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change what assembly meets besides one carrying assembled objects. */
const RELEVANT = new Set(['createPrefab', 'updatePrefab', 'removePrefab', 'importResources', 'moveResources']);
/** Copies named in one line before it says how many more. */
const NAMED_MAX = 5;

export interface PrefabProblemChecker {
  loaded(projectId: string): void;
  changed(projectId: string, change: unknown): void;
}

/** One line per problem kind and prefab: what it is and the copies it concerns. */
export function prefabProblemLines(problems: readonly ScenePrefabProblem[]): { code: string; message: string }[] {
  const groups = new Map<string, ScenePrefabProblem[]>();
  for (const p of problems) {
    const key = `${p.code}\u0000${p.prefabId}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [p]);
    else g.push(p);
  }
  return [...groups.values()].map((g) => {
    const first = g[0]!;
    const copies = [...new Set(g.map((p) => `${p.entityId} (scene "${p.sceneId}")`))];
    const named = copies.slice(0, NAMED_MAX).join(', ') + (copies.length > NAMED_MAX ? ` and ${copies.length - NAMED_MAX} more` : '');
    return { code: `prefab_${first.code.replace(/^prefab_/, '')}`, message: `Prefab "${first.prefabId}": ${first.message}${g.length > 1 ? ` (${g.length} times)` : ''} — ${named}` };
  });
}

export function createPrefabProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): PrefabProblemChecker {
  /** Per project: the lines last logged. */
  const last = new Map<string, Set<string>>();
  const check = (projectId: string): void => {
    try {
      const captured = deps.service.readCapturedV3(projectId);
      if (!captured.ok) return;
      const lines = prefabProblemLines(captured.read.prefabProblems ?? []);
      const before = last.get(projectId);
      const now = new Set<string>();
      for (const l of lines) {
        const key = `${l.code}\u0000${l.message}`;
        now.add(key);
        if (before?.has(key) !== true) deps.recordProblem(projectId, l.code, l.message);
      }
      last.set(projectId, now);
    } catch (e) {
      deps.logStartup(`prefab check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    // Every load checks (a project reopened may hold other files); the assembled read is kept, and a line logs once.
    loaded(projectId) {
      check(projectId);
    },
    changed(projectId, change) {
      if (deps.closed()) return;
      const c = change as { type?: unknown; assembled?: unknown } | null;
      if (c?.assembled === undefined && !(typeof c?.type === 'string' && RELEVANT.has(c.type))) return;
      check(projectId);
    },
  };
}
