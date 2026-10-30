/**
 * External edits: while an editor is connected, its project's envelope on
 * disk is compared with what this backend wrote. A change pauses writes and
 * is announced once; the editor resolves it (accept / discard).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { statusFor, type SessionError } from '@thirdlight/protocol';
import type { WorkspaceService } from '@thirdlight/workspace';

import { sendError, sendJson, workspaceError } from './http';
import type { RecordProblem } from './problems';
import type { SessionRegistry } from './sessions';

/** How often connected projects are compared with their files. */
const EXTERNAL_CHECK_MS = 1500;

export interface ExternalEditsDeps {
  readonly service: WorkspaceService;
  readonly sessions: SessionRegistry;
  readonly recordProblem: RecordProblem;
  readonly sendToProject: (projectId: string, frame: Record<string, unknown>) => void;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
}

export function createExternalEdits(deps: ExternalEditsDeps) {
  const { service, sessions, recordProblem, sendToProject } = deps;
  const announced = new Set<string>();

  const timer = setInterval(() => {
    for (const s of sessions.all()) {
      if (!s.connected) continue;
      const r = service.checkExternal(s.projectId);
      if (!r.ok || !r.pending) {
        announced.delete(s.projectId);
        continue;
      }
      if (announced.has(s.projectId)) continue;
      announced.add(s.projectId);
      const q = service.query({ op: 'queryProject', projectId: s.projectId }) as { ok: boolean; workspace?: unknown };
      const valid = (q.workspace as { pendingChange?: { externalValid?: boolean | null } } | undefined)?.pendingChange?.externalValid;
      recordProblem(
        s.projectId,
        'workspace',
        'external_change',
        valid === false ? 'The scene file was changed on disk and is invalid; editing is paused.' : 'The scene file was changed on disk; editing is paused.',
      );
      sendToProject(s.projectId, { type: 'workspace.externalChange', workspace: q.ok ? q.workspace : null });
    }
  }, EXTERNAL_CHECK_MS);

  /**
   * Accept or discard a pending external edit, from the project route or the
   * admin one alike: the connected editors reload either way.
   */
  const resolve = (projectId: string, action: 'accept' | 'discard') => {
    const result = action === 'accept' ? service.acceptExternalState(projectId) : service.discardExternalState(projectId);
    if (result.ok) {
      announced.delete(projectId);
      sendToProject(projectId, { type: 'workspace.resync' });
    }
    return result;
  };

  /** POST /api/v1/projects/:projectId/external/(accept|discard) — resolve an external edit. */
  const resolveRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, action: string): Promise<void> => {
    const authError = deps.requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const result = resolve(projectId, action === 'accept' ? 'accept' : 'discard');
    if (!result.ok) {
      sendError(res, workspaceError(result.error), statusFor(result.error.cls));
      return;
    }
    sendJson(res, 200, result);
  };

  return {
    resolve,
    resolveRoute,
    dispose(): void {
      clearInterval(timer);
    },
  };
}
