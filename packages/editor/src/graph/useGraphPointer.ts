/**
 * The graph editor's pointer: pan, move, box select, wires, reroute points, double-click edits,
 * the wheel zoom and the minimap.
 */
import { useEffect, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  commentRect,
  groupRect,
  overlaps,
  snap,
  toGraph,
  wireDistance,
  wireSegments,
  zoomAt,
  type GraphPoint,
  type Rect,
} from './model';
import type { GraphEditorProps } from './graph-editor-parts';
import type { GraphView } from './useGraphView';
import type { GraphActions } from './useGraphActions';

export function useGraphPointer(gv: GraphView, ga: GraphActions, props: GraphEditorProps) {
  const { kind, onOpenNode, edgeTip } = props;
  const { portPoint, nodeRect, planConnection, rootRef, canvasRef, viewRef, sizeRef, dragRef, movedRef, mouseRef, spaceRef, miniMapRef, pointerDownRef, graphRef, selectionRef, snapOn, setStatus, setCatalogue, setEditing, hoverEdge, setHoverEdge, hoverAt, setHoverAt, setSelection, requestDraw, setView } = gv;
  const { localPoint, edit, hitTest, moveSet, openCatalogue, connect, connectToNode } = ga;
  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    if ((ev.target as HTMLElement).closest('.tl-graph__popup, .tl-graph__toolbar, .tl-graph__edit, .tl-graph__minimap, .tl-empty-state')) return;
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
    // A text selection left in the page would make the browser start a native
    // drag of it on this press (then cancel the pointer and so our gesture).
    window.getSelection()?.removeAllRanges();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    if (hit.type === 'port') {
      // A new wire gesture: the last gesture's result no longer describes what is on screen.
      setStatus(null);
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
      if (e !== null && edgeTip !== undefined) setHoverAt({ sx, sy });
      else if (hoverAt !== null) setHoverAt(null);
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
      // Dropped on another node's body: its best port on the other side, or why none fits.
      const over = hitTest(d.at);
      if (over.type === 'node' && over.id !== d.from.node) {
        void connectToNode(d.from, over.id);
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
    if ((ev.target as HTMLElement).closest('.tl-graph__popup, .tl-graph__toolbar, .tl-graph__edit, .tl-graph__minimap, .tl-empty-state')) return;
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
  }, [setView, canvasRef, viewRef]);

  function centreFromMinimap(ev: ReactPointerEvent<HTMLCanvasElement>): void {
    const r = ev.currentTarget.getBoundingClientRect();
    const m = miniMapRef.current;
    const gx = (ev.clientX - r.left - m.ox) / m.scale;
    const gy = (ev.clientY - r.top - m.oy) / m.scale;
    const v = viewRef.current;
    setView({ ...v, x: sizeRef.current.w / 2 - gx * v.zoom, y: sizeRef.current.h / 2 - gy * v.zoom });
  }
  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, centreFromMinimap };
}
export type GraphPointer = ReturnType<typeof useGraphPointer>;
