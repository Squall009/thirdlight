/**
 * The graph editor's view state: the geometry helpers over the resolved ports, the canvas and
 * minimap, the view (pan and zoom), the selection, the gesture state and the problems; drawing
 * is batched to one animation frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  alignOps as alignOpsBase,
  boundsOf,
  diagnoseGraph,
  fitView,
  fixedTypesOf,
  groupAround as groupAroundBase,
  itemsInGroup as itemsInGroupBase,
  nodeRect as nodeRectBase,
  planConnection as planConnectionBase,
  portPoint as portPointBase,
  portsResolver,
  portTypeColor,
  type Alignment,
  type GraphData,
  type GraphKindDef,
  type GraphOp,
  type GraphPoint,
  type GraphProblem,
  type PortEnd,
  type PortsOf,
  type Rect,
  type View,
} from './model';
import { allRects, MINIMAP, type Drag, type Catalogue, type GraphEditorProps } from './graph-editor-parts';
import { drawGraph, drawMinimap, type Scene } from './render';

export function useGraphView(props: GraphEditorProps) {
  const { kind, owner, graph, onSelection, edgeLabels, highlighted, portContext, extraProblems, breakpoints, current } = props;
  const fixedTypes = useMemo(() => fixedTypesOf(kind), [kind]);
  // Every node's resolved ports for this graph value; the geometry
  // helpers below read the current table through a ref (callbacks keep working).
  const portsOf = useMemo(() => portsResolver(kind, graph, portContext), [kind, graph, portContext]);
  const portsRef = useRef<PortsOf>(portsOf);
  portsRef.current = portsOf;
  // The helpers read the ports through the ref only, so they are made once: the other parts list them
  // as hook dependencies without remaking their callbacks.
  const { portPoint, nodeRect, planConnection, itemsInGroup, alignOps, groupAround, portsOfNode } = useMemo(
    () => ({
      portPoint: (k: GraphKindDef, n: GraphData['nodes'][number], side: 'in' | 'out', port: string, position: GraphPoint = n.position): GraphPoint => portPointBase(k, n, side, port, position, portsRef.current),
      nodeRect: (k: GraphKindDef, n: GraphData['nodes'][number], position: GraphPoint = n.position): Rect => nodeRectBase(k, n, position, portsRef.current),
      planConnection: (k: GraphKindDef, g: GraphData, a: PortEnd, b: PortEnd): ReturnType<typeof planConnectionBase> => planConnectionBase(k, g, a, b, portsRef.current),
      itemsInGroup: (k: GraphKindDef, g: GraphData, gr: NonNullable<GraphData['groups']>[number]): string[] => itemsInGroupBase(k, g, gr, portsRef.current),
      alignOps: (k: GraphKindDef, g: GraphData, ids: ReadonlySet<string>, how: Alignment, snapOn2: boolean): GraphOp | null => alignOpsBase(k, g, ids, how, snapOn2, portsRef.current),
      groupAround: (k: GraphKindDef, g: GraphData, ids: ReadonlySet<string>, id: string, color: string): NonNullable<GraphData['groups']>[number] | null => groupAroundBase(k, g, ids, id, color, 'Group', portsRef.current),
      portsOfNode: (n: GraphData['nodes'][number]): { inputs: readonly { id: string; label: string; type: string }[]; outputs: readonly { id: string; label: string; type: string }[] } => portsRef.current(n),
    }),
    [],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ x: 40, y: 40, zoom: 1 });
  const sizeRef = useRef({ w: 800, h: 600 });
  const dragRef = useRef<Drag | null>(null);
  const movedRef = useRef<Map<string, GraphPoint>>(new Map());
  const mouseRef = useRef<{ sx: number; sy: number } | null>(null);
  const spaceRef = useRef<{ down: boolean; used: boolean }>({ down: false, used: false });
  const miniMapRef = useRef({ scale: 1, ox: 0, oy: 0 });
  const frameRef = useRef(0);
  /** A pointer is down: focus changes then come from the click, not the keyboard. */
  const pointerDownRef = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [selection, setSelectionState] = useState<ReadonlySet<string>>(new Set());
  const selectionRef = useRef(selection);
  const [tick, setTick] = useState(0); // overlay/DOM refresh after view changes
  const [snapOn, setSnapOn] = useState(true);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [editing, setEditing] = useState<{ id: string; kind: 'comment' | 'group'; text: string } | null>(null);
  const [pendingPort, setPendingPort] = useState<PortEnd | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  /** Where the pointer is over the hovered wire (the tip follows it). */
  const [hoverAt, setHoverAt] = useState<{ sx: number; sy: number } | null>(null);

  const problems = useMemo(() => [...diagnoseGraph(kind, graph, portsOf), ...(extraProblems ?? [])], [kind, graph, portsOf, extraProblems]);
  const problemsByNode = useMemo(() => {
    const m = new Map<string, GraphProblem[]>();
    for (const p of problems) if (p.nodeId !== undefined) m.set(p.nodeId, [...(m.get(p.nodeId) ?? []), p]);
    return m;
  }, [problems]);

  const setSelection = useCallback(
    (next: ReadonlySet<string>) => {
      selectionRef.current = next;
      setSelectionState(next);
      onSelection?.([...next]);
    },
    [onSelection],
  );

  // A new graph value supersedes the in-flight positions; drop gone ids from the selection.
  useEffect(() => {
    if (dragRef.current === null) movedRef.current = new Map();
    const present = new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id), ...(graph.groups ?? []).map((g) => g.id), ...(graph.comments ?? []).map((c) => c.id)]);
    const sel = selectionRef.current;
    if ([...sel].some((id) => !present.has(id))) setSelection(new Set([...sel].filter((id) => present.has(id))));
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prunes the selection when the graph changes; the other reads go through refs
  }, [graph]);

  // ---- drawing --------------------------------------------------------------------------

  const sceneOf = useCallback((): Scene => {
    const d = dragRef.current;
    let wire: Scene['wire'] = null;
    if (d?.mode === 'wire') {
      const n = graphRef.current.nodes.find((x) => x.id === d.from.node);
      if (n !== undefined) {
        const p = portPoint(kind, n, d.from.side, d.from.port);
        const own = portsOfNode(n);
        const port = (d.from.side === 'in' ? own.inputs : own.outputs).find((x) => x.id === d.from.port);
        wire = d.from.side === 'out' ? { from: p, to: d.at, color: portTypeColor(kind, port?.type ?? ''), ok: d.ok } : { from: d.at, to: p, color: portTypeColor(kind, port?.type ?? ''), ok: d.ok };
      }
    }
    const box = d?.mode === 'box' ? { x: Math.min(d.start[0], d.now[0]), y: Math.min(d.start[1], d.now[1]), w: Math.abs(d.now[0] - d.start[0]), h: Math.abs(d.now[1] - d.start[1]) } : null;
    return {
      kind,
      portsOf: portsRef.current,
      graph: graphRef.current,
      view: viewRef.current,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
      moved: movedRef.current,
      selected: selectionRef.current,
      problems: problemsByNode,
      wire,
      box,
      hoverEdge,
      ...(edgeLabels !== undefined ? { edgeLabels } : {}),
      ...(highlighted !== undefined ? { highlighted } : {}),
      ...(breakpoints !== undefined ? { breakpoints } : {}),
      ...(current !== undefined ? { current } : {}),
    };
  }, [kind, problemsByNode, hoverEdge, edgeLabels, highlighted, breakpoints, current, portPoint, portsOfNode]);

  const draw = useCallback(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const scene = sceneOf();
    drawGraph(ctx, scene, dpr);
    const mini = miniRef.current?.getContext('2d');
    if (mini) miniMapRef.current = drawMinimap(mini, scene, MINIMAP.w, MINIMAP.h, dpr);
  }, [sceneOf]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const requestDraw = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);
  useEffect(() => requestDraw(), [selection, problemsByNode, hoverEdge, edgeLabels, highlighted, breakpoints, current, requestDraw]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // Size the canvas to the element.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const fit = (): void => {
      const r = canvas.parentElement!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
      canvas.width = Math.round(sizeRef.current.w * dpr);
      canvas.height = Math.round(sizeRef.current.h * dpr);
      const mini = miniRef.current;
      if (mini) {
        mini.width = Math.round(MINIMAP.w * dpr);
        mini.height = Math.round(MINIMAP.h * dpr);
      }
      drawRef.current();
      setTick((t) => t + 1);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  // A view change moves the DOM layer directly (one transform, no React work)
  // and redraws the canvas; the layer's contents (which nodes are in view)
  // follow once the view has settled, so a pan or zoom never rebuilds DOM per frame.
  const layerRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      requestDraw();
      if (layerRef.current) layerRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(v.zoom * 100)}%`;
      if (settleRef.current !== null) clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => {
        settleRef.current = null;
        setTick((t) => t + 1);
      }, 60);
    },
    [requestDraw],
  );
  useEffect(() => () => {
    if (settleRef.current !== null) clearTimeout(settleRef.current);
  }, []);
  // The zoom label is written directly (setView) — also after every render.
  useLayoutEffect(() => {
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(viewRef.current.zoom * 100)}%`;
  });

  // Frame everything once, when the graph first shows.
  const framedRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${owner.kind}:${owner.id}`;
    if (framedRef.current === key) return;
    framedRef.current = key;
    const b = boundsOf(allRects(kind, graph, portsRef.current));
    if (b !== null) setView(fitView(b, sizeRef.current.w, sizeRef.current.h));
    else setView({ x: 40, y: 40, zoom: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frames the view once per opened owner, not on every graph edit
  }, [owner.kind, owner.id]);
  return { fixedTypes, portsOf, portsRef, portPoint, nodeRect, planConnection, itemsInGroup, alignOps, groupAround, portsOfNode, rootRef, canvasRef, miniRef, viewRef, sizeRef, dragRef, movedRef, mouseRef, spaceRef, miniMapRef, pointerDownRef, graphRef, selection, selectionRef, tick, setTick, snapOn, setSnapOn, status, setStatus, catalogue, setCatalogue, editing, setEditing, pendingPort, setPendingPort, hoverEdge, setHoverEdge, hoverAt, setHoverAt, problems, problemsByNode, setSelection, requestDraw, layerRef, zoomLabelRef, setView };
}
export type GraphView = ReturnType<typeof useGraphView>;
