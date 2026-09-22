/**
 * Migration copy — workspace.md §14: M1 project → M2 project.
 *
 * Explicit, operator-driven and non-destructive. The source project is read
 * (never claimed, released, rewritten or touched) and the destination is a
 * **new** project written destination-first, authoritative-last:
 *
 *   1. `mkdir <dest>`, `mkdir <dest>/.thirdlight`
 *   2. write `.thirdlight/migration.json` (marker; `phase` = last completed step)
 *   3. write the destination manifest via `W`
 *   4. copy every source blob via `W` (M1 sources have none today)
 *   5. **write the destination envelope last** (the commit point)
 *   6. remove the marker — the destination is reported complete only after this
 *
 * A directory carrying a valid marker and no envelope is an interrupted
 * migration destination: the §8.3 deterministic default-envelope completion is
 * suppressed for it (the startup scan reports it; §8.3/§10), and the operator
 * resumes `migrateProjectCopy` or deletes the directory.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ContentCatalog,
  ContentCatalogV3,
  Manifest,
  Scene,
  SceneV2,
  SceneV3,
} from '@thirdlight/project-model';
import {
  migrateSceneV1ToV2,
  migrateSceneV3,
  normalizeManifest,
  serializeCanonical,
  validateContentV3,
  validateProjectV3,
  validateSceneV2,
  validateSceneV3,
} from '@thirdlight/project-model';

import { sha256Hex } from './digest';
import { emptyContent, sourcesDir, verifyArtifactDir } from './content-store';
import {
  contentPublishFailed,
  migrationDestinationExists,
  migrationMarkerConflict,
  migrationSourceInvalid,
  migrationVersionUnsupported,
  pathRejected,
  type LoadDetail,
} from './errors';
import type { CommandError } from '@thirdlight/commands';
import {
  buildEnvelopeBytesV2,
  buildEnvelopeBytesV3,
  ID_RE,
} from './envelope';
import { evaluateLiveness, readOwnershipRecord } from './ownership';
import { loadManifest, loadProjectDir, resolveProjectDir, type Core } from './session';
import { writeAtomic } from './write';

/** The accepted v2 marker (workspace.md §14.3 step 2). */
export interface MigrationMarker {
  storageVersion: 1;
  type: 'migration-copy';
  sourceProjectId: string;
  newProjectId: string;
  phase: MigrationPhase;
  startedAt: string;
}

/** The v3 marker (workspace.md §16.5.3 step 2): same fields plus the copy's
 * `sourceVersion`/`newVersion` pair, which the resume path must match. */
export interface MigrationMarkerV3 {
  storageVersion: 3;
  type: 'migration-copy';
  sourceProjectId: string;
  newProjectId: string;
  sourceVersion: 2;
  newVersion: 3;
  phase: MigrationPhase;
  startedAt: string;
}

/** A marker of either known version (the startup scan reports both). */
export type AnyMigrationMarker = MigrationMarker | MigrationMarkerV3;
export type MigrationPhase = 'created' | 'manifest' | 'blobs' | 'envelope';

export interface MigrationResultOk {
  ok: true;
  sourceProjectId: string;
  newProjectId: string;
  sourceRevision: number;
  newRevision: 0;
  revisionPolicy: 'reset-to-zero';
  historyReset: true;
  retryCleared: true;
  blobsCopied: number;
  resumed: boolean;
}
export type MigrationResult = MigrationResultOk | { ok: false; error: CommandError };

/** The §16.5.2 reported object of the v2→v3 copy. */
export interface MigrationResultV3Ok {
  ok: true;
  sourceProjectId: string;
  newProjectId: string;
  sourceRevision: number;
  newRevision: 0;
  revisionPolicy: 'reset-to-zero';
  historyReset: true;
  retryCleared: true;
  blobsCopied: number;
  blobsAlreadyPresent: number;
  resumed: boolean;
  sourceVersion: 2;
  newVersion: 3;
}
export type MigrationResultV3 = MigrationResultV3Ok | { ok: false; error: CommandError };

/** workspace.md §16.7: migration copy wall clock ≤ 120 s. */
const MIGRATION_TIMEOUT_MS = 120_000;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const MARKER_REL = join('.thirdlight', 'migration.json');

