/**
 * Project creation on disk: a new empty project, a project from a template
 * source, the read-only convergence onto an existing directory, and the
 * deterministic completion of a creation a crash interrupted.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ContentCatalogV3, ContentCatalogV4, Manifest, SceneV3 } from '@thirdlight/project-model';
import { glbClipDurations, normalizeManifest, parseDocumentBytes, validateProjectV3 } from '@thirdlight/project-model';

import { ID_RE } from './envelope';
import { publishBlob, type ContentContext } from './content-store';
import { upgradeAssetsToFiles } from './upgrade-assets';
import { blobMissing, fieldTypeError, fieldValueType, invalidRequest, projectExistsInvalid, writeFailed, type LoadDetail } from './errors';
import { sha256Hex } from './digest';
import { writeAtomic, type WriteOps } from './write';
import { absOf, defaultProjectFilesV4, isV4Layout, loadV4, projectFilesFromV3, type ProjectFilesV4 } from './store-v4';
import { gameRootFor } from './session-v4';
import { gamePathOf } from './resource-files';
import { ENGINE_VERSION, ensureSession, loadEnvelopeV3, projectBaseDir, resolveContained, validateAnyManifest, type Core } from './session';
import { validName } from './request-envelope';
import type { CreateProjectResult, ProjectSource } from './types';

export function createProjectImpl(core: Core, projectId: string, name: string): CreateProjectResult {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, error: fieldTypeError('/projectId', projectId, 'string') };
  }
  if (!ID_RE.test(projectId)) {
    return {
      ok: false,
      error: fieldValueType('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax'),
    };
  }
  if (typeof name !== 'string' || !validName(name)) {
    return {
      ok: false,
      error: fieldValueType('/name', typeof name === 'string' ? name : name, '1-128 chars, no control characters', 'name must be 1-128 characters without control characters'),
    };
  }
  const dir = projectBaseDir(core, projectId);
  if (core.ops.dirExists(dir)) {
    // The containment gate BEFORE any read or
    // converge (a symlinked or unresolvable directory is not a project
    // of this backend — no writes anywhere).
    if (!resolveContained(core, projectId).ok) {
      return {
        ok: false,
        error: projectExistsInvalid([
          {
            code: 'manifest_invalid',
            path: '',
            message:
              'the project directory is a symlink escape or an unresolvable path — not a project of this backend',
          },
        ]),
      };
    }
    // Existing directory: loadable ⇒ idempotent no-op; otherwise
    // project_exists_invalid with the load errors. Nothing is written.
    return convergeExisting(core, projectId);
  }
  // Creation write sequence (two files — explicitly not "atomic";
  // deterministic crash completion by the startup scan).
  const partial = createDirectories(dir, core.ops);
  if (partial === 'error') {
    return { ok: false, error: writeFailed('previous', undefined) };
  }
  // 'failed' = the directory (partially) exists concurrently: converge.
  if (partial !== 'failed') {
    // The v4 project files (creation write sequence):
    // project.json, the scene file, then content.json — its presence makes
    // the directory a v4 project; a crash before it leaves an interrupted
    // creation the startup scan completes deterministically.
    const built = defaultProjectFilesV4(projectId, name, core.utcNow(), ENGINE_VERSION);
    if (!built.ok) return { ok: false, error: projectExistsInvalid([]) };
    const w = writeNewProjectFiles(core, projectId, dir, built.files);
    if (w.kind === 'external') return convergeExisting(core, projectId);
    if (w.kind === 'failed') return { ok: false, error: writeFailed(w.onDiskState, w.errno) };
    // Claim ownership and load in memory.
    const o = ensureSession(core, projectId);
    if (o.kind === 'open') return { ok: true, created: true, revision: 0 };
    if (o.kind === 'unavailable') {
      return {
        ok: false,
        error: projectExistsInvalid(
          o.holder !== null
            ? [
                {
                  code: o.reason,
                  path: '',
                  message: `ownership ${o.reason} during creation (holder pid ${o.holder.pid})`,
                },
              ]
            : [],
        ),
      };
    }
    return { ok: false, error: projectExistsInvalid([]) };
  }
  return convergeExisting(core, projectId);
}

/**
 * Create a NEW project from a template/sample: the source scene and content
 * (validated as a v3 project, revision reset to 0, converted to v4 exactly
 * like the automatic upgrade) plus the bytes of every blob the content
 * references. Blobs are written first, then project.json, the scene file
 * and content.json, so a crash leaves at most an incomplete project the
 * startup scan completes or reports. An existing project id is refused.
 */
