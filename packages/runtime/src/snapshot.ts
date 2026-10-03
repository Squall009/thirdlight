/**
 * Runtime snapshot validation.
 *
 * The runtime re-validates on receipt: the producer is not trusted (the
 * session layer and the exporter both construct snapshots). Strict shape
 * (unknown fields at the wrapper level ⇒ `snapshot_invalid`
 * `reason: "shape"` with the path), ID/revision rules, and a full
 * `validateSceneV3`/`validateMergedSceneV4` re-check — failures carry ≤ 10
 * project-model error objects + the total count.
 */
import { ID_RE } from '@thirdlight/project-model';
import { validateModelRig, type ModelRig } from '@thirdlight/project-model';
import { validateModes, type RuntimeModes } from '@thirdlight/project-model';
import { validateBlockTypes, validateCellFields, type BlockType, type CellField } from '@thirdlight/project-model';
import { resolveSceneHierarchy, sceneCamerasAsShots, validateMergedSceneV4, validateSceneV3, validateTagRegistry, validateAnimators, validatePrefabDefinitions, type AnimatorController, type PrefabDefinition, type TagDefinition, type ModelErrorV2, type ModelErrorV3, type SceneV3, type RuntimeUiDocumentRow } from '@thirdlight/project-model';
import { MAX_INPUT_ACTIONS, MAX_REVISION } from '@thirdlight/project-model';
import type { RuntimeError } from './errors';
import type { ModelBounds, RuntimeSceneRow, RuntimeScene, RuntimeSnapshot } from './types';

/** The project-model ID syntax (all IDs). */

import { runtimeDialogueDataProblem, validateSaveSchema, type RuntimeDialogueData, type SaveSchema } from '@thirdlight/project-model';
import { canonicalTimelines, validateTimelines, type TimelineAsset } from '@thirdlight/project-model';
import { canonicalEventCues, validateEventCues, type EventCue } from '@thirdlight/project-model';
import { materialCatalogProblem, type RuntimeMaterialCatalog } from './material-params';

const WRAPPER_FIELDS = new Set(['snapshotId', 'projectId', 'revision', 'scene', 'tags', 'scenes', 'animators', 'prefabs', 'modelBounds', 'blockTypes', 'cellFields', 'rigs', 'materialCatalog', 'materialIds', 'uiDocuments', 'modes', 'saveSchema', 'audioDurations', 'timelines', 'eventCues', 'sceneList', 'environmentPresets', 'dialogue']);
const SCENE_ID_RE = ID_RE;

/**
 * Recursively freeze (idempotent). On successful
 * `instantiateRuntime`, the runtime deep-freezes the snapshot and never
 * writes to it.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const rec = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(rec)) {
    deepFreeze(rec[key]);
  }
  return value;
}

/**
 * Validate the runtime snapshot. Returns the normalized
 * scene on success. Never throws.
 *
 * There is no `game` wrapper field (the deleted game block); one
 * is `snapshot_invalid` (`reason: "shape"`).
 */