function markerBytes(m: AnyMigrationMarker): Uint8Array {
  const doc =
    m.storageVersion === 3
      ? {
          storageVersion: 3,
          type: 'migration-copy',
          sourceProjectId: m.sourceProjectId,
          newProjectId: m.newProjectId,
          sourceVersion: 2,
          newVersion: 3,
          phase: m.phase,
          startedAt: m.startedAt,
        }
      : {
          storageVersion: 1,
          type: 'migration-copy',
          sourceProjectId: m.sourceProjectId,
          newProjectId: m.newProjectId,
          phase: m.phase,
          startedAt: m.startedAt,
        };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Read `.thirdlight/migration.json`. Both known marker versions are accepted
 * (workspace.md §10/§16.5.3): a v1 marker is the accepted M1→M2 destination, a
 * v3 marker the v2→v3 destination. Either suppresses the §8.3 default-envelope
 * completion. A malformed/unknown marker is `null` (not a valid marker).
 */
export function readMigrationMarker(destDir: string): AnyMigrationMarker | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(join(destDir, MARKER_REL)));
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as AnyMigrationMarker;
    if (v === null || typeof v !== 'object') return null;
    if (v.type !== 'migration-copy') return null;
    if (typeof v.sourceProjectId !== 'string' || typeof v.newProjectId !== 'string') return null;
    if (!['created', 'manifest', 'blobs', 'envelope'].includes(v.phase)) return null;
    if (v.storageVersion === 1) {
      return {
        storageVersion: 1,
        type: 'migration-copy',
        sourceProjectId: v.sourceProjectId,
        newProjectId: v.newProjectId,
        phase: v.phase,
        startedAt: typeof v.startedAt === 'string' ? v.startedAt : '',
      };
    }
    if (v.storageVersion === 3 && v.sourceVersion === 2 && v.newVersion === 3) {
      return {
        storageVersion: 3,
        type: 'migration-copy',
        sourceProjectId: v.sourceProjectId,
        newProjectId: v.newProjectId,
        sourceVersion: 2,
        newVersion: 3,
        phase: v.phase,
        startedAt: typeof v.startedAt === 'string' ? v.startedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function fileBytes(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

function writeMarker(core: Core, destDir: string, marker: AnyMigrationMarker): { ok: true } | { ok: false; error: CommandError } {
  const dirRes = verifyArtifactDir(destDir, ['.thirdlight'], true);
  if (!dirRes.ok) return { ok: false, error: dirRes.error };
  const res = writeAtomic({
    dir: dirRes.dir,
    target: join(dirRes.dir, 'migration.json'),
    bytes: markerBytes(marker),
    allowedPreHashes: [],
    previousHash: null,
    ops: core.ops,
  });
  if (!res.ok) {
    return { ok: false, error: contentPublishFailed('write', res.failed?.onDiskState, res.failed?.errno) };
  }
  return { ok: true };
}

/** Read-only source load (workspace.md §14.1): never claims, releases or writes. */
type SourceLoad =
  | {
      ok: true;
      dir: string;
      sceneDir: string;
      thirdlightDir: string;
      manifest: Manifest;
      scene: Scene;
    }
  | { ok: false; error: CommandError };

function loadSource(core: Core, sourceProjectId: string): SourceLoad {
  if (!ID_RE.test(sourceProjectId)) {
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  }
  const dirRes = resolveProjectDir(core, sourceProjectId);
  if (!dirRes.ok) return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  const dir = dirRes.dir;
  const man = loadManifest(core, dir);
  if (!man.ok) return { ok: false, error: migrationSourceInvalid(sourceProjectId, man.errors) };
  const sceneDir = join(dir, 'scenes');
  const thirdlightDir = join(dir, '.thirdlight');
  const loaded = loadProjectDir(core, sceneDir, sourceProjectId, man.manifest);
  if (loaded.kind !== 'loaded') {
    const details = loaded.kind === 'blocked' ? loaded.errors : [];
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, details) };
  }
  if (loaded.storageVersion !== 1) {
    return {
      ok: false,
      error: migrationSourceInvalid(sourceProjectId, [
        {
          code: 'version_combination_unsupported',
          path: '/storageVersion',
          message: 'the migration source must be an M1 project (storageVersion 1)',
          expected: '1',
        },
      ]),
    };
  }
  return { ok: true, dir, sceneDir, thirdlightDir, manifest: man.manifest, scene: loaded.scene as Scene };
}

/** The source must not be owned by a live other backend (§14.1). */
function sourceOwnedByLiveBackend(core: Core, thirdlightDir: string): boolean {
  const rec = readOwnershipRecord(thirdlightDir, core.ops);
  if (rec.kind !== 'record') return false; // absent/unreadable: not a live owner
  const r = rec.record;
  if (r === null || r.state !== 'owned') return false;
  return evaluateLiveness(r.pid, r.openedAt, core.procRoot, core.processMarker) === 'live';
}

/** The expected destination bytes (a pure function of the source). */
function expectedDestination(
  core: Core,
  source: Extract<SourceLoad, { ok: true }>,
  newProjectId: string,
): { ok: true; manifestBytes: Uint8Array; envelopeBytes: Uint8Array; sceneV2: SceneV2 } | { ok: false; error: CommandError } {
  const migrated = migrateSceneV1ToV2(source.scene);
  if (!migrated.ok) {
    return {
      ok: false,
      error: migrationSourceInvalid(newProjectId, migrated.errors.slice(0, 10)),
    };
  }
  const reset = validateSceneV2({ ...migrated.normalized, revision: 0 });
  if (!reset.ok) {
    return { ok: false, error: migrationSourceInvalid(newProjectId, reset.errors.slice(0, 10)) };
  }
  const sceneV2 = reset.normalized;
  const manifestDoc = {
    schemaVersion: 1 as const,
    engineVersion: '0.1.0',
    id: newProjectId,
    name: source.manifest.name,
    createdAt: core.utcNow(),
    scenes: [{ id: source.manifest.scenes[0].id, path: 'scenes/main.json' }],
  };
  const norm = normalizeManifest(manifestDoc);
  if (!norm.ok) return { ok: false, error: migrationSourceInvalid(newProjectId, norm.errors.slice(0, 10)) };
  const bytes = serializeCanonical(norm.normalized);
  if (!bytes.ok) return { ok: false, error: migrationSourceInvalid(newProjectId, []) };
  return {
    ok: true,
    manifestBytes: bytes.bytes,
    envelopeBytes: buildEnvelopeBytesV2(newProjectId, sceneV2, emptyContent(), []),
    sceneV2,
  };
}

/**
 * `migrateProjectCopy(sourceProjectId, newProjectId)` (workspace.md §11/§14).
 * Idempotent: a resumed destination re-verifies existing files against their
 * expected canonical bytes and continues from the recorded phase.
 */
export function migrateProjectCopy(
  core: Core,
  sourceProjectId: string,
  newProjectId: string,
): MigrationResult {
  if (typeof newProjectId !== 'string' || !ID_RE.test(newProjectId)) {
    return { ok: false, error: pathRejected('/newProjectId', 'newProjectId must use the project-model ID syntax') };
  }
  if (sourceProjectId === newProjectId) {
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  }
  const source = loadSource(core, sourceProjectId);
  if (!source.ok) return { ok: false, error: source.error };
  if (sourceOwnedByLiveBackend(core, source.thirdlightDir)) {
    return {
      ok: false,
      error: migrationSourceInvalid(sourceProjectId, [
        {
          code: 'ownership_conflict',
          path: '',
          message: 'the migration source is owned by a live backend; migration reads it, so it must not be actively written',
        },
      ]),
    };
  }
  const expected = expectedDestination(core, source, newProjectId);
  if (!expected.ok) return { ok: false, error: expected.error };

  const destDir = join(core.projectsRoot, newProjectId);
  let destExists = false;
  try {
    destExists = lstatSync(destDir).isDirectory();
  } catch {
    destExists = false;
  }
  let marker: MigrationMarker | null = null;
  if (destExists) {
    const readMarker = readMigrationMarker(destDir);
    if (readMarker === null) {
      // A directory without a marker: a loadable project ⇒ refuse; anything
      // else is retained untouched (never overwrite an operator's directory).
      return { ok: false, error: migrationDestinationExists(newProjectId) };
    }
    if (
      readMarker.storageVersion !== 1 ||
      readMarker.sourceProjectId !== sourceProjectId ||
      readMarker.newProjectId !== newProjectId
    ) {
      // A mismatched marker, or another operator's (v3) marker: never
      // resumed by the v1→v2 operator, never overwritten.
      return {
        ok: false,
        error: migrationMarkerConflict(newProjectId, readMarker.sourceProjectId, readMarker.newProjectId),
      };
    }
    marker = readMarker;
  } else {
    try {
      mkdirSync(destDir, { mode: 0o755 });
    } catch {
      return { ok: false, error: contentPublishFailed('write') };
    }
    const tlRes = verifyArtifactDir(destDir, ['.thirdlight'], true);
    if (!tlRes.ok) return { ok: false, error: tlRes.error };
    marker = {
      storageVersion: 1,
      type: 'migration-copy',
      sourceProjectId,
      newProjectId,
      phase: 'created',
      startedAt: core.utcNow(),
    };
    const wm = writeMarker(core, destDir, marker);
    if (!wm.ok) return { ok: false, error: wm.error };
  }

  const resumed = destExists; // an existing destination was continued/verified
  const phases: MigrationPhase[] = ['created', 'manifest', 'blobs', 'envelope'];
  const startPhase = marker.phase;
  const startIdx = phases.indexOf(startPhase);

  const destScenesDir = join(destDir, 'scenes');

  // Step 3 — destination manifest (verified on resume).
  const manifestPath = join(destDir, 'project.json');
  const existingManifest = fileBytes(manifestPath);
  if (existingManifest !== null) {
    if (!bytesEqual(existingManifest, expected.manifestBytes)) {
      return { ok: false, error: migrationMarkerConflict(newProjectId, sourceProjectId, newProjectId) };
    }
  } else {
    if (startIdx >= phases.indexOf('manifest')) {
      // The phase says the manifest was written but it is gone: resume
      // rewrites it (nothing authoritative exists yet).
    }
    try {
      mkdirSync(destScenesDir, { mode: 0o755 });
    } catch {
      // may already exist
    }
    const mw = writeAtomic({
      dir: destDir,
      target: manifestPath,
      bytes: expected.manifestBytes,
      allowedPreHashes: null,
      previousHash: null,
      ops: core.ops,
    });
    if (!mw.ok) return { ok: false, error: contentPublishFailed('write', mw.failed?.onDiskState, mw.failed?.errno) };
    const wm = writeMarker(core, destDir, { ...marker, phase: 'manifest' });
    if (!wm.ok) return { ok: false, error: wm.error };
  }

  // Step 4 — copy every source blob (M1 sources have none today).
  let blobsCopied = 0;
  const sourceBlobDir = join(source.dir, 'sources', 'sha256');
  let sourceBlobs: string[] = [];
  try {
    if (lstatSync(sourceBlobDir).isDirectory()) sourceBlobs = readdirSync(sourceBlobDir).filter((n) => DIGEST_RE.test(n));
  } catch {
    sourceBlobs = [];
  }
  const destBlobDir = sourcesDir(destDir);
  if (!destBlobDir.ok) return { ok: false, error: destBlobDir.error };
  for (const name of sourceBlobs) {
    const bytes = fileBytes(join(sourceBlobDir, name));
    if (bytes === null || sha256Hex(bytes) !== name) {
      return {
        ok: false,
        error: migrationSourceInvalid(sourceProjectId, [
          { code: 'blob_corrupt', path: `sources/sha256/${name}`, message: 'a source blob does not match its content-addressed name' },
        ]),
      };
    }
    const target = join(destBlobDir.dir, name);
    const already = fileBytes(target);
    if (already !== null && bytesEqual(already, bytes)) continue;
    const wr = writeAtomic({ dir: destBlobDir.dir, target, bytes, allowedPreHashes: [], previousHash: null, ops: core.ops });
    if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
    blobsCopied += 1;
  }
  {
    const wm = writeMarker(core, destDir, { ...marker, phase: 'blobs' });
    if (!wm.ok) return { ok: false, error: wm.error };
  }

  // Step 5 — the destination envelope LAST (the commit point).
  const envelopePath = join(destScenesDir, 'main.json');
  const existingEnvelope = fileBytes(envelopePath);
  if (existingEnvelope !== null) {
    if (!bytesEqual(existingEnvelope, expected.envelopeBytes)) {
      return { ok: false, error: migrationMarkerConflict(newProjectId, sourceProjectId, newProjectId) };
    }
  } else {
    const envExistsDir = verifyArtifactDir(destDir, ['scenes'], true);
    if (!envExistsDir.ok) return { ok: false, error: envExistsDir.error };
    const wr = writeAtomic({
      dir: envExistsDir.dir,
      target: join(envExistsDir.dir, 'main.json'),
      bytes: expected.envelopeBytes,
      allowedPreHashes: null,
      previousHash: null,
      ops: core.ops,
    });
    if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  }
  {
    const wm = writeMarker(core, destDir, { ...marker, phase: 'envelope' });
    if (!wm.ok) return { ok: false, error: wm.error };
  }

  // Step 6 — remove the marker; the destination is complete only after this.
  try {
    unlinkSync(join(destDir, MARKER_REL));
  } catch {
    return { ok: false, error: contentPublishFailed('write') };
  }

  return {
    ok: true,
    sourceProjectId,
    newProjectId,
    sourceRevision: source.scene.revision,
    newRevision: 0,
    revisionPolicy: 'reset-to-zero',
    historyReset: true,
    retryCleared: true,
    blobsCopied,
    resumed,
  };
}

// ---- v2 → v3 copy operator (workspace.md §16.5) ----------------------------

/** A source load under the v2 pipeline (workspace.md §16.5.1). */
type SourceLoadV3 =
  | {
      ok: true;
      dir: string;
      sceneDir: string;
      thirdlightDir: string;
      manifest: Manifest;
      scene: SceneV2;
      content: ContentCatalog;
    }
  | { ok: false; error: CommandError };

/**
 * Read-only source load for the v2→v3 copy: the source must be loadable under
 * the **v2 pipeline** (`storageVersion` 2, scene `schemaVersion` 2, manifest
 * v1) and must not carry a v3-only component (the v2 registry rejects those as
 * `component_unknown`, so the load is `migration_source_invalid` — §16.5.1/
 * §23.11). A v1 or v3 source is `migration_version_unsupported`. Never claims,
 * releases, writes or edits the source.
 */
function loadSourceV3(core: Core, sourceProjectId: string): SourceLoadV3 {
  if (!ID_RE.test(sourceProjectId)) {
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  }
  const dirRes = resolveProjectDir(core, sourceProjectId);
  if (!dirRes.ok) return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  const dir = dirRes.dir;
  const man = loadManifest(core, dir);
  if (!man.ok) return { ok: false, error: migrationSourceInvalid(sourceProjectId, man.errors) };
  const sceneDir = join(dir, 'scenes');
  const thirdlightDir = join(dir, '.thirdlight');
  const loaded = loadProjectDir(core, sceneDir, sourceProjectId, man.manifest);
  if (loaded.kind !== 'loaded') {
    const details = loaded.kind === 'blocked' ? loaded.errors : [];
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, details) };
  }
  if (loaded.storageVersion !== 2) {
    return { ok: false, error: migrationVersionUnsupported(sourceProjectId, loaded.storageVersion, '2') };
  }
  if (loaded.content === null) {
    return { ok: false, error: migrationVersionUnsupported(sourceProjectId, 2, '2') };
  }
  return {
    ok: true,
    dir,
    sceneDir,
    thirdlightDir,
    manifest: man.manifest,
    scene: loaded.scene as SceneV2,
    content: loaded.content as ContentCatalog,
  };
}

