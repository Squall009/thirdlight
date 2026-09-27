/**
 * Phase 12 (c): the session side of storage v4 (see `store-v4.ts`) — open
 * (with the automatic v3 → v4 upgrade), publish, external changes, release,
 * and the scene-aware queries. The v1–v3 single-envelope paths in
 * `session.ts` are unchanged; they branch here for a v4 project.
 */

import { createCommandState, filterEntitiesByComponent, queryAssets, queryBehaviors, queryGameConfig, queryPrefabs } from '@thirdlight/commands';
import type { ContentDocument, HistoryState } from '@thirdlight/commands';
import { BlockGrid, boxContains, effectiveCellMeta, regionCells, regionContains, type BlockCell, type BlockLayerComponent, type BlockLayerData, type BlockType, type CellField } from '@thirdlight/project-model';
import { composeV4, defaultInputFor, DESCRIPTORS, physicsDimensionOf, effectiveEntityFlags, GRAPH_KINDS, glbClipDurations, migrateModelAnimations, validateContentV4, validateSceneV4, type ContentCatalogV3, type Manifest, type ModelErrorV3, type ProjectManifestV2, type SceneV3, type SceneV4 } from '@thirdlight/project-model';

import { loadPreparedSources, readBlob, type ContentContext } from './content-store';
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
  sceneRel,
  snapshotForeignFile,
  writeTransaction,
  type FileWrite,
  type KnownFile,
  type V4State,
} from './store-v4';
import { EMPTY_BYTES } from './write';
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

/** One digest over all the project's files (for the LKG hash field). */
function combinedHash(files: ReadonlyMap<string, KnownFile>): string {
  const lines = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, f]) => `${rel}:${f.hash}`);
  return sha256Hex(new TextEncoder().encode(lines.join('\n')));
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
  s.v4 = state;
  s.storageVersion = 4;
  s.scene = scene;
  s.content = state.content;
  s.manifest = legacyManifestOf(state.manifest, scene.sceneId);
  s.revision = state.revision;
  const records = mergedRecords(state);
  s.records = records;
  s.recordMap = new Map(records.map((r) => [r.requestId, r]));
  s.lastWrittenHash = combinedHash(state.files);
  s.envelopeBytes = EMPTY_BYTES;
}

/** A fresh history for a v4 state (a history boundary). */
export function freshHistoryV4(state: V4State): HistoryState {
  return createCommandState(primaryScene(state), state.content as unknown as ContentDocument).history;
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
    lastWrittenHash: '',
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
  if (upgradeFrom !== undefined) {
    const m = migrateDirV3ToV4(core.ops, dir, thirdlightDir, projectId, upgradeFrom.manifest, upgradeFrom.scene, upgradeFrom.content, upgradeFrom.envelopeBytes);
    if (!m.ok) return { kind: 'blocked', reason: 'envelope_invalid', errors: [m.error], count: 1 };
    notes = m.notes;
  }
  const j = rollForwardJournal(core.ops, dir, thirdlightDir, projectId);
  if (!j.ok) return { kind: 'blocked', reason: 'envelope_invalid', errors: [j.error], count: 1 };
  const l = loadV4(core.ops, dir, projectId);
  if (l.kind === 'blocked') return l;
  const migrated = migrateModelAnimationsOnOpen(core, dir, thirdlightDir, projectId, l.state);
  return { kind: 'open', session: makeSessionV4(core, dir, projectId, migrated.state, ownership, sceneDir, thirdlightDir, [...notes, ...migrated.notes]) };
}

/**
 * Phase 14.6: the old `modelAnimation` idle/run/airborne profile becomes an
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
  const res = writeTransaction(core.ops, dir, thirdlightDir, projectId, state.files, plan.writes);
  if (!res.ok) return kept('the project files could not be written');
  return {
    state: { manifest: state.manifest, content: content.normalized, scenes: nextScenes, revision, files: plan.files, fileRecords: plan.fileRecords },
    notes: m.notes,
  };
}

/** Wrap an open-v4 outcome as the session layer's open outcome (blocked → caller builds the blocked session). */
export function toOpenOutcome(o: OpenV4Outcome): OpenOutcome | null {
  return o.kind === 'open' ? { kind: 'open', session: o.session } : null;
}

// ---- writing (the command path) ---------------------------------------------------

