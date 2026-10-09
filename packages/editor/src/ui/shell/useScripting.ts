/**
 * Scripts: the Behaviors panel (trust, staging, publication, declarations),
 * the script and visual-script tabs (check, publish, new visual scripts) and
 * the shared script libraries (drafts, staged saves committed once, "Save
 * all"). A digest not acknowledged yet asks first or is acknowledged with
 * the ordinary command.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import type { BehaviorDeclarationView } from '../../session/prefab-projection';
import { initialPublicationState, publicationFailed, published, sourceStaged, trustObserved, type BehaviorPublicationState } from '../../session/behavior-publication';
import type { ScriptLibrary, PropertyDeclaration, TrustEntry } from '@thirdlight/project-model';
import type { BehaviorPanelProps } from '../BehaviorPanel';
import type { ScriptCheckResult, ScriptDraft, ScriptPublishOutcome } from '../script/ScriptDocument';
import { publishScriptSource } from '../../session/script-publish';
import { activeDoc, type WorkspaceAction, type WorkspaceState } from '../../session/editor-window';
import type { DeclarationSave } from '../DeclarationEditor';
import type { SourceFocus, SourceLocation } from '../../session/source-location';
import { savedDraft, type LibraryDraft, type LibrarySaveOutcome } from '../script/LibraryDocument';
import { fitsOneRequest, libraryFilePatch, libraryStagePatches, type LibraryStagePatch } from '../../session/script-sources';
import type { VisualScriptCheckResult } from '../script/VisualScriptDocument';
import { newBehaviorGraph } from '../../session/behavior-graph';
import type { PlayInfo } from './usePlaySession';
import { refusal, type ClientRef, type UiError } from './commands';

export interface ScriptingDeps {
  clientRef: ClientRef;
  behaviorViews: BehaviorDeclarationView[];
  scriptLibraries: readonly ScriptLibrary[];
  refreshEntities: () => void;
  workspace: WorkspaceState;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  openDocument: (kind: string, id: string) => void;
  playInfo: PlayInfo | null;
  /** The acknowledged script sources (the backend's list). */
  trustEntries: readonly TrustEntry[];
}

