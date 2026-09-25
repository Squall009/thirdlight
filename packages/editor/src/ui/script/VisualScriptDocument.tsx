/**
 * Phase 19.0: a visual script (a behavior whose source is a graph) as a
 * "Graph: <behavior>" centre tab.
 *
 * The graph is the generic GraphEditor on the `behavior` graph kind: every
 * gesture is one `graphEdit {owner: {kind: "behavior", id}}` (one undo step;
 * MCP edits show up here). The selected node's fields are edited in the
 * right-dock Inspector (GraphInspector).
 *
 * Beside it: the compile check of the stored graph (the backend generates
 * TypeScript and runs the one behavior compiler; nothing is written) with its
 * problems — click one to frame its node — and Publish, which asks for the
 * trust acknowledgment of the exact digest when it is new and then publishes
 * through the ordinary source route (one `publishBehavior` command).
 *
 * 19.2 replaces this with the full visual-script editor (variable list,
 * compile errors drawn on nodes, Play debugging). Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import type { GraphDocument } from '@thirdlight/project-model';
import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE, type CompileDiagnosticView } from '../../session/behavior-publication';
import { behaviorPortContext } from '../../session/behavior-graph';
import type { BehaviorDeclarationView } from '../../session/prefab-projection';
import type { ScriptPublishOutcome } from './ScriptDocument';

export type VisualScriptCheckResult =
  | { ok: true; compiled: true; sourceDigest: string; warnings: { message: string; nodeId?: string }[] }
  | { ok: true; compiled: false; code: string; diagnostics: CompileDiagnosticView[]; warnings: { message: string; nodeId?: string }[] }
  | { ok: false; error: { code: string; message: string } };

export interface VisualScriptDocumentProps {
  behaviorId: string;
  behavior: BehaviorDeclarationView | null;
  /** The `behavior` graph kind (from the backend's kind table). */
  kind: GraphKindDef | undefined;
  /** Phase 19.1: the project's standalone graphs (shared functions) and the kind table (call nodes read their ports from them). */
  graphs: readonly GraphDocument[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  activePlay: { snapshotId: string; revision: number } | null;
  onEdit: (behaviorId: string, ops: GraphOp[]) => Promise<string | null>;
  onSelection: (ids: readonly string[]) => void;
  focus: { id: string; nonce: number } | null;
  /** Frame and select a node (a problem was clicked). */
  onFocus: (nodeId: string) => void;
  check: (behaviorId: string) => Promise<VisualScriptCheckResult>;
  publish: (behaviorId: string, acknowledge: boolean) => Promise<ScriptPublishOutcome>;
}

type CheckState = { status: 'idle' | 'checking' } | { status: 'done'; result: VisualScriptCheckResult };

