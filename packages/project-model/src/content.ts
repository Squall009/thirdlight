/**
 * Content catalog validation, normalization and settings resolution: the
 * content catalog (asset records, import profile), prefabs, declared
 * properties, the settings container and the six-key gameplay settings
 * registry, and behavior source records and trust.
 *
 * Pure value validation: no I/O, no three.js, no Node built-ins. There is
 * deliberately no `parseContent(bytes)`: the content block has no standalone
 * file, so its bytes are governed by the envelope's strict parse.
 */

import { canonicalEventCues, validateEventCueReferences, validateEventCues } from './event-cues';
import { canonicalShell, validateShell, validateShellReferences, type GameShell } from './shell';
import { canonicalSaveSchema, validateSaveSchema } from './save-schema';
import { canonicalDialogues, canonicalDialogueSettings, canonicalSpeakers, validateDialogueReferences, validateDialogues, validateDialogueSettings, validateSpeakers } from './dialogue';
import { canonicalTimelines, validateTimelineReferences, validateTimelines, type TimelineAsset } from './timelines';
import { animatorAssetIds, canonicalAnimators, validateAnimators, type AnimatorController } from './animator';
import { canonicalLighting, validateLighting } from './lighting';
import { canonicalInput, projectInputMaps, validateInput } from './input';
import {
  canonicalGraphDocuments,
  graphAssetRefs,
  graphDocumentsContext,
  validateGraphDocuments,
  type GraphData,
  type GraphKindDef,
} from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import { canonicalEffects, validateEffects } from './effects';
import { canonicalBlockStamps, canonicalBlockTypes, canonicalCellFields, composeBlockContent, validateBlockStamps, validateBlockTypes, validateCellFields, type BlockContentView } from './block-layers';
import { canonicalModes, validateBehaviorGroups, validateModeReferences, validateModes } from './modes';
import { canonicalUiDocuments, canonicalUiThemes, validateUiDocuments, validateUiReferences, validateUiThemes } from './ui-documents';
import { canonicalScriptLibraries, scriptLibraryDigest, validateScriptLibraries, type ScriptLibrary } from './script-libraries';
import {
  canonicalEnvironment,
  canonicalMaterials,
  validateEnvironment,
  validateMaterialMapping,
  validateMaterials,
  validateMaterialInstances,
  resolveMaterial,
  type MaterialDef,
} from './materials';
import {
  fail,
  fieldMissing,
  fieldType,
  fieldValue,
  isPlainObject,
  isValidName,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2, ModelResultV2, ModelResultV3 } from './errors';
import type { BehaviorRecord, GameplaySettings, PrefabDefinition, SettingsMap } from './types-v2';
import { validateCollisionLayers, ID_RE_V2 } from './components';
import type { AssetRecordV3, ContentCatalogV3 } from './types-v3';
import { MAX_TAGS, type ContentCatalogV4 } from './types-v3';
import { REMOVED_IN_PHASE_24 } from './upgrade-v24';
import {
  MAX_ASSETS,
  MAX_AUDIO_ASSETS,
  MAX_BEHAVIORS,
  MAX_CONTENT_BYTES,
  MAX_FONT_ASSETS,
  MAX_MUSIC_ASSETS,
  MAX_PREFABS,
  MAX_PREFAB_BYTES,
  MAX_SCENES,
  MAX_TEXTURE_ASSETS,
  MAX_VERSION_RECORDS,
} from './content-limits';
import { canonicalDocBytes, derivedOf, limitsError, sortedRecord } from './content-helpers';
import { canonicalAssetV3, validateAsset } from './content-assets';
import { canonicalPrefab, validatePrefabDefinition } from './content-prefabs';
import { canonicalBehavior, canonicalTrust, validateBehaviorRecord, validateTrust } from './content-behaviors';
import { canonicalSettings, M2_SETTINGS_KEYS, validateSettings } from './content-settings';
export { isValidSourcePath } from './content-helpers';
export { KTX2_ENCODINGS, canonicalLabels, isAssetLabel } from './content-assets';
export type { Ktx2Encoding } from './content-assets';
export { PREFAB_V4_COMPONENTS, validatePrefabDefinitions, canonicalPrefabs } from './content-prefabs';
export { M2_SETTINGS_KEYS, PHYSICS_DIMENSIONS, depthBufferOf, audioSpatialOf, instanceChunkSizeOf, physicsDimensionOf } from './content-settings';
export type { SettingsKeySpec, PhysicsDimension } from './content-settings';

export * from './content-limits';

/** A v3 content block carries the five accepted keys plus `game` (v4 content has no `game`). */
const KNOWN_CONTENT_FIELDS_V3 = new Set(['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game']);
const KNOWN_CONTENT_FIELDS_V4 = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'scenes', 'startScenes'];
/**
 * Engine timing every project played with before it became data
 * (recorded replays stay valid). Generic reasons: falling through a one-way
 * platform ignores it for 0.125 s (enough to clear a thin platform at any
 * normal fall speed); the world settles for 0.1 s before the first frame so
 * resting bodies start at rest.
 */
export const ENGINE_TIMING_DEFAULTS = Object.freeze({ dropThroughTime: 0.125, settleTime: 0.1 });

// ---- content schemaVersion 3: `audio` kind and `content.game` ---------

/**
 * The game block (`content.game`: the session's player, camera,
 * spawn, cues and timing) was deleted. A v3 envelope keeps the key as
 * `null`; V4 content has no `game` key (the loader drops a null
 * one from a schemaVersion 2 project and refuses a block).
 */
export function validateGameConfig(g: unknown, path: string, errors: ModelErrorV2[]): void {
  if (g === null) return;
  errors.push(withFound({ code: 'field_value', path, message: `content.game (the game block) was ${REMOVED_IN_PHASE_24}`, expected: 'null' } as ModelErrorV2, g));
}

/**
 * The six-key v3 content block. Validated with the accepted
 * v2 inner validators (prefabs/behaviors/settings/trust), the v3 asset-kind
 * discriminator and the bounded `game` block.
 */
