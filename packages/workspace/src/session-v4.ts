/**
 * The session side of storage v4 (see `store-v4.ts`) — open (with the
 * automatic v3 → v4 upgrade), publish, external changes, release, and the
 * scene-aware queries. `session.ts` owns the single-envelope paths and
 * branches here for a v4 project.
 */

import { createCommandState, filterEntitiesByComponent, queryAssets, queryBehaviors, queryGameConfig, queryPrefabs } from '@thirdlight/commands';
import type { HistoryState } from '@thirdlight/commands';
import { BlockGrid, boxContains, effectiveCellMeta, regionCells, regionContains, type BlockCell, type BlockLayerComponent, type BlockLayerData, type BlockType, type CellField } from '@thirdlight/project-model';
import { composeV4, defaultInputFor, DESCRIPTORS, physicsDimensionOf, effectiveEntityFlags, GRAPH_KINDS, glbClipDurations, liveLoadable, migrateModelAnimations, validateContentV4, validateSceneV4, type ContentCatalogV3, type Manifest, type ModelErrorV3, type ProjectManifestV2, type SceneV3, type SceneV4 } from '@thirdlight/project-model';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPreparedSources, readBlob, readSourceBlob, type ContentContext } from './content-store';
import { loadabilityNotes, SCRIPT_NAMED_LABEL, upgradeLoadability, writeLoadabilityReport } from './upgrade-loadable';
import { missingReferenceIds, rebuildFromFiles, restoreFromRecordCache, type RecoveryProblem } from './asset-recovery';
import { CACHE_GITIGNORE_LINES } from './registry';
import { upgradeAssetsToFiles } from './upgrade-assets';
import { sha256Hex } from './digest';
import type { RetryRecord } from './envelope';
import {
  entityNotFound,
  externalChangeEvidenceMissing,
  externalChangeInvalid,
  externalChangeUnreadable,
  externalChangeUnresolved,
  fieldTypeError,
  fieldUnexpected,
  fieldValueType,
  isSafeInt,
  noPendingChange,
  pointerSegment,
  projectUnavailable,
  writeFailed,
  type LoadDetail,
  type UnavailableReason,
} from './errors';
import type { Core, OpenOutcome, PendingChange, ProjectSession } from './session';
import {
  changedFile,
  CONTENT_REL,
  contentFileBytes,
  firstChangedFile,
  isV4Layout,
  loadV4,
  manifestV2Bytes,
  MANIFEST_REL_V4,
  mergedRecords,
  migrateDirV3ToV4,
  rollForwardJournal,
  sceneFileBytes,
  sceneChunkFiles,
  isChunkRel,
  chunkRel,
  projectWidePart,
  resourceFilesOf,
  sidecarWrite,
  isSidecarRel,
  withUntrackedSidecars,
  loadingByKey,
  LOADABLE_KEY,
  absOf,
  formerKey,
  sceneRel,
  sceneRelOf,
  snapshotForeignFile,
  writeTransaction,
  type FileWrite,
  type KnownFile,
  type ResourcePaths,
  type V4State,
} from './store-v4';
import { dropFlushes } from './journal-flush';
import { defaultResourcePath, gamePathOf, gameRel, recordsOfKind, RESOURCE_KINDS, resourceFileBytes, scenePathIn } from './resource-files';
import { fileOfRecord, sidecarPath, type RecordLike } from './asset-files';
import { EMPTY_BYTES } from './write';
import { commandContentOf } from './content-shapes';
import { buildIndex, updateIndex } from './project-index';
import { serveQueryIndex } from './query-index';
import type { OwnershipRecord } from './ownership';
import type { QueryResult } from './types';

export { isV4Layout };

/**
 * The v1 manifest shape the rest of the workspace still carries for a v4
 * project (queryProject reports the real v2 manifest from `s.v4`).
 */
export function legacyManifestOf(m: ProjectManifestV2, firstSceneId: string): Manifest {
  return {
    schemaVersion: 1,
    engineVersion: m.engineVersion,
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    scenes: [{ id: firstSceneId, path: 'scenes/main.json' }],
  } as Manifest;
}


/** The scene a v4 session exposes through the single-scene fields (the first start scene). */
export function primaryScene(state: V4State): SceneV4 {
  const first = state.content.startScenes[0];
  const s = (first !== undefined ? state.scenes.get(first) : undefined) ?? [...state.scenes.values()][0];
  if (s === undefined) throw new Error('a v4 project without scenes');
  return s;
}

/** Point the session's fields at a (new) v4 state. History is left alone. */
export function publishV4(s: ProjectSession, state: V4State): void {
  const scene = primaryScene(state);
  // The index follows: what the new state shares with the last one is not indexed again.
  if (s.index !== undefined && s.v4 !== null && s.v4 !== undefined) updateIndex(s.index, s.v4, state);
  else s.index = buildIndex(state);
  s.v4 = state;
  s.storageVersion = 4;
  s.scene = scene;
  s.content = state.content;
  s.manifest = legacyManifestOf(state.manifest, scene.sceneId);
  s.revision = state.revision;
  const records = mergedRecords(state);
  s.records = records;
  s.recordMap = new Map(records.map((r) => [r.requestId, r]));
  s.envelopeBytes = EMPTY_BYTES;
}

/** The revision `content.json` states (it may be below the project's, which is the highest file revision). */
function contentRevisionOf(state: V4State): number {
  const f = state.files.get(CONTENT_REL);
  if (f === undefined) return state.revision;
  const r = (JSON.parse(new TextDecoder().decode(f.bytes)) as { revision?: unknown }).revision;
  return typeof r === 'number' ? r : state.revision;
}

/** The game folder a project's resource files are in (a data-root project is its own). */
export function gameRootFor(core: Core, projectId: string, dir: string): string {
  return core.registry.get(projectId)?.folder ?? dir;
}

/** The game folder of an open project. */
export function gameRootOf(s: ProjectSession): string {
  return s.gameFolder ?? s.dir;
}

/** A fresh history for a v4 state (a history boundary). */
export function freshHistoryV4(state: V4State): HistoryState {
  return createCommandState(primaryScene(state), commandContentOf(state.content)).history;
}

function makeSessionV4(
  core: Core,
  dir: string,
  projectId: string,
  state: V4State,
  ownership: OwnershipRecord,
  sceneDir: string,
  thirdlightDir: string,
  notes: string[],
): ProjectSession {
  const scene = primaryScene(state);
  const s = {
    projectId,
    dir,
    sceneDir,
    thirdlightDir,
    gameFolder: core.registry.get(projectId)?.folder ?? null,
    manifest: legacyManifestOf(state.manifest, scene.sceneId),
    scene,
    storageVersion: 4,
    content: state.content,
    revision: state.revision,
    records: [] as RetryRecord[],
    recordMap: new Map<string, RetryRecord>(),
    envelopeBytes: EMPTY_BYTES,
    history: freshHistoryV4(state),
    ownership,
    mode: 'open',
    ownershipReverify: false,
    blocked: null,
    pendingChange: null,
    preparedSources: loadPreparedSources(thirdlightDir),
    v4: state,
    upgradeNotes: notes,
  } as ProjectSession;
  publishV4(s, state);
  return s;
}

export type OpenV4Outcome =
  | { kind: 'open'; session: ProjectSession }
  | { kind: 'blocked'; reason: UnavailableReason; errors: readonly LoadDetail[]; count: number };

/**
 * Open a v4 project directory (rolling a pending journal forward first), or
 * upgrade a loaded v3 project to v4 and open that. The caller holds the
 * ownership claim.
 */
export function openV4(
  core: Core,
  dir: string,
  projectId: string,
  sceneDir: string,
  thirdlightDir: string,
  ownership: OwnershipRecord,
  upgradeFrom?: { manifest: Manifest; scene: SceneV3; content: ContentCatalogV3; envelopeBytes: Uint8Array },
): OpenV4Outcome {
  let notes: string[] = [];
  const gameRoot = gameRootFor(core, projectId, dir);
  if (upgradeFrom !== undefined) {
    const m = migrateDirV3ToV4(core.ops, dir, thirdlightDir, projectId, upgradeFrom.manifest, upgradeFrom.scene, upgradeFrom.content, upgradeFrom.envelopeBytes, gameRoot);
    if (!m.ok) return { kind: 'blocked', reason: 'envelope_invalid', errors: [m.error], count: 1 };
    notes = m.notes;
  }
  // An open replays every journal on disk, including any this process was still flushing for an earlier session.
  dropFlushes(thirdlightDir);
  const j = rollForwardJournal(core.ops, dir, thirdlightDir, projectId, gameRoot);
  if (!j.ok) return { kind: 'blocked', reason: 'envelope_invalid', errors: [j.error], count: 1 };
  const recovered = loadRecoveringSidecars(core, dir, thirdlightDir, projectId, gameRoot);
  const l = recovered.load;
  if (l.kind === 'blocked') return l;
  let loaded = l.state;
  let loadNotes = l.upgraded?.notes ?? [];
  if (l.upgraded?.assetFiles === true) {
    const files = upgradeAssetFilesOnOpen(core, dir, thirdlightDir, projectId, loaded);
    loaded = files.state;
    loadNotes = [...loadNotes, ...files.notes];
  }
  // A layout change alone (resources out of content.json) is no edit: the revision stays.
  const bump = l.upgraded?.documents === true || l.upgraded?.assetFiles === true;
  const upgraded = l.upgraded !== undefined ? writeUpgradedProject(core, dir, thirdlightDir, projectId, loaded, loadNotes, bump, l.upgraded.manifest === true) : { state: loaded, notes: [] };
  const migrated = migrateModelAnimationsOnOpen(core, dir, thirdlightDir, projectId, upgraded.state);
  // Assets from before addresses and labels decided what ships: the ones scripts name keep shipping.
  const legacy = l.upgraded?.assetFiles === true || l.upgraded?.resourceFiles === true ? 'all' : l.preAddressSidecars !== undefined ? new Set(l.preAddressSidecars.keys()) : null;
  const loadable = legacy === null ? { state: migrated.state, notes: [] } : upgradeLoadabilityOnOpen(core, dir, thirdlightDir, projectId, migrated.state, legacy, l.preAddressSidecars ?? new Map());
  const session = makeSessionV4(core, dir, projectId, loadable.state, ownership, sceneDir, thirdlightDir, [...notes, ...upgraded.notes, ...migrated.notes, ...loadable.notes]);
  const skipped = (l.skipped ?? []).map((f): RecoveryProblem => ({ code: 'resource_file_invalid', message: `${f.message}; the file was left out of the project` }));
  if (recovered.problems.length + skipped.length > 0) session.openProblems = [...recovered.problems, ...skipped];
  return { kind: 'open', session };
}

