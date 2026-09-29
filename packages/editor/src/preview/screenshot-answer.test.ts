/**
 * The preview always answers a screenshot relay, inside the
 * relay's bounds (the bridge drops a message over 256 characters; the
 * backend refuses a data URL over 1 MiB).
 */
import { validateBridgePreviewToEditor } from '@thirdlight/protocol';
import { describe, expect, it } from 'vitest';

import { answerScreenshot, type CaptureOutcome } from './screenshot-answer';

const PLAY = `play-${'a'.repeat(32)}`;
const RELAY = `relay-${'b'.repeat(32)}`;
/** The answer as the bridge would carry it (it must pass the editor side's validator). */
const bridged = (a: ReturnType<typeof answerScreenshot>): ReturnType<typeof validateBridgePreviewToEditor> =>
  validateBridgePreviewToEditor({ v: 2, type: 'tl.screenshot.result', playSessionId: PLAY, relayId: RELAY, ...a });

const png = (chars: number): string => `data:image/png;base64,${'A'.repeat(chars)}`;

describe('answerScreenshot', () => {
  it('passes a capture through', () => {
    const a = answerScreenshot(() => ({ ok: true, result: { dataUrl: png(100), width: 512, height: 288 } }), 512);
    expect(a).toEqual({ ok: true, dataUrl: png(100), width: 512, height: 288 });
    expect(bridged(a).ok).toBe(true);
  });

  it('a capture that throws answers screenshot_failed with the reason, bounded for the bridge', () => {
    const a = answerScreenshot(() => {
      throw new TypeError(`cannot read the frame ${'x'.repeat(400)}`);
    }, 512);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.code).toBe('screenshot_failed');
    expect(a.error.message).toMatch(/^the capture threw: TypeError: cannot read the frame x+/);
    expect(a.error.message.length).toBeLessThanOrEqual(256);
    expect(bridged(a).ok).toBe(true);
  });

  it("a failed capture keeps the adapter's code and message", () => {
    const a = answerScreenshot(() => ({ ok: false, error: { code: 'render_failed', message: 'the renderer is still initialising; nothing is drawn yet' } }), 512);
    expect(a).toEqual({ ok: false, error: { code: 'render_failed', message: 'the renderer is still initialising; nothing is drawn yet' } });
  });

  it('no renderer ⇒ not_ready with a message', () => {
    const a = answerScreenshot(null, 512);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe('not_ready');
    expect(bridged(a).ok).toBe(true);
  });

  it('a PNG over the bound is captured again smaller; the answer reports the width it has', () => {
    const widths: number[] = [];
    // A fake PNG whose size grows with the pixel count (width² / 2 characters).
    const capture = (w: number): CaptureOutcome => {
      widths.push(w);
      return { ok: true, result: { dataUrl: png((w * w) / 2), width: w, height: Math.round(w * 0.5625) } };
    };
    const a = answerScreenshot(capture, 2048, 1_000_000);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.dataUrl.length).toBeLessThanOrEqual(1_000_000);
    expect(a.width).toBe(widths[widths.length - 1]);
    expect(widths[0]).toBe(2048);
    expect(widths.length).toBeGreaterThan(1);
    expect(a.width).toBeGreaterThan(1000);
  });

  it('still over the bound at the smallest width ⇒ screenshot_failed saying so', () => {
    let calls = 0;
    const a = answerScreenshot((w) => {
      calls += 1;
      return { ok: true, result: { dataUrl: png(2_000_000), width: w, height: w } };
    }, 1024);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.error.code).toBe('screenshot_failed');
      expect(a.error.message).toContain('over the 1048576-character bound');
    }
    expect(calls).toBeLessThan(20);
  });
});