export function validateRuntimeSnapshot(
  input: unknown,
):
  | {
      scene: RuntimeScene;
      sceneVersion: 3 | 4;
      snapshotId: string;
      projectId: string;
      revision: number;
      tags: readonly TagDefinition[];
      scenes: readonly RuntimeSceneRow[] | null;
      animators: readonly AnimatorController[];
      prefabs: readonly PrefabDefinition[];
      modelBounds: Readonly<Record<string, ModelBounds>>;
      audioDurations: Readonly<Record<string, number>>;
      rigs?: Readonly<Record<string, ModelRig>>;
      blockTypes: readonly BlockType[];
      cellFields: readonly CellField[];
      materialCatalog?: RuntimeMaterialCatalog;
      materialIds?: readonly string[];
      saveSchema?: SaveSchema;
      uiDocuments: readonly RuntimeUiDocumentRow[];
      dialogue?: RuntimeDialogueData;
      modes?: RuntimeModes;
      timelines?: readonly TimelineAsset[];
      eventCues?: readonly EventCue[];
      sceneList?: readonly import('./types').ListedScene[];
      environmentPresets?: readonly string[];
    }
  | { error: RuntimeError } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '',
        message: 'runtime snapshot must be a JSON object',
      },
    };
  }
  const snap = input as Record<string, unknown>;

  // Strict wrapper shape: unknown fields at the wrapper level ⇒ shape error.
  for (const key of Object.keys(snap)) {
    if (!WRAPPER_FIELDS.has(key)) {
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'shape',
          path: `/${key}`,
          // The deleted game block's field says where it went.
          message: key === 'game' ? 'snapshot field "game" (the game block) was removed from the engine: build it as project scripts' : `unknown snapshot field "${key}" (strict shape)`,
        },
      };
    }
  }
  for (const key of ['snapshotId', 'projectId', 'revision', 'scene']) {
    if (!(key in snap)) {
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'shape',
          path: `/${key}`,
          message: `snapshot field "${key}" is missing`,
        },
      };
    }
  }
  const { snapshotId, projectId, revision } = snap as Pick<RuntimeSnapshot, 'snapshotId' | 'projectId' | 'revision'>;
  if (typeof snapshotId !== 'string') {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/snapshotId',
        message: 'snapshotId must be a string',
      },
    };
  }
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/projectId',
        message: 'projectId must match the project id syntax',
      },
    };
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/revision',
        message: 'revision must be an integer in [0, 2^53-1]',
      },
    };
  }
  if (typeof snap.scene !== 'object' || snap.scene === null || Array.isArray(snap.scene)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/scene',
        message: 'scene must be a complete scene document',
      },
    };
  }

  // Re-validate the scene: the producer is not trusted. Only schemaVersion 3
  // (`validateSceneV3`) and 4 (the merged start scenes,
  // `validateMergedSceneV4`) are playable. Validation failures ⇒
  // snapshot_invalid carrying the project-model error objects (≤ 10 reported, total count given).
  const rawScene = snap.scene as { schemaVersion?: unknown };
  const rawVersion: unknown = rawScene.schemaVersion;
  if (rawVersion !== 3 && rawVersion !== 4) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/scene/schemaVersion',
        message: 'the snapshot scene must be schemaVersion 3 or 4',
      },
    };
  }
  const sceneVersion: 3 | 4 = rawVersion;
  // A scene made before the engine owned the view holds a scene camera: it plays as the shot the format upgrade makes of it.
  const rawEntities = (snap.scene as { entities?: unknown }).entities;
  const shotScene = sceneVersion === 4 && Array.isArray(rawEntities) ? { ...(snap.scene as object), entities: sceneCamerasAsShots(rawEntities) } : snap.scene;
  // v4: the start scenes merged into one runtime scene (no per-scene limits).
  const sceneResult = sceneVersion === 4 ? validateMergedSceneV4(shotScene) : validateSceneV3(snap.scene);
  if (!sceneResult.ok) {
    const errors: readonly ModelErrorV3[] = sceneResult.errors;
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'scene_validation',
        message: clipSceneMessage(errors),
        errors: errors.slice(0, 10),
        errorTotal: errors.length,
      },
    };
  }
  // The game never sees folders or inactive entities (resolved
  // once here, at scene load).
  const resolved = resolveSceneHierarchy(sceneResult.normalized);
  const scene: RuntimeScene = sceneVersion === 3 ? { ...resolved, entities: sceneCamerasAsShots(resolved.entities) } : resolved;
  if (scene.revision !== revision) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'revision_mismatch',
        message: `snapshot revision ${revision} != scene.revision ${scene.revision}`,
      },
    };
  }
  const expectedId = `${projectId}@r${revision}`;
  if (snapshotId !== expectedId) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'id_mismatch',
        message: `snapshotId "${snapshotId}" != "<projectId>@r<revision>" ("${expectedId}")`,
      },
    };
  }
  // The optional v3 tag registry.
  let tags: readonly TagDefinition[] = [];
  if (snap.tags !== undefined) {
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(snap.tags, '/tags', tagErrors);
    if (tagErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(tagErrors), errors: tagErrors.slice(0, 10), errorTotal: tagErrors.length } };
    }
    tags = snap.tags as TagDefinition[];
  }
  // The optional v4 animator controllers.
  let animators: readonly AnimatorController[] = [];
  if (snap.animators !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/animators', message: 'snapshot field "animators" is v4-only' } };
    const animatorErrors: ModelErrorV2[] = [];
    validateAnimators(snap.animators, '/animators', animatorErrors);
    if (animatorErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(animatorErrors), errors: animatorErrors.slice(0, 10), errorTotal: animatorErrors.length } };
    }
    animators = snap.animators as AnimatorController[];
  }
  // The optional v4 prefab definitions (`ctx.spawn`).
  let prefabs: readonly PrefabDefinition[] = [];
  if (snap.prefabs !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/prefabs', message: 'snapshot field "prefabs" is v4-only' } };
    const prefabErrors: ModelErrorV2[] = [];
    validatePrefabDefinitions(snap.prefabs, '/prefabs', prefabErrors, 4);
    if (prefabErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(prefabErrors), errors: prefabErrors.slice(0, 10), errorTotal: prefabErrors.length } };
    }
    prefabs = snap.prefabs as PrefabDefinition[];
  }
  // The optional v4 model bounds (assetId -> the model's recorded bounds).
  let modelBounds: Readonly<Record<string, ModelBounds>> = {};
  if (snap.modelBounds !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/modelBounds', message } });
    if (sceneVersion !== 4) return bad('snapshot field "modelBounds" is v4-only');
    const mb = snap.modelBounds as unknown;
    if (typeof mb !== 'object' || mb === null || Array.isArray(mb)) return bad('modelBounds must be an object of rows');
    const vec = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    for (const [k, v] of Object.entries(mb as Record<string, unknown>)) {
      const b = v as { min?: unknown; max?: unknown } | null;
      if (typeof b !== 'object' || b === null || !vec(b.min) || !vec(b.max)) return bad(`modelBounds["${k}"] must be { min: [x, y, z], max: [x, y, z] }`);
    }
    modelBounds = mb as Record<string, ModelBounds>;
  }
  // The optional v4 audio durations (assetId -> the audio asset's recorded length, ms; any length).
  let audioDurations: Readonly<Record<string, number>> = {};
  if (snap.audioDurations !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/audioDurations', message } });
    if (sceneVersion !== 4) return bad('snapshot field "audioDurations" is v4-only');
    const ad = snap.audioDurations as unknown;
    if (typeof ad !== 'object' || ad === null || Array.isArray(ad)) return bad('audioDurations must be an object of rows');
    for (const [k, v] of Object.entries(ad as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return bad(`audioDurations["${k}"] must be a positive integer (ms)`);
    }
    audioDurations = ad as Record<string, number>;
  }
  // The optional v4 model rigs (assetId -> nodes and node animation channels; sockets are resolved on them).
  let rigs: Readonly<Record<string, ModelRig>> | undefined;
  if (snap.rigs !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/rigs', message } });
    if (sceneVersion !== 4) return bad('snapshot field "rigs" is v4-only');
    const r = snap.rigs as unknown;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return bad('rigs must be an object of rows');
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const why = validateModelRig(v);
      if (why !== null) return bad(`rigs["${k}"]: ${why}`);
    }
    rigs = r as Record<string, ModelRig>;
  }
  // The optional v4 block types and cell fields (block layers).
  let blockTypes: readonly BlockType[] = [];
  let cellFields: readonly CellField[] = [];
  if (snap.blockTypes !== undefined || snap.cellFields !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/blockTypes', message: 'snapshot fields "blockTypes"/"cellFields" are v4-only' } };
    const blockErrors: ModelErrorV2[] = [];
    if (snap.blockTypes !== undefined) validateBlockTypes(snap.blockTypes, '/blockTypes', blockErrors);
    if (snap.cellFields !== undefined) validateCellFields(snap.cellFields, '/cellFields', blockErrors);
    if (blockErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(blockErrors), errors: blockErrors.slice(0, 10), errorTotal: blockErrors.length } };
    }
    blockTypes = (snap.blockTypes ?? []) as BlockType[];
    cellFields = (snap.cellFields ?? []) as CellField[];
  }
  // The optional graph-material catalogue (ctx.materials).
  let materialCatalog: RuntimeMaterialCatalog | undefined;
  if ((snap as { materialCatalog?: unknown }).materialCatalog !== undefined) {
    const problem = materialCatalogProblem((snap as { materialCatalog?: unknown }).materialCatalog);
    if (problem !== null) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/materialCatalog', message: problem } };
    materialCatalog = (snap as { materialCatalog: RuntimeMaterialCatalog }).materialCatalog;
  }
  // The optional list of the game's materials (what a material swap may name).
  let materialIds: readonly string[] | undefined;
  const rawIds = (snap as { materialIds?: unknown }).materialIds;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds) || !rawIds.every((x) => typeof x === 'string' && ID_RE.test(x))) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/materialIds', message: 'materialIds must be an array of material ids' } };
    materialIds = Object.freeze([...(rawIds as string[])]);
  }
  // The optional project save schema (ctx.saves).
  let saveSchema: SaveSchema | undefined;
  if ((snap as { saveSchema?: unknown }).saveSchema !== undefined) {
    const errs: ModelErrorV2[] = [];
    validateSaveSchema((snap as { saveSchema?: unknown }).saveSchema, '/saveSchema', errs);
    if (errs.length > 0) return { error: { code: 'snapshot_invalid', reason: 'shape', path: errs[0]!.path, message: errs[0]!.message } };
    saveSchema = (snap as { saveSchema: SaveSchema }).saveSchema;
  }
  // The optional v4 timelines (ctx.timeline).
  let timelines: readonly TimelineAsset[] | undefined;
  if ((snap as { timelines?: unknown }).timelines !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/timelines', message: 'snapshot field "timelines" is v4-only' } };
    const errs: ModelErrorV2[] = [];
    validateTimelines((snap as { timelines?: unknown }).timelines, '/timelines', errs);
    if (errs.length > 0) return { error: { code: 'snapshot_invalid', reason: 'shape', path: errs[0]!.path, message: errs[0]!.message } };
    timelines = canonicalTimelines((snap as { timelines: TimelineAsset[] }).timelines);
  }
  // The optional v4 event → cue table.
  let eventCues: readonly EventCue[] | undefined;
  if ((snap as { eventCues?: unknown }).eventCues !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/eventCues', message: 'snapshot field "eventCues" is v4-only' } };
    const errs: ModelErrorV2[] = [];
    validateEventCues((snap as { eventCues?: unknown }).eventCues, '/eventCues', errs);
    if (errs.length > 0) return { error: { code: 'snapshot_invalid', reason: 'shape', path: errs[0]!.path, message: errs[0]!.message } };
    eventCues = canonicalEventCues((snap as { eventCues: EventCue[] }).eventCues);
  }
  // The shell's ordered scene list (the `scene` UI event walks it).
  let sceneList: readonly import('./types').ListedScene[] | undefined;
  if ((snap as { sceneList?: unknown }).sceneList !== undefined) {
    const list = (snap as { sceneList?: unknown }).sceneList;
    const entryOk = (x: unknown): boolean => {
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
      const e = x as { scene?: unknown; spawn?: unknown; fade?: unknown; fadeColor?: unknown };
      if (!Object.keys(e).every((k) => k === 'scene' || k === 'spawn' || k === 'fade' || k === 'fadeColor')) return false;
      if (typeof e.scene !== 'string' || !SCENE_ID_RE.test(e.scene)) return false;
      if (e.spawn !== undefined && !(typeof e.spawn === 'string' && e.spawn.length > 0 && e.spawn.length <= 128)) return false;
      // The fade of a move to the entry (seconds, colour).
      if (e.fade !== undefined && !(typeof e.fade === 'number' && Number.isFinite(e.fade) && e.fade >= 0 && e.fade <= 5)) return false;
      return e.fadeColor === undefined || (typeof e.fadeColor === 'string' && /^#[0-9a-f]{6}$/.test(e.fadeColor));
    };
    const ok = Array.isArray(list) && list.length >= 1 && list.every(entryOk);
    if (!ok) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/sceneList', message: 'sceneList is at least one entry { scene, spawn?, fade?, fadeColor? }' } };
    sceneList = (list as import('./types').ListedScene[]).map((x) => Object.freeze({ scene: x.scene, ...(x.spawn !== undefined ? { spawn: x.spawn } : {}), ...(x.fade !== undefined ? { fade: x.fade } : {}), ...(x.fadeColor !== undefined ? { fadeColor: x.fadeColor } : {}) }));
  }
  // The optional environment preset ids (ctx.environment).
  let environmentPresets: readonly string[] | undefined;
  if ((snap as { environmentPresets?: unknown }).environmentPresets !== undefined) {
    const ids = (snap as { environmentPresets?: unknown }).environmentPresets;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && SCENE_ID_RE.test(x)) || new Set(ids).size !== ids.length) {
      return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/environmentPresets', message: 'environmentPresets is a list of unique preset ids' } };
    }
    environmentPresets = ids as string[];
  }
  // The optional v4 UI document rows (id, layer, modal) scripts show and hide.
  let uiDocuments: readonly RuntimeUiDocumentRow[] = [];
  if (snap.uiDocuments !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/uiDocuments', message } });
    if (sceneVersion !== 4) return bad('snapshot field "uiDocuments" is v4-only');
    const rows = snap.uiDocuments as unknown;
    if (!Array.isArray(rows)) return bad('uiDocuments must be an array of rows');
    const seen = new Set<string>();
    for (const r of rows as unknown[]) {
      const row = r as Record<string, unknown> | null;
      if (typeof row !== 'object' || row === null || Array.isArray(row) || Object.keys(row).some((k) => k !== 'uiDocumentId' && k !== 'layer' && k !== 'modal')) return bad('a UI document row is { uiDocumentId, layer, modal }');
      const id = row['uiDocumentId'];
      if (typeof id !== 'string' || !SCENE_ID_RE.test(id) || seen.has(id)) return bad('a UI document row names a unique uiDocumentId');
      seen.add(id);
      if (typeof row['layer'] !== 'number' || !Number.isInteger(row['layer']) || Math.abs(row['layer']) > 100 || typeof row['modal'] !== 'boolean') return bad(`UI document row "${id}": layer is an integer −100–100, modal true/false`);
    }
    uiDocuments = rows as RuntimeUiDocumentRow[];
  }
  // The optional v4 dialogue data (conversations, speakers, settings).
  let dialogue: RuntimeDialogueData | undefined;
  if ((snap as { dialogue?: unknown }).dialogue !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/dialogue', message: 'snapshot field "dialogue" is v4-only' } };
    const problem = runtimeDialogueDataProblem((snap as { dialogue?: unknown }).dialogue);
    if (problem !== null) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/dialogue', message: problem } };
    dialogue = (snap as { dialogue: RuntimeDialogueData }).dialogue;
  }
  // The optional v4 game modes ({ modes, actionMaps }).
  let modes: RuntimeModes | undefined;
  if (snap.modes !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/modes', message } });
    if (sceneVersion !== 4) return bad('snapshot field "modes" is v4-only');
    const m = snap.modes as unknown as Record<string, unknown>;
    if (typeof m !== 'object' || m === null || Array.isArray(m) || Object.keys(m).some((k) => k !== 'modes' && k !== 'actionMaps')) return bad('modes is { modes, actionMaps }');
    const errors: ModelErrorV2[] = [];
    validateModes(m['modes'], '/modes/modes', errors);
    if (errors.length > 0) return bad(`modes: ${errors[0]!.message}`);
    if (!Array.isArray(m['modes']) || m['modes'].length === 0) return bad('modes lists at least one game mode');
    const maps = m['actionMaps'];
    if (typeof maps !== 'object' || maps === null || Array.isArray(maps) || Object.keys(maps).length > MAX_INPUT_ACTIONS || Object.values(maps).some((v) => typeof v !== 'string')) return bad(`actionMaps maps at most ${MAX_INPUT_ACTIONS} action names to their input map`);
    modes = snap.modes as unknown as RuntimeModes;
  }
  // The optional v4 scene catalog.
  let scenes: readonly RuntimeSceneRow[] | null = null;
  if (snap.scenes !== undefined) {
    const bad = (message: string, path = '/scenes'): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path, message } });
    if (sceneVersion !== 4) return bad('snapshot field "scenes" is v4-only');
    if (!Array.isArray(snap.scenes) || snap.scenes.length < 1) {
      return bad('snapshot field "scenes" must be an array of at least one scene row');
    }
    const seen = new Set<string>();
    const members = new Set<string>();
    let starts = 0;
    for (let i = 0; i < snap.scenes.length; i += 1) {
      const row = snap.scenes[i] as Record<string, unknown>;
      const path = `/scenes/${i}`;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return bad('a scene row must be an object', path);
      for (const k of Object.keys(row)) if (k !== 'sceneId' && k !== 'start' && k !== 'entityIds') return bad(`unknown scene row field "${k}"`, path);
      if (typeof row['sceneId'] !== 'string' || !SCENE_ID_RE.test(row['sceneId'])) return bad('sceneId must be a scene id', `${path}/sceneId`);
      if (seen.has(row['sceneId'])) return bad(`duplicate scene "${row['sceneId']}"`, `${path}/sceneId`);
      seen.add(row['sceneId']);
      if (typeof row['start'] !== 'boolean') return bad('start must be a boolean', `${path}/start`);
      if (row['start']) starts += 1;
      if (row['entityIds'] !== undefined) {
        if (!row['start']) return bad('only a start scene lists entityIds', `${path}/entityIds`);
        if (!Array.isArray(row['entityIds']) || !row['entityIds'].every((x) => typeof x === 'string')) return bad('entityIds must be an array of entity ids', `${path}/entityIds`);
        for (const id of row['entityIds'] as string[]) {
          if (members.has(id)) return bad(`entity "${id}" is listed in two scenes`, `${path}/entityIds`);
          members.add(id);
        }
      }
    }
    if (starts === 0) return bad('at least one scene must be a start scene');
    scenes = snap.scenes as RuntimeSceneRow[];
  }
  return { scene, sceneVersion, snapshotId, projectId, revision, tags, scenes, animators, prefabs, modelBounds, audioDurations, blockTypes, cellFields, ...(rigs !== undefined ? { rigs } : {}), ...(materialCatalog !== undefined ? { materialCatalog } : {}), ...(materialIds !== undefined ? { materialIds } : {}), uiDocuments, ...(saveSchema !== undefined ? { saveSchema } : {}), ...(timelines !== undefined ? { timelines } : {}), ...(eventCues !== undefined ? { eventCues } : {}), ...(sceneList !== undefined ? { sceneList } : {}), ...(modes !== undefined ? { modes } : {}), ...(environmentPresets !== undefined ? { environmentPresets } : {}), ...(dialogue !== undefined ? { dialogue } : {}) };
}

function clipSceneMessage(errors: readonly (ModelErrorV2 | ModelErrorV3)[]): string {
  const first = errors[0];
  const firstPart = first ? `; first: ${first.code} at ${first.path}` : '';
  const msg = `scene validation failed: ${errors.length} error(s)${firstPart}`;
  return msg.length > 256 ? `${msg.slice(0, 255)}…` : msg;
}
/**
 * The snapshot as the game loads it — for a v3 scene, folders and
 * inactive entities removed and effective flags applied
 * (`resolveSceneHierarchy`). Hosts call this once, right after the snapshot
 * arrives, so the renderer, physics and runtime all see the same entities.
 * Other scene versions are returned unchanged. Idempotent.
 */
export function resolveSnapshotHierarchy<T extends { scene: unknown }>(snapshot: T): T {
  const scene = snapshot.scene as { schemaVersion?: unknown; entities?: unknown };
  if (scene === null || typeof scene !== 'object' || (scene.schemaVersion !== 3 && scene.schemaVersion !== 4) || !Array.isArray(scene.entities)) return snapshot;
  return { ...snapshot, scene: resolveSceneHierarchy(scene as unknown as SceneV3) };
}
