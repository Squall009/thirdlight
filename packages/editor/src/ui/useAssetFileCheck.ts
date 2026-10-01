/**
 * The editor's side of the file check: the game folder is the truth for
 * assets, so the backend is asked to bring the catalog in step with it when
 * the editor connects, when the window gets focus back (after a Blender
 * rebuild, a git checkout, a file moved in the file manager), after a publish
 * and on "check files". The check's changes arrive on the change feed; what
 * it could not fix becomes Problems rows.
 *
 * The missing files come from the backend's list (path, asset, who uses it),
 * read a page at a time after each check: a project with thousands of
 * missing files shows the first page and loads more on request.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { MissingAssetFile } from '@thirdlight/project-model';
import { CONTENT_ASSETS_LIMIT_DEFAULT } from '@thirdlight/protocol';

import { sourceIssuesFrom, type SourceIssue } from '../session/asset-sources';
import type { SessionClient } from '../session/client';

/** The missing files read so far (`total` counts them all). */
export interface MissingFilesView {
  readonly total: number;
  readonly files: readonly MissingAssetFile[];
  /** Read the next page. */
  readonly more: () => void;
}

export interface AssetFileCheck {
  /** Whether the project has a folder to check (every project whose files the backend can list). */
  checkable: boolean;
  /** The rows for Problems other than missing files (null until the first check). */
  sourceIssues: SourceIssue[] | null;
  /** The missing files (null until the first check). */
  missing: MissingFilesView | null;
  /** How many file problems there are (the Problems tab's count). */
  count: number;
  checking: boolean;
  checkFiles: () => Promise<void>;
}

export function useAssetFileCheck(clientRef: RefObject<SessionClient | null>, connection: string): AssetFileCheck {
  const [checkable, setCheckable] = useState(false);
  const [sourceIssues, setSourceIssues] = useState<SourceIssue[] | null>(null);
  const [missing, setMissing] = useState<{ total: number; files: readonly MissingAssetFile[] } | null>(null);
  const [checking, setChecking] = useState(false);
  // The check whose list is shown: a page read for an older check is dropped.
  const generation = useRef(0);
  const checkFiles = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setChecking(true);
    const r = await c.checkFiles();
    if (!r.ok) {
      setChecking(false);
      return;
    }
    const gen = (generation.current += 1);
    const first = await c.missingFiles(0, CONTENT_ASSETS_LIMIT_DEFAULT);
    setChecking(false);
    if (gen !== generation.current) return;
    if (first.ok) setMissing({ total: first.total, files: first.files });
    // The names of the assets the report names (the problems only: read by id from the index).
    const ids = [...new Set([...r.entries.map((e) => e.assetId), ...r.check.relocated.map((x) => x.assetId), ...r.check.reimported.map((x) => x.assetId), ...r.check.rebuilt.map((x) => x.assetId), ...r.check.failed.map((x) => x.assetId)])];
    const named = ids.length === 0 ? [] : await c.catalog.entries(ids).catch(() => []);
    const names = new Map(named.map((e) => [e.id, e.name] as const));
    // Missing files are listed from the backend's list (with their uses) when it could be read.
    setSourceIssues(sourceIssuesFrom(r.entries, names, r.check).filter((i) => !first.ok || i.kind !== 'missing'));
  }, [clientRef]);
  const more = useCallback(() => {
    const c = clientRef.current;
    if (!c || missing === null || missing.files.length >= missing.total) return;
    const gen = generation.current;
    void c.missingFiles(missing.files.length, CONTENT_ASSETS_LIMIT_DEFAULT).then((r) => {
      if (!r.ok || gen !== generation.current) return;
      setMissing((m) => (m === null || m.files.length !== missing.files.length ? m : { total: r.total, files: [...m.files, ...r.files] }));
    });
  }, [clientRef, missing]);
  useEffect(() => {
    if (connection !== 'connected') return;
    const c = clientRef.current;
    if (!c) return;
    let live = true;
    void c.listProjectFiles('').then((r) => {
      if (!live) return;
      setCheckable(r.ok);
      if (r.ok) void checkFiles();
      else {
        setSourceIssues(null);
        setMissing(null);
      }
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
  return {
    checkable,
    sourceIssues,
    missing: missing === null ? null : { ...missing, more },
    count: (sourceIssues?.length ?? 0) + (missing?.total ?? 0),
    checking,
    checkFiles,
  };
}
