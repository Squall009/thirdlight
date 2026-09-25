/**
 * Phase 16.1: the graph editor's canvas renderer.
 *
 * Measured choice (docs/plan-phase-16.md §6, tools/bench-graph-render.mjs):
 * one 2D canvas draws the grid, groups, comments, wires and nodes, culled to
 * the view; a DOM layer on top carries focusable elements for the nodes and
 * ports in view (keyboard, screen readers, tests). Redrawn only when
 * something changed (one requestAnimationFrame per change burst).
 */
import {
  commentRect,
  edgeConversion,
  fieldValue,
  GRID,
  GROUP_HEADER,
  HEADER,
  nodeDefOf,
  nodeRect,
  overlaps,
  portPoint,
  portTypeColor,
  ROW,
  FIELD_ROW,
  nodeTitle,
  shownFields,
  wireSegments,
  type GraphData,
  type GraphKindDef,
  type GraphNode,
  type GraphPoint,
  type GraphProblem,
  type Rect,
  type View,
} from './model';

export interface Scene {
  kind: GraphKindDef;
  graph: GraphData;
  view: View;
  width: number;
  height: number;
  /** Effective positions while a drag is in flight (id → position). */
  moved: ReadonlyMap<string, GraphPoint>;
  selected: ReadonlySet<string>;
  problems: ReadonlyMap<string, GraphProblem[]>;
  /** A wire being dragged: from a port to a point, and whether the hover target accepts it. */
  wire: { from: GraphPoint; to: GraphPoint; color: string; ok: boolean | null } | null;
  box: Rect | null;
  hoverEdge: string | null;
  /** Phase 16.2: a short label drawn on a wire (e.g. "×2" for two transitions of one pair). */
  edgeLabels?: ReadonlyMap<string, string>;
  /** Phase 16.2: nodes drawn highlighted (e.g. the live preview's current state). */
  highlighted?: ReadonlySet<string>;
}

const COLORS = {
  bg: '#0f1217',
  grid: '#191d24',
  gridMajor: '#20252e',
  node: '#20252d',
  nodeLine: '#343b47',
  header: '#2b3a52',
  text: '#e8ebf0',
  dim: '#9aa3b2',
  select: '#4c8dff',
  err: '#ff5d5d',
  warn: '#ffcf5c',
  comment: '#3a3524',
  commentLine: '#6b5f36',
  lit: '#f2b544',
};

export function positionOf(scene: Scene, id: string, fallback: GraphPoint): GraphPoint {
  return scene.moved.get(id) ?? fallback;
}

function effectiveNode(scene: Scene, n: GraphNode): GraphNode {
  const p = scene.moved.get(n.id);
  return p === undefined ? n : { ...n, position: p };
}

