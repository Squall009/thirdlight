/**
 * Bridge message allowlist + validators (sessions.md §13.5, exhaustive).
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
const nonce = 'abcdef0123456789';

describe('allowlist constants (sessions.md §13.5)', () => {
  it('editor → preview: exactly the §13.5 set', () => {
    expect([...BRIDGE_EDITOR_TO_PREVIEW_TYPES].sort()).toEqual(
      ['tl.diagnostics.request', 'tl.handshake', 'tl.play.stop', 'tl.ping', 'tl.screenshot.request', 'tl.snapshot'].sort(),
    );
  });
  it('preview → editor: exactly the §13.5 set', () => {
    expect([...BRIDGE_PREVIEW_TO_EDITOR_TYPES].sort()).toEqual(
      ['tl.diagnostics.result', 'tl.error', 'tl.handshake.ack', 'tl.pong', 'tl.ready', 'tl.screenshot.result', 'tl.stopped'].sort(),
    );
  });
  it('the M1 discriminator is v: 1', () => {
    expect(BRIDGE_VERSION).toBe(1);
  });
});

describe('editor → preview validators', () => {
  it('tl.handshake', () => {
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.handshake', playSessionId: play, nonce, demo: true }).ok).toBe(true);
    const badNonce = validateBridgeEditorToPreview({ v: 1, type: 'tl.handshake', playSessionId: play, nonce: 'ABC', demo: true });
    expect(badNonce.ok).toBe(false);
    const noDemo = validateBridgeEditorToPreview({ v: 1, type: 'tl.handshake', playSessionId: play, nonce });
    expect(noDemo.ok).toBe(false);
  });

  it('tl.snapshot (strict wrapper, ≤ fields)', () => {
    const snap = {
      v: 1,
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

  it('tl.play.stop / tl.ping', () => {
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.play.stop', playSessionId: play }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.play.stop' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.ping' }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.ping', extra: 1 }).ok).toBe(false);
  });

  it('tl.screenshot.request (maxWidth 256–2048) / tl.diagnostics.request', () => {
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.screenshot.request', playSessionId: play, relayId: relay }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.screenshot.request', playSessionId: play, relayId: relay, maxWidth: 512 }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.screenshot.request', playSessionId: play, relayId: relay, maxWidth: 100 }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.diagnostics.request', playSessionId: play, relayId: relay }).ok).toBe(true);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.diagnostics.request', playSessionId: play, relayId: `relay-bad` }).ok).toBe(false);
  });

  it('v ≠ 1 / unknown type / non-object ⇒ rejected', () => {
    expect(validateBridgeEditorToPreview({ v: 2, type: 'tl.ping' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview({ v: 1, type: 'tl.evil' }).ok).toBe(false);
    expect(validateBridgeEditorToPreview('nope').ok).toBe(false);
    expect(validateBridgeEditorToPreview(null).ok).toBe(false);
  });
});

describe('preview → editor validators', () => {
  it('tl.handshake.ack (echoes nonce)', () => {
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.handshake.ack', playSessionId: play, nonce }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.handshake.ack', playSessionId: play }).ok).toBe(false);
  });

  it('tl.ready { playSessionId, snapshotId, revision }', () => {
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.ready', playSessionId: play, snapshotId: 'demo-0001@r4', revision: 4 }).ok).toBe(true);
    const noRev = validateBridgePreviewToEditor({ v: 1, type: 'tl.ready', playSessionId: play, snapshotId: 'demo-0001@r4' });
    expect(noRev.ok).toBe(false);
  });

  it('tl.stopped', () => {
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.stopped', playSessionId: play }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.stopped' }).ok).toBe(false);
  });

  it('tl.screenshot.result (ok ⇒ dataUrl+width+height; not-ok ⇒ error)', () => {
    const ok = validateBridgePreviewToEditor({
      v: 1,
      type: 'tl.screenshot.result',
      playSessionId: play,
      relayId: relay,
      ok: true,
      dataUrl: 'data:image/png;base64,AAA=',
      width: 512,
      height: 256,
    });
    expect(ok.ok).toBe(true);
    const noData = validateBridgePreviewToEditor({ v: 1, type: 'tl.screenshot.result', playSessionId: play, relayId: relay, ok: true });
    expect(noData.ok).toBe(false);
    const wrongUrl = validateBridgePreviewToEditor({
      v: 1,
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
      v: 1,
      type: 'tl.screenshot.result',
      playSessionId: play,
      relayId: relay,
      ok: false,
      error: { code: 'render_unsupported', message: 'no WebGL' },
    });
    expect(err.ok).toBe(true);
  });

  it('tl.diagnostics.result (≤ 16 KiB) / tl.error / tl.pong', () => {
    const ok = validateBridgePreviewToEditor({ v: 1, type: 'tl.diagnostics.result', playSessionId: play, relayId: relay, ok: true, diagnostics: { renderBackend: 'webgl2' } });
    expect(ok.ok).toBe(true);
    const big = validateBridgePreviewToEditor({ v: 1, type: 'tl.diagnostics.result', playSessionId: play, relayId: relay, ok: true, diagnostics: { x: 'y'.repeat(20000) } });
    expect(big.ok).toBe(false);
    const err = validateBridgePreviewToEditor({ v: 1, type: 'tl.error', playSessionId: play, code: 'snapshot_invalid', message: 'bad' });
    expect(err.ok).toBe(true);
    const noCode = validateBridgePreviewToEditor({ v: 1, type: 'tl.error', playSessionId: play });
    expect(noCode.ok).toBe(false);
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.pong' }).ok).toBe(true);
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.pong', extra: 1 }).ok).toBe(false);
  });

  it('v ≠ 1 / unknown type ⇒ rejected', () => {
    expect(validateBridgePreviewToEditor({ v: 3, type: 'tl.pong' }).ok).toBe(false);
    expect(validateBridgePreviewToEditor({ v: 1, type: 'tl.evil' }).ok).toBe(false);
  });
});