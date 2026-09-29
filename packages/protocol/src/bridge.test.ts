/**
 * Bridge message allowlist + validators (v2).
 */
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_EDITOR_TO_PREVIEW_TYPES,
  BRIDGE_PREVIEW_TO_EDITOR_TYPES,
  BRIDGE_VERSION,
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
} from './bridge';
import { parseInputRelayRequest } from './delivery';
import { makeInputRelayRequest } from './ws-events';

const hex32 = '0123456789abcdef0123456789abcdef';
const play = `play-${hex32}`;
const relay = `relay-${hex32}`;
const req = `req-${hex32}`;
const nonce = 'abcdef0123456789';
const contentId = 'c'.repeat(43);
const buildId = 'd'.repeat(64);
const contentDigest = 'e'.repeat(64);

describe('allowlist constants (v2)', () => {
  it('editor → preview: exactly the v2 set', () => {
    expect([...BRIDGE_EDITOR_TO_PREVIEW_TYPES].sort()).toEqual(
      [
        'tl.debug.request',
        'tl.diagnostics.request',
        'tl.game.control',
        'tl.game.observe',
        'tl.handshake',
        'tl.input.request',
        'tl.play.stop',
        'tl.playContent.expect',
        'tl.ping',
        'tl.screenshot.request',
        'tl.snapshot',
      ].sort(),
    );
  });
  it('the debugger messages are validated (behavior, entity, bounded breakpoints, commands)', () => {
    const base = { v: 2, type: 'tl.debug.request', playSessionId: `play-${'a'.repeat(32)}`, relayId: `relay-${'b'.repeat(32)}`, behaviorId: 'door', breakpoints: ['n1', 'fn:open/n2', 'lib:shared/n3'] };
    expect(validateBridgeEditorToPreview(base).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ ...base, entityId: 'box-1', command: 'step' }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ ...base, command: 'jump' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ ...base, breakpoints: ['bad id'] }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ ...base, breakpoints: Array.from({ length: 65 }, (_, i) => `n${i}`) }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ ...base, extra: 1 }).ok).toBe(false);
    const result = { v: 2, type: 'tl.debug.result', playSessionId: base.playSessionId, relayId: base.relayId, ok: true, result: { paused: false } };
    expect(validateBridgePreviewToEditor(result).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ ...result, result: { big: 'x'.repeat(40_000) } }).ok).toBe(false);
    for (const command of ['debugPause', 'debugResume', 'debugStep']) {
      expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.game.control', playSessionId: base.playSessionId, relayId: base.relayId, command }).ok).toBe(true);
    }
  });
  it('preview → editor: exactly the v2 set', () => {
    expect([...BRIDGE_PREVIEW_TO_EDITOR_TYPES].sort()).toEqual(
      [
        'tl.debug.result',
        'tl.diagnostics.result',
        'tl.error',
        'tl.game.control.result',
        'tl.game.observe.result',
        'tl.handshake.ack',
        'tl.input.result',
        'tl.load.progress',
        'tl.pong',
        'tl.ready',
        'tl.screenshot.result',
        'tl.stopped',
      ].sort(),
    );
  });
  it('the M2 discriminator is v: 2 (a v: 1 message is rejected like an unknown field)', () => {
    expect(BRIDGE_VERSION).toBe(2);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.ping' }).ok).toBe(false);
  });
});

