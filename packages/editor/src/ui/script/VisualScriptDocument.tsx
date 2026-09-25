/**
 * Phase 19.0/19.2: a visual script (a behavior whose source is a graph) as a
 * "Graph: <behavior>" centre tab.
 *
 * - Tabs inside the document: the **event graph** and one tab per function
 *   of the script (`BehaviorRecord.functions`, edited as owner
 *   `<behaviorId>#<functionId>`); **+ Function** creates one (its Function
 *   start node — the first edit that adds nodes creates the function),
 *   double-click a tab to rename it (the Function start's name; calls keep
 *   the id), × deletes it (its nodes removed: one edit, refused while a call
 *   is wired to its ports).
 * - Left: the **variables** of the graph in front — name, type and
 *   visibility (public / private / local) edited in place (each change one
 *   graphEdit), + Variable, delete, a watch toggle, and drag a variable onto
 *   the graph for a Get or Set node; the **shared functions** (graphs of
 *   kind "behavior-library") open in their own tab, + Shared function makes
 *   one.
 * - Centre: the generic GraphEditor (exec wires drawn thick with arrows,
 *   reroutes, comments, groups); the compile check's problems are drawn on
 *   their nodes.
 * - Right: compile status, problems (click: the node), Publish with the
 *   trust notice; the **debugger** while Play runs — the object whose
 *   instance is watched, the nodes that just ran light up, wire values on
 *   hover, breakpoints (F9 or ● Breakpoint) pause Play after the step in
 *   which their node ran, Pause / Step once / Resume, and the watch list.
 *   The editor never runs game code: it polls the running Play over the
 *   preview bridge (`tl.debug.request`).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp, GraphPoint } from '../../graph/model';
import type { GraphData, GraphDocument, GraphValue } from '@thirdlight/project-model';
import type { DebugRequest, DebugResult } from '../../preview/play-debug';
import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE, type CompileDiagnosticView } from '../../session/behavior-publication';
import { behaviorPortContext } from '../../session/behavior-graph';
import type { BehaviorDeclarationView } from '../../session/prefab-projection';
import {
  freshNodeId,
  freshVariableName,
  functionIdFor,
  functionName,
  idsInTab,
  newDeclarationPosition,
  scopedId,
  splitScoped,
  toggleBreakpoints,
  variablesOf,
  visibilitiesOf,
  VARIABLE_KINDS,
} from '../../session/visual-debug';
import type { ScriptPublishOutcome } from './ScriptDocument';

export type VisualScriptCheckResult =
  | { ok: true; compiled: true; sourceDigest: string; warnings: { message: string; nodeId?: string }[] }
  | { ok: true; compiled: false; code: string; diagnostics: CompileDiagnosticView[]; warnings: { message: string; nodeId?: string }[] }
  | { ok: false; error: { code: string; message: string } };

/** One compile problem of a script (node ids scoped: `fn:<functionId>/<node>` inside a function). */
export interface VisualScriptProblem {
  message: string;
  nodeId?: string;
  severity: 'error' | 'warning';
}