/**
 * Load the project, putting lost sidecars back first (`asset-recovery.ts`):
 * from the record cache, then, while the load names ids nothing holds, from
 * files named for them. An id still missing after that blocks the open as
 * any broken reference does, with a first detail that says what to do.
 */
function loadRecoveringSidecars(core: Core, dir: string, thirdlightDir: string, projectId: string, gameRoot: string): { load: ReturnType<typeof loadV4>; problems: RecoveryProblem[] } {
  let l = loadV4(core.ops, dir, projectId, gameRoot);
  // An older layout keeps the records in content.json: nothing to put back yet.
  if (l.kind === 'loaded' && l.upgraded?.resourceFiles === true) return { load: l, problems: [] };
  const ctx: ContentContext = { projectId, dir, thirdlightDir, storageVersion: 4, revision: l.kind === 'loaded' ? l.state.revision : 0, scene: null, content: null, gameFolder: core.registry.get(projectId)?.folder ?? null };
  const files = l.kind === 'loaded' ? l.state.files : new Map<string, KnownFile>();
  const problems = restoreFromRecordCache(core, ctx, l.kind === 'loaded' ? (l.state.content.assets as unknown as RecordLike[]) : [], (file) => files.get(gameRel(sidecarPath(file)))?.bytes);
  if (problems.some((p) => p.code === 'asset_sidecar_restored')) l = loadV4(core.ops, dir, projectId, gameRoot);
  if (l.kind === 'loaded') return { load: l, problems };
  const missing = missingReferenceIds(l.errors);
  const rebuilt = rebuildFromFiles(core, ctx, missing, contentRevisionOnDisk(core, dir));
  problems.push(...rebuilt.problems);
  if (rebuilt.rebuilt.length > 0) l = loadV4(core.ops, dir, projectId, gameRoot);
  if (l.kind === 'blocked') {
    const still = missingReferenceIds(l.errors);
    if (still.length > 0) {
      const lead: LoadDetail = {
        code: 'reference_missing',
        path: '',
        message: `${still.map((id) => `"${id}"`).join(', ')} ${still.length === 1 ? 'is' : 'are'} used but no asset or resource of the project has ${still.length === 1 ? 'it' : 'them'}: a lost .tlasset sidecar (or resource file) that neither the record cache nor a file named for the id could put back. Put the file back, or import the asset's file again with that id`,
        expected: 'every used id held by an asset sidecar or a resource file',
      };
      l = { ...l, errors: [lead, ...l.errors].slice(0, 10), count: l.count + 1 };
    }
  }
  return { load: l, problems };
}

/** The revision `content.json` states (0 when it cannot be read): a rebuilt record's publishedRevision. */
function contentRevisionOnDisk(core: Core, dir: string): number {
  try {
    const r = (JSON.parse(new TextDecoder().decode(core.ops.readFile(join(dir, CONTENT_REL)))) as { revision?: unknown }).revision;
    return typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 ? r : 0;
  } catch {
    return 0;
  }
}

/**
 * A schemaVersion 4 project's assets become files in the game folder with
 * their sidecars (`upgrade-assets.ts`); the result must validate like any
 * command's, else the project opens as it was and the notes say why.
 */
function upgradeAssetFilesOnOpen(core: Core, dir: string, thirdlightDir: string, projectId: string, state: V4State): { state: V4State; notes: string[] } {
  const ctx: ContentContext = {
    projectId,
    dir,
    thirdlightDir,
    storageVersion: 4,
    revision: state.revision,
    scene: primaryScene(state),
    content: state.content,
    scenes: [...state.scenes.values()],
    gameFolder: core.registry.get(projectId)?.folder ?? null,
  };
  const u = upgradeAssetsToFiles(core, ctx, state.content, state.scenes.values());
  const v = validateContentV4(u.content);
  if (!v.ok) return { state, notes: [...u.notes, `the assets stay stored in sources/sha256: the upgraded content does not validate (${v.errors[0]?.message ?? 'unknown'})`] };
  ensureCacheIgnored(dir);
  return { state: { ...state, content: v.normalized }, notes: u.notes };
}

/** A folder project's `.gitignore` names the import cache (it is rebuilt, never committed). */
function ensureCacheIgnored(dir: string): void {
  const path = join(dir, '.gitignore');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (/^cache\/?$/m.test(text)) return;
  try {
    writeFileSync(path, `${text.endsWith('\n') || text.length === 0 ? text : `${text}\n`}${CACHE_GITIGNORE_LINES}`);
  } catch {
    // the cache is then only unignored; nothing else depends on it
  }
}

/**
 * Write a project the load upgraded (schemaVersion 2 or 3 → 4) back
 * as one new revision: the manifest, the content file and every scene file
 * (block chunk files are unchanged). If the write fails the project still
 * opens upgraded in memory (the next open upgrades it again) and the notes
 * say so.
 */
function writeUpgradedProject(core: Core, dir: string, thirdlightDir: string, projectId: string, state: V4State, notes: string[], bump: boolean, manifest = false): { state: V4State; notes: string[] } {
  const revision = bump ? state.revision + 1 : state.revision;
  const files = new Map(state.files);
  const writes: FileWrite[] = [];
  const contentRevision = bump ? revision : contentRevisionOf(state);
  const contentBytes = contentFileBytes(projectId, contentRevision, state.content, state.fileRecords.get(CONTENT_REL) ?? []);
  writes.push({ rel: CONTENT_REL, bytes: contentBytes });
  files.set(CONTENT_REL, { bytes: contentBytes, hash: sha256Hex(contentBytes) });
  const scenes = new Map<string, SceneV4>(state.scenes);
  // A new schemaVersion alone is written without a new revision.
  if (bump || manifest) {
    const manifestBytes = manifestV2Bytes(state.manifest);
    writes.push({ rel: MANIFEST_REL_V4, bytes: manifestBytes });
    files.set(MANIFEST_REL_V4, { bytes: manifestBytes, hash: sha256Hex(manifestBytes) });
  }
  for (const [id, scene] of bump ? state.scenes : []) {
    const stamped: SceneV4 = { ...scene, revision };
    const rel = sceneRelOf(state, id);
    const bytes = sceneFileBytes(projectId, stamped, state.fileRecords.get(rel) ?? []);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
    scenes.set(id, stamped);
  }
  // Every resource its own file, every asset's record in its sidecar (an older content.json held them all).
  const resources = resourceFilesOf(state.content, state.resourcePaths);
  for (const w of resources.writes) {
    const hash = sha256Hex(w.bytes as Uint8Array);
    if (files.get(w.rel)?.hash === hash) continue;
    writes.push(w);
    files.set(w.rel, { bytes: w.bytes as Uint8Array, hash });
  }
  const gameRoot = gameRootFor(core, projectId, dir);
  const res = writeTransaction(core.ops, dir, thirdlightDir, projectId, withUntrackedSidecars(core.ops, dir, gameRoot, state.files, writes), writes, gameRoot);
  if (!res.ok) return { state, notes: [...notes, 'the upgraded project could not be written; it is upgraded again at the next open'] };
  return { state: { ...state, scenes, revision, files, resourcePaths: resources.paths }, notes };
}

/**
 * The old `modelAnimation` idle/run/airborne profile becomes an
 * animator controller when the project opens (the clip lengths are read from
 * the model files). Written as one new revision; if anything fails the
 * project opens as it was (the old component keeps playing) and the reason
 * goes to the upgrade notes.
 */
