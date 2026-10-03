/**
 * The pure editing model of the UI document editor — widget
 * tree operations (add, delete, reorder, reparent, duplicate), the layout
 * and drag maths of the preview's direct manipulation (move and resize of
 * anchored rects with snapping, anchor presets), the view-model mock values
 * and the neutral starting values of new documents, themes and widgets.
 *
 * Every function returns new values (the stored document is never mutated);
 * the caller sends the result as one `setUiDocument` / `setUiTheme` (one
 * undo step). No DOM, no React.
 */
import type { UiBindable, UiDocument, UiStyle, UiTheme, UiWidget, UiWidgetType } from '@thirdlight/project-model';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A widget's place in its document: child indices from the root; `t` is a list's template. `[]` is the root. */
export type WidgetPath = readonly (number | 't')[];

/** The preview's `data-tl-path` form: `r`, `r.0.2`, `r.1.t`. */
export function pathKey(p: WidgetPath): string {
  return ['r', ...p.map(String)].join('.');
}

export function parsePathKey(key: string): WidgetPath | null {
  const parts = key.split('.');
  if (parts[0] !== 'r') return null;
  const out: (number | 't')[] = [];
  for (const s of parts.slice(1)) {
    if (s === 't') out.push('t');
    else if (/^\d{1,4}$/.test(s)) out.push(Number(s));
    else return null;
  }
  return out;
}

export const samePath = (a: WidgetPath | null, b: WidgetPath | null): boolean => a !== null && b !== null && pathKey(a) === pathKey(b);
export const parentPath = (p: WidgetPath): WidgetPath => p.slice(0, -1);
/** `a` is `b` or inside it. */
export const isWithin = (a: WidgetPath, b: WidgetPath): boolean => a.length >= b.length && b.every((x, i) => a[i] === x);

export function widgetAt(root: UiWidget, path: WidgetPath): UiWidget | null {
  let w: UiWidget | undefined = root;
  for (const s of path) {
    if (w === undefined) return null;
    w = s === 't' ? w.template : w.children?.[s];
  }
  return w ?? null;
}

/** Replace the widget at `path` with `fn(widget)` (null removes it; the root cannot be removed). */
export function replaceAt(root: UiWidget, path: WidgetPath, fn: (w: UiWidget) => UiWidget | null): UiWidget {
  if (path.length === 0) {
    const r = fn(root);
    if (r === null) throw new Error('the root widget cannot be removed');
    return r;
  }
  const [head, ...rest] = path;
  if (head === 't') {
    if (root.template === undefined) return root;
    if (rest.length === 0) {
      const t = fn(root.template);
      if (t === null) {
        const { template: _t, ...others } = root;
        return others as UiWidget;
      }
      return { ...root, template: t };
    }
    return { ...root, template: replaceAt(root.template, rest, fn) };
  }
  const kids = root.children ?? [];
  const child = kids[head!];
  if (child === undefined) return root;
  if (rest.length === 0) {
    const next = fn(child);
    return { ...root, children: next === null ? kids.filter((_, i) => i !== head) : kids.map((c, i) => (i === head ? next : c)) };
  }
  return { ...root, children: kids.map((c, i) => (i === head ? replaceAt(c, rest, fn) : c)) };
}

/** Where a widget keeps its children: a list only its template, a panel/stack/grid/button a child list. */
export function holds(w: UiWidget): 'children' | 'template' | null {
  if (w.type === 'list') return 'template';
  return w.type === 'panel' || w.type === 'stack' || w.type === 'grid' || w.type === 'button' ? 'children' : null;
}

/** The children of this widget flow (stack, grid, list, button) — its children are not anchored. */
export function flowsChildren(w: UiWidget): boolean {
  return w.type === 'stack' || w.type === 'grid' || w.type === 'list' || w.type === 'button';
}

