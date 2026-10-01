/**
 * The commands of the documents the dock lists and the centre tabs edit:
 * materials, the environment, conversations, effects, timelines, UI
 * documents and themes, standalone graphs and every graph edit (queued, so a
 * burst of gestures never races its own revision), with each list's last
 * refusal.
 */
import { useCallback, useRef, useState, type Dispatch } from 'react';
import { mergeDocumentEdit } from '../../session/own-commands';
import type { EnvironmentConfig, MaterialDef } from '@thirdlight/project-model';
import type { TimelinePreviewValue } from '../timeline/TimelineDocument';
import { newUiDocument, uniqueDocId } from '../../session/ui-edit';
import type { GraphOp } from '../../graph/model';
import type { WorkspaceAction } from '../../session/workspace-tabs';
import { refusal, type ClientRef, type ViewportRef } from '../shell/commands';

export interface DocumentCommandsDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  setGraphFocus: (focus: { id: string; nonce: number } | null) => void;
}

export function useDocumentCommands(deps: DocumentCommandsDeps) {
  const { clientRef, viewportRef, workspaceDispatch, setGraphFocus } = deps;
  const [graphsError, setGraphsError] = useState<string | null>(null);
  const graphQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [effectError, setEffectError] = useState<string | null>(null);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  // Edits made on `base` (what the panel showed) are re-applied onto the
  // document as it is at send time, so a quick second edit keeps the first (own-commands.ts).
  const saveMaterial = useCallback(async (material: MaterialDef, base: MaterialDef | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { material: MaterialDef } => ({ material: mergeDocumentEdit(base, material, c.getMaterials().find((m) => m.materialId === material.materialId) ?? null) ?? material });
    setMaterialError(refusal(await c.command('setMaterial', build, c.projection.revision)));
  }, [clientRef]);
  const deleteMaterial = useCallback(async (materialId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const err = refusal(await c.command('deleteMaterial', { materialId }, c.projection.revision));
    setMaterialError(err);
    if (err === null) setSelectedMaterialId(null);
  }, [clientRef]);
  // Dialogue commands (one undo step each).
  const dialogueCommand = useCallback(async (op: 'setDialogue' | 'deleteDialogue' | 'setSpeaker' | 'deleteSpeaker' | 'setDialogueSettings', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setDialogueError(err);
    return err === null;
  }, [clientRef]);
  // Effect commands (one undo step each).
  const effectCommand = useCallback(async (op: 'setEffect' | 'deleteEffect' | 'renameEffect', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setEffectError(err);
    return err === null;
  }, [clientRef]);
  // Timeline commands (one undo step each; a key drag is one setTimeline).
  const timelineCommand = useCallback(async (op: 'setTimeline' | 'deleteTimeline', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setTimelineError(err);
    return err === null;
  }, [clientRef]);
  // The timeline tab's scrub preview in the Scene view.
  const onTimelinePreview = useCallback((p: TimelinePreviewValue | null) => {
    viewportRef.current?.setTimelinePreview(p);
  }, [viewportRef]);
  // UI document/theme commands go out one at a time (each after the previous is applied
  // here), so a queued edit is always made on the latest stored value. Resolves with a refusal or null.
  const uiQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const uiCommand = useCallback((op: 'setUiDocument' | 'deleteUiDocument' | 'setUiTheme' | 'deleteUiTheme', args: Record<string, unknown>): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      const c = clientRef.current;
      if (!c) return 'not connected';
      const res = await c.command(op, args, c.projection.revision);
      if (res.ok) {
        for (let i = 0; i < 150 && c.projection.revision < res.revision; i++) await new Promise((r) => setTimeout(r, 20));
      }
      return refusal(res);
    };
    const next = uiQueueRef.current.then(run, run);
    uiQueueRef.current = next;
    return next;
  }, [clientRef]);
  const createUiDocument = useCallback(
    async (name: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const uiDocumentId = uniqueDocId(name, c.getUiDocuments().map((d) => d.uiDocumentId), 'ui');
      const err = await uiCommand('setUiDocument', { document: newUiDocument(uiDocumentId, name) });
      setUiError(err);
      if (err === null) workspaceDispatch({ type: 'open', doc: { kind: 'ui-document', id: uiDocumentId } });
    },
    [clientRef, uiCommand, workspaceDispatch],
  );
  // Graph edits go out one at a time (each after the previous is
  // applied here), so a burst of gestures never races its own revision.
  const sendGraphEdit = useCallback((owner: { kind: string; id: string }, ops: GraphOp[]): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      const c = clientRef.current;
      if (!c) return 'not connected';
      const res = await c.command('graphEdit', { owner, ops }, c.projection.revision);
      if (res.ok) {
        for (let i = 0; i < 100 && c.projection.revision < res.revision; i++) await new Promise((r) => setTimeout(r, 20));
      }
      return refusal(res);
    };
    const p = graphQueueRef.current.then(run, run);
    graphQueueRef.current = p;
    return p;
  }, [clientRef]);
  const graphDocCommand = useCallback(async (op: 'setGraph' | 'deleteGraph', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setGraphsError(err);
    return err === null;
  }, [clientRef]);
  const showGraph = useCallback(
    (graphId: string, focusId?: string) => {
      workspaceDispatch({ type: 'open', doc: { kind: 'graph', id: graphId } });
      if (focusId !== undefined) setGraphFocus({ id: focusId, nonce: Date.now() });
    },
    [setGraphFocus, workspaceDispatch],
  );
  const saveEnvironment = useCallback(async (env: EnvironmentConfig, base: EnvironmentConfig | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { environment: EnvironmentConfig } => ({ environment: mergeDocumentEdit(base, env, c.getEnvironment()) ?? env });
    setMaterialError(refusal(await c.command('setEnvironment', build, c.projection.revision)));
  }, [clientRef]);

  return {
    graphsError, effectError, dialogueError, setDialogueError, timelineError, uiError, setUiError, selectedMaterialId, setSelectedMaterialId, materialError,
    saveMaterial, deleteMaterial, saveEnvironment, dialogueCommand, effectCommand, timelineCommand, onTimelinePreview, uiCommand, createUiDocument, sendGraphEdit, graphDocCommand, showGraph,
  };
}

export type DocumentCommands = ReturnType<typeof useDocumentCommands>;
