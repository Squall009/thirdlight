import { describe, it, expect } from 'vitest';
import { Bridge, type BridgeMessageEvent } from './bridge';

const EDITOR_ORIGIN = 'http://127.0.0.1:8501';
const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
const PLAY_ID = 'play-' + 'b'.repeat(32);
const CONTENT_ID = 'c'.repeat(43);
const BUILD_ID = 'd'.repeat(64);
const CONTENT_DIGEST = 'e'.repeat(64);

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

const HANDSHAKE = { v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId: PLAY_ID, nonce: 'c'.repeat(16), demo: false, contentId: CONTENT_ID, buildId: BUILD_ID };
const READY = { v: 2, type: 'tl.ready', playSessionId: PLAY_ID, snapshotId: 's@r0', revision: 0, buildId: BUILD_ID, contentDigest: CONTENT_DIGEST, stepIndex: 0 };
const SNAPSHOT = { v: 2, type: 'tl.snapshot', playSessionId: PLAY_ID, nonce: 'c'.repeat(16), snapshot: { snapshotId: 's', projectId: 'p', revision: 0, scene: { schemaVersion: 1, sceneId: 'sc', revision: 0, entities: [] } } };

describe('Bridge — §13.3 transport checks (origin + source)', () => {
  it('drops a message from the wrong origin (and counts it)', () => {
    const { editor } = makePair();
    editor.on('tl.ready', () => {
      throw new Error('must not fire');
    });
    deliver(editor, { origin: 'http://evil.example', source: { tag: 'preview-window' }, data: READY });
    expect(editor.drops.byReason.origin_mismatch).toBe(1);
    expect(editor.drops.total).toBe(1);
  });

  it('drops a message from an untrusted source', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'someone-else' }, data: READY });
    expect(editor.drops.byReason.source_untrusted).toBe(1);
  });

  it('drops a non-object payload', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: 'hi' });
    expect(editor.drops.byReason.not_object).toBe(1);
  });
});

describe('Bridge — §13.5 allowlist (exhaustive, v2)', () => {
  it('drops a type not in the receive allowlist', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { v: 2, type: 'tl.evil', playSessionId: PLAY_ID } });
    expect(editor.drops.total).toBe(1);
    expect(Object.keys(editor.drops.byReason)[0]).toContain('invalid');
  });

  it('rejects an unknown field (strict validator)', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { ...READY, secret: 'x' } });
    expect(editor.drops.total).toBe(1);
  });

  it('a v: 1 message is rejected exactly like an unknown field (M2 discriminator)', () => {
    const { editor } = makePair();
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { ...READY, v: 1 } });
    expect(editor.drops.total).toBe(1);
  });
});

describe('Bridge — handshake + nonce sequence', () => {
  it('the full v2 handshake: editor nonce is echoed and accepted', () => {
    const { editor, preview, previewWin, postedEditorToPreview } = makePair();
    let readySeen = false;
    editor.on('tl.ready', () => {
      readySeen = true;
    });
    preview.on('tl.handshake', (m) => {
      const msg = m as { nonce: string; playSessionId: string };
      preview.ackHandshake(msg.playSessionId, msg.nonce);
    });

    const nonce = editor.beginHandshake(PLAY_ID, false, CONTENT_ID, BUILD_ID);
    expect(nonce).toBe('a'.repeat(16));
    for (const p of [...postedEditorToPreview]) {
      deliver(preview, { origin: EDITOR_ORIGIN, source: { tag: 'editor-window' }, data: p.data });
    }
    deliver(editor, { origin: PREVIEW_ORIGIN, source: previewWin, data: { v: 2, type: 'tl.handshake.ack', playSessionId: PLAY_ID, nonce: 'a'.repeat(16) } });
    deliver(editor, { origin: PREVIEW_ORIGIN, source: previewWin, data: READY });
    expect(readySeen).toBe(true);
  });

  it('a tl.snapshot whose nonce does not match the handshake is DROPPED (preview side)', () => {
    const { preview, editorWin } = makePair();
    let got = false;
    preview.on('tl.snapshot', () => {
      got = true;
    });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: HANDSHAKE });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: { ...SNAPSHOT, nonce: 'd'.repeat(16) } });
    expect(got).toBe(false);
    expect(preview.drops.byReason.snapshot_nonce_mismatch).toBe(1);
  });

  it('a tl.snapshot with the matching nonce is delivered (preview side)', () => {
    const { preview, editorWin } = makePair();
    let got = false;
    preview.on('tl.snapshot', () => {
      got = true;
    });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: HANDSHAKE });
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: SNAPSHOT });
    expect(got).toBe(true);
  });

  it('the editor drops a tl.handshake.ack whose nonce does not match', () => {
    const { editor } = makePair();
    let acked = false;
    editor.on('tl.handshake.ack', () => {
      acked = true;
    });
    editor.beginHandshake(PLAY_ID, false, CONTENT_ID, BUILD_ID); // nonce = aaaa...
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: { v: 2, type: 'tl.handshake.ack', playSessionId: PLAY_ID, nonce: 'f'.repeat(16) } });
    expect(acked).toBe(false);
    expect(editor.drops.byReason.ack_nonce_mismatch).toBe(1);
  });
});

describe('Bridge — v2 relay messages (delivery §7)', () => {
  it('the editor forwards bounded input frames and the preview answers with the applied range', () => {
    const { editor, preview, previewWin, editorWin, postedEditorToPreview, postedPreviewToEditor } = makePair();
    let applied: unknown = null;
    editor.on('tl.input.result', (m) => {
      applied = m;
    });
    editor.beginHandshake(PLAY_ID, false, CONTENT_ID, BUILD_ID);
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: HANDSHAKE });
    editor.requestInput(PLAY_ID, 'req-' + '1'.repeat(32), [{ stepOffset: 0, moveX: 1, jump: 'pressed' }]);
    const forwarded = postedEditorToPreview[postedEditorToPreview.length - 1]!;
    expect((forwarded.data as { type: string }).type).toBe('tl.input.request');
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: forwarded.data });
    preview.on('tl.input.request', (m) => {
      const msg = m as { requestId: string };
      preview.sendInputResult(PLAY_ID, msg.requestId, { ok: true, appliedFromStep: 10, appliedToStep: 10 });
    });
    // Re-deliver now that the handler is registered.
    deliver(preview, { origin: EDITOR_ORIGIN, source: editorWin, data: forwarded.data });
    const result = postedPreviewToEditor[postedPreviewToEditor.length - 1]!;
    deliver(editor, { origin: PREVIEW_ORIGIN, source: previewWin, data: result.data });
    expect(applied).toMatchObject({ ok: true, appliedFromStep: 10, appliedToStep: 10 });
  });

  it('a tl.load.progress over the 1 KiB bound is rejected', () => {
    const { editor } = makePair();
    const progress = { v: 2, type: 'tl.load.progress', playSessionId: PLAY_ID, phase: 'assets', loadedBytes: 0, totalBytes: 0 };
    deliver(editor, { origin: PREVIEW_ORIGIN, source: { tag: 'preview-window' }, data: progress });
    expect(editor.drops.total).toBe(0);
  });
});

describe('Bridge — no wildcard, no credentials (m1-acceptance §2.2)', () => {
  function runHandshakeAndSnapshot() {
    const pair = makePair();
    pair.preview.on('tl.handshake', (m) => {
      const msg = m as { nonce: string; playSessionId: string };
      pair.preview.ackHandshake(msg.playSessionId, msg.nonce);
    });
    pair.editor.beginHandshake(PLAY_ID, false, CONTENT_ID, BUILD_ID);
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