/** A widget is placed by anchors (the root, or a child of a panel) — else its parent flows it. */
export function isAnchored(root: UiWidget, path: WidgetPath): boolean {
  if (path.length === 0) return true;
  const w = widgetAt(root, path);
  if (w?.worldAnchor !== undefined) return false;
  const parent = widgetAt(root, parentPath(path));
  return parent !== null && !flowsChildren(parent);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function collectIds(root: UiWidget, out: Set<string> = new Set()): Set<string> {
  if (root.id !== undefined) out.add(root.id);
  for (const c of root.children ?? []) collectIds(c, out);
  if (root.template !== undefined) collectIds(root.template, out);
  return out;
}

const NAME_MAX = 32;

/** `base`, else `base2`, `base3`… not in `taken` (a widget id / style / tween name: letter or _, then letters, digits, _ -). */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  let b = base.replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z_]+/, '');
  if (b === '') b = 'item';
  b = b.slice(0, NAME_MAX - 3);
  if (!taken.has(b)) return b;
  const stem = b.replace(/\d+$/, '') || b;
  for (let i = 2; i < 10_000; i += 1) {
    const c = `${stem}${i}`.slice(0, NAME_MAX);
    if (!taken.has(c)) return c;
  }
  return `${stem}${Date.now() % 100_000}`;
}

/** Give every id in a copied subtree a fresh one (and keep references inside the copy pointing at the copies). */
function renameIds(w: UiWidget, taken: Set<string>, map: Map<string, string>): UiWidget {
  const out: UiWidget = { ...w };
  if (w.id !== undefined) {
    const id = uniqueName(w.id, taken);
    taken.add(id);
    map.set(w.id, id);
    out.id = id;
  }
  if (w.children !== undefined) out.children = w.children.map((c) => renameIds(c, taken, map));
  if (w.template !== undefined) out.template = renameIds(w.template, taken, map);
  return out;
}
function remapRefs(w: UiWidget, map: ReadonlyMap<string, string>): UiWidget {
  const out: UiWidget = { ...w };
  if (w.nav !== undefined) out.nav = Object.fromEntries(Object.entries(w.nav).map(([k, v]) => [k, map.get(v) ?? v]));
  if (w.worldAnchor?.indicator !== undefined) out.worldAnchor = { ...w.worldAnchor, indicator: map.get(w.worldAnchor.indicator) ?? w.worldAnchor.indicator };
  if (w.children !== undefined) out.children = w.children.map((c) => remapRefs(c, map));
  if (w.template !== undefined) out.template = remapRefs(w.template, map);
  return out;
}

// ---------------------------------------------------------------------------
// Tree operations
// ---------------------------------------------------------------------------

export interface TreeResult {
  readonly root: UiWidget;
  /** Where the edited widget is now. */
  readonly path: WidgetPath;
}
export type TreeOutcome = TreeResult | { readonly error: string };

/** Insert `widget` into the container at `parent` (at `index`, default the end). */
export function insertWidget(root: UiWidget, parent: WidgetPath, widget: UiWidget, index?: number): TreeOutcome {
  const p = widgetAt(root, parent);
  if (p === null) return { error: 'the parent widget is gone' };
  const kind = holds(p);
  if (kind === null) return { error: `a ${p.type} widget holds no children` };
  if (kind === 'template') {
    if (p.template !== undefined) return { error: 'a list has one template widget: edit or replace it' };
    if (widget.type === 'list') return { error: 'a list template cannot hold another list' };
    return { root: replaceAt(root, parent, (w) => ({ ...w, template: widget })), path: [...parent, 't'] };
  }
  if (widget.type === 'list' && parent.includes('t')) return { error: 'a list template cannot hold another list' };
  const kids = p.children ?? [];
  const at = Math.max(0, Math.min(kids.length, index ?? kids.length));
  return { root: replaceAt(root, parent, (w) => ({ ...w, children: [...kids.slice(0, at), widget, ...kids.slice(at)] })), path: [...parent, at] };
}

export function removeWidget(root: UiWidget, path: WidgetPath): TreeOutcome {
  if (path.length === 0) return { error: 'the root widget cannot be deleted' };
  if (widgetAt(root, path) === null) return { error: 'the widget is gone' };
  if (path[path.length - 1] === 't') return { error: 'a list needs its template: replace it, or delete the list' };
  return { root: replaceAt(root, path, () => null), path: parentPath(path) };
}

/** Move a widget up (−1) or down (+1) among its siblings. */
export function reorderWidget(root: UiWidget, path: WidgetPath, delta: -1 | 1): TreeOutcome {
  const last = path[path.length - 1];
  if (typeof last !== 'number') return { error: 'this widget has no siblings to move among' };
  const parent = parentPath(path);
  const kids = widgetAt(root, parent)?.children ?? [];
  const to = last + delta;
  if (to < 0 || to >= kids.length) return { error: 'already at the end' };
  const next = [...kids];
  const [moved] = next.splice(last, 1);
  next.splice(to, 0, moved!);
  return { root: replaceAt(root, parent, (w) => ({ ...w, children: next })), path: [...parent, to] };
}

