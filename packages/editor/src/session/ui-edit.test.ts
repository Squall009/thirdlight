import { describe, expect, it } from 'vitest';
import type { UiDocument, UiWidget } from '@thirdlight/project-model';

import {
  ANCHOR_PRESETS,
  applyAnchorPreset,
  bindingPaths,
  collectIds,
  currentPreset,
  duplicateWidget,
  fillMock,
  flattenTree,
  guidesFor,
  insertWidget,
  isAnchored,
  mockWrites,
  moveWidgetBy,
  NO_SNAP,
  newWidget,
  parseMock,
  parsePathKey,
  pathKey,
  placedRect,
  removeWidget,
  reorderWidget,
  reparentWidget,
  resizeWidgetBy,
  snapEdge,
  snapSpan,
  uniqueDocId,
  uniqueName,
  widgetAt,
  withPlacement,
  type TreeOutcome,
  type TreeResult,
} from './ui-edit';

const ok = (r: TreeOutcome): TreeResult => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

const TREE: UiWidget = {
  type: 'panel',
  stretch: 'both',
  children: [
    { id: 'col', type: 'stack', children: [{ id: 'a', type: 'text', text: 'A' }, { id: 'b', type: 'text', text: 'B' }] },
    { id: 'box', type: 'panel', children: [] },
    { id: 'rows', type: 'list', items: { bind: 'rows' }, template: { id: 'row', type: 'text', text: '{$item}' } },
  ],
};