export function useScripting(deps: ScriptingDeps) {
  const { clientRef, behaviorViews, scriptLibraries, refreshEntities, workspace, workspaceDispatch, openDocument, playInfo, trustEntries } = deps;
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [selectedBehaviorId, setSelectedBehaviorId] = useState<string | null>(null);
  const [publication, setPublication] = useState<BehaviorPublicationState>(() => initialPublicationState());
  const [sourceDraft, setSourceDraft] = useState('');
  const [behaviorError, setBehaviorError] = useState<UiError | null>(null);
  const [trustError, setTrustError] = useState<{ sourceDigest: string; message: string } | null>(null);

  // The publish controls ask for an acknowledgment only when the project's list lacks the digest
  // (a revocation, or a list read at a full state, replaces what this page saw acknowledged).
  useEffect(() => setPublication((s) => trustObserved(s, trustEntries)), [trustEntries]);

  /** Withdraw an acknowledged source (refused while a published script uses it; one undo brings it back). */
  const revokeTrust = useCallback(
    async (sourceDigest: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const err = refusal(await c.command('revokeBehaviorTrust', { sourceDigest }, c.projection.revision));
      setTrustError(err === null ? null : { sourceDigest, message: err });
    },
    [clientRef],
  );

  const stageBehaviorSource = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setBehaviorError(null);
    const bytes = new TextEncoder().encode(sourceDraft);
    try {
      JSON.parse(sourceDraft);
    } catch (e) {
      setPublication((s) =>
        publicationFailed(s, {
          code: 'behavior_source_invalid',
          message: `staged source is not JSON: ${String((e as Error).message).slice(0, 200)}`,
        }),
      );
      return;
    }
    const staged = await c.stageBehaviorSource(bytes);
    if (!staged.ok) {
      setPublication((s) => publicationFailed(s, staged.error));
      return;
    }
    setPublication((s) => sourceStaged(s, staged));
  }, [clientRef, sourceDraft]);

  const acknowledgeDigest = useCallback(
    async (sourceDigest: string) => {
      const c = clientRef.current;
      if (!c) return;
      setBehaviorError(null);
      const res = await c.acknowledgeBehaviorTrust(sourceDigest, c.projection.revision);
      if (!res.ok) {
        const r = res.response;
        setPublication((s) =>
          publicationFailed(s, r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code }),
        );
        return;
      }
      // Optimistic convergence: the authoritative record arrives with the same
      // command's `mutation.applied` change; the observed set is also used.
      setPublication((s) => trustObserved(s, [...c.prefabs.listTrust(), { sourceDigest, acknowledgedRevision: res.revision }]));
      refreshEntities();
    },
    [clientRef, refreshEntities],
  );

  const publishStagedSource = useCallback(async () => {
    const c = clientRef.current;
    const view = behaviorViews.find((b) => b.behaviorId === selectedBehaviorId);
    const staged = publication.staged;
    if (!c || !view || !staged) return;
    setBehaviorError(null);
    const res = await c.publishBehaviorSource(
      {
        behaviorId: view.behaviorId,
        displayName: view.displayName,
        declaration: view.declaration,
        sourceDigest: staged.digest,
        sourceByteLength: staged.byteLength,
        stageId: staged.stageId,
      },
      c.projection.revision,
    );
    if (!res.ok) {
      const r = res.response;
      setPublication((s) =>
        publicationFailed(s, r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code }),
      );
      return;
    }
    setPublication((s) => published(s, { revision: res.revision }));
    refreshEntities();
  }, [clientRef, behaviorViews, publication.staged, refreshEntities, selectedBehaviorId]);

  // ---- The script editor tab ------------------------------------

  /** Unpublished script edits per behavior (survive tab switches; not project data). */
  const scriptDrafts = useRef(new Map<string, ScriptDraft>()).current;

  const checkScript = useCallback(async (behaviorId: string, bytes: Uint8Array, declaration: PropertyDeclaration | null): Promise<ScriptCheckResult> => {
    const c = clientRef.current;
    if (!c) return { ok: false, error: { code: 'disconnected', message: 'not connected' } };
    return c.checkBehaviorSource(behaviorId, bytes, declaration);
  }, [clientRef]);

  /**
   * Publish a script: stage the container, then — when its digest is not
   * acknowledged yet — ask first (`needs-ack`) or acknowledge it (the
   * ordinary `acknowledgeBehaviorTrust` command), then the ordinary source
   * route (compile + one `publishBehavior` command).
   */
  const publishScript = useCallback(
    async (behaviorId: string, bytes: Uint8Array, acknowledge: boolean): Promise<ScriptPublishOutcome> => {
      const c = clientRef.current;
      const view = behaviorViews.find((b) => b.behaviorId === behaviorId);
      if (!c || !view) return { kind: 'failed', message: 'the behavior is not available' };
      const out = await publishScriptSource(c, view, bytes, acknowledge, (digest, revision) => setPublication((s) => trustObserved(s, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: revision }])));
      if (out.kind === 'published') refreshEntities();
      return out;
    },
    [behaviorViews, clientRef, refreshEntities],
  );

  // ---- Shared script libraries --------------------------------------

  /** Unsaved library edits per library (survive tab switches; not project data). */
  const libraryDrafts = useRef(new Map<string, LibraryDraft>()).current;
  /** The published scripts that import a library (their source pins it). */
  const libraryDependents = useCallback((libraryId: string): string[] => behaviorViews.filter((b) => b.source?.libraries?.some((p) => p.libraryId === libraryId) === true).map((b) => b.behaviorId), [behaviorViews]);
  const libraryCommand = useCallback(async (op: 'setScriptLibrary' | 'deleteScriptLibrary', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setLibraryError(err);
    return err === null;
  }, [clientRef]);
  /**
   * Save a library's changed files: one setScriptLibrary command (the backend
   * recompiles the scripts that import it in the same command). A library
   * digest those scripts would link that is not acknowledged yet asks first
   * (`needs-ack`) or is acknowledged (the ordinary acknowledgeBehaviorTrust
   * command) and the save retried.
   */
  /**
   * Stage these patches (several requests, nothing changes yet)
   * and commit them as one change: one revision, one undo, each script that
   * imports a changed library compiled once. A digest those scripts will
   * link that is not acknowledged yet asks first (the stage is dropped and
   * made again on the acknowledged retry).
   */
  const commitLibraryPatches = useCallback(
    async (patches: readonly LibraryStagePatch[], acknowledge: boolean): Promise<LibrarySaveOutcome> => {
      const c = clientRef.current;
      if (!c) return { kind: 'failed', message: 'not connected' };
      let stageId: string | undefined;
      for (const patch of patches) {
        const r = await c.stageScriptLibrary({ ...(stageId !== undefined ? { stageId } : {}), libraryId: patch.libraryId, files: patch.files });
        if (!r.ok) {
          if (stageId !== undefined) await c.stageScriptLibrary({ stageId, discard: true });
          return { kind: 'failed', message: `${r.error.code}: ${r.error.message}` };
        }
        stageId = r.stageId;
      }
      if (stageId === undefined) return { kind: 'failed', message: 'nothing to save' };
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await c.command('commitScriptLibraryStage', { stageId }, c.projection.revision);
        if (res.ok) {
          refreshEntities();
          return { kind: 'saved', revision: res.revision, recompiled: (res.libraryStage?.dependents ?? []).map((d) => d.behaviorId), patches: patches.length };
        }
        const r = res.response;
        if (!r.ok && r.code === 'behavior_trust_unacknowledged' && r.sourceDigest !== undefined) {
          if (!acknowledge) {
            await c.stageScriptLibrary({ stageId, discard: true });
            return { kind: 'needs-ack', digest: r.sourceDigest };
          }
          const digest = r.sourceDigest;
          const ack = await c.acknowledgeBehaviorTrust(digest, c.projection.revision);
          if (!ack.ok) {
            const a = ack.response;
            return { kind: 'failed', message: a.ok ? 'the acknowledgment was not recorded' : `${a.code}: ${a.message ?? a.code}` };
          }
          setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: ack.revision }]));
          continue;
        }
        await c.stageScriptLibrary({ stageId, discard: true });
        return r.ok ? { kind: 'failed', message: 'the libraries were not saved' } : { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}`, ...(r.diagnostics !== undefined ? { diagnostics: r.diagnostics } : {}) };
      }
      await c.stageScriptLibrary({ stageId, discard: true });
      return { kind: 'failed', message: 'the libraries were not saved (trust acknowledgments kept changing)' };
    },
    [clientRef, refreshEntities],
  );

  const saveLibrary = useCallback(
    async (libraryId: string, files: { path: string; text: string | null }[], acknowledge: boolean): Promise<LibrarySaveOutcome> => {
      const c = clientRef.current;
      if (!c) return { kind: 'failed', message: 'not connected' };
      // A change larger than one request goes in several staged patches, committed once.
      if (!fitsOneRequest(files)) return commitLibraryPatches(libraryStagePatches(libraryId, files), acknowledge);
      const recompiled = libraryDependents(libraryId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await c.command('setScriptLibrary', { libraryId, files }, c.projection.revision);
        if (res.ok) {
          refreshEntities();
          return { kind: 'saved', revision: res.revision, recompiled };
        }
        const r = res.response;
        if (r.ok) return { kind: 'failed', message: 'the library was not saved' };
        if (r.code === 'behavior_trust_unacknowledged' && r.sourceDigest !== undefined) {
          if (!acknowledge) return { kind: 'needs-ack', digest: r.sourceDigest };
          const digest = r.sourceDigest;
          const ack = await c.acknowledgeBehaviorTrust(digest, c.projection.revision);
          if (!ack.ok) {
            const a = ack.response;
            return { kind: 'failed', message: a.ok ? 'the acknowledgment was not recorded' : `${a.code}: ${a.message ?? a.code}` };
          }
          setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: ack.revision }]));
          continue;
        }
        return { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}`, ...(r.diagnostics !== undefined ? { diagnostics: r.diagnostics } : {}) };
      }
      return { kind: 'failed', message: 'the library was not saved (trust acknowledgments kept changing)' };
    },
    [clientRef, commitLibraryPatches, libraryDependents, refreshEntities],
  );

  /** A source position to show in a script or library tab (the Console's locations). */
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  /** Bumped when a library draft becomes dirty or clean (the Libraries panel's "Save all"). */
  const [libraryDraftsVersion, setLibraryDraftsVersion] = useState(0);
  const onLibraryDraftChange = useCallback(() => setLibraryDraftsVersion((v) => v + 1), []);
  const [saveAllOutcome, setSaveAllOutcome] = useState<LibrarySaveOutcome | { kind: 'working' } | null>(null);
  /** The libraries with unsaved edits (their drafts differ from the stored files). */
  const dirtyLibraries = useMemo(
    () => scriptLibraries.filter((l) => libraryDrafts.get(l.libraryId)?.dirty === true).map((l) => l.libraryId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- libraryDrafts is a mutable map; libraryDraftsVersion signals its changes
    [scriptLibraries, libraryDraftsVersion],
  );
  /**
   * "Save all" — every library with unsaved edits staged in one
   * stage (several patches) and committed once: one revision, one undo, the
   * scripts that import any of them compiled once each.
   */
  const saveAllLibraries = useCallback(
    async (acknowledge: boolean): Promise<void> => {
      const patches: LibraryStagePatch[] = [];
      const saved: { libraryId: string; draft: LibraryDraft }[] = [];
      for (const lib of scriptLibraries) {
        const draft = libraryDrafts.get(lib.libraryId);
        if (draft?.dirty !== true) continue;
        const files = libraryFilePatch(lib.files, draft.files);
        if (files.length === 0) continue;
        patches.push(...libraryStagePatches(lib.libraryId, files));
        saved.push({ libraryId: lib.libraryId, draft });
      }
      if (patches.length === 0) return;
      setSaveAllOutcome({ kind: 'working' });
      const r = await commitLibraryPatches(patches, acknowledge);
      if (r.kind === 'saved') {
        for (const x of saved) libraryDrafts.set(x.libraryId, savedDraft(x.draft));
        setLibraryDraftsVersion((v) => v + 1);
      }
      setSaveAllOutcome(r);
    },
    [scriptLibraries, libraryDrafts, commitLibraryPatches],
  );

  /** The declaration editor's save — one ordinary publishBehavior command. */
  const saveDeclaration = useCallback(
    async (save: DeclarationSave): Promise<boolean> => {
      const c = clientRef.current;
      if (!c) return false;
      setBehaviorError(null);
      const res = await c.publishBehaviorDeclaration(save, c.projection.revision);
      if (!res.ok) {
        const r = res.response;
        setBehaviorError(r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code });
        return false;
      }
      setSelectedBehaviorId(save.behaviorId);
      refreshEntities();
      return true;
    },
    [clientRef, refreshEntities],
  );

  // ---- Visual scripts ------------------------------------------------

  const checkVisualScript = useCallback(async (behaviorId: string): Promise<VisualScriptCheckResult> => {
    const c = clientRef.current;
    if (!c) return { ok: false, error: { code: 'disconnected', message: 'not connected' } };
    return c.checkBehaviorGraph(behaviorId);
  }, [clientRef]);

  /**
   * Publish a visual script: compile the stored graph (its digest), ask for
   * or record the trust acknowledgment of a new digest, then the source route
   * with `graph: true` (the backend generates the same bytes and runs one
   * publishBehavior command).
   */
  const publishVisualScript = useCallback(
    async (behaviorId: string, acknowledge: boolean): Promise<ScriptPublishOutcome> => {
      const c = clientRef.current;
      const view = behaviorViews.find((b) => b.behaviorId === behaviorId);
      if (!c || !view) return { kind: 'failed', message: 'the behavior is not available' };
      const checked = await c.checkBehaviorGraph(behaviorId);
      if (!checked.ok) return { kind: 'failed', message: `${checked.error.code}: ${checked.error.message}` };
      if (!checked.compiled) return { kind: 'failed', message: checked.diagnostics[0]?.message ?? checked.code };
      let revision = c.projection.revision;
      if (!c.acknowledgedDigests().includes(checked.sourceDigest)) {
        if (!acknowledge) return { kind: 'needs-ack', digest: checked.sourceDigest };
        const ack = await c.acknowledgeBehaviorTrust(checked.sourceDigest, revision);
        if (!ack.ok) {
          const r = ack.response;
          return { kind: 'failed', message: r.ok ? 'the acknowledgment was not recorded' : `${r.code}: ${r.message ?? r.code}` };
        }
        revision = ack.revision;
        setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: checked.sourceDigest, acknowledgedRevision: ack.revision }]));
      }
      const res = await c.publishBehaviorGraph(behaviorId, view.displayName, revision);
      if (!res.ok) {
        if (res.code === 'behavior_trust_unacknowledged' && res.sourceDigest !== undefined) return { kind: 'needs-ack', digest: res.sourceDigest };
        return { kind: 'failed', message: `${res.code}: ${res.message}` };
      }
      refreshEntities();
      return { kind: 'published', revision: res.revision, digest: res.sourceDigest };
    },
    [behaviorViews, clientRef, refreshEntities],
  );

  /**
   * A new visual script: a behavior created with a graph holding one On start
   * node (no variable needed — a behavior may declare no
   * property). One publishBehavior command.
   */
  const createVisualScript = useCallback(
    async (displayName: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'visual-script';
      let behaviorId = base;
      for (let i = 2; behaviorViews.some((b) => b.behaviorId === behaviorId); i++) behaviorId = `${base}-${i}`;
      setBehaviorError(null);
      const template = newBehaviorGraph();
      const res = await c.command('publishBehavior', { behaviorId, displayName, mode: 'declaration-create', declaration: template.declaration, graph: template.graph }, c.projection.revision);
      const err = refusal(res);
      if (err !== null) {
        setBehaviorError({ code: 'refused', message: err });
        return;
      }
      for (let i = 0; i < 100 && c.projection.revision < (res as { revision: number }).revision; i++) await new Promise((r) => setTimeout(r, 20));
      refreshEntities();
      workspaceDispatch({ type: 'open', doc: { kind: 'visual-script', id: behaviorId } });
    },
    [behaviorViews, clientRef, refreshEntities, workspaceDispatch],
  );
  // A script tab in front selects its behavior (the source
  // stage/acknowledge/publish flow acts on the selected behavior).
  const activeScript = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'script' ? d.id : null;
  })();
  useEffect(() => {
    if (activeScript !== null) setSelectedBehaviorId(activeScript);
  }, [activeScript]);
  /** A script or library position (from the Console) opened in its code editor tab at the line. */
  const openSource = (loc: SourceLocation): void => {
    const id = loc.libraryId ?? loc.behaviorId;
    if (id === undefined) return;
    openDocument(loc.libraryId !== undefined ? 'script-library' : 'script', id);
    setSourceFocus({ id, path: loc.path, line: loc.line, column: loc.column, nonce: Date.now() });
  };
  const behaviorProps: BehaviorPanelProps = {
    behaviors: behaviorViews,
    selectedBehaviorId,
    publication,
    sourceDraft,
    activePlay: playInfo ? { snapshotId: playInfo.snapshotId, revision: playInfo.revision } : null,
    error: behaviorError,
    onSelect: (id) => {
      setSelectedBehaviorId(id);
      setBehaviorError(null);
    },
    onSourceDraft: setSourceDraft,
    onStage: () => void stageBehaviorSource(),
    onAcknowledge: (digest) => void acknowledgeDigest(digest),
    onPublishSource: () => void publishStagedSource(),
    onSaveDeclaration: saveDeclaration,
    // A visual script opens as a Graph tab, any other behavior as a Script tab.
    onOpen: (id) => openDocument(behaviorViews.find((b) => b.behaviorId === id)?.graph !== undefined ? 'visual-script' : 'script', id),
    onCreateVisualScript: (name) => void createVisualScript(name),
  };

  return {
    selectedBehaviorId, publication, behaviorError, behaviorProps, scriptDrafts, checkScript, publishScript, libraryDrafts, libraryDependents, libraryCommand, libraryError,
    saveLibrary, sourceFocus, openSource, libraryDraftsVersion, onLibraryDraftChange, saveAllOutcome, dirtyLibraries, saveAllLibraries, saveDeclaration,
    checkVisualScript, publishVisualScript, createVisualScript, revokeTrust, trustError,
  };
}

export type Scripting = ReturnType<typeof useScripting>;