function migrateModelAnimationsOnOpen(core: Core, dir: string, thirdlightDir: string, projectId: string, state: V4State): { state: V4State; notes: string[] } {
  const scenes = [...state.scenes.values()];
  const hasOld = scenes.some((sc) => sc.entities.some((e) => (e.components as Record<string, unknown>)['modelAnimation'] !== undefined)) ||
    state.content.prefabs.some((p) => (p.entities as unknown as { components: Record<string, unknown> }[]).some((e) => e.components['modelAnimation'] !== undefined));
  if (!hasOld) return { state, notes: [] };
  const ctx: ContentContext = {
    projectId,
    dir,
    thirdlightDir,
    storageVersion: 4,
    revision: state.revision,
    scene: primaryScene(state),
    content: state.content,
    scenes,
    gameFolder: core.registry.get(projectId)?.folder ?? null,
  };
  const lengths = new Map<string, { name: string; duration: number }[] | null>();
  const durationOf = (assetId: string, version: number, clipIndex: number, clipName: string): number | null => {
    const key = `${assetId}@${version}`;
    if (!lengths.has(key)) {
      const r = readBlob(core, ctx, { assetId, version });
      lengths.set(key, r.ok ? glbClipDurations(r.bytes) : null);
    }
    const list = lengths.get(key);
    if (list === null || list === undefined) return null;
    const clip = list[clipIndex]?.name === clipName ? list[clipIndex] : list.find((c) => c.name === clipName);
    return clip === undefined ? null : clip.duration;
  };
  const m = migrateModelAnimations(scenes, state.content, durationOf);
  if (m === null) return { state, notes: [] };
  if (m.migrated === 0) return { state, notes: m.notes };
  const kept = (why: string): { state: V4State; notes: string[] } => ({ state, notes: [`the idle/run/airborne animations were not moved to animators (${why}); they keep playing as before`] });
  // The migrated project must validate like any command result.
  const revision = state.revision + 1;
  const content = validateContentV4(m.content);
  if (!content.ok) return kept(content.errors[0]?.message ?? 'the content does not validate');
  const nextScenes = new Map<string, SceneV4>();
  for (const sc of m.scenes) {
    const v = validateSceneV4(sc);
    if (!v.ok) return kept(v.errors[0]?.message ?? 'a scene does not validate');
    nextScenes.set(sc.sceneId, sc);
  }
  const errors: ModelErrorV3[] = [];
  composeV4([...nextScenes.values()], content.normalized, errors, revision);
  if (errors.length > 0) return kept(errors[0]!.message);
  const plan = changedFiles(projectId, state, { content: content.normalized, scenes: nextScenes, revision }, null);
  const gameRoot = gameRootFor(core, projectId, dir);
  const res = writeTransaction(core.ops, dir, thirdlightDir, projectId, withUntrackedSidecars(core.ops, dir, gameRoot, state.files, plan.writes), plan.writes, gameRoot);
  if (!res.ok) return kept('the project files could not be written');
  return {
    state: { manifest: state.manifest, content: content.normalized, scenes: nextScenes, revision, files: plan.commitFiles(), fileRecords: plan.fileRecords, resourcePaths: plan.resourcePaths, scenePaths: plan.scenePaths, formerPaths: plan.formerPaths },
    notes: m.notes,
  };
}

/**
 * Label the assets scripts name by id (`upgrade-loadable.ts`) and write the
 * old sidecars in this build's format, as one transaction; a new revision
 * only when a record changed. If it cannot be written the project opens as
 * it was (the next open tries again) and the notes say so.
 */
