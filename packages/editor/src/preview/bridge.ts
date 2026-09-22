/**
 * Restricted cross-origin message bridge (sessions.md §13; packet 10; M2 v2 by
 * packet 35 — delivery.md §7, sessions.md §17.6).
 *
 * The editor (authoring origin) and the play preview (a SEPARATE origin) talk
 * only through `postMessage` with the exhaustive §13.5 allowlist. The
 * transport enforces, for EVERY received message (sessions.md §13.3 — the
 * origin/source checks cannot be verified from the body):
 *   1. `event.origin === expectedOrigin` (exact string match; a wildcard
 *      `"*"` target is forbidden — we always post to the exact peer origin);
 *   2. `event.source` is the trusted peer window (the iframe's contentWindow
 *      on the editor side; the opener/parent on the preview side);
 *   3. the body parses and passes the §13.5 strict v2 validator for the
 *      direction;
 *   4. the `tl.handshake` nonce is echoed correctly — a `tl.snapshot` whose
 *      nonce does not match the handshake is DROPPED.
 * Anything else is dropped and counted (never executed).
 *
 * The bridge CARRIES NO CREDENTIALS: the page config is
 * `{ v, authoringOrigin, playSessionId, contentId, manifestPath }`; the
 * authoring token and the authoring API URL are never sent across the bridge
 * and never embedded in the preview bundle. `contentId` is a read-only
 * artifact capability, redacted in logs but not an authoring credential.
 *
 * The `post` and the message source check are INJECTED so this module is
 * unit-testable without a browser/DOM.
 */

import {
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
  type BridgeEditorToPreviewType,
  type BridgePreviewToEditorType,
} from '@thirdlight/protocol';

/** A raw `message` event (the injectable transport hands us this shape). */
export interface BridgeMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The injectable `postMessage` (the real one: `win.postMessage(data, origin)`). */
export type PostFn = (data: unknown, targetOrigin: string) => void;

export type BridgeDirection = 'editor' | 'preview';

export interface BridgeOptions {
  /** Which side this instance is (selects the receive allowlist + nonce role). */
  direction: BridgeDirection;
  /** The peer's exact origin — received messages from any other origin drop. */
  expectedOrigin: string;
  /** The exact origin to post TO (never `"*"`). */
  targetOrigin: string;
  /** Injected `postMessage`. */
  post: PostFn;
  /** Trust check on `event.source` (iframe contentWindow / opener). */
  isTrustedSource: (source: unknown) => boolean;
  /** Nonce generator (16 lowercase hex). Injectable for tests. */
  makeNonce?: () => string;
}

export type Handler<T = unknown> = (payload: T, event: BridgeMessageEvent) => void;

/** Drop accounting (for diagnostics / the "drop counters" evidence). */
export interface DropStats {
  total: number;
  byReason: Record<string, number>;
}

const NONCE_LEN = 16;