export interface VisualScriptDocumentProps {
  behaviorId: string;
  behavior: BehaviorDeclarationView | null;
  /** The `behavior` graph kind (from the backend's kind table). */
  kind: GraphKindDef | undefined;
  /** Phase 19.1: the project's standalone graphs (shared functions) and the kind table (call nodes read their ports from them). */
  graphs: readonly GraphDocument[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  activePlay: { snapshotId: string; revision: number } | null;
  /** One graphEdit on owner {kind: "behavior", id: ownerId} (`<behaviorId>` or `<behaviorId>#<functionId>`). */
  onEdit: (ownerId: string, ops: GraphOp[]) => Promise<string | null>;
  /** The selection of the graph in front changed (its owner id: `<behaviorId>` or `<behaviorId>#<functionId>`). */
  onSelection: (ids: readonly string[], ownerId: string) => void;
  /** A focus request (a problem was clicked): the node id, scoped inside a function; `behaviorId` = for which script. */
  focus: { behaviorId?: string; id: string; nonce: number } | null;
  /** Frame and select a node (scoped id). */
  onFocus: (nodeId: string) => void;
  check: (behaviorId: string) => Promise<VisualScriptCheckResult>;
  publish: (behaviorId: string, acknowledge: boolean) => Promise<ScriptPublishOutcome>;
  /** Phase 19.2: the graph in front per script ("" = the event graph, else a function id) and its setter. */
  targets: Readonly<Record<string, string>>;
  onTarget: (behaviorId: string, target: string) => void;
  /** Phase 19.2: the latest compile problems of the script (the Problems tab lists them). */
  onProblems: (behaviorId: string, problems: readonly VisualScriptProblem[]) => void;
  /** Phase 19.2: breakpoints (scoped node ids) and watched variables (names; scoped for a function's locals), per script. */
  breakpoints: Readonly<Record<string, readonly string[]>>;
  onBreakpoints: (behaviorId: string, ids: readonly string[]) => void;
  watches: Readonly<Record<string, readonly string[]>>;
  onWatches: (behaviorId: string, names: readonly string[]) => void;
  /** Phase 19.2: the objects carrying each script (the debugger's object choice) and the scene selection. */
  carriers: (behaviorId: string) => readonly { id: string; name: string }[];
  selectedEntityId: string | null;
  /** Phase 19.2: one debugger poll of the running Play (null: nothing answered). */
  debugRequest: (req: DebugRequest) => Promise<DebugResult | null>;
  /** Phase 19.2: shared functions — open one in its Graph tab, create one (resolves to its graph id or null). */
  onOpenGraph: (graphId: string) => void;
  onCreateSharedFunction: (name: string) => Promise<string | null>;
}

type CheckState = { status: 'idle' | 'checking' } | { status: 'done'; result: VisualScriptCheckResult };

const DRAG_TYPE = 'application/x-thirdlight-variable';
/** How often the debugger polls the running Play (4 per second: a glance, a small relay load). */
const DEBUG_POLL_MS = 250;

export function VisualScriptDocument(p: VisualScriptDocumentProps): JSX.Element {
  const { behaviorId, behavior, check } = p;
  const [state, setState] = useState<CheckState>({ status: 'idle' });
  const [publishing, setPublishing] = useState<ScriptPublishOutcome | { kind: 'working' } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [newFunction, setNewFunction] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ functionId: string; text: string } | null>(null);
  const [newShared, setNewShared] = useState<string | null>(null);
  const [dropMenu, setDropMenu] = useState<{ name: string; at: GraphPoint; x: number; y: number } | null>(null);
  const seq = useRef(0);
  const target = p.targets[behaviorId] ?? '';
  const functions = behavior?.functions ?? [];
  const fn = target === '' ? null : (functions.find((f) => f.functionId === target) ?? null);
  const inFunction = target !== '';
  const graph: GraphData | undefined = inFunction ? fn?.graph : behavior?.graph;
  const kind = inFunction ? p.kinds['behavior-function'] : p.kind;
  const ownerId = inFunction ? `${behaviorId}#${target}` : behaviorId;
  const graphKey = behavior?.graph !== undefined ? JSON.stringify([behavior.graph, behavior.functions ?? []]) : '';
  // The graph's variables type its Get/Set ports (in a function: its locals, then the script's).
  const portContext = useMemo(
    () => behaviorPortContext(graph, { functions: behavior?.functions, graphs: p.graphs, kinds: p.kinds, ...(inFunction && behavior?.graph !== undefined ? { script: behavior.graph } : {}) }),
    [graph, behavior?.graph, behavior?.functions, p.graphs, p.kinds, inFunction],
  );

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

  const result = state.status === 'done' ? state.result : null;
  const problems: VisualScriptProblem[] = useMemo(
    () => [
      ...(result !== null && result.ok && !result.compiled ? result.diagnostics.map((d) => ({ message: d.message, severity: 'error' as const, ...(d.nodeId !== undefined ? { nodeId: d.nodeId } : {}) })) : []),
      ...(result !== null && result.ok ? result.warnings.map((w) => ({ ...w, severity: 'warning' as const })) : []),
    ],
    [result],
  );
  // The Problems tab lists the latest problems of every checked script.
  const { onProblems } = p;
  useEffect(() => {
    if (result !== null) onProblems(behaviorId, problems);
  }, [behaviorId, result, problems, onProblems]);

