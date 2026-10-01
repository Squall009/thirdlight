/**
 * What the open document tabs show besides their document: which tab of each
 * kind is in front, the selection inside it (the right dock's Inspector shows
 * it), focus requests (a Problems click frames a node), per-tab views (a
 * controller's graph, an effect's system, a script's function) and the
 * visual scripts' checks, breakpoints and watches. Tabs whose document went
 * away close here.
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject } from 'react';
import type { SessionClient } from '../../session/client';
import { activeDoc, docKey, type WorkspaceAction, type WorkspaceState } from '../../session/editor-window';
import { graphsPortContext } from '../../session/material-graph';
import type { VisualScriptProblem } from '../script/VisualScriptDocument';
import type { ProjectContent } from '../shell/useProjectContent';

export function useDocumentState(
  clientRef: MutableRefObject<SessionClient | null>,
  workspace: WorkspaceState,
  workspaceDispatch: Dispatch<WorkspaceAction>,
  content: Pick<ProjectContent, 'graphs' | 'graphKinds' | 'graphsLoaded' | 'dialogues'>,
  catalogTick: number,
) {
  const { graphs, graphKinds, graphsLoaded, dialogues } = content;
  const [graphSelection, setGraphSelection] = useState<readonly string[]>([]);
  const [graphFocus, setGraphFocus] = useState<{ id: string; nonce: number } | null>(null);
  /** The graph of the tab in front of the editor window (its inspector shows beside it). */
  const activeGraphId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'graph' ? d.id : null;
  })();
  const openGraph = activeGraphId !== null ? (graphs.find((g) => g.graphId === activeGraphId) ?? null) : null;
  // A different graph in front starts with an empty selection.
  useEffect(() => setGraphSelection([]), [activeGraphId]);
  // The visual script in front (a behavior with a graph), its selection and a focus request.
  // The selection with the graph it belongs to (owner id): a tab switch shows no stale selection.
  const [visualSelectionOf, setVisualSelectionOf] = useState<{ owner: string; ids: readonly string[] }>({ owner: '', ids: [] });
  // A focus request names its script (a Problems click may open another script's tab first).
  const [visualFocus, setVisualFocus] = useState<{ behaviorId?: string; id: string; nonce: number } | null>(null);
  const activeVisualId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'visual-script' ? d.id : null;
  })();
  // Per script — the graph in front ("" = event graph, else a function id), the latest
  // compile problems (the Problems tab), breakpoints (scoped node ids) and watched variables.
  const [visualTargets, setVisualTargets] = useState<Readonly<Record<string, string>>>({});
  const [visualProblems, setVisualProblems] = useState<Readonly<Record<string, readonly VisualScriptProblem[]>>>({});
  const [visualBreakpoints, setVisualBreakpoints] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [visualWatches, setVisualWatches] = useState<Readonly<Record<string, readonly string[]>>>({});
  const activeVisualTarget = activeVisualId !== null ? (visualTargets[activeVisualId] ?? '') : '';
  const onVisualTarget = useCallback((behaviorId: string, target: string) => setVisualTargets((m) => (m[behaviorId] === target ? m : { ...m, [behaviorId]: target })), []);
  const onVisualProblems = useCallback((behaviorId: string, problems: readonly VisualScriptProblem[]) => setVisualProblems((m) => ({ ...m, [behaviorId]: problems })), []);
  const activeVisualOwner = activeVisualId === null ? '' : activeVisualTarget === '' ? activeVisualId : `${activeVisualId}#${activeVisualTarget}`;
  const visualSelection = visualSelectionOf.owner === activeVisualOwner ? visualSelectionOf.ids : [];
  // The Animator tabs — which graph of each controller is shown
  // (an animator owner id: base layer, `@n` layer, `#state` blend tree), the
  // selection of the one in front (the Inspector shows it) and a focus request.
  const [animatorTargets, setAnimatorTargets] = useState<Readonly<Record<string, string>>>({});
  const [animatorSelection, setAnimatorSelection] = useState<{ ownerId: string; ids: readonly string[] }>({ ownerId: '', ids: [] });
  const [animatorFocus, setAnimatorFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeAnimatorId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'animator' ? d.id : null;
  })();
  useEffect(() => {
    setAnimatorSelection({ ownerId: '', ids: [] });
    setAnimatorFocus(null);
  }, [activeAnimatorId]);
  // Sub-graph calls (material functions) read their ports from the project's graphs.
  const graphsContext = useMemo(() => graphsPortContext(graphs, graphKinds), [graphs, graphKinds]);
  // The graph material of the tab in front of the editor window (its node inspector shows beside it).
  const [materialSelection, setMaterialSelection] = useState<readonly string[]>([]);
  const [materialFocus, setMaterialFocus] = useState<{ id: string; nonce: number; materialId?: string } | null>(null);
  const activeMaterialId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'material' ? d.id : null;
  })();
  useEffect(() => {
    setMaterialSelection([]);
    // A focus request for the tab being opened (a Problems click) survives the switch.
    setMaterialFocus((f) => (f !== null && f.materialId === activeMaterialId ? f : null));
  }, [activeMaterialId]);
  // The effect of the tab in front of the editor window (the selected node of its shown system shows in the Inspector).
  const [effectSelection, setEffectSelection] = useState<readonly string[]>([]);
  const [effectFocus, setEffectFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeEffectId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'effect' ? d.id : null;
  })();
  useEffect(() => {
    setEffectSelection([]);
    setEffectFocus(null);
  }, [activeEffectId]);
  // The conversation of the tab in front of the editor window (its selected node shows in the Inspector).
  const [dialogueSelection, setDialogueSelection] = useState<readonly string[]>([]);
  const [dialogueFocus, setDialogueFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeDialogueId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'dialogue' ? d.id : null;
  })();
  useEffect(() => {
    setDialogueSelection([]);
    setDialogueFocus(null);
  }, [activeDialogueId]);
  // A graph that went away (deleted here, by MCP or undone) closes its tab.
  useEffect(() => {
    if (!graphsLoaded) return;
    const ids = new Set(graphs.map((g) => g.graphId));
    for (const d of workspace.docs) if (d.kind === 'graph' && !ids.has(d.id)) workspaceDispatch({ type: 'close', key: docKey(d) });
  }, [graphsLoaded, graphs, workspace.docs, workspaceDispatch]);
  const [effectSystems, setEffectSystems] = useState<Readonly<Record<string, string | null>>>({});
  // The conversations open in tabs are read by id; one the index no longer has closes its tab (after the first full state).
  useEffect(() => {
    const c = clientRef.current;
    const open = workspace.docs.filter((d) => d.kind === 'dialogue');
    if (!graphsLoaded || c === null || open.length === 0) return;
    let live = true;
    void c.catalog.ensureResources('dialogue', open.map((d) => d.id)).then(() => {
      if (!live) return;
      const held = new Set(c.getDialogues().map((d) => d.dialogueId));
      for (const d of open) if (!held.has(d.id) && c.catalog.resourceAbsent('dialogue', d.id)) workspaceDispatch({ type: 'close', key: docKey(d) });
    });
    return () => {
      live = false;
    };
  }, [graphsLoaded, dialogues, workspace.docs, workspaceDispatch, catalogTick, clientRef]);

  return {
    graphSelection, setGraphSelection, graphFocus, setGraphFocus, activeGraphId, openGraph,
    visualSelection, setVisualSelectionOf, visualFocus, setVisualFocus, activeVisualId, activeVisualTarget, visualTargets, onVisualTarget, visualProblems, onVisualProblems,
    visualBreakpoints, setVisualBreakpoints, visualWatches, setVisualWatches,
    animatorTargets, setAnimatorTargets, animatorSelection, setAnimatorSelection, animatorFocus, setAnimatorFocus, activeAnimatorId,
    graphsContext, materialSelection, setMaterialSelection, materialFocus, setMaterialFocus, activeMaterialId,
    effectSelection, setEffectSelection, effectFocus, setEffectFocus, activeEffectId, effectSystems, setEffectSystems,
    dialogueSelection, setDialogueSelection, dialogueFocus, setDialogueFocus, activeDialogueId,
  };
}

export type DocumentState = ReturnType<typeof useDocumentState>;