function upgradeLoadabilityOnOpen(core: Core, dir: string, thirdlightDir: string, projectId: string, state: V4State, legacy: ReadonlySet<string> | 'all', preAddress: ReadonlyMap<string, string | null>): { state: V4State; notes: string[] } {
  const ctx: ContentContext = { projectId, dir, thirdlightDir, storageVersion: 4, revision: state.revision, scene: primaryScene(state), content: state.content, scenes: [...state.scenes.values()], gameFolder: core.registry.get(projectId)?.folder ?? null };
  const u = upgradeLoadability(state.content, legacy, preAddress, (digest) => {
    const r = readSourceBlob(core, ctx, { digest });
    return r.ok ? r.bytes : null;
  });
  if (u === null) return { state, notes: [] };
  const kept = (why: string): { state: V4State; notes: string[] } => ({ state, notes: [`the assets scripts name were not labelled "${SCRIPT_NAMED_LABEL}" (${why}); the next open tries again`] });
  const content = validateContentV4(u.content, state.content);
  if (!content.ok) return kept(content.errors[0]?.message ?? 'the content does not validate');
  const revision = u.changed ? state.revision + 1 : state.revision;
  const scenes = new Map(state.scenes);
  const plan = changedFiles(projectId, state, { content: content.normalized, scenes, revision }, null);
  const gameRoot = gameRootFor(core, projectId, dir);
  const res = writeTransaction(core.ops, dir, thirdlightDir, projectId, withUntrackedSidecars(core.ops, dir, gameRoot, state.files, plan.writes), plan.writes, gameRoot);
  if (!res.ok) return kept('the project files could not be written');
  writeLoadabilityReport(core.ops, dir, u, new Date(core.content.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  return {
    state: { manifest: state.manifest, content: content.normalized, scenes, revision, files: plan.commitFiles(), fileRecords: plan.fileRecords, resourcePaths: plan.resourcePaths, scenePaths: plan.scenePaths, formerPaths: plan.formerPaths },
    notes: loadabilityNotes(u),
  };
}

/** Wrap an open-v4 outcome as the session layer's open outcome (blocked → caller builds the blocked session). */
export function toOpenOutcome(o: OpenV4Outcome): OpenOutcome | null {
  return o.kind === 'open' ? { kind: 'open', session: o.session } : null;
}

// ---- writing (the command path) ---------------------------------------------------

/**
 * Where a command puts the resources and scenes it creates: `folder` (a
 * folder of the game folder the request named) for what it creates, `at` for
 * files adopted where they are (`formerKey` → game-folder path), and `disk`:
 * those files' bytes as the file check read them (null: gone), the baseline
 * the transaction checks and the known files start from.
 */
export interface Placement {
  folder?: string;
  at?: ReadonlyMap<string, string>;
  disk?: ReadonlyMap<string, KnownFile | null>;
  /** Files a move puts elsewhere (`formerKey` → a resource's game-folder path, or a scene's file key): written there, removed where they were. */
  moved?: ReadonlyMap<string, string>;
}

/** The files a new v4 state needs written, compared with what is on record. */
export function changedFiles(projectId: string, before: V4State, after: { content: V4State['content']; scenes: Map<string, SceneV4>; revision: number }, record: RetryRecord | null, place: Placement = {}): {
  writes: FileWrite[];
  /** The known files after the transaction: call once it is written (it brings the known files up to date in place). */
  commitFiles: () => Map<string, KnownFile>;
  fileRecords: Map<string, RetryRecord[]>;
  resourcePaths: ResourcePaths;
  scenePaths: ReadonlyMap<string, string>;
  formerPaths: ReadonlyMap<string, string>;
} {
  const writes: FileWrite[] = [];
  const files = new FileDelta(before.files);
  for (const [rel, f] of place.disk ?? []) {
    if (f === null) files.delete(rel);
    else files.set(rel, f);
  }
  const scenePaths = new Map(before.scenePaths);
  const formerPaths = new Map(before.formerPaths ?? []);
  // A new scene's file: adopted where it is, in the folder the request named, where it was before it was removed, or scenes/<id>.json.
  const newSceneRel = (id: string): string => {
    const key = formerKey('scene', id);
    const at = place.at?.get(key);
    const former = formerPaths.get(key);
    formerPaths.delete(key);
    return at !== undefined ? gameRel(at) : place.folder !== undefined ? gameRel(scenePathIn(place.folder, id)) : (former ?? sceneRel(id));
  };
  const fileRecords = new Map(before.fileRecords);
  const appendTo = (rel: string): RetryRecord[] => {
    const list = [...(fileRecords.get(rel) ?? [])];
    if (record !== null) {
      list.push(record);
      while (list.length > 128) list.shift();
    }
    return list;
  };
  // Scenes: written when their entities, cells or look changed; created / removed with the index.
  for (const [id, scene] of after.scenes) {
    const prev = before.scenes.get(id);
    // A scene the command did not touch is the same object (or
    // holds the same entity array) — skip it without serializing it; only the
    // edited scene is compared by value.
    // The scene's block cells count too (they live in its chunk files), and its look.
    const sameBlocks = prev !== undefined && (prev.blocks === scene.blocks || JSON.stringify(prev.blocks ?? null) === JSON.stringify(scene.blocks ?? null));
    const sameLook = prev !== undefined && (prev.environment === scene.environment || JSON.stringify(prev.environment ?? null) === JSON.stringify(scene.environment ?? null));
    if (prev !== undefined && (prev === scene || (sameBlocks && sameLook && (prev.entities === scene.entities || JSON.stringify(prev.entities) === JSON.stringify(scene.entities))))) continue;
    let rel = scenePaths.get(id);
    if (rel === undefined) {
      rel = newSceneRel(id);
      scenePaths.set(id, rel);
    }
    const recs = appendTo(rel);
    const stamped: SceneV4 = { ...scene, revision: after.revision };
    const bytes = sceneFileBytes(projectId, stamped, recs);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
    fileRecords.set(rel, recs);
    after.scenes.set(id, stamped);
    // The chunk files that changed, appeared or went away.
    const chunks = sceneChunkFiles(projectId, stamped);
    for (const [crel, f] of chunks) {
      if (files.get(crel)?.hash === f.hash) continue;
      writes.push({ rel: crel, bytes: f.bytes });
      files.set(crel, f);
    }
    for (const crel of chunkRelsOf(prev)) {
      if (chunks.has(crel) || !files.has(crel)) continue;
      writes.push({ rel: crel, bytes: null });
      files.delete(crel);
    }
  }
  for (const id of before.scenes.keys()) {
    if (after.scenes.has(id)) continue;
    const rel = sceneRelOf(before, id);
    scenePaths.delete(id);
    formerPaths.set(formerKey('scene', id), rel);
    writes.push({ rel, bytes: null });
    files.delete(rel);
    fileRecords.delete(rel);
    for (const crel of chunkRelsOf(before.scenes.get(id))) {
      if (!files.has(crel)) continue;
      writes.push({ rel: crel, bytes: null });
      files.delete(crel);
    }
  }
  const sceneWritten = writes.some((w) => w.bytes !== null && !isChunkRel(w.rel));
  // Scene files a move puts elsewhere: the same bytes at the new key.
  for (const [key, rel] of place.moved ?? []) {
    if (!key.startsWith(formerKey('scene', ''))) continue;
    const id = key.slice(formerKey('scene', '').length);
    const old = scenePaths.get(id) ?? sceneRel(id);
    const f = files.get(old);
    if (old === rel || f === undefined) continue;
    writes.push({ rel, bytes: f.bytes });
    files.set(rel, f);
    writes.push({ rel: old, bytes: null });
    files.delete(old);
    const recs = fileRecords.get(old);
    fileRecords.delete(old);
    if (recs !== undefined) fileRecords.set(rel, recs);
    if (rel === sceneRel(id)) scenePaths.delete(id);
    else scenePaths.set(id, rel);
  }
  // Resources: each record the command added, changed or removed is one file.
  const resourcePaths = resourceWrites(before, after.content, writes, files, place, formerPaths);
  // Content: written when the project-wide settings changed, or when no scene file carries the record.
  if (projectWideChanged(before.content, after.content) || !sceneWritten) {
    const recs = appendTo(CONTENT_REL);
    const bytes = contentFileBytes(projectId, after.revision, after.content, recs);
    writes.push({ rel: CONTENT_REL, bytes });
    files.set(CONTENT_REL, { bytes, hash: sha256Hex(bytes) });
    fileRecords.set(CONTENT_REL, recs);
  }
  return { writes, commitFiles: () => files.commit(), fileRecords, resourcePaths, scenePaths, formerPaths };
}

/**
 * The known files as a transaction changes them: the project's thousands of
 * files are not copied per command. The changes apply to the known files
 * once the transaction is written (the state they belong to is then gone).
 */
class FileDelta {
  private readonly changes = new Map<string, KnownFile | null>();
  constructor(private readonly base: Map<string, KnownFile>) {}
  get(rel: string): KnownFile | undefined {
    const c = this.changes.get(rel);
    return c === undefined ? this.base.get(rel) : (c ?? undefined);
  }
  has(rel: string): boolean {
    return this.get(rel) !== undefined;
  }
  set(rel: string, f: KnownFile): void {
    this.changes.set(rel, f);
  }
  delete(rel: string): void {
    this.changes.set(rel, null);
  }
  commit(): Map<string, KnownFile> {
    for (const [rel, f] of this.changes) {
      if (f === null) this.base.delete(rel);
      else this.base.set(rel, f);
    }
    this.changes.clear();
    return this.base;
  }
}

/** The chunk files a scene (as last written) has. */
function chunkRelsOf(scene: SceneV4 | undefined): string[] {
  const out: string[] = [];
  for (const b of scene?.blocks ?? []) for (const c of b.chunks ?? []) out.push(chunkRel(scene!.sceneId, b.entityId, c.cx, c.cz));
  return out;
}

/**
 * The resource files a new content block needs written or removed: in each
 * list the command replaced, a record that is not the same object as before
 * is written (at its file's path, or its kind's folder when new), and a
 * record that is gone is removed. Lists the command left alone are not read.
 */
function resourceWrites(before: V4State, next: V4State['content'], writes: FileWrite[], files: FileDelta, place: Placement, formerPaths: Map<string, string>): ResourcePaths {
  const out = new Map(before.resourcePaths);
  // Assets: each record with a file is its sidecar (written where its file is; a moved file's old sidecar goes).
  if (before.content.assets !== next.assets) {
    const prev = new Map((before.content.assets as unknown as RecordLike[]).map((a) => [a.assetId, a]));
    const kept = new Set<string>();
    const removeAt = (file: string | null): void => {
      if (file === null) return;
      const rel = gameRel(sidecarPath(file));
      if (!files.has(rel) || writes.some((w) => w.rel === rel)) return;
      writes.push({ rel, bytes: null });
      files.delete(rel);
    };
    for (const a of next.assets as unknown as RecordLike[]) {
      kept.add(a.assetId);
      const p = prev.get(a.assetId);
      if (p === a) continue;
      const oldFile = p === undefined ? null : fileOfRecord(p);
      const w = sidecarWrite(a);
      if (oldFile !== null && oldFile !== fileOfRecord(a)) removeAt(oldFile);
      if (w === null) continue;
      const hash = sha256Hex(w.bytes as Uint8Array);
      if (files.get(w.rel)?.hash === hash) continue;
      const at = writes.findIndex((x) => x.rel === w.rel);
      if (at >= 0) writes.splice(at, 1);
      writes.push(w);
      files.set(w.rel, { bytes: w.bytes as Uint8Array, hash });
    }
    for (const [id, a] of prev) if (!kept.has(id)) removeAt(fileOfRecord(a));
  }
  const prevContent = before.content as unknown as Record<string, unknown>;
  const nextContent = next as unknown as Record<string, unknown>;
  // A resource whose address or labels changed is written again (they are in its file).
  const loading = loadingByKey(next);
  const loadingChanged = new Set<string>();
  if (prevContent[LOADABLE_KEY] !== nextContent[LOADABLE_KEY]) {
    const was = loadingByKey(before.content);
    for (const key of new Set([...was.keys(), ...loading.keys()])) if (JSON.stringify(was.get(key)) !== JSON.stringify(loading.get(key))) loadingChanged.add(key);
  }
  const loadingKinds = new Set([...loadingChanged].map((key) => key.slice(0, key.indexOf(':'))));
  const movedLists = new Set([...(place.moved?.keys() ?? [])].map((key) => key.slice(0, key.indexOf('\u0000'))));
  for (const k of RESOURCE_KINDS) {
    const a = recordsOfKind(prevContent, k);
    const b = recordsOfKind(nextContent, k);
    const rewrite = loadingKinds.has(k.kind) || movedLists.has(k.list);
    if (a === b && !rewrite) continue;
    // A command replaces a few records and keeps the others in place: records at the same position are
    // compared first; the lists are matched by id, and the paths copied, only when something differs.
    const beforePaths = before.resourcePaths.get(k.list);
    let paths: Map<string, string> | null = null;
    const pathOf = (id: string): string | undefined => (paths ?? beforePaths)?.get(id);
    const setPath = (id: string, path: string): void => {
      if (pathOf(id) !== path) (paths ??= new Map(beforePaths ?? [])).set(id, path);
    };
    const deletePath = (id: string): void => {
      if ((paths ?? beforePaths)?.has(id) === true) (paths ??= new Map(beforePaths ?? [])).delete(id);
    };
    let prevById: Map<string, unknown> | null = null;
    const prevOf = (i: number, id: string): unknown => {
      const at = a?.[i];
      if (at !== undefined && String(at[k.idKey]) === id) return at;
      return (prevById ??= new Map((a ?? []).map((r) => [String(r[k.idKey]), r] as const))).get(id);
    };
    let aligned = a !== undefined && b !== undefined && a.length === b.length;
    if (b !== undefined) {
      for (let i = 0; i < b.length; i += 1) {
        const r = b[i]!;
        if (aligned && a![i] === r && !rewrite) continue;
        const id = String(r[k.idKey]);
        if (aligned && String(a![i]?.[k.idKey]) !== id) aligned = false;
        const movedTo = place.moved?.get(formerKey(k.list, id));
        if (movedTo !== undefined && pathOf(id) !== undefined && pathOf(id) !== movedTo) {
          // Moved: the file goes (the record is written at its new path below).
          const old = gameRel(pathOf(id)!);
          if (files.has(old)) {
            writes.push({ rel: old, bytes: null });
            files.delete(old);
          }
          setPath(id, movedTo);
        } else if (prevOf(i, id) === r && !loadingChanged.has(`${k.kind}:${id}`)) continue;
        let path = pathOf(id);
        if (path === undefined) {
          // New here: adopted where it is, in the folder the request named, where it was before it was removed, or its kind's folder.
          const key = formerKey(k.list, id);
          path = place.at?.get(key) ?? (place.folder !== undefined ? defaultResourcePath(k, id, place.folder) : undefined) ?? formerPaths.get(key) ?? defaultResourcePath(k, id);
          formerPaths.delete(key);
        }
        setPath(id, path);
        const rel = gameRel(path);
        const bytes = resourceFileBytes(k, id, r, loading.get(`${k.kind}:${id}`));
        const hash = sha256Hex(bytes);
        if (files.get(rel)?.hash === hash) continue;
        writes.push({ rel, bytes });
        files.set(rel, { bytes, hash });
      }
    }
    if (!aligned) {
      const kept = new Set((b ?? []).map((r) => String(r[k.idKey])));
      for (const r of a ?? []) {
        const id = String(r[k.idKey]);
        if (kept.has(id)) continue;
        const path = pathOf(id);
        deletePath(id);
        if (path === undefined) continue;
        formerPaths.set(formerKey(k.list, id), path);
        writes.push({ rel: gameRel(path), bytes: null });
        files.delete(gameRel(path));
      }
    }
    out.set(k.list, paths ?? beforePaths ?? new Map());
  }
  return out;
}

/** Whether the project-wide part of the content block (what `content.json` holds) differs; both blocks are canonical. */
function projectWideChanged(a: V4State['content'], b: V4State['content']): boolean {
  if (a === b) return false;
  const x = projectWidePart(a);
  const y = projectWidePart(b);
  const keys = Object.keys(x);
  if (keys.join('\0') !== Object.keys(y).join('\0')) return true;
  return keys.some((k) => x[k] !== y[k] && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
}

/**
 * Put back the sidecars of assets whose file is there but whose sidecar is
 * gone (removed by hand): the session's records are the last committed ones.
 * Written like any project file (one transaction); returns what failed.
 */
export function restoreSidecars(core: Core, s: ProjectSession, records: readonly RecordLike[]): string[] {
  const state = s.v4;
  if (state === null || state === undefined || s.pendingChange !== null || records.length === 0) return [];
  const gameRoot = gameRootOf(s);
  const known = new Map(state.files);
  const writes: FileWrite[] = [];
  for (const r of records) {
    const w = sidecarWrite(r);
    if (w === null) continue;
    known.delete(w.rel);
    writes.push(w);
  }
  if (writes.length === 0) return [];
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, known, writes, gameRoot);
  if (!res.ok) return writes.map((w) => `the sidecar ${gamePathOf(w.rel) ?? w.rel} could not be written`);
  const files = new Map(state.files);
  for (const w of writes) files.set(w.rel, { bytes: w.bytes as Uint8Array, hash: sha256Hex(w.bytes as Uint8Array) });
  publishV4(s, { ...state, files });
  return [];
}

// ---- external changes --------------------------------------------------------------

/** Pause on a foreign project file: snapshot it, re-read the project, record the pending change. */
export function detectExternalChangeV4(core: Core, s: ProjectSession, foreign: { rel: string; bytes: Uint8Array; hash: string }): PendingChange & { snapshotState: 'ok' | 'snapshot_failed' } {
  const snapshotName = foreign.bytes.length > 0 ? snapshotForeignFile(s.thirdlightDir, foreign.bytes, core.ops, core.stamp) : 'deleted';
  const l = loadV4(core.ops, s.dir, s.projectId, gameRootOf(s));
  const pending = {
    snapshotState: snapshotName === null ? ('snapshot_failed' as const) : ('ok' as const),
    externalHash: foreign.hash,
    externalValid: l.kind === 'loaded',
    externalErrors: l.kind === 'loaded' ? [] : l.errors,
    externalScene: l.kind === 'loaded' ? primaryScene(l.state) : null,
    externalContent: l.kind === 'loaded' ? l.state.content : null,
    externalStorageVersion: 4 as const,
    externalV4: l.kind === 'loaded' ? l.state : null,
    externalFile: foreign.rel,
  };
  s.pendingChange = pending as PendingChange;
  return pending as PendingChange & { snapshotState: 'ok' | 'snapshot_failed' };
}

/** The poll check: any project file that differs pauses the project. */
export function checkExternalV4(core: Core, s: ProjectSession): { ok: true; pending: boolean } {
  if (s.pendingChange !== null) return { ok: true, pending: true };
  if (s.v4 === null || s.v4 === undefined) return { ok: true, pending: false };
  const changed = firstChangedFile(core.ops, s.dir, gameRootOf(s), s.v4);
  if (changed === null) return { ok: true, pending: false };
  if ('unreadable' in changed) return { ok: true, pending: false }; // the next write reports it
  detectExternalChangeV4(core, s, changed);
  return { ok: true, pending: true };
}

/** What is on disk now, for the files a resolution rewrites (the pre-write baseline). */
function diskBaseline(core: Core, s: ProjectSession, rels: Iterable<string>): Map<string, KnownFile> {
  const out = new Map<string, KnownFile>();
  for (const rel of rels) {
    try {
      const bytes = core.ops.readFile(absOf(s.dir, gameRootOf(s), rel));
      out.set(rel, { bytes, hash: sha256Hex(bytes) });
    } catch {
      // absent: the resolution recreates it
    }
  }
  return out;
}

/** The public summary of a pending change (the external-change error payloads). */
function infoOf<T extends PendingChange>(pc: T): { snapshotState: T['snapshotState']; externalHash: string | null; externalValid: boolean | null; externalErrorCount: number | null } {
  return { snapshotState: pc.snapshotState, externalHash: pc.externalHash, externalValid: pc.externalValid, externalErrorCount: pc.externalErrors?.length ?? null };
}

/** The unreadable pending state (the bytes of `rel` are unknown): nothing read, nothing snapshotted. */
export function setPendingUnreadableV4(s: ProjectSession, rel: string): void {
  s.pendingChange = {
    snapshotState: 'unreadable',
    externalHash: null,
    externalValid: null,
    externalErrors: null,
    externalScene: null,
    externalContent: null,
    externalStorageVersion: null,
    externalFile: rel,
  };
}

/**
 * The resolution refusal clause for v4: while the pending change's evidence is
 * missing (`snapshot_failed`) or its bytes are unknown (`unreadable`), a
 * resolution first re-reads the project files (the pending file first):
 * - still unreadable ⇒ refused `external_change_unreadable`;
 * - every file is this backend's own again ⇒ proceed (nothing foreign on disk);
 * - the same foreign bytes (or any readable bytes for an unreadable pending
 *   change) ⇒ the detection re-runs (the snapshot is retried): proceed when it
 *   is durable, else refused `external_change_evidence_missing`;
 * - other foreign bytes ⇒ the protocol re-fires, refused `external_change_unresolved`.
 */
function rereadForResolutionV4(core: Core, s: ProjectSession): { ok: true } | { ok: false; error: import('@thirdlight/commands').CommandError } {
  const state = s.v4 as V4State;
  const pc = s.pendingChange as PendingChange & { externalFile?: string };
  let found = pc.externalFile !== undefined ? changedFile(core.ops, s.dir, gameRootOf(s), pc.externalFile, state.files.get(pc.externalFile)) : null;
  if (found === null) found = firstChangedFile(core.ops, s.dir, gameRootOf(s), state);
  if (found === null) return { ok: true };
  if ('unreadable' in found) {
    setPendingUnreadableV4(s, found.rel);
    return { ok: false, error: externalChangeUnreadable(s.projectId) };
  }
  const same = pc.snapshotState === 'unreadable' || (found.rel === pc.externalFile && found.hash === pc.externalHash);
  const again = detectExternalChangeV4(core, s, found);
  if (!same) return { ok: false, error: externalChangeUnresolved(infoOf(again)) };
  if (again.snapshotState !== 'ok') return { ok: false, error: externalChangeEvidenceMissing(s.projectId, infoOf(again)) };
  return { ok: true };
}

/** `acceptExternalState` for v4: the files on disk become the project (records cleared, new history). */
export function acceptExternalV4(core: Core, s: ProjectSession): { ok: true; revision: number; historyReset: true; retryCleared: true } | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null) return { ok: false, error: noPendingChange() };
  if (s.pendingChange.snapshotState !== 'ok') {
    const rr = rereadForResolutionV4(core, s);
    if (!rr.ok) return rr;
  }
  // Re-read now: the resolution is never answered from a stale read.
  const l = loadV4(core.ops, s.dir, s.projectId, gameRootOf(s));
  if (l.kind !== 'loaded') return { ok: false, error: externalChangeInvalid() };
  // Rewrite every file canonically with the retry records cleared (a new retry boundary).
  const state = l.state;
  const writes: FileWrite[] = [];
  const files = new Map<string, KnownFile>();
  const contentBytes = contentFileBytes(s.projectId, state.revision, state.content, []);
  writes.push({ rel: CONTENT_REL, bytes: contentBytes });
  files.set(CONTENT_REL, { bytes: contentBytes, hash: sha256Hex(contentBytes) });
  for (const scene of state.scenes.values()) {
    const bytes = sceneFileBytes(s.projectId, scene, []);
    const rel = sceneRelOf(state, scene.sceneId);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
    // Its chunk files, canonical.
    for (const [crel, f] of sceneChunkFiles(s.projectId, scene)) {
      writes.push({ rel: crel, bytes: f.bytes });
      files.set(crel, f);
    }
  }
  const man = manifestV2Bytes(state.manifest);
  files.set(MANIFEST_REL_V4, { bytes: man, hash: sha256Hex(man) });
  // The resource files are what is on disk already.
  for (const [rel, f] of state.files) if (gamePathOf(rel) !== null && !files.has(rel)) files.set(rel, f);
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, diskBaseline(core, s, writes.map((w) => w.rel)), writes, gameRootOf(s));
  if (!res.ok) {
    if ('unreadable' in res) return { ok: false, error: externalChangeUnreadable(s.projectId) };
    if ('external' in res) {
      const again = detectExternalChangeV4(core, s, res.external);
      return { ok: false, error: externalChangeUnresolved({ snapshotState: again.snapshotState, externalHash: again.externalHash, externalValid: again.externalValid, externalErrorCount: again.externalErrors?.length ?? null }) };
    }
    if (res.failed.onDiskState === 'previous') return { ok: false, error: writeFailed('previous', res.failed.errno) };
  }
  const fileRecords = new Map<string, RetryRecord[]>([...files.keys()].map((rel) => [rel, []]));
  const next: V4State = { ...state, files, fileRecords };
  publishV4(s, next);
  s.history = freshHistoryV4(next);
  s.pendingChange = null;
  if (!res.ok) return { ok: false, error: writeFailed('new-undurable', res.failed.errno) };
  return { ok: true, revision: s.revision, historyReset: true, retryCleared: true };
}