/**
 * The §16.5.2 destination content: the source content carried verbatim
 * (assets/prefabs/behaviors/settings/behaviorTrust) **except** the derived
 * revision metadata reset to `0` (`versions[j].publishedRevision`,
 * `behaviors[i].publishedRevision`, `behaviors[i].source.publishedRevision`,
 * `behaviorTrust.entries[k].acknowledgedRevision`), with `game: null` added.
 * The six-key canonical order is emitted explicitly (`game` last).
 */
function deriveV3Content(source: ContentCatalog): ContentCatalogV3 {
  const clone = JSON.parse(JSON.stringify(source)) as ContentCatalog;
  for (const a of clone.assets) for (const v of a.versions) v.publishedRevision = 0;
  for (const b of clone.behaviors) {
    b.publishedRevision = 0;
    if (b.source !== null) b.source.publishedRevision = 0;
  }
  for (const e of clone.behaviorTrust.entries) e.acknowledgedRevision = 0;
  return {
    assets: clone.assets,
    prefabs: clone.prefabs,
    behaviors: clone.behaviors,
    settings: clone.settings,
    behaviorTrust: clone.behaviorTrust,
    game: null,
  } as unknown as ContentCatalogV3;
}

/** The expected v3 destination bytes (a pure function of the v2 source). */
function expectedDestinationV3(
  core: Core,
  source: Extract<SourceLoadV3, { ok: true }>,
  newProjectId: string,
):
  | { ok: true; manifestBytes: Uint8Array; envelopeBytes: Uint8Array }
  | { ok: false; error: CommandError } {
  const migrated = migrateSceneV3(source.scene);
  if (!migrated.ok) {
    return { ok: false, error: migrationSourceInvalid(newProjectId, migrated.errors.slice(0, 10) as LoadDetail[]) };
  }
  // The destination is a new project identity: revision resets to 0 with empty
  // history/retry (§16.5.2). The entities are carried verbatim.
  const reset = validateSceneV3({ ...migrated.normalized, revision: 0 });
  if (!reset.ok) {
    return { ok: false, error: migrationSourceInvalid(newProjectId, reset.errors.slice(0, 10) as LoadDetail[]) };
  }
  const sceneV3 = reset.normalized;
  const contentRes = validateContentV3(deriveV3Content(source.content));
  if (!contentRes.ok) {
    return { ok: false, error: migrationSourceInvalid(newProjectId, contentRes.errors.slice(0, 10) as LoadDetail[]) };
  }
  const contentV3 = contentRes.normalized;
  const manifestDoc = {
    schemaVersion: 1 as const,
    engineVersion: '0.1.0',
    id: newProjectId,
    name: source.manifest.name,
    createdAt: core.utcNow(),
    scenes: [{ id: source.manifest.scenes[0].id, path: 'scenes/main.json' }],
  };
  const norm = normalizeManifest(manifestDoc);
  if (!norm.ok) return { ok: false, error: migrationSourceInvalid(newProjectId, norm.errors.slice(0, 10)) };
  const bytes = serializeCanonical(norm.normalized);
  if (!bytes.ok) return { ok: false, error: migrationSourceInvalid(newProjectId, []) };
  // §16.5.2/§16.5.4: the copy must never write a state outside the passable
  // v3 combination, so the destination is re-validated as a whole before any
  // write (this is where a carried value that violates §13.2 rule 5 / §18.9.2
  // rule 4 would be caught if the derived reset were missing).
  const project = validateProjectV3(norm.normalized, sceneV3, contentV3);
  if (!project.ok) {
    return { ok: false, error: migrationSourceInvalid(newProjectId, project.errors.slice(0, 10) as LoadDetail[]) };
  }
  return {
    ok: true,
    manifestBytes: bytes.bytes,
    envelopeBytes: buildEnvelopeBytesV3(
      newProjectId,
      project.normalized.scene,
      project.normalized.content,
      [],
    ),
  };
}

