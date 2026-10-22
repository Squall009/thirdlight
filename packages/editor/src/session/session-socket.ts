/**
 * The session's WebSocket: the upgrade with its single-use token, the
 * heartbeat and the one client→server send path. What a frame means and
 * what a close does are the client's (the hooks).
 */

/** How often the client pings: at least every 20 s (the server drops a 60 s-silent connection). */
const HEARTBEAT_MS = 15_000;

export interface SessionSocketHooks {
  /** The socket opened (the heartbeat already runs). */
  opened(): void;
  message(raw: string): void;
  /** The socket closed (it is already released and its heartbeat stopped). */
  closed(ev: CloseEvent): void;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private heartbeatTimer: number | null = null;

  constructor(private readonly hooks: SessionSocketHooks) {}

  /** Upgrade to `url`; resolves when the socket opens, rejects when the upgrade fails. */
  open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.startHeartbeat();
        this.hooks.opened();
        resolve();
      };
      ws.onerror = () => reject(new Error('ws upgrade failed'));
      ws.onclose = (ev) => {
        this.ws = null;
        this.stopHeartbeat();
        this.hooks.closed(ev);
      };
      ws.onmessage = (ev) => this.hooks.message(ev.data as string);
    });
  }

  /**
   * A strict JSON text frame on the live socket. False when no live socket
   * exists (the caller treats a dropped frame as bounded by the session's
   * accepted timeouts — never a fabricated ack).
   */
  send(obj: unknown): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** A frame whose loss the backend times out itself (a relay answer, the selection). */
  sendUnchecked(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // the backend times the relay out
    }
  }

  /** Close for good (no close hook: the client is going away). */
  close(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'editor closed');
      this.ws = null;
    }
  }

  /** A WS `ping` while the socket is live (the server replies `pong`). */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