/** `discardExternalState` for v4: this backend's last known bytes go back on disk (new history). */
export function discardExternalV4(core: Core, s: ProjectSession): { ok: true; revision: number; historyReset: true } | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null || s.v4 === null || s.v4 === undefined) return { ok: false, error: noPendingChange() };
  if (s.pendingChange.snapshotState !== 'ok') {
    const rr = rereadForResolutionV4(core, s);
    if (!rr.ok) return rr;
  }
  const pc = s.pendingChange;
  const state = s.v4;
  const baseline = diskBaseline(core, s, state.files.keys());
  // The resolution overwrites only bytes that are known: this backend's own,
  // or the pending (snapshotted) foreign bytes of the pending file. Any other
  // change on disk has no snapshot yet: the protocol re-fires (snapshot, new
  // pending change) instead of destroying it.
  const pendingFile = (pc as PendingChange & { externalFile?: string }).externalFile;
  for (const [rel, known] of state.files) {
    if (isSidecarRel(rel)) continue;
    const onDisk = baseline.get(rel);
    const hash = onDisk?.hash ?? sha256Hex(new Uint8Array(0));
    if (hash === known.hash || (rel === pendingFile && hash === pc.externalHash)) continue;
    const again = detectExternalChangeV4(core, s, { rel, bytes: onDisk?.bytes ?? new Uint8Array(0), hash });
    return { ok: false, error: externalChangeUnresolved({ snapshotState: again.snapshotState, externalHash: again.externalHash, externalValid: again.externalValid, externalErrorCount: again.externalErrors?.length ?? null }) };
  }
  const writes: FileWrite[] = [];
  for (const [rel, known] of state.files) {
    if (isSidecarRel(rel) || baseline.get(rel)?.hash === known.hash) continue;
    writes.push({ rel, bytes: known.bytes });
  }
  if (writes.length > 0) {
    const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, baseline, writes, gameRootOf(s));
    if (!res.ok) {
      if ('unreadable' in res) return { ok: false, error: externalChangeUnreadable(s.projectId) };
      if ('external' in res) {
        const again = detectExternalChangeV4(core, s, res.external);
        return { ok: false, error: externalChangeUnresolved({ snapshotState: again.snapshotState, externalHash: again.externalHash, externalValid: again.externalValid, externalErrorCount: again.externalErrors?.length ?? null }) };
      }
      if (res.failed.onDiskState === 'previous') return { ok: false, error: writeFailed('previous', res.failed.errno) };
      // new-undurable: the last known bytes are back on disk (durability
      // unproven): the resolution is applied in memory, the failure reported.
      s.history = freshHistoryV4(state);
      s.pendingChange = null;
      return { ok: false, error: writeFailed('new-undurable', res.failed.errno) };
    }
  }
  s.history = freshHistoryV4(state);
  s.pendingChange = null;
  return { ok: true, revision: s.revision, historyReset: true };
}

