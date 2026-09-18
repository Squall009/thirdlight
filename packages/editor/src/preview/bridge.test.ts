import { describe, it, expect } from 'vitest';
import { Bridge, type BridgeMessageEvent } from './bridge';

const EDITOR_ORIGIN = 'http://127.0.0.1:8501';
const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
const PLAY_ID = 'play-' + 'b'.repeat(32);

function makePair() {
  const postedEditorToPreview: Array<{ data: unknown; target: string }> = [];
  const postedPreviewToEditor: Array<{ data: unknown; target: string }> = [];
  const previewWin = { tag: 'preview-window' };
  const editorWin = { tag: 'editor-window' };

  const editor = new Bridge({
    direction: 'editor',
    expectedOrigin: PREVIEW_ORIGIN,
    targetOrigin: PREVIEW_ORIGIN,
    post: (data, target) => {
      postedEditorToPreview.push({ data, target });
    },
    isTrustedSource: (s) => (s as { tag?: string })?.tag === 'preview-window',
    makeNonce: () => 'a'.repeat(16),
  });
  const preview = new Bridge({
    direction: 'preview',
    expectedOrigin: EDITOR_ORIGIN,
    targetOrigin: EDITOR_ORIGIN,
    post: (data, target) => {
      postedPreviewToEditor.push({ data, target });
    },
    isTrustedSource: (s) => (s as { tag?: string })?.tag === 'editor-window',
  });
  return { editor, preview, previewWin, editorWin, postedEditorToPreview, postedPreviewToEditor };
}

function deliver(target: Bridge, event: BridgeMessageEvent): void {
  target.handleMessage(event);
}

describe('Bridge — §13.3 transport checks (origin + source)', () => {
  it('drops a message from the wrong origin (and counts it)', () => {
    const { editor } = makePair();
    editor.on('tl.ready', () => {
      throw new Error('must not fire');
    });
    deliver(editor, { origin: 'http://evil.example', source: { tag: 'preview-window' }, data: { v: 1, type: 'tl.ready', playSessionId: 'play-' + '0'.repeat(32), snapshotId: 's', revision: 0 } });
    expect(editor.drops.byReason.origin_mismatch).toBe(1);
    expect(editor.drops.total).toBe(1);
  });

  it('drops a message from an untrusted source', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'someone-else' }, data: { v: 1, type: 'tl.ready', playSessionId: 'play-' + '0'.repeat(32), snapshotId: 's', revision: 0 } });
    expect(editor.drops.byReason.source_untrusted).toBe(1);
  });

  it('drops a non-object payload', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: 'hi' });
    expect(editor.drops.byReason.not_object).toBe(1);
  });
});

describe('Bridge — §13.5 allowlist (exhaustive)', () => {
  it('drops a type not in the receive allowlist', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { v: 1, type: 'tl.evil', playSessionId: 'play-' + '0'.repeat(32) } });
    expect(editor.drops.total).toBe(1);
    expect(Object.keys(editor.drops.byReason)[0]).toContain('invalid');
  });

  it('rejects an unknown field (strict validator)', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { v: 1, type: 'tl.ready', playSessionId: 'play-' + '0'.repeat(32), snapshotId: 's', revision: 0, secret: 'x' } });
    expect(editor.drops.total).toBe(1);
  });
});