function validateContentV3Value(doc: Record<string, unknown>, version: 3 | 4 = 3, previous?: ContentCatalogV3 | ContentCatalogV4): { errors: ModelErrorV2[]; doc?: ContentCatalogV3 | ContentCatalogV4 } {
  const errors: ModelErrorV2[] = [];
  // A block this module validated and normalized before: what the edit left
  // as it was (the same list, the same record object) is not checked again.
  const prev = previous !== undefined && NORMALIZED.has(previous) ? (previous as unknown as Record<string, unknown>) : undefined;
  const same = (...keys: string[]): boolean => prev !== undefined && keys.every((k) => doc[k] === prev[k]);
  const trusted = (key: string, ...context: string[]): ReadonlySet<unknown> | undefined => (prev !== undefined && context.every((k) => doc[k] === prev[k]) ? recordsOf(prev[key]) : undefined);
  const required = version === 4 ? KNOWN_CONTENT_FIELDS_V4 : [...KNOWN_CONTENT_FIELDS_V3];
  // A v4 content block has no `game` key.
  if (version === 4 && doc['game'] !== undefined) {
    errors.push(withFound({ code: 'field_unexpected', path: '/game', message: `content.game (the game block: player, camera, spawn, cues and timing) was ${REMOVED_IN_PHASE_24}`, expected: 'no game key' } as ModelErrorV2, 'game'));
  }
  for (const key of required) {
    if (doc[key] === undefined) errors.push(fieldMissing(`/${pointerSegment(key)}`, key));
  }
  for (const k of Object.keys(doc)) {
    if (!required.includes(k) && k !== 'tags' && !(version === 4 && k === 'game') && !(version === 4 && (k === 'materials' || k === 'environment' || k === 'lighting' || k === 'animators' || k === 'input' || k === 'flow' || k === 'graphs' || k === 'effects' || k === 'scriptLibraries' || k === 'blockTypes' || k === 'cellFields' || k === 'blockStamps' || k === 'collisionLayers' || k === 'saveSchema' || k === 'uiDocuments' || k === 'uiThemes' || k === 'timelines' || k === 'modes' || k === 'behaviorGroups' || k === 'dialogues' || k === 'speakers' || k === 'dialogueSettings' || k === 'eventCues' || k === 'shell'))) {
      errors.push(unexpectedField(`/${pointerSegment(k)}`, k, [...required, 'tags (optional)', ...(version === 4 ? ['materials (optional)', 'environment (optional)', 'lighting (optional)', 'animators (optional)', 'input (optional)', 'graphs (optional)', 'effects (optional)', 'scriptLibraries (optional)', 'blockTypes (optional)', 'cellFields (optional)', 'blockStamps (optional)', 'collisionLayers (optional)', 'saveSchema (optional)', 'uiDocuments (optional)', 'uiThemes (optional)', 'timelines (optional)', 'modes (optional)', 'behaviorGroups (optional)', 'dialogues (optional)', 'speakers (optional)', 'dialogueSettings (optional)', 'eventCues (optional)', 'shell (optional)'] : [])].join(', ')));
    }
  }
  if (version === 4 && doc['scenes'] !== undefined) {
    // The scene index — one entry per scene file.
    const scenes = doc['scenes'];
    if (!Array.isArray(scenes)) errors.push(fieldType('/scenes', scenes, 'array of { sceneId, name }'));
    else {
      if (scenes.length < 1 || scenes.length > MAX_SCENES) errors.push(fieldValue('/scenes', scenes.length, `1-${MAX_SCENES} scenes`, 'a project has 1 to 64 scenes'));
      const seen = new Set<string>();
      scenes.forEach((entry, i) => {
        const p = `/scenes/${i}`;
        if (!isPlainObject(entry)) {
          errors.push(fieldType(p, entry, 'object { sceneId, name }'));
          return;
        }
        for (const k of Object.keys(entry)) if (k !== 'sceneId' && k !== 'name') errors.push(unexpectedField(`${p}/${pointerSegment(k)}`, k, 'sceneId, name'));
        const id = entry['sceneId'];
        if (typeof id !== 'string' || !ID_RE_V2.test(id)) errors.push(fieldValue(`${p}/sceneId`, id, '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', 'a scene id uses the id syntax'));
        else if (seen.has(id)) errors.push(withFound({ code: 'id_duplicate', path: `${p}/sceneId`, message: 'two scenes use the same id', expected: 'a unique scene id' }, id));
        else seen.add(id);
        const name = entry['name'];
        if (typeof name !== 'string' || !isValidName(name)) errors.push(fieldValue(`${p}/name`, name, '1-128 chars, no control characters', 'a scene name is 1-128 characters'));
      });
    }
  }
  if (version === 4 && doc['startScenes'] !== undefined) {
    // The scenes loaded when the game starts.
    const start = doc['startScenes'];
    if (!Array.isArray(start)) errors.push(fieldType('/startScenes', start, 'array of scene ids'));
    else {
      if (start.length < 1 || start.length > MAX_SCENES) errors.push(fieldValue('/startScenes', start.length, `1-${MAX_SCENES} scene ids`, 'the game starts with at least one scene'));
      start.forEach((id, i) => {
        if (typeof id !== 'string') errors.push(fieldType(`/startScenes/${i}`, id, 'string (scene id)'));
        else if (!ID_RE_V2.test(id)) errors.push(fieldValue(`/startScenes/${i}`, id, '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', 'a scene id uses the id syntax'));
      });
      if (new Set(start).size !== start.length) errors.push(fieldValue('/startScenes', start, 'distinct scene ids', 'a start scene is listed twice'));
      const listed = Array.isArray(doc['scenes']) ? new Set((doc['scenes'] as { sceneId?: unknown }[]).map((e) => e?.sceneId)) : null;
      if (listed !== null) {
        start.forEach((id, i) => {
          if (typeof id === 'string' && !listed.has(id)) errors.push(withFound({ code: 'reference_missing', path: `/startScenes/${i}`, reason: 'scene', message: 'a start scene is not in the scene index', expected: 'a scene id from content.scenes' }, id));
        });
      }
    }
  }

  const assets = doc['assets'];
  let versionRecords = 0;
  // An asset list the edit left as it is was counted and checked with the block before.
  if (assets !== undefined && !same('assets')) {
    if (!Array.isArray(assets)) errors.push(fieldType('/assets', assets, 'array'));
    else {
      const modelAssets = assets.filter((a) => isPlainObject(a) && a['kind'] !== 'audio' && a['kind'] !== 'texture' && a['kind'] !== 'music' && a['kind'] !== 'font').length;
      if (modelAssets > MAX_ASSETS) {
        errors.push(limitsError('/assets', 'assets', modelAssets, MAX_ASSETS, `the catalog may hold at most ${MAX_ASSETS} model assets`));
      }
      let audioAssets = 0;
      let textureAssets = 0;
      let musicAssets = 0;
      let fontAssets = 0;
      const seen = new Set<string>();
      const known = trusted('assets');
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        if (known?.has(a) === true) versionRecords += (a as { versions: unknown[] }).versions.length;
        else versionRecords += validateAsset(a, `/assets/${i}`, errors, true);
        if (isPlainObject(a)) {
          if (a['kind'] === 'audio') audioAssets += 1;
          if (a['kind'] === 'texture') textureAssets += 1;
          if (a['kind'] === 'music') musicAssets += 1;
          if (a['kind'] === 'font') fontAssets += 1;
          if (typeof a['assetId'] === 'string') {
            if (seen.has(a['assetId'])) {
              errors.push(withFound({ code: 'id_duplicate', path: `/assets/${i}/assetId`, message: 'assetId is already used by an earlier record (first occurrence wins)', expected: 'a unique assetId' }, a['assetId']));
            } else seen.add(a['assetId']);
          }
        }
      }
      if (musicAssets > MAX_MUSIC_ASSETS) {
        errors.push(limitsError('/assets', 'assets', musicAssets, MAX_MUSIC_ASSETS, `the catalog may hold at most ${MAX_MUSIC_ASSETS} music asset records`));
      }
      if (fontAssets > MAX_FONT_ASSETS) {
        errors.push(limitsError('/assets', 'font_assets', fontAssets, MAX_FONT_ASSETS, `the catalog may hold at most ${MAX_FONT_ASSETS} font asset records`));
      }
      if (textureAssets > MAX_TEXTURE_ASSETS) {
        errors.push(limitsError('/assets', 'assets', textureAssets, MAX_TEXTURE_ASSETS, `the catalog may hold at most ${MAX_TEXTURE_ASSETS} texture asset records`));
      }
      if (audioAssets > MAX_AUDIO_ASSETS) {
        errors.push(limitsError('/assets', 'audio_assets', audioAssets, MAX_AUDIO_ASSETS, `the catalog may hold at most ${MAX_AUDIO_ASSETS} audio asset records`));
      }
      if (versionRecords > MAX_VERSION_RECORDS) {
        errors.push(limitsError('/assets', 'version_records', versionRecords, MAX_VERSION_RECORDS, `the catalog may hold at most ${MAX_VERSION_RECORDS} version records`));
      }
    }
  }

  const prefabs = doc['prefabs'];
  if (prefabs !== undefined && !same('prefabs')) {
    if (!Array.isArray(prefabs)) errors.push(fieldType('/prefabs', prefabs, 'array'));
    else {
      if (prefabs.length > MAX_PREFABS) errors.push(limitsError('/prefabs', 'prefabs', prefabs.length, MAX_PREFABS, `the catalog may hold at most ${MAX_PREFABS} prefab definitions`));
      const seen = new Set<string>();
      const known = trusted('prefabs');
      for (let i = 0; i < prefabs.length; i++) {
        const d = prefabs[i];
        const checked = known?.has(d) === true;
        if (!checked) validatePrefabDefinition(d, `/prefabs/${i}`, errors, version);
        if (isPlainObject(d) && typeof d['prefabId'] === 'string') {
          if (seen.has(d['prefabId'])) errors.push(withFound({ code: 'id_duplicate', path: `/prefabs/${i}/prefabId`, message: 'prefabId is already used (first occurrence wins)', expected: 'a unique prefabId' }, d['prefabId']));
          else seen.add(d['prefabId']);
        }
        if (!checked && isPlainObject(d) && canonicalDocBytes(d) > MAX_PREFAB_BYTES) {
          errors.push(limitsError(`/prefabs/${i}`, 'prefab_bytes', canonicalDocBytes(d), MAX_PREFAB_BYTES, 'canonical prefab definition exceeds the byte cap'));
        }
      }
    }
  }

  const behaviors = doc['behaviors'];
  if (behaviors !== undefined && !same('behaviors', 'graphs')) {
    if (!Array.isArray(behaviors)) errors.push(fieldType('/behaviors', behaviors, 'array'));
    else {
      if (behaviors.length > MAX_BEHAVIORS) errors.push(limitsError('/behaviors', 'behaviors', behaviors.length, MAX_BEHAVIORS, `the catalog may hold at most ${MAX_BEHAVIORS} behavior records`));
      const seen = new Set<string>();
      const known = trusted('behaviors', 'graphs');
      for (let i = 0; i < behaviors.length; i++) {
        if (known?.has(behaviors[i]) !== true) validateBehaviorRecord(behaviors[i], `/behaviors/${i}`, errors, version, doc['graphs']);
        const b = behaviors[i];
        if (isPlainObject(b) && typeof b['behaviorId'] === 'string') {
          if (seen.has(b['behaviorId'])) errors.push(withFound({ code: 'id_duplicate', path: `/behaviors/${i}/behaviorId`, message: 'behaviorId is already used (first occurrence wins)', expected: 'a unique behaviorId' }, b['behaviorId']));
          else seen.add(b['behaviorId']);
        }
      }
    }
  }

  const settings = doc['settings'];
  if (settings !== undefined && !same('settings')) validateSettings(settings, '/settings', errors);

  // A missing behaviorTrust is reported once, by the required-key check above.
  if (doc['behaviorTrust'] !== undefined && !same('behaviorTrust')) validateTrust(doc['behaviorTrust'], '/behaviorTrust', errors);

  const game = doc['game'];
  if (version === 3 && game !== undefined && game !== null) validateGameConfig(game, '/game', errors);

  if (doc['tags'] !== undefined && !same('tags')) validateTagRegistry(doc['tags'], '/tags', errors);

  // v4: project materials, the asset default mappings and the environment.
  // A graph material may call material functions (standalone graphs).
  if (doc['materials'] !== undefined && !same('materials', 'graphs')) {
    validateMaterials(doc['materials'], '/materials', errors, graphDocumentsContext(GRAPH_KINDS, doc['graphs']), trusted('materials', 'graphs'));
    // Instances against their parents (the whole list).
    validateMaterialInstances(doc['materials'], '/materials', errors);
  }
  if (doc['environment'] !== undefined && !same('environment')) validateEnvironment(doc['environment'], '/environment', errors);
  if (doc['lighting'] !== undefined && !same('lighting')) validateLighting(doc['lighting'], '/lighting', errors);
  if (doc['animators'] !== undefined && !same('animators')) validateAnimators(doc['animators'], '/animators', errors, trusted('animators'));
  if (doc['input'] !== undefined && !same('input')) validateInput(doc['input'], '/input', errors);
  // The level flow was deleted (the game shell, content.shell, is the generic menus and scene list).
  if (doc['flow'] !== undefined) errors.push(withFound({ code: 'field_unexpected', path: '/flow', message: `content.flow (the level flow and its menus) was ${REMOVED_IN_PHASE_24} (menus: the game shell, content.shell)`, expected: 'no flow' } as ModelErrorV2, 'flow'));
  // Standalone graph documents.
  if (doc['graphs'] !== undefined && !same('graphs')) validateGraphDocuments(GRAPH_KINDS, doc['graphs'], '/graphs', errors);
  // Visual effects.
  if (doc['effects'] !== undefined && !same('effects')) validateEffects(doc['effects'], '/effects', errors, trusted('effects'));
  // Shared script libraries (v4) and the behavior pins that name them.
  if (version === 4 && doc['scriptLibraries'] !== undefined && !same('scriptLibraries')) validateScriptLibraries(doc['scriptLibraries'], '/scriptLibraries', errors, trusted('scriptLibraries'));
  // Block types, the cell metadata schema and stamps (v4), and their references.
  if (version === 4 && !same('blockTypes', 'cellFields', 'blockStamps')) {
    const before = errors.length;
    if (doc['blockTypes'] !== undefined) validateBlockTypes(doc['blockTypes'], '/blockTypes', errors);
    if (doc['cellFields'] !== undefined) validateCellFields(doc['cellFields'], '/cellFields', errors);
    if (doc['blockStamps'] !== undefined) validateBlockStamps(doc['blockStamps'], '/blockStamps', errors);
    if (errors.length === before && (doc['blockTypes'] !== undefined || doc['blockStamps'] !== undefined)) composeBlockContent(doc as unknown as BlockContentView, errors);
  }
  // The named collision layers (v4).
  if (version === 4 && doc['collisionLayers'] !== undefined && !same('collisionLayers')) validateCollisionLayers(doc['collisionLayers'], '/collisionLayers', errors);
  // The project save schema (v4).
  if (version === 4 && doc['saveSchema'] !== undefined && !same('saveSchema')) validateSaveSchema(doc['saveSchema'], '/saveSchema', errors);
  if (!same('behaviors', 'scriptLibraries')) validateLibraryPinReferences(doc, errors);
  // Project UI documents and themes (v4), and what they reference.
  // A document's action map may be one of the project's own maps (input.maps).
  if (version === 4 && doc['uiDocuments'] !== undefined && !same('uiDocuments', 'input')) validateUiDocuments(doc['uiDocuments'], '/uiDocuments', errors, projectInputMaps(doc['input']), trusted('uiDocuments', 'input'));
  if (version === 4 && doc['uiThemes'] !== undefined && !same('uiThemes')) validateUiThemes(doc['uiThemes'], '/uiThemes', errors, trusted('uiThemes'));
  // Dialogue (v4): conversations, the speaker registry, the settings.
  if (version === 4 && doc['dialogues'] !== undefined && !same('dialogues')) validateDialogues(doc['dialogues'], '/dialogues', errors, trusted('dialogues'));
  if (version === 4 && doc['speakers'] !== undefined && !same('speakers')) validateSpeakers(doc['speakers'], '/speakers', errors);
  if (version === 4 && doc['dialogueSettings'] !== undefined && !same('dialogueSettings')) validateDialogueSettings(doc['dialogueSettings'], '/dialogueSettings', errors);
  if (version === 4 && errors.length === 0 && !same('assets', 'input', 'modes', 'uiDocuments', 'uiThemes', 'dialogues', 'speakers', 'dialogueSettings')) {
    // The page draws UI images and portraits (<img>), which cannot show a KTX2 (a GPU texture).
    const kinds = imageKindsOf(doc['assets']);
    validateUiReferences(doc, errors, (id) => kinds.get(id));
    if (doc['dialogues'] !== undefined || doc['speakers'] !== undefined || doc['dialogueSettings'] !== undefined) validateDialogueReferences(doc, errors, (id) => kinds.get(id));
  }
  // The event → cue table (v4) and its sounds.
  if (version === 4 && doc['eventCues'] !== undefined && !same('eventCues', 'assets')) {
    const before = errors.length;
    validateEventCues(doc['eventCues'], '/eventCues', errors);
    if (errors.length === before) {
      const kinds = assetKindsOf(doc['assets']);
      validateEventCueReferences(doc, errors, (id) => kinds.get(id));
    }
  }
  // The game shell (v4): its screens' and HUD's UI documents.
  if (version === 4 && doc['shell'] !== undefined && !same('shell', 'uiDocuments')) {
    const before = errors.length;
    validateShell(doc['shell'], '/shell', errors);
    if (errors.length === before) validateShellReferences(doc, errors);
  }
  // Game modes and behavior groups (v4), and what the modes reference.
  if (version === 4 && doc['behaviorGroups'] !== undefined && !same('behaviorGroups')) validateBehaviorGroups(doc['behaviorGroups'], '/behaviorGroups', errors);
  if (version === 4 && doc['modes'] !== undefined && !same('modes', 'behaviorGroups', 'input', 'uiDocuments')) {
    const before = errors.length;
    validateModes(doc['modes'], '/modes', errors);
    if (errors.length === before) validateModeReferences(doc, errors);
  }
  // Timelines (v4) and what their keys name (audio assets, effects, materials).
  if (version === 4 && doc['timelines'] !== undefined && !same('timelines', 'assets', 'effects', 'materials', 'modes')) {
    const before = errors.length;
    if (!same('timelines')) validateTimelines(doc['timelines'], '/timelines', errors, trusted('timelines'));
    if (errors.length === before) {
      const kinds = assetKindsOf(doc['assets']);
      const ids = (key: string, idKey: string): Set<string> => new Set((Array.isArray(doc[key]) ? (doc[key] as unknown[]) : []).filter(isPlainObject).map((x) => String(x[idKey])));
      validateTimelineReferences(doc['timelines'] as TimelineAsset[], '/timelines', errors, { assetKind: (id) => kinds.get(id), effectIds: ids('effects', 'effectId'), materialIds: ids('materials', 'materialId'), modeIds: ids('modes', 'modeId') });
    }
  }
  if (version === 4 && !same('assets', 'materials', 'graphs', 'effects', 'environment', 'input', 'animators', 'lighting', 'scenes')) {
    validateMaterialReferences(doc, errors, prev === undefined || !same('assets') || !sameIds(prev['materials'], doc['materials'], 'materialId'));
  }
  else if (Array.isArray(doc['assets'])) {
    // Clips-only assets are v4 data (v3 projects upgrade on open).
    (doc['assets'] as unknown[]).forEach((a, i) => {
      if (isPlainObject(a) && a['clipsFor'] !== undefined) errors.push(unexpectedField(`/assets/${i}/clipsFor`, 'clipsFor', 'clipsFor is v4 data'));
    });
  }

  if (errors.length > 0) return { errors };
  const canonical = canonicalContentV3(doc as unknown as ContentCatalogV3 | ContentCatalogV4, prev as unknown as ContentCatalogV3 | ContentCatalogV4 | undefined);
  if (version === 4) {
    (canonical as ContentCatalogV4).scenes = same('scenes') ? (prev!['scenes'] as ContentCatalogV4['scenes']) : (doc['scenes'] as { sceneId: string; name: string }[]).map((e) => ({ sceneId: e.sceneId, name: e.name }));
    (canonical as ContentCatalogV4).startScenes = same('startScenes') ? (prev!['startScenes'] as string[]) : [...(doc['startScenes'] as string[])];
  }
  const over = contentBytesOver(canonical as unknown as Record<string, unknown>, prev);
  if (over !== null) return { errors: [over] };
  NORMALIZED.add(canonical);
  return { errors, doc: canonical };
}

