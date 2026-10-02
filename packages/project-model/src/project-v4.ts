/**
 * The v4 project — several scenes, one file each — and the
 * pure v3 → v4 migration.
 *
 * Layout (storage v4, workspace): `project.json` (manifest schemaVersion 3;
 * a 2 is upgraded on load), `content.json` (the project-wide content block:
 * assets, prefabs, behaviors, settings, trust, tags, startScenes…) and
 * `scenes/<sceneId>.json` (one v4 scene each). This module holds the rules
 * that span documents:
 *
 * - scene ids are unique; entity ids are unique across the whole project;
 * - `startScenes` name existing scenes. The start set holds the one-per-game
 *   things — exactly one (active) camera, at most one controller and one
 *   light of each type; other scenes (loaded later) hold none of these;
 * - a scene transition names existing scenes, and its spawn sits in the
 *   scene it loads (or its own);
 * - every scene's asset, cue, tag and behavior references resolve against
 *   the content block (the v3 per-scene cross-block rules, reused).
 *
 * v4 has no level bounds or kill height: rules like these are a game's own
 * logic (scripts). Pure: no I/O.
 */

import { composeBlockLayers, type BlockContentView } from './block-layers';
import { composeContentChecks, composeV3 } from './project-v3';
import { derivedOf } from './content-helpers';
import { validateContentV4, physicsDimensionOf, arrayTextureIds, TEXTURE_ARRAY_KIND } from './content';
import { validateSceneV4 } from './scene-v3';
import { ID_RE_V2, physicsRotationErrors, physicsScaleErrors } from './components';
import { fail, fieldMissing, fieldType, fieldValue, isPlainObject, isValidName, pointerSegment, unexpectedField, withFound } from './validate';
import type { ModelErrorV3, ModelResultV3 } from './errors';
import type { Manifest as M1Manifest } from './types';
import type { ContentCatalogV3, ContentCatalogV4, SceneEntityV3, SceneV3, SceneV4 } from './types-v3';
import { isFolderEntity } from './types-v3';
import { materialOverrideErrors } from './materials';
import { behaviorGroupErrors } from './modes';
import { effectComponentErrors } from './effects';
import { PROJECT_SCHEMA_VERSION, isUpgradedProjectSchemaVersion } from './upgrade-v24';
import { nextFreeEntityIdOf } from './entity-ids';
import { upgradeSceneModel } from './upgrade-scene-model';

/**
 * `project.json` — scenes are the files in `scenes/`. schemaVersion 3 (the
 * format without the genre layer; `upgrade-v24.ts`: the loader upgrades a 2
 * before validating).
 */
export interface ProjectManifestV2 {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  engineVersion: string;
  id: string;
  name: string;
  createdAt: string;
}

const MANIFEST_V2_FIELDS = ['schemaVersion', 'engineVersion', 'id', 'name', 'createdAt'] as const;
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateManifestV2Project(doc: unknown): ModelResultV3<ProjectManifestV2> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  const errors: ModelErrorV3[] = [];
  if (doc['schemaVersion'] !== PROJECT_SCHEMA_VERSION) {
    errors.push(
      isUpgradedProjectSchemaVersion(doc['schemaVersion'])
        ? fieldValue('/schemaVersion', doc['schemaVersion'], String(PROJECT_SCHEMA_VERSION), `a schemaVersion ${String(doc['schemaVersion'])} project is upgraded by the loader before it is validated (each upgrade step from ${String(doc['schemaVersion'])} to ${PROJECT_SCHEMA_VERSION}: upgradeProjectDocsV24, upgradeProjectDocsV25, the asset-file upgrade of the open, upgradeSceneEnvironments, upgradeSceneModel)`)
        : fieldValue('/schemaVersion', doc['schemaVersion'], String(PROJECT_SCHEMA_VERSION), `a v4 project manifest has schemaVersion ${PROJECT_SCHEMA_VERSION}`),
    );
  }
  for (const k of MANIFEST_V2_FIELDS) if (doc[k] === undefined) errors.push(fieldMissing(`/${k}`, k));
  for (const k of Object.keys(doc)) {
    if (!(MANIFEST_V2_FIELDS as readonly string[]).includes(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, MANIFEST_V2_FIELDS.join(', ')));
  }
  const id = doc['id'];
  if (id !== undefined && (typeof id !== 'string' || !ID_RE_V2.test(id))) errors.push(fieldValue('/id', id, 'project id syntax', 'the project id uses the id syntax'));
  const name = doc['name'];
  if (name !== undefined && (typeof name !== 'string' || !isValidName(name))) errors.push(fieldValue('/name', name, '1-128 chars, no control characters', 'project name'));
  const ev = doc['engineVersion'];
  if (ev !== undefined && typeof ev !== 'string') errors.push(fieldType('/engineVersion', ev, 'string'));
  const at = doc['createdAt'];
  if (at !== undefined && (typeof at !== 'string' || !UTC_SECONDS_RE.test(at))) errors.push(fieldValue('/createdAt', at, 'YYYY-MM-DDTHH:MM:SSZ', 'createdAt is a UTC second'));
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    normalized: { schemaVersion: PROJECT_SCHEMA_VERSION, engineVersion: ev as string, id: id as string, name: name as string, createdAt: at as string },
  };
}

