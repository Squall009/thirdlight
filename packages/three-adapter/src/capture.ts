/**
 * The view's pictures: a bounded PNG of a freshly drawn frame (the session
 * screenshot) and a save slot's downscaled picture. Both draw their own frame
 * and read it back in the same task.
 */
import { adapterError, type AdapterError } from './errors';

export interface ScreenshotResult {
  /** Base64 PNG data URL (same-origin canvas). */
  dataUrl: string;
  width: number;
  height: number;
  /** Approximate decoded PNG byte size (for the ≤ 1 MiB session bound). */
  byteSize: number;
}

const DEFAULT_SCREENSHOT_MAX_WIDTH = 1024;

/** What a thrown value says, for a capture failure's message (clipped by adapterError). */
function reasonOf(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** The canvas surface a capture reads (duck-typed, like the adapter's). */
export interface CaptureCanvas {
  toDataURL?: (type?: string) => string;
  width?: number;
  height?: number;
}

export interface FrameCaptureDeps {
  readonly canvas: CaptureCanvas | null;
  /** Draw a frame now, even while a precompile holds presents. */
  readonly drawFrame: () => { ok: true } | { ok: false; error: AdapterError };
  /** The frame just asked for was skipped (the renderer still starting). */
  readonly skipped: () => boolean;
}

export function createFrameCapture({ canvas, drawFrame, skipped }: FrameCaptureDeps): {
  captureScreenshot(maxWidth?: number): { ok: true; result: ScreenshotResult } | { ok: false; error: AdapterError };
  captureThumbnail(width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number): { dataUrl: string; width: number; height: number } | null;
} {
  function captureScreenshot(maxWidth: number = DEFAULT_SCREENSHOT_MAX_WIDTH):
    | { ok: true; result: ScreenshotResult }
    | { ok: false; error: AdapterError } {
    // Argument validation FIRST (before any render attempt — no side
    // effects on a bad argument; observable in Node-side tests where the
    // render itself would be `render_unsupported`). The session layer
    // passes integers per sessions.md (default 1024, max 2048);
    // this is the adapter's defensive bound on its own argument.
    if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < 1) {
      return {
        ok: false,
        error: adapterError('screenshot_failed', 'captureScreenshot: maxWidth must be a positive integer (width bound)'),
      };
    }
    // A capture always answers — anything the frame or the read throws becomes
    // `screenshot_failed` with the reason (the relay would otherwise wait for its timeout).
    let frame: { ok: true } | { ok: false; error: AdapterError };
    try {
      frame = drawFrame();
    } catch (e) {
      return { ok: false, error: adapterError('screenshot_failed', `the frame for the capture failed: ${reasonOf(e)}`) };
    }
    if (!frame.ok) return { ok: false, error: frame.error };
    if (skipped()) return { ok: false, error: adapterError('render_failed', 'the renderer is still initialising; nothing is drawn yet') };
    if (typeof canvas?.toDataURL !== 'function') {
      return { ok: false, error: adapterError('screenshot_failed', 'canvas does not expose toDataURL()') };
    }
    let dataUrl: string;
    let w: number;
    let h: number;
    try {
      // Synchronous capture, the same on both backends: the frame is read back in the task
      // that drew it. WebGL 2: the drawing buffer is valid until the task ends (no
      // preserveDrawingBuffer needed). WebGPU: the canvas' current texture is
      // the drawing buffer until the browser presents it after this task, so the canvas
      // copy (and the downscale's drawImage) read this frame; checked pixel by pixel in
      // tests/e2e/screenshot.e2e.ts on a GPU and on headless (SwiftShader) WebGPU.
      dataUrl = canvas.toDataURL('image/png');
      w = Math.max(1, Math.floor(canvas.width ?? 0));
      h = Math.max(1, Math.floor(canvas.height ?? 0));
      if (w > maxWidth && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        // Downscale to ≤ maxWidth (the session bound in sessions.md).
        const off = document.createElement('canvas');
        const scale = maxWidth / w;
        off.width = maxWidth;
        off.height = Math.max(1, Math.round(h * scale));
        const ctx2d = off.getContext('2d');
        if (ctx2d) {
          ctx2d.drawImage(canvas as unknown as CanvasImageSource, 0, 0, off.width, off.height);
          dataUrl = off.toDataURL('image/png');
          w = off.width;
          h = off.height;
        }
      }
    } catch (e) {
      return { ok: false, error: adapterError('screenshot_failed', `PNG capture failed: ${reasonOf(e)}`) };
    }
    if (!dataUrl.startsWith('data:image/png;base64,')) {
      // e.g. `data:,` from a zero-sized canvas: not an image.
      return { ok: false, error: adapterError('screenshot_failed', `the canvas gave no PNG (${w}×${h} pixels)`) };
    }
    const prefix = 'data:image/png;base64,';
    const b64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl;
    const byteSize = Math.floor((b64.length / 4) * 3);
    return { ok: true, result: { dataUrl, width: w, height: h, byteSize } };
  }

  /**
   * A save slot's picture — draw a frame and scale it to cover
   * `width × height` (centred crop), encoded as JPEG/WebP (the browser falls
   * back to PNG for a type it cannot encode; the data URL says which).
   * Null when nothing is drawn yet or the page has no 2D canvas.
   */
  function captureThumbnail(width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number): { dataUrl: string; width: number; height: number } | null {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) return null;
    const frame = drawFrame();
    if (!frame.ok || skipped() || typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const sw = Math.max(1, Math.floor(canvas?.width ?? 0));
    const sh = Math.max(1, Math.floor(canvas?.height ?? 0));
    try {
      const off = document.createElement('canvas');
      off.width = width;
      off.height = height;
      const ctx2d = off.getContext('2d');
      if (ctx2d === null) return null;
      const scale = Math.max(width / sw, height / sh);
      const cw = width / scale;
      const ch = height / scale;
      ctx2d.drawImage(canvas as unknown as CanvasImageSource, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, width, height);
      return { dataUrl: off.toDataURL(type, Math.min(1, Math.max(0.1, quality))), width, height };
    } catch {
      return null;
    }
  }

  return { captureScreenshot, captureThumbnail };
}
