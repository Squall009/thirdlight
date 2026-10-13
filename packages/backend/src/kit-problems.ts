/**
 * Kits that name parts the project does not have (project-model
 * `kitProblems`): a missing or non-trim trim material, a missing preset or
 * one that is not an architecture preset, a missing block type, a piece
 * whose model is gone. A kit only names its parts, so deleting a part is
 * never refused for a kit's sake; the kit's line in the project's problems
 * (`tl_diagnostics`, the editor's Problems) says what to fix instead.
 *
 * A piece that fails the kit's piece checks with an error (its origin off
 * the bottom centre, transforms not applied, UVs outside the sheet's rows:
 * project-model `kit-checks`) is named on the same line.
 *
 * Checked when the project loads and shortly after a change that can change
 * the answer (a kit's pieces only when that kit's inputs changed); a kit's
 * line is logged when it appears or changes.
 */
import { kitProblems, type KitProblemContent, type KitProblemRow } from '@thirdlight/project-model/kits';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change what a kit's references resolve to (or how its pieces check). */
const RELEVANT = new Set(['setKit', 'setMaterial', 'setGraph', 'setBlockType', 'publishAsset', 'removeAsset', 'importAssets', 'importResources', 'setAssetOptions', 'createEntity', 'deleteEntity', 'pasteEntities']);
/** A block layer's fields a kit's piece checks read (the cell its pieces are sized in). */
const LAYER_FIELDS = new Set(['kitId', 'cellSize']);

/** Whether a change can change a kit's answer; only the kits whose inputs changed are then checked again (kit-check.ts). */
function matters(change: unknown): boolean {
  const c = change as { type?: unknown; component?: unknown; changedFields?: unknown } | null;
  if (typeof c?.type !== 'string') return false;
  if (RELEVANT.has(c.type)) return true;
  return c.type === 'setComponent' && c.component === 'blockLayer' && (!Array.isArray(c.changedFields) || c.changedFields.some((f) => LAYER_FIELDS.has(f as string)));
}

/** Problems named in one line (the count says how many). */
const NAMED_PER_LINE = 4;

export function kitProblemLine(row: KitProblemRow): string {
  const shown = row.problems.slice(0, NAMED_PER_LINE).join('; ');
  const more = row.problems.length > NAMED_PER_LINE ? `; and ${row.problems.length - NAMED_PER_LINE} more` : '';
  return `Kit "${row.name}" (${row.kitId}): ${shown}${more}. Pick another part for it or take the part out of the kit.`;
}

export interface KitProblemChecker {
  /** Check now (logging lines that appeared or changed); null: the project cannot be read. */
  check(projectId: string): KitProblemRow[] | null;
  /** The project loaded: check it unless it was checked. */
  loaded(projectId: string): void;
  /** After an applied change: check soon when the change can matter. */
  changed(projectId: string, change: unknown): void;
}

export function createKitProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
  /** Each kit's piece errors in plain words (kit-check.ts). */
  pieceErrors?: (projectId: string) => ReadonlyMap<string, readonly string[]>;
}): KitProblemChecker {
  /** Per project: kit → the line last logged. */
  const last = new Map<string, Map<string, string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = (projectId: string): KitProblemRow[] | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const content = captured.read.content as unknown as KitProblemContent;
    const pieces = deps.pieceErrors?.(projectId) ?? new Map<string, readonly string[]>();
    const rows: KitProblemRow[] = kitProblems(content).map((r) => ({ ...r, problems: [...r.problems, ...(pieces.get(r.kitId) ?? [])] }));
    for (const k of content.kits ?? []) {
      const extra = pieces.get(k.kitId);
      if (extra !== undefined && !rows.some((r) => r.kitId === k.kitId)) rows.push({ kitId: k.kitId, name: k.name, problems: [...extra] });
    }
    const before = last.get(projectId);
    const now = new Map<string, string>();
    for (const row of rows) {
      const line = kitProblemLine(row);
      now.set(row.kitId, line);
      if (before?.get(row.kitId) !== line) deps.recordProblem(projectId, 'kit_reference_missing', line);
    }
    last.set(projectId, now);
    return rows;
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`kit check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    check,
    loaded(projectId) {
      if (!last.has(projectId)) safeCheck(projectId);
    },
    changed(projectId, change) {
      if (!matters(change) || deps.closed() || timers.has(projectId)) return;
      const t = setTimeout(() => {
        timers.delete(projectId);
        if (!deps.closed()) safeCheck(projectId);
      }, 25);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
  };
}