/** The files a new v4 state needs written, compared with what is on record. */
export function changedFiles(projectId: string, before: V4State, after: { content: V4State['content']; scenes: Map<string, SceneV4>; revision: number }, record: RetryRecord | null): {
  writes: FileWrite[];
  files: Map<string, KnownFile>;
  fileRecords: Map<string, RetryRecord[]>;
} {
  const writes: FileWrite[] = [];
  const files = new Map(before.files);
  const fileRecords = new Map(before.fileRecords);
  const appendTo = (rel: string): RetryRecord[] => {
    const list = [...(fileRecords.get(rel) ?? [])];
    if (record !== null) {
      list.push(record);
      while (list.length > 128) list.shift();
    }
    return list;
  };
  // Scenes: written when their entities changed; created / removed with the index.
  for (const [id, scene] of after.scenes) {
    const prev = before.scenes.get(id);
    // Phase 21.4: a scene the command did not touch is the same object (or
    // holds the same entity array) — skip it without serializing it; only the
    // edited scene is compared by value.
    // Phase 23.5: the scene's block cells count too (they live in its chunk files).
    const sameBlocks = prev !== undefined && (prev.blocks === scene.blocks || JSON.stringify(prev.blocks ?? null) === JSON.stringify(scene.blocks ?? null));
    if (prev !== undefined && (prev === scene || (sameBlocks && (prev.entities === scene.entities || JSON.stringify(prev.entities) === JSON.stringify(scene.entities))))) continue;
    const rel = sceneRel(id);
    const recs = appendTo(rel);
    const stamped: SceneV4 = { ...scene, revision: after.revision };
    const bytes = sceneFileBytes(projectId, stamped, recs);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
    fileRecords.set(rel, recs);
    after.scenes.set(id, stamped);
    // Phase 23.5: the chunk files that changed, appeared or went away.
    const chunks = sceneChunkFiles(projectId, stamped);
    for (const [crel, f] of chunks) {
      if (files.get(crel)?.hash === f.hash) continue;
      writes.push({ rel: crel, bytes: f.bytes });
      files.set(crel, f);
    }
    for (const crel of [...files.keys()]) {
      if (!isChunkRel(crel, id) || chunks.has(crel)) continue;
      writes.push({ rel: crel, bytes: null });
      files.delete(crel);
    }
  }
  for (const id of before.scenes.keys()) {
    if (after.scenes.has(id)) continue;
    const rel = sceneRel(id);
    writes.push({ rel, bytes: null });
    files.delete(rel);
    fileRecords.delete(rel);
    for (const crel of [...files.keys()]) {
      if (!isChunkRel(crel, id)) continue;
      writes.push({ rel: crel, bytes: null });
      files.delete(crel);
    }
  }
  // Content: written when it changed (or when no scene carries the record).
  const contentChanged = before.content !== after.content && JSON.stringify(before.content) !== JSON.stringify(after.content);
  if (contentChanged || writes.length === 0) {
    const recs = appendTo(CONTENT_REL);
    const bytes = contentFileBytes(projectId, after.revision, after.content, recs);
    writes.push({ rel: CONTENT_REL, bytes });
    files.set(CONTENT_REL, { bytes, hash: sha256Hex(bytes) });
    fileRecords.set(CONTENT_REL, recs);
  }
  return { writes, files, fileRecords };
}

// ---- external changes --------------------------------------------------------------

/** Pause on a foreign project file: snapshot it, re-read the project, record the pending change. */
export function detectExternalChangeV4(core: Core, s: ProjectSession, foreign: { rel: string; bytes: Uint8Array; hash: string }): PendingChange & { snapshotState: 'ok' | 'snapshot_failed' } {
  const snapshotName = foreign.bytes.length > 0 ? snapshotForeignFile(s.thirdlightDir, foreign.bytes, core.ops, core.stamp) : 'deleted';
  const l = loadV4(core.ops, s.dir, s.projectId);
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
  const changed = firstChangedFile(core.ops, s.dir, s.v4);
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
      const bytes = core.ops.readFile(`${s.dir}/${rel}`);
      out.set(rel, { bytes, hash: sha256Hex(bytes) });
    } catch {
      // absent: the resolution recreates it
    }
  }
  return out;
}

