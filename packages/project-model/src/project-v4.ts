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
import { composeV3 } from './project-v3';
import { validateContentV4, MAX_SCENES, physicsDimensionOf, arrayTextureIds, TEXTURE_ARRAY_KIND } from './content';
import { effectiveEntityFlags } from './hierarchy-v3';
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
import { PROJECT_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION_UPGRADED, isUpgradedProjectSchemaVersion } from './upgrade-v24';
import { nextFreeEntityIdOf } from './entity-ids';

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
        ? fieldValue('/schemaVersion', doc['schemaVersion'], String(PROJECT_SCHEMA_VERSION), `a schemaVersion ${String(doc['schemaVersion'])} project is upgraded by the loader before it is validated (${doc['schemaVersion'] === PROJECT_SCHEMA_VERSION_UPGRADED ? 'upgradeProjectDocsV24, then ' : ''}upgradeProjectDocsV25)`)
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
 */
export function composeV4(
  scenes: readonly SceneV4[],
  content: ContentCatalogV4,
  errors: ModelErrorV3[],
  /** The project revision (the highest file revision); asset versions must not be newer. */
  projectRevision: number = Number.MAX_SAFE_INTEGER,
): void {
  if (scenes.length > MAX_SCENES) {
    errors.push(projectError('', 'limits_exceeded', `a project may hold at most ${MAX_SCENES} scenes`, `<= ${MAX_SCENES}`, { limit: 'entities' as never, current: scenes.length, max: MAX_SCENES }));
  }
  const sceneIds = new Set<string>();
  for (const s of scenes) {
    if (sceneIds.has(s.sceneId)) errors.push(projectError('/sceneId', 'id_duplicate', 'two scene files use the same scene id', 'unique scene ids', { document: 'scene', sceneId: s.sceneId } as never, s.sceneId));
    sceneIds.add(s.sceneId);
  }

  // Entity ids are unique across the project.
  const owner = new Map<string, string>();
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const first = owner.get(e.id);
      if (first !== undefined) {
        errors.push(sceneError(s.sceneId, withFound({ code: 'id_duplicate', path: `/entities/${i}/id`, message: `entity id is already used in scene "${first}" (ids are unique across the project)`, expected: 'a project-unique entity id' }, e.id)));
      } else owner.set(e.id, s.sceneId);
    });
  }
  const entityById = new Map<string, { entity: SceneEntityV3; sceneId: string }>();
  for (const s of scenes) for (const e of s.entities) if (!entityById.has(e.id)) entityById.set(e.id, { entity: e, sceneId: s.sceneId });

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
  // one directional, one ambient, one hemisphere, 16 point/spot). The camera and the controller stay start-scene only.
  let cameras = 0;
  let controllers = 0;
  for (const s of scenes) {
    const inStart = start.has(s.sceneId);
    const flags = effectiveEntityFlags(s.entities);
    s.entities.forEach((e, i) => {
      if (isFolderEntity(e)) return;
      const c = e.components;
      const oneOf: string[] = [];
      if (c.camera !== undefined) oneOf.push('camera');
      if (c.controller !== undefined) oneOf.push('controller');
      if (oneOf.length === 0) return;
      if (!inStart) {
        errors.push(
          sceneError(s.sceneId, withFound({
            code: 'component_conflict',
            path: `/entities/${i}/components`,
            reason: 'start_scene_only',
            message: `a ${oneOf.join(' / ')} belongs in a start scene (scenes loaded later hold level content and lights only)`,
            expected: 'the entity in a scene listed in content.startScenes',
          }, oneOf)),
        );
        return;
      }
      if (c.camera !== undefined && flags.get(e.id)?.active !== false) cameras += 1;
      if (c.controller !== undefined) controllers += 1;
    });
  }
  if (cameras !== 1) errors.push(projectError('/startScenes', 'camera_count_invalid', 'the start scenes together hold exactly one active camera', 'exactly 1 camera', { document: 'content' } as never, cameras));
  if (controllers > 1) errors.push(projectError('/startScenes', 'controller_count_invalid', 'the start scenes hold at most one player controller', 'at most 1 controller', { document: 'content' } as never, controllers));

  // The shell's listed scenes are scenes of the project, each spawn a player spawn in its scene.
  const shell = (content as { shell?: { scenes?: { scene: string; spawn?: string }[] } }).shell;
  if (shell?.scenes !== undefined) {
    const sceneIds = new Set(scenes.map((sc) => sc.sceneId));
    shell.scenes.forEach((entry, i) => {
      const p = `/shell/scenes/${i}`;
      if (!sceneIds.has(entry.scene)) errors.push(projectError(`${p}/scene`, 'reference_missing', 'a listed scene names an unknown scene', 'a sceneId of this project', { document: 'content' } as never, entry.scene));
      if (entry.spawn !== undefined) {
        const spawn = entityById.get(entry.spawn);
        if (spawn === undefined || spawn.entity.components.playerSpawn === undefined || spawn.sceneId !== entry.scene) {
          errors.push(projectError(`${p}/spawn`, 'reference_missing', 'a listed scene starts at a player spawn in that scene', 'a playerSpawn entity id in the scene', { document: 'content' } as never, entry.spawn));
        }
      }
    });
  }

  // An audio source plays an audio or music asset of this project.
  // A cookie is one plain texture (a texture array is read by graph materials only).
  const arrays = arrayTextureIds(content as unknown as Record<string, unknown>);
  const soundKinds = new Map((content.assets as { assetId: string; kind?: string }[]).map((a) => [a.assetId, arrays.has(a.assetId) ? TEXTURE_ARRAY_KIND : a.kind]));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      // A spot light's cookie is a texture asset of this project.
      const cookie = (e.components as { light?: { cookie?: string } }).light?.cookie;
      if (cookie !== undefined && soundKinds.get(cookie) !== 'texture') {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/light/cookie`, message: 'a spot light\'s cookie is a texture asset of this project', expected: 'a texture assetId' }, cookie)));
      }
      const src = (e.components as { audioSource?: { assetId: string } }).audioSource;
      if (src !== undefined && soundKinds.get(src.assetId) !== 'audio' && soundKinds.get(src.assetId) !== 'music') {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/audioSource/assetId`, message: 'an audio source plays an audio or music asset of this project', expected: 'an audio or music assetId' }, src.assetId)));
      }
    });
  }

  // A pickup's collect sound is an audio asset of this project.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const cue = (e.components as { pickup?: { cue?: string } }).pickup?.cue;
      if (cue !== undefined && soundKinds.get(cue) !== 'audio') {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/pickup/cue`, message: 'a pickup cue plays an audio asset of this project', expected: 'an audio assetId' }, cue)));
      }
    });
  }

  // An animator names a controller of this project.
  const controllerIds = new Set((content.animators ?? []).map((c) => c.controllerId));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const a = e.components.animator;
      if (a !== undefined && !controllerIds.has(a.controller)) {
        errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/animator/controller`, message: 'the animator names no controller of this project', expected: 'a controllerId in content.animators' }, a.controller)));
      }
    });
  }

  // An object's material mapping names project materials.
  const materialIds = new Set((content.materials ?? []).map((m) => m.materialId));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const mapping = e.components.materials;
      if (mapping === undefined) return;
      for (const [slot, id] of Object.entries(mapping)) {
        if (!materialIds.has(id)) {
          errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/materials/${slot}`, message: 'the material mapping names no material of this project', expected: 'a materialId in content.materials' }, id)));
        }
      }
    });
  }

  // Overrides name public parameters of the project's graph materials.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const o = e.components.materialParams;
      if (o === undefined) return;
      for (const x of materialOverrideErrors(o, content.materials ?? [])) {
        errors.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/materialParams${x.path}`, message: x.message, expected: 'a public parameter of a graph material, with a value that fits it' }, x.found)));
      }
    });
  }

  // An effect component names a project effect and overrides only its public parameters.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const c = e.components.effect;
      if (c === undefined) return;
      for (const x of effectComponentErrors(c, content.effects ?? [])) {
        errors.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/effect${x.path}`, message: x.message, expected: 'an effect of this project and its public parameters' }, x.found)));
      }
    });
  }
  // A prefab's gameplay components name project things too.
  (content.prefabs ?? []).forEach((d, di) => {
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
      if (c.audioSource !== undefined && soundKinds.get(c.audioSource.assetId) !== 'audio' && soundKinds.get(c.audioSource.assetId) !== 'music') bad('audioSource/assetId', 'asset_reference_missing', 'an audio source plays an audio or music asset of this project', 'an audio or music assetId', c.audioSource.assetId);
    });
  });

  // triggers' scene transitions (the scenes exist; the spawn is a player spawn the character can reach).
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const t = (e.components as { trigger?: { sceneTransition?: { scene: string; spawn?: string; unload?: string[] } } }).trigger?.sceneTransition;
      if (t === undefined) return;
      const at = `/entities/${i}/components/trigger/sceneTransition`;
      if (!sceneIds.has(t.scene)) errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/scene`, reason: 'scene', message: 'a scene transition names no scene of the project', expected: 'an existing scene id' }, t.scene)));
      (t.unload ?? []).forEach((id, j) => {
        if (!sceneIds.has(id)) errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/unload/${j}`, reason: 'scene', message: 'a scene transition unloads no scene of the project', expected: 'an existing scene id' }, id)));
      });
      if (t.spawn !== undefined) {
        const hit = entityById.get(t.spawn);
        const reachable = hit !== undefined && (hit.sceneId === s.sceneId || hit.sceneId === t.scene);
        if (hit === undefined || hit.entity.components.playerSpawn === undefined || !reachable) {
          errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `${at}/spawn`, reason: 'spawn', message: 'a scene transition\'s spawn must be a player spawn in the scene it loads (or its own)', expected: 'a playerSpawn entity id' }, t.spawn)));
        }
      }
    });
  }

  // Per-scene references against the content block.
  for (const s of scenes) composeSceneV4(s, content, errors, projectRevision);

  // A prefab's collider follows the project's physics dimension too.
  const dimension = physicsDimensionOf(content.settings);
  (content.prefabs ?? []).forEach((d, di) => {
    d.entities.forEach((e, ei) => {
      const local: ModelErrorV3[] = [];
      physicsDimensionErrors(e.components as unknown as Record<string, unknown>, `/prefabs/${di}/entities/${ei}`, dimension, local, `/prefabs/${di}/entities/${ei}/components`, content.collisionLayers ?? []);
      // A copy's behavior group is one of the project's.
      behaviorGroupErrors(e.components as unknown as Record<string, unknown>, `/prefabs/${di}/entities/${ei}`, content.behaviorGroups ?? [], local as never);
      for (const x of local) errors.push({ ...x, document: 'content' } as ModelErrorV3);
    });
  });
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
  const assetById = new Map(content.assets.map((a) => [a.assetId, a]));
  const local: ModelErrorV3[] = [];
  // The v3 rules compare published revisions with the scene's revision; in
  // v4 the project revision (shared by all files) is the bound.
  const asV3 = { ...s, schemaVersion: 3, revision: projectRevision } as unknown as SceneV3;
  composeV3(asV3, { ...content, game: null }, local);
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
  return { project: { manifest: manifestV2, content: contentV4, scenes: [sceneV4] }, notes };
}
