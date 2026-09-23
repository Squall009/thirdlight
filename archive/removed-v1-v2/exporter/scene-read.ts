/**
 * The shared authoring-state read for the M1 and M2 export pipelines
 * (export.md §2/§4 step 1): one `queryProject` + paged `queryEntities` through
 * the INJECTED workspace service, the manifest cross-checks of workspace.md
 * §4.3, and the entity-count consistency guard. The caller decides which scene
 * validator (v1 `validateScene` / v2 `validateSceneV2`) applies.
 *
 * Pure reads: no filesystem access, no service construction, no mutation.
 */
import type { Manifest } from '@thirdlight/project-model';
import type { Entity, WorkspaceService } from '@thirdlight/workspace';

import { clip, type ExportError } from './errors';

export interface SceneReadContext {
  projectId: string;
  service: WorkspaceService;
}

export interface CapturedSceneRead {
  entities: Entity[];
  revision: number;
  sceneId: string;
  cameraId: string;
  manifest: Manifest;
}

export type SceneReadResult = { ok: true; captured: CapturedSceneRead } | { ok: false; error: ExportError };

function fail(code: 'export_scene_invalid', cls: 'validation', message: string, detail?: ExportError['detail']): SceneReadResult {
  return { ok: false, error: { code, cls, message: clip(message), detail } };
}

export function readCapturedScene(ctx: SceneReadContext): SceneReadResult {
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
  return {
    ok: true,
    captured: {
      entities,
      revision: qp.revision,
      sceneId: qp.scene.sceneId,
      cameraId: qp.scene.cameraId,
      manifest,
    },
  };
}
