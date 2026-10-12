/** The edit modes' key map: Esc, Home, C, Shift+number within the rail, nothing with Ctrl/Alt/Meta. */
import { describe, expect, it } from 'vitest';

import { editKeyAction, paletteKeyHint, paletteKeyIndex, sharedKeyHints, type EditKeyEvent } from './edit-keys';

const key = (k: string, more: Partial<EditKeyEvent> = {}): EditKeyEvent => ({ key: k, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...more });

describe('editKeyAction', () => {
  it('maps the shared keys', () => {
    expect(editKeyAction(key('Escape'), 3)).toEqual({ kind: 'done' });
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

  it('lists the shared keys, the mode range only with several modes', () => {
    expect(sharedKeyHints(7)[0]).toEqual({ keys: ['Shift', '1–7'], label: 'Mode' });
    expect(sharedKeyHints(1).some((h) => h.label === 'Mode')).toBe(false);
    expect(sharedKeyHints(1).at(-1)).toEqual({ keys: ['Esc'], label: 'Done' });
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