/** The public summary of a pending change (the §11 error payloads). */
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
 * The §7.3 refusal clause for v4: while the pending change's evidence is
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
  let found = pc.externalFile !== undefined ? changedFile(core.ops, s.dir, pc.externalFile, state.files.get(pc.externalFile)) : null;
  if (found === null) found = firstChangedFile(core.ops, s.dir, state);
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
  const l = loadV4(core.ops, s.dir, s.projectId);
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
    writes.push({ rel: sceneRel(scene.sceneId), bytes });
    files.set(sceneRel(scene.sceneId), { bytes, hash: sha256Hex(bytes) });
    // Phase 23.5: its chunk files, canonical.
    for (const [crel, f] of sceneChunkFiles(s.projectId, scene)) {
      writes.push({ rel: crel, bytes: f.bytes });
      files.set(crel, f);
    }
  }
  const man = manifestV2Bytes(state.manifest);
  files.set(MANIFEST_REL_V4, { bytes: man, hash: sha256Hex(man) });
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, diskBaseline(core, s, writes.map((w) => w.rel)), writes);
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
  // pending change) instead of destroying it (workspace.md §7).
  const pendingFile = (pc as PendingChange & { externalFile?: string }).externalFile;
  for (const [rel, known] of state.files) {
    const onDisk = baseline.get(rel);
    const hash = onDisk?.hash ?? sha256Hex(new Uint8Array(0));
    if (hash === known.hash || (rel === pendingFile && hash === pc.externalHash)) continue;
    const again = detectExternalChangeV4(core, s, { rel, bytes: onDisk?.bytes ?? new Uint8Array(0), hash });
    return { ok: false, error: externalChangeUnresolved({ snapshotState: again.snapshotState, externalHash: again.externalHash, externalValid: again.externalValid, externalErrorCount: again.externalErrors?.length ?? null }) };
  }
  const writes: FileWrite[] = [];
  for (const [rel, known] of state.files) {
    if (baseline.get(rel)?.hash === known.hash) continue;
    writes.push({ rel, bytes: known.bytes });
  }
  if (writes.length > 0) {
    const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, baseline, writes);
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
  for (const [rel, recs] of state.fileRecords) {
    if (recs.length === 0) continue;
    const bytes =
      rel === CONTENT_REL
        ? contentFileBytes(s.projectId, (JSON.parse(new TextDecoder().decode(state.files.get(rel)!.bytes)) as { revision: number }).revision, state.content, [])
        : sceneFileBytes(s.projectId, state.scenes.get(rel.slice('scenes/'.length, -'.json'.length))!, []);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
  }
  if (writes.length === 0) return { ok: true };
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, state.files, writes);
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

type QueryOp = 'queryProject' | 'queryEntity' | 'queryEntities' | 'queryAssets' | 'queryPrefabs' | 'queryBehaviors' | 'queryGameConfig' | 'queryBlocks';

function failure(op: string, projectId: string, error: import('@thirdlight/commands').CommandError): QueryResult {
  return { ok: false, op, projectId, error } as unknown as QueryResult;
}

/**
 * The v4 queries. `queryEntities` takes an optional `sceneId` (default: all
 * scenes, in index order, with `entitySceneIds` naming each entity's scene);
 * `queryEntity` reports the entity's `sceneId`; `queryProject` lists the
 * scene index and the start set; `queryGameConfig` adds them too (and,
 * with `args.descriptors: true`, the phase 15.0 descriptor registry).
 */
