/**
 * Packet 35/36 — the immutable runtime-content manifest and the scoped
 * play-content locator store (sessions.md §10.5/§17, export.md §2).
 *
 * Packet 36 makes this module a THIN consumer of the shared closure builder in
 * `@thirdlight/exporter` (`buildContentClosure`) — the SAME implementation the
 * export pipeline uses. There is one manifest/closure derivation for play and
 * export; this module owns only the play-specific wrapper (the prebuilt play
 * bundle as `game.js`) and the bounded in-memory artifact store:
 *
 * - `buildPlayContent` wraps the shared closure and appends `game.js`.
 * - `PlayContentStore` holds one immutable artifact set per play start and
 *   serves reads only through the exact §17.2.1 route set; a set is unreachable
 *   after `PLAY_CONTENT_TTL` (or `PLAY_CONTENT_GRACE` after a terminal play),
 *   and the contentId is a redacted secret-equivalent.
 * - `captureRuntimeContentManifest` is a compatibility adapter over
 *   `project-model`'s pure `captureManifest` (one assembler, no second copy).
 *
 * No authoritative or project write ever happens here; the artifact bytes are
 * buffered and bounded (512 MiB per set, 32 MiB per artifact) so a locator
 * read can never reach a project directory, a temp directory or a listing.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { PLAY_CONTENT_ARTIFACT_MAX_BYTES, PLAY_CONTENT_GRACE_SECONDS, PLAY_CONTENT_SET_MAX_BYTES, PLAY_CONTENT_TTL_SECONDS, type LocatorPath, type SessionError } from '@thirdlight/protocol';

/** SHA-256 (lowercase hex) of one byte string. */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function limitError(code: string, message: string, limit?: string, current?: number, max?: number): SessionError {
  return {
    code: code as SessionError['code'],
    cls: code === 'internal' ? 'internal' : 'validation',
    message: message.slice(0, 256),
    ...(limit !== undefined ? { limit } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

export interface PlayArtifact {
  /** The locator-relative path (the map key). */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly contentType: string;
}

export interface PlayContentSet {
  readonly contentId: string;
  readonly playSessionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly snapshotId: string;
  readonly buildId: string;
  readonly contentDigest: string;
  readonly manifestBytes: Uint8Array;
  readonly artifacts: ReadonlyMap<string, PlayArtifact>;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  terminalAtMs: number | null;
}

export interface PlayContentStoreOptions {
  now?: () => number;
  ttlMs?: number;
  graceMs?: number;
  randomId?: () => string;
  maxSetBytes?: number;
  maxArtifactBytes?: number;
  /** The prune sweep interval (one timer for the whole store). */
  sweepMs?: number;
}

export interface PublishPlayContentInput {
  playSessionId: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  buildId: string;
  contentDigest: string;
  manifestBytes: Uint8Array;
  artifacts: ReadonlyArray<PlayArtifact>;
}

export type PublishPlayContentResult =
  | { ok: true; set: PlayContentSet; contentId: string }
  | { ok: false; error: SessionError };

export type PlayContentStatus = 'live' | 'grace' | 'expired';

/** 32 CSPRNG bytes as unpadded base64url (43 chars). */
export function randomContentId(): string {
  return base64Url(nodeRandomBytes(32));
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url of a byte string (sessions.md §17.2 `contentId`). */
export function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export class PlayContentStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly randomId: () => string;
  private readonly maxSetBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly sets = new Map<string, PlayContentSet>();
  private readonly byPlay = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Counters for the lifecycle/leak tests. */
  published = 0;
  pruned = 0;
  reads = 0;
  private disposed = false;

  constructor(opts: PlayContentStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? PLAY_CONTENT_TTL_SECONDS * 1000;
    this.graceMs = opts.graceMs ?? PLAY_CONTENT_GRACE_SECONDS * 1000;
    this.randomId = opts.randomId ?? randomContentId;
    this.maxSetBytes = opts.maxSetBytes ?? PLAY_CONTENT_SET_MAX_BYTES;
    this.maxArtifactBytes = opts.maxArtifactBytes ?? PLAY_CONTENT_ARTIFACT_MAX_BYTES;
    const sweepMs = opts.sweepMs ?? 30_000;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.prune(), sweepMs);
      // Never keep the process alive for the sweep (Node-only timer handle).
      (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Publish one immutable set (the play build's completion point). */
  publish(input: PublishPlayContentInput): PublishPlayContentResult {
    let total = input.manifestBytes.length;
    for (const a of input.artifacts) {
      if (a.bytes.length > this.maxArtifactBytes) {
        return {
          ok: false,
          error: limitError('play_build_unavailable', `artifact ${a.path} exceeds the single-artifact cap`, 'artifact_bytes', a.bytes.length, this.maxArtifactBytes),
        };
      }
      total += a.bytes.length;
    }
    if (total > this.maxSetBytes) {
      return {
        ok: false,
        error: limitError('play_build_unavailable', 'the artifact set exceeds the 512 MiB closure cap', 'closure_bytes', total, this.maxSetBytes),
      };
    }
    const nowMs = this.now();
    let contentId = this.randomId();
    while (this.sets.has(contentId)) contentId = this.randomId();
    const artifacts = new Map<string, PlayArtifact>();
    for (const a of input.artifacts) artifacts.set(a.path, a);
    const set: PlayContentSet = {
      contentId,
      playSessionId: input.playSessionId,
      projectId: input.projectId,
      revision: input.revision,
      snapshotId: input.snapshotId,
      buildId: input.buildId,
      contentDigest: input.contentDigest,
      manifestBytes: input.manifestBytes,
      artifacts,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      terminalAtMs: null,
    };
    this.sets.set(contentId, set);
    this.byPlay.set(input.playSessionId, contentId);
    this.published += 1;
    return { ok: true, set, contentId };
  }

  get(contentId: string): PlayContentSet | undefined {
    return this.sets.get(contentId);
  }

  /** The set issued for one play session (a play has at most one). */
  forPlay(playSessionId: string): PlayContentSet | undefined {
    const id = this.byPlay.get(playSessionId);
    return id === undefined ? undefined : this.sets.get(id);
  }

  /** Every live contentId (redaction sweeps; never a listing route). */
  allContentIds(): string[] {
    return [...this.sets.keys()];
  }

  /** The play became terminal: start the in-flight-read grace window. */
  markTerminal(playSessionId: string): void {
    const set = this.forPlay(playSessionId);
    if (set !== undefined && set.terminalAtMs === null) set.terminalAtMs = this.now();
  }

  /** `live` (TTL running), `grace` (terminal grace), `expired`. */
  status(set: PlayContentSet, nowMs = this.now()): PlayContentStatus {
    if (set.terminalAtMs !== null) {
      return nowMs <= set.terminalAtMs + this.graceMs ? 'grace' : 'expired';
    }
    return nowMs <= set.expiresAtMs ? 'live' : 'expired';
  }

  /** `Cache-Control: private, max-age=<remaining>, immutable` remaining seconds. */
  remainingMaxAge(set: PlayContentSet, nowMs = this.now()): number {
    const deadline =
      set.terminalAtMs !== null ? Math.min(set.expiresAtMs, set.terminalAtMs + this.graceMs) : set.expiresAtMs;
    return Math.max(0, Math.floor((deadline - nowMs) / 1000));
  }

  /** Resolve one locator path within a set (declared paths only). */
  artifactFor(set: PlayContentSet, locator: LocatorPath): PlayArtifact | undefined {
    this.reads += 1;
    switch (locator.kind) {
      case 'manifest':
        return { path: 'manifest.json', bytes: set.manifestBytes, digest: sha256HexBytes(set.manifestBytes), contentType: 'application/json; charset=utf-8' };
      case 'game':
        return set.artifacts.get('game.js');
      case 'asset':
        return set.artifacts.get(`content/${locator.assetId}/${locator.version}`);
      case 'asset-digest':
        return set.artifacts.get(`content/sha256/${locator.digest}`);
      case 'behavior':
        return set.artifacts.get(`behaviors/${locator.outputDigest}.js`);
      case 'scene':
        return set.artifacts.get(`scenes/${locator.sceneId}.json`);
      default:
        return undefined;
    }
  }

  /**
   * Drop sets whose deadline plus one extra TTL has passed (expired reads keep
   * resolving to `play_locator_expired` for a bounded retention window before
   * they become unknown).
   */
  prune(nowMs = this.now()): number {
    let dropped = 0;
    for (const [id, set] of this.sets) {
      const deadline =
        set.terminalAtMs !== null ? Math.min(set.expiresAtMs, set.terminalAtMs + this.graceMs) : set.expiresAtMs;
      if (deadline + this.ttlMs <= nowMs) {
        this.sets.delete(id);
        if (this.byPlay.get(set.playSessionId) === id) this.byPlay.delete(set.playSessionId);
        dropped += 1;
      }
    }
    this.pruned += dropped;
    return dropped;
  }

  /** Leak/accounting counters for the lifecycle tests. */
  counters(): { sets: number; plays: number; bytes: number; timers: number; published: number; pruned: number; reads: number } {
    let bytes = 0;
    for (const set of this.sets.values()) {
      bytes += set.manifestBytes.length;
      for (const a of set.artifacts.values()) bytes += a.bytes.length;
    }
    return {
      sets: this.sets.size,
      plays: this.byPlay.size,
      bytes,
      timers: this.sweepTimer === undefined ? 0 : 1,
      published: this.published,
      pruned: this.pruned,
      reads: this.reads,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.sets.clear();
    this.byPlay.clear();
  }
}

// ---- the play build (the shared closure + the prebuilt play bundle) ----------