/** A whole v4 project in memory. */
export interface ProjectV4 {
  manifest: ProjectManifestV2;
  content: ContentCatalogV4;
  /** In a stable order (scene id, ascending). */
  scenes: SceneV4[];
}

function sceneError(sceneId: string, e: ModelErrorV3): ModelErrorV3 {
  return { ...e, document: 'scene', sceneId } as ModelErrorV3;
}

function projectError(path: string, code: ModelErrorV3['code'], message: string, expected: string, extra: Partial<ModelErrorV3> = {}, found?: unknown): ModelErrorV3 {
  const e = { code, path, message, expected, ...extra } as ModelErrorV3;
  return found === undefined ? e : withFound(e, found);
}

/**
 * The cross-document v4 rules over already-validated documents. Errors carry
 * `document` and, for scene errors, `sceneId`.
 *
 * A scene's own part of each rule is kept with the scene and the content
 * sections it read (documents are immutable values): a command that edits
 * one scene, or content the scenes do not name, composes the others from
 * what they gave before. The errors come in the same order either way.
 */
export function composeV4(
  scenes: readonly SceneV4[],
  content: ContentCatalogV4,
  errors: ModelErrorV3[],
  /** The project revision (the highest file revision); asset versions must not be newer. */
  projectRevision: number = Number.MAX_SAFE_INTEGER,
): void {
  const sceneIds = new Set<string>();
  for (const s of scenes) {
    if (sceneIds.has(s.sceneId)) errors.push(projectError('/sceneId', 'id_duplicate', 'two scene files use the same scene id', 'unique scene ids', { document: 'scene', sceneId: s.sceneId } as never, s.sceneId));
    sceneIds.add(s.sceneId);
  }

  // Entity ids are unique across the project.
  errors.push(...entityIdErrors(scenes));
  // An entity and its scene by id (made when a rule needs it: spawns named across scenes).
  let byId: Map<string, { entity: SceneEntityV3; sceneId: string }> | null = null;
  const entityById = (id: string): { entity: SceneEntityV3; sceneId: string } | undefined => {
    if (byId === null) {
      byId = new Map();
      for (const s of scenes) for (const e of s.entities) if (!byId.has(e.id)) byId.set(e.id, { entity: e, sceneId: s.sceneId });
    }
    return byId.get(id);
  };

  // The scene index and the scene files match one to one.
  const indexed = new Set(content.scenes.map((e) => e.sceneId));
  for (const s of scenes) {
    if (!indexed.has(s.sceneId)) errors.push(projectError('/scenes', 'reference_missing', `scene file "${s.sceneId}" is not in the scene index`, 'every scene file listed in content.scenes', { document: 'content', reason: 'scene' } as never, s.sceneId));
  }
  content.scenes.forEach((e, i) => {
    if (!sceneIds.has(e.sceneId)) errors.push(projectError(`/scenes/${i}/sceneId`, 'reference_missing', `the scene index lists "${e.sceneId}" but there is no scene file for it`, 'a scene file per index entry', { document: 'content', reason: 'scene' } as never, e.sceneId));
  });

  // The start set.
  const start = new Set(content.startScenes);
  content.startScenes.forEach((id, i) => {
    if (!sceneIds.has(id)) errors.push(projectError(`/startScenes/${i}`, 'reference_missing', 'a start scene names no scene of the project', 'an existing scene id', { document: 'content', reason: 'scene' } as never, id));
  });
  // Lights belong to scenes — any light kind may sit in any scene (each scene's own limits:
  // one directional, one ambient, one hemisphere, 16 point/spot). Where the player and the cameras are is
  // checked when the game starts (play-checks.ts), not per edit.
  // The shell's listed scenes are scenes of the project, each spawn a player spawn in its scene.
  const shell = (content as { shell?: { scenes?: { scene: string; spawn?: string }[] } }).shell;
  if (shell?.scenes !== undefined) {
    shell.scenes.forEach((entry, i) => {
      const p = `/shell/scenes/${i}`;
      if (!sceneIds.has(entry.scene)) errors.push(projectError(`${p}/scene`, 'reference_missing', 'a listed scene names an unknown scene', 'a sceneId of this project', { document: 'content' } as never, entry.scene));
      if (entry.spawn !== undefined) {
        const spawn = entityById(entry.spawn);
        if (spawn === undefined || spawn.entity.components.playerSpawn === undefined || spawn.sceneId !== entry.scene) {
          errors.push(projectError(`${p}/spawn`, 'reference_missing', 'a listed scene starts at a player spawn in that scene', 'a playerSpawn entity id in the scene', { document: 'content' } as never, entry.spawn));
        }
      }
    });
  }

  // Each scene's references to project content, rule by rule (in this order over all scenes).
  const refs = scenes.map((s) => sceneReferenceRules(s, content));
  for (let rule = 0; rule < SCENE_REFERENCE_RULES; rule++) for (const r of refs) errors.push(...r[rule]!);

  // A prefab's gameplay components name project things too.
  errors.push(...prefabReferenceRules(content));

  // triggers' scene transitions (the scenes exist; the spawn is a player spawn the character can reach).
  for (const s of scenes) {
    for (const t of sceneTransitionsOf(s)) {
      const at = `/entities/${t.index}/components/trigger/sceneTransition`;
      if (!sceneIds.has(t.transition.scene)) errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/scene`, reason: 'scene', message: 'a scene transition names no scene of the project', expected: 'an existing scene id' }, t.transition.scene)));
      (t.transition.unload ?? []).forEach((id, j) => {
        if (!sceneIds.has(id)) errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/unload/${j}`, reason: 'scene', message: 'a scene transition unloads no scene of the project', expected: 'an existing scene id' }, id)));
      });
      if (t.transition.spawn !== undefined) {
        const hit = entityById(t.transition.spawn);
        const reachable = hit !== undefined && (hit.sceneId === s.sceneId || hit.sceneId === t.transition.scene);
        if (hit === undefined || hit.entity.components.playerSpawn === undefined || !reachable) {
          errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/spawn`, reason: 'spawn', message: 'a scene transition\'s spawn must be a player spawn in the scene it loads (or its own)', expected: 'a playerSpawn entity id' }, t.transition.spawn)));
        }
      }
    }
  }

  // Per-scene references against the content block, and the block's own rules once.
  for (const s of scenes) composeSceneV4(s, content, errors, projectRevision);
  composeContentChecks({ ...content, game: null }, errors, projectRevision);

  // A prefab's collider follows the project's physics dimension too.
  errors.push(...prefabPhysicsRules(content));
}

/**
 * Entity ids used twice across the project's scenes. The last answer is kept
 * with the scenes it was for and a count of every id (scenes are immutable
 * values, kept by identity like the other per-scene rules here): a command that changes no scene (a content edit) does not walk
 * every entity again, and one that changes a few scenes of a project without
 * duplicates recounts only those scenes' ids.
 */
let lastEntityIds: { readonly scenes: readonly SceneV4[]; readonly counts: Map<string, number>; readonly errors: readonly ModelErrorV3[] } | null = null;
/** How many changed scenes are recounted instead of walking every scene again. */
const ENTITY_ID_RECOUNT_SCENES = 8;
function entityIdErrors(scenes: readonly SceneV4[]): readonly ModelErrorV3[] {
  const last = lastEntityIds;
  if (last !== null && last.scenes.length === scenes.length) {
    const changed: number[] = [];
    for (let i = 0; i < scenes.length && changed.length <= ENTITY_ID_RECOUNT_SCENES; i += 1) if (last.scenes[i] !== scenes[i]) changed.push(i);
    if (changed.length === 0) return last.errors;
    if (last.errors.length === 0 && changed.length <= ENTITY_ID_RECOUNT_SCENES) {
      lastEntityIds = null;
      const counts = last.counts;
      let duplicate = false;
      for (const i of changed) for (const e of last.scenes[i]!.entities) counts.set(e.id, (counts.get(e.id) ?? 1) - 1);
      for (const i of changed) {
        for (const e of scenes[i]!.entities) {
          const n = (counts.get(e.id) ?? 0) + 1;
          counts.set(e.id, n);
          if (n > 1) duplicate = true;
        }
      }
      if (!duplicate) {
        for (const i of changed) for (const e of last.scenes[i]!.entities) if (counts.get(e.id) === 0) counts.delete(e.id);
        lastEntityIds = { scenes: [...scenes], counts, errors: [] };
        return lastEntityIds.errors;
      }
    }
  }
  const errors: ModelErrorV3[] = [];
  const owner = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      const first = owner.get(e.id);
      if (first !== undefined) {
        errors.push(sceneError(s.sceneId, withFound({ code: 'id_duplicate', path: `/entities/${i}/id`, message: `entity id is already used in scene "${first}" (ids are unique across the project)`, expected: 'a project-unique entity id' }, e.id)));
      } else owner.set(e.id, s.sceneId);
    });
  }
  lastEntityIds = { scenes: [...scenes], counts, errors };
  return errors;
}

/** How many rules `sceneReferenceRules` checks (its result holds one error list per rule). */
const SCENE_REFERENCE_RULES = 6;
const referenceRules = new WeakMap<SceneV4, { key: readonly unknown[]; byRule: readonly ModelErrorV3[][] }>();

/**
 * One scene's references to project content, one error list per rule: a
 * light's cookie and an audio source's clip, a pickup's cue, an animator's
 * controller, a material mapping, material parameter overrides, an effect.
 * Kept with the scene and the asset, animator, material and effect lists.
 */
function sceneReferenceRules(s: SceneV4, content: ContentCatalogV4): readonly ModelErrorV3[][] {
  // A material mapping reads the material ids; only an override reads a material's parameters, only an effect component the effects.
  const uses = sceneUses(s);
  const key = [content.assets, animatorIds(content), materialIdsOf(content), uses.params ? content.materials : null, uses.effects ? content.effects : null];
  const hit = referenceRules.get(s);
  if (hit !== undefined && hit.key.every((v, i) => v === key[i])) return hit.byRule;
  const byRule: ModelErrorV3[][] = Array.from({ length: SCENE_REFERENCE_RULES }, () => []);
  const [sounds, pickups, animators, mappings, params, effects] = byRule as [ModelErrorV3[], ModelErrorV3[], ModelErrorV3[], ModelErrorV3[], ModelErrorV3[], ModelErrorV3[]];
  // An audio source plays an audio asset of this project.
  // A cookie is one plain texture (a texture array is read by graph materials only).
  const soundKinds = plainAssetKinds(content);
  const controllerIds = animatorIds(content);
  const materialIds = materialIdsOf(content);
  s.entities.forEach((e, i) => {
    // A spot light's cookie is a texture asset of this project.
    const cookie = (e.components as { light?: { cookie?: string } }).light?.cookie;
    if (cookie !== undefined && soundKinds.get(cookie) !== 'texture') {
      sounds.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/light/cookie`, message: 'a spot light\'s cookie is a texture asset of this project', expected: 'a texture assetId' }, cookie)));
    }
    const src = (e.components as { audioSource?: { assetId: string } }).audioSource;
    if (src !== undefined && soundKinds.get(src.assetId) !== 'audio') {
      sounds.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/audioSource/assetId`, message: 'an audio source plays an audio asset of this project', expected: 'an audio assetId' }, src.assetId)));
    }
    // A pickup's collect sound is an audio asset of this project.
    const cue = (e.components as { pickup?: { cue?: string } }).pickup?.cue;
    if (cue !== undefined && soundKinds.get(cue) !== 'audio') {
      pickups.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/pickup/cue`, message: 'a pickup cue plays an audio asset of this project', expected: 'an audio assetId' }, cue)));
    }
    // An animator names a controller of this project.
    const a = e.components.animator;
    if (a !== undefined && !controllerIds.has(a.controller)) {
      animators.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/animator/controller`, message: 'the animator names no controller of this project', expected: 'a controllerId in content.animators' }, a.controller)));
    }
    // An object's material mapping names project materials.
    const mapping = e.components.materials;
    if (mapping !== undefined) {
      for (const [slot, id] of Object.entries(mapping)) {
        if (!materialIds.has(id)) {
          mappings.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/materials/${slot}`, message: 'the material mapping names no material of this project', expected: 'a materialId in content.materials' }, id)));
        }
      }
    }
    // Overrides name public parameters of the project's graph materials.
    const o = e.components.materialParams;
    if (o !== undefined) {
      for (const x of materialOverrideErrors(o, content.materials ?? [])) {
        params.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/materialParams${x.path}`, message: x.message, expected: 'a public parameter of a graph material, with a value that fits it' }, x.found)));
      }
    }
    // An effect component names a project effect and overrides only its public parameters.
    const fx = e.components.effect;
    if (fx !== undefined) {
      for (const x of effectComponentErrors(fx, content.effects ?? [])) {
        effects.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/effect${x.path}`, message: x.message, expected: 'an effect of this project and its public parameters' }, x.found)));
      }
    }
  });
  referenceRules.set(s, { key, byRule });
  return byRule;
}

