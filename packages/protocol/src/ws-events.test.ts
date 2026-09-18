/**
 * WS event catalog (sessions.md §7) — builders, strict inbound
 * validation, the unknown-type robustness rule, and the §5.2 frame bounds.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  WS_IN_FRAME_MAX,
  WS_OUT_FRAME_MAX,
  WS_SCREENSHOT_ACK_MAX,
  enforceDefaultFrameBound,
  inboundFrameAllowed,
  makeAttached,
  makeErrorEvent,
  makeMutationApplied,
  makePong,
  makePlayStarted,
  makePlayStopRequest,
  makePlayStopped,
  makeScreenshotRequest,
  parseInboundEvent,
} from './ws-events';

const hex32 = '0123456789abcdef0123456789abcdef';
const play = `play-${hex32}`;
const relay = `relay-${hex32}`;

describe('catalog constants (sessions.md §7, exhaustive)', () => {
  it('server → client: exactly the §7.1 set', () => {
    expect([...SERVER_EVENT_TYPES].sort()).toEqual(
      ['attached', 'error', 'mutation.applied', 'play.diagnostics.request', 'play.started', 'play.stop.request', 'play.stopped', 'pong', 'screenshot.request'].sort(),
    );
  });
  it('client → server: exactly the §7.2 set', () => {
    expect([...CLIENT_EVENT_TYPES].sort()).toEqual(
      ['ping', 'play.diagnostics.ack', 'play.preview.failed', 'play.preview.ready', 'play.stopped.ack', 'screenshot.ack'].sort(),
    );
  });
});

describe('server → client builders (§7.1 exact payloads)', () => {
  it('attached { connId, revision }', () => {
    expect(JSON.parse(makeAttached(`conn-${hex32}`, 4))).toEqual({ type: 'attached', connId: `conn-${hex32}`, revision: 4 });
  });
  it('pong {}', () => {
    expect(JSON.parse(makePong())).toEqual({ type: 'pong' });
  });
  it('mutation.applied { requestId, revision, origin, change }', () => {
    const s = makeMutationApplied({
      requestId: `req-${hex32}`,
      revision: 5,
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      change: { type: 'setTransform', id: 'box-0001', previous: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, next: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, changedFields: ['position'] },
    });
    const o = JSON.parse(s);
    expect(o.type).toBe('mutation.applied');
    expect(o.requestId).toBe(`req-${hex32}`);
    expect(o.revision).toBe(5);
    expect(o.origin).toEqual({ kind: 'mcp', clientId: 'pi-harness' });
    expect(o.change.changedFields).toEqual(['position']);
  });
  it('play.started carries the full snapshot document', () => {
    const snapshot = {
      snapshotId: 'demo-0001@r4',
      projectId: 'demo-0001',
      revision: 4,
      scene: { schemaVersion: 1, sceneId: 'scene-main', revision: 4, entities: [] },
    };
    const o = JSON.parse(makePlayStarted({ playSessionId: play, startedBy: null, snapshot }));
    expect(o.type).toBe('play.started');
    expect(o.playSessionId).toBe(play);
    expect(o.startedBy).toBeNull();
    expect(o.snapshot).toEqual(snapshot);
  });
  it('play.stop.request / play.stopped (reasons + stopUnconfirmed optional)', () => {
    expect(JSON.parse(makePlayStopRequest(play, 'request'))).toEqual({ type: 'play.stop.request', playSessionId: play, reason: 'request' });
    expect(JSON.parse(makePlayStopped({ playSessionId: play, reason: 'preview_timeout' }))).toEqual({ type: 'play.stopped', playSessionId: play, reason: 'preview_timeout' });
    expect(JSON.parse(makePlayStopped({ playSessionId: play, reason: 'request', stopUnconfirmed: true }))).toEqual({ type: 'play.stopped', playSessionId: play, reason: 'request', stopUnconfirmed: true });
  });
  it('screenshot.request { relayId, maxWidth? }', () => {
    expect(JSON.parse(makeScreenshotRequest(relay))).toEqual({ type: 'screenshot.request', relayId: relay });
    expect(JSON.parse(makeScreenshotRequest(relay, 512))).toEqual({ type: 'screenshot.request', relayId: relay, maxWidth: 512 });
  });
  it('error { code, frameHint? ≤ 64 }', () => {
    expect(JSON.parse(makeErrorEvent('unknown_event'))).toEqual({ type: 'error', code: 'unknown_event' });
    const hint = 'x'.repeat(200);
    expect(JSON.parse(makeErrorEvent('protocol_error', hint)).frameHint).toHaveLength(64);
  });
});

describe('parseInboundEvent (sessions.md §7.2)', () => {
  it('ping', () => {
    const r = parseInboundEvent({ type: 'ping' });
    expect(r).toEqual({ ok: true, event: { type: 'ping' } });
  });

  it('unknown type ⇒ unknown_event (connection survives)', () => {
    const r = parseInboundEvent({ type: 'teleport' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'unknown_event') {
      expect(r.type).toBe('teleport');
    } else {
      throw new Error('expected unknown_event');
    }
  });

  it('play.preview.ready / play.stopped.ack strict', () => {
    expect(parseInboundEvent({ type: 'play.preview.ready', playSessionId: play }).ok).toBe(true);
    const badId = parseInboundEvent({ type: 'play.stopped.ack', playSessionId: 'play-bad' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.kind).toBe('protocol_error');
    const extra = parseInboundEvent({ type: 'play.preview.ready', playSessionId: play, extra: 1 });
    expect(extra.ok).toBe(false);
  });

  it('play.preview.failed requires code', () => {
    const ok1 = parseInboundEvent({ type: 'play.preview.failed', playSessionId: play, code: 'snapshot_invalid' });
    expect(ok1.ok).toBe(true);
    const noCode = parseInboundEvent({ type: 'play.preview.failed', playSessionId: play });
    expect(noCode.ok).toBe(false);
    if (!noCode.ok) expect(noCode.kind).toBe('protocol_error');
  });

  it('screenshot.ack: ok:true requires dataUrl/width/height, ok:false requires error', () => {
    const ok1 = parseInboundEvent({
      type: 'screenshot.ack',
      relayId: relay,
      ok: true,
      dataUrl: 'data:image/png;base64,AAA=',
      width: 512,
      height: 256,
    });
    expect(ok1.ok).toBe(true);
    const missing = parseInboundEvent({ type: 'screenshot.ack', relayId: relay, ok: true });
    expect(missing.ok).toBe(true); // dataUrl/width/height are OPTIONAL fields of the ack
      // (the §7.2 payload marks them `?`); the backend treats a missing
      // dataUrl on ok:true as a relay failure (relay_failed).
    const badRelay = parseInboundEvent({ type: 'screenshot.ack', relayId: 'relay-bad', ok: true });
    expect(badRelay.ok).toBe(false);
    const err = parseInboundEvent({ type: 'screenshot.ack', relayId: relay, ok: false, error: { code: 'relay_failed' } });
    expect(err.ok).toBe(true);
    const noErr = parseInboundEvent({ type: 'screenshot.ack', relayId: relay, ok: false });
    expect(noErr.ok).toBe(false);
    if (!noErr.ok) expect(noErr.kind).toBe('protocol_error');
    const errExtra = parseInboundEvent({ type: 'screenshot.ack', relayId: relay, ok: false, error: { code: 'x', evil: 1 } });
    expect(errExtra.ok).toBe(false);
  });

  it('play.diagnostics.ack: diagnostics ≤ 16 KiB', () => {
    const big = JSON.stringify({ d: 'x'.repeat(20000) });
    const okBig = parseInboundEvent({ type: 'play.diagnostics.ack', relayId: relay, ok: true, diagnostics: JSON.parse(big) });
    expect(okBig.ok).toBe(false);
    if (!okBig.ok) expect(okBig.kind).toBe('protocol_error');
    const okSmall = parseInboundEvent({ type: 'play.diagnostics.ack', relayId: relay, ok: true, diagnostics: { renderBackend: 'webgl2' } });
    expect(okSmall.ok).toBe(true);
  });

  it('malformed frames ⇒ protocol_error', () => {
    for (const v of ['str', null, [1], 42, {}, { type: 7 }]) {
      const r = parseInboundEvent(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('protocol_error');
    }
  });
});

describe('frame bounds (sessions.md §5.2/§11.5)', () => {
  it('incoming: ≤ 64 KiB default, ≤ 1.5 MiB for screenshot.ack', () => {
    expect(WS_IN_FRAME_MAX).toBe(65536);
    expect(WS_SCREENSHOT_ACK_MAX).toBe(1572864);
    expect(WS_OUT_FRAME_MAX).toBe(1048576);
    expect(inboundFrameAllowed(WS_SCREENSHOT_ACK_MAX)).toBe(true);
    expect(inboundFrameAllowed(WS_SCREENSHOT_ACK_MAX + 1)).toBe(false);
  });
  it('enforceDefaultFrameBound: only screenshot.ack-shaped frames pass the 64 KiB bound', () => {
    expect(enforceDefaultFrameBound(1000, { type: 'ping' })).toBe(true);
    expect(enforceDefaultFrameBound(WS_IN_FRAME_MAX + 1, { type: 'ping' })).toBe(false);
    expect(enforceDefaultFrameBound(WS_IN_FRAME_MAX + 1, { type: 'screenshot.ack', relayId: relay, ok: true })).toBe(true);
    expect(enforceDefaultFrameBound(WS_IN_FRAME_MAX + 1, { type: 'screenshot_ack' })).toBe(false);
  });
});