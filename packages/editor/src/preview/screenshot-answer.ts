/**
 * Phase 25.2: the preview's answer to a screenshot relay. It always answers:
 * a capture that fails or throws becomes `screenshot_failed` (or the
 * adapter's own code) with the reason, never a missing reply that the
 * backend can only report as `screenshot_timeout`.
 *
 * The answer also stays inside the relay's bounds, which would otherwise
 * drop it silently: the bridge refuses an error message over 256 characters,
 * and the backend refuses a data URL over 1 MiB (and a WS frame over
 * 1.5 MiB). A PNG over the bound is captured again at a smaller width (the
 * answer reports the width it has); at the smallest width it is an error.
 */

/** The backend's screenshot bound (`MAX_SCREENSHOT`, sessions.md §11.5): data URL characters. */
export const SCREENSHOT_DATA_URL_MAX = 1024 * 1024;
/** The smallest width a too-large capture is retried at (the MCP tool's lower maxWidth bound). */
export const SCREENSHOT_MIN_RETRY_WIDTH = 256;
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
    if (w <= SCREENSHOT_MIN_RETRY_WIDTH) {
      return failed('screenshot_failed', `the PNG is ${dataUrl.length} characters at ${w} pixels wide, over the ${dataUrlMax}-character bound`);
    }
    // PNG size grows about with the pixel count: shrink by the square root of the excess, with a margin.
    const next = Math.max(SCREENSHOT_MIN_RETRY_WIDTH, Math.floor(w * Math.sqrt(dataUrlMax / dataUrl.length) * 0.9));
    width = Math.min(next, w - 1);
  }
}
