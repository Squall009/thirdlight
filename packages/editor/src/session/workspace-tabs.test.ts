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
} from './workspace-tabs';

const run = (...actions: WorkspaceAction[]): WorkspaceState => actions.reduce(reduceWorkspace, INITIAL_WORKSPACE);
const a = { kind: 'animator', id: 'animator-01' };
const b = { kind: 'script', id: 'mover' };
const c = { kind: 'script', id: 'door' };

describe('workspace tabs', () => {
  it('opens documents after Scene and Game and focuses them', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b });
    expect(tabKeys(s)).toEqual(['scene', 'game', 'animator:animator-01', 'script:mover']);
    expect(s.active).toBe('script:mover');
    expect(activeDoc(s)).toEqual(b);
  });

  it('opening an open document focuses its tab instead of adding one', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: { ...a } });
    expect(s.docs).toHaveLength(2);
    expect(s.active).toBe('animator:animator-01');
  });

  it('never closes Scene or Game', () => {
    const s = run({ type: 'close', key: 'scene' }, { type: 'close', key: 'game' });
    expect(s).toBe(INITIAL_WORKSPACE);
  });

  it('closing the active tab activates its right neighbour, else its left one', () => {
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'open', doc: c }, { type: 'activate', key: 'script:mover' });
    const t = reduceWorkspace(s, { type: 'close', key: 'script:mover' });
    expect(t.active).toBe('script:door');
    const u = reduceWorkspace(t, { type: 'close', key: 'script:door' });
    expect(u.active).toBe('animator:animator-01');
    const v = reduceWorkspace(u, { type: 'close', key: 'animator:animator-01' });
    expect(v.active).toBe('game');
    expect(v.docs).toEqual([]);
  });

  it('closing an inactive tab keeps the active one', () => {
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

  it('cycles forwards and backwards through every tab, wrapping', () => {
    const s = run({ type: 'open', doc: a }, { type: 'activate', key: 'scene' });
    const next = (x: WorkspaceState): WorkspaceState => reduceWorkspace(x, { type: 'cycle', dir: 1 });
    expect([next(s).active, next(next(s)).active, next(next(next(s))).active]).toEqual(['game', 'animator:animator-01', 'scene']);
    expect(reduceWorkspace(s, { type: 'cycle', dir: -1 }).active).toBe('animator:animator-01');
  });

  it('toggles maximize', () => {
    const s = run({ type: 'maximize' });
    expect(s.maximized).toBe(true);
    expect(reduceWorkspace(s, { type: 'maximize' }).maximized).toBe(false);
    expect(reduceWorkspace(s, { type: 'maximize', on: true })).toBe(s);
  });

  it('caps the number of document tabs', () => {
    let s = INITIAL_WORKSPACE;
    for (let i = 0; i < MAX_DOCUMENT_TABS + 3; i++) s = reduceWorkspace(s, { type: 'open', doc: { kind: 'script', id: `b${i}` } });
    expect(s.docs).toHaveLength(MAX_DOCUMENT_TABS);
  });

  it('round-trips through the layout storage and drops what it cannot trust', () => {
    const kinds = new Set(['animator', 'script']);
    const s = run({ type: 'open', doc: a }, { type: 'open', doc: b }, { type: 'maximize' });
    expect(parseWorkspace(serializeWorkspace(s), kinds)).toEqual(s);
    // The Game tab is empty after a reload (nothing plays): Scene comes back instead.
    expect(parseWorkspace(serializeWorkspace({ ...s, active: 'game' }), kinds).active).toBe('scene');
    expect(parseWorkspace(null, kinds)).toBe(INITIAL_WORKSPACE);
    expect(parseWorkspace('{not json', kinds)).toBe(INITIAL_WORKSPACE);
    const odd = JSON.stringify({ docs: [a, a, { kind: 'unknown', id: 'x' }, { kind: 'script', id: '' }, { kind: 'script' }, 7], active: 'unknown:x', maximized: 'yes' });
    expect(parseWorkspace(odd, kinds)).toEqual({ docs: [a], active: 'scene', maximized: false });
  });
});
