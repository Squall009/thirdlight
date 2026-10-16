import { describe, expect, it } from 'vitest';

import { dockAt, dockStorageKey, EMPTY_DOCKS, loadDocks, movePanel, PANEL_KEEP_HEIGHT, panelKeepHeight, placeFor, sanitizeDocks, saveDocks, stacks, togglePanel, type PanelDefault } from './dock-layout';

/** The Rooms & buildings mode's panels as it declares them: the list collapsed top right, the picked room on the right edge. */
const ROOMS: readonly PanelDefault[] = [
  { id: 'rooms', dock: 'tr', open: false, order: 0 },
  { id: 'selection', dock: 'r', open: true, order: 1 },
];

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('dock layout', () => {
  it('puts each panel in its default dock until the user moves it', () => {
    const s = stacks({}, ROOMS);
    expect(s.tr).toEqual(['rooms']);
    expect(s.r).toEqual(['selection']);
    expect(s.tl).toEqual([]);
    expect(placeFor({}, ROOMS[0]!)).toEqual({ dock: 'tr', open: false, order: 0 });
  });

  it('stacks the panels of one dock in order, never two in one place', () => {
    const three: PanelDefault[] = [{ id: 'a', dock: 'r', open: true, order: 2 }, { id: 'b', dock: 'r', open: true, order: 0 }, { id: 'c', dock: 'r', open: true, order: 0 }];
    // Order first, then the order they were declared in.
    expect(stacks({}, three).r).toEqual(['b', 'c', 'a']);
    // Every panel is in exactly one dock.
    const all = Object.values(stacks({}, three)).flat();
    expect(all.sort()).toEqual(['a', 'b', 'c']);
  });

  it('moves a panel to the end of another dock, keeping whether it is open', () => {
    let l = movePanel({}, ROOMS, 'selection', 'tr');
    expect(stacks(l, ROOMS).tr).toEqual(['rooms', 'selection']);
    expect(stacks(l, ROOMS).r).toEqual([]);
    expect(placeFor(l, ROOMS[1]!).open).toBe(true);
    // Back in front of it: the list moved after the selection's panel.
    l = movePanel(l, ROOMS, 'rooms', 'tr');
    expect(stacks(l, ROOMS).tr).toEqual(['selection', 'rooms']);
    // An unknown panel changes nothing.
    expect(movePanel(l, ROOMS, 'nope', 'b')).toBe(l);
  });

  it('collapses and opens a panel', () => {
    const l = togglePanel({}, ROOMS, 'rooms');
    expect(placeFor(l, ROOMS[0]!)).toEqual({ dock: 'tr', open: true, order: 0 });
    expect(placeFor(togglePanel(l, ROOMS, 'rooms'), ROOMS[0]!).open).toBe(false);
  });

  it('finds the dock a drop lands in from the view’s ninths; the middle is none', () => {
    const view = { left: 100, top: 50, width: 900, height: 600 };
    expect(dockAt(110, 60, view)).toBe('tl');
    expect(dockAt(550, 60, view)).toBe('t');
    expect(dockAt(990, 60, view)).toBe('tr');
    expect(dockAt(110, 350, view)).toBe('l');
    expect(dockAt(550, 350, view)).toBeNull();
    expect(dockAt(990, 350, view)).toBe('r');
    expect(dockAt(110, 640, view)).toBe('bl');
    expect(dockAt(550, 640, view)).toBe('b');
    expect(dockAt(1000, 650, view)).toBe('br');
    // Outside the view: no dock.
    expect(dockAt(90, 60, view)).toBeNull();
    expect(dockAt(550, 700, view)).toBeNull();
  });

  it('lets tall panels give way while a short one keeps its height', () => {
    expect(panelKeepHeight(34, 120)).toBe(154);
    expect(panelKeepHeight(34, 2000)).toBe(PANEL_KEEP_HEIGHT);
  });

  it('remembers the layout per editor, drops what does not read, and forgets it on reset', () => {
    const st = memoryStorage();
    const moved = { places: movePanel({}, ROOMS, 'selection', 'tl'), hidden: false };
    saveDocks('blocks', moved, st);
    expect(loadDocks('blocks', st)).toEqual(moved);
    // Another editor keeps its own (none here).
    expect(loadDocks('terrain', st)).toEqual(EMPTY_DOCKS);
    // A stale entry (an unknown dock, a missing field) falls back to the default; the good ones stay.
    st.setItem(dockStorageKey('blocks'), JSON.stringify({ places: { rooms: { dock: 'middle', open: true, order: 0 }, selection: { dock: 'tl', open: true, order: 3 }, other: { dock: 'r' } }, hidden: 'yes' }));
    const read = loadDocks('blocks', st);
    expect(read).toEqual({ places: { selection: { dock: 'tl', open: true, order: 3 } }, hidden: false });
    expect(placeFor(read.places, ROOMS[0]!).dock).toBe('tr');
    // Not JSON at all: the defaults.
    st.setItem(dockStorageKey('blocks'), '{');
    expect(loadDocks('blocks', st)).toEqual(EMPTY_DOCKS);
    // Reset: the empty layout is no entry at all.
    saveDocks('blocks', moved, st);
    saveDocks('blocks', EMPTY_DOCKS, st);
    expect(st.data.has(dockStorageKey('blocks'))).toBe(false);
    // The Panels switch off is remembered on its own.
    saveDocks('blocks', { places: {}, hidden: true }, st);
    expect(loadDocks('blocks', st)).toEqual({ places: {}, hidden: true });
    expect(sanitizeDocks(null)).toEqual(EMPTY_DOCKS);
  });
});
