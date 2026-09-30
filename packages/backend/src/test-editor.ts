/**
 * The play tests' stand-in for the editor page over the real WebSocket.
 */
import type { TestWs } from './test-helpers';

/** A stub editor: presents on play.started, acks stops, answers relays.
 *
 * NOTE: the pump owns ALL server→client traffic on the socket after
 * construction (it reads with `waitFor(() => true)`), so tests must use
 * `waitForEvent` / the collected arrays — a direct `ws.waitFor` on the
 * same socket would race the pump and starve it.
 */
export class FakeEditor {
  ws!: TestWs;
  started: Array<Record<string, unknown>> = [];
  stopRequests: Array<Record<string, unknown>> = [];
  screenshotRequests: Array<Record<string, unknown>> = [];
  diagnosticsRequests: Array<Record<string, unknown>> = [];
  stoppedEvents: Array<Record<string, unknown>> = [];
  /** Set when the stub sent play.preview.ready (the play is presented). */
  presentedFlag = false;
  presentOnStart = true;
  ackStops = true;
  screenshotReply: { ok: boolean; dataUrl?: string; width?: number; height?: number; error?: { code: string; message?: string } } | null = {
    ok: true,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    width: 256,
    height: 144,
  };
  diagnosticsReply: { ok: boolean; diagnostics?: unknown; error?: { code: string } } | null = {
    ok: true,
    diagnostics: { fps: 60, errorCount: 0 },
  };
  private pending: Array<{ type: string; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(ws: TestWs) {
    this.ws = ws;
    void (async () => {
      for (;;) {
        const m = await this.ws.waitFor(() => true, 30_000).catch(() => null);
        if (m === null) break;
        this.handle(m as Record<string, unknown>);
      }
    })();
  }

  /** Wait for a server→client event of `type` (collected by the pump). */
  waitForEvent(type: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const byType: Record<string, Array<Record<string, unknown>>> = {
      'play.started': this.started,
      'play.stop.request': this.stopRequests,
      'screenshot.request': this.screenshotRequests,
      'play.diagnostics.request': this.diagnosticsRequests,
      'play.stopped': this.stoppedEvents,
    };
    const arr = byType[type] ?? [];
    const existing = arr[arr.length - 1];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === resolve);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new Error(`FakeEditor timeout waiting for ${type}`));
      }, timeoutMs);
      this.pending.push({ type, resolve, reject, timer });
    });
  }

  /** Poll a predicate over the pump-collected state (the pump is the sole socket consumer). */
  waitUntil(pred: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        if (pred()) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('waitUntil timeout'));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  close(): void {
    this.ws.close();
  }

  private handle(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'play.started': {
        this.started.push(ev);
        if (this.presentOnStart) {
          this.ws.send({ type: 'play.preview.ready', playSessionId: ev.playSessionId });
          this.presentedFlag = true;
        }
        break;
      }
      case 'play.stop.request': {
        this.stopRequests.push(ev);
        if (this.ackStops) this.ws.send({ type: 'play.stopped.ack', playSessionId: ev.playSessionId });
        break;
      }
      case 'screenshot.request': {
        this.screenshotRequests.push(ev);
        const reply = this.screenshotReply;
        if (reply === null) break;
        if (reply.ok) {
          this.ws.send({
            type: 'screenshot.ack',
            relayId: ev.relayId,
            ok: true,
            dataUrl: reply.dataUrl,
            width: reply.width,
            height: reply.height,
          });
        } else {
          this.ws.send({ type: 'screenshot.ack', relayId: ev.relayId, ok: false, error: reply.error });
        }
        break;
      }
      case 'play.diagnostics.request': {
        this.diagnosticsRequests.push(ev);
        const reply = this.diagnosticsReply;
        if (reply === null) break;
        if (reply.ok) {
          this.ws.send({ type: 'play.diagnostics.ack', relayId: ev.relayId, ok: true, diagnostics: reply.diagnostics });
        } else {
          this.ws.send({ type: 'play.diagnostics.ack', relayId: ev.relayId, ok: false, error: reply.error });
        }
        break;
      }
      case 'play.stopped': {
        this.stoppedEvents.push(ev);
        break;
      }
      default:
        break;
    }
    // Resolve the first pending waiter for this event type (if any).
    const i = this.pending.findIndex((p) => p.type === ev.type);
    if (i !== -1) {
      const [w] = this.pending.splice(i, 1);
      if (w) {
        clearTimeout(w.timer);
        w.resolve(ev);
      }
    }
  }
}