/** Move a widget into another container (at `index`, default the end). */
export function reparentWidget(root: UiWidget, path: WidgetPath, target: WidgetPath, index?: number): TreeOutcome {
  if (path.length === 0) return { error: 'the root widget cannot move' };
  if (isWithin(target, path)) return { error: 'a widget cannot move into itself' };
  if (path[path.length - 1] === 't') return { error: 'a list needs its template: move its content instead' };
  const w = widgetAt(root, path);
  const t = widgetAt(root, target);
  if (w === null || t === null) return { error: 'the widget is gone' };
  if (holds(t) === null) return { error: `a ${t.type} widget holds no children` };
  // Remove first, then find the target again (its path shifts when it came after the moved widget among the same siblings).
  const removed = replaceAt(root, path, () => null);
  const at = path.length - 1;
  const shifted = [...target];
  const lastIdx = path[at] as number;
  if (target.length > at && isWithin(target.slice(0, at), path.slice(0, at)) && typeof target[at] === 'number' && (target[at] as number) > lastIdx) shifted[at] = (target[at] as number) - 1;
  let idx = index;
  if (idx !== undefined && samePath(shifted, parentPath(path)) && idx > lastIdx) idx -= 1;
  return insertWidget(removed, shifted, w, idx);
}

/** Copy a widget next to itself (ids renamed to stay unique; references inside the copy follow). */
export function duplicateWidget(root: UiWidget, path: WidgetPath): TreeOutcome {
  if (path.length === 0) return { error: 'the root widget cannot be duplicated' };
  const last = path[path.length - 1];
  if (typeof last !== 'number') return { error: 'a list has one template' };
  const w = widgetAt(root, path);
  if (w === null) return { error: 'the widget is gone' };
  const map = new Map<string, string>();
  const copy = remapRefs(renameIds(w, collectIds(root), map), map);
  return insertWidget(root, parentPath(path), copy, last + 1);
}

/** Every widget in document order with its path and depth (the hierarchy's rows). */
export function flattenTree(root: UiWidget): { path: WidgetPath; widget: UiWidget; depth: number }[] {
  const out: { path: WidgetPath; widget: UiWidget; depth: number }[] = [];
  const go = (w: UiWidget, p: WidgetPath): void => {
    out.push({ path: p, widget: w, depth: p.length });
    (w.children ?? []).forEach((c, i) => go(c, [...p, i]));
    if (w.template !== undefined) go(w.template, [...p, 't']);
  };
  go(root, []);
  return out;
}

/** A short label for a hierarchy row. */
export function widgetLabel(w: UiWidget): string {
  const text = w.text !== undefined ? ` "${w.text.replace(/\[[^\]]*\]/g, '').slice(0, 24)}"` : '';
  return `${w.id ?? w.type}${w.id !== undefined ? ` (${w.type})` : ''}${text}`;
}

// ---------------------------------------------------------------------------
// New values
// ---------------------------------------------------------------------------

export const WIDGET_TYPES: readonly UiWidgetType[] = ['panel', 'stack', 'grid', 'text', 'image', 'bar', 'button', 'list', 'input'];

/**
 * A new widget with neutral starting values a designer then tunes: sizes
 * big enough to see and grab in the preview, a visible bar track and button
 * face (otherwise both are invisible until styled), an id so events,
 * navigation and tweens can name it. `texture` is the first texture of the
 * project (an image needs one).
 */
export function newWidget(type: UiWidgetType, taken: ReadonlySet<string>, texture: string | null): UiWidget | { error: string } {
  const id = uniqueName(type, taken);
  switch (type) {
    case 'panel':
      return { id, type, size: [240, 160] };
    case 'stack':
      return { id, type, direction: 'column', gap: 8, children: [] };
    case 'grid':
      return { id, type, columns: 2, gap: 8, children: [] };
    case 'text':
      return { id, type, text: 'Text' };
    case 'image':
      if (texture === null) return { error: 'an image shows a texture: import one first (Assets)' };
      return { id, type, image: texture, size: [64, 64] };
    case 'bar':
      return { id, type, size: [200, 16], value: 0.5, fillColor: '#4caf50', css: { background: '#202020' } };
    case 'button':
      return { id, type, text: 'Button', css: { background: '#39424e', color: '#ffffff', padding: [6, 14, 6, 14], radius: 4 } };
    case 'list':
      return { id, type, items: { bind: 'items' }, gap: 4, template: { type: 'text', text: '{$item}' } };
    case 'input':
      return { id, type, placeholder: 'Type here', size: [200, 28], css: { background: '#ffffff', color: '#000000', padding: [2, 6, 2, 6] } };
  }
}