describe('editor → preview validators', () => {
  it('tl.handshake (v2: bridgeVersion + contentId + buildId)', () => {
    const ok = validateBridgeEditorToPreview({ v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId: play, nonce, demo: true, contentId, buildId });
    expect(ok.ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId: play, nonce: 'ABC', demo: true, contentId, buildId }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.handshake', bridgeVersion: 1, playSessionId: play, nonce, demo: true, contentId, buildId }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId: play, nonce, demo: true, contentId: 'short', buildId }).ok).toBe(false);
  });

  it('tl.snapshot (strict wrapper, ≤ fields)', () => {
    const snap = {
      v: 2,
      type: 'tl.snapshot',
      playSessionId: play,
      nonce,
      snapshot: { snapshotId: 'demo-0001@r4', projectId: 'demo-0001', revision: 4, scene: { schemaVersion: 1, sceneId: 'scene-main', revision: 4, entities: [] } },
    };
    expect(validateBridgeEditorToPreview(snap).ok).toBe(true);
    const extraSnap = { ...snap, snapshot: { ...snap.snapshot, extra: 1 } };
    expect(validateBridgeEditorToPreview(extraSnap).ok).toBe(false);
    const badNonce2 = validateBridgeEditorToPreview({ ...snap, nonce: 'nope' });
    expect(badNonce2.ok).toBe(false);
  });

  it('tl.playContent.expect', () => {
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.playContent.expect', playSessionId: play, contentId, buildId }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.playContent.expect', playSessionId: play, contentId, buildId: 'nope' }).ok).toBe(false);
  });

  it('tl.input.request (1–600 strictly ascending frames)', () => {
    const ok = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } }, { stepOffset: 5, actions: { move: { v: 0.5, p: 'none' }, jump: { v: 1, p: 'held' } } }] });
    expect(ok.ok).toBe(true);
    const dup = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 1 }, { stepOffset: 1 }] });
    expect(dup.ok).toBe(false);
    const empty = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [] });
    expect(empty.ok).toBe(false);
    const tooMany = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: Array.from({ length: 601 }, (_, i) => ({ stepOffset: i })) });
    expect(tooMany.ok).toBe(false);
    const badJump = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, moveX: 0, jump: 'up' }] });
    expect(badJump.ok).toBe(false);
    // The move vector's forward axis and named actions travel with a frame.
    const vec = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 0, p: 'none' }, run: { v: 1, p: 'held' } } }] });
    expect(vec.ok).toBe(true);
    // Frame version 2 — the fixed channels are refused.
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, moveX: 0.5, jump: 'none' }] }).ok).toBe(false);
    expect(parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 0, moveX: 0.5, jump: 'none' }] }).ok).toBe(false);
  });

  it('the relay body parser and the WS event keep the named actions (a 2D move is { v, x, y }; frame version 2)', () => {
    const parsed = parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 0, actions: { move: { v: 0.25, x: 0.25, y: -0.5, p: 'none' }, jump: { v: 0, p: 'none' } } }, { stepOffset: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } }] });
    expect(parsed.ok && parsed.request.frames).toEqual([{ stepOffset: 0, actions: { move: { v: 0.25, x: 0.25, y: -0.5, p: 'none' }, jump: { v: 0, p: 'none' } } }, { stepOffset: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } }]);
    expect(parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 0, actions: { move: { v: 0, x: 0, y: 'up', p: 'none' }, jump: { v: 0, p: 'none' } } }] }).ok).toBe(false);
    const ws = JSON.parse(makeInputRelayRequest('req-1', [{ stepOffset: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 0, p: 'none' }, run: { v: 1, p: 'held' } } }, { stepOffset: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } }])) as { frames: unknown[] };
    expect(ws.frames).toEqual([{ stepOffset: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 0, p: 'none' }, run: { v: 1, p: 'held' } } }, { stepOffset: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } }]);
  });

  it('run-length frames, a virtual gamepad and UI edges (no overlap, the span bounded)', () => {
    const frames = [
      { stepOffset: 0, steps: 120, actions: { move: { v: 1, p: 'none' } } },
      { stepOffset: 120, gamepad: { buttons: [1, 0, 0.25], axes: [0.123456, -1] } },
      { stepOffset: 130, ui: ['down', 'submit'] },
    ];
    const parsed = parseInputRelayRequest({ mode: 'exclusive-test', frames });
    expect(parsed.ok && parsed.request.frames).toEqual([
      { stepOffset: 0, steps: 120, actions: { move: { v: 1, p: 'none' } } },
      { stepOffset: 120, gamepad: { buttons: [1, 0, 0.25], axes: [0.1235, -1] } },
      { stepOffset: 130, ui: ['down', 'submit'] },
    ]);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames }).ok).toBe(true);
    const ws = JSON.parse(makeInputRelayRequest('req-1', parsed.ok ? parsed.request.frames : [])) as { frames: unknown[] };
    expect(ws.frames).toEqual(parsed.ok ? parsed.request.frames : null);
    // A frame starting inside the run before it is refused.
    const overlap = parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 0, steps: 10 }, { stepOffset: 5 }] });
    expect(overlap.ok).toBe(false);
    expect(!overlap.ok && overlap.error.message).toContain('overlap');
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, steps: 10 }, { stepOffset: 5 }] }).ok).toBe(false);
    // The span ends by 7200 steps.
    const long = parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 7000, steps: 201 }] });
    expect(!long.ok && long.error.code).toBe('input_relay_limits_exceeded');
    expect(parseInputRelayRequest({ mode: 'exclusive-test', frames: [{ stepOffset: 7000, steps: 200 }] }).ok).toBe(true);
    for (const bad of [{ stepOffset: 0, steps: 0 }, { stepOffset: 0, steps: 1.5 }, { stepOffset: 0, gamepad: { buttons: [2] } }, { stepOffset: 0, gamepad: { axes: [0, 0, 0, 0, 0] } }, { stepOffset: 0, gamepad: { trigger: 1 } }, { stepOffset: 0, ui: [] }, { stepOffset: 0, ui: ['jump'] }]) {
      expect(parseInputRelayRequest({ mode: 'exclusive-test', frames: [bad] }).ok, JSON.stringify(bad)).toBe(false);
      expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [bad] }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('hold travels with the relay (a boolean)', () => {
    const r = parseInputRelayRequest({ mode: 'exclusive-test', hold: true, restart: true, frames: [{ stepOffset: 0 }] });
    expect(r.ok && r.request).toMatchObject({ hold: true, restart: true });
    expect(parseInputRelayRequest({ mode: 'exclusive-test', hold: 1, frames: [{ stepOffset: 0 }] }).ok).toBe(false);
    const plain = parseInputRelayRequest({ mode: 'exclusive-test', hold: false, frames: [{ stepOffset: 0 }] });
    expect(plain.ok && plain.request.hold).toBeUndefined();
    expect((JSON.parse(makeInputRelayRequest('req-1', [{ stepOffset: 0 }], false, true)) as { hold?: boolean }).hold).toBe(true);
    expect((JSON.parse(makeInputRelayRequest('req-1', [{ stepOffset: 0 }], true)) as { hold?: boolean }).hold).toBeUndefined();
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, hold: true, frames: [{ stepOffset: 0 }] }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, hold: 'yes', frames: [{ stepOffset: 0 }] }).ok).toBe(false);
  });

  it('restart travels with the relay (a boolean)', () => {
    const r = parseInputRelayRequest({ mode: 'exclusive-test', restart: true, frames: [{ stepOffset: 0 }] });
    expect(r.ok && r.request.restart).toBe(true);
    expect(parseInputRelayRequest({ mode: 'exclusive-test', restart: 'yes', frames: [{ stepOffset: 0 }] }).ok).toBe(false);
    const plain = parseInputRelayRequest({ mode: 'exclusive-test', restart: false, frames: [{ stepOffset: 0 }] });
    expect(plain.ok && plain.request.restart).toBeUndefined();
    expect((JSON.parse(makeInputRelayRequest('req-1', [{ stepOffset: 0 }], true)) as { restart?: boolean }).restart).toBe(true);
    expect((JSON.parse(makeInputRelayRequest('req-1', [{ stepOffset: 0 }])) as { restart?: boolean }).restart).toBeUndefined();
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, restart: true, frames: [{ stepOffset: 0 }] }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, restart: 1, frames: [{ stepOffset: 0 }] }).ok).toBe(false);
  });

  it('tl.play.stop / tl.ping', () => {
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.play.stop', playSessionId: play }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.play.stop' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.ping' }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.ping', extra: 1 }).ok).toBe(false);
  });

  it('tl.screenshot.request (maxWidth 256–2048) / tl.diagnostics.request', () => {
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.screenshot.request', playSessionId: play, relayId: relay }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.screenshot.request', playSessionId: play, relayId: relay, maxWidth: 512 }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.screenshot.request', playSessionId: play, relayId: relay, maxWidth: 100 }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.diagnostics.request', playSessionId: play, relayId: relay }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.diagnostics.request', playSessionId: play, relayId: `relay-bad` }).ok).toBe(false);
  });

  it('unknown type / non-object ⇒ rejected', () => {
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.evil' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview('nope').ok).toBe(false);
    expect(validateBridgeEditorToPreview(null).ok).toBe(false);
  });
});