/** Whether a scene has material parameter overrides or effect components (kept with the scene). */
const usesOf = new WeakMap<SceneV4, { params: boolean; effects: boolean }>();
function sceneUses(s: SceneV4): { params: boolean; effects: boolean } {
  let out = usesOf.get(s);
  if (out === undefined) {
    out = { params: s.entities.some((e) => e.components.materialParams !== undefined), effects: s.entities.some((e) => e.components.effect !== undefined) };
    usesOf.set(s, out);
  }
  return out;
}

/** A scene's triggers that load scenes (kept with the scene). */
const transitionsOf = new WeakMap<SceneV4, readonly { index: number; transition: { scene: string; spawn?: string; unload?: string[] } }[]>();
function sceneTransitionsOf(s: SceneV4): readonly { index: number; transition: { scene: string; spawn?: string; unload?: string[] } }[] {
  let out = transitionsOf.get(s);
  if (out === undefined) {
    const list: { index: number; transition: { scene: string; spawn?: string; unload?: string[] } }[] = [];
    s.entities.forEach((e, i) => {
      const t = (e.components as { trigger?: { sceneTransition?: { scene: string; spawn?: string; unload?: string[] } } }).trigger?.sceneTransition;
      if (t !== undefined) list.push({ index: i, transition: t });
    });
    out = list;
    transitionsOf.set(s, out);
  }
  return out;
}