/** A tag name — a letter, then letters, digits, `_` or `-`; 1–32 characters. */
export const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * The tag registry — at most 32 `{ bit, name }` entries, each
 * bit 0–31 used once, names unique ignoring case.
 */
export function validateTagRegistry(tags: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(tags)) {
    errors.push(fieldType(path, tags, 'array of { bit, name }'));
    return;
  }
  if (tags.length > MAX_TAGS) {
    errors.push(limitsError(path, 'tags', tags.length, MAX_TAGS, `a project may define at most ${MAX_TAGS} tags`));
  }
  const bits = new Set<number>();
  const names = new Set<string>();
  tags.forEach((t, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(t)) {
      errors.push(fieldType(p, t, 'object { bit, name }'));
      return;
    }
    for (const k of Object.keys(t)) if (k !== 'bit' && k !== 'name') errors.push(unexpectedField(`${p}/${pointerSegment(k)}`, k, 'bit, name'));
    const bit = t['bit'];
    if (bit === undefined) errors.push(fieldMissing(`${p}/bit`, 'bit'));
    else if (typeof bit !== 'number' || !Number.isInteger(bit) || bit < 0 || bit > 31) {
      errors.push(fieldValue(`${p}/bit`, bit, 'integer 0-31', 'a tag bit is an integer from 0 to 31'));
    } else if (bits.has(bit)) {
      errors.push(withFound({ code: 'id_duplicate', path: `${p}/bit`, message: 'another tag already uses this bit', expected: 'a unique bit' }, bit));
    } else bits.add(bit);
    const name = t['name'];
    if (name === undefined) errors.push(fieldMissing(`${p}/name`, 'name'));
    else if (typeof name !== 'string') errors.push(fieldType(`${p}/name`, name, 'string'));
    else if (!TAG_NAME_RE.test(name)) {
      errors.push(fieldValue(`${p}/name`, name, 'a letter, then letters, digits, _ or -; 1-32 characters', 'tag names are short identifiers'));
    } else if (names.has(name.toLowerCase())) {
      errors.push(withFound({ code: 'id_duplicate', path: `${p}/name`, message: 'another tag already has this name (names ignore case)', expected: 'a unique name' }, name));
    } else names.add(name.toLowerCase());
  });
}