describe('widget paths and the tree', () => {
  it('paths round-trip through the preview key and address widgets', () => {
    expect(pathKey([])).toBe('r');
    expect(pathKey([0, 1])).toBe('r.0.1');
    expect(pathKey([2, 't'])).toBe('r.2.t');
    expect(parsePathKey('r.2.t')).toEqual([2, 't']);
    expect(parsePathKey('x.1')).toBeNull();
    expect(widgetAt(TREE, [0, 1])?.id).toBe('b');
    expect(widgetAt(TREE, [2, 't'])?.id).toBe('row');
    expect(widgetAt(TREE, [9])).toBeNull();
    expect(flattenTree(TREE).map((r) => pathKey(r.path))).toEqual(['r', 'r.0', 'r.0.0', 'r.0.1', 'r.1', 'r.2', 'r.2.t']);
  });

  it('adds into containers only, a list holds one template', () => {
    const r = ok(insertWidget(TREE, [1], { type: 'text', text: 'new' }));
    expect(r.path).toEqual([1, 0]);
    expect(widgetAt(r.root, [1, 0])?.text).toBe('new');
    expect(TREE.children![1]!.children).toEqual([]); // not mutated
    expect(insertWidget(TREE, [0, 0], { type: 'text', text: 'x' })).toHaveProperty('error');
    expect(insertWidget(TREE, [2], { type: 'text', text: 'x' })).toHaveProperty('error');
    expect(ok(insertWidget(TREE, [0], { type: 'text', text: 'first' }, 0)).path).toEqual([0, 0]);
  });

  it('deletes, reorders, reparents and duplicates', () => {
    expect(ok(removeWidget(TREE, [0, 0])).root.children![0]!.children!.map((c) => c.id)).toEqual(['b']);
    expect(removeWidget(TREE, [])).toHaveProperty('error');
    expect(removeWidget(TREE, [2, 't'])).toHaveProperty('error');

    const down = ok(reorderWidget(TREE, [0, 0], 1));
    expect(down.path).toEqual([0, 1]);
    expect(down.root.children![0]!.children!.map((c) => c.id)).toEqual(['b', 'a']);
    expect(reorderWidget(TREE, [0, 1], 1)).toHaveProperty('error');

    // Move "col" (index 0) into "box" (index 1): box shifts to index 0 once col is out.
    const moved = ok(reparentWidget(TREE, [0], [1]));
    expect(moved.path).toEqual([0, 0]);
    expect(moved.root.children!.map((c) => c.id)).toEqual(['box', 'rows']);
    expect(widgetAt(moved.root, [0, 0])?.id).toBe('col');
    expect(reparentWidget(TREE, [0], [0, 0])).toHaveProperty('error'); // into itself / a text
    expect(reparentWidget(TREE, [1], [1])).toHaveProperty('error');

    const dup = ok(duplicateWidget(TREE, [0]));
    expect(dup.path).toEqual([1]);
    const ids = [...collectIds(dup.root)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(widgetAt(dup.root, [1])?.id).toBe('col2');
    expect(widgetAt(dup.root, [1, 0])?.id).toBe('a2');
  });

  it('duplicating keeps references inside the copy pointing at the copy', () => {
    const t: UiWidget = { type: 'panel', children: [{ id: 'm', type: 'panel', worldAnchor: { point: [0, 0, 0], indicator: 'arrow' }, children: [{ id: 'arrow', type: 'text', text: '>', nav: { up: 'arrow' } }] }] };
    const d = ok(duplicateWidget(t, [0]));
    const copy = widgetAt(d.root, [1])!;
    expect(copy.worldAnchor?.indicator).toBe('arrow2');
    expect(copy.children![0]!.nav?.up).toBe('arrow2');
  });

  it('knows which widgets are anchored (a panel child) and which flow (a stack child)', () => {
    expect(isAnchored(TREE, [])).toBe(true);
    expect(isAnchored(TREE, [1])).toBe(true);
    expect(isAnchored(TREE, [0, 0])).toBe(false);
  });

  it('names stay unique and in the id syntax', () => {
    expect(uniqueName('text', new Set(['text', 'text2']))).toBe('text3');
    expect(uniqueName('9 lives!', new Set())).toBe('lives');
    expect(uniqueDocId('Main HUD', ['main-hud'], 'ui')).toBe('main-hud-2');
    expect(uniqueDocId('!!!', [], 'ui')).toBe('ui');
    const w = newWidget('bar', new Set(['bar']), null);
    expect(w).toMatchObject({ id: 'bar2', type: 'bar', value: 0.5 });
    expect(newWidget('image', new Set(), null)).toHaveProperty('error');
  });
});

describe('layout and drag maths', () => {
  const parent = { w: 800, h: 600 };

  it('places an anchored rect like the game host (anchor, pivot, offset, size, stretch)', () => {
    expect(placedRect({ type: 'panel', size: [100, 50] }, parent, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(placedRect({ type: 'panel', anchor: [1, 1], size: [100, 50], offset: [-10, -20] }, parent, { w: 0, h: 0 })).toEqual({ x: 690, y: 530, w: 100, h: 50 });
    expect(placedRect({ type: 'panel', anchor: [0.5, 0.5], pivot: [0.5, 0.5], size: [100, 50] }, parent, { w: 0, h: 0 })).toEqual({ x: 350, y: 275, w: 100, h: 50 });
    expect(placedRect({ type: 'panel', stretch: 'x', margin: [10, 0, 30, 0], size: [null, 40] }, parent, { w: 0, h: 0 })).toEqual({ x: 10, y: 0, w: 760, h: 40 });
    // Content-sized axes use the measured size.
    expect(placedRect({ type: 'text', anchor: [1, 0] }, parent, { w: 80, h: 20 })).toEqual({ x: 720, y: 0, w: 80, h: 20 });
  });

  it('snaps a span to guides (edges and centre) before the grid', () => {
    expect(snapSpan(103, 50, [100], 8, 5)).toEqual({ start: 100, guide: 100 });
    expect(snapSpan(47, 50, [100], 8, 5)).toEqual({ start: 50, guide: 100 }); // its end snapped
    expect(snapSpan(376, 50, [400], 8, 5)).toEqual({ start: 375, guide: 400 }); // its centre snapped
    expect(snapSpan(13, 50, [100], 8, 5)).toEqual({ start: 16, guide: null }); // grid
    expect(snapSpan(13.3, 50, [], 0, 0)).toEqual({ start: 13.3, guide: null });
    expect(snapEdge(198, [200], 10, 4)).toEqual({ edge: 200, guide: 200 });
    expect(snapEdge(187, [200], 10, 4)).toEqual({ edge: 190, guide: null });
  });

  it('moves an anchored widget through its offset, a stretched axis through its margins', () => {
    const w: UiWidget = { type: 'panel', anchor: [1, 0], pivot: [1, 0], offset: [-16, 16], size: [100, 40] };
    const rect = placedRect(w, parent, { w: 0, h: 0 });
    const m = moveWidgetBy(w, rect, -30, 12, NO_SNAP);
    expect(m.patch).toEqual({ offset: [-46, 28] });
    expect(placedRect(withPlacement(w, m.patch), parent, { w: 0, h: 0 })).toEqual({ ...rect, x: rect.x - 30, y: rect.y + 12 });
    const s: UiWidget = { type: 'panel', stretch: 'x', margin: [10, 0, 10, 0], size: [null, 40] };
    const sm = moveWidgetBy(s, placedRect(s, parent, { w: 0, h: 0 }), 5, 7, NO_SNAP);
    expect(sm.patch).toEqual({ offset: [0, 7], margin: [15, 0, 5, 0] });
  });

  it('snaps a move to the parent centre', () => {
    const w: UiWidget = { type: 'panel', size: [100, 50] };
    const snap = { grid: 8, threshold: 6, ...guidesFor(parent, []) };
    const m = moveWidgetBy(w, placedRect(w, parent, { w: 0, h: 0 }), 347, 0, snap);
    expect(m.patch.offset).toEqual([350, 0]); // centre 400 = parent centre
    expect(m.guideX).toBe(400);
  });

  it('resizes from any grip keeping the opposite edge, whatever the pivot', () => {
    for (const pivot of [[0, 0], [0.5, 0.5], [1, 1]] as [number, number][]) {
      const w: UiWidget = { type: 'panel', anchor: [0.5, 0.5], pivot, offset: [10, -5], size: [100, 60] };
      const before = placedRect(w, parent, { w: 0, h: 0 });
      const se = resizeWidgetBy(w, before, 'se', 20, 10, NO_SNAP);
      const a = placedRect(withPlacement(w, se.patch), parent, { w: 0, h: 0 });
      expect(a).toEqual({ x: before.x, y: before.y, w: 120, h: 70 });
      const nw = resizeWidgetBy(w, before, 'nw', 20, 10, NO_SNAP);
      const b = placedRect(withPlacement(w, nw.patch), parent, { w: 0, h: 0 });
      expect(b).toEqual({ x: before.x + 20, y: before.y + 10, w: 80, h: 50 });
    }
  });

  it('resizes a stretched axis through its margin, a flowing child through its size only, never below the minimum', () => {
    const s: UiWidget = { type: 'panel', stretch: 'x', margin: [10, 0, 10, 0], size: [null, 40] };
    const r = resizeWidgetBy(s, placedRect(s, parent, { w: 0, h: 0 }), 'e', -30, 0, NO_SNAP);
    expect(r.patch).toEqual({ margin: [10, 0, 40, 0] });
    const f: UiWidget = { type: 'text', text: 'x' };
    expect(resizeWidgetBy(f, { x: 0, y: 0, w: 50, h: 20 }, 's', 0, 15, NO_SNAP, true).patch).toEqual({ size: [null, 35] });
    const tiny = resizeWidgetBy({ type: 'panel', size: [20, 20] }, { x: 0, y: 0, w: 20, h: 20 }, 'e', -100, 0, NO_SNAP);
    expect(tiny.patch.size).toEqual([4, 20]);
  });

  it('applies anchor presets keeping the widget where it is (or moving onto the anchor)', () => {
    const w: UiWidget = { type: 'panel', offset: [100, 100], size: [200, 50] };
    const rect = placedRect(w, parent, { w: 0, h: 0 });
    for (const p of ANCHOR_PRESETS) {
      const patch = applyAnchorPreset(w, p, rect, parent, true);
      const next = withPlacement(w, patch);
      expect(placedRect(next, parent, { w: 0, h: 0 }), p.label).toEqual(rect);
      expect(currentPreset(next), p.label).toBe(p);
    }
    const br = applyAnchorPreset(w, ANCHOR_PRESETS.find((p) => p.label === 'bottom right')!, rect, parent, false);
    expect(placedRect(withPlacement(w, br), parent, { w: 0, h: 0 })).toEqual({ x: 600, y: 550, w: 200, h: 50 });
  });
});

describe('view-model mock values', () => {
  const doc: UiDocument = {
    uiDocumentId: 'hud',
    name: 'HUD',
    root: {
      type: 'panel',
      children: [
        { type: 'bar', value: { bind: 'hud.hp' }, max: { bind: 'hud.maxHp' } },
        { type: 'text', text: 'Gold {hud.gold} of {$item}', visible: { bind: '!hud.hidden' } },
        { type: 'list', items: { bind: 'party' }, template: { type: 'text', text: '{$item.name}' } },
      ],
    },
  };

  it('finds the bound paths and fills samples without overwriting', () => {
    expect(bindingPaths(doc)).toEqual([
      { path: 'hud.gold', kind: 'value' },
      { path: 'hud.hidden', kind: 'bool' },
      { path: 'hud.hp', kind: 'number' },
      { path: 'hud.maxHp', kind: 'number' },
      { path: 'party', kind: 'list' },
    ]);
    const m = fillMock(doc, { hud: { hp: 0.25 } });
    expect(m).toEqual({ hud: { hp: 0.25, gold: 7, hidden: true, maxHp: 0.5 }, party: ['One', 'Two', 'Three'] });
  });

  it('parses the mock panel and turns it into view-model writes and $flow values', () => {
    expect(parseMock('')).toEqual({ ok: true, value: {} });
    expect(parseMock('[1]')).toHaveProperty('ok', false);
    expect(parseMock('{"a":')).toHaveProperty('ok', false);
    const p = parseMock('{"hud":{"hp":3},"$flow":{"level":{"name":"One"}},"bad key":1}');
    expect(p.ok).toBe(true);
    if (p.ok) expect(mockWrites(p.value)).toEqual({ set: [['hud', { hp: 3 }]], flow: { level: { name: 'One' } } });
  });
});