/** The release rewrite for v4: every file with its retry records cleared. */
export function clearRecordsV4(core: Core, s: ProjectSession): { ok: true } | { ok: false; error: import('@thirdlight/commands').CommandError } {
  const state = s.v4;
  if (state === null || state === undefined) return { ok: true };
  const writes: FileWrite[] = [];
  const files = new Map(state.files);
  const sceneOfRel = new Map([...state.scenes.keys()].map((id) => [sceneRelOf(state, id), id]));
  for (const [rel, recs] of state.fileRecords) {
    if (recs.length === 0) continue;
    const sceneId = sceneOfRel.get(rel);
    if (rel !== CONTENT_REL && sceneId === undefined) continue;
    const bytes =
      rel === CONTENT_REL
        ? contentFileBytes(s.projectId, (JSON.parse(new TextDecoder().decode(state.files.get(rel)!.bytes)) as { revision: number }).revision, state.content, [])
        : sceneFileBytes(s.projectId, state.scenes.get(sceneId!)!, []);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
  }
  if (writes.length === 0) return { ok: true };
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, state.files, writes, gameRootOf(s));
  if (!res.ok) {
    if ('external' in res) {
      detectExternalChangeV4(core, s, res.external);
      return { ok: false, error: projectUnavailable('external_change_unresolved', null, []) };
    }
    if ('unreadable' in res) return { ok: false, error: projectUnavailable('external_change_unreadable', null, []) };
    if (res.failed.onDiskState === 'previous') return { ok: false, error: writeFailed('previous', res.failed.errno) };
  }
  const fileRecords = new Map<string, RetryRecord[]>([...state.fileRecords.keys()].map((rel) => [rel, []]));
  publishV4(s, { ...state, files, fileRecords });
  // new-undurable: the cleared files are on disk but not proven durable — a
  // crash could bring the records back, so the release must not complete.
  if (!res.ok) return { ok: false, error: writeFailed('new-undurable', res.failed.errno) };
  return { ok: true };
}

// ---- queries ------------------------------------------------------------------------

/** The scene holding an entity (null when no scene does). */
export function sceneOfEntity(state: V4State, entityId: string): SceneV4 | null {
  for (const scene of state.scenes.values()) if (scene.entities.some((e) => e.id === entityId)) return scene;
  return null;
}

/** The lists `queryGameConfig` may leave out (read by id from the index: `queryIndex {kind, ids, records: true}`). */
export const GAME_CONFIG_OMITTABLE: readonly string[] = ['dialogues', 'graphs', 'timelines', 'uiDocuments', 'effects'];

type QueryOp = 'queryProject' | 'queryEntity' | 'queryEntities' | 'queryAssets' | 'queryPrefabs' | 'queryBehaviors' | 'queryGameConfig' | 'queryBlocks' | 'queryIndex';

function failure(op: string, projectId: string, error: import('@thirdlight/commands').CommandError): QueryResult {
  return { ok: false, op, projectId, error } as unknown as QueryResult;
}

/**
 * The v4 queries. `queryEntities` takes an optional `sceneId` (default: all
 * scenes, in index order, with `entitySceneIds` naming each entity's scene);
 * `queryEntity` reports the entity's `sceneId`; `queryProject` lists the
 * scene index and the start set; `queryGameConfig` adds them too (and,
 * with `args.descriptors: true`, the descriptor registry).
 */
