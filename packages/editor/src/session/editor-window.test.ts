import { describe, expect, it } from 'vitest';

import {
  INITIAL_WORKSPACE,
  MAX_DOCUMENT_TABS,
  activeDoc,
  parseWorkspace,
  reduceWorkspace,
  serializeWorkspace,
  tabKeys,
  type WorkspaceAction,
  type WorkspaceState,
} from './editor-window';

const run = (...actions: WorkspaceAction[]): WorkspaceState => actions.reduce(reduceWorkspace, INITIAL_WORKSPACE);
const a = { kind: 'animator', id: 'animator-01' };
const b = { kind: 'script', id: 'mover' };
const c = { kind: 'script', id: 'door' };

describe('editor window', () => {
  it('opens items as tabs of the window, the last one in front', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b });
    expect(tabKeys(s)).toEqual(['animator:animator-01', 'script:mover']);
    expect(s.active).toBe('script:mover');
    expect(s.open).toBe(true);
    expect(activeDoc(s)).toEqual(b);
  });

  it('opening an open item brings its tab to the front instead of adding one', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: { ...a } });
    expect(s.docs).toHaveLength(2);
    expect(s.active).toBe('animator:animator-01');
  });

  it('closing the window keeps its tabs; the next open shows them again', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'show', on: false });
    expect(s.open).toBe(false);
    expect(activeDoc(s)).toBeNull();
    expect(s.docs).toEqual([a, b]);
    const t = reduceWorkspace(s, { type: 'open', doc: c });
    expect(t.open).toBe(true);
    expect(tabKeys(t)).toEqual(['animator:animator-01', 'script:mover', 'script:door']);
    expect(reduceWorkspace(s, { type: 'show' }).open).toBe(true);
    // Nothing open: the window cannot show.
    expect(reduceWorkspace(INITIAL_WORKSPACE, { type: 'show', on: true })).toBe(INITIAL_WORKSPACE);
  });

  it('the Scene or Game view changes under the window, which stays as it is', () => {
    const s = run({ type: 'open', doc: a }, { type: 'view', view: 'game' });
    expect(s.open).toBe(true);
    expect(s.view).toBe('game');
    expect(reduceWorkspace(s, { type: 'view', view: 'game' })).toBe(s);
  });

  it('closing the tab in front hands over to its right neighbour, else its left one; the last closes the window', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: c }, { type: 'activate', key: 'script:mover' });
    const t = reduceWorkspace(s, { type: 'close', key: 'script:mover' });
    expect(t.active).toBe('script:door');
    const u = reduceWorkspace(t, { type: 'close', key: 'script:door' });
    expect(u.active).toBe('animator:animator-01');
    const v = reduceWorkspace(u, { type: 'close', key: 'animator:animator-01' });
    expect(v).toEqual({ ...INITIAL_WORKSPACE });
  });

  it('closing a tab behind keeps the one in front', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'close', key: 'animator:animator-01' });
    expect(s.active).toBe('script:mover');
    expect(s.docs).toEqual([b]);
  });

  it('reorders by moving a tab to another tab’s place', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: c }, { type: 'move', from: 'script:door', to: 'animator:animator-01' });
    expect(s.docs).toEqual([c, a, b]);
    const t = reduceWorkspace(s, { type: 'move', from: 'script:door', to: 'script:mover' });
    expect(t.docs).toEqual([a, b, c]);
    expect(reduceWorkspace(t, { type: 'move', from: 'scene', to: 'script:door' })).toBe(t);
  });

  it('Ctrl+Tab cycles the window tabs, wrapping; with the window closed it swaps Scene and Game', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: c });
    const next = (x: WorkspaceState): WorkspaceState => reduceWorkspace(x, { type: 'cycle', dir: 1 });
    expect([next(s).active, next(next(s)).active]).toEqual(['animator:animator-01', 'script:mover']);
    expect(reduceWorkspace(s, { type: 'cycle', dir: -1 }).active).toBe('script:mover');
    const closed = reduceWorkspace(s, { type: 'show', on: false });
    expect(next(closed).view).toBe('game');
    expect(next(next(closed)).view).toBe('scene');
    expect(next(closed).open).toBe(false);
  });

  it('toggles maximize', () => {
    const s = run({ type: 'maximize' });
    expect(s.maximized).toBe(true);
    expect(reduceWorkspace(s, { type: 'maximize' }).maximized).toBe(false);
    expect(reduceWorkspace(s, { type: 'maximize', on: true })).toBe(s);
  });

  it('caps the number of tabs', () => {
    let s = INITIAL_WORKSPACE;
    for (let i = 0; i < MAX_DOCUMENT_TABS + 3; i++) s = reduceWorkspace(s, { type: 'open', doc: { kind: 'script', id: `b${i}` } });
    expect(s.docs).toHaveLength(MAX_DOCUMENT_TABS);
  });

  it('round-trips through the layout storage and drops what it cannot trust', () => {
    const kinds = new Set(['animator', 'script']);
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'maximize' });
    expect(parseWorkspace(serializeWorkspace(s), kinds)).toEqual(s);
    const closed = reduceWorkspace(s, { type: 'show', on: false });
    expect(parseWorkspace(serializeWorkspace(closed), kinds)).toEqual(closed);
    // The Game view is empty after a reload (nothing plays): the Scene view comes back.
    expect(parseWorkspace(serializeWorkspace({ ...closed, view: 'game' }), kinds).view).toBe('scene');
    expect(parseWorkspace(null, kinds)).toBe(INITIAL_WORKSPACE);
    expect(parseWorkspace('{not json', kinds)).toBe(INITIAL_WORKSPACE);
    const odd = JSON.stringify({ docs: [a, a, { kind: 'unknown', id: 'x' }, { kind: 'script', id: '' }, { kind: 'script' }, 7], active: 'unknown:x', open: true, maximized: 'yes' });
    expect(parseWorkspace(odd, kinds)).toEqual({ docs: [a], active: 'animator:animator-01', open: false, view: 'scene', maximized: false });
  });

  it('reads an entry stored before the window: its front document opens the window', () => {
    const kinds = new Set(['animator', 'script']);
    expect(parseWorkspace(JSON.stringify({ docs: [a, b], active: 'script:mover', maximized: false }), kinds)).toEqual({ docs: [a, b], active: 'script:mover', open: true, view: 'scene', maximized: false });
    expect(parseWorkspace(JSON.stringify({ docs: [a, b], active: 'scene', maximized: false }), kinds).open).toBe(false);
  });
});