/** Asset kinds by id as a plain-texture reference sees them (a texture array is its own kind). */
function plainAssetKinds(content: ContentCatalogV4): ReadonlyMap<string, string | undefined> {
  const arrays = arrayTextureIds(content as unknown as Record<string, unknown>);
  return derivedOf(content.assets, 'plain-kinds-v4', () => new Map((content.assets as { assetId: string; kind?: string }[]).map((a) => [a.assetId, arrays.has(a.assetId) ? TEXTURE_ARRAY_KIND : a.kind])));
}

function animatorIds(content: ContentCatalogV4): ReadonlySet<string> {
  return internIds('animators', content.animators, (c) => c.controllerId);
}

function materialIdsOf(content: ContentCatalogV4): ReadonlySet<string> {
  return internIds('materials', content.materials, (m) => m.materialId);
}

/**
 * A list's ids as one set object for as long as the ids stay the same: a
 * record edited in place keeps the set, so what was checked against the ids
 * alone is not checked again.
 */
const lastIds = new Map<string, ReadonlySet<string>>();
const EMPTY_IDS: ReadonlySet<string> = new Set();
function internIds<T>(role: string, list: readonly T[] | undefined, idOf: (r: T) => string): ReadonlySet<string> {
  if (list === undefined || list.length === 0) return EMPTY_IDS;
  return derivedOf(list, `interned-ids:${role}`, () => {
    const ids = new Set(list.map(idOf));
    const last = lastIds.get(role);
    if (last !== undefined && last.size === ids.size && [...ids].every((id) => last.has(id))) return last;
    lastIds.set(role, ids);
    return ids;
  });
}