/** A new document: a full-view panel root (anchored children place themselves in it). */
export function newUiDocument(uiDocumentId: string, name: string): UiDocument {
  return { uiDocumentId, name: name.slice(0, 64), root: { type: 'panel', stretch: 'both' } };
}

/** A new theme with one style to start from. */
export function newUiTheme(uiThemeId: string, name: string): UiTheme {
  return { uiThemeId, name: name.slice(0, 64), styles: { label: { color: '#ffffff', fontSize: 18 } } };
}

// ---------------------------------------------------------------------------
// Layout and drag maths (document px; the preview converts from the screen)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapOptions {
  /** Grid step in document px (0: no grid). */
  readonly grid: number;
  /** Distance (document px) within which an edge or centre snaps to a guide. */
  readonly threshold: number;
  /** Guide lines per axis (parent edges and centre, siblings' edges and centres), parent-local. */
  readonly guidesX: readonly number[];
  readonly guidesY: readonly number[];
}

export const NO_SNAP: SnapOptions = { grid: 0, threshold: 0, guidesX: [], guidesY: [] };

/** The guides of a parent box and sibling rects (all parent-local). */
export function guidesFor(parent: { w: number; h: number }, siblings: readonly Rect[]): { guidesX: number[]; guidesY: number[] } {
  const xs = [0, parent.w / 2, parent.w];
  const ys = [0, parent.h / 2, parent.h];
  for (const s of siblings) {
    xs.push(s.x, s.x + s.w / 2, s.x + s.w);
    ys.push(s.y, s.y + s.h / 2, s.y + s.h);
  }
  return { guidesX: xs, guidesY: ys };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Snap a span [start, start+size] moved to `start`: its start, centre or end
 * to the nearest guide within the threshold, else its start to the grid.
 * Returns the snapped start and the guide used (for drawing).
 */
export function snapSpan(start: number, size: number, guides: readonly number[], grid: number, threshold: number): { start: number; guide: number | null } {
  let best: { d: number; start: number; guide: number } | null = null;
  if (threshold > 0) {
    for (const g of guides) {
      for (const [edge, off] of [[start, 0], [start + size / 2, size / 2], [start + size, size]] as const) {
        const d = Math.abs(edge - g);
        if (d <= threshold && (best === null || d < best.d)) best = { d, start: g - off, guide: g };
      }
    }
  }
  if (best !== null) return { start: round(best.start), guide: best.guide };
  if (grid > 0) return { start: round(Math.round(start / grid) * grid), guide: null };
  return { start: round(start), guide: null };
}

/** Snap one edge (a resize) to the nearest guide within the threshold, else to the grid. */
export function snapEdge(edge: number, guides: readonly number[], grid: number, threshold: number): { edge: number; guide: number | null } {
  let best: { d: number; g: number } | null = null;
  if (threshold > 0) for (const g of guides) {
    const d = Math.abs(edge - g);
    if (d <= threshold && (best === null || d < best.d)) best = { d, g };
  }
  if (best !== null) return { edge: round(best.g), guide: best.g };
  if (grid > 0) return { edge: round(Math.round(edge / grid) * grid), guide: null };
  return { edge: round(edge), guide: null };
}

/** The placement fields a drag writes. */
export type PlacementPatch = Pick<UiWidget, 'anchor' | 'pivot' | 'offset' | 'size' | 'stretch' | 'margin'>;

const stretchX = (w: UiWidget): boolean => w.stretch === 'x' || w.stretch === 'both';
const stretchY = (w: UiWidget): boolean => w.stretch === 'y' || w.stretch === 'both';
/** A widget's offset; an axis bound to the view model stays bound (a drag moves only numbers; the preview draws it at 0). */
type Offset = [UiBindable<number>, UiBindable<number>];
const offsetOf = (w: UiWidget): Offset => [w.offset?.[0] ?? 0, w.offset?.[1] ?? 0];
const offsetPx = (o: Offset, a: 0 | 1): number => {
  const v = o[a];
  return typeof v === 'number' ? v : 0;
};
/** Move a numeric offset axis by `d` (false: it is bound, left as it is). */
const shiftOffset = (o: Offset, a: 0 | 1, d: number): boolean => {
  const v = o[a];
  if (typeof v !== 'number') return false;
  o[a] = round(v + d);
  return true;
};
/** A size axis given as a number (null: sized to the content, or read from the view model — the preview measures it). */
const fixedSize = (w: UiWidget, a: 0 | 1): number | null => {
  const v = w.size?.[a];
  return typeof v === 'number' ? v : null;
};

/**
 * The rect an anchored widget occupies in its parent (parent-local px), from
 * its placement and its measured size (the size it has when `size` leaves an
 * axis to its content). Mirrors the game host's placement CSS.
 */
export function placedRect(w: UiWidget, parent: { w: number; h: number }, measured: { w: number; h: number }): Rect {
  const anchor = w.anchor ?? [0, 0];
  const pivot = w.pivot ?? anchor;
  const offset = offsetOf(w);
  const margin = w.margin ?? [0, 0, 0, 0];
  let x: number;
  let width: number;
  if (stretchX(w)) {
    x = margin[0];
    width = Math.max(0, parent.w - margin[0] - margin[2]);
  } else {
    width = fixedSize(w, 0) ?? measured.w;
    x = anchor[0] * parent.w + offsetPx(offset, 0) - pivot[0] * width;
  }
  let y: number;
  let height: number;
  if (stretchY(w)) {
    y = margin[1];
    height = Math.max(0, parent.h - margin[1] - margin[3]);
  } else {
    height = fixedSize(w, 1) ?? measured.h;
    y = anchor[1] * parent.h + offsetPx(offset, 1) - pivot[1] * height;
  }
  return { x: round(x), y: round(y), w: round(width), h: round(height) };
}

/**
 * Move an anchored widget by (dx, dy) document px from where the drag began
 * (`rect`, parent-local). The moved rect snaps (edges/centre to guides, else
 * the grid); an axis with a size moves its offset, a stretched axis shifts
 * both margins. Returns the patch and the guides that caught it.
 */
export function moveWidgetBy(w: UiWidget, rect: Rect, dx: number, dy: number, snap: SnapOptions): { patch: PlacementPatch; guideX: number | null; guideY: number | null } {
  const sx = snapSpan(rect.x + dx, rect.w, snap.guidesX, snap.grid, snap.threshold);
  const sy = snapSpan(rect.y + dy, rect.h, snap.guidesY, snap.grid, snap.threshold);
  const ddx = sx.start - rect.x;
  const ddy = sy.start - rect.y;
  const patch: PlacementPatch = {};
  const offset = offsetOf(w);
  const margin = [...(w.margin ?? [0, 0, 0, 0])] as [number, number, number, number];
  let offsetChanged = false;
  let marginChanged = false;
  if (stretchX(w)) {
    margin[0] = round(margin[0] + ddx);
    margin[2] = round(margin[2] - ddx);
    marginChanged = true;
  } else offsetChanged = shiftOffset(offset, 0, ddx) || offsetChanged;
  if (stretchY(w)) {
    margin[1] = round(margin[1] + ddy);
    margin[3] = round(margin[3] - ddy);
    marginChanged = true;
  } else offsetChanged = shiftOffset(offset, 1, ddy) || offsetChanged;
  if (offsetChanged) patch.offset = offset;
  if (marginChanged) patch.margin = margin;
  return { patch, guideX: sx.guide, guideY: sy.guide };
}

/** A resize grip: the edges it moves. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The smallest size a drag leaves (a widget stays grabbable). */
export const MIN_DRAG_SIZE = 4;

/**
 * Resize an anchored widget by dragging a grip (dx, dy document px from
 * where the drag began). The moving edge snaps; the opposite edge stays put:
 * a sized axis writes its size and shifts its offset by the pivot's share, a
 * stretched axis moves its margin. A widget in a flowing parent (`flow`)
 * only gets a size.
 */
export function resizeWidgetBy(w: UiWidget, rect: Rect, handle: ResizeHandle, dx: number, dy: number, snap: SnapOptions, flow = false): { patch: PlacementPatch; guideX: number | null; guideY: number | null } {
  const anchor = w.anchor ?? [0, 0];
  const pivot = w.pivot ?? anchor;
  const patch: PlacementPatch = {};
  const size: [UiBindable<number> | null, UiBindable<number> | null] = [w.size?.[0] ?? null, w.size?.[1] ?? null];
  const offset = offsetOf(w);
  const margin = [...(w.margin ?? [0, 0, 0, 0])] as [number, number, number, number];
  let sizeChanged = false;
  let offsetChanged = false;
  let marginChanged = false;
  let guideX: number | null = null;
  let guideY: number | null = null;
  const axis = (a: 0 | 1, lowEdge: boolean, d: number): void => {
    const start = a === 0 ? rect.x : rect.y;
    const len = a === 0 ? rect.w : rect.h;
    const guides = a === 0 ? snap.guidesX : snap.guidesY;
    const stretched = a === 0 ? stretchX(w) : stretchY(w);
    if (lowEdge) {
      const s = snapEdge(start + d, guides, snap.grid, snap.threshold);
      const edge = Math.min(s.edge, start + len - MIN_DRAG_SIZE);
      const moved = round(edge - start);
      const nextLen = round(len - moved);
      if (a === 0) guideX = s.guide;
      else guideY = s.guide;
      if (!flow && stretched) {
        margin[a === 0 ? 0 : 1] = round(margin[a === 0 ? 0 : 1] + moved);
        marginChanged = true;
      } else {
        size[a] = nextLen;
        sizeChanged = true;
        if (!flow) offsetChanged = shiftOffset(offset, a, (1 - pivot[a]) * moved) || offsetChanged;
      }
    } else {
      const s = snapEdge(start + len + d, guides, snap.grid, snap.threshold);
      const edge = Math.max(s.edge, start + MIN_DRAG_SIZE);
      const nextLen = round(edge - start);
      const grew = round(nextLen - len);
      if (a === 0) guideX = s.guide;
      else guideY = s.guide;
      if (!flow && stretched) {
        margin[a === 0 ? 2 : 3] = round(margin[a === 0 ? 2 : 3] - grew);
        marginChanged = true;
      } else {
        size[a] = nextLen;
        sizeChanged = true;
        if (!flow) offsetChanged = shiftOffset(offset, a, pivot[a] * grew) || offsetChanged;
      }
    }
  };
  if (handle.includes('w')) axis(0, true, dx);
  if (handle.includes('e')) axis(0, false, dx);
  if (handle.includes('n')) axis(1, true, dy);
  if (handle.includes('s')) axis(1, false, dy);
  if (sizeChanged) patch.size = size;
  if (offsetChanged) patch.offset = offset;
  if (marginChanged) patch.margin = margin;
  return { patch, guideX, guideY };
}

/** Anchor presets: a point of the parent (the widget's pivot follows), or a stretch along one axis or both. */
export interface AnchorPreset {
  readonly label: string;
  /** Anchor/pivot on the axes it pins (null: that axis stretches). */
  readonly x: number | null;
  readonly y: number | null;
}

export const ANCHOR_PRESETS: readonly AnchorPreset[] = [
  { label: 'top left', x: 0, y: 0 },
  { label: 'top', x: 0.5, y: 0 },
  { label: 'top right', x: 1, y: 0 },
  { label: 'left', x: 0, y: 0.5 },
  { label: 'centre', x: 0.5, y: 0.5 },
  { label: 'right', x: 1, y: 0.5 },
  { label: 'bottom left', x: 0, y: 1 },
  { label: 'bottom', x: 0.5, y: 1 },
  { label: 'bottom right', x: 1, y: 1 },
  { label: 'stretch top', x: null, y: 0 },
  { label: 'stretch middle', x: null, y: 0.5 },
  { label: 'stretch bottom', x: null, y: 1 },
  { label: 'stretch left', x: 0, y: null },
  { label: 'stretch centre', x: 0.5, y: null },
  { label: 'stretch right', x: 1, y: null },
  { label: 'stretch both', x: null, y: null },
];

/**
 * Apply an anchor preset. With `keep` the widget stays where it is on
 * screen (its offset or margins are recomputed from its current rect);
 * without it, it moves onto the anchor (offset 0, margins 0). The result is
 * the whole placement (absent fields removed by the caller when undefined).
 */
export function applyAnchorPreset(w: UiWidget, preset: AnchorPreset, rect: Rect, parent: { w: number; h: number }, keep: boolean): PlacementPatch {
  const out: PlacementPatch = {};
  const sx = preset.x === null;
  const sy = preset.y === null;
  out.stretch = sx && sy ? 'both' : sx ? 'x' : sy ? 'y' : undefined;
  const ax = preset.x ?? 0;
  const ay = preset.y ?? 0;
  out.anchor = sx && sy ? undefined : [ax, ay];
  out.pivot = sx && sy ? undefined : [ax, ay];
  const size: [UiBindable<number> | null, UiBindable<number> | null] = [w.size?.[0] ?? null, w.size?.[1] ?? null];
  // A pinned axis leaving a stretch keeps its drawn size.
  if (!sx && stretchX(w)) size[0] = rect.w;
  if (!sy && stretchY(w)) size[1] = rect.h;
  if (sx) size[0] = null;
  if (sy) size[1] = null;
  out.size = size[0] === null && size[1] === null ? undefined : size;
  // An offset axis bound to the view model keeps its binding.
  const offset: Offset = [typeof w.offset?.[0] === 'object' ? w.offset[0] : 0, typeof w.offset?.[1] === 'object' ? w.offset[1] : 0];
  const margin: [number, number, number, number] = [0, 0, 0, 0];
  if (keep) {
    if (!sx && typeof offset[0] === 'number') offset[0] = round(rect.x - ax * parent.w + ax * rect.w);
    else {
      margin[0] = round(rect.x);
      margin[2] = round(parent.w - rect.x - rect.w);
    }
    if (!sy && typeof offset[1] === 'number') offset[1] = round(rect.y - ay * parent.h + ay * rect.h);
    else {
      margin[1] = round(rect.y);
      margin[3] = round(parent.h - rect.y - rect.h);
    }
  }
  out.offset = sx && sy ? undefined : offset[0] === 0 && offset[1] === 0 ? undefined : offset;
  out.margin = !sx && !sy ? undefined : margin.every((m) => m === 0) ? undefined : margin;
  return out;
}

/** Write a placement patch into a widget (an undefined field is removed). */
export function withPlacement(w: UiWidget, patch: PlacementPatch): UiWidget {
  const out: Record<string, unknown> = { ...w };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as UiWidget;
}

/** The preset a widget's placement matches (null: none). */
export function currentPreset(w: UiWidget): AnchorPreset | null {
  const sx = stretchX(w);
  const sy = stretchY(w);
  const a = w.anchor ?? [0, 0];
  return ANCHOR_PRESETS.find((p) => (p.x === null) === sx && (p.y === null) === sy && (p.x === null || p.x === a[0]) && (p.y === null || p.y === a[1])) ?? null;
}

// ---------------------------------------------------------------------------
// Widget field edits
// ---------------------------------------------------------------------------

/** Set (or with undefined, remove) one field of a widget. */
export function setWidgetField(w: UiWidget, key: string, value: unknown): UiWidget {
  const out: Record<string, unknown> = { ...w };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out as unknown as UiWidget;
}

// ---------------------------------------------------------------------------
// Styles and themes
// ---------------------------------------------------------------------------

/** The style names a document can use: its own, then its theme's. */
export function styleNames(doc: UiDocument, theme: UiTheme | undefined): string[] {
  return [...new Set([...Object.keys(doc.styles ?? {}), ...Object.keys(theme?.styles ?? {})])].sort();
}

/** Set (or remove, with undefined) one value of a named style (or of one of its states). */
export function setStyleValue(style: UiStyle, state: 'hover' | 'focus' | 'pressed' | 'disabled' | null, key: string, value: unknown): UiStyle {
  if (state === null) return setWidgetField(style as unknown as UiWidget, key, value) as unknown as UiStyle;
  const sub = { ...(style[state] ?? {}) } as Record<string, unknown>;
  if (value === undefined) delete sub[key];
  else sub[key] = value;
  const out = { ...style } as Record<string, unknown>;
  if (Object.keys(sub).length === 0) delete out[state];
  else out[state] = sub;
  return out as UiStyle;
}

// ---------------------------------------------------------------------------
// View-model mock values
// ---------------------------------------------------------------------------

/** The paths a document reads from the view model, with what kind of value each wants. */
export function bindingPaths(doc: UiDocument): { path: string; kind: 'number' | 'px' | 'text' | 'bool' | 'list' | 'value' }[] {
  const out = new Map<string, 'number' | 'px' | 'text' | 'bool' | 'list' | 'value'>();
  const add = (raw: string, kind: 'number' | 'px' | 'text' | 'bool' | 'list' | 'value'): void => {
    const p = raw.startsWith('!') ? raw.slice(1) : raw;
    if (p.startsWith('$item') || p.startsWith('$index')) return;
    if (!out.has(p)) out.set(p, kind);
  };
  const bind = (v: unknown, kind: 'number' | 'px' | 'text' | 'bool' | 'list' | 'value'): void => {
    if (typeof v === 'object' && v !== null && typeof (v as { bind?: unknown }).bind === 'string') add((v as { bind: string }).bind, kind);
  };
  const go = (w: UiWidget): void => {
    bind(w.visible, 'bool');
    bind(w.enabled, 'bool');
    if (w.type === 'bar') {
      bind(w.value, 'number');
      bind(w.min, 'number');
      bind(w.max, 'number');
      bind(w.startAngle, 'number');
    } else bind(w.value, 'text');
    bind(w.size?.[0], 'px');
    bind(w.size?.[1], 'px');
    bind(w.image, 'text');
    bind(w.items, 'list');
    bind(w.worldAnchor?.entity, 'text');
    for (const m of (w.text ?? '').matchAll(/\{([^{}]*)\}/g)) add(m[1]!, 'value');
    for (const c of w.children ?? []) go(c);
    if (w.template !== undefined) go(w.template);
  };
  go(doc.root);
  return [...out].map(([path, kind]) => ({ path, kind })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

function writeMock(obj: Record<string, unknown>, segs: readonly string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i]!;
    const next = cur[s];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1]!;
  if (!(last in cur)) cur[last] = value;
}

/** Add a sample value for every bound path the mock lacks (a bar gets 0.5, a bound size 100 px, a list three items, a text its path). */
export function fillMock(doc: UiDocument, mock: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(mock);
  for (const b of bindingPaths(doc)) {
    const segs = b.path.split('.');
    if (segs.length === 0 || segs.some((s) => s === '')) continue;
    const sample = b.kind === 'number' ? 0.5 : b.kind === 'px' ? 100 : b.kind === 'bool' ? true : b.kind === 'list' ? ['One', 'Two', 'Three'] : b.kind === 'text' ? segs[segs.length - 1]! : 7;
    writeMock(out, segs, sample);
  }
  return out;
}

/** Parse the mock JSON panel: an object whose top-level keys are view-model roots (`$flow` feeds `$flow.*`). */
export function parseMock(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'the mock values are one JSON object ({ "hud": { "hp": 3 } })' };
  return { ok: true, value: v as Record<string, unknown> };
}

