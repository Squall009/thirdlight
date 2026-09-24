/**
 * Phase 12 (c): the session side of storage v4 (see `store-v4.ts`) — open
 * (with the automatic v3 → v4 upgrade), publish, external changes, release,
 * and the scene-aware queries. The v1–v3 single-envelope paths in
 * `session.ts` are unchanged; they branch here for a v4 project.
 */

import { createCommandState, filterEntitiesByComponent, queryAssets, queryBehaviors, queryGameConfig, queryPrefabs } from '@thirdlight/commands';
import type { ContentDocument, HistoryState } from '@thirdlight/commands';
import { effectiveEntityFlags, type ContentCatalogV3, type Manifest, type ProjectManifestV2, type SceneV3, type SceneV4 } from '@thirdlight/project-model';

import { loadPreparedSources } from './content-store';
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
  return { kind: 'open', session: makeSessionV4(core, dir, projectId, l.state, ownership, sceneDir, thirdlightDir, notes) };
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
    if (prev !== undefined && JSON.stringify(prev.entities) === JSON.stringify(scene.entities)) continue;
    const rel = sceneRel(id);
    const recs = appendTo(rel);
    const stamped: SceneV4 = { ...scene, revision: after.revision };
    const bytes = sceneFileBytes(projectId, stamped, recs);
    writes.push({ rel, bytes });
    files.set(rel, { bytes, hash: sha256Hex(bytes) });
    fileRecords.set(rel, recs);
    after.scenes.set(id, stamped);
  }
  for (const id of before.scenes.keys()) {
    if (after.scenes.has(id)) continue;
    const rel = sceneRel(id);
    writes.push({ rel, bytes: null });
    files.delete(rel);
    fileRecords.delete(rel);
  }
  // Content: written when it changed (or when no scene carries the record).
  const contentChanged = JSON.stringify(before.content) !== JSON.stringify(after.content);
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

/** `acceptExternalState` for v4: the files on disk become the project (records cleared, new history). */
export function acceptExternalV4(core: Core, s: ProjectSession): { ok: true; revision: number; historyReset: true; retryCleared: true } | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null) return { ok: false, error: noPendingChange() };
  // Re-read now: the resolution is never answered from a stale read.
  const l = loadV4(core.ops, s.dir, s.projectId);
  const pc = s.pendingChange as PendingChange & { externalFile?: string };
  if (pc.snapshotState !== 'ok') return { ok: false, error: externalChangeEvidenceMissing(s.projectId, { externalHash: pc.externalHash, externalValid: pc.externalValid, externalErrorCount: pc.externalErrors?.length ?? null }) };
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
  const pc = s.pendingChange;
  if (pc.snapshotState !== 'ok') return { ok: false, error: externalChangeEvidenceMissing(s.projectId, { externalHash: pc.externalHash, externalValid: pc.externalValid, externalErrorCount: pc.externalErrors?.length ?? null }) };
  const state = s.v4;
  const baseline = diskBaseline(core, s, state.files.keys());
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
  return { ok: true };
}

// ---- queries ------------------------------------------------------------------------

/** The scene holding an entity (null when no scene does). */
export function sceneOfEntity(state: V4State, entityId: string): SceneV4 | null {
  for (const scene of state.scenes.values()) if (scene.entities.some((e) => e.id === entityId)) return scene;
  return null;
}

type QueryOp = 'queryProject' | 'queryEntity' | 'queryEntities' | 'queryAssets' | 'queryPrefabs' | 'queryBehaviors' | 'queryGameConfig';

function failure(op: string, projectId: string, error: import('@thirdlight/commands').CommandError): QueryResult {
  return { ok: false, op, projectId, error } as unknown as QueryResult;
}

/**
 * The v4 queries. `queryEntities` takes an optional `sceneId` (default: all
 * scenes, in index order, with `entitySceneIds` naming each entity's scene);
 * `queryEntity` reports the entity's `sceneId`; `queryProject` lists the
 * scene index and the start set; `queryGameConfig` adds them too.
 */
export function serveQueryV4(s: ProjectSession, op: QueryOp, projectId: string, args: Record<string, unknown> | undefined, workspace: unknown): QueryResult {
  const state = s.v4 as V4State;
  const tags = (state.content.tags ?? []).map((t) => ({ bit: t.bit, name: t.name }));
  if (op === 'queryAssets' || op === 'queryPrefabs' || op === 'queryBehaviors' || op === 'queryGameConfig') {
    const cs = createCommandState({ ...primaryScene(state), revision: state.revision }, state.content as unknown as ContentDocument);
    const request: Record<string, unknown> = { op, projectId };
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
      } as unknown as QueryResult;
    }
    return result as unknown as QueryResult;
  }
  const a = args ?? {};
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