describe('Bridge — handshake + nonce sequence', () => {

  it('the full handshake: editor nonce is echoed and accepted', () => {
    const { editor, preview, previewWin, postedEditorToPreview } = makePair();
    let readySeen = false;
    editor.on('tl.ready', () => {
      readySeen = true;
    });
    preview.on('tl.handshake', (m) => {
      const msg = m as { nonce: string; playSessionId: string };
      preview.ackHandshake(msg.playSessionId, msg.nonce);
    });

    const nonce = editor.beginHandshake(PLAY_ID, false);
    expect(nonce).toBe('a'.repeat(16));
    // Route the editor's posted handshake into the preview (from the editor window)
    // so the preview echoes the nonce back.
    for (const p of [...postedEditorToPreview]) {
      deliver(preview, { origin: EDITOR_ORIGIN, source: { tag: 'editor-window' }, data: p.data });
    }
    // Deliver the preview's ack + ready to the editor (from the preview window).
    deliver(editor, { origin: PREVIEW_ORIGIN, source: previewWin, data: { v: 1, type: 'tl.handshake.ack', playSessionId: PLAY_ID, nonce: 'a'.repeat(16) } });
    deliver(editor, { origin: PREVIEW_ORIGIN, source: previewWin, data: { v: 1, type: 'tl.ready', playSessionId: PLAY_ID, snapshotId: 's@r0', revision: 0 } });
    expect(readySeen).toBe(true);
  });

  it('a tl.snapshot whose nonce does not match the handshake is DROPPED (preview side)', () => {
    const { preview, editorWin } = makePair();
    let got = false;
    preview.on('tl.snapshot', () => {
      got = true;
    });
    // Handshake with nonce N.
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: { v: 1, type: 'tl.handshake', playSessionId: PLAY_ID, nonce: 'c'.repeat(16), demo: false } });
    // A snapshot with a DIFFERENT nonce must be dropped.
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: { v: 1, type: 'tl.snapshot', playSessionId: PLAY_ID, nonce: 'd'.repeat(16), snapshot: { snapshotId: 's', projectId: 'p', revision: 0, scene: { schemaVersion: 1, sceneId: 'sc', revision: 0, entities: [] } } } });
    expect(got).toBe(false);
    expect(preview.drops.byReason.snapshot_nonce_mismatch).toBe(1);
  });

  it('a tl.snapshot with the matching nonce is delivered (preview side)', () => {
    const { preview, editorWin } = makePair();
    let got = false;
    preview.on('tl.snapshot', () => {
      got = true;
    });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: { v: 1, type: 'tl.handshake', playSessionId: PLAY_ID, nonce: 'e'.repeat(16), demo: false } });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: { v: 1, type: 'tl.snapshot', playSessionId: PLAY_ID, nonce: 'e'.repeat(16), snapshot: { snapshotId: 's', projectId: 'p', revision: 0, scene: { schemaVersion: 1, sceneId: 'sc', revision: 0, entities: [] } } } });
    expect(got).toBe(true);
  });

  it('the editor drops a tl.handshake.ack whose nonce does not match', () => {
    const { editor } = makePair();
    let acked = false;
    editor.on('tl.handshake.ack', () => {
      acked = true;
    });
    editor.beginHandshake(PLAY_ID, false); // nonce = aaaa...
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { v: 1, type: 'tl.handshake.ack', playSessionId: PLAY_ID, nonce: 'f'.repeat(16) } });
    expect(acked).toBe(false);
    expect(editor.drops.byReason.ack_nonce_mismatch).toBe(1);
  });
});

describe('Bridge — no wildcard, no credentials (m1-acceptance §2.2)', () => {
  function runHandshakeAndSnapshot() {
    const pair = makePair();
    pair.preview.on('tl.handshake', (m) => {
      const msg = m as { nonce: string; playSessionId: string };
      pair.preview.ackHandshake(msg.playSessionId, msg.nonce);
    });
    pair.editor.beginHandshake(PLAY_ID, false);
    for (const p of [...pair.postedEditorToPreview]) {
      deliver(pair.preview, { origin: EDITOR_ORIGIN, source: { tag: 'editor-window' }, data: p.data });
    }
    pair.editor.sendSnapshot(PLAY_ID, {
      snapshotId: 's',
      projectId: 'p',
      revision: 0,
      scene: { schemaVersion: 1, sceneId: 'sc', revision: 0, entities: [] },
    });
    return pair;
  }

  it('every postMessage targets the exact peer origin (never "*")', () => {
    const pair = runHandshakeAndSnapshot();
    for (const p of pair.postedEditorToPreview) {
      expect(p.target).toBe(PREVIEW_ORIGIN);
      expect(p.target).not.toBe('*');
    }
    for (const p of pair.postedPreviewToEditor) {
      expect(p.target).toBe(EDITOR_ORIGIN);
      expect(p.target).not.toBe('*');
    }
    expect(pair.postedPreviewToEditor.length).toBeGreaterThan(0); // the ack was posted back
  });

  it('bridge messages carry no authoring token or authoring API URL', () => {
    const pair = runHandshakeAndSnapshot();
    const serialized = JSON.stringify([...pair.postedEditorToPreview, ...pair.postedPreviewToEditor]);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toContain('/api/v1/');
  });
});

function playId(): string {
  return 'play-' + '9'.repeat(32);
}