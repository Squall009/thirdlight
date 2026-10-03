/**
 * Restricted cross-origin message bridge (message version 2).
 *
 * The editor (authoring origin) and the play preview (a SEPARATE origin) talk
 * only through `postMessage` with the exhaustive allowlist. The
 * transport enforces, for EVERY received message (the
 * origin/source checks cannot be verified from the body):
 *   1. `event.origin === expectedOrigin` (exact string match; a wildcard
 *      `"*"` target is forbidden — we always post to the exact peer origin);
 *   2. `event.source` is the trusted peer window (the iframe's contentWindow
 *      on the editor side; the opener/parent on the preview side);
 *   3. the body parses and passes the strict v2 validator for the
 *      direction;
 *   4. the `tl.handshake` nonce is echoed correctly — a `tl.snapshot` whose
 *      nonce does not match the handshake is DROPPED.
 * Anything else is dropped and counted (never executed).
 *
 * A message this side refuses to send (its own validator says no) never
 * vanishes either: it is counted, and when it answers or asks for an answer
 * (a relay), the waiting side gets an error answer naming the reason — the
 * peer for a refused answer, this side's own handlers for a refused request —
 * so the backend's waiting call answers instead of timing out.
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
  PLAY_PROBLEM_MESSAGE_MAX,
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

/** The error code of an answer that stands in for a message the bridge refused. */
export const BRIDGE_REFUSED_CODE = 'bridge_message_refused';
/** The bridge's error message bound. */
const ERROR_MESSAGE_MAX = 256;

/** Each relay request and the answer type its sender waits for (paired by relayId, or requestId for input). */
const ANSWER_OF: Readonly<Record<string, string>> = {
  'tl.input.request': 'tl.input.result',
  'tl.screenshot.request': 'tl.screenshot.result',
  'tl.diagnostics.request': 'tl.diagnostics.result',
  'tl.game.control': 'tl.game.control.result',
  'tl.game.observe': 'tl.game.observe.result',
  'tl.debug.request': 'tl.debug.result',
};
const ANSWER_TYPES: ReadonlySet<string> = new Set(Object.values(ANSWER_OF));

/**
 * The error answer of `type` (an answer type) for the relay `msg` names,
 * saying why the bridge refused the real message; null when `msg` has no
 * well-formed ids (then there is no waiting call to answer).
 */
function refusalAnswer(type: string, msg: Record<string, unknown>, refused: string, reason: string): Record<string, unknown> | null {
  const id = type === 'tl.input.result' ? 'requestId' : 'relayId';
  const text = `the bridge refused ${refused}: ${reason}`;
  const answer = {
    v: 2,
    type,
    playSessionId: msg['playSessionId'],
    [id]: msg[id],
    ok: false,
    error: { code: BRIDGE_REFUSED_CODE, message: text.length > ERROR_MESSAGE_MAX ? `${text.slice(0, ERROR_MESSAGE_MAX - 1)}…` : text },
  };
  return validateBridgePreviewToEditor(answer).ok ? answer : null;
}

