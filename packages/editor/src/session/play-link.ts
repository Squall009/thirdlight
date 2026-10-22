/**
 * The editor's side of one isolated play: the retained `play.started` (with
 * its snapshot, fetched over HTTP when it did not fit a frame) and the
 * preview's ready / progress frames, each sent at most as often as the
 * backend's present timeout needs.
 */

/** A play-start result. */
export interface PlayStartResult {
  playSessionId: string;
  /** The preview iframe base (the backend's preview origin). */
  playBase: string;
  snapshotId: string;
  revision: number;
  expiresAt: number;
  /** The immutable play-content locator (capability + build id). */
  playContent?: {
    contentId: string;
    buildId: string;
    path: string;
    manifestPath: string;
    expiresAt: string;
  };
}

export type ActivePlay = PlayStartResult & { snapshot: unknown };

/** A `play.started` frame as the socket carries it. */
export interface PlayStartedFrame {
  playSessionId: string;
  snapshot?: unknown;
  snapshotRef?: { path?: unknown; bytes?: unknown };
  playContent?: PlayStartResult['playContent'];
}

export interface PlayLinkHost {
  readonly projectId: string;
  readonly previewOrigin: string;
  get<T>(path: string): Promise<T>;
  send(frame: unknown): boolean;
  started(play: ActivePlay): void;
  stopped(reason: string): void;
  /** The snapshot could not be read: shown, and the play is stopped (`play.preview.failed`). */
  snapshotFailed(playSessionId: string, message: string): void;
}

/** At most one progress frame a second: the backend's present timeout counts from the last one. */
const PROGRESS_INTERVAL_MS = 1000;

export class PlayLink {
  private active: ActivePlay | null = null;
  /** The playSessionId the WS `play.preview.ready` was already sent for (sent exactly once per play session). */
  private readySentFor: string | null = null;
  private progressSent: { id: string; at: number } | null = null;

  constructor(private readonly host: PlayLinkHost) {}

  get current(): ActivePlay | null {
    return this.active;
  }

  /** A play this editor started: a new play session, so the ready send resets. */
  begin(r: PlayStartResult): void {
    this.active = { ...r, snapshot: null };
    this.readySentFor = null;
  }

  /** This editor stopped the play. */
  end(playSessionId: string): void {
    this.active = null;
    if (this.readySentFor === playSessionId) this.readySentFor = null;
  }

  /**
   * A `play.started` carries the snapshot inline, or — when it
   * does not fit one WebSocket frame (1 MiB) — a `snapshotRef` to fetch it by
   * from the play's snapshot route over HTTP. A failed fetch is shown and the
   * play is stopped (`play.preview.failed`), never left waiting.
   */
  async receiveStarted(m: PlayStartedFrame): Promise<void> {
    if (m.snapshot !== undefined || m.snapshotRef === undefined) {
      this.started({ ...m, snapshot: m.snapshot ?? null });
      return;
    }
    const path = typeof m.snapshotRef.path === 'string' ? m.snapshotRef.path : '';
    const expected = `/api/v1/projects/${this.host.projectId}/play/${m.playSessionId}/snapshot`;
    try {
      // Only this project's own play route (the reference never points elsewhere).
      if (path !== expected) throw new Error(`unexpected snapshot reference ${path.slice(0, 120)}`);
      const snapshot = await this.host.get<unknown>(path.slice('/api/v1'.length));
      this.started({ ...m, snapshot });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = `Play could not load the ${typeof m.snapshotRef.bytes === 'number' ? `${Math.round(m.snapshotRef.bytes / 1024)} KiB ` : ''}snapshot: ${status !== undefined ? `HTTP ${status}` : String((e as Error).message ?? e)}`;
      this.host.snapshotFailed(m.playSessionId, message);
    }
  }

  /** The backend stopped the play. */
  receiveStopped(reason: string): void {
    this.active = null;
    this.host.stopped(reason);
  }

  /** Send `play.preview.ready` exactly once per play session (idempotent per playSessionId). */
  ready(playSessionId: string): boolean {
    if (this.readySentFor === playSessionId) return true;
    const ok = this.host.send({ type: 'play.preview.ready', playSessionId });
    if (ok) this.readySentFor = playSessionId;
    return ok;
  }

  /** Tell the backend about load progress at most once a second; nothing after `ready`. */
  progress(playSessionId: string): boolean {
    if (this.readySentFor === playSessionId) return true;
    const now = Date.now();
    if (this.progressSent !== null && this.progressSent.id === playSessionId && now - this.progressSent.at < PROGRESS_INTERVAL_MS) return true;
    const ok = this.host.send({ type: 'play.preview.progress', playSessionId });
    if (ok) this.progressSent = { id: playSessionId, at: now };
    return ok;
  }

  private started(m: { playSessionId: string; snapshot: unknown; playContent?: PlayStartResult['playContent'] }): void {
    // The retained `play.started` (delivered once). The editor stores
    // it and, on the preview iframe load, hands it across the bridge.
    const base = this.active ?? ({} as PlayStartResult);
    this.active = {
      playSessionId: m.playSessionId,
      playBase: base.playBase ?? this.host.previewOrigin,
      snapshotId: base.snapshotId ?? '',
      revision: base.revision ?? 0,
      expiresAt: base.expiresAt ?? 0,
      // The play-content locator (contentId / buildId / path) is retained —
      // the preview bootstrap's handshake + `tl.playContent.expect` gate read
      // it from the onPlayStarted result.
      playContent: m.playContent ?? base.playContent,
      snapshot: m.snapshot,
    };
    this.host.started(this.active);
  }
}