const prefabRefRules = new WeakMap<object, { key: readonly unknown[]; errors: readonly ModelErrorV3[] }>();

/** A prefab's gameplay components name project things (kept with the prefab, asset, animator, material and effect lists). */
function prefabReferenceRules(content: ContentCatalogV4): readonly ModelErrorV3[] {
  const prefabs = content.prefabs ?? [];
  const uses = derivedOf(prefabs, 'uses', () => ({ params: prefabs.some((d) => d.entities.some((e) => e.components.materialParams !== undefined)), effects: prefabs.some((d) => d.entities.some((e) => e.components.effect !== undefined)) }));
  const key = [content.assets, animatorIds(content), materialIdsOf(content), uses.params ? content.materials : null, uses.effects ? content.effects : null];
  const hit = prefabRefRules.get(prefabs);
  if (hit !== undefined && hit.key.every((v, i) => v === key[i])) return hit.errors;
  const errors: ModelErrorV3[] = [];
  const soundKinds = plainAssetKinds(content);
  const controllerIds = animatorIds(content);
  const materialIds = materialIdsOf(content);
  prefabs.forEach((d, di) => {
    d.entities.forEach((e, ei) => {
      const p = `/prefabs/${di}/entities/${ei}/components`;
      const c = e.components;
      const bad = (path: string, code: string, message: string, expected: string, found: unknown): void => {
        errors.push(projectError(`${p}/${path}`, code as ModelErrorV3['code'], message, expected, { document: 'content' } as never, found));
      };
      if (c.animator !== undefined && !controllerIds.has(c.animator.controller)) bad('animator/controller', 'reference_missing', 'the animator names no controller of this project', 'a controllerId in content.animators', c.animator.controller);
      for (const [slot, id] of Object.entries(c.materials ?? {})) if (!materialIds.has(id)) bad(`materials/${slot}`, 'reference_missing', 'the material mapping names no material of this project', 'a materialId in content.materials', id);
      if (c.materialParams !== undefined) for (const x of materialOverrideErrors(c.materialParams, content.materials ?? [])) bad(`materialParams${x.path}`, x.code, x.message, 'a public parameter of a graph material, with a value that fits it', x.found);
      if (c.effect !== undefined) for (const x of effectComponentErrors(c.effect, content.effects ?? [])) bad(`effect${x.path}`, x.code, x.message, 'an effect of this project and its public parameters', x.found);
      if (c.audioSource !== undefined && soundKinds.get(c.audioSource.assetId) !== 'audio') bad('audioSource/assetId', 'asset_reference_missing', 'an audio source plays an audio asset of this project', 'an audio assetId', c.audioSource.assetId);
    });
  });
  prefabRefRules.set(prefabs, { key, errors });
  return errors;
}

const prefabPhysics = new WeakMap<object, { key: readonly unknown[]; errors: readonly ModelErrorV3[] }>();

/** A prefab's collider follows the project's physics dimension; a copy's behavior group is one of the project's (kept with the prefab list and those settings). */
function prefabPhysicsRules(content: ContentCatalogV4): readonly ModelErrorV3[] {
  const prefabs = content.prefabs ?? [];
  const key = [content.settings, content.collisionLayers, content.behaviorGroups];
  const hit = prefabPhysics.get(prefabs);
  if (hit !== undefined && hit.key.every((v, i) => v === key[i])) return hit.errors;
  const errors: ModelErrorV3[] = [];
  const dimension = physicsDimensionOf(content.settings);
  prefabs.forEach((d, di) => {
    d.entities.forEach((e, ei) => {
      const local: ModelErrorV3[] = [];
      physicsDimensionErrors(e.components as unknown as Record<string, unknown>, `/prefabs/${di}/entities/${ei}`, dimension, local, `/prefabs/${di}/entities/${ei}/components`, content.collisionLayers ?? []);
      behaviorGroupErrors(e.components as unknown as Record<string, unknown>, `/prefabs/${di}/entities/${ei}`, content.behaviorGroups ?? [], local as never);
      for (const x of local) errors.push({ ...x, document: 'content' } as ModelErrorV3);
    });
  });
  prefabPhysics.set(prefabs, { key, errors });
  return errors;
}

