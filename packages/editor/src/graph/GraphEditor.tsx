/**
 * Phase 16.1: the generic node-graph editor.
 *
 * A self-contained component: give it a graph kind (catalogue, port types,
 * rules), the owner (which document's graph it is), the graph value, and an
 * `onEdit` that sends ONE `graphEdit` command with a list of ops. Every
 * gesture is one call (a drag of many nodes is one `moveNodes` on release;
 * a paste is one add + connect), so every gesture is one undo step and MCP
 * and other clients see the same graph. The component never changes the
 * graph itself: it shows the value it is given (plus the in-flight drag),
 * so a remote edit appears as soon as the host passes the new value.
 *
 * Gestures: pan (middle-drag or Space+drag), zoom to the cursor (wheel), fit
 * (F: the selection, Shift+F: everything), minimap (click/drag to move the
 * view), grid snapping (toggle), box select (drag on empty space; Shift
 * adds, Ctrl toggles), multi-drag, a group drags what is inside it,
 * copy/cut/paste (Ctrl+C/X/V, also between editors of the same kind),
 * duplicate (Ctrl+D), delete (Delete), select all (Ctrl+A), group
 * (Ctrl+G), alignment (toolbar), search-to-add (right click or Space: a
 * filterable catalogue with categories), drag from a port to empty space
 * (the catalogue filtered to nodes that can take the wire), double-click a
 * wire to add a reroute point (double-click the point to remove it),
 * double-click a node's title to collapse it, a comment or a group title to
 * edit it. Keyboard: nodes and ports are focusable; arrows move the
 * selection by a grid step (Shift: five); Enter on a port starts a wire,
 * Enter on another port connects it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

import {
  alignOps,
  boundsOf,
  commentRect,
  compatibleNodeDefs,
  copyItems,
  deleteOps,
  diagnoseGraph,
  fitView,
  fixedTypesOf,
  groupAround,
  GROUP_HEADER,
  groupRect,
  HEADER,
  inside,
  itemsInGroup,
  makeIdFactory,
  nodeDefOf,
  nodeRect,
  nodeTitle,
  overlaps,
  pasteItems,
  planConnection,
  portPoint,
  portTypeColor,
  portTypeLabel,
  ROW,
  searchCatalogue,
  snap,
  toGraph,
  wireDistance,
  wireSegments,
  zoomAt,
  GRID,
  type Alignment,
  type GraphClipboard,
  type GraphData,
  type GraphKindDef,
  type GraphNodeDef,
  type GraphOp,
  type GraphPoint,
  type GraphProblem,
  type GraphValue,
  type PortEnd,
  type Rect,
  type View,
} from './model';
import { drawGraph, drawMinimap, type Scene } from './render';

export interface GraphOwnerRef {
  kind: string;
  id: string;
}

export interface GraphEditorProps {
  kind: GraphKindDef;
  owner: GraphOwnerRef;
  graph: GraphData;
  /** Send one graphEdit (one undo step); resolves to null or the refusal message. */
  onEdit: (ops: GraphOp[]) => Promise<string | null>;
  /** The selected item ids changed (the host shows them in the Inspector). */
  onSelection?: (ids: readonly string[]) => void;
  /** Select and frame an item (a Problems jump); a new `nonce` repeats it. */
  focus?: { id: string; nonce: number } | null;
  /** Phase 16.2: a short label drawn on a wire (edge id → text, e.g. "×2"). */
  edgeLabels?: ReadonlyMap<string, string>;
  /** Phase 16.2: nodes drawn highlighted (e.g. the live preview's current state). */
  highlighted?: ReadonlySet<string>;
  /** Phase 16.2: the host's field values for a node added from the catalogue (absent = the field defaults). */
  newNodeData?: (type: string) => Record<string, GraphValue> | undefined;
  /** Phase 16.2: a node's body was double-clicked (e.g. open a blend tree's own graph). */
  onOpenNode?: (id: string) => void;
}

/** Copy/paste between editors of the same graph kind (document tabs of one kind). */
const CLIPBOARDS = new Map<string, GraphClipboard>();

const GROUP_COLORS = ['#4c6ef5', '#2f9e44', '#e8590c', '#ae3ec9', '#1098ad', '#f59f00'];
/** Above this many nodes in view, only selected nodes get DOM elements (the canvas still draws all). */
const MAX_DOM_NODES = 400;
const MINIMAP = { w: 200, h: 130 };

type Hit =
  | { type: 'port'; end: PortEnd }
  | { type: 'reroute'; edge: string; index: number }
  | { type: 'node'; id: string; header: boolean; toggle: boolean }
  | { type: 'comment'; id: string }
  | { type: 'group'; id: string }
  | { type: 'edge'; id: string }
  | { type: 'empty' };

type Drag =
  | { mode: 'pan'; sx: number; sy: number; view: View; moved: boolean }
  | { mode: 'move'; start: GraphPoint; items: Map<string, GraphPoint>; moved: boolean }
  | { mode: 'box'; start: GraphPoint; now: GraphPoint; additive: boolean; toggle: boolean }
  | { mode: 'wire'; from: PortEnd; at: GraphPoint; target: PortEnd | null; ok: boolean | null }
  | { mode: 'reroute'; edge: string; index: number; start: GraphPoint; orig: GraphPoint; moved: boolean }
  | { mode: 'minimap' };

interface Catalogue {
  sx: number;
  sy: number;
  at: GraphPoint;
  from: PortEnd | null;
  query: string;
  active: number;
}