/** The view-model writes a mock stands for (the UI layer's `set` entries) and the `$flow` values. */
export function mockWrites(mock: Record<string, unknown>): { set: [string, unknown][]; flow: Record<string, unknown> | null } {
  const set: [string, unknown][] = [];
  let flow: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(mock)) {
    if (k === '$flow') {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) flow = v as Record<string, unknown>;
      continue;
    }
    if (/^[A-Za-z0-9_-]{1,32}$/.test(k)) set.push([k, v]);
  }
  return { set, flow };
}

// ---------------------------------------------------------------------------
// Preview resolutions
// ---------------------------------------------------------------------------

/** Preview sizes: the usual game aspect ratios (and a portrait phone), or the document's reference size. */
export const RESOLUTION_PRESETS: readonly { id: string; label: string; w: number; h: number }[] = [
  { id: '16:9', label: '16:9 (1920×1080)', w: 1920, h: 1080 },
  { id: '16:9-720', label: '16:9 (1280×720)', w: 1280, h: 720 },
  { id: '4:3', label: '4:3 (1024×768)', w: 1024, h: 768 },
  { id: '21:9', label: '21:9 (2560×1080)', w: 2560, h: 1080 },
  { id: 'portrait', label: 'Portrait 9:16 (1080×1920)', w: 1080, h: 1920 },
];

/**
 * The safe-area inset in percent of each side: the classic TV action-safe
 * margin (5 %), where overscan and rounded phone corners can cut a UI off.
 */
export const DEFAULT_SAFE_AREA_PERCENT = 5;
