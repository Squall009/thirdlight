/**
 * Scripts that name an asset which is not loadable.
 *
 * A build ships what scenes reference and what has an address or a label.
 * A script that names an asset by its id in a string literal
 * (`ctx.audio.play("door-open")`) gets it only if one of those holds, so the
 * project's Problems say which scripts name which assets that have neither
 * (Unity's Addressables load only addressable assets by key).
 *
 * Checked when the project loads and after a change that can change the
 * answer (a script or library published, an asset's labels or address, an
 * asset added or removed); a script's literals are kept by its source
 * digest, so a check reads only scripts that changed. The Problem is logged
 * when the set of such assets changes and is not empty.
 */
import { scriptNamedAssets, type WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change which assets scripts name or which are loadable. */
const RELEVANT = new Set(['publishBehavior', 'setScriptLibrary', 'setScriptLibraries', 'setLabels', 'setAddress', 'publishAsset', 'importAssets', 'removeAsset', 'importResources']);

/** Assets named in one Problem line (the count says how many). */
const NAMED_PER_LINE = 6;

export interface ScriptNameRow {
  readonly assetId: string;
  readonly scripts: readonly string[];
}

export interface ScriptNameChecker {
  /** Check now (logging a changed, non-empty set); null: the project cannot be read. */
  check(projectId: string): ScriptNameRow[] | null;
  /** The project loaded: check it unless it was checked. */
  loaded(projectId: string): void;
  /** After an applied change: check soon when the change can matter. */
  changed(projectId: string, change: unknown): void;
}

export function scriptNameProblemLine(rows: readonly ScriptNameRow[]): string {
  const shown = rows.slice(0, NAMED_PER_LINE).map((r) => `"${r.assetId}" (${r.scripts[0]}${r.scripts.length > 1 ? ` and ${r.scripts.length - 1} more` : ''})`);
  const what = rows.length === 1 ? 'A script names an asset that isn\'t loadable' : `Scripts name ${rows.length} assets that aren't loadable`;
  return `${what}: ${shown.join(', ')}${rows.length > NAMED_PER_LINE ? ', …' : ''}. Give it an address or a label (Inspector, Assets tab, or setLabels/setAddress); a build ships an asset only when a scene references it or it is loadable.`;
}

export function createScriptNameChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3' | 'readSourceBlob'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): ScriptNameChecker {
  const last = new Map<string, string>();
  const literals = new Map<string, Map<string, Set<string>>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = (projectId: string): ScriptNameRow[] | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const cache = literals.get(projectId) ?? new Map<string, Set<string>>();
    literals.set(projectId, cache);
    const read = (digest: string): Uint8Array | null => {
      const r = deps.service.readSourceBlob(projectId, { digest });
      return r.ok ? r.bytes : null;
    };
    const rows = scriptNamedAssets(read, captured.read.content as Parameters<typeof scriptNamedAssets>[1], cache)
      .filter((n) => !n.loadable)
      .map((n) => ({ assetId: n.assetId, scripts: n.scripts }));
    const key = JSON.stringify(rows);
    if (last.get(projectId) !== key) {
      last.set(projectId, key);
      if (rows.length > 0) deps.recordProblem(projectId, 'script_names_unloadable_asset', scriptNameProblemLine(rows));
    }
    return rows;
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`script name check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    check,
    loaded(projectId) {
      if (!last.has(projectId)) safeCheck(projectId);
    },
    changed(projectId, change) {
      const type = (change as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !RELEVANT.has(type) || deps.closed() || timers.has(projectId)) return;
      const t = setTimeout(() => {
        timers.delete(projectId);
        if (!deps.closed()) safeCheck(projectId);
      }, 25);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
  };
}