/**
 * The rules of one physics-bearing entity (scene entity or prefab
 * entity; `path` is the entity's pointer) that depend on the project's
 * physics dimension. A 2D plane: rotation about Z only. 3D: any collider
 * rotation, the controller upright; every box collider needs its half depth
 * `hz` (no guessed depth); a polygon collider is a 2D-plane shape (3D uses
 * the 3D shapes and mesh colliders).
 */
export function physicsDimensionErrors(comps: Record<string, unknown>, path: string, dimension: 2 | 3, errors: ModelErrorV3[], rotationBase: string = path, collisionLayers: readonly string[] = []): void {
  blockDimensionErrors(comps, path, dimension, errors);
  const collider = comps['collider'] as { shape?: { type?: string; hz?: number } } | undefined;
  const hasController = comps['controller'] !== undefined;
  if (collider === undefined && !hasController) return;
  // The scale rule follows the dimension too (a 3D collider may be scaled).
  physicsScaleErrors(comps, rotationBase, hasController, dimension, errors);
  physicsRotationErrors(comps, rotationBase, hasController, dimension, errors);
  if (collider === undefined) return;
  const shape = collider.shape;
  const type = shape?.type;
  // Collision layers are 3D physics (the 2D plane is unchanged); each must be the implicit
  // "default" or one the project names.
  const layers = (collider as { layers?: unknown }).layers;
  if (Array.isArray(layers)) {
    if (dimension !== 3) errors.push(withFound({ code: 'field_value', path: `${path}/components/collider/layers`, message: 'collision layers are a 3D physics feature (set physics_dimension to 3)', expected: 'absent' } as ModelErrorV3, layers));
    else layers.forEach((name, i) => {
      if (typeof name === 'string' && name !== 'default' && !collisionLayers.includes(name)) errors.push(withFound({ code: 'reference_missing', path: `${path}/components/collider/layers/${i}`, message: `the collision layer "${name}" is not one of the project's layers`, expected: `default or one of: ${collisionLayers.join(', ') || '(none named)'}` } as ModelErrorV3, name));
    });
  }
  if (dimension !== 3) {
    // The 3D shapes need a 3D project.
    if (type === 'sphere' || type === 'capsule' || type === 'convex' || type === 'mesh') {
      errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/components/collider/shape/type`, message: `a ${type} collider is a 3D shape; a 2D-plane project uses box or polygon colliders (or set physics_dimension to 3)`, expected: '"box" | "polygon"' } as ModelErrorV3, type));
    }
    return;
  }
  if (type === 'box' && shape?.hz === undefined) {
    errors.push({ code: 'collider_shape_invalid', path: `${path}/components/collider/shape/hz`, message: 'a box collider in a 3D project needs its half depth hz (m)', expected: 'hz > 0' } as ModelErrorV3);
  } else if (type === 'polygon') {
    errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/components/collider/shape/type`, message: 'a polygon collider is a 2D-plane shape; a 3D project uses box (with hz), sphere, capsule, convex or mesh colliders', expected: '"box" | "sphere" | "capsule" | "convex" | "mesh"' } as ModelErrorV3, 'polygon'));
  } else if (type === 'mesh' && (comps['mover'] !== undefined || comps['controller'] !== undefined)) {
    // A triangle mesh has no inside: it is level geometry that never moves.
    errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/components/collider/shape/type`, message: 'a mesh collider is static level geometry; a moving collider (a mover) uses box, sphere, capsule or convex', expected: '"box" | "sphere" | "capsule" | "convex"' } as ModelErrorV3, 'mesh'));
  }
  if ((collider as { oneWay?: unknown }).oneWay === true) {
    errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/components/collider/oneWay`, message: 'a one-way collider is a 2D-plane platform (passed from below); a 3D project has none', expected: 'absent' } as ModelErrorV3, true));
  }
}

/**
 * The gameplay blocks' rules that follow the project's physics
 * dimension. A trigger's `sphere` and `capsule` are 3D areas (a 2D plane has
 * `box` and `circle`); in 3D a box trigger needs its depth (`size` [w, h, d])
 * and a circle is a sphere. A switch tests the character on the 2D plane
 * only, so a 3D project refuses it rather than ignoring depth.
 */