function defaultNonce(): string {
  let s = '';
  for (let i = 0; i < NONCE_LEN; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** One bounded relay frame as the editor forwards it (§18.1.1). */
export interface BridgeRelayFrame {
  stepOffset: number;
  moveX: number;
  jump: string;
}

/**
 * One end of the bridge. Construct one per side; the two ends share the
 * `expectedOrigin`/`targetOrigin` pair (each side's expectedOrigin is the
 * other's targetOrigin).
 */
export class Bridge {
  readonly direction: BridgeDirection;
  private readonly expectedOrigin: string;
  private readonly targetOrigin: string;
  private readonly post: PostFn;
  private readonly isTrustedSource: (source: unknown) => boolean;
  private readonly makeNonce: () => string;
  private readonly handlers = new Map<string, Handler[]>();

  /** The editor's handshake nonce (editor side) / the nonce seen in
   *  `tl.handshake` (preview side). */
  private editorNonce: string | null = null;
  /** The nonce the preview expects on `tl.snapshot` (set on `tl.handshake`). */
  private snapshotNonce: string | null = null;
  private previewPlayId: string | null = null;

  readonly drops: DropStats = { total: 0, byReason: {} };

  constructor(opts: BridgeOptions) {
    this.direction = opts.direction;
    this.expectedOrigin = opts.expectedOrigin;
    this.targetOrigin = opts.targetOrigin;
    this.post = opts.post;
    this.isTrustedSource = opts.isTrustedSource;
    this.makeNonce = opts.makeNonce ?? defaultNonce;
  }

  /** Register a handler for an inbound bridge type. */
  on(type: string, handler: Handler): void {
    const arr = this.handlers.get(type) ?? [];
    arr.push(handler);
    this.handlers.set(type, arr);
  }

  /** Generate + remember the editor's handshake nonce (editor side only). */
  beginHandshake(playSessionId: string, demo: boolean, contentId: string, buildId: string): string {
    if (this.direction !== 'editor') throw new Error('beginHandshake is editor-side only');
    const nonce = this.makeNonce();
    this.editorNonce = nonce;
    this.postLocal({ v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId, nonce, demo, contentId, buildId });
    return nonce;
  }

  /** Send the snapshot to the preview (editor side, post-handshake). */
  sendSnapshot(playSessionId: string, snapshot: unknown): void {
    if (this.direction !== 'editor') throw new Error('sendSnapshot is editor-side only');
    const nonce = this.editorNonce ?? this.makeNonce();
    this.postLocal({ v: 2, type: 'tl.snapshot', playSessionId, nonce, snapshot });
  }

  /** Tell the preview which content build it must load (editor side, once). */
  sendPlayContentExpect(playSessionId: string, contentId: string, buildId: string): void {
    if (this.direction !== 'editor') throw new Error('sendPlayContentExpect is editor-side only');
    this.postLocal({ v: 2, type: 'tl.playContent.expect', playSessionId, contentId, buildId });
  }

  /** Forward one bounded input-exercise sequence (editor side, §18.1). */
  requestInput(playSessionId: string, requestId: string, frames: readonly BridgeRelayFrame[]): void {
    if (this.direction !== 'editor') throw new Error('requestInput is editor-side only');
    this.postLocal({ v: 2, type: 'tl.input.request', playSessionId, requestId, frames: frames.map((f) => ({ ...f })) });
  }

  /** Request a bounded screenshot (editor side). */
  requestScreenshot(playSessionId: string, relayId: string, maxWidth?: number): void {
    if (this.direction !== 'editor') throw new Error('requestScreenshot is editor-side only');
    this.postLocal({ v: 2, type: 'tl.screenshot.request', playSessionId, relayId, maxWidth });
  }

  /** Request diagnostics (editor side). */
  requestDiagnostics(playSessionId: string, relayId: string): void {
    if (this.direction !== 'editor') throw new Error('requestDiagnostics is editor-side only');
    this.postLocal({ v: 2, type: 'tl.diagnostics.request', playSessionId, relayId });
  }

  /** Ask the preview to stop (editor side). */
  requestStop(playSessionId: string): void {
    if (this.direction !== 'editor') throw new Error('requestStop is editor-side only');
    this.postLocal({ v: 2, type: 'tl.play.stop', playSessionId });
  }

  /** Acknowledge the handshake (preview side; echoes the editor's nonce). */
  ackHandshake(playSessionId: string, nonce: string): void {
    if (this.direction !== 'preview') throw new Error('ackHandshake is preview-side only');
    this.postLocal({ v: 2, type: 'tl.handshake.ack', playSessionId, nonce });
  }

  /** Report the preview is ready (preview side, v2 — delivery §7). */
  sendReady(
    playSessionId: string,
    snapshotId: string,
    revision: number,
    buildId: string,
    contentDigest: string,
    stepIndex: number,
  ): void {
    if (this.direction !== 'preview') throw new Error('sendReady is preview-side only');
    this.postLocal({ v: 2, type: 'tl.ready', playSessionId, snapshotId, revision, buildId, contentDigest, stepIndex });
  }

  /** Report truthful load progress (preview side, ≤ 1 KiB). */
  sendLoadProgress(playSessionId: string, phase: string, loadedBytes: number, totalBytes: number): void {
    if (this.direction !== 'preview') throw new Error('sendLoadProgress is preview-side only');
    this.postLocal({ v: 2, type: 'tl.load.progress', playSessionId, phase, loadedBytes, totalBytes });
  }

  /** Report the applied range of one input-exercise relay (preview side). */
  sendInputResult(
    playSessionId: string,
    requestId: string,
    result:
      | { ok: true; appliedFromStep: number; appliedToStep: number }
      | { ok: false; error: { code: string; message?: string } },
  ): void {
    if (this.direction !== 'preview') throw new Error('sendInputResult is preview-side only');
    this.postLocal({ v: 2, type: 'tl.input.result', playSessionId, requestId, ...result });
  }

  /** Report the preview stopped (preview side). */
  sendStopped(playSessionId: string): void {
    if (this.direction !== 'preview') throw new Error('sendStopped is preview-side only');
    this.postLocal({ v: 2, type: 'tl.stopped', playSessionId });
  }

  /** Report a screenshot result (preview side). */
  sendScreenshotResult(
    playSessionId: string,
    relayId: string,
    result: { ok: true; dataUrl: string; width: number; height: number } | { ok: false; error: { code: string; message?: string } },
  ): void {
    if (this.direction !== 'preview') throw new Error('sendScreenshotResult is preview-side only');
    this.postLocal({ v: 2, type: 'tl.screenshot.result', playSessionId, relayId, ...result });
  }

  /** Report a diagnostics result (preview side). */
  sendDiagnosticsResult(
    playSessionId: string,
    relayId: string,
    result: { ok: true; diagnostics: unknown } | { ok: false; error: { code: string; message?: string } },
  ): void {
    if (this.direction !== 'preview') throw new Error('sendDiagnosticsResult is preview-side only');
    this.postLocal({ v: 2, type: 'tl.diagnostics.result', playSessionId, relayId, ...result });
  }

  /** Report a structured preview error (preview side; `phase` names the load phase). */
  sendError(playSessionId: string, code: string, message?: string, phase?: string): void {
    if (this.direction !== 'preview') throw new Error('sendError is preview-side only');
    this.postLocal({
      v: 2,
      type: 'tl.error',
      playSessionId,
      code,
      ...(phase !== undefined ? { phase } : {}),
      ...(message !== undefined ? { message: message.slice(0, 256) } : {}),
    });
  }

  /** Respond to a ping (preview side). */
  sendPong(): void {
    if (this.direction !== 'preview') throw new Error('sendPong is preview-side only');
    this.postLocal({ v: 2, type: 'tl.pong' });
  }

  /** Post a validated local message to the peer (never `"*"`). */
  private postLocal(msg: Record<string, unknown>): void {
    // Local validation before crossing the origin boundary (fail fast; the
    // peer re-validates independently).
    const verdict = this.direction === 'editor' ? validateBridgeEditorToPreview(msg) : validateBridgePreviewToEditor(msg);
    if (!verdict.ok) return; // a malformed local message is never posted
    this.post(msg, this.targetOrigin);
  }

  /**
   * Handle one inbound `message` event. Enforces the §13.3 transport checks
   * (origin + source) and the §13.5 body validation + nonce. Drops (and
   * counts) anything that fails.
   */
  handleMessage(event: BridgeMessageEvent): void {
    // 1. exact origin match (a wildcard is impossible: we compare equality).
    if (event.origin !== this.expectedOrigin) {
      this.drop('origin_mismatch');
      return;
    }
    // 2. trusted source (the peer window).
    if (!this.isTrustedSource(event.source)) {
      this.drop('source_untrusted');
      return;
    }
    // 3. the body must be a JSON object.
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
      this.drop('not_object');
      return;
    }
    const body = event.data as Record<string, unknown>;
    // 4. §13.5 strict validation for THIS direction's receive allowlist.
    const verdict =
      this.direction === 'editor'
        ? validateBridgePreviewToEditor(body)
        : validateBridgeEditorToPreview(body);
    if (!verdict.ok) {
      this.drop(`invalid:${verdict.reason}`);
      return;
    }
    const type = body.type as string;

    // 5. Nonce enforcement.
    if (this.direction === 'preview') {
      if (type === 'tl.handshake') {
        this.snapshotNonce = body.nonce as string;
        this.previewPlayId = body.playSessionId as string;
        this.dispatch(type, body, event);
        return;
      }
      if (type === 'tl.snapshot') {
        if (this.snapshotNonce === null || body.nonce !== this.snapshotNonce) {
          this.drop('snapshot_nonce_mismatch');
          return;
        }
        this.dispatch(type, body, event);
        return;
      }
      // other preview-received types (stop/screenshot/diag/input/ping): allowlisted,
      // no nonce gate beyond the validator.
      this.dispatch(type, body, event);
      return;
    }
    // editor side
    if (type === 'tl.handshake.ack') {
      if (this.editorNonce === null || body.nonce !== this.editorNonce) {
        this.drop('ack_nonce_mismatch');
        return;
      }
      this.dispatch(type, body, event);
      return;
    }
    this.dispatch(type, body, event);
  }

  private dispatch(type: string, body: unknown, event: BridgeMessageEvent): void {
    const arr = this.handlers.get(type);
    if (!arr) return;
    for (const h of arr) h(body, event);
  }

  private drop(reason: string): void {
    this.drops.total += 1;
    this.drops.byReason[reason] = (this.drops.byReason[reason] ?? 0) + 1;
  }
}

// Re-export the allowlist type helpers for the preview bootstrap.
export type { BridgeEditorToPreviewType, BridgePreviewToEditorType };