export function createProjectFrom(core: Core, projectId: string, name: string, source: ProjectSource): CreateProjectResult {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return {
      ok: false,
      error: fieldValueType('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax'),
    };
  }
  if (typeof name !== 'string' || !validName(name)) {
    return { ok: false, error: fieldValueType('/name', name, '1-128 chars, no control characters', 'name must be 1-128 characters without control characters') };
  }
  const dir = projectBaseDir(core, projectId);
  if (core.ops.dirExists(dir)) {
    return { ok: false, error: invalidRequest('/projectId', projectId, 'a new project id', `project "${projectId}" already exists`) };
  }
  const manifestDoc = {
    schemaVersion: 1 as const,
    engineVersion: ENGINE_VERSION,
    id: projectId,
    name,
    createdAt: core.utcNow(),
    scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
  };
  const man = normalizeManifest(manifestDoc);
  if (!man.ok) return { ok: false, error: invalidRequest('/name', name, 'a valid manifest', 'the project manifest is invalid') };
  const scene = { ...(source.scene as Record<string, unknown>), sceneId: 'scene-main', revision: 0 };
  // A new project starts at revision 0: publication revisions reset with it.
  const sourceContent = JSON.parse(JSON.stringify(source.content ?? null)) as {
    assets?: { versions?: { publishedRevision?: number }[] }[];
    behaviors?: { publishedRevision?: number; source?: { publishedRevision?: number } | null }[];
  } | null;
  for (const a of sourceContent?.assets ?? []) for (const v of a.versions ?? []) v.publishedRevision = 0;
  for (const b of sourceContent?.behaviors ?? []) {
    b.publishedRevision = 0;
    if (b.source) b.source.publishedRevision = 0;
  }
  const project = validateProjectV3(man.normalized, scene, sourceContent);
  if (!project.ok) {
    const first = project.errors[0];
    return { ok: false, error: invalidRequest(first?.path ?? '', undefined, 'a valid v3 scene + content', `the template is not a valid project: ${first?.message ?? 'invalid'}`) };
  }
  const content = project.normalized.content;
  const needed = new Set<string>();
  for (const a of content.assets) for (const v of a.versions) needed.add(v.convertedFrom?.sourceDigest ?? v.sourceDigest);
  for (const b of content.behaviors) if (b.source !== null) needed.add(b.source.sourceDigest);
  for (const digest of needed) {
    const bytes = source.blobs.get(digest);
    if (bytes === undefined || sha256Hex(bytes) !== digest) return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
  }
  if (createDirectories(dir, core.ops) !== 'ok') return { ok: false, error: writeFailed('previous', undefined) };
  const ctx: ContentContext = { projectId, dir, thirdlightDir: join(dir, '.thirdlight'), storageVersion: 4, revision: 0, scene: null, content: null, gameFolder: core.registry.get(projectId)?.folder ?? null };
  // Behavior containers go to the blob store; the template's asset files into the game folder, each with its sidecar.
  for (const b of content.behaviors) {
    if (b.source === null) continue;
    const bytes = source.blobs.get(b.source.sourceDigest)!;
    const put = publishBlob(core, ctx, { digest: b.source.sourceDigest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    if (!put.ok) return { ok: false, error: put.error };
  }
  const filed = upgradeAssetsToFiles(core, ctx, project.normalized.content as unknown as ContentCatalogV4, [], { readStored: (digest) => source.blobs.get(digest) ?? null, report: false });
  if (filed.report.notMoved.length > 0) {
    const first = filed.report.notMoved[0]!;
    return { ok: false, error: invalidRequest('', undefined, 'template assets written into the project folder', `asset ${first.assetId}: ${first.reason}`) };
  }
  // The clip lengths come from the template's own model files.
  const clips = new Map<string, { name: string; duration: number }[] | null>();
  const durationOf = (assetId: string, version: number, clipIndex: number, clipName: string): number | null => {
    const key = `${assetId}@${version}`;
    if (!clips.has(key)) {
      const v = content.assets.find((a) => a.assetId === assetId)?.versions.find((x) => x.version === version);
      const bytes = v === undefined ? undefined : source.blobs.get(v.convertedFrom?.sourceDigest ?? v.sourceDigest);
      clips.set(key, bytes === undefined ? null : glbClipDurations(bytes));
    }
    const list = clips.get(key);
    const clip = list?.[clipIndex]?.name === clipName ? list[clipIndex] : list?.find((c) => c.name === clipName);
    return clip?.duration ?? null;
  };
  const built = projectFilesFromV3(projectId, project.normalized.manifest, project.normalized.scene as SceneV3, filed.content as unknown as ContentCatalogV3, durationOf);
  if (!built.ok) {
    return { ok: false, error: invalidRequest('', undefined, 'a valid v4 project', `the template is not a valid project: ${built.message}`) };
  }
  const w = writeNewProjectFiles(core, projectId, dir, built.files);
  if (w.kind !== 'ok') return { ok: false, error: writeFailed(w.kind === 'failed' ? w.onDiskState : 'previous', w.kind === 'failed' ? w.errno : undefined) };
  const o = ensureSession(core, projectId);
  if (o.kind !== 'open') return { ok: false, error: projectExistsInvalid([]) };
  return { ok: true, created: true, revision: 0 };
}

/** The existing-directory outcome of createProject (idempotency).
 * READ-ONLY: a strict manifest + envelope load
 * via the same loaders the query path uses — MINUS session creation,
 * ownership evaluation/claim, and liveness side effects. Loadable ⇒ the
 * idempotent no-op; unloadable ⇒ `project_exists_invalid` with the load
 * errors; neither outcome writes anything (no ownership/claim file is
 * created or rewritten, envelope bytes are untouched). */
export function convergeExisting(core: Core, projectId: string): CreateProjectResult {
  const dir = projectBaseDir(core, projectId);
  // An existing v4 project is loadable when its files validate.
  if (isV4Layout(core.ops, dir)) {
    const l = loadV4(core.ops, dir, projectId, gameRootFor(core, projectId, dir));
    if (l.kind === 'loaded') return { ok: true, created: false, revision: l.state.revision };
    return { ok: false, error: projectExistsInvalid([...l.errors]) };
  }

  // Manifest loadability — report the actual manifest load details (a
  // garbage manifest is still an existing-invalid directory). Nothing is
  // written.
  let manifest: Manifest | null = null;
  const details: LoadDetail[] = [];
  const manPath = join(dir, 'project.json');
  if (!core.ops.fileExists(manPath)) {
    details.push({
      code: 'manifest_invalid',
      path: '/project.json',
      message: 'the manifest is missing (a concurrent creation or deletion is in flight)',
    });
  } else {
    try {
      const parsed = parseDocumentBytes(core.ops.readFile(manPath));
      if (!parsed.ok) {
        details.push({ code: parsed.error.code, path: parsed.error.path, message: parsed.error.message });
      } else {
        const v = validateAnyManifest(parsed.value);
        if (!v.ok) {
          for (const e of v.errors.slice(0, 10)) {
            details.push({ code: e.code, path: e.path, message: e.message });
          }
        } else {
          manifest = v.manifest;
        }
      }
    } catch {
      details.push({ code: 'manifest_invalid', path: '/project.json', message: 'the manifest is unreadable' });
    }
  }
  if (manifest === null) {
    if (details.length === 0) {
      details.push({
        code: 'manifest_invalid',
        path: '/project.json',
        message: 'the existing project directory is not loadable',
      });
    }
    return { ok: false, error: projectExistsInvalid(details) };
  }

  // A storage v3 project (upgraded to v4 when opened): the
  // envelope load — the same loader as the open path, without the
  // session/ownership acquisition around it (and without the upgrade).
  // Read-only probe; the caller's containment gate verified the
  // project directory (the scenes child is read here, never written).
  const l = loadEnvelopeV3(core, join(dir, 'scenes'), projectId, manifest);
  if (l.kind === 'loaded') return { ok: true, created: false, revision: l.scene.revision };
  const envDetails: LoadDetail[] =
    l.kind === 'envelope-missing'
      ? [
          {
            code: 'envelope_invalid',
            path: '',
            message:
              'the project has no content.json (an interrupted creation is completed by the startup scan)',
            expected: 'a loadable project (content.json and its scene files)',
          },
        ]
      : [...l.errors];
  if (envDetails.length === 0) {
    envDetails.push({
      code: 'manifest_invalid',
      path: '',
      message: 'the project directory exists but is not a loadable project',
      expected: 'a loadable manifest + authoring-state envelope',
    });
  }
  return { ok: false, error: projectExistsInvalid(envDetails) };
}


/**
 * The deterministic creation completion of a v4 project whose creation stopped
 * after `project.json`: the missing default scene file and `content.json` —
 * a pure function of the manifest (the default project at revision 0) — are
 * written via W, content.json last. A file already present is never
 * overwritten (it was written before the crash, or by someone else); the
 * project is loadable when the resulting files load.
 */
export function completeInterruptedCreation(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
): boolean {
  const built = defaultProjectFilesV4(projectId, manifest.name, manifest.createdAt, manifest.engineVersion);
  if (!built.ok) return false;
  for (const f of [built.files.scene, built.files.content]) {
    const target = join(dir, f.rel);
    if (core.ops.fileExists(target)) continue;
    const res = writeAtomic({
      dir: dirname(target),
      target,
      bytes: f.bytes as Uint8Array,
      allowedPreHashes: null, // must stay absent
      previousHash: null,
      ops: core.ops,
    });
    if (res.ok) continue;
    // Appeared concurrently: kept (never overwrite a foreign write); the load below decides.
    if (res.external) continue;
    if (res.failed && res.failed.onDiskState === 'new-undurable') continue; // on disk; durability unproven
    return false; // "previous" / unreadable: still absent — kept for the operator
  }
  return loadV4(core.ops, dir, projectId, gameRootFor(core, projectId, dir)).kind === 'loaded';
}

/**
 * Write a new project's files (creation sequence, v4): `project.json`,
 * its resource files (a template's prefabs, materials, …) in the game
 * folder, the scene file, then `content.json` — its presence makes the directory a
 * v4 project, so a crash before it leaves an interrupted creation the startup
 * scan completes. A scene/content file that already exists is an external
 * appearance (a concurrent creator).
 */
export function writeNewProjectFiles(
  core: Core,
  projectId: string,
  dir: string,
  files: ProjectFilesV4,
): { kind: 'ok' } | { kind: 'external' } | { kind: 'failed'; onDiskState: 'previous' | 'new-undurable'; errno: string | undefined } {
  const gameRoot = gameRootFor(core, projectId, dir);
  for (const f of [files.manifest, ...files.resources, files.scene, files.content]) {
    const target = absOf(dir, gameRoot, f.rel);
    if (gamePathOf(f.rel) !== null) mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const res = writeAtomic({
      dir: dirname(target),
      target,
      bytes: f.bytes as Uint8Array,
      // The manifest takes no pre-write check (races are handled by the
      // reload); the scene and content files must not exist yet.
      allowedPreHashes: f === files.manifest || f.rel.endsWith('.tlasset') ? [] : null,
      previousHash: null,
      ops: core.ops,
    });
    if (res.external) return { kind: 'external' };
    if (res.failed) return { kind: 'failed', onDiskState: res.failed.onDiskState, errno: res.failed.errno };
    if (res.unreadable) return { kind: 'failed', onDiskState: 'previous', errno: res.unreadable.errno };
  }
  return { kind: 'ok' };
}

/**
 * Mkdir the project, scenes, .thirdlight and
 * .thirdlight/recovery (all 0755). Returns 'ok', 'failed' (the project
 * directory already exists — a concurrent creator: converge instead), or
 * 'error' (a real I/O failure).
 */
export function createDirectories(dir: string, ops: WriteOps): 'ok' | 'failed' | 'error' {
  // Step 1: the project directory itself — NON-recursive so a concurrent
  // creator's EEXIST is detected (converge instead of clobbering).
  if (ops.dirExists(dir)) return 'failed';
  try {
    mkdirSync(dir, { mode: 0o755 });
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort
    }
  } catch (e) {
    const errno = (e as { errno?: unknown })?.errno;
    if (errno === 'EEXIST') return 'failed'; // concurrent creator
    return 'error';
  }
  // The fixed sub-layout (recursive: the parent now exists).
  for (const d of [join(dir, 'scenes'), join(dir, '.thirdlight'), join(dir, '.thirdlight', 'recovery')]) {
    if (ops.dirExists(d)) continue;
    try {
      mkdirSync(d, { recursive: true, mode: 0o755 });
      try {
        chmodSync(d, 0o755);
      } catch {
        // best effort
      }
    } catch {
      return 'error';
    }
  }
  return 'ok';
}