export function blockDimensionErrors(comps: Record<string, unknown>, path: string, dimension: 2 | 3, errors: ModelErrorV3[]): void {
  const trigger = comps['trigger'] as { shape?: unknown; size?: unknown } | undefined;
  if (trigger !== undefined && typeof trigger === 'object' && trigger !== null) {
    const shape = trigger.shape ?? 'box';
    if (dimension !== 3 && (shape === 'sphere' || shape === 'capsule')) {
      errors.push(withFound({ code: 'field_value', path: `${path}/components/trigger/shape`, message: `a ${String(shape)} trigger is a 3D area; a 2D-plane project uses box or circle (or set physics_dimension to 3)`, expected: '"box" | "circle"' } as ModelErrorV3, shape));
    }
    if (dimension === 3 && shape === 'circle') {
      errors.push(withFound({ code: 'field_value', path: `${path}/components/trigger/shape`, message: 'a circle trigger is a 2D-plane area; a 3D project uses box (with a depth), sphere or capsule', expected: '"box" | "sphere" | "capsule"' } as ModelErrorV3, shape));
    }
    if (dimension === 3 && shape === 'box' && !(Array.isArray(trigger.size) && trigger.size.length === 3)) {
      errors.push(withFound({ code: 'field_value', path: `${path}/components/trigger/size`, message: 'a box trigger in a 3D project needs its depth: size [w, h, d] (m)', expected: '[w, h, d]' } as ModelErrorV3, trigger.size));
    }
  }
  if (dimension === 3) {
    if (comps['switch'] !== undefined) {
      errors.push({ code: 'component_conflict', path: `${path}/components/switch`, message: 'the switch block works on the 2D plane only; a 3D project uses triggers', expected: 'trigger' } as ModelErrorV3);
    }
  }
}

/**
 * The rules one v4 scene must meet against the project content block: the
 * v3 per-scene cross-block rules (assets, cues, tags, behaviors, prefabs —
 * v3's game rules are replaced by the project-level ones in `composeV4`) and
 * instance-set assets. The command layer runs this on the scene an edit
 * touches; `composeV4` runs it for every scene.
 */
export function composeSceneV4(s: SceneV4, content: ContentCatalogV4, errors: ModelErrorV3[], projectRevision: number = Number.MAX_SAFE_INTEGER): void {
  // A scene composed before against the same content sections gives the same answer (documents are immutable values).
  // A scene with block layers reads the materials too (a block type's material).
  const key = [...SCENE_RULE_SECTIONS.map((k) => (content as unknown as Record<string, unknown>)[k]), s.blocks !== undefined ? content.materials : null];
  const hit = composedScenes.get(s);
  if (hit !== undefined && hit.key.length === key.length && hit.key.every((v, i) => v === key[i])) {
    errors.push(...hit.errors);
    return;
  }
  const own: ModelErrorV3[] = [];
  composeSceneRules(s, content, own, projectRevision);
  composedScenes.set(s, { key, errors: own });
  errors.push(...own);
}

/**
 * The content sections the per-scene rules read (asset kinds and records,
 * prefab definitions, behavior declarations, tags, the physics dimension in
 * the settings, collision layers, behavior groups, block types, cell fields
 * and stamps; with block layers the materials): a scene is composed again
 * only when one of them changed.
 */
const SCENE_RULE_SECTIONS = ['assets', 'prefabs', 'behaviors', 'tags', 'settings', 'collisionLayers', 'behaviorGroups', 'blockTypes', 'cellFields', 'blockStamps'] as const;
const composedScenes = new WeakMap<SceneV4, { key: readonly unknown[]; errors: readonly ModelErrorV3[] }>();

