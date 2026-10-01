/**
 * The Problems tab's diagnostics computed in the editor: every graph's
 * problems (the kind's rules), the open visual scripts' compile problems and
 * the graph materials' problems (in the editor worker, inline without one).
 */
import { useEffect, useMemo, type MutableRefObject } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';
import type { SessionClient } from '../../session/client';
import { functionName as scriptFunctionName, splitScoped } from '../../session/visual-debug';
import { graphIssuesOf, materialIssuesOf, type GraphIssue, type MaterialIssue } from '../../workers/problems';
import { useWorkerJob } from '../../workers/use-worker-job';
import { stringsIn } from '../catalog/catalog-context';
import type { VisualScriptProblem } from '../script/VisualScriptDocument';
import type { ProjectContent } from './useProjectContent';

/** The Problems tab's graph diagnostics before the first worker result. */
const NO_GRAPH_ISSUES: readonly GraphIssue[] = [];
const NO_MATERIAL_ISSUES: readonly MaterialIssue[] = [];

export function useEditorProblems(
  clientRef: MutableRefObject<SessionClient | null>,
  content: Pick<ProjectContent, 'graphs' | 'graphKinds' | 'behaviorViews'> & { materials: MaterialDef[] },
  visualProblems: Readonly<Record<string, readonly VisualScriptProblem[]>>,
  catalogTick: number,
) {
  const { graphs, graphKinds, behaviorViews, materials } = content;
  // Every graph's problems (the kind's rules), for the Problems tab.
  // Computed in the editor worker (inline without one).
  const graphIssues = useWorkerJob('graphIssues', () => ({ graphs, kinds: graphKinds }), (i) => graphIssuesOf(i.graphs, i.kinds), NO_GRAPH_ISSUES, [graphs, graphKinds]);
  // Visual scripts' compile problems (from the last check of each open script), for the Problems tab.
  const scriptIssues = useMemo(
    () =>
      Object.entries(visualProblems).flatMap(([behaviorId, list]) => {
        const b = behaviorViews.find((x) => x.behaviorId === behaviorId);
        if (b === undefined || b.graph === undefined) return [];
        return list.map((p, i) => {
          const s = p.nodeId !== undefined ? splitScoped(p.nodeId) : null;
          const fn = s !== null && s.target !== '' ? b.functions?.find((f) => f.functionId === s.target) : undefined;
          const g = s === null ? undefined : s.target === '' ? b.graph : fn?.graph;
          const kindDef = s !== null && s.target !== '' ? graphKinds['behavior-function'] : graphKinds['behavior'];
          const node = s !== null ? g?.nodes.find((n) => n.id === s.id) : undefined;
          const label = node !== undefined ? (kindDef?.nodes.find((d) => d.type === node.type)?.label ?? node.type) : null;
          return {
            key: `script:${behaviorId}:${i}`,
            graphId: behaviorId,
            graphName: `${b.displayName}${fn !== undefined ? ` › ${scriptFunctionName(fn)}` : ''}`,
            ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}),
            nodeLabel: label,
            severity: p.severity,
            message: p.message,
            behaviorId,
          };
        });
      }),
    [visualProblems, behaviorViews, graphKinds],
  );
  // Graph materials' problems (the kind's rules and the compiler's), for the Problems tab.
  // Computed in the editor worker (inline without one).
  // The textures the materials name, read by id: one not read yet counts as there (it is checked once read).
  const materialTextureIds = useMemo(() => {
    const c = clientRef.current;
    const ids = [...new Set(stringsIn(materials))];
    return ids.filter((id) => {
      const a = c?.content.getAsset(id);
      return a !== undefined ? a.kind === 'texture' : c === null || c === undefined || !c.catalog.assetAbsent(id);
    });
    // `catalogTick` stands for the summaries read since.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the summaries live in the client; the tick says they changed
  }, [materials, catalogTick]);
  useEffect(() => {
    void clientRef.current?.catalog.ensureAssets(stringsIn(materials));
  }, [materials, catalogTick, clientRef]);
  const materialIssues = useWorkerJob(
    'materialIssues',
    () => ({ materials, graphs, kinds: graphKinds, textureIds: materialTextureIds }),
    (i) => materialIssuesOf(i.materials, i.graphs, i.kinds, i.textureIds),
    NO_MATERIAL_ISSUES,
    [materials, graphs, graphKinds, materialTextureIds],
  );
  return { graphIssues, scriptIssues, materialIssues };
}

export type EditorProblems = ReturnType<typeof useEditorProblems>;
