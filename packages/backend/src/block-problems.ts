/**
 * Block layers' level-building problems on the backend: blocks that float,
 * regions with no cell of their layer, places not reachable from the layer's
 * walk region (project-model `blockLayerChecks`, through the workspace's
 * `layerLevelChecks`).
 *
 * They read whole layers, so they run here, off the editor's frame and off
 * the request's path: when the project loads and a moment after an edit that
 * can change them (block edits, block types, cell fields, components,
 * objects added or removed). A layer's result is kept by what it reads (its
 * cells, component, the block types and fields, the slope setting), so a
 * check re-reads only the layers that changed. A layer's line goes to the
 * project's problems (`tl_diagnostics`, the editor's Problems) when it
 * appears or changes.
 */
import type { BlockLayerComponent, BlockLayerData } from '@thirdlight/project-model';
import { layerLevelChecks, type BlockCheckContent, type BlockLayerCheck, type WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change a layer's checks. */
const RELEVANT = new Set(['editBlocks', 'setBlockType', 'deleteBlockType', 'setCellFields', 'setComponent', 'removeComponent', 'deleteEntity', 'createEntity', 'createEntities', 'pasteEntities', 'instantiatePrefab', 'updateEntity', 'createScene', 'deleteScene', 'setSettings']);

/** How long after the last relevant change a check runs: a brush stroke's edits settle first. */
const SETTLE_MS = 250;
/** Layers' results kept (one per distinct input). */
const CACHE_MAX = 256;

export interface BlockProblemRow {
  readonly sceneId: string;
  readonly entityId: string;
  readonly checks: readonly BlockLayerCheck[];
}

export interface BlockProblemChecker {
  /** Check every layer now (logging lines that appeared or changed); null: the project cannot be read. */
  check(projectId: string): BlockProblemRow[] | null;
  /** The project loaded: check it unless it was checked. */
  loaded(projectId: string): void;
  /** After an applied change: check soon when the change can matter. */
  changed(projectId: string, change: unknown): void;
}

interface SceneLike {
  readonly sceneId: string;
  readonly entities: readonly { readonly id: string; readonly active?: boolean; readonly components: Record<string, unknown> }[];
  readonly blocks?: readonly (BlockLayerData & { readonly entityId: string })[];
}

export function createBlockProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): BlockProblemChecker {
  /** Per project: layer → the lines last logged. */
  const last = new Map<string, Map<string, string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const idOf = (o: object | null | undefined): number => {
    if (o === null || o === undefined) return 0;
    let id = ids.get(o);
    if (id === undefined) ids.set(o, (id = nextId++));
    return id;
  };
  const cache = new Map<string, readonly BlockLayerCheck[]>();

  const check = (projectId: string): BlockProblemRow[] | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const content = captured.read.content as BlockCheckContent;
    const scenes = (captured.read.scenes ?? []) as unknown as readonly SceneLike[];
    const rows: BlockProblemRow[] = [];
    const now = new Map<string, string>();
    const before = last.get(projectId);
    for (const s of scenes) {
      const data = new Map((s.blocks ?? []).map((b) => [b.entityId, b]));
      for (const e of s.entities) {
        const component = e.components['blockLayer'] as BlockLayerComponent | undefined;
        if (component === undefined) continue;
        const layerData = data.get(e.id) ?? null;
        const key = `${idOf(layerData)}|${idOf(content.blockTypes)}|${idOf(content.cellFields)}|${JSON.stringify((content.settings as Record<string, unknown> | undefined)?.['max_slope_climb_deg'] ?? null)}|${e.id}|${JSON.stringify(component)}`;
        let checks = cache.get(key);
        if (checks === undefined) {
          checks = layerLevelChecks(e.id, component, layerData, content);
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(key, checks);
        }
        rows.push({ sceneId: s.sceneId, entityId: e.id, checks });
        const layerKey = `${s.sceneId}\u0000${e.id}`;
        const sig = JSON.stringify(checks.map((c) => c.message));
        now.set(layerKey, sig);
        if (checks.length > 0 && before?.get(layerKey) !== sig) for (const c of checks) deps.recordProblem(projectId, c.code, `${c.message} (scene "${s.sceneId}")`);
      }
    }
    last.set(projectId, now);
    return rows;
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`block check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    check,
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
