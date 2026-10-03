/**
 * The preview's answer to a screenshot relay. It always answers:
 * a capture that fails or throws becomes `screenshot_failed` (or the
 * adapter's own code) with the reason, never a missing reply that the
 * backend can only report as `screenshot_timeout`.
 *
 * The answer also stays inside the relay's bounds: the bridge refuses an
 * error message over 256 characters, and every hop refuses a data URL over
 * the screenshot bound. A PNG over the bound is captured again at a smaller
 * width (the answer reports the width it has); at the smallest width (the
 * request's lower maxWidth bound) it is an error.
 *
 * A renderer that has not drawn its first frame yet (WebGPU starts
 * asynchronously, so a Play reads `running` before it draws) is waited for
 * within the time the relay allows (`answerScreenshotWhenDrawn`), so a
 * capture asked right after Play starts gets that frame.
 */

import { SCREENSHOT_DATA_URL_MAX, SCREENSHOT_MAX_WIDTH_MIN } from '@thirdlight/protocol';
import { RENDER_NOT_READY } from '@thirdlight/three-adapter';

/** The bridge's error message bound. */
const MESSAGE_MAX = 256;

export type CaptureOutcome =
  | { ok: true; result: { dataUrl: string; width: number; height: number } }
  | { ok: false; error: { code: string; message: string } };

export type ScreenshotAnswer =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; error: { code: string; message: string } };

function clip(message: string): string {
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message;
}

function failed(code: string, message: string): ScreenshotAnswer {
  return { ok: false, error: { code: code.slice(0, 128) || 'screenshot_failed', message: clip(message) } };
}

/**
 * Capture with `capture(maxWidth)` (null: no renderer to capture from) and
 * turn the outcome into the relay answer.
 */
export function answerScreenshot(capture: ((maxWidth: number) => CaptureOutcome) | null, maxWidth: number, dataUrlMax = SCREENSHOT_DATA_URL_MAX): ScreenshotAnswer {
  if (capture === null) return failed('not_ready', 'the play has no renderer to capture from yet');
  let width = maxWidth;
  for (;;) {
    let shot: CaptureOutcome;
    try {
      shot = capture(width);
    } catch (e) {
      return failed('screenshot_failed', `the capture threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    if (!shot.ok) return failed(shot.error.code, shot.error.message);
    const { dataUrl, width: w, height: h } = shot.result;
    if (dataUrl.length <= dataUrlMax) return { ok: true, dataUrl, width: w, height: h };
    if (w <= SCREENSHOT_MAX_WIDTH_MIN) {
      return failed('screenshot_failed', `the PNG is ${dataUrl.length} characters at ${w} pixels wide, over the ${dataUrlMax}-character bound`);
    }
    // PNG size grows about with the pixel count: shrink by the square root of the excess, with a margin.
    const next = Math.max(SCREENSHOT_MAX_WIDTH_MIN, Math.floor(w * Math.sqrt(dataUrlMax / dataUrl.length) * 0.9));
    width = Math.min(next, w - 1);
  }
}

/** How often a capture is tried again while the renderer starts (about a frame). */
const DRAWN_POLL_MS = 16;

/**
 * `answerScreenshot`, asked again while the renderer has not drawn its first
 * frame, until `withinMs` passed or `alive` turns false (the play stopped);
 * then the last answer stands.
 */
export async function answerScreenshotWhenDrawn(capture: ((maxWidth: number) => CaptureOutcome) | null, maxWidth: number, withinMs: number, alive: () => boolean, dataUrlMax = SCREENSHOT_DATA_URL_MAX): Promise<ScreenshotAnswer> {
  const end = performance.now() + withinMs;
  for (;;) {
    const answer = answerScreenshot(capture, maxWidth, dataUrlMax);
    if (answer.ok || answer.error.code !== RENDER_NOT_READY || !alive() || performance.now() >= end) return answer;
    await new Promise((r) => setTimeout(r, Math.min(DRAWN_POLL_MS, Math.max(0, end - performance.now()))));
  }
}

/** Draw the page's UI over a captured frame (a PNG data URL of the same size). */
export type OverlayDrawer = (frame: { readonly dataUrl: string; readonly width: number; readonly height: number }) => Promise<string>;

/**
 * `answerScreenshotWhenDrawn`, with the page's UI and overlays drawn over
 * the frame by `overlay`. A picture over the bound is captured again
 * smaller, as a frame alone is; a drawing that fails says why.
 */
export async function answerScreenshotWithOverlay(capture: ((maxWidth: number) => CaptureOutcome) | null, overlay: OverlayDrawer, maxWidth: number, withinMs: number, alive: () => boolean, dataUrlMax = SCREENSHOT_DATA_URL_MAX): Promise<ScreenshotAnswer> {
  let frame = await answerScreenshotWhenDrawn(capture, maxWidth, withinMs, alive, dataUrlMax);
  for (;;) {
    if (!frame.ok) return frame;
    let dataUrl: string;
    try {
      dataUrl = await overlay(frame);
    } catch (e) {
      return failed('screenshot_failed', `the UI over the frame could not be drawn: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    if (dataUrl.length <= dataUrlMax) return { ok: true, dataUrl, width: frame.width, height: frame.height };
    if (frame.width <= SCREENSHOT_MAX_WIDTH_MIN) return failed('screenshot_failed', `the PNG with its UI is ${dataUrl.length} characters at ${frame.width} pixels wide, over the ${dataUrlMax}-character bound`);
    const next = Math.max(SCREENSHOT_MAX_WIDTH_MIN, Math.floor(frame.width * Math.sqrt(dataUrlMax / dataUrl.length) * 0.9));
    frame = answerScreenshot(capture, Math.min(next, frame.width - 1), dataUrlMax);
  }
}
