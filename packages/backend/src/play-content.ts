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

import {
  PLAY_CONTENT_ARTIFACT_MAX_BYTES,
  PLAY_CONTENT_GRACE_SECONDS,
  PLAY_CONTENT_SET_MAX_BYTES,
  PLAY_CONTENT_TTL_SECONDS,
  RUNTIME_CONTENT_MANIFEST_VERSION,
  RUNTIME_CONTENT_TYPE,
  type LocatorPath,
  type SessionError,
} from '@thirdlight/protocol';
import type {
  CaptureManifestResult as ModelCaptureManifestResult,
  ManifestAssetInput as ModelManifestAssetInput,
  ManifestBehaviorInput,
  RuntimeContentManifest,
} from '@thirdlight/project-model';
import {
  M2_ENGINE_PINS,
  M2_KNOWN_MODULE_IDS,
  buildContentClosure,
  buildOptionsRecordBytes,
  captureManifest,
  recipeDigestOf as modelRecipeDigestOf,
  requiredModuleIds as modelRequiredModuleIds,
  versionFactsDigest as modelVersionFactsDigest,
  type ContentClosureCompilerPort,
} from '@thirdlight/exporter';
import type { BehaviorCompiler } from '@thirdlight/behavior-build';
import type { WorkspaceService } from '@thirdlight/workspace';

export const RUNTIME_CONTENT_TYPE_VALUE = RUNTIME_CONTENT_TYPE;
export const MANIFEST_VERSION = RUNTIME_CONTENT_MANIFEST_VERSION;

/** SHA-256 (lowercase hex) of one byte string. */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `buildOptionsDigest` = SHA-256 of the canonical option-set record bytes. */
export const BUILD_OPTIONS_DIGEST = sha256HexBytes(buildOptionsRecordBytes());

/** One bounded session error (the store's limit refusals). */
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

/** The pinned engine table recorded in `enginePins` (ascending by `id`). */
export const ENGINE_PINS = M2_ENGINE_PINS;

/** The required-module IDs this snapshot's module set needs (ascending). */
export const KNOWN_MODULE_IDS = M2_KNOWN_MODULE_IDS;

export type { RuntimeContentManifest };

export interface ManifestAssetInput extends Omit<ModelManifestAssetInput, 'importRecipe'> {
  /** Optional here: the play capture carries precomputed digests. */
  importRecipe?: unknown;
  recipeDigest?: string;
  metricsDigest?: string;
}
export type ManifestModuleInput = { id: string; package: string; version: string; apiVersion: number };

export interface CaptureManifestInput {
  projectId: string;
  revision: number;
  /** UTC second at capture (project-model §7.2), e.g. `2026-09-19T10:00:00Z`. */
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  assets: readonly ManifestAssetInput[];
  behaviors: readonly ManifestBehaviorInput[];
  moduleIds: readonly string[];
  recipeVersions?: { 'gltf-glb': number; 'behavior-source': number };
}

export type CaptureManifestResult = ModelCaptureManifestResult;

/**
 * `captureManifest` (sessions.md §17.1.3 step 2) — compatibility adapter over
 * `project-model`'s pure `captureManifest`: the precomputed `sceneDigest`/
 * `contentDigest` and per-asset `recipeDigest`/`metricsDigest` are passed
 * through, so the assembled document is byte-identical to the packet-35
 * implementation (verified by `play-content.test.ts`).
 */
export function captureRuntimeContentManifest(input: CaptureManifestInput): CaptureManifestResult {
  return captureManifest({
    projectId: input.projectId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    sceneDigest: input.sceneDigest,
    contentDigest: input.contentDigest,
    assets: input.assets.map((a) => ({
      assetId: a.assetId,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipeDigest: a.recipeDigest ?? modelRecipeDigestOf(a.importRecipe),
      metricsDigest: a.metricsDigest ?? modelVersionFactsDigest(a),
    })),
    behaviors: input.behaviors,
    moduleIds: input.moduleIds,
    ...(input.recipeVersions !== undefined ? { recipeVersions: input.recipeVersions } : {}),
  });
}

/** `recipeDigest`/`metricsDigest` for one catalog asset version (§18.5). */
export function recipeDigestOf(importRecipe: unknown): string {
  return modelRecipeDigestOf(importRecipe);
}
export function metricsDigestOf(metrics: unknown): string {
  return modelVersionFactsDigest(metrics as { assetId: string; version: number; sourceDigest: string; sourceByteLength: number });
}

