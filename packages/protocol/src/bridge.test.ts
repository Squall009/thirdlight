/**
 * Bridge message allowlist + validators (sessions.md §13.5/§17.6, v2).
 */
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_EDITOR_TO_PREVIEW_TYPES,
  BRIDGE_PREVIEW_TO_EDITOR_TYPES,
  BRIDGE_VERSION,
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
} from './bridge';

const hex32 = '0123456789abcdef0123456789abcdef';
const play = `play-${hex32}`;
const relay = `relay-${hex32}`;
const req = `req-${hex32}`;
const nonce = 'abcdef0123456789';
const contentId = 'c'.repeat(43);
const buildId = 'd'.repeat(64);
const contentDigest = 'e'.repeat(64);

describe('allowlist constants (sessions.md §13.5, v2)', () => {
  it('editor → preview: exactly the §13.5 v2 set', () => {
    expect([...BRIDGE_EDITOR_TO_PREVIEW_TYPES].sort()).toEqual(
      [
        'tl.diagnostics.request',
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
  it('preview → editor: exactly the §13.5 v2 set', () => {
    expect([...BRIDGE_PREVIEW_TO_EDITOR_TYPES].sort()).toEqual(
      [
        'tl.diagnostics.result',
        'tl.error',
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
    const ok = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, moveX: 1, jump: 'pressed' }, { stepOffset: 5, moveX: 0.5, jump: 'held' }] });
    expect(ok.ok).toBe(true);
    const dup = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 1, moveX: 0, jump: 'none' }, { stepOffset: 1, moveX: 0, jump: 'none' }] });
    expect(dup.ok).toBe(false);
    const empty = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [] });
    expect(empty.ok).toBe(false);
    const tooMany = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: Array.from({ length: 601 }, (_, i) => ({ stepOffset: i, moveX: 0, jump: 'none' })) });
    expect(tooMany.ok).toBe(false);
    const badJump = validateBridgeEditorToPreview({ v: 2, type: 'tl.input.request', playSessionId: play, requestId: req, frames: [{ stepOffset: 0, moveX: 0, jump: 'up' }] });
    expect(badJump.ok).toBe(false);
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