function defaultNonce(): string {
  let s = '';
  for (let i = 0; i < NONCE_LEN; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** One bounded relay frame as the editor forwards it. */
export interface BridgeRelayFrame {
  stepOffset: number;
  /** Named input actions this step (frame version 2, no fixed move/jump channels). */
  actions?: Readonly<Record<string, { v: number; x?: number; y?: number; p: 'none' | 'pressed' | 'held' | 'released' }>>;
  /** Run length, the pointer, a virtual standard gamepad and UI edges. */
  steps?: number;
  pointer?: unknown;
  gamepad?: { buttons?: number[]; axes?: number[] };
  ui?: string[];
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

  /** Forward one bounded input-exercise sequence (editor side). */
  requestInput(playSessionId: string, requestId: string, frames: readonly BridgeRelayFrame[], restart = false, hold = false): void {
    if (this.direction !== 'editor') throw new Error('requestInput is editor-side only');
    // `restart` restarts the game first (the frames begin at the new run's first step).
    // `hold` holds the game right after the last step (until the next exercise).
    this.postLocal({ v: 2, type: 'tl.input.request', playSessionId, requestId, frames: frames.map((f) => ({ ...f })), ...(restart ? { restart: true } : {}), ...(hold ? { hold: true } : {}) });
  }

  /** Request a bounded screenshot (editor side). */
  requestScreenshot(playSessionId: string, relayId: string, maxWidth?: number, answerWithinMs?: number, ui?: boolean): void {
    if (this.direction !== 'editor') throw new Error('requestScreenshot is editor-side only');
    this.postLocal({ v: 2, type: 'tl.screenshot.request', playSessionId, relayId, maxWidth, ...(answerWithinMs !== undefined ? { answerWithinMs } : {}), ...(ui === false ? { ui: false } : {}) });
  }

  /** Forward a game control command (editor side). */
  requestGameControl(playSessionId: string, relayId: string, command: string, sceneId?: string, debug?: { name: string; args: Record<string, unknown> }, answerWithinMs?: number): void {
    if (this.direction !== 'editor') throw new Error('requestGameControl is editor-side only');
    // A debug command carries its name and arguments; a replay how long its answer may wait for the restart.
    this.postLocal({ v: 2, type: 'tl.game.control', playSessionId, relayId, command, ...(sceneId !== undefined ? { sceneId } : {}), ...(debug !== undefined ? { name: debug.name, args: debug.args } : {}), ...(command === 'replay' && answerWithinMs !== undefined ? { answerWithinMs } : {}) });
  }

  /** Request a game observation (editor side). */
  requestGameObserve(playSessionId: string, relayId: string, entityId?: string): void {
    if (this.direction !== 'editor') throw new Error('requestGameObserve is editor-side only');
    // `entityId` adds that entity's script property values.
    this.postLocal({ v: 2, type: 'tl.game.observe', playSessionId, relayId, ...(entityId !== undefined ? { entityId } : {}) });
  }

  /** Reply to a game control/observe request (preview side). */
  sendGameResult(
    kind: 'control' | 'observe',
    playSessionId: string,
    relayId: string,
    body: { ok: true; result: unknown } | { ok: false; error: { code: string; message?: string } },
  ): void {
    if (this.direction !== 'preview') throw new Error('sendGameResult is preview-side only');
    this.postLocal({ v: 2, type: kind === 'control' ? 'tl.game.control.result' : 'tl.game.observe.result', playSessionId, relayId, ...body });
  }

  /**
   * The visual-script debugger's poll (editor side): the behavior
   * (and object) it watches, its breakpoints and an optional pause / resume /
   * step. The preview answers from the running game (`tl.debug.result`).
   */
  requestDebug(playSessionId: string, relayId: string, body: { behaviorId: string; entityId?: string; breakpoints: readonly string[]; command?: 'pause' | 'resume' | 'step' }): void {
    if (this.direction !== 'editor') throw new Error('requestDebug is editor-side only');
    this.postLocal({
      v: 2,
      type: 'tl.debug.request',
      playSessionId,
      relayId,
      behaviorId: body.behaviorId,
      ...(body.entityId !== undefined ? { entityId: body.entityId } : {}),
      breakpoints: [...body.breakpoints],
      ...(body.command !== undefined ? { command: body.command } : {}),
    });
  }

  /** Answer a debug request (preview side). */
  sendDebugResult(playSessionId: string, relayId: string, body: { ok: true; result: unknown } | { ok: false; error: { code: string; message?: string } }): void {
    if (this.direction !== 'preview') throw new Error('sendDebugResult is preview-side only');
    this.postLocal({ v: 2, type: 'tl.debug.result', playSessionId, relayId, ...body });
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

  /** Report the preview is ready (preview side, v2). */
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

  /** Report a problem of the running game for its author's Problems log (preview side; once per kind). */
  sendProblem(playSessionId: string, code: string, message: string): void {
    if (this.direction !== 'preview') throw new Error('sendProblem is preview-side only');
    this.postLocal({ v: 2, type: 'tl.play.problem', playSessionId, code, message: message.slice(0, PLAY_PROBLEM_MESSAGE_MAX) });
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
    if (verdict.ok) {
      this.post(msg, this.targetOrigin);
      return;
    }
    // A refused message is never posted, and never dropped without a word.
    const type = String(msg['type']);
    this.drop(`refused:${type}:${verdict.reason}`);
    const awaited = ANSWER_OF[type];
    if (awaited !== undefined) {
      // A refused request: this side's own handlers get the error answer (the editor acks the backend with it).
      const answer = refusalAnswer(awaited, msg, type, verdict.reason);
      if (answer !== null) this.dispatch(awaited, answer, { origin: this.expectedOrigin, source: null, data: answer });
    } else if (ANSWER_TYPES.has(type)) {
      // A refused answer: the peer gets an error answer in its place.
      const answer = refusalAnswer(type, msg, type, verdict.reason);
      if (answer !== null) this.post(answer, this.targetOrigin);
    }
  }

  /**
   * Handle one inbound `message` event. Enforces the transport checks
   * (origin + source) and the body validation + nonce. Drops (and
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
    // 4. Strict validation for THIS direction's receive allowlist.
    const verdict =
      this.direction === 'editor'
        ? validateBridgePreviewToEditor(body)
        : validateBridgeEditorToPreview(body);
    if (!verdict.ok) {
      this.drop(`invalid:${verdict.reason}`);
      // An answer from the trusted peer that fails validation still answers its relay: the
      // waiting call gets the reason instead of a timeout.
      const refusedType = String(body['type']);
      if (this.direction === 'editor' && ANSWER_TYPES.has(refusedType)) {
        const answer = refusalAnswer(refusedType, body, refusedType, verdict.reason);
        if (answer !== null) this.dispatch(refusedType, answer, event);
      }
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