function composeSceneRules(s: SceneV4, content: ContentCatalogV4, errors: ModelErrorV3[], projectRevision: number): void {
  const assetById = derivedOf(content.assets, 'by-id', () => new Map(content.assets.map((a) => [a.assetId, a])));
  const local: ModelErrorV3[] = [];
  // The v3 rules compare published revisions with the scene's revision; in
  // v4 the project revision (shared by all files) is the bound.
  const asV3 = { ...s, schemaVersion: 3, revision: projectRevision } as unknown as SceneV3;
  composeV3(asV3, { ...content, game: null }, local, false);
  for (const e of local) errors.push(e.document === 'content' ? e : sceneError(s.sceneId, e));
  // The rules that follow the project's physics dimension.
  const dimension = physicsDimensionOf(content.settings);
  s.entities.forEach((e, i) => {
    const local3: ModelErrorV3[] = [];
    physicsDimensionErrors(e.components as unknown as Record<string, unknown>, `/entities/${i}`, dimension, local3, `/entities/${i}`, content.collisionLayers ?? []);
    // An entity's behavior group is one of the project's.
    behaviorGroupErrors(e.components as unknown as Record<string, unknown>, `/entities/${i}`, content.behaviorGroups ?? [], local3 as never);
    for (const x of local3) errors.push(sceneError(s.sceneId, x));
  });
  // The cells against the block types and the metadata schema.
  if (s.blocks !== undefined) {
    const local5: ModelErrorV3[] = [];
    composeBlockLayers(s.blocks, s.entities as unknown as { id: string; components: Record<string, unknown> }[], content as unknown as BlockContentView, local5);
    for (const x of local5) errors.push(sceneError(s.sceneId, x));
  }
  // The scene's sky images and grading LUT are plain texture assets of the project.
  if (s.environment !== undefined) {
    const sky = s.environment.sky;
    const refs: [string, string][] = [];
    if (sky?.texture !== undefined) refs.push(['/environment/sky/texture', sky.texture]);
    (sky?.cube ?? []).forEach((id, i) => refs.push([`/environment/sky/cube/${i}`, id]));
    const lut = s.environment.post?.grading?.lut;
    if (lut !== undefined) refs.push(['/environment/post/grading/lut', lut]);
    for (const [path, id] of refs) {
      const record = assetById.get(id);
      if (record === undefined || record.kind !== 'texture' || arrayTextureIds(content).has(id)) {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path, message: 'this environment image must name a (plain) texture asset of this project', expected: 'a texture assetId' }, id)));
      }
    }
  }
  s.entities.forEach((e, i) => {
    const inst = e.components.instances;
    if (inst === undefined) return;
    const record = assetById.get(inst.asset.assetId);
    if (record === undefined) {
      errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/instances/asset/assetId`, message: 'an instance set names no asset of the catalog', expected: 'an existing model assetId' }, inst.asset.assetId)));
    } else if (record.kind !== 'model') {
      errors.push(sceneError(s.sceneId, withFound({ code: 'asset_kind_mismatch', path: `/entities/${i}/components/instances/asset/assetId`, reason: 'model', message: 'an instance set places a model', expected: '"model"' }, record.kind)));
    }
  });
}

/**
 * Validate a whole v4 project (manifest v2, content v4, the scene files).
 * Each document's own rules first; the cross-document rules only when all
 * documents are valid on their own.
 */
export function validateProjectV4(
  manifest: unknown,
  content: unknown,
  scenes: readonly unknown[],
  projectRevision: number = Number.MAX_SAFE_INTEGER,
): ModelResultV3<ProjectV4> {
  const errors: ModelErrorV3[] = [];
  const m = validateManifestV2Project(manifest);
  if (!m.ok) errors.push(...m.errors.map((e) => ({ ...e, document: 'manifest' as const })));
  const c = validateContentV4(content);
  if (!c.ok) errors.push(...c.errors.map((e) => ({ ...e, document: 'content' as const })));
  const parsed: SceneV4[] = [];
  scenes.forEach((doc, i) => {
    const r = validateSceneV4(doc);
    const sid = isPlainObject(doc) && typeof doc['sceneId'] === 'string' ? (doc['sceneId'] as string) : `#${i}`;
    if (!r.ok) errors.push(...r.errors.map((e) => sceneError(sid, e)));
    else parsed.push(r.normalized);
  });
  if (errors.length > 0) return fail(errors);
  const project: ProjectV4 = {
    manifest: (m as { normalized: ProjectManifestV2 }).normalized,
    content: (c as { normalized: ContentCatalogV4 }).normalized,
    scenes: [...parsed].sort((a, b) => (a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0)),
  };
  composeV4(project.scenes, project.content, errors, projectRevision);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: project };
}

// ---- migration v3 → v4 -------------------------------------------------------

/** The display name the migration gives the one v3 scene (in the scene index). */
export const MIGRATED_SCENE_NAME = 'Main';

export interface MigrationV4Result {
  project: ProjectV4;
  /** What the migration changed beyond the layout (shown to the owner / logged). */
  notes: string[];
}

function nextId(taken: Set<string>, prefix: string): string {
  // The assigned ids' width (at least six digits).
  const id = nextFreeEntityIdOf(taken, prefix);
  if (id === undefined) throw new Error(`no free ${prefix} id`);
  return id;
}

/**
 * Pure v3 → v4: the one v3 scene becomes scene v4 (same id, name "Main") and
 * the content block gains `startScenes: [that scene]`. A non-null v3 game
 * block does not validate, so `content.game` is always null here; v4 content
 * has no `game`. Retry records are not carried over (the upgrade is a
 * history boundary).
 */
export function migrateProjectV3ToV4(manifest: M1Manifest, scene: SceneV3, content: ContentCatalogV3): MigrationV4Result {
  const notes: string[] = [];
  const entities: SceneEntityV3[] = JSON.parse(JSON.stringify(scene.entities)) as SceneEntityV3[];
  const sceneV4: SceneV4 = {
    schemaVersion: 4,
    sceneId: scene.sceneId,
    revision: scene.revision,
    entities,
  };
  const { game: _game, ...rest } = JSON.parse(JSON.stringify(content)) as ContentCatalogV3;
  const contentV4: ContentCatalogV4 = {
    ...rest,
    scenes: [{ sceneId: scene.sceneId, name: MIGRATED_SCENE_NAME }],
    startScenes: [scene.sceneId],
  };

  const manifestV2: ProjectManifestV2 = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    engineVersion: manifest.engineVersion,
    id: manifest.id,
    name: manifest.name,
    createdAt: manifest.createdAt,
  };
  // A v3 scene holds the scene camera: it becomes a shot, as the open upgrades a 6 (one shape for new and upgraded projects).
  const model = upgradeSceneModel(contentV4, [sceneV4]);
  return { project: { manifest: manifestV2, content: model.content as ContentCatalogV4, scenes: model.scenes as SceneV4[] }, notes };
}
