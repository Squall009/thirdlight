/**
 * The graph editor's elements over the canvas: the toolbar, the DOM layer (focusable nodes, ports,
 * wires, comments and groups for the keyboard, screen readers and tests), the inline edit, the node
 * catalogue, the minimap, the wire tip and the status line. A plain render function (no hooks):
 * the page's element tree is the component's own.
 */
import type { JSX } from 'react';

import {
  commentRect,
  GROUP_HEADER,
  inside,
  nodeDefOf,
  nodeTitle,
  overlaps,
  portTypeLabel,
  snap,
  toGraph,
  wireSegments,
  type GraphData,
  type GraphPoint,
  type Rect,
} from './model';
import { ToolButton, ToolbarSeparator, ToolbarSpacer, EmptyState } from '../ui/chrome/EditorChrome';
import { familyOf } from './node-style';
import { MINIMAP, MAX_DOM_NODES, type GraphEditorProps } from './graph-editor-parts';
import type { GraphView } from './useGraphView';
import type { GraphActions } from './useGraphActions';
import type { GraphPointer } from './useGraphPointer';
import type { GraphKeyboard } from './useGraphKeyboard';

export function renderGraphEditor(gv: GraphView, ga: GraphActions, gp: GraphPointer, gk: GraphKeyboard, props: GraphEditorProps): JSX.Element {
  const { kind, owner, graph, edgeLabels, highlighted, breakpoints, onToggleBreakpoint, current, edgeTip, onDropItem, nodeNotes } = props;
  const { portPoint, nodeRect, portsOfNode, rootRef, canvasRef, miniRef, viewRef, sizeRef, dragRef, movedRef, pointerDownRef, graphRef, selection, selectionRef, tick, snapOn, setSnapOn, status, setStatus, catalogue, setCatalogue, editing, setEditing, pendingPort, hoverEdge, hoverAt, problems, problemsByNode, setSelection, requestDraw, layerRef, zoomLabelRef } = gv;
  const { localPoint, openCatalogue, frame, align, addGroup, addComment, addNodeFromCatalogue } = ga;
  const { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, centreFromMinimap } = gp;
  const { onKeyDown, onKeyUp, catalogueEntries, onCatalogueKey, commitEditing } = gk;
  const view = viewRef.current;
  void tick;
  const { w, h } = sizeRef.current;
  const viewRect: Rect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: w / view.zoom, h: h / view.zoom };
  const pos = (id: string, fallback: GraphPoint): GraphPoint => movedRef.current.get(id) ?? fallback;
  const visible = graph.nodes.filter((n) => overlaps(nodeRect(kind, { ...n, position: pos(n.id, n.position) }), viewRect));
  const domNodes = visible.length <= MAX_DOM_NODES ? visible : visible.filter((n) => selection.has(n.id));
  // A focusable handle at each wire's middle (keyboard selection, screen readers,
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

  // Nothing but the nodes every graph of the kind must have (an output, an entry): the editor says how to begin.
  const required = graph.nodes.map((n) => nodeDefOf(kind, n.type)).filter((d) => d?.required === true).map((d) => d!.label);
  const structureOnly = graph.nodes.length === required.length;
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
      <div className="tl-graph__toolbar tl-editor-toolbar" role="toolbar" aria-label="Graph tools">
        <ToolButton action="add-node" label="Node" title="Add a node (right click or Space in the graph)" onClick={() => openCatalogue(sizeRef.current.w / 2 - 120, 60, null)} />
        <ToolButton action="comment" label="Comment" title="Add a comment" onClick={() => void addComment()} />
        <ToolButton action="group" label="Group" title="Frame the selected nodes in a group (Ctrl+G)" onClick={() => void addGroup()} />
        {onToggleBreakpoint !== undefined && (
          <ToolButton
            action="breakpoint"
            label="Breakpoint"
            title="Toggle a breakpoint on the selected nodes (F9): Play pauses after the step in which the node runs"
            onClick={() => {
              const ids = graphRef.current.nodes.filter((n) => selectionRef.current.has(n.id)).map((n) => n.id);
              if (ids.length > 0) onToggleBreakpoint(ids);
              else setStatus({ text: 'select a node to put a breakpoint on it', error: false });
            }}
          />
        )}
        <ToolbarSeparator />
        {(
          [
            ['left', 'align-left', 'Align left edges'],
            ['centerX', 'align-center-x', 'Align horizontal centres'],
            ['right', 'align-right', 'Align right edges'],
            ['top', 'align-top', 'Align top edges'],
            ['centerY', 'align-center-y', 'Align vertical centres'],
            ['bottom', 'align-bottom', 'Align bottom edges'],
            ['distributeX', 'distribute-x', 'Distribute horizontally'],
            ['distributeY', 'distribute-y', 'Distribute vertically'],
          ] as const
        ).map(([how, icon, label]) => (
          <ToolButton key={how} action={icon} aria={label} onClick={() => void align(how)} />
        ))}
        <ToolbarSeparator />
        <ToolButton action="fit" label="Fit" title="Fit the selection (F); Shift+F fits everything" onClick={() => frame(selectionRef.current)} />
        <ToolButton action="snap" label="Snap" title="Snap positions to the grid" pressed={snapOn} onClick={() => setSnapOn(!snapOn)} />
        <span ref={zoomLabelRef} className="tl-graph__zoom" aria-label="Zoom" />
        <ToolbarSpacer />
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
          if (dragRef.current?.mode === 'wire') setStatus({ text: 'wire cancelled: nothing connected', error: false });
          dragRef.current = null;
          movedRef.current = new Map();
          requestDraw();
        }}
        onDoubleClick={onDoubleClick}
        onDragStart={(ev) => {
          // Pressing and moving on the stage is a graph gesture (wire, move, box), never a native drag of what is under the pointer.
          ev.preventDefault();
        }}
        onDragOver={(ev) => {
          if (onDropItem !== undefined) ev.preventDefault();
        }}
        onDrop={(ev) => {
          if (onDropItem === undefined) return;
          ev.preventDefault();
          const { sx, sy } = localPoint(ev.clientX, ev.clientY);
          const at = toGraph(viewRef.current, sx, sy);
          onDropItem(ev.dataTransfer, [snap(at[0], snapOn), snap(at[1], snapOn)], { x: ev.clientX, y: ev.clientY });
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const { sx, sy } = localPoint(ev.clientX, ev.clientY);
          openCatalogue(sx, sy, null);
        }}
      >
        <canvas ref={canvasRef} className="tl-graph__canvas" aria-hidden="true" />
        {structureOnly && (
          <EmptyState
            overlay
            kind={owner.kind === 'behavior' ? 'visual-script' : owner.kind}
            title="No nodes yet"
            actions={<ToolButton action="add-node" label="Add a node" onClick={() => openCatalogue(sizeRef.current.w / 2 - 120, 60, null)} />}
          >
            {required.length > 0 ? `Wire nodes into ${required.join(', ')}. ` : ''}Right-click or press Space in the graph for the node catalogue, or drag from a port.
          </EmptyState>
        )}
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
                data-node-family={familyOf(def?.category)}
                data-problems={probs.length > 0 ? probs.map((x) => x.severity).join(' ') : undefined}
                data-breakpoint={breakpoints?.has(n.id) === true ? 'true' : undefined}
                data-active={highlighted?.has(n.id) === true ? 'true' : undefined}
                data-current={current === n.id ? 'true' : undefined}
                title={probs.map((x) => `${x.severity}: ${x.message}`).join('\n') || undefined}
                onFocus={(e) => {
                  if (!pointerDownRef.current && e.target === e.currentTarget && !selectionRef.current.has(n.id)) setSelection(new Set([n.id]));
                }}
              >
                {(nodeNotes?.get(n.id) ?? []).length > 0 && (
                  <div className="tl-graph__node-notes" data-node-notes={n.id} title={nodeNotes!.get(n.id)!.join(' · ')} style={{ top: r.h + 4 }}>
                    {nodeNotes!.get(n.id)!.map((t) => (
                      <span key={t} className="tl-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {(['in', 'out'] as const).flatMap((side) =>
                  (side === 'in' ? portsOfNode(n).inputs : portsOfNode(n).outputs).map((port) => {
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
              data-value={edgeTip?.(e.id) ?? undefined}
              title={edgeTip?.(e.id) ?? undefined}
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
                    <div className="tl-graph__cat" data-node-family={familyOf(cat)}>
                      {cat}
                    </div>
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
        {hoverEdge !== null && hoverAt !== null && edgeTip !== undefined && edgeTip(hoverEdge) !== null && (
          <div className="tl-graph__tip" role="tooltip" aria-label="Wire value" style={{ left: hoverAt.sx + 14, top: hoverAt.sy + 14 }}>
            {edgeTip(hoverEdge)}
          </div>
        )}
        {(status !== null || graphProblems.length > 0) && (
          <div className={`tl-graph__status${status?.error === true || (status === null && graphProblems.length > 0) ? ' is-error' : ''}`} role="status">
            {status?.text ?? graphProblems.map((p) => p.message).join('; ')}
          </div>
        )}
      </div>
    </div>
  );
}
