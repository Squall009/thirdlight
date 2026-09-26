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
    const s = parsePlayStartRequest({ options: { save: { version: 1, levelId: 'level-2', run: { values: {} } } } });
    expect(s.ok && s.request.start?.save).toEqual({ version: 1, levelId: 'level-2', run: { values: {} } });
  });

  it('refuses bad values and conflicting options', () => {
    for (const options of [
      { sceneId: 'Bad Scene' },
      { mode: '' },
      { variables: [1] },
      { variables: { 'no spaces': 1 } },
      { variables: { big: 'x'.repeat(5000) } },
      { variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) },
      { save: { levelId: 'x' } },
      { save: { version: 1, levelId: 'x', run: {}, pad: 'y'.repeat(70_000) } },
      { saveSlot: '4' },
      { save: { version: 1, levelId: 'x', run: {} }, saveSlot: '1' },
      { sceneId: 'scene-a', saveSlot: 'auto' },
      { unknown: 1 },
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