export function GraphEditor({ kind, owner, graph, onEdit, onSelection, focus, edgeLabels, highlighted, newNodeData, onOpenNode }: GraphEditorProps): JSX.Element {
  const fixedTypes = useMemo(() => fixedTypesOf(kind), [kind]);
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

  const problems = useMemo(() => diagnoseGraph(kind, graph), [kind, graph]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ---- drawing --------------------------------------------------------------------------

  const sceneOf = useCallback((): Scene => {
    const d = dragRef.current;
    let wire: Scene['wire'] = null;
    if (d?.mode === 'wire') {
      const n = graphRef.current.nodes.find((x) => x.id === d.from.node);
      if (n !== undefined) {
        const p = portPoint(kind, n, d.from.side, d.from.port);
        const def = nodeDefOf(kind, n.type);
        const port = (d.from.side === 'in' ? def?.inputs : def?.outputs)?.find((x) => x.id === d.from.port);
        wire = d.from.side === 'out' ? { from: p, to: d.at, color: portTypeColor(kind, port?.type ?? ''), ok: d.ok } : { from: d.at, to: p, color: portTypeColor(kind, port?.type ?? ''), ok: d.ok };
      }
    }
    const box = d?.mode === 'box' ? { x: Math.min(d.start[0], d.now[0]), y: Math.min(d.start[1], d.now[1]), w: Math.abs(d.now[0] - d.start[0]), h: Math.abs(d.now[1] - d.start[1]) } : null;
    return { kind, graph: graphRef.current, view: viewRef.current, width: sizeRef.current.w, height: sizeRef.current.h, moved: movedRef.current, selected: selectionRef.current, problems: problemsByNode, wire, box, hoverEdge, ...(edgeLabels !== undefined ? { edgeLabels } : {}), ...(highlighted !== undefined ? { highlighted } : {}) };
  }, [kind, problemsByNode, hoverEdge, edgeLabels, highlighted]);

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
  useEffect(() => requestDraw(), [selection, problemsByNode, hoverEdge, edgeLabels, highlighted, requestDraw]);
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
    const b = boundsOf(allRects(kind, graph));
    if (b !== null) setView(fitView(b, sizeRef.current.w, sizeRef.current.h));
    else setView({ x: 40, y: 40, zoom: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, owner.id]);

  // ---- helpers --------------------------------------------------------------------------

  const localPoint = (clientX: number, clientY: number): { sx: number; sy: number } => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { sx: clientX - r.left, sy: clientY - r.top };
  };

  const edit = useCallback(
    async (ops: GraphOp[], done?: string): Promise<boolean> => {
      if (ops.length === 0) return false;
      const err = await onEdit(ops);
      if (err !== null) {
        movedRef.current = new Map();
        requestDraw();
        setStatus({ text: err, error: true });
        return false;
      }
      setStatus(done !== undefined ? { text: done, error: false } : null);
      return true;
    },
    [onEdit, requestDraw],
  );

  const hitTest = useCallback(
    (p: GraphPoint): Hit => {
      const g = graphRef.current;
      const z = viewRef.current.zoom;
      const pos = (id: string, fallback: GraphPoint): GraphPoint => movedRef.current.get(id) ?? fallback;
      // Draw order: unselected, then selected (on top) — hit tests walk it backwards.
      const nodesTopFirst = [...g.nodes.filter((n) => !selectionRef.current.has(n.id)), ...g.nodes.filter((n) => selectionRef.current.has(n.id))];
      const portR = Math.max(8, 9 / z);
      for (let i = nodesTopFirst.length - 1; i >= 0; i--) {
        const n0 = nodesTopFirst[i]!;
        const n = { ...n0, position: pos(n0.id, n0.position) };
        const r = nodeRect(kind, n);
        if (!inside({ x: r.x - portR, y: r.y - portR, w: r.w + 2 * portR, h: r.h + 2 * portR }, p)) continue;
        const def = nodeDefOf(kind, n.type);
        for (const [side, list] of [['in', def?.inputs ?? []], ['out', def?.outputs ?? []]] as const) {
          for (const port of list) {
            const pt = portPoint(kind, n, side, port.id);
            if (Math.hypot(pt[0] - p[0], pt[1] - p[1]) <= portR) return { type: 'port', end: { node: n.id, port: port.id, side } };
          }
        }
      }
      for (const e of g.edges) {
        const rr = e.reroutes ?? [];
        for (let i = 0; i < rr.length; i++) {
          const q = movedRef.current.get(`${e.id}#${i}`) ?? rr[i]!;
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= Math.max(7, 8 / z)) return { type: 'reroute', edge: e.id, index: i };
        }
      }
      for (let i = nodesTopFirst.length - 1; i >= 0; i--) {
        const n0 = nodesTopFirst[i]!;
        const r = nodeRect(kind, { ...n0, position: pos(n0.id, n0.position) });
        if (inside(r, p)) return { type: 'node', id: n0.id, header: p[1] <= r.y + HEADER, toggle: p[1] <= r.y + HEADER && p[0] <= r.x + 16 };
      }
      for (const c of [...(g.comments ?? [])].reverse()) if (inside(commentRect(c, pos(c.id, c.position)), p)) return { type: 'comment', id: c.id };
      for (const e of g.edges) {
        const a = g.nodes.find((n) => n.id === e.from.node);
        const b = g.nodes.find((n) => n.id === e.to.node);
        if (a === undefined || b === undefined) continue;
        const from = portPoint(kind, { ...a, position: pos(a.id, a.position) }, 'out', e.from.port);
        const to = portPoint(kind, { ...b, position: pos(b.id, b.position) }, 'in', e.to.port);
        if (wireDistance(wireSegments(from, to, e.reroutes ?? []), p) <= Math.max(5, 6 / z)) return { type: 'edge', id: e.id };
      }
      for (const gr of [...(g.groups ?? [])].reverse()) {
        const at = pos(gr.id, [gr.rect[0], gr.rect[1]]);
        if (inside({ x: at[0], y: at[1], w: gr.rect[2], h: GROUP_HEADER }, p)) return { type: 'group', id: gr.id };
      }
      return { type: 'empty' };
    },
    [kind],
  );

  /** What a move of `ids` drags: the items, plus everything inside a dragged group. */
  const moveSet = useCallback(
    (ids: ReadonlySet<string>): Map<string, GraphPoint> => {
      const g = graphRef.current;
      const m = new Map<string, GraphPoint>();
      for (const n of g.nodes) if (ids.has(n.id)) m.set(n.id, n.position);
      for (const c of g.comments ?? []) if (ids.has(c.id)) m.set(c.id, c.position);
      for (const gr of g.groups ?? []) {
        if (!ids.has(gr.id)) continue;
        m.set(gr.id, [gr.rect[0], gr.rect[1]]);
        for (const id of itemsInGroup(kind, g, gr)) {
          const n = g.nodes.find((x) => x.id === id);
          const c = (g.comments ?? []).find((x) => x.id === id);
          if (n !== undefined) m.set(id, n.position);
          else if (c !== undefined) m.set(id, c.position);
        }
      }
      return m;
    },
    [kind],
  );

  const openCatalogue = useCallback((sx: number, sy: number, from: PortEnd | null) => {
    const at = toGraph(viewRef.current, sx, sy);
    setCatalogue({ sx, sy, at, from, query: '', active: 0 });
  }, []);

  const frame = useCallback(
    (ids: ReadonlySet<string> | null) => {
      const g = graphRef.current;
      const rects = ids === null || ids.size === 0 ? allRects(kind, g) : allRects(kind, g, ids);
      const b = boundsOf(rects);
      if (b !== null) setView(fitView(b, sizeRef.current.w, sizeRef.current.h));
    },
    [kind, setView],
  );

  // Problems jump: select the item and frame it.
  useEffect(() => {
    if (focus === null || focus === undefined) return;
    const ids = new Set([focus.id]);
    setSelection(ids);
    frame(ids);
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focus.id)}"]`);
    el?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id, focus?.nonce]);

  // ---- clipboard and selection commands ----------------------------------------------------

  const copySelection = useCallback((): GraphClipboard | null => {
    const sel = selectionRef.current;
    if (sel.size === 0) return null;
    const clip = copyItems(kind.kind, graphRef.current, sel, fixedTypes);
    if (clip.nodes.length + clip.groups.length + clip.comments.length === 0) return null;
    CLIPBOARDS.set(kind.kind, clip);
    return clip;
  }, [kind.kind, fixedTypes]);

  const pasteClip = useCallback(
    async (clip: GraphClipboard, place: { at: GraphPoint } | { offset: GraphPoint }) => {
      const { ops, ids } = pasteItems(clip, makeIdFactory(graphRef.current, 'p'), place);
      if (await edit(ops, `pasted ${ids.length} item${ids.length === 1 ? '' : 's'}`)) setSelection(new Set(ids));
    },
    [edit, setSelection],
  );

  const paste = useCallback(async () => {
    const clip = CLIPBOARDS.get(kind.kind);
    if (clip === undefined) {
      setStatus({ text: 'the clipboard holds nothing of this graph kind', error: false });
      return;
    }
    const m = mouseRef.current;
    const at = m !== null ? toGraph(viewRef.current, m.sx, m.sy) : toGraph(viewRef.current, sizeRef.current.w / 2, sizeRef.current.h / 2);
    await pasteClip(clip, { at: [snap(at[0], snapOn), snap(at[1], snapOn)] });
  }, [kind.kind, pasteClip, snapOn]);

  const removeSelection = useCallback(async () => {
    const ops = deleteOps(graphRef.current, selectionRef.current, fixedTypes);
    if (ops.length === 0) {
      if (selectionRef.current.size > 0) setStatus({ text: 'this node is part of every graph of its kind: it cannot be deleted', error: false });
      return;
    }
    if (await edit(ops)) setSelection(new Set());
  }, [edit, setSelection, fixedTypes]);

  const align = useCallback(
    async (how: Alignment) => {
      const op = alignOps(kind, graphRef.current, selectionRef.current, how, snapOn);
      if (op === null) setStatus({ text: 'select two or more nodes to align them', error: false });
      else await edit([op]);
    },
    [edit, kind, snapOn],
  );

  const addGroup = useCallback(async () => {
    const g = graphRef.current;
    const id = makeIdFactory(g, 'g')();
    const color = GROUP_COLORS[(g.groups ?? []).length % GROUP_COLORS.length]!;
    const group = groupAround(kind, g, selectionRef.current, id, color);
    if (group === null) {
      setStatus({ text: 'select nodes to group them', error: false });
      return;
    }
    if (await edit([{ op: 'setGroups', groups: [group] }])) setSelection(new Set([id]));
  }, [edit, kind, setSelection]);

  const addComment = useCallback(async () => {
    const id = makeIdFactory(graphRef.current, 'k')();
    const m = mouseRef.current;
    const at = toGraph(viewRef.current, m?.sx ?? sizeRef.current.w / 2, m?.sy ?? sizeRef.current.h / 2);
    if (await edit([{ op: 'setComments', comments: [{ id, text: 'Comment', position: [snap(at[0], snapOn), snap(at[1], snapOn)] }] }])) {
      setSelection(new Set([id]));
      setEditing({ id, kind: 'comment', text: 'Comment' });
    }
  }, [edit, setSelection, snapOn]);

  const addNodeFromCatalogue = useCallback(
    async (type: string) => {
      const c = catalogue;
      if (c === null) return;
      setCatalogue(null);
      rootRef.current?.focus({ preventScroll: true });
      const def = nodeDefOf(kind, type);
      if (def === undefined) return;
      const g = graphRef.current;
      const id = makeIdFactory(g, def.type.slice(0, 3))();
      let position: GraphPoint = [snap(c.at[0], snapOn), snap(c.at[1], snapOn)];
      const data = newNodeData?.(type);
      const withData = data !== undefined && Object.keys(data).length > 0 ? { data } : {};
      const ops: GraphOp[] = [];
      let connectTo: { from: { node: string; port: string }; to: { node: string; port: string }; replaces: string[] } | null = null;
      if (c.from !== null) {
        const fromNode = g.nodes.find((n) => n.id === c.from!.node);
        const fromDef = fromNode !== undefined ? nodeDefOf(kind, fromNode.type) : undefined;
        const fromPort = (c.from.side === 'out' ? fromDef?.outputs : fromDef?.inputs)?.find((p) => p.id === c.from!.port);
        const match = fromPort !== undefined ? compatibleNodeDefs(kind, fromPort.type, c.from.side).find((x) => x.def.type === type) : undefined;
        if (match !== undefined) {
          const list = c.from.side === 'out' ? def.inputs : def.outputs;
          const row = Math.max(0, list.findIndex((p) => p.id === match.port));
          // Put the new node's port under the drop point.
          position = [snap(c.at[0] - (c.from.side === 'out' ? 0 : 180), snapOn), snap(c.at[1] - HEADER - ROW / 2 - row * ROW, snapOn)];
          const newEnd: PortEnd = { node: id, port: match.port, side: c.from.side === 'out' ? 'in' : 'out' };
          const withNode: GraphData = { ...g, nodes: [...g.nodes, { id, type, position }] };
          const plan = planConnection(kind, withNode, c.from, newEnd);
          if (plan.ok) connectTo = plan;
        }
      }
      ops.push({ op: 'addNodes', nodes: [{ id, type, position, ...withData }] });
      if (connectTo !== null) {
        if (connectTo.replaces.length > 0) ops.push({ op: 'disconnect', ids: connectTo.replaces });
        ops.push({ op: 'connect', edges: [{ id: makeIdFactory({ ...g, nodes: [...g.nodes, { id, type, position }] }, 'e')(), from: connectTo.from, to: connectTo.to }] });
      }
      if (await edit(ops, `added ${def.label}`)) setSelection(new Set([id]));
    },
    [catalogue, edit, kind, setSelection, snapOn, newNodeData],
  );

  const connect = useCallback(
    async (a: PortEnd, b: PortEnd): Promise<boolean> => {
      const g = graphRef.current;
      const plan = planConnection(kind, g, a, b);
      if (!plan.ok) {
        setStatus({ text: `cannot connect: ${plan.reason}`, error: true });
        return false;
      }
      const ops: GraphOp[] = [];
      if (plan.replaces.length > 0) ops.push({ op: 'disconnect', ids: plan.replaces });
      ops.push({ op: 'connect', edges: [{ id: makeIdFactory(g, 'e')(), from: plan.from, to: plan.to }] });
      return edit(ops, plan.conversion !== null ? `connected (${plan.conversion.label})` : 'connected');
    },
    [edit, kind],
  );

  // ---- pointer input ----------------------------------------------------------------------

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    if ((ev.target as HTMLElement).closest('.tl-graph__popup, .tl-graph__toolbar, .tl-graph__edit, .tl-graph__minimap')) return;
    const { sx, sy } = localPoint(ev.clientX, ev.clientY);
    const p = toGraph(viewRef.current, sx, sy);
    pointerDownRef.current = true;
    rootRef.current?.focus({ preventScroll: true });
    setCatalogue(null);
    if (ev.button === 2) return; // the context menu opens the catalogue
    if (ev.button === 1 || (ev.button === 0 && spaceRef.current.down)) {
      ev.preventDefault();
      spaceRef.current.used = true;
      dragRef.current = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, view: viewRef.current, moved: false };
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      return;
    }
    if (ev.button !== 0) return;
    const hit = hitTest(p);
    const sel = selectionRef.current;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    if (hit.type === 'port') {
      dragRef.current = { mode: 'wire', from: hit.end, at: p, target: null, ok: null };
      requestDraw();
      return;
    }
    if (hit.type === 'reroute') {
      const e = graphRef.current.edges.find((x) => x.id === hit.edge)!;
      dragRef.current = { mode: 'reroute', edge: hit.edge, index: hit.index, start: p, orig: e.reroutes![hit.index]!, moved: false };
      return;
    }
    if (hit.type === 'node' && hit.toggle) {
      const n = graphRef.current.nodes.find((x) => x.id === hit.id)!;
      void edit([{ op: 'setCollapsed', ids: [n.id], collapsed: n.collapsed !== true }]);
      return;
    }
    if (hit.type === 'node' || hit.type === 'comment' || hit.type === 'group') {
      let next = sel;
      if (ev.ctrlKey || ev.metaKey) {
        const toggled = new Set(sel);
        if (toggled.has(hit.id)) toggled.delete(hit.id);
        else toggled.add(hit.id);
        next = toggled;
      } else if (ev.shiftKey) next = new Set([...sel, hit.id]);
      else if (!sel.has(hit.id)) next = new Set([hit.id]);
      if (next !== sel) setSelection(next);
      if (next.has(hit.id)) dragRef.current = { mode: 'move', start: p, items: moveSet(next), moved: false };
      return;
    }
    if (hit.type === 'edge') {
      setSelection(ev.shiftKey ? new Set([...sel, hit.id]) : new Set([hit.id]));
      return;
    }
    dragRef.current = { mode: 'box', start: p, now: p, additive: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey };
  };

  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    const { sx, sy } = localPoint(ev.clientX, ev.clientY);
    mouseRef.current = { sx, sy };
    const p = toGraph(viewRef.current, sx, sy);
    const d = dragRef.current;
    if (d === null) {
      const h = hitTest(p);
      const e = h.type === 'edge' ? h.id : null;
      if (e !== hoverEdge) setHoverEdge(e);
      return;
    }
    if (d.mode === 'pan') {
      d.moved = true;
      setView({ ...d.view, x: d.view.x + ev.clientX - d.sx, y: d.view.y + ev.clientY - d.sy });
      return;
    }
    if (d.mode === 'move') {
      const dx = p[0] - d.start[0];
      const dy = p[1] - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
      d.moved = true;
      const m = new Map<string, GraphPoint>();
      for (const [id, o] of d.items) m.set(id, [snap(o[0] + dx, snapOn), snap(o[1] + dy, snapOn)]);
      movedRef.current = m;
      requestDraw();
      return;
    }
    if (d.mode === 'box') {
      d.now = p;
      requestDraw();
      return;
    }
    if (d.mode === 'wire') {
      d.at = p;
      const h = hitTest(p);
      if (h.type === 'port' && !(h.end.node === d.from.node && h.end.port === d.from.port && h.end.side === d.from.side)) {
        d.target = h.end;
        d.ok = planConnection(kind, graphRef.current, d.from, h.end).ok;
      } else {
        d.target = null;
        d.ok = null;
      }
      requestDraw();
      return;
    }
    if (d.mode === 'reroute') {
      d.moved = true;
      movedRef.current = new Map([[`${d.edge}#${d.index}`, [snap(d.orig[0] + p[0] - d.start[0], snapOn), snap(d.orig[1] + p[1] - d.start[1], snapOn)] as GraphPoint]]);
      requestDraw();
    }
  };

  const onPointerUp = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    pointerDownRef.current = false;
    const d = dragRef.current;
    dragRef.current = null;
    if (d === null) return;
    const { sx, sy } = localPoint(ev.clientX, ev.clientY);
    if (d.mode === 'move') {
      if (!d.moved) return;
      const moves = [...movedRef.current].filter(([id, pos]) => {
        const o = d.items.get(id)!;
        return o[0] !== pos[0] || o[1] !== pos[1];
      });
      if (moves.length === 0) {
        movedRef.current = new Map();
        requestDraw();
        return;
      }
      void edit([{ op: 'moveNodes', moves: moves.map(([id, position]) => ({ id, position })) }]);
      return;
    }
    if (d.mode === 'box') {
      const box: Rect = { x: Math.min(d.start[0], d.now[0]), y: Math.min(d.start[1], d.now[1]), w: Math.abs(d.now[0] - d.start[0]), h: Math.abs(d.now[1] - d.start[1]) };
      const g = graphRef.current;
      const hits = new Set<string>();
      if (box.w * viewRef.current.zoom >= 3 || box.h * viewRef.current.zoom >= 3) {
        for (const n of g.nodes) if (overlaps(box, nodeRect(kind, n))) hits.add(n.id);
        for (const c of g.comments ?? []) if (overlaps(box, commentRect(c))) hits.add(c.id);
        for (const gr of g.groups ?? []) {
          const r = groupRect(gr);
          if (box.x <= r.x && box.y <= r.y && box.x + box.w >= r.x + r.w && box.y + box.h >= r.y + r.h) hits.add(gr.id);
        }
      }
      const sel = selectionRef.current;
      if (d.toggle) {
        const next = new Set(sel);
        for (const id of hits) if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelection(next);
      } else setSelection(d.additive ? new Set([...sel, ...hits]) : hits);
      requestDraw();
      return;
    }
    if (d.mode === 'wire') {
      requestDraw();
      if (d.target !== null) {
        void connect(d.from, d.target);
        return;
      }
      // Dropped on empty space: the catalogue, filtered to what can take this wire.
      const n = graphRef.current.nodes.find((x) => x.id === d.from.node);
      const start = n !== undefined ? portPoint(kind, n, d.from.side, d.from.port) : d.at;
      if (Math.hypot(start[0] - d.at[0], start[1] - d.at[1]) * viewRef.current.zoom > 12) openCatalogue(sx, sy, d.from);
      return;
    }
    if (d.mode === 'reroute') {
      if (!d.moved) return;
      const e = graphRef.current.edges.find((x) => x.id === d.edge);
      const moved = movedRef.current.get(`${d.edge}#${d.index}`);
      if (e === undefined || moved === undefined) return;
      const rr = (e.reroutes ?? []).map((q, i) => (i === d.index ? moved : q));
      void edit([{ op: 'setReroutes', id: e.id, reroutes: rr }]);
    }
  };

  const onDoubleClick = (ev: ReactMouseEvent<HTMLDivElement>): void => {
    if ((ev.target as HTMLElement).closest('.tl-graph__popup, .tl-graph__toolbar, .tl-graph__edit, .tl-graph__minimap')) return;
    const { sx, sy } = localPoint(ev.clientX, ev.clientY);
    const p = toGraph(viewRef.current, sx, sy);
    const hit = hitTest(p);
    const g = graphRef.current;
    if (hit.type === 'node' && hit.header && !hit.toggle) {
      const n = g.nodes.find((x) => x.id === hit.id)!;
      void edit([{ op: 'setCollapsed', ids: [n.id], collapsed: n.collapsed !== true }]);
    } else if (hit.type === 'node' && !hit.header) {
      onOpenNode?.(hit.id);
    } else if (hit.type === 'comment') {
      const c = (g.comments ?? []).find((x) => x.id === hit.id)!;
      setEditing({ id: c.id, kind: 'comment', text: c.text });
    } else if (hit.type === 'group') {
      const gr = (g.groups ?? []).find((x) => x.id === hit.id)!;
      setEditing({ id: gr.id, kind: 'group', text: gr.title });
    } else if (hit.type === 'reroute') {
      const e = g.edges.find((x) => x.id === hit.edge)!;
      void edit([{ op: 'setReroutes', id: e.id, reroutes: (e.reroutes ?? []).filter((_, i) => i !== hit.index) }]);
    } else if (hit.type === 'edge') {
      // A reroute point where the wire was double-clicked, between the right neighbours.
      const e = g.edges.find((x) => x.id === hit.id)!;
      const a = g.nodes.find((n) => n.id === e.from.node)!;
      const b = g.nodes.find((n) => n.id === e.to.node)!;
      const segs = wireSegments(portPoint(kind, a, 'out', e.from.port), portPoint(kind, b, 'in', e.to.port), e.reroutes ?? []);
      let best = 0;
      let bestD = Infinity;
      segs.forEach((s, i) => {
        const dd = wireDistance([s], p);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      const rr = [...(e.reroutes ?? [])];
      rr.splice(best, 0, [snap(p[0], snapOn), snap(p[1], snapOn)]);
      void edit([{ op: 'setReroutes', id: e.id, reroutes: rr }]);
    }
  };

  // Wheel: zoom to the cursor (non-passive, so the page does not scroll).
  useEffect(() => {
    const canvas = canvasRef.current?.parentElement;
    if (!canvas) return;
    const onWheel = (ev: WheelEvent): void => {
      if ((ev.target as HTMLElement).closest('.tl-graph__popup')) return;
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      setView(zoomAt(viewRef.current, ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [setView]);

  // ---- keyboard ---------------------------------------------------------------------------

  const keyMoveRef = useRef<Map<string, GraphPoint> | null>(null);

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>): void => {
    const t = ev.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    const handled = (): void => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (mod && key === 'z') return; // project undo/redo (the app handles it)
    if (mod && key === 'y') return;
    if (ev.key === 'Escape') {
      handled();
      setCatalogue(null);
      setPendingPort(null);
      dragRef.current = null;
      movedRef.current = new Map();
      requestDraw();
      return;
    }
    if (ev.key === ' ' && !ev.repeat) {
      handled();
      // Space tapped (no drag while held) opens the catalogue; held + drag pans.
      if (t.dataset['port'] !== undefined) return activatePort(t);
      spaceRef.current = { down: true, used: false };
      return;
    }
    if (ev.key === ' ') return handled();
    if (ev.key === 'Enter' && t.dataset['port'] !== undefined) {
      handled();
      return activatePort(t);
    }
    if (mod && key === 'c') {
      handled();
      const clip = copySelection();
      setStatus({ text: clip !== null ? `copied ${clip.nodes.length + clip.groups.length + clip.comments.length} item(s)` : 'nothing to copy', error: false });
      return;
    }
    if (mod && key === 'x') {
      handled();
      if (copySelection() !== null) void removeSelection();
      return;
    }
    if (mod && key === 'v') {
      handled();
      void paste();
      return;
    }
    if (mod && key === 'd') {
      handled();
      const clip = copyItems(kind.kind, graphRef.current, selectionRef.current, fixedTypes);
      if (clip.nodes.length + clip.groups.length + clip.comments.length > 0) void pasteClip(clip, { offset: [GRID * 2, GRID * 2] });
      return;
    }
    if (mod && key === 'a') {
      handled();
      const g = graphRef.current;
      setSelection(new Set([...g.nodes.map((n) => n.id), ...(g.comments ?? []).map((c) => c.id), ...(g.groups ?? []).map((x) => x.id)]));
      return;
    }
    if (mod && key === 'g') {
      handled();
      void addGroup();
      return;
    }
    if (mod) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      handled();
      void removeSelection();
      return;
    }
    if (key === 'f') {
      handled();
      frame(ev.shiftKey ? null : selectionRef.current);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[ev.key];
    if (dir !== undefined && selectionRef.current.size > 0) {
      handled();
      const step = GRID * (ev.shiftKey ? 5 : 1);
      const base = keyMoveRef.current ?? moveSet(selectionRef.current);
      if (keyMoveRef.current === null) keyMoveRef.current = new Map(base);
      const cur = movedRef.current.size > 0 ? movedRef.current : base;
      const m = new Map<string, GraphPoint>();
      for (const [id, pos] of cur) m.set(id, [snap(pos[0] + dir[0] * step, snapOn), snap(pos[1] + dir[1] * step, snapOn)]);
      movedRef.current = m;
      requestDraw();
      setTick((x) => x + 1);
    }
  };

  const onKeyUp = (ev: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (ev.key === ' ') {
      const s = spaceRef.current;
      spaceRef.current = { down: false, used: false };
      const t = ev.target as HTMLElement;
      if (s.down && !s.used && t.dataset['port'] === undefined && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
        const m = mouseRef.current ?? { sx: sizeRef.current.w / 2, sy: sizeRef.current.h / 2 };
        openCatalogue(m.sx, m.sy, null);
      }
      return;
    }
    if (ev.key.startsWith('Arrow') && keyMoveRef.current !== null) {
      // One keyboard move (press → release) is one edit.
      const orig = keyMoveRef.current;
      keyMoveRef.current = null;
      const moves = [...movedRef.current].filter(([id, pos]) => {
        const o = orig.get(id);
        return o !== undefined && (o[0] !== pos[0] || o[1] !== pos[1]);
      });
      if (moves.length > 0) void edit([{ op: 'moveNodes', moves: moves.map(([id, position]) => ({ id, position })) }]);
    }
  };

  const activatePort = (el: HTMLElement): void => {
    const end: PortEnd = { node: el.dataset['node']!, port: el.dataset['port']!, side: el.dataset['side'] as 'in' | 'out' };
    if (pendingPort === null) {
      setPendingPort(end);
      setStatus({ text: `wire from ${end.side === 'out' ? 'output' : 'input'} "${end.port}" — focus a port and press Enter to connect (Esc cancels)`, error: false });
      return;
    }
    const from = pendingPort;
    setPendingPort(null);
    void connect(from, end);
  };

  // ---- the catalogue ----------------------------------------------------------------------

  const catalogueEntries = useMemo(() => {
    if (catalogue === null) return [];
    let only: readonly GraphNodeDef[] | undefined;
    if (catalogue.from !== null) {
      const g = graphRef.current;
      const n = g.nodes.find((x) => x.id === catalogue.from!.node);
      const d = n !== undefined ? nodeDefOf(kind, n.type) : undefined;
      const port = (catalogue.from.side === 'out' ? d?.outputs : d?.inputs)?.find((p) => p.id === catalogue.from!.port);
      only = port !== undefined ? compatibleNodeDefs(kind, port.type, catalogue.from.side).map((x) => x.def) : [];
    }
    return searchCatalogue(kind, catalogue.query, only);
  }, [catalogue, kind]);

  const onCatalogueKey = (ev: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (catalogue === null) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      setCatalogue(null);
      rootRef.current?.focus();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = catalogueEntries.length;
      if (n > 0) setCatalogue({ ...catalogue, active: (catalogue.active + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const d = catalogueEntries[catalogue.active];
      if (d !== undefined) void addNodeFromCatalogue(d.type);
    }
  };

  // ---- inline text editing ------------------------------------------------------------------

  const commitEditing = (): void => {
    const e = editing;
    setEditing(null);
    if (e === null) return;
    const g = graphRef.current;
    if (e.kind === 'comment') {
      const c = (g.comments ?? []).find((x) => x.id === e.id);
      if (c !== undefined && c.text !== e.text && e.text.length > 0) void edit([{ op: 'setComments', comments: [{ ...c, text: e.text.slice(0, 2000) }] }]);
    } else {
      const gr = (g.groups ?? []).find((x) => x.id === e.id);
      if (gr !== undefined && gr.title !== e.text) void edit([{ op: 'setGroups', groups: [{ ...gr, title: e.text.slice(0, 64) }] }]);
    }
    rootRef.current?.focus();
  };

  // ---- DOM overlay (focus, screen readers, tests) ------------------------------------------

  const view = viewRef.current;
  void tick;
  const { w, h } = sizeRef.current;
  const viewRect: Rect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: w / view.zoom, h: h / view.zoom };
  const pos = (id: string, fallback: GraphPoint): GraphPoint => movedRef.current.get(id) ?? fallback;
  const visible = graph.nodes.filter((n) => overlaps(nodeRect(kind, { ...n, position: pos(n.id, n.position) }), viewRect));
  const domNodes = visible.length <= MAX_DOM_NODES ? visible : visible.filter((n) => selection.has(n.id));
  // Phase 16.2: a focusable handle at each wire's middle (keyboard selection, screen readers,
  // tests) — only while every node in view has its DOM element (the same budget).
  const domEdges = ((): { e: GraphData['edges'][number]; mid: GraphPoint; label: string }[] => {
    if (visible.length > MAX_DOM_NODES) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const out: { e: GraphData['edges'][number]; mid: GraphPoint; label: string }[] = [];
    for (const e of graph.edges) {
      const a = byId.get(e.from.node);
      const b = byId.get(e.to.node);
      if (a === undefined || b === undefined) continue;
      const segs = wireSegments(portPoint(kind, { ...a, position: pos(a.id, a.position) }, 'out', e.from.port), portPoint(kind, { ...b, position: pos(b.id, b.position) }, 'in', e.to.port), (e.reroutes ?? []).map((p, i) => movedRef.current.get(`${e.id}#${i}`) ?? p));
      const s = segs[Math.floor(segs.length / 2)]!;
      const mid: GraphPoint = [(s[0][0] + s[3][0]) / 2, (s[0][1] + s[3][1]) / 2];
      if (!inside(viewRect, mid)) continue;
      const extra = edgeLabels?.get(e.id);
      out.push({ e, mid, label: `wire ${nodeTitle(kind, a)} → ${nodeTitle(kind, b)}${extra !== undefined ? ` (${extra})` : ''}` });
      if (out.length >= MAX_DOM_NODES) break;
    }
    return out;
  })();
  const graphProblems = problems.filter((p) => p.nodeId === undefined);
  const errorCount = problems.filter((p) => p.severity === 'error').length;
  const warnCount = problems.length - errorCount;

  const editingRect = ((): Rect | null => {
    if (editing === null) return null;
    const g = graph;
    if (editing.kind === 'comment') {
      const c = (g.comments ?? []).find((x) => x.id === editing.id);
      return c !== undefined ? commentRect(c) : null;
    }
    const gr = (g.groups ?? []).find((x) => x.id === editing.id);
    return gr !== undefined ? { x: gr.rect[0], y: gr.rect[1], w: gr.rect[2], h: GROUP_HEADER } : null;
  })();

  return (
    <div
      ref={rootRef}
      className="tl-graph"
      tabIndex={0}
      role="application"
      aria-label={`${kind.label} editor`}
      data-graph-owner={`${owner.kind}:${owner.id}`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <div className="tl-graph__toolbar" role="toolbar" aria-label="Graph tools">
        <button className="tl-btn tl-btn--small" onClick={() => openCatalogue(sizeRef.current.w / 2 - 120, 60, null)} title="Add a node (right click or Space in the graph)">
          + Node
        </button>
        <button className="tl-btn tl-btn--small" onClick={() => void addComment()} title="Add a comment">
          Comment
        </button>
        <button className="tl-btn tl-btn--small" onClick={() => void addGroup()} title="Frame the selected nodes in a group (Ctrl+G)">
          Group
        </button>
        <span className="tl-graph__sep" />
        {(
          [
            ['left', '⇤', 'Align left edges'],
            ['centerX', '↔', 'Align horizontal centres'],
            ['right', '⇥', 'Align right edges'],
            ['top', '⤒', 'Align top edges'],
            ['centerY', '↕', 'Align vertical centres'],
            ['bottom', '⤓', 'Align bottom edges'],
            ['distributeX', '⋯', 'Distribute horizontally'],
            ['distributeY', '⋮', 'Distribute vertically'],
          ] as const
        ).map(([how, icon, label]) => (
          <button key={how} className="tl-btn tl-btn--small tl-graph__icon" aria-label={label} title={label} onClick={() => void align(how)}>
            {icon}
          </button>
        ))}
        <span className="tl-graph__sep" />
        <button className="tl-btn tl-btn--small" onClick={() => frame(selectionRef.current)} title="Fit the selection (F); Shift+F fits everything">
          Fit
        </button>
        <label className="tl-graph__check" title="Snap positions to the grid">
          <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap
        </label>
        <span ref={zoomLabelRef} className="tl-graph__zoom" aria-label="Zoom" />
        <span className="tl-graph__spacer" />
        <span className={`tl-graph__problems${errorCount > 0 ? ' is-error' : warnCount > 0 ? ' is-warn' : ''}`} aria-label="Graph problems">
          {errorCount} error{errorCount === 1 ? '' : 's'}, {warnCount} warning{warnCount === 1 ? '' : 's'}
        </span>
      </div>
      <div
        className="tl-graph__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pointerDownRef.current = false;
          dragRef.current = null;
          movedRef.current = new Map();
          requestDraw();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const { sx, sy } = localPoint(ev.clientX, ev.clientY);
          openCatalogue(sx, sy, null);
        }}
      >
        <canvas ref={canvasRef} className="tl-graph__canvas" aria-hidden="true" />
        <div ref={layerRef} className="tl-graph__layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          {domNodes.map((n) => {
            const def = nodeDefOf(kind, n.type);
            const p = pos(n.id, n.position);
            const r = nodeRect(kind, { ...n, position: p });
            const probs = problemsByNode.get(n.id) ?? [];
            return (
              <div
                key={n.id}
                className={`tl-graph__node${selection.has(n.id) ? ' is-selected' : ''}`}
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                tabIndex={0}
                role="group"
                aria-label={`${def?.label ?? n.type}${nodeTitle(kind, n) !== (def?.label ?? n.type) ? ` ${nodeTitle(kind, n)}` : ''} node ${n.id}${probs.length > 0 ? ` (${probs.map((x) => x.message).join('; ')})` : ''}`}
                aria-selected={selection.has(n.id)}
                data-node-id={n.id}
                data-node-type={n.type}
                data-problems={probs.length > 0 ? probs.map((x) => x.severity).join(' ') : undefined}
                title={probs.map((x) => `${x.severity}: ${x.message}`).join('\n') || undefined}
                onFocus={(e) => {
                  if (!pointerDownRef.current && e.target === e.currentTarget && !selectionRef.current.has(n.id)) setSelection(new Set([n.id]));
                }}
              >
                {(['in', 'out'] as const).flatMap((side) =>
                  ((side === 'in' ? def?.inputs : def?.outputs) ?? []).map((port) => {
                    const pt = portPoint(kind, { ...n, position: p }, side, port.id);
                    return (
                      <button
                        key={`${side}:${port.id}`}
                        className={`tl-graph__port${pendingPort?.node === n.id && pendingPort.port === port.id && pendingPort.side === side ? ' is-pending' : ''}`}
                        style={{ left: pt[0] - r.x - 7, top: pt[1] - r.y - 7 }}
                        aria-label={`${side === 'in' ? 'input' : 'output'} ${port.label} (${portTypeLabel(kind, port.type)}) of ${def?.label ?? n.type} ${n.id}`}
                        data-node={n.id}
                        data-port={port.id}
                        data-side={side}
                        tabIndex={0}
                      />
                    );
                  }),
                )}
              </div>
            );
          })}
          {(graph.comments ?? []).map((c) => {
            const r = commentRect(c, pos(c.id, c.position));
            if (!overlaps(r, viewRect)) return null;
            return <div key={c.id} className="tl-graph__item" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} tabIndex={0} role="note" aria-label={`Comment: ${c.text}`} data-comment-id={c.id} onFocus={(e) => !pointerDownRef.current && e.target === e.currentTarget && !selectionRef.current.has(c.id) && setSelection(new Set([c.id]))} />;
          })}
          {domEdges.map(({ e, mid, label }) => (
            <div
              key={e.id}
              className={`tl-graph__wire${selection.has(e.id) ? ' is-selected' : ''}`}
              style={{ left: mid[0] - 9, top: mid[1] - 9 }}
              tabIndex={0}
              role="button"
              aria-label={label}
              aria-pressed={selection.has(e.id)}
              data-edge-id={e.id}
              onFocus={(ev) => !pointerDownRef.current && ev.target === ev.currentTarget && !selectionRef.current.has(e.id) && setSelection(new Set([e.id]))}
            />
          ))}
          {(graph.groups ?? []).map((g) => {
            const at = pos(g.id, [g.rect[0], g.rect[1]]);
            return <div key={g.id} className="tl-graph__item" style={{ left: at[0], top: at[1], width: g.rect[2], height: GROUP_HEADER }} tabIndex={0} role="group" aria-label={`Group ${g.title}`} data-group-id={g.id} onFocus={(e) => !pointerDownRef.current && e.target === e.currentTarget && !selectionRef.current.has(g.id) && setSelection(new Set([g.id]))} />;
          })}
        </div>
        {editing !== null && editingRect !== null && (
          <div className="tl-graph__edit" style={{ left: editingRect.x * view.zoom + view.x, top: editingRect.y * view.zoom + view.y, width: Math.max(160, editingRect.w * view.zoom), height: editing.kind === 'comment' ? Math.max(60, editingRect.h * view.zoom) : undefined }}>
            {editing.kind === 'comment' ? (
              <textarea
                autoFocus
                aria-label="Edit comment"
                value={editing.text}
                maxLength={2000}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEditing();
                  e.stopPropagation();
                }}
              />
            ) : (
              <input
                autoFocus
                aria-label="Edit group title"
                value={editing.text}
                maxLength={64}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                  if (e.key === 'Enter') commitEditing();
                  e.stopPropagation();
                }}
              />
            )}
          </div>
        )}
        {catalogue !== null && (
          <div className="tl-graph__popup" role="dialog" aria-label="Add node" style={{ left: Math.min(catalogue.sx, w - 250), top: Math.min(catalogue.sy, h - 320) }}>
            <input
              autoFocus
              className="tl-input"
              placeholder={catalogue.from !== null ? 'Nodes that take this wire…' : 'Search nodes…'}
              aria-label="Search nodes"
              value={catalogue.query}
              onChange={(e) => setCatalogue({ ...catalogue, query: e.target.value, active: 0 })}
              onKeyDown={onCatalogueKey}
            />
            <div className="tl-graph__list" role="listbox" aria-label="Node catalogue">
              {catalogueEntries.length === 0 && <div className="tl-hint">No matching nodes.</div>}
              {kind.categories.map((cat) => {
                const items = catalogueEntries.filter((d) => d.category === cat);
                if (items.length === 0) return null;
                return (
                  <div key={cat} role="group" aria-label={cat}>
                    <div className="tl-graph__cat">{cat}</div>
                    {items.map((d) => {
                      const index = catalogueEntries.indexOf(d);
                      return (
                        <button
                          key={d.type}
                          role="option"
                          aria-selected={index === catalogue.active}
                          className={`tl-graph__entry${index === catalogue.active ? ' is-active' : ''}`}
                          title={d.description ?? d.label}
                          onClick={() => void addNodeFromCatalogue(d.type)}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <canvas
          ref={miniRef}
          className="tl-graph__minimap"
          style={{ width: MINIMAP.w, height: MINIMAP.h }}
          aria-label="Minimap"
          role="img"
          onPointerDown={(ev) => {
            ev.stopPropagation();
            (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
            dragRef.current = { mode: 'minimap' };
            centreFromMinimap(ev);
          }}
          onPointerMove={(ev) => {
            ev.stopPropagation();
            if (dragRef.current?.mode === 'minimap') centreFromMinimap(ev);
          }}
          onPointerUp={(ev) => {
            ev.stopPropagation();
            dragRef.current = null;
          }}
        />
        {(status !== null || graphProblems.length > 0) && (
          <div className={`tl-graph__status${status?.error === true || (status === null && graphProblems.length > 0) ? ' is-error' : ''}`} role="status">
            {status?.text ?? graphProblems.map((p) => p.message).join('; ')}
          </div>
        )}
      </div>
    </div>
  );

  function centreFromMinimap(ev: ReactPointerEvent<HTMLCanvasElement>): void {
    const r = ev.currentTarget.getBoundingClientRect();
    const m = miniMapRef.current;
    const gx = (ev.clientX - r.left - m.ox) / m.scale;
    const gy = (ev.clientY - r.top - m.oy) / m.scale;
    const v = viewRef.current;
    setView({ ...v, x: sizeRef.current.w / 2 - gx * v.zoom, y: sizeRef.current.h / 2 - gy * v.zoom });
  }
}

function allRects(kind: GraphKindDef, g: GraphData, only?: ReadonlySet<string>): Rect[] {
  const keep = (id: string): boolean => only === undefined || only.has(id);
  return [
    ...g.nodes.filter((n) => keep(n.id)).map((n) => nodeRect(kind, n)),
    ...(g.comments ?? []).filter((c) => keep(c.id)).map((c) => commentRect(c)),
    ...(g.groups ?? []).filter((x) => keep(x.id)).map((x) => groupRect(x)),
  ];
}