/** Canonical v3 content block (fixed six-key order, `game` last; v4 content has no `game`). */
export function canonicalContentV3<T extends ContentCatalogV3 | ContentCatalogV4>(c: T, previous?: T): T {
  return canonicalContentWith(c, previous !== undefined && NORMALIZED.has(previous) ? (previous as unknown as Record<string, unknown>) : undefined);
}

/** The records of a list, as a set (built once per list: lists are immutable values). */
const recordSets = new WeakMap<readonly unknown[], ReadonlySet<unknown>>();
function recordsOf(list: unknown): ReadonlySet<unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  let set = recordSets.get(list);
  if (set === undefined) {
    set = new Set(list);
    recordSets.set(list, set);
  }
  return set;
}

/**
 * Content blocks this module validated and normalized. Documents are
 * immutable values: a later validation given one of these as its previous
 * block trusts the lists and records the new block still shares with it.
 */
const NORMALIZED = new WeakSet<object>();

/** Whether a content block is one this module validated and normalized (a trusted previous block). */
export function isNormalizedContent(c: unknown): boolean {
  return typeof c === 'object' && c !== null && NORMALIZED.has(c);
}

/** The lists whose records are each a project resource (a file of its own), capped one by one. */
const RESOURCE_LISTS = ['assets', 'prefabs', 'behaviors', 'materials', 'animators', 'graphs', 'effects', 'scriptLibraries', 'uiDocuments', 'uiThemes', 'dialogues', 'timelines'] as const;