export function drawGraph(ctx: CanvasRenderingContext2D, scene: Scene, dpr: number): void {
  const { view, width, height, kind, graph } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  // Grid (minor every GRID, major every 5): skipped when too dense to read.
  const step = GRID * view.zoom;
  if (step >= 6) {
    for (const [every, color] of [[1, COLORS.grid], [5, COLORS.gridMajor]] as const) {
      const s = step * every;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = ((view.x % s) + s) % s; x < width; x += s) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = ((view.y % s) + s) % s; y < height; y += s) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(width, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }

  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
  const viewRect: Rect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: width / view.zoom, h: height / view.zoom };
  const detail = view.zoom >= 0.45;
  const px = 1 / view.zoom;

  // Groups.
  for (const g of graph.groups ?? []) {
    const p = positionOf(scene, g.id, [g.rect[0], g.rect[1]]);
    const r = { x: p[0], y: p[1], w: g.rect[2], h: g.rect[3] };
    if (!overlaps(r, viewRect)) continue;
    ctx.fillStyle = hexA(g.color, 0.14);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = hexA(g.color, 0.5);
    ctx.fillRect(r.x, r.y, r.w, GROUP_HEADER);
    ctx.strokeStyle = scene.selected.has(g.id) ? COLORS.select : hexA(g.color, 0.8);
    ctx.lineWidth = (scene.selected.has(g.id) ? 2 : 1) * px;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (detail) {
      ctx.fillStyle = COLORS.text;
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(clip(g.title, r.w / 7.5), r.x + 8, r.y + 16);
    }
  }

  // Comments.
  for (const c of graph.comments ?? []) {
    const r = commentRect(c, positionOf(scene, c.id, c.position));
    if (!overlaps(r, viewRect)) continue;
    ctx.fillStyle = COLORS.comment;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = scene.selected.has(c.id) ? COLORS.select : COLORS.commentLine;
    ctx.lineWidth = (scene.selected.has(c.id) ? 2 : 1) * px;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (detail) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '12px sans-serif';
      c.text.split('\n').slice(0, Math.floor((r.h - 8) / 16)).forEach((line, i) => ctx.fillText(clip(line, r.w / 6.6), r.x + 8, r.y + 18 + i * 16));
    }
  }

  // Wires.
  const nodes = new Map(graph.nodes.map((n) => [n.id, effectiveNode(scene, n)]));
  ctx.lineCap = 'round';
  for (const e of graph.edges) {
    const a = nodes.get(e.from.node);
    const b = nodes.get(e.to.node);
    if (a === undefined || b === undefined) continue;
    const from = portPoint(kind, a, 'out', e.from.port);
    const to = portPoint(kind, b, 'in', e.to.port);
    const reroutes = (e.reroutes ?? []).map((p, i) => scene.moved.get(`${e.id}#${i}`) ?? p);
    const xs = [from[0], to[0], ...reroutes.map((p) => p[0])];
    const ys = [from[1], to[1], ...reroutes.map((p) => p[1])];
    const bb = { x: Math.min(...xs) - 60, y: Math.min(...ys) - 60, w: Math.max(...xs) - Math.min(...xs) + 120, h: Math.max(...ys) - Math.min(...ys) + 120 };
    if (!overlaps(bb, viewRect)) continue;
    const outDef = nodeDefOf(kind, a.type)?.outputs.find((p) => p.id === e.from.port);
    const color = portTypeColor(kind, outDef?.type ?? '');
    const conv = edgeConversion(kind, graph, e);
    const hot = scene.selected.has(e.id) || scene.hoverEdge === e.id || scene.selected.has(a.id) || scene.selected.has(b.id);
    ctx.strokeStyle = scene.selected.has(e.id) ? COLORS.select : color;
    ctx.lineWidth = (hot ? 3 : 2) * Math.max(px, 1);
    ctx.setLineDash(conv !== null ? [8, 5] : []);
    ctx.beginPath();
    const segs = wireSegments(from, to, reroutes);
    for (const s of segs) {
      ctx.moveTo(s[0][0], s[0][1]);
      ctx.bezierCurveTo(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of reroutes) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
      ctx.fill();
    }
    const extra = scene.edgeLabels?.get(e.id);
    if (extra !== undefined && view.zoom >= 0.35) {
      const mid = segs[Math.floor(segs.length / 2)]!;
      const m: GraphPoint = [(mid[0][0] + mid[3][0]) / 2, (mid[0][1] + mid[3][1]) / 2];
      ctx.font = 'bold 11px sans-serif';
      const w = ctx.measureText(extra).width + 10;
      ctx.fillStyle = '#11151b';
      ctx.fillRect(m[0] - w / 2, m[1] - 9, w, 18);
      ctx.strokeStyle = color;
      ctx.lineWidth = px;
      ctx.strokeRect(m[0] - w / 2, m[1] - 9, w, 18);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(extra, m[0] - w / 2 + 5, m[1] + 4);
    }
    if (conv !== null && view.zoom >= 0.6) {
      // The implicit conversion, shown on the wire.
      const mid = segs[Math.floor(segs.length / 2)]!;
      const m: GraphPoint = [(mid[0][0] + mid[3][0]) / 2, (mid[0][1] + mid[3][1]) / 2];
      const label = `${conv.from}→${conv.to}`;
      ctx.font = '10px sans-serif';
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = '#11151b';
      ctx.fillRect(m[0] - w / 2, m[1] - 8, w, 16);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(label, m[0] - w / 2 + 4, m[1] + 4);
    }
  }

  // Nodes (selected last, on top).
  const order = [...graph.nodes.filter((n) => !scene.selected.has(n.id)), ...graph.nodes.filter((n) => scene.selected.has(n.id))];
  for (const raw of order) {
    const n = nodes.get(raw.id)!;
    const r = nodeRect(kind, n);
    if (!overlaps(r, viewRect)) continue;
    drawNode(ctx, scene, n, r, detail, px);
  }

  // The wire being dragged.
  if (scene.wire !== null) {
    ctx.strokeStyle = scene.wire.ok === false ? COLORS.err : scene.wire.color;
    ctx.lineWidth = 2.5 * Math.max(px, 1);
    ctx.setLineDash(scene.wire.ok === false ? [6, 4] : []);
    ctx.beginPath();
    for (const s of wireSegments(scene.wire.from, scene.wire.to)) {
      ctx.moveTo(s[0][0], s[0][1]);
      ctx.bezierCurveTo(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (scene.box !== null) {
    ctx.fillStyle = 'rgba(76, 141, 255, .12)';
    ctx.strokeStyle = 'rgba(76, 141, 255, .8)';
    ctx.lineWidth = px;
    ctx.fillRect(scene.box.x, scene.box.y, scene.box.w, scene.box.h);
    ctx.strokeRect(scene.box.x, scene.box.y, scene.box.w, scene.box.h);
  }
}

function drawNode(ctx: CanvasRenderingContext2D, scene: Scene, n: GraphNode, r: Rect, detail: boolean, px: number): void {
  const { kind } = scene;
  const def = nodeDefOf(kind, n.type);
  const selected = scene.selected.has(n.id);
  const problems = scene.problems.get(n.id) ?? [];
  ctx.fillStyle = COLORS.node;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = COLORS.header;
  ctx.fillRect(r.x, r.y, r.w, HEADER);
  const lit = scene.highlighted?.has(n.id) === true;
  ctx.strokeStyle = selected ? COLORS.select : lit ? COLORS.lit : problems.some((p) => p.severity === 'error') ? COLORS.err : COLORS.nodeLine;
  ctx.lineWidth = (selected || lit ? 2.5 : 1) * px;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  if (detail) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = '10px sans-serif';
    ctx.fillText(n.collapsed === true ? '▸' : '▾', r.x + 6, r.y + 17);
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(clip(nodeTitle(kind, n), 20), r.x + 18, r.y + 17);
  }
  if (problems.length > 0) {
    // The problem badge: red for an error, yellow for a warning.
    ctx.fillStyle = problems.some((p) => p.severity === 'error') ? COLORS.err : COLORS.warn;
    ctx.beginPath();
    ctx.arc(r.x + r.w - 12, r.y + HEADER / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    if (detail) {
      ctx.fillStyle = '#111';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText('!', r.x + r.w - 14, r.y + HEADER / 2 + 4);
    }
  }
  if (def === undefined) return;
  const ports: [readonly { id: string; label: string; type: string }[], 'in' | 'out'][] = [[def.inputs, 'in'], [def.outputs, 'out']];
  for (const [list, side] of ports) {
    list.forEach((p) => {
      const pt = portPoint(kind, n, side, p.id);
      ctx.fillStyle = portTypeColor(kind, p.type);
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], n.collapsed === true ? 3.5 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (detail && n.collapsed !== true) {
        ctx.fillStyle = COLORS.dim;
        ctx.font = '11px sans-serif';
        if (side === 'in') ctx.fillText(clip(p.label, 11), pt[0] + 10, pt[1] + 4);
        else {
          const t = clip(p.label, 11);
          ctx.fillText(t, pt[0] - 10 - ctx.measureText(t).width, pt[1] + 4);
        }
      }
    });
  }
  if (detail && n.collapsed !== true && def.fields !== undefined) {
    const rows = Math.max(def.inputs.length, def.outputs.length);
    shownFields(def).forEach((f, i) => {
      const v = fieldValue(n, f);
      ctx.fillStyle = COLORS.dim;
      ctx.font = '11px sans-serif';
      ctx.fillText(clip(`${f.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`, 26), r.x + 10, r.y + HEADER + rows * ROW + i * FIELD_ROW + 16);
    });
  }
}

/** The minimap: every node as a dot-rect, the view as a frame. Returns the mapping it used. */
export function drawMinimap(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number, dpr: number): { scale: number; ox: number; oy: number } {
  const { kind, graph, view } = scene;
  const viewRect: Rect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: scene.width / view.zoom, h: scene.height / view.zoom };
  let x0 = viewRect.x;
  let y0 = viewRect.y;
  let x1 = viewRect.x + viewRect.w;
  let y1 = viewRect.y + viewRect.h;
  for (const n of graph.nodes) {
    const p = scene.moved.get(n.id) ?? n.position;
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0] + 180);
    y1 = Math.max(y1, p[1] + 60);
  }
  const scale = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0));
  const ox = (w - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (h - (y1 - y0) * scale) / 2 - y0 * scale;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(12, 14, 18, .92)';
  ctx.fillRect(0, 0, w, h);
  for (const g of graph.groups ?? []) {
    ctx.fillStyle = hexA(g.color, 0.3);
    ctx.fillRect(g.rect[0] * scale + ox, g.rect[1] * scale + oy, g.rect[2] * scale, g.rect[3] * scale);
  }
  for (const n of graph.nodes) {
    const r = nodeRect(kind, n, scene.moved.get(n.id) ?? n.position);
    ctx.fillStyle = scene.selected.has(n.id) ? COLORS.select : scene.problems.has(n.id) ? '#8a5a5a' : '#5a6475';
    ctx.fillRect(r.x * scale + ox, r.y * scale + oy, Math.max(1.5, r.w * scale), Math.max(1.5, r.h * scale));
  }
  ctx.strokeStyle = '#f2b544';
  ctx.lineWidth = 1;
  ctx.strokeRect(viewRect.x * scale + ox + 0.5, viewRect.y * scale + oy + 0.5, viewRect.w * scale, viewRect.h * scale);
  return { scale, ox, oy };
}

function clip(s: string, chars: number): string {
  const n = Math.max(1, Math.floor(chars));
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function hexA(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) return `rgba(128, 128, 128, ${a})`;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${a})`;
}
