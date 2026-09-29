/**
 * Glyph resolution (families, labels, project images, the
 * generic SVG set), device detection and the bindings controller (listening
 * with a cancel key and a timeout, requests, profiles, the frame entry).
 */
import { describe, expect, it } from 'vitest';
import type { InputStatusEntry } from '@thirdlight/runtime';
import { validateInputStatus } from '@thirdlight/runtime';

import { bindingGlyph, gamepadFamily, glyphDataUrl, glyphSvg, GLYPH_ICONS, keyName } from './glyphs';
import type { Captured, ConfigData } from './input-bindings';
import { createInputBindings } from './rebind';
import { createSettingsStore, type SaveStorage } from './storage';

const CONFIG: ConfigData = {
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }, { kind: 'gamepadButtons1d', negative: 14, positive: 15 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'fire', type: 'button', map: 'gameplay', bindings: [{ kind: 'pointerButton', button: 'left' }, { kind: 'gamepadButton', button: 7, hold: 0.4 }] },
  ],
  glyphs: { 'playstation:pad-south': 'tex-cross', 'key:Space': 'tex-space' },
};

describe('glyphs', () => {
  it('detects the pad family from the browser id', () => {
    expect(gamepadFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
    expect(gamepadFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(gamepadFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('switch');
    expect(gamepadFamily('USB gamepad (Vendor: 0079 Product: 0011)')).toBe('generic');
    expect(gamepadFamily(null)).toBe('generic');
  });
  it('labels per family with neutral icons; composites list parts; the project image overrides by family or key', () => {
    const south = { kind: 'gamepadButton', button: 0 };
    expect(bindingGlyph(south, 'xbox')).toMatchObject({ device: 'gamepad', label: 'A', icon: 'pad-south' });
    expect(bindingGlyph(south, 'playstation', CONFIG.glyphs)).toMatchObject({ label: 'Cross', icon: 'pad-south', image: 'tex-cross' });
    expect(bindingGlyph(south, 'switch', CONFIG.glyphs)).toMatchObject({ label: 'B', icon: 'pad-south' });
    expect(bindingGlyph(south, 'switch', CONFIG.glyphs).image).toBeUndefined();
    expect(bindingGlyph({ kind: 'key', code: 'Space' }, 'generic', CONFIG.glyphs)).toMatchObject({ device: 'keyboard', label: 'Space', icon: 'key', image: 'tex-space' });
    expect(bindingGlyph({ kind: 'gamepadButton', button: 7, hold: 0.4 }, 'xbox')).toMatchObject({ label: 'RT', icon: 'pad-trigger-right', hold: 0.4 });
    expect(bindingGlyph({ kind: 'pointerButton', button: 'right' }, 'generic')).toMatchObject({ device: 'mouse', label: 'Right button', icon: 'mouse-right' });
    const move = bindingGlyph({ kind: 'keys1d', negative: 'KeyA', positive: 'ArrowRight' }, 'generic');
    expect(move.label).toBe('A / Right');
    expect(move.parts).toEqual([{ part: 'negative', label: 'A', icon: 'key' }, { part: 'positive', label: 'Right', icon: 'key' }]);
    expect(bindingGlyph({ kind: 'gamepadButtons1d', negative: 14, positive: 15 }, 'xbox')).toMatchObject({ label: 'D-pad left / right', icon: 'pad-dpad' });
    expect(keyName('ShiftLeft')).toBe('Left Shift');
    expect(keyName('Digit4')).toBe('4');
  });
  it('the generic set draws every icon as SVG (a key cap carries its label, escaped)', () => {
    for (const icon of GLYPH_ICONS) {
      const s = glyphSvg(icon, 'X');
      expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), icon).toBe(true);
      expect(s.endsWith('</svg>'), icon).toBe(true);
    }
    expect(glyphSvg('key', '<&>')).toContain('&lt;&amp;&gt;');
    expect(glyphSvg('key', 'Left Shift')).toContain('width="130"');
    expect(glyphDataUrl('pad-south')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  });
});

function fakeOwner() {
  const o = {
    device: 'keyboard' as 'keyboard' | 'gamepad',
    padId: null as string | null,
    configured: [] as ConfigData[],
    capture: null as ((c: Captured | null) => void) | null,
    captureOpts: null as unknown,
    frameInput: null as (() => InputStatusEntry | undefined) | null,
  };
  return Object.assign(o, {
    owner: {
      configure: (c: unknown) => void o.configured.push(c as ConfigData),
      captureInput: (opts: unknown, cb: (c: Captured | null) => void) => {
        o.capture = cb;
        o.captureOpts = opts;
        return () => (o.capture = null);
      },
      activeDeviceInfo: () => ({ device: o.device, gamepadId: o.padId }),
      setFrameInput: (f: (() => InputStatusEntry | undefined) | null) => void (o.frameInput = f),
    },
    hear(c: Captured | null) {
      const cb = o.capture;
      o.capture = null;
      cb?.(c);
    },
  });
}
function memoryStorage(): SaveStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) } as SaveStorage & { data: Map<string, string> };
}

