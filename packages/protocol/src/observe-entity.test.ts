/**
 * Phase 15.4: an observation may name an entity (its running scripts'
 * property values, for the Play debug view and tl_game_observe).
 */
import { describe, expect, it } from 'vitest';

import { makeGameObserveRequest, parseGameObserveRequest, validateBridgeEditorToPreview } from './index';

const PLAY = `play-${'a'.repeat(32)}`;
const RELAY = `relay-${'b'.repeat(32)}`;

describe('phase 15.4: observe with an entity id', () => {
  it('the HTTP body accepts an entity id and refuses a malformed one', () => {
    expect(parseGameObserveRequest({ entityId: 'box-0001' })).toEqual({ ok: true, request: { timeoutMs: 5000, entityId: 'box-0001' } });
    expect(parseGameObserveRequest({ timeoutMs: 1000, entityId: 'box-0001' })).toEqual({ ok: true, request: { timeoutMs: 1000, entityId: 'box-0001' } });
    expect(parseGameObserveRequest({})).toEqual({ ok: true, request: { timeoutMs: 5000 } });
    expect(parseGameObserveRequest({ entityId: 'Bad Id' }).ok).toBe(false);
  });

  it('the relay frame and the bridge message carry it', () => {
    expect(JSON.parse(makeGameObserveRequest(RELAY, 5000, 'box-0001'))).toEqual({ type: 'game.observe.request', relayId: RELAY, timeoutMs: 5000, entityId: 'box-0001' });
    expect(JSON.parse(makeGameObserveRequest(RELAY, 5000))).toEqual({ type: 'game.observe.request', relayId: RELAY, timeoutMs: 5000 });
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.observe', playSessionId: PLAY, relayId: RELAY, entityId: 'box-0001' }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.observe', playSessionId: PLAY, relayId: RELAY, entityId: '../x' }).ok).toBe(false);
  });
});