export function serveQueryV4(s: ProjectSession, op: QueryOp, projectId: string, args: Record<string, unknown> | undefined, workspace: unknown): QueryResult {
  const state = s.v4 as V4State;
  const tags = (state.content.tags ?? []).map((t) => ({ bit: t.bit, name: t.name }));
  if (op === 'queryAssets' || op === 'queryPrefabs' || op === 'queryBehaviors' || op === 'queryGameConfig') {
    const cs = createCommandState({ ...primaryScene(state), revision: state.revision }, state.content as unknown as ContentDocument);
    const request: Record<string, unknown> = { op, projectId };
    // Phase 15.0: `queryGameConfig {descriptors: true}` adds the component and
    // content descriptor registry (asked for once; it is static and ~120 KB).
    let withDescriptors = false;
    if (op === 'queryGameConfig' && args !== undefined && Object.prototype.hasOwnProperty.call(args, 'descriptors')) {
      const d = args['descriptors'];
      if (typeof d !== 'boolean') return failure(op, projectId, fieldTypeError('/args/descriptors', d, 'boolean'));
      withDescriptors = d;
      const { descriptors: _d, ...rest } = args;
      args = rest;
    }
    if (args !== undefined) request['args'] = args;
    const result = op === 'queryAssets' ? queryAssets(cs, request) : op === 'queryPrefabs' ? queryPrefabs(cs, request) : op === 'queryBehaviors' ? queryBehaviors(cs, request) : queryGameConfig(cs, request);
    if (op === 'queryGameConfig' && (result as { ok?: boolean }).ok === true) {
      // Phase 9.4: the project materials and the environment travel with the game block.
      return {
        ...(result as object),
        scenes: state.content.scenes.map((e) => ({ ...e })),
        startScenes: [...state.content.startScenes],
        materials: JSON.parse(JSON.stringify(state.content.materials ?? [])) as unknown,
        environment: state.content.environment !== undefined ? (JSON.parse(JSON.stringify(state.content.environment)) as unknown) : null,
        lighting: state.content.lighting !== undefined ? (JSON.parse(JSON.stringify(state.content.lighting)) as unknown) : null,
        animators: JSON.parse(JSON.stringify(state.content.animators ?? [])) as unknown,
        input: state.content.input !== undefined ? (JSON.parse(JSON.stringify(state.content.input)) as unknown) : null,
        // Phase 23.2: a 3D project's defaults (a 2D move and a run button).
        inputDefaults: JSON.parse(JSON.stringify(defaultInputFor(physicsDimensionOf(state.content.settings) === 3 ? 3 : 2))) as unknown,
        flow: (state.content as { flow?: unknown }).flow !== undefined ? (JSON.parse(JSON.stringify((state.content as { flow?: unknown }).flow)) as unknown) : null,
        // Phase 16.1: standalone graph documents (and, with the descriptors, the graph kinds' catalogues).
        graphs: JSON.parse(JSON.stringify((state.content as { graphs?: unknown[] }).graphs ?? [])) as unknown,
        // Phase 20.0: visual effects (systems and their graphs).
        effects: JSON.parse(JSON.stringify((state.content as { effects?: unknown[] }).effects ?? [])) as unknown,
        // Phase 23.5: block types, the cell metadata schema and stamps.
        blockTypes: JSON.parse(JSON.stringify((state.content as { blockTypes?: unknown[] }).blockTypes ?? [])) as unknown,
        cellFields: JSON.parse(JSON.stringify((state.content as { cellFields?: unknown[] }).cellFields ?? [])) as unknown,
        blockStamps: JSON.parse(JSON.stringify((state.content as { blockStamps?: unknown[] }).blockStamps ?? [])) as unknown,
        // Phase 23.7: shared script libraries (their files).
        scriptLibraries: JSON.parse(JSON.stringify((state.content as { scriptLibraries?: unknown[] }).scriptLibraries ?? [])) as unknown,
        // Phase 23.9a: project UI documents and themes.
        uiDocuments: JSON.parse(JSON.stringify((state.content as { uiDocuments?: unknown[] }).uiDocuments ?? [])) as unknown,
        uiThemes: JSON.parse(JSON.stringify((state.content as { uiThemes?: unknown[] }).uiThemes ?? [])) as unknown,
        // Phase 23.17: timelines.
        timelines: JSON.parse(JSON.stringify((state.content as { timelines?: unknown[] }).timelines ?? [])) as unknown,
        // Phase 23.3: the named collision layers.
        collisionLayers: [...((state.content as { collisionLayers?: string[] }).collisionLayers ?? [])],
        // Phase 23.10: the game modes and behavior groups.
        modes: JSON.parse(JSON.stringify((state.content as { modes?: unknown[] }).modes ?? [])) as unknown,
        behaviorGroups: [...((state.content as { behaviorGroups?: string[] }).behaviorGroups ?? [])],
        // Phase 23.19: the project save schema (null: no project saves).
        saveSchema: (state.content as { saveSchema?: unknown }).saveSchema !== undefined ? (JSON.parse(JSON.stringify((state.content as { saveSchema?: unknown }).saveSchema)) as unknown) : null,
        // Phase 23.16: conversations, the speaker registry and the dialogue settings (null: the defaults).
        dialogues: JSON.parse(JSON.stringify((state.content as { dialogues?: unknown[] }).dialogues ?? [])) as unknown,
        speakers: JSON.parse(JSON.stringify((state.content as { speakers?: unknown[] }).speakers ?? [])) as unknown,
        dialogueSettings: (state.content as { dialogueSettings?: unknown }).dialogueSettings !== undefined ? (JSON.parse(JSON.stringify((state.content as { dialogueSettings?: unknown }).dialogueSettings)) as unknown) : null,
        // Phase 17.1: the settings map (the editor's Scene view reads render_backend at load).
        settings: JSON.parse(JSON.stringify((state.content as { settings?: unknown }).settings ?? {})) as unknown,
        ...(withDescriptors ? { descriptors: JSON.parse(JSON.stringify(DESCRIPTORS)) as unknown, graphKinds: JSON.parse(JSON.stringify(GRAPH_KINDS)) as unknown } : {}),
      } as unknown as QueryResult;
    }
    return result as unknown as QueryResult;
  }
  const a = args ?? {};
  if (op === 'queryBlocks') return serveQueryBlocks(state, projectId, a);
  if (op === 'queryProject') {
    for (const k of Object.keys(a)) return failure(op, projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'queryProject takes no args'));
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
        cameraId: [...state.scenes.values()].flatMap((x) => x.entities).find((e) => e.components.camera !== undefined)?.id ?? '',
      },
      scenes: state.content.scenes.map((e) => ({ sceneId: e.sceneId, name: e.name, entityCount: state.scenes.get(e.sceneId)?.entities.length ?? 0 })),
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
 * Phase 23.5: `queryBlocks` — block-layer cells and regions for editors, MCP
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