export function serveQueryV4(s: ProjectSession, op: QueryOp, projectId: string, args: Record<string, unknown> | undefined, workspace: unknown): QueryResult {
  const state = s.v4 as V4State;
  const tags = (state.content.tags ?? []).map((t) => ({ bit: t.bit, name: t.name }));
  if (op === 'queryAssets' || op === 'queryPrefabs' || op === 'queryBehaviors' || op === 'queryGameConfig') {
    const cs = createCommandState({ ...primaryScene(state), revision: state.revision }, commandContentOf(state.content));
    const request: Record<string, unknown> = { op, projectId };
    // `queryGameConfig {descriptors: true}` adds the component and
    // content descriptor registry (asked for once; it is static and ~120 KB).
    let withDescriptors = false;
    if (op === 'queryGameConfig' && args !== undefined && Object.prototype.hasOwnProperty.call(args, 'descriptors')) {
      const d = args['descriptors'];
      if (typeof d !== 'boolean') return failure(op, projectId, fieldTypeError('/args/descriptors', d, 'boolean'));
      withDescriptors = d;
      const { descriptors: _d, ...rest } = args;
      args = rest;
    }
    // `queryGameConfig {omit: [...]}` leaves out lists the caller reads by id instead (a
    // project's conversations, for one, are read one at a time from the index).
    let omit: readonly string[] = [];
    if (op === 'queryGameConfig' && args !== undefined && Object.prototype.hasOwnProperty.call(args, 'omit')) {
      const o = args['omit'];
      if (!Array.isArray(o) || !o.every((x) => typeof x === 'string' && GAME_CONFIG_OMITTABLE.includes(x))) return failure(op, projectId, fieldValueType('/args/omit', o, `a list of: ${GAME_CONFIG_OMITTABLE.join(', ')}`, 'omit names lists of the reply'));
      omit = o as string[];
      const { omit: _o, ...rest } = args;
      args = rest;
    }
    if (args !== undefined) request['args'] = args;
    const result = op === 'queryAssets' ? queryAssets(cs, request) : op === 'queryPrefabs' ? queryPrefabs(cs, request) : op === 'queryBehaviors' ? queryBehaviors(cs, request) : queryGameConfig(cs, request);
    if (op === 'queryGameConfig' && (result as { ok?: boolean }).ok === true) {
      // The project materials and the environment travel with the game block.
      const reply = {
        ...(result as object),
        scenes: state.content.scenes.map((e) => ({ ...e })),
        startScenes: [...state.content.startScenes],
        materials: JSON.parse(JSON.stringify(state.content.materials ?? [])) as unknown,
        environment: state.content.environment !== undefined ? (JSON.parse(JSON.stringify(state.content.environment)) as unknown) : null,
        lighting: state.content.lighting !== undefined ? (JSON.parse(JSON.stringify(state.content.lighting)) as unknown) : null,
        animators: JSON.parse(JSON.stringify(state.content.animators ?? [])) as unknown,
        input: state.content.input !== undefined ? (JSON.parse(JSON.stringify(state.content.input)) as unknown) : null,
        // A 3D project's defaults (a 2D move and a run button).
        inputDefaults: JSON.parse(JSON.stringify(defaultInputFor(physicsDimensionOf(state.content.settings) === 3 ? 3 : 2))) as unknown,
        flow: (state.content as { flow?: unknown }).flow !== undefined ? (JSON.parse(JSON.stringify((state.content as { flow?: unknown }).flow)) as unknown) : null,
        // Standalone graph documents (and, with the descriptors, the graph kinds' catalogues).
        ...(omit.includes('graphs') ? {} : { graphs: JSON.parse(JSON.stringify((state.content as { graphs?: unknown[] }).graphs ?? [])) as unknown }),
        // Visual effects (systems and their graphs).
        ...(omit.includes('effects') ? {} : { effects: JSON.parse(JSON.stringify((state.content as { effects?: unknown[] }).effects ?? [])) as unknown }),
        // Block types, the cell metadata schema and stamps.
        blockTypes: JSON.parse(JSON.stringify((state.content as { blockTypes?: unknown[] }).blockTypes ?? [])) as unknown,
        cellFields: JSON.parse(JSON.stringify((state.content as { cellFields?: unknown[] }).cellFields ?? [])) as unknown,
        blockStamps: JSON.parse(JSON.stringify((state.content as { blockStamps?: unknown[] }).blockStamps ?? [])) as unknown,
        // Shared script libraries (their files).
        scriptLibraries: JSON.parse(JSON.stringify((state.content as { scriptLibraries?: unknown[] }).scriptLibraries ?? [])) as unknown,
        // Project UI documents and themes.
        ...(omit.includes('uiDocuments') ? {} : { uiDocuments: JSON.parse(JSON.stringify((state.content as { uiDocuments?: unknown[] }).uiDocuments ?? [])) as unknown }),
        uiThemes: JSON.parse(JSON.stringify((state.content as { uiThemes?: unknown[] }).uiThemes ?? [])) as unknown,
        // timelines.
        ...(omit.includes('timelines') ? {} : { timelines: JSON.parse(JSON.stringify((state.content as { timelines?: unknown[] }).timelines ?? [])) as unknown }),
        // The named collision layers.
        collisionLayers: [...((state.content as { collisionLayers?: string[] }).collisionLayers ?? [])],
        // The light layer names (editor labels by layer number).
        lightLayers: [...((state.content as { lightLayers?: string[] }).lightLayers ?? [])],
        // The game modes and behavior groups.
        modes: JSON.parse(JSON.stringify((state.content as { modes?: unknown[] }).modes ?? [])) as unknown,
        behaviorGroups: [...((state.content as { behaviorGroups?: string[] }).behaviorGroups ?? [])],
        // The event → cue table.
        eventCues: JSON.parse(JSON.stringify((state.content as { eventCues?: unknown[] }).eventCues ?? [])) as unknown,
        // The resources' addresses and labels (only those the project has).
        loadable: liveLoadable(state.content),
        // The game shell (null: none).
        shell: (state.content as { shell?: unknown }).shell !== undefined ? (JSON.parse(JSON.stringify((state.content as { shell?: unknown }).shell)) as unknown) : null,
        // The project save schema (null: no project saves).
        saveSchema: (state.content as { saveSchema?: unknown }).saveSchema !== undefined ? (JSON.parse(JSON.stringify((state.content as { saveSchema?: unknown }).saveSchema)) as unknown) : null,
        // Conversations, the speaker registry and the dialogue settings (null: the defaults).
        ...(omit.includes('dialogues') ? {} : { dialogues: JSON.parse(JSON.stringify((state.content as { dialogues?: unknown[] }).dialogues ?? [])) as unknown }),
        speakers: JSON.parse(JSON.stringify((state.content as { speakers?: unknown[] }).speakers ?? [])) as unknown,
        dialogueSettings: (state.content as { dialogueSettings?: unknown }).dialogueSettings !== undefined ? (JSON.parse(JSON.stringify((state.content as { dialogueSettings?: unknown }).dialogueSettings)) as unknown) : null,
        // The settings map (the editor's Scene view reads render_backend at load).
        settings: JSON.parse(JSON.stringify((state.content as { settings?: unknown }).settings ?? {})) as unknown,
        ...(withDescriptors ? { descriptors: JSON.parse(JSON.stringify(DESCRIPTORS)) as unknown, graphKinds: JSON.parse(JSON.stringify(GRAPH_KINDS)) as unknown } : {}),
      };
      return reply as unknown as QueryResult;
    }
    return result as unknown as QueryResult;
  }
  const a = args ?? {};
  if (op === 'queryBlocks') return serveQueryBlocks(state, projectId, a);
  if (op === 'queryIndex') return serveQueryIndex(s, state, projectId, a);
  if (op === 'queryProject') {
    // `{environments: true}`: each scene row carries its look (sky, fog, post, wind) when it has one.
    for (const k of Object.keys(a)) if (k !== 'environments') return failure(op, projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'environments'));
    if (a['environments'] !== undefined && typeof a['environments'] !== 'boolean') return failure(op, projectId, fieldTypeError('/args/environments', a['environments'], 'boolean'));
    const looks = a['environments'] === true;
    const scene = primaryScene(state);
    return {
      ok: true,
      projectId,
      revision: state.revision,
      manifest: state.manifest,
      scene: {
        sceneId: scene.sceneId,
        schemaVersion: 4,
        entityCount: [...state.scenes.values()].reduce((n, x) => n + x.entities.length, 0),
      },
      scenes: state.content.scenes.map((e) => {
        const sc = state.scenes.get(e.sceneId);
        return { sceneId: e.sceneId, name: e.name, entityCount: sc?.entities.length ?? 0, ...(looks && sc?.environment !== undefined ? { environment: JSON.parse(JSON.stringify(sc.environment)) as unknown } : {}) };
      }),
      startScenes: [...state.content.startScenes],
      history: { undoDepth: s.history.cursor, redoDepth: s.history.entries.length - s.history.cursor },
      workspace,
      tags,
    } as unknown as QueryResult;
  }
  if (op === 'queryEntity') {
    for (const k of Object.keys(a)) if (k !== 'entityId' && k !== 'includeSubtree') return failure(op, projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'entityId, includeSubtree'));
    const entityId = a['entityId'];
    if (typeof entityId !== 'string' || entityId.length === 0) return failure(op, projectId, fieldTypeError('/args/entityId', entityId, 'string'));
    const scene = sceneOfEntity(state, entityId);
    if (scene === null) return failure(op, projectId, entityNotFound(entityId));
    const entity = scene.entities.find((e) => e.id === entityId)!;
    const byId = new Map(scene.entities.map((e) => [e.id, e]));
    const parentChain: string[] = [];
    for (let cur = entity.parentId; cur !== undefined && byId.has(cur); cur = byId.get(cur)!.parentId) parentChain.unshift(cur);
    const childIds = scene.entities.filter((e) => e.parentId === entityId).map((e) => e.id);
    const effective = effectiveEntityFlags(scene.entities).get(entityId)?.tags ?? 0;
    const namesOf = (mask: number): string[] => tags.filter((t) => (mask & (1 << t.bit)) !== 0).map((t) => t.name);
    const out: Record<string, unknown> = {
      ok: true,
      projectId,
      revision: state.revision,
      sceneId: scene.sceneId,
      entity,
      parentChain,
      childIds,
      tagNames: { own: namesOf(((entity as { tags?: number }).tags ?? 0) >>> 0), effective: namesOf(effective) },
    };
    if (a['includeSubtree'] === true) {
      const inside = new Set([entityId]);
      for (const e of scene.entities) if (e.parentId !== undefined && inside.has(e.parentId)) inside.add(e.id);
      const entities = scene.entities.filter((e) => inside.has(e.id));
      out['subtree'] = { count: entities.length, entities };
    }
    return out as unknown as QueryResult;
  }
  // queryEntities
  for (const k of Object.keys(a)) {
    if (!['limit', 'offset', 'component', 'sceneId'].includes(k)) return failure(op, projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'limit, offset, component, sceneId'));
  }
  let limit = 100;
  if (a['limit'] !== undefined) {
    const l = a['limit'];
    if (!isSafeInt(l)) return failure(op, projectId, fieldTypeError('/args/limit', l, 'integer'));
    if (l < 1 || l > 16_384) return failure(op, projectId, fieldValueType('/args/limit', l, 'integer 1-16384', 'limit must be between 1 and 16384'));
    limit = l;
  }
  let offset = 0;
  if (a['offset'] !== undefined) {
    const o = a['offset'];
    if (!isSafeInt(o) || o < 0) return failure(op, projectId, fieldValueType('/args/offset', o, 'integer >= 0', 'offset must be >= 0'));
    offset = o;
  }
  const sceneId = a['sceneId'];
  if (sceneId !== undefined && (typeof sceneId !== 'string' || !state.scenes.has(sceneId))) {
    return failure(op, projectId, fieldValueType('/args/sceneId', sceneId, 'a scene id of the project', 'no such scene'));
  }
  const scenes = sceneId !== undefined ? [state.scenes.get(sceneId as string)!] : [...state.scenes.values()];
  let rows = scenes.flatMap((sc) => sc.entities.map((entity) => ({ entity, sceneId: sc.sceneId })));
  if (a['component'] !== undefined) {
    const f = filterEntitiesByComponent(rows.map((r) => r.entity) as unknown as readonly { components: Record<string, unknown> }[], a['component']);
    if (!f.ok) return failure(op, projectId, f.error);
    const keep = new Set((f.entities as unknown as { id: string }[]).map((e) => e.id));
    rows = rows.filter((r) => keep.has(r.entity.id));
  }
  const total = rows.length;
  const page = offset >= total ? [] : rows.slice(offset, offset + limit);
  return {
    ok: true,
    projectId,
    revision: state.revision,
    total,
    offset,
    limit,
    entities: page.map((r) => r.entity),
    entitySceneIds: page.map((r) => r.sceneId),
  } as unknown as QueryResult;
}