describe('preview → editor validators', () => {
  it('tl.handshake.ack (echoes nonce)', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.handshake.ack', playSessionId: play, nonce }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.handshake.ack', playSessionId: play }).ok).toBe(false);
  });

  it('tl.ready (v2: buildId + contentDigest + stepIndex)', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.ready', playSessionId: play, snapshotId: 'demo-0001@r4', revision: 4, buildId, contentDigest, stepIndex: 12 }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.ready', playSessionId: play, snapshotId: 'demo-0001@r4', revision: 4 }).ok).toBe(false);
  });

  it('tl.load.progress (phase set, ≤ 1 KiB)', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.load.progress', playSessionId: play, phase: 'assets', loadedBytes: 10, totalBytes: 100 }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.load.progress', playSessionId: play, phase: 'nope', loadedBytes: 0, totalBytes: 0 }).ok).toBe(false);
  });

  it('tl.input.result', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.input.result', playSessionId: play, requestId: req, ok: true, appliedFromStep: 10, appliedToStep: 12 }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.input.result', playSessionId: play, requestId: req, ok: true }).ok).toBe(false);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.input.result', playSessionId: play, requestId: req, ok: false, error: { code: 'input_relay_conflict' } }).ok).toBe(true);
  });

  it('tl.stopped', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.stopped', playSessionId: play }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.stopped' }).ok).toBe(false);
  });

  it('tl.screenshot.result (ok ⇒ dataUrl+width+height; not-ok ⇒ error)', () => {
    const ok = validateBridgePreviewToEditor({
      v: 2,
      type: 'tl.screenshot.result',
      playSessionId: play,
      relayId: relay,
      ok: true,
      dataUrl: 'data:image/png;base64,AAA=',
      width: 512,
      height: 256,
    });
    expect(ok.ok).toBe(true);
    const noData = validateBridgePreviewToEditor({ v: 2, type: 'tl.screenshot.result', playSessionId: play, relayId: relay, ok: true });
    expect(noData.ok).toBe(false);
    const wrongUrl = validateBridgePreviewToEditor({
      v: 2,
      type: 'tl.screenshot.result',
      playSessionId: play,
      relayId: relay,
      ok: true,
      dataUrl: 'data:image/jpeg;base64,AAA=',
      width: 512,
      height: 256,
    });
    expect(wrongUrl.ok).toBe(false);
    const err = validateBridgePreviewToEditor({
      v: 2,
      type: 'tl.screenshot.result',
      playSessionId: play,
      relayId: relay,
      ok: false,
      error: { code: 'render_unsupported', message: 'no WebGL' },
    });
    expect(err.ok).toBe(true);
  });

  it('tl.diagnostics.result (≤ 16 KiB) / tl.error (phase) / tl.pong', () => {
    const ok = validateBridgePreviewToEditor({ v: 2, type: 'tl.diagnostics.result', playSessionId: play, relayId: relay, ok: true, diagnostics: { renderBackend: 'webgl2' } });
    expect(ok.ok).toBe(true);
    const big = validateBridgePreviewToEditor({ v: 2, type: 'tl.diagnostics.result', playSessionId: play, relayId: relay, ok: true, diagnostics: { x: 'y'.repeat(20000) } });
    expect(big.ok).toBe(false);
    const err = validateBridgePreviewToEditor({ v: 2, type: 'tl.error', playSessionId: play, code: 'snapshot_invalid', message: 'bad', phase: 'manifest' });
    expect(err.ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.error', playSessionId: play, code: 'x', phase: 'nope' }).ok).toBe(false);
    const noCode = validateBridgePreviewToEditor({ v: 2, type: 'tl.error', playSessionId: play });
    expect(noCode.ok).toBe(false);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.pong' }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.pong', extra: 1 }).ok).toBe(false);
  });

  it('unknown type ⇒ rejected', () => {
    expect(validateBridgePreviewToEditor({ v: 2, type: 'tl.evil' }).ok).toBe(false);
  });
});
