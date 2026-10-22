/**
 * The graph editor's edits: every gesture becomes one `onEdit` call (one undo step) — hit tests,
 * the clipboard, delete, align, groups, comments, adding a node from the catalogue and connecting
 * ports.
 */
import { useCallback, useEffect } from 'react';
import {
  boundsOf,
  commentRect,
  compatibleNodeDefs,
  copyItems,
  deleteOps,
  fitView,
  freePlace,
  GROUP_HEADER,
  HEADER,
  inside,
  makeIdFactory,
  nodeDefOf,
  nodeRect as nodeRectBase,
  pasteItems,
  planDropOnNode,
  staticPorts,
  ROW,
  snap,
  toGraph,
  wireDistance,
  wireSegments,
  type Alignment,
  type GraphClipboard,
  type GraphData,
  type GraphOp,
  type GraphPoint,
  type PortEnd,
} from './model';
import { allRects, GROUP_COLORS, CLIPBOARDS, type Hit, type GraphEditorProps } from './graph-editor-parts';
import type { GraphView } from './useGraphView';

export function useGraphActions(gv: GraphView, props: GraphEditorProps) {
  const { kind, onEdit, focus, newNodeData, portContext } = props;
  const { fixedTypes, portsRef, portPoint, nodeRect, planConnection, itemsInGroup, alignOps, groupAround, portsOfNode, rootRef, canvasRef, viewRef, sizeRef, movedRef, mouseRef, graphRef, selectionRef, snapOn, setStatus, catalogue, setCatalogue, setEditing, setSelection, requestDraw, setView } = gv;
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
    [onEdit, requestDraw, movedRef, setStatus],
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
        const own = portsOfNode(n);
        for (const [side, list] of [['in', own.inputs], ['out', own.outputs]] as const) {
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
    [kind, graphRef, movedRef, nodeRect, portPoint, portsOfNode, selectionRef, viewRef],
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
    [kind, graphRef, itemsInGroup],
  );

  const openCatalogue = useCallback((sx: number, sy: number, from: PortEnd | null) => {
    const at = toGraph(viewRef.current, sx, sy);
    setCatalogue({ sx, sy, at, from, query: '', active: 0 });
  }, [setCatalogue, viewRef]);

  const frame = useCallback(
    (ids: ReadonlySet<string> | null) => {
      const g = graphRef.current;
      const rects = ids === null || ids.size === 0 ? allRects(kind, g, portsRef.current) : allRects(kind, g, portsRef.current, ids);
      const b = boundsOf(rects);
      if (b !== null) setView(fitView(b, sizeRef.current.w, sizeRef.current.h));
    },
    [kind, setView, graphRef, portsRef, sizeRef],
  );

  // Problems jump: select the item and frame it.
  useEffect(() => {
    if (focus === null || focus === undefined) return;
    const ids = new Set([focus.id]);
    setSelection(ids);
    frame(ids);
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focus.id)}"]`);
    el?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per focus request (id and nonce)
  }, [focus?.id, focus?.nonce]);

  // ---- clipboard and selection commands ----------------------------------------------------

  const copySelection = useCallback((): GraphClipboard | null => {
    const sel = selectionRef.current;
    if (sel.size === 0) return null;
    const clip = copyItems(kind.kind, graphRef.current, sel, fixedTypes);
    if (clip.nodes.length + clip.groups.length + clip.comments.length === 0) return null;
    CLIPBOARDS.set(kind.kind, clip);
    return clip;
  }, [kind.kind, fixedTypes, graphRef, selectionRef]);

  const pasteClip = useCallback(
    async (clip: GraphClipboard, place: { at: GraphPoint } | { offset: GraphPoint }) => {
      const { ops, ids } = pasteItems(clip, makeIdFactory(graphRef.current, 'p'), place);
      if (await edit(ops, `pasted ${ids.length} item${ids.length === 1 ? '' : 's'}`)) setSelection(new Set(ids));
    },
    [edit, setSelection, graphRef],
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
  }, [kind.kind, pasteClip, snapOn, mouseRef, setStatus, sizeRef, viewRef]);

  const removeSelection = useCallback(async () => {
    const ops = deleteOps(graphRef.current, selectionRef.current, fixedTypes);
    if (ops.length === 0) {
      if (selectionRef.current.size > 0) setStatus({ text: 'this node is part of every graph of its kind: it cannot be deleted', error: false });
      return;
    }
    if (await edit(ops)) setSelection(new Set());
  }, [edit, setSelection, fixedTypes, graphRef, selectionRef, setStatus]);

  const align = useCallback(
    async (how: Alignment) => {
      const op = alignOps(kind, graphRef.current, selectionRef.current, how, snapOn);
      if (op === null) setStatus({ text: 'select two or more nodes to align them', error: false });
      else await edit([op]);
    },
    [edit, kind, snapOn, alignOps, graphRef, selectionRef, setStatus],
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
  }, [edit, kind, setSelection, graphRef, groupAround, selectionRef, setStatus]);

  const addComment = useCallback(async () => {
    const id = makeIdFactory(graphRef.current, 'k')();
    const m = mouseRef.current;
    const at = toGraph(viewRef.current, m?.sx ?? sizeRef.current.w / 2, m?.sy ?? sizeRef.current.h / 2);
    if (await edit([{ op: 'setComments', comments: [{ id, text: 'Comment', position: [snap(at[0], snapOn), snap(at[1], snapOn)] }] }])) {
      setSelection(new Set([id]));
      setEditing({ id, kind: 'comment', text: 'Comment' });
    }
  }, [edit, setSelection, snapOn, graphRef, mouseRef, setEditing, sizeRef, viewRef]);

  const addNodeFromCatalogue = useCallback(
    async (type: string) => {
      const c = catalogue;
      if (c === null) return;
      setCatalogue(null);
      rootRef.current?.focus({ preventScroll: true });
      const def = nodeDefOf(kind, type);
      if (def === undefined) return;
      const g = graphRef.current;
      // A readable id prefix from the type (item ids are letters, digits, _ and -: "fn.input" → "fni").
      const id = makeIdFactory(g, def.type.replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'n')();
      let position: GraphPoint = [snap(c.at[0], snapOn), snap(c.at[1], snapOn)];
      const data = newNodeData?.(type);
      const withData = data !== undefined && Object.keys(data).length > 0 ? { data } : {};
      const ops: GraphOp[] = [];
      let connectTo: { from: { node: string; port: string }; to: { node: string; port: string }; replaces: string[] } | null = null;
      if (c.from !== null) {
        const fromNode = g.nodes.find((n) => n.id === c.from!.node);
        const fromPorts = fromNode !== undefined ? portsOfNode(fromNode) : { inputs: [], outputs: [] };
        const fromPort = (c.from.side === 'out' ? fromPorts.outputs : fromPorts.inputs).find((p) => p.id === c.from!.port);
        const match = fromPort !== undefined ? compatibleNodeDefs(kind, fromPort.type, c.from.side).find((x) => x.def.type === type) : undefined;
        if (match !== undefined) {
          const fresh = staticPorts(kind, { id, type, position, ...withData }, portContext);
          const list = c.from.side === 'out' ? fresh.inputs : fresh.outputs;
          const row = Math.max(0, list.findIndex((p) => p.id === match.port));
          // Put the new node's port under the drop point.
          position = [snap(c.at[0] - (c.from.side === 'out' ? 0 : 180), snapOn), snap(c.at[1] - HEADER - ROW / 2 - row * ROW, snapOn)];
          const newEnd: PortEnd = { node: id, port: match.port, side: c.from.side === 'out' ? 'in' : 'out' };
          const withNode: GraphData = { ...g, nodes: [...g.nodes, { id, type, position }] };
          const plan = planConnection(kind, withNode, c.from, newEnd);
          if (plan.ok) connectTo = plan;
        }
      }
      if (connectTo === null) {
        // Not placed by a wire drop: keep clear of the nodes already there, so its ports never sit on theirs.
        const fresh = staticPorts(kind, { id, type, position, ...withData }, portContext);
        const r = nodeRectBase(kind, { id, type, position, ...withData }, position, () => fresh);
        position = freePlace(position, { w: r.w, h: r.h }, g.nodes.map((n) => nodeRect(kind, n)), snapOn);
      }
      ops.push({ op: 'addNodes', nodes: [{ id, type, position, ...withData }] });
      if (connectTo !== null) {
        if (connectTo.replaces.length > 0) ops.push({ op: 'disconnect', ids: connectTo.replaces });
        ops.push({ op: 'connect', edges: [{ id: makeIdFactory({ ...g, nodes: [...g.nodes, { id, type, position }] }, 'e')(), from: connectTo.from, to: connectTo.to }] });
      }
      if (await edit(ops, `added ${def.label}`)) setSelection(new Set([id]));
    },
    [catalogue, edit, kind, setSelection, snapOn, newNodeData, portContext, graphRef, nodeRect, planConnection, portsOfNode, rootRef, setCatalogue],
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
    [edit, kind, graphRef, planConnection, setStatus],
  );

  const connectToNode = useCallback(
    async (from: PortEnd, nodeId: string): Promise<boolean> => {
      const plan = planDropOnNode(kind, graphRef.current, from, nodeId, portsRef.current);
      if (!plan.ok) {
        setStatus({ text: `cannot connect: ${plan.reason}`, error: true });
        return false;
      }
      return connect(from, from.side === 'out' ? { ...plan.to, side: 'in' } : { ...plan.from, side: 'out' });
    },
    [connect, kind, graphRef, portsRef, setStatus],
  );
  return { localPoint, edit, hitTest, moveSet, openCatalogue, frame, copySelection, pasteClip, paste, removeSelection, align, addGroup, addComment, addNodeFromCatalogue, connect, connectToNode };
}
export type GraphActions = ReturnType<typeof useGraphActions>;
