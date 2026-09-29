/**
 * The editor's side of the file check: the game folder is the truth for
 * assets, so the backend is asked to bring the catalog in step with it when
 * the editor connects, when the window gets focus back (after a Blender
 * rebuild, a git checkout, a file moved in the file manager), after a publish
 * and on "check files". The check's changes arrive on the change feed; what
 * it could not fix becomes Problems rows.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

import { sourceIssuesFrom, type SourceIssue } from '../session/asset-sources';
import type { SessionClient } from '../session/client';

export interface AssetFileCheck {
  /** Whether the project has a folder to check (every project whose files the backend can list). */
  checkable: boolean;
  /** The rows for Problems (null until the first check). */
  sourceIssues: SourceIssue[] | null;
  checking: boolean;
  checkFiles: () => Promise<void>;
}

export function useAssetFileCheck(clientRef: RefObject<SessionClient | null>, connection: string): AssetFileCheck {
  const [checkable, setCheckable] = useState(false);
  const [sourceIssues, setSourceIssues] = useState<SourceIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const checkFiles = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setChecking(true);
    const r = await c.checkFiles();
    setChecking(false);
    if (!r.ok) return;
    const names = new Map(c.content.listAssets().map((a) => [a.assetId, a.displayName]));
    setSourceIssues(sourceIssuesFrom(r.entries, names, r.check));
  }, [clientRef]);
  useEffect(() => {
    if (connection !== 'connected') return;
    const c = clientRef.current;
    if (!c) return;
    let live = true;
    void c.listProjectFiles('').then((r) => {
      if (!live) return;
      setCheckable(r.ok);
      if (r.ok) void checkFiles();
      else setSourceIssues(null);
    });
    return () => {
      live = false;
    };
  }, [connection, checkFiles, clientRef]);
  useEffect(() => {
    if (!checkable) return;
    const onFocus = (): void => void checkFiles();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [checkable, checkFiles]);
  return { checkable, sourceIssues, checking, checkFiles };
}