describe('the bindings controller', () => {
  it('sends everything once, then only changes; the device switch changes glyphs and pad labels follow the family', () => {
    const f = fakeOwner();
    const b = createInputBindings({ defaults: CONFIG, input: f.owner });
    const first = f.frameInput!()!;
    expect(validateInputStatus(first).ok).toBe(true);
    expect(first.device).toEqual({ kind: 'keyboardMouse' });
    expect(first.profile).toBe('default');
    expect(first.actions!.map((a) => a.name)).toEqual(['move', 'jump', 'fire']);
    expect(f.frameInput!()).toBeUndefined();
    expect(b.glyph('jump')).toMatchObject({ label: 'Space', icon: 'key' });
    expect(b.glyph('fire')).toMatchObject({ label: 'Left button', icon: 'mouse-left' });

    f.device = 'gamepad';
    f.padId = 'DualSense Wireless Controller (Vendor: 054c)';
    b.tick();
    expect(b.device()).toEqual({ kind: 'gamepad', id: f.padId, family: 'playstation' });
    expect(b.glyph('jump')).toMatchObject({ label: 'Cross', icon: 'pad-south', image: 'tex-cross' });
    const next = f.frameInput!()!;
    expect(next.device).toEqual({ kind: 'gamepad', id: f.padId, family: 'playstation' });
    expect(next.actions!.find((a) => a.name === 'jump')!.bindings[1]!.label).toBe('Cross');
    expect(b.observe().glyphs['jump']).toEqual({ label: 'Cross', icon: 'pad-south' });
  });

  it('listens for input: started, rebound (saved); the cancel key; a timeout; a refusal under refuse', () => {
    const f = fakeOwner();
    const storage = memoryStorage();
    let t = 0;
    const b = createInputBindings({ defaults: CONFIG, input: f.owner, store: createSettingsStore(storage, 'g'), now: () => t });
    f.frameInput!();
    expect(b.listen('jump', { cancelKey: 'KeyQ' })).toEqual({ ok: true, target: { action: 'jump', index: 0 } });
    expect(f.captureOpts).toEqual({ devices: ['keyboard', 'mouse'], cancelKeys: ['KeyQ'] });
    expect(b.listening()).toEqual({ action: 'jump', index: 0 });
    f.hear({ device: 'keyboard', code: 'KeyK' });
    expect(b.listening()).toBeNull();
    expect(f.configured.at(-1)!.actions.find((a) => a.name === 'jump')!.bindings[0]).toEqual({ kind: 'key', code: 'KeyK' });
    expect(JSON.parse(storage.data.get('g:bindings:default')!).actions.jump[0]).toEqual({ kind: 'key', code: 'KeyK' });
    const e1 = f.frameInput!()!;
    expect(e1.events!.map((e) => e.type)).toEqual(['started', 'rebound']);
    expect(e1.events![1]).toMatchObject({ action: 'jump', index: 0, label: 'K' });
    expect(e1.actions!.find((a) => a.name === 'jump')!.changed).toBe(true);

    b.listen('jump');
    f.hear(null);
    expect(f.frameInput!()!.events!.map((e) => e.type)).toEqual(['started', 'cancelled']);

    b.listen('fire', { device: 'gamepad', timeout: 2 });
    expect(f.captureOpts).toMatchObject({ devices: ['gamepad'] });
    t = 1500;
    b.tick();
    expect(b.listening()).not.toBeNull();
    t = 2100;
    b.tick();
    expect(b.listening()).toBeNull();
    expect(f.frameInput!()!.events!.map((e) => e.type)).toEqual(['started', 'timeout']);

    b.listen('move', { part: 'positive', policy: 'refuse' });
    expect(f.captureOpts).toMatchObject({ devices: ['keyboard'] });
    f.hear({ device: 'keyboard', code: 'KeyK' }); // jump's key now
    const refused = f.frameInput!()!.events!.at(-1)!;
    expect(refused).toMatchObject({ type: 'refused', action: 'move', part: 'positive', conflicts: [{ action: 'jump', index: 0 }] });
  });

  it('carries out scripts\' requests: rebind with options, reset one and all, profiles saved apart', () => {
    const f = fakeOwner();
    const storage = memoryStorage();
    const b = createInputBindings({ defaults: CONFIG, input: f.owner, store: createSettingsStore(storage, 'g') });
    b.handle([{ op: 'rebind', action: 'fire', options: { device: 'gamepad', policy: 'allow' } }]);
    f.hear({ device: 'gamepad', button: 0 });
    expect(b.config().actions.find((a) => a.name === 'fire')!.bindings[1]).toEqual({ kind: 'gamepadButton', button: 0, hold: 0.4 });
    expect(b.config().actions.find((a) => a.name === 'jump')!.bindings[1]).toEqual({ kind: 'gamepadButton', button: 0 });
    b.handle([{ op: 'profile', profile: 'p2' }]);
    expect(b.profile()).toBe('p2');
    expect(b.config()).toBe(CONFIG);
    b.bind('jump', { device: 'keyboard', code: 'KeyJ' });
    b.handle([{ op: 'profile', profile: 'default' }]);
    expect(b.config().actions.find((a) => a.name === 'jump')!.bindings[0]).toEqual({ kind: 'key', code: 'Space' });
    expect(b.config().actions.find((a) => a.name === 'fire')!.bindings[1]).toMatchObject({ button: 0 });
    b.handle([{ op: 'reset', action: 'fire' }, { op: 'reset', action: 'nope' }]);
    expect(b.config().actions.find((a) => a.name === 'fire')!.bindings).toEqual(CONFIG.actions[2]!.bindings);
    const events = f.frameInput!()!.events!;
    expect(events.map((e) => e.type)).toEqual(['started', 'rebound', 'profile', 'rebound', 'profile', 'reset', 'refused'].slice(-8));
    expect(JSON.parse(storage.data.get('g:bindings:p2')!).actions.jump[0]).toEqual({ kind: 'key', code: 'KeyJ' });
    b.handle([{ op: 'reset' }]);
    expect(b.observe().changed).toEqual([]);
  });
});
