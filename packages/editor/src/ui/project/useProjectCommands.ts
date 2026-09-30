/**
 * The project window's file commands through the session client (the one
 * mutation path): `moveResources`, `renameFolder`, `createFolder`, each one
 * command and one undo. Each resolves to the failure message, or null.
 *
 * Browser-only (React).
 */
import { useCallback, useMemo, type MutableRefObject } from 'react';

import type { SessionClient } from '../../session/client';
import type { ProjectItem } from '../../session/project-items';

export interface ProjectCommands {
  move(items: readonly ProjectItem[], folders: readonly string[], to: string): Promise<string | null>;
  renameFolder(folder: string, name: string): Promise<string | null>;
  createFolder(folder: string): Promise<string | null>;
}

export function useProjectCommands(clientRef: MutableRefObject<SessionClient | null>): ProjectCommands {
  const run = useCallback(
    async (op: string, args: Record<string, unknown>): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const res = await c.command(op, args, c.projection.revision);
      if (res.ok) return null;
      const r = res.response as { code?: string; message?: string; error?: { message?: string; code?: string } };
      // Everything named was already there: nothing to do.
      if ((r.code ?? r.error?.code) === 'no_change') return null;
      return r.error?.message ?? r.message ?? r.error?.code ?? r.code ?? 'unknown error';
    },
    [clientRef],
  );
  const move = useCallback(
    (items: readonly ProjectItem[], folders: readonly string[], to: string) =>
      run('moveResources', { ...(items.length > 0 ? { items: items.map((i) => ({ kind: i.kind, id: i.id })) } : {}), ...(folders.length > 0 ? { folders: [...folders] } : {}), to }),
    [run],
  );
  const renameFolder = useCallback((folder: string, name: string) => run('renameFolder', { folder, name }), [run]);
  const createFolder = useCallback((folder: string) => run('createFolder', { folder }), [run]);
  return useMemo(() => ({ move, renameFolder, createFolder }), [move, renameFolder, createFolder]);
}
