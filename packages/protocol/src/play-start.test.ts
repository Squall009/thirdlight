/**
 * Phase 23.8: the play-start options (scene, mode, variables, save) and the
 * `debugCommand` game control — strict wire validation.
 */
import { describe, expect, it } from 'vitest';

import { parseGameControlRequest, parsePlayStartRequest, validateBridgeEditorToPreview } from './index';

describe('play start options (phase 23.8)', () => {
  it('accepts a scene, a mode, variables and a save slot; absent options keep the old request', () => {
    expect(parsePlayStartRequest({ options: { demo: false } })).toEqual({ ok: true, request: { demo: false } });
    const r = parsePlayStartRequest({ options: { demo: false, sceneId: 'scene-arena', mode: 'battle', variables: { gold: 100, party: ['a'] } } });
    expect(parsePlayStartRequest({ options: { saveSlot: '2' } })).toEqual({ ok: true, request: { demo: true, start: { saveSlot: '2' } } });
    expect(r).toEqual({ ok: true, request: { demo: false, start: { sceneId: 'scene-arena', mode: 'battle', variables: { gold: 100, party: ['a'] } } } });
    // Phase 23.19: project save slots 1-99 and a project save document.
    expect(parsePlayStartRequest({ options: { saveSlot: '42' } }).ok).toBe(true);
    const doc = { format: 'thirdlight.save', version: 2, doc: { big: 'x'.repeat(100_000) } };
    const p = parsePlayStartRequest({ options: { save: doc } });
    expect(p.ok && p.request.start?.save).toEqual(doc);
    // Phase 25.17: a play-test's threading mode.
    expect(parsePlayStartRequest({ options: { threads: 'single' } })).toEqual({ ok: true, request: { demo: true, start: { threads: 'single' } } });
    expect(parsePlayStartRequest({ options: { threads: 'worker', variables: { a: 1 } } })).toEqual({ ok: true, request: { demo: true, start: { variables: { a: 1 }, threads: 'worker' } } });
  });

  it('refuses bad values and conflicting options', () => {
    for (const options of [
      { sceneId: 'Bad Scene' },
      { mode: '' },
      { variables: [1] },
      { variables: { 'no spaces': 1 } },
      { variables: { big: 'x'.repeat(5000) } },
      { variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) },
      // Phase 24: only a project save document (the flow save is gone).
      { save: { version: 1, levelId: 'x', run: {} } },
      { saveSlot: '100' },
      { saveSlot: '0' },
      // Phase 23.19: a project save document needs a version and a doc, and stays within 1 MiB.
      { save: { format: 'thirdlight.save', doc: {} } },
      { save: { format: 'thirdlight.save', version: 1 } },
      { save: { format: 'thirdlight.save', version: 1, doc: 'z'.repeat(1_048_600) } },
      { save: { format: 'thirdlight.save', version: 1, doc: {} }, saveSlot: '1' },
      { sceneId: 'scene-a', saveSlot: 'auto' },
      { unknown: 1 },
      { threads: 'both' },
      { threads: 2 },
    ]) {
      expect(parsePlayStartRequest({ options }).ok, JSON.stringify(options).slice(0, 80)).toBe(false);
    }
  });
});

describe('the debugCommand game control (phase 23.8)', () => {
  it('carries a name and arguments, and only it does', () => {
    expect(parseGameControlRequest({ command: 'debugCommand', name: 'giveItem', args: { item: 'key', count: 2, loud: true } })).toEqual({
      ok: true,
      request: { command: 'debugCommand', name: 'giveItem', args: { item: 'key', count: 2, loud: true } },
    });
    expect(parseGameControlRequest({ command: 'debugCommand', name: 'heal' })).toEqual({ ok: true, request: { command: 'debugCommand', name: 'heal', args: {} } });
    for (const body of [
      { command: 'debugCommand' },
      { command: 'debugCommand', name: '1x' },
      { command: 'debugCommand', name: 'x', args: { a: {} } },
      { command: 'debugCommand', name: 'x', args: { a: 'y'.repeat(300) } },
      { command: 'start', name: 'x' },
    ]) {
      expect(parseGameControlRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('the bridge passes a debug command (and a snapshot start block) to the preview', () => {
    const psid = `play-${'a'.repeat(32)}`;
    const relayId = `relay-${'b'.repeat(32)}`;
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.control', playSessionId: psid, relayId, command: 'debugCommand', name: 'nudge', args: { dx: 1 } }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.control', playSessionId: psid, relayId, command: 'debugCommand', name: 'nudge', args: { dx: [1] } }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.control', playSessionId: psid, relayId, command: 'start', name: 'nudge' }).ok).toBe(false);
  });
});