/**
 * `queryBlocks` — block-layer cells and regions for editors, MCP
 * and tools. `{sceneId?}` lists the layers (entity, component, cell count,
 * chunk keys, regions); `{entityId}` one layer: with `chunks: [[cx, cz], …]`
 * those chunks in their stored form (palette + runs; the editor reads what a
 * change named), with `box: [x0, y0, z0, x1, y1, z1]` the cells inside it as
 * `[x, y, z, paletteIndex]` rows plus the palette and each distinct value's
 * effective metadata (at most 65,536 cells), with `region: id` that region's
 * boxes and cells (at most 65,536).
 */
function serveQueryBlocks(state: V4State, projectId: string, a: Record<string, unknown>): QueryResult {
  const op = 'queryBlocks';
  for (const k of Object.keys(a)) if (!['sceneId', 'entityId', 'chunks', 'box', 'region'].includes(k)) return failure(op, projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'sceneId, entityId, chunks, box, region'));
  const layersOf = (sc: SceneV4): { entityId: string; sceneId: string; component: BlockLayerComponent; data: BlockLayerData | null }[] =>
    sc.entities
      .filter((e) => (e.components as { blockLayer?: unknown }).blockLayer !== undefined)
      .map((e) => ({ entityId: e.id, sceneId: sc.sceneId, component: (e.components as { blockLayer: BlockLayerComponent }).blockLayer, data: sc.blocks?.find((b) => b.entityId === e.id) ?? null }));
  const cellCount = (d: BlockLayerData | null): number => (d?.chunks ?? []).reduce((n, c) => n + c.columns.reduce((m, col) => { let t = 0; for (let i = 3; i < col.length; i += 3) t += col[i]!; return m + t; }, 0), 0);
  if (a['entityId'] === undefined) {
    const sceneId = a['sceneId'];
    if (sceneId !== undefined && (typeof sceneId !== 'string' || !state.scenes.has(sceneId))) return failure(op, projectId, fieldValueType('/args/sceneId', sceneId, 'a scene id of the project', 'no such scene'));
    const scenes = sceneId !== undefined ? [state.scenes.get(sceneId as string)!] : [...state.scenes.values()];
    const layers = scenes.flatMap(layersOf).map((l) => ({
      entityId: l.entityId,
      sceneId: l.sceneId,
      component: l.component,
      cells: cellCount(l.data),
      chunks: (l.data?.chunks ?? []).map((c) => [c.cx, c.cz]),
      regions: (l.data?.regions ?? []).map((r) => r.regionId),
    }));
    return { ok: true, projectId, revision: state.revision, layers } as unknown as QueryResult;
  }
  const entityId = a['entityId'];
  if (typeof entityId !== 'string') return failure(op, projectId, fieldTypeError('/args/entityId', entityId, 'string'));
  const scene = sceneOfEntity(state, entityId);
  const layer = scene === null ? undefined : layersOf(scene).find((l) => l.entityId === entityId);
  if (scene === null || layer === undefined) return failure(op, projectId, entityNotFound(entityId));
  const out: Record<string, unknown> = { ok: true, projectId, revision: state.revision, sceneId: scene.sceneId, entityId, component: layer.component, cells: cellCount(layer.data), regions: layer.data?.regions ?? [] };
  const chunks = a['chunks'];
  if (chunks !== undefined) {
    if (!Array.isArray(chunks) || chunks.length > 4096 || !chunks.every((c) => Array.isArray(c) && c.length === 2 && Number.isSafeInteger(c[0]) && Number.isSafeInteger(c[1]))) return failure(op, projectId, fieldValueType('/args/chunks', chunks, 'up to 4096 [cx, cz] pairs', 'chunks is a list of [cx, cz]'));
    const byKey = new Map((layer.data?.chunks ?? []).map((c) => [`${c.cx},${c.cz}`, c]));
    // A chunk that holds no cells any more is reported as null (the reader drops it).
    out['chunks'] = (chunks as number[][]).map((c) => ({ cx: c[0], cz: c[1], chunk: byKey.get(`${c[0]},${c[1]}`) ?? null }));
  } else if (a['box'] === undefined && a['region'] === undefined) {
    out['chunks'] = (layer.data?.chunks ?? []).map((c) => ({ cx: c.cx, cz: c.cz, chunk: c }));
  }
  const listCells = (inside: (x: number, y: number, z: number) => boolean): { rows: number[][]; palette: BlockCell[]; meta: Record<string, unknown>[] } | null => {
    const grid = BlockGrid.from(layer.component, layer.data);
    const types = new Map(((state.content as { blockTypes?: BlockType[] }).blockTypes ?? []).map((t) => [t.blockId, t]));
    const fields = (state.content as { cellFields?: CellField[] }).cellFields ?? [];
    const rows: number[][] = [];
    const palette: BlockCell[] = [];
    const meta: Record<string, unknown>[] = [];
    const remap = new Map<number, number>();
    let over = false;
    grid.forEach((x, y, z, idx) => {
      if (over || !inside(x, y, z)) return;
      if (rows.length >= 65_536) {
        over = true;
        return;
      }
      let p = remap.get(idx);
      if (p === undefined) {
        p = palette.length;
        remap.set(idx, p);
        const v = grid.valueOf(idx);
        palette.push(v);
        meta.push(effectiveCellMeta(v, types, fields));
      }
      rows.push([x, y, z, p]);
    });
    return over ? null : { rows, palette, meta };
  };
  const box = a['box'];
  if (box !== undefined) {
    if (!Array.isArray(box) || box.length !== 6 || !box.every((v) => Number.isSafeInteger(v))) return failure(op, projectId, fieldValueType('/args/box', box, '[x0, y0, z0, x1, y1, z1] integers', 'box is [x0, y0, z0, x1, y1, z1] (max exclusive)'));
    const b = box as number[];
    const listed = listCells((x, y, z) => boxContains(b, x, y, z));
    if (listed === null) return failure(op, projectId, fieldValueType('/args/box', box, 'a box holding at most 65536 cells', 'the box holds more than 65,536 cells; ask for a smaller box or for chunks'));
    out['box'] = { box: b, cells: listed.rows, palette: listed.palette, meta: listed.meta };
  }
  const region = a['region'];
  if (region !== undefined) {
    const r = (layer.data?.regions ?? []).find((x) => x.regionId === region);
    if (r === undefined) return failure(op, projectId, fieldValueType('/args/region', region, 'a region id of this layer', 'no such region in this layer'));
    const cells = regionCells(r.boxes, 65_536);
    if (cells === null) return failure(op, projectId, fieldValueType('/args/region', region, 'a region of at most 65536 cells', 'the region covers more than 65,536 cells'));
    const listed = listCells((x, y, z) => regionContains(r.boxes, x, y, z));
    out['region'] = { regionId: r.regionId, boxes: r.boxes, cells, occupied: listed?.rows ?? [], palette: listed?.palette ?? [], meta: listed?.meta ?? [] };
  }
  return out as unknown as QueryResult;
}