  // A focus request for this script: a node in another tab switches to it first.
  const focusFor = p.focus !== null && (p.focus.behaviorId === undefined || p.focus.behaviorId === behaviorId) ? p.focus : null;
  const focusSplit = focusFor !== null ? splitScoped(focusFor.id) : null;
  const { onTarget } = p;
  useEffect(() => {
    if (focusSplit !== null && focusSplit.target !== target) onTarget(behaviorId, focusSplit.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFor?.nonce]);
  const graphFocus = focusFor !== null && focusSplit !== null && focusSplit.target === target ? { id: focusSplit.id, nonce: focusFor.nonce } : null;

  // ---- debugging in Play -------------------------------------------------------------
  const breakpoints = p.breakpoints[behaviorId] ?? [];
  const watches = p.watches[behaviorId] ?? [];
  const carriers = p.carriers(behaviorId);
  const [debugEntity, setDebugEntity] = useState<string | null>(null);
  const [debug, setDebug] = useState<DebugResult | null>(null);
  const bpsRef = useRef(breakpoints);
  bpsRef.current = breakpoints;
  const pausedRef = useRef(false);
  pausedRef.current = debug?.paused === true;
  const commandRef = useRef<'pause' | 'resume' | 'step' | null>(null);
  const pollRef = useRef<() => void>(() => undefined);
  // The scene's selection picks the debugged object when it carries this script.
  useEffect(() => {
    if (p.selectedEntityId !== null && carriers.some((c) => c.id === p.selectedEntityId)) setDebugEntity(p.selectedEntityId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectedEntityId]);
  const playKey = p.activePlay !== null ? `${p.activePlay.snapshotId}@${p.activePlay.revision}` : null;
  const { debugRequest } = p;
  useEffect(() => {
    if (playKey === null) {
      setDebug(null);
      return;
    }
    let alive = true;
    let busy = false;
    const poll = async (): Promise<void> => {
      if (busy || !alive) return;
      busy = true;
      const command = commandRef.current ?? undefined;
      commandRef.current = null;
      const r = await debugRequest({ behaviorId, breakpoints: bpsRef.current, ...(debugEntity !== null ? { entityId: debugEntity } : {}), ...(command !== undefined ? { command } : {}) });
      busy = false;
      if (alive) setDebug(r);
    };
    pollRef.current = () => void poll();
    void poll();
    const t = window.setInterval(() => void poll(), DEBUG_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
      pollRef.current = () => undefined;
      // Leaving: no breakpoints stay armed and a paused game is never left behind.
      void debugRequest({ behaviorId, breakpoints: [], ...(pausedRef.current ? { command: 'resume' as const } : {}) });
    };
  }, [playKey, behaviorId, debugEntity, debugRequest]);
  const send = (command: 'pause' | 'resume' | 'step'): void => {
    commandRef.current = command;
    pollRef.current();
  };
  const inst = debug?.instance ?? null;
  const paused = debug?.paused === true;
  const highlighted = useMemo(() => (inst === null ? undefined : idsInTab(paused ? inst.trace : inst.recent, target)), [inst, paused, target]);
  const current = paused && debug?.hit !== null && debug?.hit !== undefined && (inst === null || debug.hit.entityId === inst.entityId) ? (() => {
    const s = splitScoped(debug.hit.nodeId);
    return s !== null && s.target === target ? s.id : null;
  })() : null;
  const edgeTip = useCallback((edgeId: string): string | null => {
    const v = inst?.wires[scopedId(target, edgeId)];
    return v === undefined ? null : `value: ${v}`;
  }, [inst, target]);
  const bpsHere = useMemo(() => idsInTab(breakpoints, target), [breakpoints, target]);

  const doPublish = async (acknowledge: boolean): Promise<void> => {
    setPublishing({ kind: 'working' });
    setPublishing(await p.publish(behaviorId, acknowledge));
  };

  const edit = async (ops: GraphOp[], owner = ownerId): Promise<boolean> => {
    const err = await p.onEdit(owner, ops);
    setStatus(err);
    return err === null;
  };

  if (behavior === null) return <p className="tl-hint">This behavior no longer exists (deleted or undone). Close the tab.</p>;
  if (behavior.graph === undefined) return <p className="tl-hint">"{behavior.displayName}" is not a visual script (open it as a script).</p>;
  if (p.kind === undefined) return <p className="tl-hint">This editor does not know the visual-script graph kind yet (it is still loading).</p>;

  const digest = result !== null && result.ok && result.compiled ? result.sourceDigest : null;
  const published = behavior.source?.kind === 'graph' ? behavior.source.sourceDigest : null;
  const compileStatus =
    state.status === 'checking' || state.status === 'idle'
      ? 'checking'
      : result === null || !result.ok
        ? 'unavailable'
        : result.compiled
          ? 'ok'
          : 'errors';
  // A new call runs the script's first function (or the first shared function): a call must name one.
  const library = p.graphs.filter((g) => g.kind === 'behavior-library');
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => {
    if (type === 'fn.call' && functions.length > 0) return { function: functions[0]!.functionId };
    if (type === 'fn.library' && library.length > 0) return { function: library[0]!.graphId };
    return undefined;
  };
  const titleOf = (scoped: string): string => {
    const s = splitScoped(scoped);
    if (s === null) return scoped;
    const g = s.target === '' ? behavior.graph : functions.find((f) => f.functionId === s.target)?.graph;
    const k = s.target === '' ? p.kind : p.kinds['behavior-function'];
    const n = g?.nodes.find((x) => x.id === s.id);
    const label = n === undefined ? s.id : (k?.nodes.find((d) => d.type === n.type)?.label ?? n.type);
    const fnPart = s.target !== '' ? `${functionName(functions.find((f) => f.functionId === s.target) ?? { functionId: s.target, graph: { nodes: [], edges: [] } })} › ` : '';
    return `${fnPart}${label}`;
  };
  // Compile problems on the nodes of the graph in front.
  const extraProblems = problems.flatMap((x) => {
    if (x.nodeId === undefined) return [];
    const s = splitScoped(x.nodeId);
    return s !== null && s.target === target ? [{ severity: x.severity, nodeId: s.id, message: x.message }] : [];
  });

  // ---- variables ------------------------------------------------------------------------
  const variables = variablesOf(graph, inFunction);
  const addVariable = (): void => {
    const name = freshVariableName(graph);
    void edit([{ op: 'addNodes', nodes: [{ id: freshNodeId(graph, 'var'), type: 'var.number', position: newDeclarationPosition(graph), data: { name } }] }]);
  };
  const renameVariable = (nodeId: string, from: string, to: string): void => {
    const next = to.trim().toLowerCase();
    if (next === from || next === '' || graph === undefined) return;
    // The declaration and the graph's Get/Set nodes naming it: one edit (one undo step).
    const ops: GraphOp[] = [];
    for (const n of graph.nodes) {
      if (n.id === nodeId) ops.push({ op: 'setNodeData', id: n.id, data: { ...(n.data ?? {}), name: next } });
      else if ((n.type === 'var.get' || n.type === 'var.set') && n.data?.['variable'] === from && from !== '') ops.push({ op: 'setNodeData', id: n.id, data: { ...n.data, variable: next } });
    }
    void edit(ops);
  };
  const retypeVariable = (nodeId: string, kindName: string): void => {
    const n = graph?.nodes.find((x) => x.id === nodeId);
    if (n === undefined || n.type === `var.${kindName}`) return;
    const vis = n.data?.['visibility'];
    const keep: Record<string, GraphValue> = !inFunction && typeof vis === 'string' && visibilitiesOf(kindName, false).includes(vis) ? { visibility: vis } : {};
    const name = n.data?.['name'];
    // A declaration has no ports: the new type is a new node in the same place (one edit).
    void edit([
      { op: 'removeNodes', ids: [nodeId] },
      { op: 'addNodes', nodes: [{ id: freshNodeId(graph, 'var'), type: `var.${kindName}`, position: n.position, data: { ...(typeof name === 'string' ? { name } : {}), ...keep } }] },
    ]);
  };
  const setVisibility = (nodeId: string, visibility: string): void => {
    const n = graph?.nodes.find((x) => x.id === nodeId);
    if (n === undefined) return;
    const kindName = n.type.slice(4);
    const dflt = kindName === 'list' || kindName === 'map' ? 'private' : 'public';
    const data = { ...(n.data ?? {}) };
    if (visibility === dflt) delete data['visibility'];
    else data['visibility'] = visibility;
    void edit([{ op: 'setNodeData', id: n.id, data }]);
  };
  const watchKey = (name: string): string => (inFunction ? scopedId(target, name) : name);
  const toggleWatch = (name: string): void => {
    const key = watchKey(name);
    p.onWatches(behaviorId, watches.includes(key) ? watches.filter((w) => w !== key) : [...watches, key]);
  };
  const onDropItem = (data: DataTransfer, at: GraphPoint, screen: { x: number; y: number }): void => {
    const name = data.getData(DRAG_TYPE);
    if (name === '') return;
    setDropMenu({ name, at, x: screen.x, y: screen.y });
  };
  const addAccess = (type: 'var.get' | 'var.set'): void => {
    const m = dropMenu;
    setDropMenu(null);
    if (m === null) return;
    void edit([{ op: 'addNodes', nodes: [{ id: freshNodeId(graph, type === 'var.get' ? 'get' : 'set'), type, position: m.at, data: { variable: m.name } }] }]);
  };

  // ---- functions ------------------------------------------------------------------------
  const createFunction = async (name: string): Promise<void> => {
    const clean = name.trim();
    setNewFunction(null);
    if (clean === '') return;
    const functionId = functionIdFor(clean, functions.map((f) => f.functionId));
    if (await edit([{ op: 'addNodes', nodes: [{ id: 'start', type: 'fn.entry', position: [0, 0], data: { name: clean.slice(0, 64) } }] }], `${behaviorId}#${functionId}`)) p.onTarget(behaviorId, functionId);
  };
  const renameFunction = (functionId: string, name: string): void => {
    setRenaming(null);
    const f = functions.find((x) => x.functionId === functionId);
    const entry = f?.graph.nodes.find((n) => n.type === 'fn.entry');
    if (f === undefined || entry === undefined || name.trim() === '' || name.trim() === functionName(f)) return;
    void edit([{ op: 'setNodeData', id: entry.id, data: { ...(entry.data ?? {}), name: name.trim().slice(0, 64) } }], `${behaviorId}#${functionId}`);
  };
  const deleteFunction = async (functionId: string): Promise<void> => {
    const f = functions.find((x) => x.functionId === functionId);
    if (f === undefined) return;
    if (await edit([{ op: 'removeNodes', ids: f.graph.nodes.map((n) => n.id) }], `${behaviorId}#${functionId}`)) {
      if (target === functionId) p.onTarget(behaviorId, '');
    }
  };

  const debugObjects = [...carriers.map((c) => ({ id: c.id, name: c.name })), ...(debug?.instances ?? []).filter((id) => !carriers.some((c) => c.id === id)).map((id) => ({ id, name: id }))];
  const shownEntity = inst?.entityId ?? debugEntity;
  const debugState = p.activePlay === null ? 'idle' : debug === null ? 'waiting' : !debug.debuggable ? 'unavailable' : paused ? 'paused' : 'running';
  const watchValue = (key: string): string => {
    if (inst === null) return '—';
    return inst.vars[key] ?? inst.locals[key] ?? '—';
  };

  return (
    <div className="tl-vscript" aria-label="visual script" data-behavior={behaviorId} data-target={target}>
      <div className="tl-vscript__tabs" role="tablist" aria-label="Script graphs">
        <button role="tab" aria-selected={target === ''} className={`tl-vscript__tab${target === '' ? ' is-active' : ''}`} onClick={() => p.onTarget(behaviorId, '')} title="The script's events and their flow">
          Event graph
        </button>
        {functions.map((f) =>
          renaming?.functionId === f.functionId ? (
            <input
              key={f.functionId}
              autoFocus
              className="tl-input tl-vscript__tabinput"
              aria-label="Function name"
              value={renaming.text}
              maxLength={64}
              onChange={(e) => setRenaming({ functionId: f.functionId, text: e.target.value })}
              onBlur={() => renameFunction(f.functionId, renaming.text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') renameFunction(f.functionId, renaming.text);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span key={f.functionId} className={`tl-vscript__tab${target === f.functionId ? ' is-active' : ''}`} data-function={f.functionId}>
              <button role="tab" aria-selected={target === f.functionId} className="tl-vscript__tablabel" onClick={() => p.onTarget(behaviorId, f.functionId)} onDoubleClick={() => setRenaming({ functionId: f.functionId, text: functionName(f) })} title={`Function ${f.functionId} — double-click to rename`}>
                ƒ {functionName(f)}
              </button>
              <button className="tl-vscript__tabclose" aria-label={`Delete function ${functionName(f)}`} title="Delete this function (refused while a call uses its ports)" onClick={() => void deleteFunction(f.functionId)}>
                ×
              </button>
            </span>
          ),
        )}
        {newFunction !== null ? (
          <input
            autoFocus
            className="tl-input tl-vscript__tabinput"
            aria-label="New function name"
            placeholder="Function name"
            value={newFunction}
            maxLength={64}
            onChange={(e) => setNewFunction(e.target.value)}
            onBlur={() => void createFunction(newFunction)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFunction(newFunction);
              if (e.key === 'Escape') setNewFunction(null);
            }}
          />
        ) : (
          <button className="tl-btn tl-btn--small" onClick={() => setNewFunction('')} title="A function of this script: a graph with a Function start, Inputs and Outputs, run by Call function">
            + Function
          </button>
        )}
      </div>
      <div className="tl-vscript__body">
        <div className="tl-vscript__left">
          <div className="tl-panel__subtitle">{inFunction ? 'Local variables' : 'Variables'}</div>
          <ul className="tl-vscript__vars" aria-label="Variables">
            {variables.length === 0 && <li className="tl-hint">No variables.</li>}
            {variables.map((v) => (
              <li
                key={v.nodeId}
                className="tl-vscript__var"
                data-variable={v.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, v.name);
                  e.dataTransfer.setData('text/plain', v.name);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title="Drag onto the graph for a Get or Set node"
              >
                <div className="tl-vscript__varrow">
                <span className="tl-vscript__grip" aria-label={`Drag ${v.name}`}>≡</span>
                <VariableName value={v.name} onCommit={(to) => renameVariable(v.nodeId, v.name, to)} />
                <button className="tl-btn tl-btn--small" aria-label={`Delete variable ${v.name}`} title="Delete the variable (its Get/Set nodes stay, marked until renamed)" onClick={() => void edit([{ op: 'removeNodes', ids: [v.nodeId] }])}>
                  ×
                </button>
                </div>
                <div className="tl-vscript__varrow">
                <select className="tl-input" aria-label={`Type of ${v.name}`} value={v.kind} onChange={(e) => retypeVariable(v.nodeId, e.target.value)}>
                  {VARIABLE_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <select className="tl-input" aria-label={`Visibility of ${v.name}`} value={v.visibility} disabled={inFunction} onChange={(e) => setVisibility(v.nodeId, e.target.value)}>
                  {visibilitiesOf(v.kind, inFunction).map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <label className="tl-vscript__watch" title="Show its value in the watch list while Play runs">
                  <input type="checkbox" aria-label={`Watch ${v.name}`} checked={watches.includes(watchKey(v.name))} onChange={() => toggleWatch(v.name)} />
                  watch
                </label>
                <button className="tl-btn tl-btn--small" aria-label={`Select ${v.name}`} title="Select its declaration (the Inspector edits its default, label, group, tooltip)" onClick={() => p.onFocus(scopedId(target, v.nodeId))}>
                  edit
                </button>
                </div>
              </li>
            ))}
          </ul>
          <button className="tl-btn tl-btn--small" onClick={addVariable} disabled={graph === undefined}>
            + Variable
          </button>
          <div className="tl-panel__subtitle">Shared functions</div>
          <ul className="tl-vscript__shared" aria-label="Shared functions">
            {library.length === 0 && <li className="tl-hint">None (any script can call one).</li>}
            {library.map((g) => (
              <li key={g.graphId}>
                <button className="tl-btn tl-btn--small" onClick={() => p.onOpenGraph(g.graphId)} title="Open the shared function in its own tab">
                  {g.name}
                </button>
              </li>
            ))}
          </ul>
          {newShared !== null ? (
            <input
              autoFocus
              className="tl-input"
              aria-label="New shared function name"
              placeholder="Shared function name"
              value={newShared}
              maxLength={64}
              onChange={(e) => setNewShared(e.target.value)}
              onBlur={() => setNewShared(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewShared(null);
                if (e.key === 'Enter' && newShared.trim() !== '') {
                  const name = newShared.trim();
                  setNewShared(null);
                  void p.onCreateSharedFunction(name).then((id) => id !== null && p.onOpenGraph(id));
                }
              }}
            />
          ) : (
            <button className="tl-btn tl-btn--small" onClick={() => setNewShared('')} title="A function graph every script of the project can call (Call shared function)">
              + Shared function
            </button>
          )}
          {status !== null && (
            <p className="tl-error" role="alert">
              {status}
            </p>
          )}
        </div>
        <div className="tl-vscript__graph">
          {graph === undefined || kind === undefined ? (
            <div className="tl-hint">
              This function no longer exists (deleted or undone).{' '}
              <button className="tl-btn tl-btn--small" onClick={() => p.onTarget(behaviorId, '')}>
                Back to the event graph
              </button>
            </div>
          ) : (
            <GraphEditor
              key={ownerId}
              kind={kind}
              owner={{ kind: 'behavior', id: ownerId }}
              graph={graph}
              onEdit={(ops) => p.onEdit(ownerId, ops)}
              onSelection={(ids) => p.onSelection(ids, ownerId)}
              focus={graphFocus}
              portContext={portContext}
              newNodeData={newNodeData}
              extraProblems={extraProblems}
              breakpoints={bpsHere}
              onToggleBreakpoint={(ids) => p.onBreakpoints(behaviorId, toggleBreakpoints(breakpoints, target, ids))}
              current={current}
              edgeTip={edgeTip}
              onDropItem={onDropItem}
              {...(highlighted !== undefined ? { highlighted } : {})}
            />
          )}
          {dropMenu !== null && (
            <div className="tl-vscript__dropmenu" role="menu" aria-label="Variable node" style={{ left: dropMenu.x, top: dropMenu.y }}>
              <button role="menuitem" className="tl-btn tl-btn--small" onClick={() => addAccess('var.get')}>
                Get {dropMenu.name}
              </button>
              <button role="menuitem" className="tl-btn tl-btn--small" onClick={() => addAccess('var.set')}>
                Set {dropMenu.name}
              </button>
              <button role="menuitem" className="tl-btn tl-btn--small" onClick={() => setDropMenu(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <div className="tl-vscript__side">
          <div className="tl-script__bar">
            <span className={`tl-script__status tl-script__status--${compileStatus}`} aria-label="compile status" data-status={compileStatus}>
              {compileStatus === 'checking' ? 'Compiling…' : compileStatus === 'ok' ? 'Compiles' : compileStatus === 'errors' ? `${problems.filter((x) => x.severity === 'error').length} problem(s)` : `Not checked: ${result !== null && !result.ok ? result.error.message : ''}`}
            </span>
            <span className="tl-script__spacer" />
            <span className="tl-script__status">{digest !== null && digest === published ? 'published' : published === null ? 'not published' : 'unpublished edits'}</span>
          </div>
          <div className="tl-script__row">
            <button className="tl-btn tl-btn--small" onClick={() => void runCheck()} title="Compile the graph now (nothing is written)">
              Check
            </button>
            <button className="tl-btn tl-btn--small tl-btn--primary" disabled={compileStatus !== 'ok' || publishing?.kind === 'working'} onClick={() => void doPublish(false)} title="Compile and publish the graph (Play and exports run the published script)">
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

          <div className="tl-vscript__debug" aria-label="debugger" data-state={debugState}>
            <div className="tl-panel__subtitle">Debug (Play)</div>
            {p.activePlay === null ? (
              <p className="tl-hint">Start Play to debug: the nodes that run light up, wires show their values on hover, a breakpoint (F9) pauses Play after the step in which its node runs.</p>
            ) : (
              <>
                <label className="tl-field">
                  <span>Object</span>
                  <select className="tl-input" aria-label="Debug object" value={shownEntity ?? ''} onChange={(e) => setDebugEntity(e.target.value === '' ? null : e.target.value)}>
                    {debugObjects.length === 0 && <option value="">(none)</option>}
                    {debugObjects.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tl-vscript__debugstatus" aria-label="debug status" data-paused={paused ? 'true' : 'false'} data-node={debug?.hit?.nodeId ?? undefined}>
                  {debugState === 'waiting'
                    ? 'Reading the running game…'
                    : debugState === 'unavailable'
                      ? published !== null && digest !== null && digest !== published
                        ? 'Play runs the published script without debugging: this graph has unpublished edits. Publish, then restart Play.'
                        : 'No object runs this script with debugging in this Play (publish it and restart Play).'
                      : paused
                        ? `Paused at step ${debug!.stepIndex}${debug!.hit !== null ? ` on ${titleOf(debug!.hit.nodeId)} (${debug!.hit.entityId})` : ''}`
                        : `Running — step ${debug!.stepIndex}`}
                </div>
                <div className="tl-script__row">
                  <button className="tl-btn tl-btn--small" disabled={debugState !== 'running'} onClick={() => send('pause')} title="Hold the game at the next step boundary">
                    Pause
                  </button>
                  <button className="tl-btn tl-btn--small" disabled={debugState !== 'paused'} onClick={() => send('step')} title="Run exactly one step, then hold again">
                    Step once
                  </button>
                  <button className="tl-btn tl-btn--small" disabled={debugState !== 'paused'} onClick={() => send('resume')} title="Let the game run on">
                    Resume
                  </button>
                </div>
              </>
            )}
            <div className="tl-panel__subtitle">Breakpoints</div>
            <ul className="tl-vscript__bps" aria-label="breakpoints">
              {breakpoints.length === 0 && <li className="tl-hint">None — select a node and press F9.</li>}
              {breakpoints.map((b) => (
                <li key={b} data-breakpoint={b}>
                  <button className="tl-script__problem" onClick={() => p.onFocus(b)}>
                    ● {titleOf(b)}
                  </button>
                  <button className="tl-btn tl-btn--small" aria-label={`Remove breakpoint ${b}`} onClick={() => p.onBreakpoints(behaviorId, breakpoints.filter((x) => x !== b))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="tl-panel__subtitle">Watch</div>
            <ul className="tl-vscript__watches" aria-label="watch list">
              {watches.length === 0 && <li className="tl-hint">Tick "watch" on a variable to watch it.</li>}
              {watches.map((w) => (
                <li key={w} data-watch={w}>
                  <span className="tl-comp__name">{w}</span> <span className="tl-comp__value" data-watch-value={w}>{watchValue(w)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="tl-hint">
            Events start the flow along the white exec wires (arrows show the direction); data wires carry values. An unwired input uses the value set on the node in the Inspector. Public variables are properties set per object in the Inspector.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A variable's name, committed on Enter or blur. */
function VariableName({ value, onCommit }: { value: string; onCommit: (v: string) => void }): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="tl-input tl-vscript__varname"
      aria-label={`Variable name ${value}`}
      value={text}
      maxLength={64}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text !== value) onCommit(text);
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}
