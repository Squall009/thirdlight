/** The edit modes' key map: Esc and its order, Space, Home, C, Shift+number within the rail, nothing with Ctrl/Alt/Meta. */
import { describe, expect, it } from 'vitest';

import { editKeyAction, escapeStep, paletteKeyHint, paletteKeyIndex, sharedKeyHints, type EditKeyEvent, type SharedKeyState } from './edit-keys';

const key = (k: string, more: Partial<EditKeyEvent> = {}): EditKeyEvent => ({ key: k, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...more });

describe('editKeyAction', () => {
  it('maps the shared keys', () => {
    expect(editKeyAction(key('Escape'), 3)).toEqual({ kind: 'escape' });
    expect(editKeyAction(key(' ', { code: 'Space' }), 3)).toEqual({ kind: 'last-tool' });
    expect(editKeyAction(key(' ', { code: 'Space', shiftKey: true }), 3)).toBeNull();
    expect(editKeyAction(key('Home'), 3)).toEqual({ kind: 'frame' });
    expect(editKeyAction(key('c'), 3)).toEqual({ kind: 'context' });
    expect(editKeyAction(key('C', { shiftKey: true }), 3)).toBeNull();
  });

  it('switches modes with Shift+number, only within the rail', () => {
    expect(editKeyAction(key('!', { code: 'Digit1', shiftKey: true }), 3)).toEqual({ kind: 'mode', index: 0 });
    expect(editKeyAction(key('#', { code: 'Digit3', shiftKey: true }), 3)).toEqual({ kind: 'mode', index: 2 });
    expect(editKeyAction(key('$', { code: 'Digit4', shiftKey: true }), 3)).toBeNull();
    // A plain number is a palette's.
    expect(editKeyAction(key('1', { code: 'Digit1' }), 3)).toBeNull();
  });

  it('leaves chords with Ctrl, Alt or Meta to others (undo, the browser)', () => {
    expect(editKeyAction(key('z', { ctrlKey: true }), 3)).toBeNull();
    expect(editKeyAction(key('c', { metaKey: true }), 3)).toBeNull();
    expect(editKeyAction(key('Escape', { altKey: true }), 3)).toBeNull();
  });

  it('leaves Space with Ctrl to others', () => {
    expect(editKeyAction(key(' ', { code: 'Space', ctrlKey: true }), 3)).toBeNull();
  });
});

describe('escapeStep', () => {
  it('drops the tool first, then clears the selection, then leaves', () => {
    expect(escapeStep({ selection: true, armed: true })).toBe('drop');
    expect(escapeStep({ selection: true, armed: false })).toBe('deselect');
    expect(escapeStep({ selection: false, armed: true })).toBe('drop');
    expect(escapeStep({ selection: false, armed: false })).toBe('leave');
  });
});

describe('sharedKeyHints', () => {
  const st = (more: Partial<SharedKeyState> = {}): SharedKeyState => ({ modes: 7, tools: true, armed: false, selection: false, lastTool: 'Rect', ...more });
  const esc = (h: ReturnType<typeof sharedKeyHints>): string | undefined => h.find((x) => x.keys[0] === 'Esc')?.label;

  it('in Navigate: a drag orbits, a click selects, Space brings the last tool back, Esc leaves', () => {
    const h = sharedKeyHints(st());
    expect(h.slice(0, 2)).toEqual([{ keys: ['Drag'], label: 'Orbit' }, { keys: ['Click'], label: 'Select' }]);
    expect(h).toContainEqual({ keys: ['Space'], label: 'Last tool: Rect' });
    expect(esc(h)).toBe('Leave');
  });

  it('with a tool armed: Alt+drag orbits, Esc drops the tool, a selection or not', () => {
    const h = sharedKeyHints(st({ armed: true }));
    expect(h[0]).toEqual({ keys: ['Alt', 'Drag'], label: 'Orbit' });
    expect(h.some((x) => x.keys[0] === 'Space')).toBe(false);
    expect(esc(h)).toBe('Drop the tool');
    expect(esc(sharedKeyHints(st({ armed: true, selection: true })))).toBe('Drop the tool');
    expect(esc(sharedKeyHints(st({ selection: true })))).toBe('Deselect');
  });

  it('a mode without tools has no tool to drop or bring back', () => {
    const h = sharedKeyHints(st({ tools: false, armed: true }));
    expect(h[0]).toEqual({ keys: ['Drag'], label: 'Orbit' });
    expect(h.some((x) => x.keys[0] === 'Space')).toBe(false);
    expect(esc(h)).toBe('Leave');
  });

  it('lists the mode range only with several modes', () => {
    expect(sharedKeyHints(st())).toContainEqual({ keys: ['Shift', '1–7'], label: 'Mode' });
    expect(sharedKeyHints(st({ modes: 1 })).some((h) => h.label === 'Mode')).toBe(false);
  });
});

describe('paletteKeyIndex', () => {
  const k = (code: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({ key: code.slice(-1), code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  it('picks entries 1–9 with plain digits, leaving Shift (modes) and chords alone', () => {
    expect(paletteKeyIndex(k('Digit1'))).toBe(0);
    expect(paletteKeyIndex(k('Digit9'))).toBe(8);
    expect(paletteKeyIndex(k('Digit0'))).toBeNull();
    expect(paletteKeyIndex(k('Digit2', { shiftKey: true }))).toBeNull();
    expect(paletteKeyIndex(k('Digit2', { ctrlKey: true }))).toBeNull();
    expect(paletteKeyHint(5, 'Layer')).toEqual([{ keys: ['1–5'], label: 'Layer' }]);
    expect(paletteKeyHint(12, 'Layer')).toEqual([{ keys: ['1–9'], label: 'Layer' }]);
    expect(paletteKeyHint(0, 'Layer')).toEqual([]);
  });
});