/**
 * The byte cap applies to each resource record and to the rest of the block
 * (the project-wide settings), not to the sum: the records are stored one
 * file each. A record the previous block held unchanged was measured then.
 */
function contentBytesOver(c: Record<string, unknown>, prev: Record<string, unknown> | undefined): ModelErrorV2 | null {
  const rest: Record<string, unknown> = {};
  let restSame = prev !== undefined;
  for (const [key, value] of Object.entries(c)) {
    if ((RESOURCE_LISTS as readonly string[]).includes(key)) continue;
    rest[key] = value;
    if (prev === undefined || prev[key] !== value) restSame = false;
  }
  if (prev !== undefined) for (const key of Object.keys(prev)) if (!(RESOURCE_LISTS as readonly string[]).includes(key) && !(key in c)) restSame = false;
  if (!restSame) {
    const bytes = canonicalDocBytes(rest);
    if (bytes > MAX_CONTENT_BYTES) return limitsError('/content', 'content_bytes', bytes, MAX_CONTENT_BYTES, 'canonical content block (the project-wide settings) exceeds the byte cap');
  }
  for (const key of RESOURCE_LISTS) {
    const list = c[key];
    if (!Array.isArray(list)) continue;
    if (prev !== undefined && prev[key] === list) continue;
    const known = prev !== undefined ? recordsOf(prev[key]) : undefined;
    for (let i = 0; i < list.length; i++) {
      if (known?.has(list[i]) === true) continue;
      const bytes = canonicalDocBytes(list[i]);
      if (bytes > MAX_CONTENT_BYTES) return limitsError(`/${key}/${i}`, 'content_bytes', bytes, MAX_CONTENT_BYTES, `canonical ${key} record exceeds the byte cap`);
    }
  }
  return null;
}

/** Whether two lists of records hold the same ids (a record changed in place keeps its id). */
function sameIds(a: unknown, b: unknown, idKey: string): boolean {
  if (a === b) return true;
  const x = Array.isArray(a) ? (a as Record<string, unknown>[]) : [];
  const y = Array.isArray(b) ? (b as Record<string, unknown>[]) : [];
  if (x.length !== y.length) return false;
  const ids = derivedOf(x, `ids:${idKey}`, () => new Set(x.map((r) => r[idKey])));
  return y.every((r) => ids.has(r[idKey]));
}

/** An asset's kind by id (built once per asset list). */
function assetKindsOf(assets: unknown): ReadonlyMap<unknown, unknown> {
  return derivedOf(Array.isArray(assets) ? assets : EMPTY_LIST, 'kinds', () => new Map((Array.isArray(assets) ? (assets as unknown[]) : []).filter(isPlainObject).map((a) => [a['assetId'], a['kind'] ?? 'model'] as const)));
}

/** An asset's kind by id as an image the page draws sees it (a KTX2 texture is its own kind). */
function imageKindsOf(assets: unknown): ReadonlyMap<unknown, unknown> {
  return derivedOf(Array.isArray(assets) ? assets : EMPTY_LIST, 'image-kinds', () => {
    const ktx2 = ktx2TextureIds({ assets });
    return new Map((Array.isArray(assets) ? (assets as unknown[]) : []).filter(isPlainObject).map((a) => [a['assetId'], ktx2.has(a['assetId'] as string) ? KTX2_TEXTURE_KIND : a['kind']] as const));
  });
}

const EMPTY_LIST: readonly unknown[] = Object.freeze([]);

/**
 * One key of the canonical content block, in the block's key order: how it
 * is canonicalized, and (for a list of records) the record id it is sorted by.
 * `always`: present even when empty; otherwise a list is present only when it
 * has records, a section only when it is set.
 */
interface CanonicalKey {
  key: string;
  canon: (value: never) => unknown;
  idOf?: (record: never) => string;
  always?: true;
  present?: (value: never) => boolean;
}

const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const CANONICAL_KEYS: readonly CanonicalKey[] = [
  { key: 'assets', canon: (l: AssetRecordV3[]) => sortedRecord(l, (a) => a.assetId).map(canonicalAssetV3), idOf: (a: AssetRecordV3) => a.assetId, always: true },
  { key: 'prefabs', canon: (l: PrefabDefinition[]) => sortedRecord(l, (d) => d.prefabId).map(canonicalPrefab), idOf: (d: PrefabDefinition) => d.prefabId, always: true },
  { key: 'behaviors', canon: (l: BehaviorRecord[]) => sortedRecord(l, (b) => b.behaviorId).map(canonicalBehavior), idOf: (b: BehaviorRecord) => b.behaviorId, always: true },
  { key: 'settings', canon: canonicalSettings, always: true },
  { key: 'behaviorTrust', canon: canonicalTrust, always: true },
  { key: 'game', canon: () => null },
  // v4 only — the scene index and the start set.
  { key: 'scenes', canon: (l: { sceneId: string; name: string }[]) => l.map((e) => ({ sceneId: e.sceneId, name: e.name })) },
  { key: 'startScenes', canon: (l: string[]) => [...l] },
  { key: 'tags', canon: (l: { bit: number; name: string }[]) => [...l].sort((a, b) => a.bit - b.bit).map((t) => ({ bit: t.bit, name: t.name })), present: nonEmpty },
  { key: 'materials', canon: canonicalMaterials, idOf: (m: MaterialDef) => m.materialId, present: nonEmpty },
  { key: 'environment', canon: canonicalEnvironment },
  { key: 'animators', canon: canonicalAnimators, idOf: (c: AnimatorController) => c.controllerId, present: nonEmpty },
  { key: 'input', canon: canonicalInput },
  { key: 'graphs', canon: canonicalGraphDocuments, idOf: (g: { graphId: string }) => g.graphId, present: nonEmpty },
  { key: 'effects', canon: canonicalEffects, idOf: (e: { effectId: string }) => e.effectId, present: nonEmpty },
  { key: 'scriptLibraries', canon: canonicalScriptLibraries, idOf: (l: ScriptLibrary) => l.libraryId, present: nonEmpty },
  { key: 'blockTypes', canon: canonicalBlockTypes, present: nonEmpty },
  { key: 'cellFields', canon: canonicalCellFields, present: nonEmpty },
  { key: 'blockStamps', canon: canonicalBlockStamps, present: nonEmpty },
  { key: 'uiDocuments', canon: canonicalUiDocuments, idOf: (d: { uiDocumentId: string }) => d.uiDocumentId, present: nonEmpty },
  { key: 'uiThemes', canon: canonicalUiThemes, idOf: (t: { uiThemeId: string }) => t.uiThemeId, present: nonEmpty },
  { key: 'modes', canon: canonicalModes, present: nonEmpty },
  { key: 'behaviorGroups', canon: (l: string[]) => [...l], present: nonEmpty },
  { key: 'collisionLayers', canon: (l: string[]) => [...l], present: nonEmpty },
  { key: 'saveSchema', canon: canonicalSaveSchema },
  { key: 'dialogues', canon: canonicalDialogues, idOf: (d: { dialogueId: string }) => d.dialogueId, present: nonEmpty },
  { key: 'speakers', canon: canonicalSpeakers, present: nonEmpty },
  { key: 'dialogueSettings', canon: canonicalDialogueSettings },
  { key: 'eventCues', canon: canonicalEventCues, present: nonEmpty },
  { key: 'shell', canon: (v: GameShell) => canonicalShell(v) },
  { key: 'timelines', canon: canonicalTimelines, idOf: (t: TimelineAsset) => t.timelineId, present: nonEmpty },
  { key: 'lighting', canon: canonicalLighting, present: (v: Record<string, unknown>) => Object.keys(v).length > 0 },
];