/** True for a `W` temp file name (§5.1: `.<base>.tmp-<pid>-<nonce>`). */
function isTempName(name: string): boolean {
  return name.startsWith('.') && name.includes('.tmp-');
}

/** Every regular file under `dir`, as `/`-joined paths relative to `dir`. */
function listFilesRelative(dir: string, base = ''): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    const rel = base === '' ? n : `${base}/${n}`;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listFilesRelative(p, rel));
    else out.push(rel);
  }
  return out;
}

/** Remove the destination's leftover `W` temp files (never an authoritative path). */
function cleanDestinationTemps(destDir: string): void {
  for (const rel of listFilesRelative(destDir)) {
    const name = rel.split('/').pop() ?? rel;
    if (!isTempName(name)) continue;
    try {
      unlinkSync(join(destDir, ...rel.split('/')));
    } catch {
      // best effort: a temp that cannot be removed blocks below via the
      // unexpected-file check only when it is not a temp name
    }
  }
}

/**
 * `migrateProjectCopyV3(sourceProjectId, newProjectId)` (workspace.md §16.5).
 * Explicit, operator-driven and non-destructive: the source is read only and
 * retained byte-for-byte after success and after every refusal; the
 * destination is a new project identity written destination-first,
 * authoritative-last with a resumable four-phase marker. Idempotent: a
 * resumed destination re-verifies existing files against their expected
 * canonical bytes and continues from the recorded `phase`.
 */