export function VisualScriptDocument(p: VisualScriptDocumentProps): JSX.Element {
  const { behaviorId, behavior, check } = p;
  const [state, setState] = useState<CheckState>({ status: 'idle' });
  const [publishing, setPublishing] = useState<ScriptPublishOutcome | { kind: 'working' } | null>(null);
  const seq = useRef(0);
  const graphKey = behavior?.graph !== undefined ? JSON.stringify([behavior.graph, behavior.functions ?? []]) : '';
  // The graph's variables type its Get/Set ports (the framework's data-dependent ports).
  const portContext = useMemo(() => behaviorPortContext(behavior?.graph, { functions: behavior?.functions, graphs: p.graphs, kinds: p.kinds }), [behavior?.graph, behavior?.functions, p.graphs, p.kinds]);

  const runCheck = useCallback(async () => {
    const mine = ++seq.current;
    setState({ status: 'checking' });
    const result = await check(behaviorId);
    if (mine === seq.current) setState({ status: 'done', result });
  }, [behaviorId, check]);

  // Compile after each change settles (the backend compiles the stored graph).
  useEffect(() => {
    if (graphKey === '') return;
    const t = window.setTimeout(() => void runCheck(), 500);
    return () => window.clearTimeout(t);
  }, [graphKey, runCheck]);

  const doPublish = async (acknowledge: boolean): Promise<void> => {
    setPublishing({ kind: 'working' });
    setPublishing(await p.publish(behaviorId, acknowledge));
  };

  if (behavior === null) return <p className="tl-hint">This behavior no longer exists (deleted or undone). Close the tab.</p>;
  if (behavior.graph === undefined) return <p className="tl-hint">"{behavior.displayName}" is not a visual script (open it as a script).</p>;
  if (p.kind === undefined) return <p className="tl-hint">This editor does not know the visual-script graph kind yet (it is still loading).</p>;

  const result = state.status === 'done' ? state.result : null;
  const digest = result !== null && result.ok && result.compiled ? result.sourceDigest : null;
  const published = behavior.source?.kind === 'graph' ? behavior.source.sourceDigest : null;
  const status =
    state.status === 'checking' || state.status === 'idle'
      ? 'checking'
      : result === null || !result.ok
        ? 'unavailable'
        : result.compiled
          ? 'ok'
          : 'errors';
  const problems: { message: string; nodeId?: string; severity: 'error' | 'warning' }[] = [
    ...(result !== null && result.ok && !result.compiled ? result.diagnostics.map((d) => ({ message: d.message, severity: 'error' as const, ...(d.nodeId !== undefined ? { nodeId: d.nodeId } : {}) })) : []),
    ...(result !== null && result.ok ? result.warnings.map((w) => ({ ...w, severity: 'warning' as const })) : []),
  ];
  const titleOf = (id: string): string => {
    const n = behavior.graph?.nodes.find((x) => x.id === id);
    return n === undefined ? id : (p.kind?.nodes.find((d) => d.type === n.type)?.label ?? n.type);
  };

  return (
    <div className="tl-vscript" aria-label="visual script" data-behavior={behaviorId}>
      <div className="tl-vscript__graph">
        <GraphEditor
          key={behaviorId}
          kind={p.kind}
          owner={{ kind: 'behavior', id: behaviorId }}
          graph={behavior.graph}
          onEdit={(ops) => p.onEdit(behaviorId, ops)}
          onSelection={p.onSelection}
          focus={p.focus}
          portContext={portContext}
        />
      </div>
      <div className="tl-vscript__side">
        <div className="tl-script__bar">
          <span className={`tl-script__status tl-script__status--${status}`} aria-label="compile status" data-status={status}>
            {status === 'checking' ? 'Compiling…' : status === 'ok' ? 'Compiles' : status === 'errors' ? `${problems.filter((x) => x.severity === 'error').length} problem(s)` : `Not checked: ${result !== null && !result.ok ? result.error.message : ''}`}
          </span>
          <span className="tl-script__spacer" />
          <span className="tl-script__status">{digest !== null && digest === published ? 'published' : published === null ? 'not published' : 'unpublished edits'}</span>
        </div>
        <div className="tl-script__row">
          <button className="tl-btn tl-btn--small" onClick={() => void runCheck()} title="Compile the graph now (nothing is written)">
            Check
          </button>
          <button className="tl-btn tl-btn--small tl-btn--primary" disabled={status !== 'ok' || publishing?.kind === 'working'} onClick={() => void doPublish(false)} title="Compile and publish the graph (Play and exports run the published script)">
            Publish
          </button>
        </div>
        <div className="tl-script__problems" aria-label="script problems">
          {problems.length === 0 ? (
            <span className="tl-hint">No problems.</span>
          ) : (
            <ul>
              {problems.map((x, i) => (
                <li key={`${i}-${x.nodeId ?? ''}`}>
                  <button className="tl-script__problem" data-severity={x.severity} disabled={x.nodeId === undefined} onClick={() => x.nodeId !== undefined && p.onFocus(x.nodeId)}>
                    {x.nodeId !== undefined && <span className="tl-script__where">{titleOf(x.nodeId)}: </span>}
                    {x.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {publishing?.kind === 'needs-ack' && (
          <div className="tl-script__trust" role="group" aria-label="trust acknowledgment">
            {BEHAVIOR_TRUST_NOTICE.map((line) => (
              <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
                {line}
              </p>
            ))}
            <div className="tl-prop__caption" title={publishing.digest}>
              source digest {publishing.digest.slice(0, 16)}…
            </div>
            <button className="tl-btn tl-btn--small" onClick={() => void doPublish(true)}>
              {BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL} and publish
            </button>
          </div>
        )}
        {publishing?.kind === 'published' && (
          <div className="tl-script__published" aria-label="publish result">
            Published (r{publishing.revision}). {p.activePlay !== null ? 'Restart Play to run it.' : 'Play runs it.'}
          </div>
        )}
        {publishing?.kind === 'failed' && (
          <div className="tl-prop__error" aria-label="publish result">
            {publishing.message}
          </div>
        )}
        <p className="tl-hint">
          Events (On start, On step) start the flow along the white exec wires; data wires carry values. An unwired input uses the value set on the node in
          the Inspector. Public variables are properties set per object in the Inspector.
        </p>
      </div>
    </div>
  );
}