/**
 * The canonical block. With a trusted previous block, a key whose value the
 * edit left as it was keeps the previous canonical value, and in a changed
 * list each record the edit left as it was is kept as it is (only new or
 * changed records are canonicalized, then the list is put in id order).
 */
function canonicalContentWith<T extends ContentCatalogV3 | ContentCatalogV4>(c: T, prev?: Record<string, unknown>): T {
  const src = c as unknown as Record<string, unknown>;
  const v4 = src['scenes'] !== undefined;
  const out: Record<string, unknown> = {};
  for (const spec of CANONICAL_KEYS) {
    if (spec.key === 'game') {
      if (!v4) out['game'] = null;
      continue;
    }
    const value = src[spec.key];
    if (value === undefined) continue;
    if (spec.always !== true && spec.present !== undefined && !spec.present(value as never)) continue;
    const before = prev?.[spec.key];
    if (before !== undefined && before === value) {
      out[spec.key] = before;
      continue;
    }
    if (prev !== undefined && spec.idOf !== undefined && Array.isArray(before) && Array.isArray(value)) {
      out[spec.key] = canonicalListFrom(value, recordsOf(before)!, spec.idOf as (r: unknown) => string, spec.canon as (l: unknown[]) => unknown[]);
      continue;
    }
    out[spec.key] = spec.canon(value as never);
  }
  return out as unknown as T;
}

/** A list with the records a trusted list already holds kept, the others canonicalized, in id order. */
function canonicalListFrom(list: readonly unknown[], known: ReadonlySet<unknown>, idOf: (r: unknown) => string, canon: (l: unknown[]) => unknown[]): unknown[] {
  const out = list.map((r) => (known.has(r) ? r : canon([r])[0]));
  for (let i = 1; i < out.length; i++) {
    if (idOf(out[i - 1]) > idOf(out[i])) {
      out.sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
      break;
    }
  }
  return out;
}

/**
 * A material's texture slots name texture assets; an asset's
 * default material mapping (and only a model asset has one) names existing
 * materials.
 */
/**
 * Every library a published behavior pins exists with exactly the
 * pinned digest (a library change republishes its dependents in the same
 * command, so a stale or dangling pin never reaches a document; deleting a
 * library a behavior still imports is refused here).
 */
function validateLibraryPinReferences(doc: Record<string, unknown>, errors: ModelErrorV2[]): void {
  if (!Array.isArray(doc['behaviors'])) return;
  const libs = new Map<string, ScriptLibrary>();
  if (Array.isArray(doc['scriptLibraries'])) {
    for (const l of doc['scriptLibraries'] as unknown[]) {
      if (isPlainObject(l) && typeof l['libraryId'] === 'string' && Array.isArray(l['files'])) libs.set(l['libraryId'], l as unknown as ScriptLibrary);
    }
  }
  const digests = new Map<string, string | null>();
  (doc['behaviors'] as unknown[]).forEach((b, i) => {
    if (!isPlainObject(b) || !isPlainObject(b['source']) || !Array.isArray(b['source']['libraries'])) return;
    (b['source']['libraries'] as unknown[]).forEach((p, j) => {
      if (!isPlainObject(p) || typeof p['libraryId'] !== 'string') return;
      const id = p['libraryId'];
      const lib = libs.get(id);
      const path = `/behaviors/${i}/source/libraries/${j}`;
      if (lib === undefined) {
        errors.push(withFound({ code: 'reference_missing', path: `${path}/libraryId`, message: `behavior ${String(b['behaviorId'])} imports the script library "${id}", which is not in this project`, expected: 'a libraryId of content.scriptLibraries' }, id));
        return;
      }
      if (!digests.has(id)) {
        let d: string | null = null;
        try {
          d = (lib.files as unknown[]).every((f) => isPlainObject(f) && typeof f['path'] === 'string' && typeof f['text'] === 'string') ? scriptLibraryDigest(lib) : null;
        } catch {
          d = null;
        }
        digests.set(id, d);
      }
      const current = digests.get(id);
      if (current !== null && current !== undefined && p['sourceDigest'] !== current) {
        errors.push(withFound({ code: 'reference_missing', path: `${path}/sourceDigest`, message: `behavior ${String(b['behaviorId'])} was compiled against another version of the script library "${id}" (republish it)`, expected: current }, p['sourceDigest']));
      }
    });
  });
}

/**
 * What an image the page draws (a UI image, a portrait, a glyph)
 * sees for a KTX2 texture asset — a GPU texture no <img> can show.
 */
export const KTX2_TEXTURE_KIND = 'texture (KTX2: a GPU texture the page cannot draw as an image; import a PNG, JPEG or WebP for it)';

/** The texture assets whose current version is a KTX2. */
function ktx2TextureIds(doc: Record<string, unknown>): ReadonlySet<string> {
  const list = doc['assets'];
  if (!Array.isArray(list)) return new Set();
  return derivedOf(list, 'ktx2', () => {
    const out = new Set<string>();
    for (const a of list as unknown[]) {
    if (!isPlainObject(a) || a['kind'] !== 'texture' || !Array.isArray(a['versions'])) continue;
    const current = (a['versions'] as unknown[]).find((v) => isPlainObject(v) && v['version'] === a['currentVersion']) as Record<string, unknown> | undefined;
    if (isPlainObject(current?.['metrics']) && current['metrics']['format'] === 'ktx2') out.add(a['assetId'] as string);
    }
    return out;
  });
}

/**
 * What a reference that reads one plain (2D) texture sees for a
 * texture array — only a graph material's texture nodes and parameters sample
 * a layer of an array.
 */
export const TEXTURE_ARRAY_KIND = 'texture (a texture array: only graph materials read its layers; name a plain texture here)';

/** The texture assets whose current version is a texture array (KTX2 with layers). */
export function arrayTextureIds(doc: { assets?: readonly unknown[] } | Record<string, unknown>): ReadonlySet<string> {
  const list = (doc as Record<string, unknown>)['assets'];
  if (!Array.isArray(list)) return new Set();
  return derivedOf(list, 'texture-arrays', () => {
    const out = new Set<string>();
    for (const a of list as unknown[]) {
    if (!isPlainObject(a) || a['kind'] !== 'texture' || !Array.isArray(a['versions'])) continue;
    const current = (a['versions'] as unknown[]).find((v) => isPlainObject(v) && v['version'] === a['currentVersion']) as Record<string, unknown> | undefined;
    if (isPlainObject(current?.['metrics']) && typeof current['metrics']['layers'] === 'number') out.add(a['assetId'] as string);
    }
    return out;
  });
}