export function migrateProjectCopyV3(
  core: Core,
  sourceProjectId: string,
  newProjectId: string,
): MigrationResultV3 {
  if (typeof newProjectId !== 'string' || !ID_RE.test(newProjectId)) {
    return { ok: false, error: pathRejected('/newProjectId', 'newProjectId must use the project-model ID syntax') };
  }
  if (sourceProjectId === newProjectId) {
    return { ok: false, error: migrationSourceInvalid(sourceProjectId, []) };
  }
  const source = loadSourceV3(core, sourceProjectId);
  if (!source.ok) return { ok: false, error: source.error };
  if (sourceOwnedByLiveBackend(core, source.thirdlightDir)) {
    return {
      ok: false,
      error: migrationSourceInvalid(sourceProjectId, [
        {
          code: 'ownership_conflict',
          path: '',
          message: 'the migration source is owned by a live backend; migration reads it, so it must not be actively written',
        },
      ]),
    };
  }
  const expected = expectedDestinationV3(core, source, newProjectId);
  if (!expected.ok) return { ok: false, error: expected.error };

  // §16.5.3 step 4 precondition, checked before any write: every blob the
  // source catalog references (asset versions and behavior source containers)
  // must exist and match its content-addressed name. A missing referenced blob
  // is a corrupt source (`migration_source_invalid`), never a silent copy of a
  // dangling reference. Unreferenced blobs are also copied ("reachable and
  // unreachable").
  const sourceBlobDir = join(source.dir, 'sources', 'sha256');
  let sourceBlobs: string[] = [];
  try {
    if (lstatSync(sourceBlobDir).isDirectory()) {
      sourceBlobs = readdirSync(sourceBlobDir).filter((n) => DIGEST_RE.test(n));
    }
  } catch {
    sourceBlobs = [];
  }
  {
    const referenced = new Set<string>();
    for (const a of source.content.assets) for (const v of a.versions) referenced.add(v.sourceDigest);
    for (const b of source.content.behaviors) if (b.source !== null) referenced.add(b.source.sourceDigest);
    const present = new Set(sourceBlobs);
    const missing = [...referenced].filter((d) => !present.has(d)).sort();
    if (missing.length > 0) {
      return {
        ok: false,
        error: migrationSourceInvalid(
          sourceProjectId,
          missing.slice(0, 10).map((d) => ({
            code: 'blob_missing',
            path: `sources/sha256/${d}`,
            message: 'a source-referenced authoritative blob is missing',
          })),
        ),
      };
    }
  }

  const deadline = core.content.now() + MIGRATION_TIMEOUT_MS;
  const timedOut = (): boolean => core.content.now() > deadline;

  const destDir = join(core.projectsRoot, newProjectId);
  let destExists = false;
  try {
    destExists = lstatSync(destDir).isDirectory();
  } catch {
    destExists = false;
  }

  let marker: MigrationMarkerV3;
  const resumed = destExists;
  if (destExists) {
    const existing = readMigrationMarker(destDir);
    if (existing === null) {
      // No marker: a loadable project, another operator's directory or any
      // unexpected content is refused (never overwritten).
      return { ok: false, error: migrationDestinationExists(newProjectId) };
    }
    if (
      existing.storageVersion !== 3 ||
      existing.sourceProjectId !== sourceProjectId ||
      existing.newProjectId !== newProjectId ||
      existing.sourceVersion !== 2 ||
      existing.newVersion !== 3
    ) {
      return { ok: false, error: migrationMarkerConflict(newProjectId, existing.sourceProjectId, existing.newProjectId) };
    }
    marker = existing;
  } else {
    try {
      mkdirSync(destDir, { mode: 0o755 });
    } catch {
      return { ok: false, error: contentPublishFailed('write') };
    }
    const tlRes = verifyArtifactDir(destDir, ['.thirdlight'], true);
    if (!tlRes.ok) return { ok: false, error: tlRes.error };
    marker = {
      storageVersion: 3,
      type: 'migration-copy',
      sourceProjectId,
      newProjectId,
      sourceVersion: 2,
      newVersion: 3,
      phase: 'created',
      startedAt: core.utcNow(),
    };
    const wm = writeMarker(core, destDir, marker);
    if (!wm.ok) return { ok: false, error: wm.error };
  }

  const phases: MigrationPhase[] = ['created', 'manifest', 'blobs', 'envelope'];
  const startIdx = phases.indexOf(marker.phase);

  // §16.5.3: `phase: "created"` with an unexpected non-marker file ⇒
  // `migration_destination_exists` unless the file is a `W` temp (cleaned).
  // Applies at every resume: temps are cleaned, never authoritative.
  cleanDestinationTemps(destDir);
  if (marker.phase === 'created') {
    const extra = listFilesRelative(destDir).filter(
      (rel) => rel !== '.thirdlight/migration.json' && !isTempName(rel.split('/').pop() ?? rel),
    );
    if (extra.length > 0) {
      return { ok: false, error: migrationDestinationExists(newProjectId) };
    }
  }

  const destScenesDir = join(destDir, 'scenes');

  // ---- step 3 — destination manifest (verified on resume) -----------------
  const manifestPath = join(destDir, 'project.json');
  const existingManifest = fileBytes(manifestPath);
  if (existingManifest !== null) {
    if (!bytesEqual(existingManifest, expected.manifestBytes)) {
      return { ok: false, error: migrationMarkerConflict(newProjectId, sourceProjectId, newProjectId) };
    }
  } else {
    try {
      mkdirSync(destScenesDir, { mode: 0o755 });
    } catch {
      // may already exist
    }
    const mw = writeAtomic({
      dir: destDir,
      target: manifestPath,
      bytes: expected.manifestBytes,
      allowedPreHashes: null,
      previousHash: null,
      ops: core.ops,
    });
    if (!mw.ok) return { ok: false, error: contentPublishFailed('write', mw.failed?.onDiskState, mw.failed?.errno) };
  }
  if (startIdx < phases.indexOf('manifest')) {
    const wm = writeMarker(core, destDir, { ...marker, phase: 'manifest' });
    if (!wm.ok) return { ok: false, error: wm.error };
    marker = { ...marker, phase: 'manifest' };
  }
  if (timedOut()) return { ok: false, error: contentPublishFailed('timeout') };

  // ---- step 4 — copy every reachable and unreachable source blob ----------
  const destBlobDir = sourcesDir(destDir);
  if (!destBlobDir.ok) return { ok: false, error: destBlobDir.error };
  let blobsCopied = 0;
  let blobsAlreadyPresent = 0;
  for (const name of sourceBlobs) {
    const bytes = fileBytes(join(sourceBlobDir, name));
    if (bytes === null || sha256Hex(bytes) !== name) {
      return {
        ok: false,
        error: migrationSourceInvalid(sourceProjectId, [
          {
            code: 'blob_corrupt',
            path: `sources/sha256/${name}`,
            message: 'a source blob does not match its content-addressed name',
          },
        ]),
      };
    }
    const target = join(destBlobDir.dir, name);
    const already = fileBytes(target);
    if (already !== null) {
      if (!bytesEqual(already, bytes)) {
        return { ok: false, error: contentPublishFailed('write') };
      }
      blobsAlreadyPresent += 1;
      continue;
    }
    const wr = writeAtomic({
      dir: destBlobDir.dir,
      target,
      bytes,
      allowedPreHashes: [],
      previousHash: null,
      ops: core.ops,
    });
    if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
    blobsCopied += 1;
  }
  if (startIdx < phases.indexOf('blobs')) {
    const wm = writeMarker(core, destDir, { ...marker, phase: 'blobs' });
    if (!wm.ok) return { ok: false, error: wm.error };
    marker = { ...marker, phase: 'blobs' };
  }
  if (timedOut()) return { ok: false, error: contentPublishFailed('timeout') };

  // ---- step 5 — the destination envelope LAST (the commit point) ----------
  const envelopePath = join(destScenesDir, 'main.json');
  const existingEnvelope = fileBytes(envelopePath);
  if (existingEnvelope !== null) {
    // §16.5.3: `phase: "envelope"` with a loadable v3 envelope means step 5
    // succeeded and only step 6 was interrupted — verify and remove the
    // marker without rewriting.
    if (!bytesEqual(existingEnvelope, expected.envelopeBytes)) {
      return { ok: false, error: migrationMarkerConflict(newProjectId, sourceProjectId, newProjectId) };
    }
  } else {
    const envDir = verifyArtifactDir(destDir, ['scenes'], true);
    if (!envDir.ok) return { ok: false, error: envDir.error };
    const wr = writeAtomic({
      dir: envDir.dir,
      target: join(envDir.dir, 'main.json'),
      bytes: expected.envelopeBytes,
      allowedPreHashes: null,
      previousHash: null,
      ops: core.ops,
    });
    if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  }
  if (startIdx < phases.indexOf('envelope')) {
    const wm = writeMarker(core, destDir, { ...marker, phase: 'envelope' });
    if (!wm.ok) return { ok: false, error: wm.error };
    marker = { ...marker, phase: 'envelope' };
  }
  if (timedOut()) return { ok: false, error: contentPublishFailed('timeout') };

  // ---- step 6 — remove the marker; complete only after this ---------------
  try {
    unlinkSync(join(destDir, MARKER_REL));
  } catch {
    return { ok: false, error: contentPublishFailed('write') };
  }

  return {
    ok: true,
    sourceProjectId,
    newProjectId,
    sourceRevision: source.scene.revision,
    newRevision: 0,
    revisionPolicy: 'reset-to-zero',
    historyReset: true,
    retryCleared: true,
    blobsCopied,
    blobsAlreadyPresent,
    resumed,
    sourceVersion: 2,
    newVersion: 3,
  };
}

/** Best-effort recursive removal (tests / operator delete of a destination). */
export function removeMigrationDestination(destDir: string): void {
  rmSync(destDir, { recursive: true, force: true });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