/** The required engine module ids for one captured scene (ascending). */
export const requiredModuleIds = modelRequiredModuleIds;

// ---- the artifact store -------------------------------------------------------

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

export interface BuildPlayContentInput {
  service: WorkspaceService;
  compiler: BehaviorCompiler;
  projectId: string;
  revision: number;
  capturedAt: string;
  demo: boolean;
  /** The captured scene block (`{schemaVersion, sceneId, revision, entities}`). */
  scene: { schemaVersion: number; sceneId: string; revision: number; entities: ReadonlyArray<Record<string, unknown>> };
  /** The prebuilt play bundle bytes served as `game.js`. */
  gameBundle: Uint8Array;
}

export interface BuiltPlayContent {
  manifest: RuntimeContentManifest;
  manifestBytes: Uint8Array;
  buildId: string;
  contentDigest: string;
  snapshotId: string;
  moduleIds: readonly string[];
  artifacts: readonly PlayArtifact[];
}

export type BuildPlayContentResult = { ok: true; built: BuiltPlayContent } | { ok: false; error: SessionError };

/**
 * Build the immutable play artifact set for one play start: the SHARED closure
 * (`buildContentClosure` — the same builder the export pipeline uses) plus the
 * prebuilt play bundle served as `game.js`.
 *
 * The build performs no authoritative write and never executes project source.
 */
export async function buildPlayContent(input: BuildPlayContentInput): Promise<BuildPlayContentResult> {
  const { service, compiler, projectId } = input;
  if (input.gameBundle.length > PLAY_CONTENT_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'play_build_unavailable',
        cls: 'unavailable',
        reason: 'game_bundle_bytes',
        message: 'the play bundle exceeds the single-artifact cap',
        hint: 'rebuild the preview bundle (workspace build script)',
      },
    };
  }
  const built = await buildContentClosure({
    service,
    compiler: compiler as unknown as ContentClosureCompilerPort,
    projectId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    demo: input.demo,
    scene: input.scene,
  });
  if (!built.ok) {
    return { ok: false, error: sessionErrorFromClosure(built.error) };
  }
  const closure = built.closure;
  const artifacts: PlayArtifact[] = [
    ...closure.assetArtifacts.map((a) => ({ path: a.path, bytes: a.bytes, digest: a.digest, contentType: a.contentType })),
    ...closure.behaviorArtifacts.map((a) => ({ path: a.path, bytes: a.bytes, digest: a.digest, contentType: a.contentType })),
  ];
  // The play locator additionally serves the per-(assetId, version) address
  // (§17.2.1): the same immutable bytes under `content/<assetId>/<version>`.
  // The manifest declares only the digest-addressed path; the export closure
  // therefore emits exactly one file per asset (no duplicate artifacts).
  for (const row of closure.manifest.assets) {
    const path = String(row['path']);
    const artifact = closure.assetArtifacts.find((a) => a.path === path);
    if (artifact === undefined) continue;
    artifacts.push({
      path: `content/${String(row['assetId'])}/${String(row['version'])}`,
      bytes: artifact.bytes,
      digest: artifact.digest,
      contentType: artifact.contentType,
    });
  }
  // The play-specific artifact: the prebuilt bundle.
  artifacts.push({
    path: 'game.js',
    bytes: input.gameBundle,
    digest: sha256HexBytes(input.gameBundle),
    contentType: 'text/javascript; charset=utf-8',
  });
  return {
    ok: true,
    built: {
      manifest: closure.manifest,
      manifestBytes: closure.manifestBytes,
      buildId: closure.buildId,
      contentDigest: closure.contentDigest,
      snapshotId: closure.snapshotId,
      moduleIds: closure.moduleIds,
      artifacts,
    },
  };
}

/** Surface a closure error as a session error (unchanged codes/reasons). */
function sessionErrorFromClosure(e: {
  code: string;
  cls: string;
  message: string;
  reason?: string;
  found?: string;
  expected?: string;
}): SessionError {
  return {
    code: e.code as SessionError['code'],
    cls: e.cls as SessionError['cls'],
    message: e.message.slice(0, 256),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    ...(e.found !== undefined ? { found: e.found } : {}),
    ...(e.expected !== undefined ? { expected: e.expected } : {}),
  };
}
