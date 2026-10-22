/**
 * The full state an editor session reads: the manifest, every entity of
 * every scene (paged; a project's size is not capped), the history, the
 * workspace and the size of the content index. Reading it is an editor
 * loading the project, so the load-time checks run.
 */
import { sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import type { WorkspaceService } from '@thirdlight/workspace';

import { workspaceError } from './http';
import type { ProjectChecks } from './problems';

export type FullState =
  | {
      ok: true;
      revision: number;
      manifest: Record<string, unknown>;
      scene: Record<string, unknown>;
      history: Record<string, unknown>;
      workspace: Record<string, unknown>;
      content?: Record<string, unknown>;
    }
  | { ok: false; error: SessionError; status: number };

/** The page the editor session's entities (all scenes) are read in; there is no bound on how many. */
const SESSION_PAGE = 16_384;
/** A legacy (v1–v3) session reads its entities in pages this size. */
const LEGACY_SESSION_PAGE = 1024;

export function makeFullState(deps: { service: WorkspaceService; checks: ProjectChecks }) {
  const { service } = deps;

  /**
   * The content part of the full state: the size of the project index. The
   * editor reads what it shows from the index in pages (`queryIndex`) and the
   * records it needs by id (`queryAssets {ids}`, …) — never a first page
   * standing in for the catalog. Undefined for a project whose index cannot
   * be read (the scene full state is still served).
   */
  const contentProjection = (projectId: string): Record<string, unknown> | undefined => {
    const index = service.query({ op: 'queryIndex', projectId, args: { limit: 1, refs: false } });
    if (!index.ok) return undefined;
    return { index: { total: (index as unknown as { total: number }).total } };
  };

  return (projectId: string): FullState => {
    const q = service.query({ op: 'queryProject', projectId });
    if (!q.ok) {
      return { ok: false, error: workspaceError(q.error), status: statusFor(q.error.cls) };
    }
    const { checks } = deps;
    checks.loaded(projectId);
    checks.loadedByEditor(projectId);
    if (!('manifest' in q)) {
      // queryProject always yields the project shape; this is a defensive
      // guard so the code below narrows to `QueryProjectResult`.
      return { ok: false, status: 500, error: sessionError('invalid_request', 'internal', 'unexpected query shape') };
    }
    // Paged, every entity of every scene (a project's size is not capped); a v4
    // project also names each entity's scene and lists its scenes.
    const v4 = (q as { scenes?: unknown }).scenes !== undefined;
    const page = v4 ? SESSION_PAGE : LEGACY_SESSION_PAGE;
    const entities: unknown[] = [];
    const entitySceneIds: string[] = [];
    let total = 0;
    for (let offset = 0; ; offset += page) {
      const e = service.query({ op: 'queryEntities', projectId, args: { limit: page, offset } });
      if (!e.ok) {
        return { ok: false, error: workspaceError(e.error), status: statusFor(e.error.cls) };
      }
      if (!('entities' in e)) {
        return { ok: false, status: 500, error: sessionError('invalid_request', 'internal', 'unexpected query shape') };
      }
      total = e.total;
      entities.push(...e.entities);
      const ids = (e as { entitySceneIds?: string[] }).entitySceneIds;
      if (ids !== undefined) entitySceneIds.push(...ids);
      if (entities.length >= total || e.entities.length === 0) break;
    }
    const scene: Record<string, unknown> = {
      // The SCENE document's `schemaVersion`
      // (1/2/3/4) — never the manifest's.
      schemaVersion: q.scene.schemaVersion,
      sceneId: q.scene.sceneId,
      revision: q.revision,
      entities,
      ...(v4 ? { entitySceneIds, scenes: (q as { scenes?: unknown }).scenes, startScenes: (q as { startScenes?: unknown }).startScenes } : {}),
    };
    const content = contentProjection(projectId);
    return {
      ok: true,
      revision: q.revision,
      manifest: q.manifest as unknown as Record<string, unknown>,
      scene,
      history: q.history as unknown as Record<string, unknown>,
      workspace: q.workspace as unknown as Record<string, unknown>,
      ...(content !== undefined ? { content } : {}),
    };
  };
}
