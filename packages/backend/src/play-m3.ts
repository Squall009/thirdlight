/**
 * Packet 59 — the v3 play-content build (sessions.md §10/§17, delivery.md
 * §2/§3; B16/B19).
 *
 * `buildPlayContentM3` is the v3 counterpart of `buildPlayContent` (packet
 * 35/36, M2): it is a THIN consumer of the shared M3 closure builder
 * `buildContentClosureM3` in `@thirdlight/exporter` — the SAME implementation
 * the M3 export pipeline uses (packet 58). There is one v2
 * manifest/closure derivation for play and export; this module owns only the
 * play-specific artifact assembly (the manifest v2 document, the v3 scene, the
 * declared assets and the prebuilt M3 play bundle served as the entry).
 *
 * - The content is the captured v3 `scene` + `content` block (the single
 *   acknowledged envelope read — `readCapturedV3`), passed by the caller.
 * - The artifact set is served by the same manifest-version-agnostic
 *   `PlayContentStore` (the v2 manifest is opaque bytes to the locator).
 * - It FAILS CLOSED on the shared closure's closed error set (`blob_missing`,
 *   ...) and on a `scene.json` whose bytes
 *   do not re-hash to `manifest.sceneDigest` (a captured-state integrity check).
 *
 * No authoritative or project write ever happens here; the artifact bytes are
 * buffered and bounded so a locator read can never reach a project directory.
 */
import { PLAY_CONTENT_ARTIFACT_MAX_BYTES, type SessionError } from '@thirdlight/protocol';
import { buildContentClosureM3, type ContentClosureM3 } from '@thirdlight/exporter';
import type { RuntimeContentManifestV2 } from '@thirdlight/project-model';
import type { WorkspaceService } from '@thirdlight/workspace';
import type { BehaviorCompiler } from '@thirdlight/behavior-build';
import { sha256HexBytes, type PlayArtifact } from './play-content';

export interface BuildPlayContentM3Input {
  service: WorkspaceService;
  compiler: BehaviorCompiler;
  projectId: string;
  revision: number;
  capturedAt: string;
  /** The captured v3 scene block (`{schemaVersion, sceneId, revision, entities}`). */
  scene: { schemaVersion: number; sceneId: string; revision: number; entities: ReadonlyArray<Record<string, unknown>> };
  /** The captured v3 `content` block (assets/settings/behaviors/game). */
  content: Record<string, unknown>;
  /** The prebuilt M3 play bundle bytes served as the entry (`game.js`). */
  gameBundle: Uint8Array;
}

export interface BuiltPlayContentM3 {
  /** The runtime-content manifest v2 document. */
  manifest: RuntimeContentManifestV2;
  manifestBytes: Uint8Array;
  buildId: string;
  contentDigest: string;
  snapshotId: string;
  moduleIds: readonly string[];
  /** The immutable play artifact set (locator-relative paths). */
  artifacts: readonly PlayArtifact[];
}

export type BuildPlayContentM3Result = { ok: true; built: BuiltPlayContentM3 } | { ok: false; error: SessionError };

/** Surface a closure error as a session error (unchanged codes/reasons). */
function sessionErrorFromM3Closure(e: { code: string; cls: string; message: string; reason?: string }): SessionError {
  return {
    code: e.code as SessionError['code'],
    cls: e.cls as SessionError['cls'],
    message: e.message.slice(0, 256),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  };
}

/**
 * Build the immutable v3 play artifact set for one play start: the SHARED M3
 * closure (`buildContentClosureM3` — the same builder the export pipeline uses)
 * plus the prebuilt M3 play bundle served as `game.js`.
 *
 * The build performs no authoritative write and never executes project source.
 */
export async function buildPlayContentM3(input: BuildPlayContentM3Input): Promise<BuildPlayContentM3Result> {
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
  const built = await buildContentClosureM3({
    service,
    compiler: compiler as Parameters<typeof buildContentClosureM3>[0]['compiler'],
    projectId,
    revision: input.revision,
    capturedAt: input.capturedAt,
    scene: input.scene,
    content: input.content,
  });
  if (!built.ok) {
    return { ok: false, error: sessionErrorFromM3Closure(built.error) };
  }
  const closure: ContentClosureM3 = built.closure;

  // The v3 scene document bytes (the exact pretty-printed bytes the closure
  // emitted as `scene.json` and whose digest is `manifest.sceneDigest`) — a
  // captured-state integrity check, not a re-derivation.
  const sceneBytes = closure.sceneBytes;
  if (sha256HexBytes(sceneBytes) !== closure.manifest.sceneDigest) {
    return {
      ok: false,
      error: {
        code: 'play_build_unavailable',
        cls: 'internal',
        reason: 'scene_digest',
        message: 'the v3 scene bytes do not re-hash to the manifest sceneDigest',
      },
    };
  }

  const artifacts: PlayArtifact[] = [];
  // manifest.json (the runtime-content manifest v2 document; carries
  // sceneDigest for the bridge-delivered snapshot verification).
  artifacts.push({
    path: 'manifest.json',
    bytes: closure.manifestBytes,
    digest: sha256HexBytes(closure.manifestBytes),
    contentType: 'application/json; charset=utf-8',
  });
  // NOTE: no scene.json artifact — the v3 scene arrives through the
  // nonce-verified `tl.snapshot` bridge (the accepted §17.2.1 locator route set
  // has no scene route; the manifest's sceneDigest is the identity the preview
  // verifies the bridge snapshot against). The sceneBytes re-hash above is a
  // captured-state integrity check only.
  // The declared assets (at their manifest-declared digest-addressed path).
  for (const a of [...closure.assetArtifacts, ...closure.behaviorArtifacts]) {
    artifacts.push({ path: a.path, bytes: a.bytes, digest: a.digest, contentType: a.contentType });
  }
  // The M3 play entry: the prebuilt bundle served as game.js (the page
  // bootstrap's import target — the same role as the M2 game.js).
  artifacts.push({ path: 'game.js', bytes: input.gameBundle, digest: sha256HexBytes(input.gameBundle), contentType: 'text/javascript; charset=utf-8' });

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