function validateMaterialReferences(doc: Record<string, unknown>, errors: ModelErrorV2[], assetRules = true): void {
  const list = Array.isArray(doc['assets']) ? (doc['assets'] as unknown[]) : EMPTY_LIST;
  const assets = derivedOf(list, 'records', () => list.filter(isPlainObject));
  const kindOf = derivedOf(list, 'raw-kinds', () => new Map(assets.map((a) => [a['assetId'], a['kind']])));
  const byId = derivedOf(list, 'by-id', () => new Map(assets.map((a) => [a['assetId'], a])));
  // Where one plain texture is read, a texture array is not one.
  const arrays = arrayTextureIds(doc);
  const plainKindOf = derivedOf(list, 'plain-kinds', () => new Map(assets.map((a) => [a['assetId'], arrays.has(a['assetId'] as string) ? TEXTURE_ARRAY_KIND : a['kind']])));
  const graphRefs = (kind: GraphKindDef, graph: GraphData, at: string): void => {
    const nodes = graph.nodes.filter((n) => isPlainObject(n) && typeof n.type === 'string' && (n.data === undefined || isPlainObject(n.data)));
    // A material graph samples array layers; an effect graph reads plain textures.
    const kinds = kind.kind === 'material' || kind.kind === 'material-function' ? kindOf : plainKindOf;
    for (const r of graphAssetRefs(kind, { nodes, edges: [] })) {
      if (kinds.get(r.id) !== r.asset) errors.push(withFound({ code: 'asset_reference_missing', path: `${at}${r.path}`, message: `this node field must name a ${r.asset} asset of this project`, expected: `a ${r.asset} assetId` }, r.id));
    }
  };
  const materials = Array.isArray(doc['materials']) ? (doc['materials'] as unknown[]).filter(isPlainObject) : [];
  const materialIds = new Set(materials.map((m) => m['materialId']));
  materials.forEach((m, i) => {
    const textures = m['textures'];
    if (isPlainObject(textures)) {
      for (const [slot, id] of Object.entries(textures)) {
        if (kindOf.get(id) !== 'texture') {
          errors.push(withFound({ code: 'asset_reference_missing', path: `/materials/${i}/textures/${pointerSegment(slot)}`, message: 'a material texture slot must name a texture asset of this project', expected: 'a texture assetId' }, id));
        } else if (arrays.has(id as string) && m['graph'] === undefined && (typeof m['materialId'] !== 'string' || resolveMaterial(materials as unknown as MaterialDef[], m['materialId'])?.graph === undefined)) {
          // A shader material's slot reads one plain texture.
          errors.push(withFound({ code: 'field_value', path: `/materials/${i}/textures/${pointerSegment(slot)}`, message: 'a material texture slot reads one plain texture: a texture array is read by a graph material\'s texture nodes', expected: 'a plain texture assetId' }, id));
        }
      }
    }
    // A graph's texture fields and texture parameters name texture assets.
    if (isPlainObject(m['graph']) && Array.isArray(m['graph']['nodes'])) graphRefs(GRAPH_KINDS['material']!, m['graph'] as unknown as GraphData, `/materials/${i}/graph`);
    if (Array.isArray(m['parameters'])) {
      (m['parameters'] as unknown[]).forEach((p, j) => {
        if (isPlainObject(p) && p['type'] === 'texture' && typeof p['default'] === 'string' && p['default'] !== '' && kindOf.get(p['default']) !== 'texture') {
          errors.push(withFound({ code: 'asset_reference_missing', path: `/materials/${i}/parameters/${j}/default`, message: 'a texture parameter must name a texture asset of this project', expected: 'a texture assetId' }, p['default']));
        }
      });
    }
    // An instance's value for a texture parameter names a texture asset.
    if (typeof m['instanceOf'] === 'string' && isPlainObject(m['values']) && typeof m['materialId'] === 'string') {
      const root = resolveMaterial(materials as unknown as MaterialDef[], m['materialId']);
      for (const p of root?.parameters ?? []) {
        const v = m['values'][p.key];
        if (p.type === 'texture' && typeof v === 'string' && v !== '' && kindOf.get(v) !== 'texture') {
          errors.push(withFound({ code: 'asset_reference_missing', path: `/materials/${i}/values/${pointerSegment(p.key)}`, message: 'a texture parameter must name a texture asset of this project', expected: 'a texture assetId' }, v));
        }
      }
    }
  });
  // Standalone graphs (material functions) reference assets the same way.
  if (Array.isArray(doc['graphs'])) {
    (doc['graphs'] as unknown[]).forEach((g, i) => {
      const k = isPlainObject(g) && typeof g['kind'] === 'string' ? GRAPH_KINDS[g['kind']] : undefined;
      if (k !== undefined && isPlainObject(g) && isPlainObject(g['graph']) && Array.isArray(g['graph']['nodes'])) graphRefs(k, g['graph'] as unknown as GraphData, `/graphs/${i}/graph`);
    });
  }
  // Effect system graphs name textures and models the same way.
  if (Array.isArray(doc['effects'])) {
    (doc['effects'] as unknown[]).forEach((e, i) => {
      if (!isPlainObject(e) || !Array.isArray(e['systems'])) return;
      (e['systems'] as unknown[]).forEach((sys, j) => {
        if (isPlainObject(sys) && isPlainObject(sys['graph']) && Array.isArray(sys['graph']['nodes'])) graphRefs(GRAPH_KINDS['effect']!, sys['graph'] as unknown as GraphData, `/effects/${i}/systems/${j}/graph`);
      });
    });
  }
  // Sky images and the grading LUT are texture assets too.
  const env = doc['environment'];
  if (isPlainObject(env)) {
    const refs: [string, unknown][] = [];
    const sky = env['sky'];
    if (isPlainObject(sky)) {
      if (sky['texture'] !== undefined) refs.push(['/environment/sky/texture', sky['texture']]);
      if (Array.isArray(sky['cube'])) sky['cube'].forEach((id, i) => refs.push([`/environment/sky/cube/${i}`, id]));
    }
    const post = env['post'];
    if (isPlainObject(post) && isPlainObject(post['grading']) && post['grading']['lut'] !== undefined) refs.push(['/environment/post/grading/lut', post['grading']['lut']]);
    // The presets' sky images and LUTs.
    if (Array.isArray(env['presets'])) {
      (env['presets'] as unknown[]).forEach((pr, i) => {
        if (!isPlainObject(pr)) return;
        const psky = pr['sky'];
        if (isPlainObject(psky)) {
          if (psky['texture'] !== undefined) refs.push([`/environment/presets/${i}/sky/texture`, psky['texture']]);
          if (Array.isArray(psky['cube'])) psky['cube'].forEach((id, j) => refs.push([`/environment/presets/${i}/sky/cube/${j}`, id]));
        }
        const ppost = pr['post'];
        if (isPlainObject(ppost) && isPlainObject(ppost['grading']) && ppost['grading']['lut'] !== undefined) refs.push([`/environment/presets/${i}/post/grading/lut`, ppost['grading']['lut']]);
      });
    }
    for (const [p, id] of refs) {
      if (plainKindOf.get(id) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: p, message: 'this environment image must name a (plain) texture asset of this project', expected: 'a texture assetId' }, id));
    }
  }
  // The input's glyph images are texture assets.
  const input = doc['input'];
  if (isPlainObject(input) && isPlainObject(input['glyphs'])) {
    for (const [k, id] of Object.entries(input['glyphs'])) {
      if (kindOf.get(id as string) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: `/input/glyphs/${k}`, message: 'a glyph image must name a texture asset of this project', expected: 'a texture assetId' }, id));
      // Glyphs are drawn by the page as images.
      else if (ktx2TextureIds(doc).has(id as string)) errors.push(withFound({ code: 'field_value', path: `/input/glyphs/${k}`, message: 'a glyph image is drawn by the page: it cannot be a KTX2 texture (import a PNG, JPEG or WebP)', expected: 'a PNG, JPEG or WebP texture' }, id));
    }
  }
  // A controller's clips come from model assets of this project.
  if (Array.isArray(doc['animators'])) {
    (doc['animators'] as unknown[]).forEach((c, i) => {
      if (!isPlainObject(c) || !Array.isArray(c['states'])) return;
      for (const id of animatorAssetIds(c as unknown as AnimatorController)) {
        if (kindOf.get(id) !== 'model') errors.push(withFound({ code: 'asset_reference_missing', path: `/animators/${i}/states`, message: 'an animator clip must come from a model asset of this project', expected: 'a model assetId' }, id));
      }
    });
  }
  // A bake belongs to a scene of the index; its atlases are texture assets.
  const lighting = doc['lighting'];
  if (isPlainObject(lighting)) {
    const sceneIds = new Set(Array.isArray(doc['scenes']) ? (doc['scenes'] as unknown[]).map((e) => (isPlainObject(e) ? e['sceneId'] : undefined)) : []);
    for (const [sceneId, bake] of Object.entries(lighting)) {
      if (!sceneIds.has(sceneId)) errors.push(withFound({ code: 'reference_missing', reason: 'scene', path: `/lighting/${pointerSegment(sceneId)}`, message: 'a bake belongs to a scene of this project', expected: 'a sceneId of content.scenes' }, sceneId));
      if (!isPlainObject(bake) || !Array.isArray(bake['atlases'])) continue;
      bake['atlases'].forEach((id, i) => {
        if (plainKindOf.get(id) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: `/lighting/${pointerSegment(sceneId)}/atlases/${i}`, message: 'a lightmap atlas must name a texture asset of this project', expected: 'a texture assetId' }, id));
      });
    }
  }
  // The asset records' own references (their rig, their default materials) only when the assets or the material ids changed.
  if (!assetRules) return;
  // "clips for rig of <asset>" names another model of this project that is not itself a clips-only asset.
  assets.forEach((a, i) => {
    const rig = a['clipsFor'];
    if (typeof rig !== 'string') return;
    const target = byId.get(rig);
    if (rig === a['assetId']) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/clipsFor`, message: 'an asset cannot hold clips for its own rig (absent = its clips are its own)', expected: 'another model assetId' }, rig));
    else if (target === undefined || target['kind'] !== 'model') errors.push(withFound({ code: 'asset_reference_missing', path: `/assets/${i}/clipsFor`, message: 'clipsFor must name a model asset of this project', expected: 'a model assetId' }, rig));
    else if (target['clipsFor'] !== undefined) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/clipsFor`, message: 'clipsFor must name a model with its own rig, not another clips-only asset', expected: 'a model assetId without clipsFor' }, rig));
  });
  assets.forEach((a, i) => {
    const mapping = a['materials'];
    if (mapping === undefined) return;
    if (a['kind'] !== 'model') {
      errors.push(unexpectedField(`/assets/${i}/materials`, 'materials', 'only a model asset has a default material mapping'));
      return;
    }
    validateMaterialMapping(mapping, `/assets/${i}/materials`, errors);
    if (!isPlainObject(mapping)) return;
    for (const [slot, id] of Object.entries(mapping)) {
      if (!materialIds.has(id)) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/materials/${pointerSegment(slot)}`, message: 'a material mapping names no material of this project', expected: 'a materialId in content.materials' }, id));
    }
  });
}

/** The explicit v3 content validator. */
export function validateContentV3(doc: unknown): ModelResultV3<ContentCatalogV3> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  const { errors, doc: canonical } = validateContentV3Value(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as ContentCatalogV3 };
}

/**
 * The v4 project content block (`content.json`): v3's keys plus
 * the scene index and the required `startScenes` (no `game`).
 */
/**
 * `previous`: the block this one was edited from, when it is a block this
 * module validated (anything else is ignored): what the edit left as it was is
 * trusted, not checked again.
 */
export function validateContentV4(doc: unknown, previous?: unknown): ModelResultV3<ContentCatalogV4> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  // An unchanged block is itself (a trusted previous block is valid and canonical).
  if (isNormalizedContent(previous) && doc === previous) return { ok: true, normalized: previous as ContentCatalogV4 };
  const { errors, doc: canonical } = validateContentV3Value(doc, 4, isNormalizedContent(previous) ? (previous as ContentCatalogV4) : undefined);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as ContentCatalogV4 };
}

/** Validate, then return the new canonical v3 content block. */
export function normalizeContentV3(doc: unknown): ModelResultV3<ContentCatalogV3> {
  return validateContentV3(doc);
}

// ---- settings resolution ---------------------------------------------

/** `defaults ⊕ content.settings`, validated and deep-frozen. */
export function resolveGameplaySettings(content: unknown): ModelResultV2<GameplaySettings> {
  const errors: ModelErrorV2[] = [];
  const isContentBlock =
    isPlainObject(content) &&
    ['assets', 'prefabs', 'behaviors', 'behaviorTrust'].some((k) =>
      Object.prototype.hasOwnProperty.call(content, k),
    );
  const hasSettingsKey = isPlainObject(content) && Object.prototype.hasOwnProperty.call(content, 'settings');
  const raw: unknown = hasSettingsKey
    ? (content as Record<string, unknown>)['settings']
    : isContentBlock
      ? undefined
      : content;
  if (raw === undefined) {
    errors.push(fieldMissing('/settings', 'settings'));
  } else if (isPlainObject(raw)) {
    validateSettings(raw, '/settings', errors);
  } else {
    errors.push(fieldType('/settings', raw, 'object'));
  }
  if (errors.length > 0) return fail(errors);
  const settingsMap = isPlainObject(raw) ? (raw as SettingsMap) : {};
  const resolved: GameplaySettings = {
    gravity_y: M2_SETTINGS_KEYS[0]!.default,
    run_speed: M2_SETTINGS_KEYS[1]!.default,
    jump_velocity: M2_SETTINGS_KEYS[2]!.default,
    max_fall_speed: M2_SETTINGS_KEYS[3]!.default,
    max_slope_climb_deg: M2_SETTINGS_KEYS[4]!.default,
    min_slope_slide_deg: M2_SETTINGS_KEYS[5]!.default,
  };
  for (const spec of M2_SETTINGS_KEYS) {
    const provided = settingsMap[spec.key];
    if (typeof provided === 'number') {
      (resolved as unknown as Record<string, number>)[spec.key] = provided;
    }
  }
  deepFreeze(resolved);
  return { ok: true, normalized: resolved };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[k]);
    Object.freeze(value);
  }
  return value;
}

