/**
 * The shared brush settings: bounds and defaults for anything read back,
 * what a stroke sends (only what changes something), the key steps and
 * drags, the brush keys of the one key map, and the store remembering each
 * editor's tool apart (but never invert).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { BRUSH_BOUNDS, DEFAULT_BRUSH, brushRadius, brushStore, brushStrokeExtras, brushSummary, dragStrength, resetBrushStores, sanitizeBrush, stepSize, stepStrength, type BrushBounds, type BrushUse } from './brush';
import { brushKeyAction, brushKeyHints, type EditKeyEvent } from './edit-keys';

const BOUNDS: BrushBounds = { size: [0.5, 4096], heightStep: [0.01, 1000] };
const ALL: BrushUse[] = ['heightStep', 'size', 'strength', 'opacity', 'falloff', 'spacing', 'invert', 'mask'];

/** A storage of strings (what localStorage holds). */
function memory(): Pick<Storage, 'getItem' | 'setItem'> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
}

beforeEach(() => resetBrushStores());

describe('brush settings', () => {
  it('read back within bounds, anything malformed its default', () => {
    expect(sanitizeBrush(null, DEFAULT_BRUSH, BOUNDS)).toEqual(DEFAULT_BRUSH);
    const b = sanitizeBrush({ size: 1e9, strength: -1, opacity: 'x', falloff: 'spiky', spacing: 0.5, heightStep: 0, mask: { on: true, octaves: 9.4, seed: 2.5, scale: 0 } }, DEFAULT_BRUSH, BOUNDS);
    expect(b.size).toBe(4096);
    expect(b.strength).toBe(BRUSH_BOUNDS.strength[0]);
    expect(b.opacity).toBe(DEFAULT_BRUSH.opacity);
    expect(b.falloff).toBe(DEFAULT_BRUSH.falloff);
    expect(b.spacing).toBe(0.5);
    expect(b.heightStep).toBe(0.01);
    expect(b.mask).toEqual({ ...DEFAULT_BRUSH.mask, on: true, octaves: 5, scale: BRUSH_BOUNDS.maskScale[0] });
    expect(brushRadius({ size: 9 })).toBe(4.5);
  });

  it('a stroke sends a hardness, an opacity and a mask only where they change something, and only for tools that use them', () => {
    expect(brushStrokeExtras(DEFAULT_BRUSH, ALL)).toEqual({});
    const b = { ...DEFAULT_BRUSH, falloff: 'curve' as const, hardness: 0.3, opacity: 0.8, mask: { ...DEFAULT_BRUSH.mask, on: true } };
    expect(brushStrokeExtras(b, ALL)).toEqual({ hardness: 0.3, opacity: 0.8, mask: { scale: 4, contrast: 1.6, threshold: 0.45, octaves: 4, seed: 1207 } });
    // A sculpt tool uses no opacity; a holes brush no falloff and no mask.
    expect(brushStrokeExtras(b, ['size', 'strength', 'falloff', 'mask'])).not.toHaveProperty('opacity');
    expect(brushStrokeExtras(b, ['size', 'spacing', 'invert'])).toEqual({});
    expect(brushSummary(b, ALL)).toBe('16 m · 0.5 m step · 50 % · opacity 80 % · noise');
  });

  it('keys step the size by a share of it and the strength by 5 %; Shift+F drags the strength', () => {
    expect(stepSize(10, 1, BOUNDS)).toBe(12);
    expect(stepSize(10, -1, BOUNDS)).toBe(8.7);
    expect(stepSize(0.5, -1, BOUNDS)).toBe(0.5);
    expect(stepSize(4000, 1, BOUNDS)).toBe(4096);
    // A prop's brush steps by centimetres (0.1 m steps would stall it under a metre).
    expect(stepSize(0.3, 1, { ...BOUNDS, size: [0.02, 128] })).toBe(0.35);
    expect(stepSize(0.3, -1, { ...BOUNDS, size: [0.02, 128] })).toBe(0.26);
    expect(stepStrength(0.5, 1)).toBe(0.55);
    expect(stepStrength(0.03, -1)).toBe(0.01);
    expect(stepStrength(1, 1)).toBe(1);
    expect(dragStrength(0.5, 120, 0)).toBe(1);
    expect(dragStrength(0.5, 0, 60)).toBe(0.25);
  });

  it('the brush keys: brackets by their physical key, Shift for strength, F and Shift+F, X; only what the tool uses', () => {
    const k = (code: string, more: Partial<EditKeyEvent> = {}): EditKeyEvent => ({ key: '', code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...more });
    expect(brushKeyAction(k('BracketRight'), ALL)).toEqual({ kind: 'size', dir: 1 });
    expect(brushKeyAction(k('BracketLeft'), ALL)).toEqual({ kind: 'size', dir: -1 });
    expect(brushKeyAction(k('BracketLeft', { shiftKey: true }), ALL)).toEqual({ kind: 'strength', dir: -1 });
    expect(brushKeyAction(k('KeyF'), ALL)).toEqual({ kind: 'resize' });
    expect(brushKeyAction(k('KeyF', { shiftKey: true }), ALL)).toEqual({ kind: 'restrength' });
    expect(brushKeyAction(k('KeyX'), ALL)).toEqual({ kind: 'invert' });
    expect(brushKeyAction(k('KeyX', { ctrlKey: true }), ALL)).toBeNull();
    expect(brushKeyAction(k('BracketLeft', { shiftKey: true }), ['size'])).toBeNull();
    expect(brushKeyAction(k('KeyX'), ['size', 'strength'])).toBeNull();
    expect(brushKeyHints(['size', 'strength', 'invert'], 'Erase').map((h) => `${h.keys.join('+')} ${h.label}`)).toEqual(['[ / ] Size', 'Shift+[ / ] Strength', 'F Resize in view', 'Shift+F Strength in view', 'X Paint / erase', 'Ctrl Erase']);
    expect(brushKeyHints(['size'])).toHaveLength(2);
  });

  it('are remembered per editor and tool, without invert, and shared by everyone who asks for the same tool', () => {
    const storage = memory();
    const raise = brushStore('terrain', 'raise', DEFAULT_BRUSH, BOUNDS, storage);
    const paint = brushStore('terrain', 'paint', DEFAULT_BRUSH, BOUNDS, storage);
    let heard = 0;
    raise.subscribe(() => heard++);
    raise.set({ size: 24, invert: true, mask: { on: true } });
    expect(heard).toBe(1);
    raise.set({ size: 24 });
    expect(heard).toBe(1);
    expect(paint.get().size).toBe(DEFAULT_BRUSH.size);
    expect(brushStore('terrain', 'raise', DEFAULT_BRUSH, BOUNDS, storage)).toBe(raise);
    const saved = JSON.parse(storage.items.get('thirdlight.brush.terrain.raise')!) as Record<string, unknown>;
    expect(saved['size']).toBe(24);
    expect(saved).not.toHaveProperty('invert');
    // A new page: the tool's settings come back; invert does not.
    resetBrushStores();
    const again = brushStore('terrain', 'raise', DEFAULT_BRUSH, BOUNDS, storage).get();
    expect(again.size).toBe(24);
    expect(again.mask.on).toBe(true);
    expect(again.invert).toBe(false);
    // Storage holding rubbish: the defaults.
    storage.items.set('thirdlight.brush.blocks.paint', '{not json');
    expect(brushStore('blocks', 'paint', DEFAULT_BRUSH, BOUNDS, storage).get()).toEqual(DEFAULT_BRUSH);
  });
});
