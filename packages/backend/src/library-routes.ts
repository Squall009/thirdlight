/**
 * The script library and behavior source routes beside the content table:
 * a library draft's compile check, staged library edits, and the published
 * source graph of one behavior.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStrictJsonBytes, sessionError, type SessionError } from '@thirdlight/protocol';
import type { CommandError, WorkspaceService } from '@thirdlight/workspace';

import { readBody, sendError, sendJson, workspaceError } from './http';

export interface LibraryRoutesDeps {
  readonly service: WorkspaceService;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
}

export function makeLibraryRoutes(deps: LibraryRoutesDeps) {
  const { service, requireAuth } = deps;

  /**
   * `POST …/content/libraries/check {libraryId, files}` — compile
   * one script library draft on its own (the script editor's idle check and
   * Compile): its files replace the stored library of that id (or add one)
   * and the other libraries are the project's. Nothing is written and no code
   * runs. Answers the compiler's diagnostics (each with the library and file
   * it names), the draft's digest, the libraries it reaches and the published
   * scripts that import it (they are recompiled when it is saved).
   */
  const libraryCheckRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const value = strict.value as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key !== 'libraryId' && key !== 'files') {
        sendError(res, sessionError('field_unexpected', 'validation', `a library check takes libraryId and files only ("${key}")`, { path: `/${key}` }));
        return;
      }
    }
    const libraryId = value.libraryId;
    if (typeof libraryId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryId)) {
      sendError(res, sessionError('field_value', 'validation', 'libraryId must use the id syntax', { path: '/libraryId' }));
      return;
    }
    const files = value.files;
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'object' || f === null || typeof (f as { path?: unknown }).path !== 'string' || typeof (f as { text?: unknown }).text !== 'string')) {
      sendError(res, sessionError('field_value', 'validation', 'files must be a list of { path, text }', { path: '/files' }));
      return;
    }
    const r = await service.checkScriptLibraryDraft(projectId, { libraryId, files: (files as { path: string; text: string }[]).map((f) => ({ path: f.path, text: f.text })) });
    if (!r.ok) {
      sendError(res, workspaceError(r.error));
      return;
    }
    sendJson(res, 200, r);
  };

  /**
   * `POST …/content/libraries/stage` — staged library edits.
   * `{stageId?, libraryId, name?, files?}` adds one patch (`setScriptLibrary`'s
   * shape, each under the request cap; a file's text may come in pieces,
   * `{path, text, append: true}`) to a stage (a new one without
   * stageId) and answers the stage (its libraries, their digests, the patch
   * count); `{stageId, discard: true}` drops one. Nothing authoritative
   * changes: `commitScriptLibraryStage {stageId}` commits the stage as one
   * change (one revision, one undo, the dependents compiled once).
   */
  const libraryStageRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const value = strict.value as Record<string, unknown>;
    const stageId = value['stageId'];
    if (stageId !== undefined && (typeof stageId !== 'string' || !/^lstage-[0-9]{1,12}$/.test(stageId))) {
      sendError(res, sessionError('field_value', 'validation', 'stageId must be a stage id this route answered (lstage-<n>)', { path: '/stageId' }));
      return;
    }
    if (value['discard'] !== undefined) {
      if (value['discard'] !== true || typeof stageId !== 'string' || Object.keys(value).length !== 2) {
        sendError(res, sessionError('field_value', 'validation', 'discard a stage with exactly { stageId, discard: true }', { path: '/discard' }));
        return;
      }
      const d = service.discardScriptLibraryStage(projectId, stageId);
      if (!d.ok) {
        sendError(res, workspaceError(d.error));
        return;
      }
      sendJson(res, 200, { ok: true, stageId, discarded: true });
      return;
    }
    for (const key of Object.keys(value)) {
      if (!['stageId', 'libraryId', 'name', 'files'].includes(key)) {
        sendError(res, sessionError('field_unexpected', 'validation', `a library stage patch takes stageId, libraryId, name and files ("${key}")`, { path: `/${key}` }));
        return;
      }
    }
    const libraryId = value['libraryId'];
    if (typeof libraryId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryId)) {
      sendError(res, sessionError('field_value', 'validation', 'libraryId must use the id syntax', { path: '/libraryId' }));
      return;
    }
    const name = value['name'];
    if (name !== undefined && typeof name !== 'string') {
      sendError(res, sessionError('field_value', 'validation', 'name must be a string', { path: '/name' }));
      return;
    }
    const files = value['files'];
    if (name === undefined && files === undefined) {
      sendError(res, sessionError('field_missing', 'validation', 'a patch names files (or a name)', { path: '/files' }));
      return;
    }
    const fileOk = (f: unknown): boolean => {
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return false;
      const o = f as { path?: unknown; text?: unknown; append?: unknown };
      if (typeof o.path !== 'string' || Object.keys(o).some((k) => k !== 'path' && k !== 'text' && k !== 'append')) return false;
      if (o.append !== undefined) return o.append === true && typeof o.text === 'string';
      return typeof o.text === 'string' || o.text === null;
    };
    if (files !== undefined && (!Array.isArray(files) || files.length > 32 || !files.every(fileOk))) {
      sendError(res, sessionError('field_value', 'validation', 'files must be a list of up to 32 { path, text: string | null, append?: true } (append adds a piece to the staged file)', { path: '/files' }));
      return;
    }
    const patch = {
      libraryId,
      ...(typeof name === 'string' ? { name } : {}),
      ...(files !== undefined ? { files: (files as { path: string; text: string | null; append?: true }[]).map((f) => ({ path: f.path, text: f.text, ...(f.append === true ? { append: true } : {}) })) } : {}),
    };
    const r = service.stageScriptLibraryPatch(projectId, { ...(typeof stageId === 'string' ? { stageId } : {}), patch: patch as never });
    if (!r.ok) {
      sendError(res, workspaceError(r.error));
      return;
    }
    sendJson(res, 200, { ok: true, ...r.stage });
  };

  /**
   * `GET …/content/behaviors/:behaviorId/source` — the published
   * source-graph container of one behavior (the script editor loads it). The
   * digest comes from the behavior record; the bytes are the verified
   * immutable blob (`readSourceBlob`).
   */
  const behaviorSourceRead = (req: IncomingMessage, res: ServerResponse, projectId: string, behaviorId: string): void => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(behaviorId)) {
      sendError(res, sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }));
      return;
    }
    // includeDeclaration: the stored record (with its source facts, never bytes).
    const found = service.query({ op: 'queryBehaviors', projectId, args: { behaviorId, includeDeclaration: true, limit: 1, offset: 0 } }) as unknown as { ok: boolean; error?: CommandError; behaviors?: { behaviorId: string; source?: { sourceDigest: string } | null }[] };
    if (!found.ok && found.error?.code !== 'behavior_not_found') {
      sendError(res, workspaceError(found.error as CommandError));
      return;
    }
    const record = found.behaviors?.find((b) => b.behaviorId === behaviorId);
    if (record === undefined) {
      sendError(res, sessionError('field_value', 'not_found', `no behavior "${behaviorId}"`, { path: '/behaviorId' }), 404);
      return;
    }
    if (record.source === null || record.source === undefined) {
      sendJson(res, 200, { ok: true, behaviorId, source: null });
      return;
    }
    const read = service.readSourceBlob(projectId, { digest: record.source.sourceDigest });
    if (!read.ok) {
      sendError(res, workspaceError(read.error));
      return;
    }
    sendJson(res, 200, { ok: true, behaviorId, sourceDigest: read.digest, source: new TextDecoder().decode(read.bytes) });
  };

  return { libraryCheckRoute, libraryStageRoute, behaviorSourceRead };
}
