/**
 * Phase 12 (c): the v4 project — several scenes, one file each — and the
 * pure v3 → v4 migration.
 *
 * Layout (storage v4, workspace): `project.json` (manifest schemaVersion 2),
 * `content.json` (the project-wide content block: assets, prefabs,
 * behaviors, settings, trust, game, tags, startScenes) and
 * `scenes/<sceneId>.json` (one v4 scene each). This module holds the rules
 * that span documents:
 *
 * - scene ids are unique; entity ids are unique across the whole project;
 * - `startScenes` name existing scenes. The start set holds the one-per-game
 *   things — exactly one (active) camera, at most one controller and one
 *   light of each type; other scenes (loaded later) hold none of these;
 * - `content.game` names its player, camera and start spawn in start
 *   scenes, and the project has at least one goal zone;
 * - an exit zone names existing scenes, and its spawn sits in a scene it
 *   loads (or its own);
 * - every scene's asset, cue, tag and behavior references resolve against
 *   the content block (the v3 per-scene cross-block rules, reused).
 *
 * Level bounds and a kill height are gone in v4: rules like these are a
 * game's own logic (scripts, hazard zones). Pure: no I/O.
 */

import { composeV3 } from './project-v3';
import { validateContentV4, MAX_SCENES, physicsDimensionOf } from './content';
import { effectiveEntityFlags } from './hierarchy-v3';
import { validateSceneV4 } from './scene-v3';
import { ID_RE_V2, physicsRotationErrors, physicsScaleErrors } from './components';
import { fail, fieldMissing, fieldType, fieldValue, isPlainObject, isValidName, pointerSegment, unexpectedField, withFound } from './validate';
import type { ModelErrorV3, ModelResultV3 } from './errors';
import type { Manifest as M1Manifest } from './types';
import type { ContentCatalogV3, ContentCatalogV4, GameConfig, SceneEntityV3, SceneV3, SceneV4 } from './types-v3';
import { isFolderEntity } from './types-v3';
import type { GameFlow } from './flow';
import { materialOverrideErrors } from './materials';
import { effectComponentErrors, effectHookRefs } from './effects';

/** Phase 12 (c): `project.json` schemaVersion 2 — scenes are the files in `scenes/`. */
export interface ProjectManifestV2 {
  schemaVersion: 2;
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
  if (doc['schemaVersion'] !== 2) errors.push(fieldValue('/schemaVersion', doc['schemaVersion'], '2', 'a v4 project manifest has schemaVersion 2'));
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
    normalized: { schemaVersion: 2, engineVersion: ev as string, id: id as string, name: name as string, createdAt: at as string },
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
  let cameras = 0;
  let directional = 0;
  let ambient = 0;
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
      // Phase 9.5: point and spot lights may sit in any scene (a torch in a level).
      if (c.light !== undefined && c.light.type !== 'point' && c.light.type !== 'spot') oneOf.push(`${c.light.type} light`);
      if (oneOf.length === 0) return;
      if (!inStart) {
        errors.push(
          sceneError(s.sceneId, withFound({
            code: 'component_conflict',
            path: `/entities/${i}/components`,
            reason: 'start_scene_only',
            message: `a ${oneOf.join(' / ')} belongs in a start scene (scenes loaded later hold level content only)`,
            expected: 'the entity in a scene listed in content.startScenes',
          }, oneOf)),
        );
        return;
      }
      if (c.camera !== undefined && flags.get(e.id)?.active !== false) cameras += 1;
      if (c.controller !== undefined) controllers += 1;
      if (c.light?.type === 'directional') directional += 1;
      if (c.light?.type === 'ambient') ambient += 1;
    });
  }
  if (cameras !== 1) errors.push(projectError('/startScenes', 'camera_count_invalid', 'the start scenes together hold exactly one active camera', 'exactly 1 camera', { document: 'content' } as never, cameras));
  if (controllers > 1) errors.push(projectError('/startScenes', 'controller_count_invalid', 'the start scenes hold at most one player controller', 'at most 1 controller', { document: 'content' } as never, controllers));
  if (directional > 1) errors.push(projectError('/startScenes', 'limits_exceeded', 'the start scenes hold at most one directional light', '<= 1', { document: 'content', limit: 'lights_directional' as never, current: directional, max: 1 } as never));
  if (ambient > 1) errors.push(projectError('/startScenes', 'limits_exceeded', 'the start scenes hold at most one ambient light', '<= 1', { document: 'content', limit: 'lights_ambient' as never, current: ambient, max: 1 } as never));

  // The game block (project-level references).
  const game: GameConfig | null = content.game;
  if (game !== null) {
    const ref = (key: 'playerId' | 'cameraId' | 'spawnId', ok: (e: SceneEntityV3) => boolean, what: string): void => {
      const hit = entityById.get(game[key]);
      const reason = key === 'playerId' ? 'player' : key === 'cameraId' ? 'camera' : 'spawn';
      if (hit === undefined || !ok(hit.entity)) {
        errors.push(projectError(`/game/${key}`, 'game_reference_missing', `game.${key} must name ${what}`, what, { document: 'content', reason } as never, game[key]));
      } else if (!start.has(hit.sceneId)) {
        errors.push(projectError(`/game/${key}`, 'game_reference_missing', `game.${key} must be in a start scene (it is in "${hit.sceneId}")`, 'an entity in a start scene', { document: 'content', reason } as never, game[key]));
      }
    };
    ref('playerId', (e) => e.components.controller !== undefined, 'the entity carrying the player controller');
    ref('cameraId', (e) => e.components.camera !== undefined && e.components.cameraFollow !== undefined, 'the camera entity (carrying cameraFollow)');
    ref('spawnId', (e) => e.components.playerSpawn !== undefined, 'an entity carrying playerSpawn');
    const goals = scenes.reduce((n, s) => n + s.entities.filter((e) => e.components.gameZone?.role === 'goal').length, 0);
    if (goals < 1) errors.push(projectError('/game', 'zone_goal_missing', 'content.game requires at least one goal zone in the project', '>= 1 goal zone', { document: 'content' } as never));
  }

  // Phase 9.10: every level loads known scenes, starts at a spawn among them,
  // and keeps the player and the camera loaded.
  const flow = (content as { flow?: GameFlow }).flow;
  if (flow !== undefined) {
    const sceneIds = new Set(scenes.map((sc) => sc.sceneId));
    const holder = (id: string | undefined): string | undefined => (id === undefined ? undefined : entityById.get(id)?.sceneId);
    // Phase 14.5: the title background is a scene of this project.
    if (flow.title?.scene !== undefined && !sceneIds.has(flow.title.scene)) {
      errors.push(projectError('/flow/title/scene', 'reference_missing', 'the title background names an unknown scene', 'a sceneId of this project', { document: 'content' } as never, flow.title.scene));
    }
    flow.levels.forEach((level, i) => {
      const p = `/flow/levels/${i}`;
      for (const id of level.scenes) {
        if (!sceneIds.has(id)) errors.push(projectError(`${p}/scenes`, 'reference_missing', `level "${level.name}" names an unknown scene`, 'a sceneId of this project', { document: 'content' } as never, id));
      }
      const spawn = entityById.get(level.spawnId);
      if (spawn === undefined || spawn.entity.components.playerSpawn === undefined || !level.scenes.includes(spawn.sceneId)) {
        errors.push(projectError(`${p}/spawnId`, 'reference_missing', `level "${level.name}" must start at a player spawn in one of its scenes`, 'a playerSpawn entity in the level', { document: 'content' } as never, level.spawnId));
      }
      if (game !== null) {
        for (const [what, id] of [['player', game.playerId], ['camera', game.cameraId]] as const) {
          const sc = holder(id);
          if (sc !== undefined && !level.scenes.includes(sc)) errors.push(projectError(`${p}/scenes`, 'reference_missing', `level "${level.name}" must load the ${what}'s scene "${sc}"`, `the scene holding the ${what}`, { document: 'content' } as never, sc));
        }
      }
    });
  }

  // Phase 9.10: an audio source plays an audio or music asset of this project.
  const soundKinds = new Map((content.assets as { assetId: string; kind?: string }[]).map((a) => [a.assetId, a.kind]));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const src = (e.components as { audioSource?: { assetId: string } }).audioSource;
      if (src !== undefined && soundKinds.get(src.assetId) !== 'audio' && soundKinds.get(src.assetId) !== 'music') {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/audioSource/assetId`, message: 'an audio source plays an audio or music asset of this project', expected: 'an audio or music assetId' }, src.assetId)));
      }
    });
  }

  // Phase 9.9: a pickup's collect sound is an audio asset of this project.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const cue = (e.components as { pickup?: { cue?: string } }).pickup?.cue;
      if (cue !== undefined && soundKinds.get(cue) !== 'audio') {
        errors.push(sceneError(s.sceneId, withFound({ code: 'asset_reference_missing', path: `/entities/${i}/components/pickup/cue`, message: 'a pickup cue plays an audio asset of this project', expected: 'an audio assetId' }, cue)));
      }
    });
  }

  // Phase 9.7: an animator names a controller of this project.
  const controllerIds = new Set((content.animators ?? []).map((c) => c.controllerId));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const a = e.components.animator;
      if (a !== undefined && !controllerIds.has(a.controller)) {
        errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/animator/controller`, message: 'the animator names no controller of this project', expected: 'a controllerId in content.animators' }, a.controller)));
      }
    });
  }

  // Phase 9.4: an object's material mapping names project materials.
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

  // Phase 18.0: overrides name public parameters of the project's graph materials.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const o = e.components.materialParams;
      if (o === undefined) return;
      for (const x of materialOverrideErrors(o, content.materials ?? [])) {
        errors.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/materialParams${x.path}`, message: x.message, expected: 'a public parameter of a graph material, with a value that fits it' }, x.found)));
      }
    });
  }

  // Phase 20.0: an effect component names a project effect and overrides only its public parameters.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const c = e.components.effect;
      if (c === undefined) return;
      for (const x of effectComponentErrors(c, content.effects ?? [])) {
        errors.push(sceneError(s.sceneId, withFound({ code: x.code as never, path: `/entities/${i}/components/effect${x.path}`, message: x.message, expected: 'an effect of this project and its public parameters' }, x.found)));
      }
    });
  }
  // Phase 20.2: gameplay hooks (pickup collected, enemy hit/defeated, player hit, checkpoint/goal reached) name project effects.
  const effectIds = new Set((content.effects ?? []).map((e) => e.effectId));
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      for (const [path, id] of effectHookRefs(e.components as unknown as Record<string, unknown>)) {
        if (!effectIds.has(id)) errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/${path}`, message: 'the hook names no effect of this project', expected: 'an effectId in content.effects' }, id)));
      }
    });
  }

  // Phase 14.1: a prefab's gameplay components name project things too.
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
      for (const [path, id] of effectHookRefs(c as unknown as Record<string, unknown>)) if (!effectIds.has(id)) bad(path, 'reference_missing', 'the hook names no effect of this project', 'an effectId in content.effects', id);
      if (c.audioSource !== undefined && soundKinds.get(c.audioSource.assetId) !== 'audio' && soundKinds.get(c.audioSource.assetId) !== 'music') bad('audioSource/assetId', 'asset_reference_missing', 'an audio source plays an audio or music asset of this project', 'an audio or music assetId', c.audioSource.assetId);
      const cue = (c.pickup as { cue?: string } | undefined)?.cue;
      if (cue !== undefined && soundKinds.get(cue) !== 'audio') bad('pickup/cue', 'asset_reference_missing', 'a pickup cue plays an audio asset of this project', 'an audio assetId', cue);
    });
  });

  // Exit zones.
  for (const s of scenes) {
    s.entities.forEach((e, i) => {
      const z = e.components.gameZone;
      if (z?.role !== 'exit') return;
      for (const key of ['load', 'unload'] as const) {
        (z[key] ?? []).forEach((id, j) => {
          if (!sceneIds.has(id)) {
            errors.push(sceneError(s.sceneId, withFound({ code: 'reference_missing', path: `/entities/${i}/components/gameZone/${key}/${j}`, reason: 'scene', message: 'an exit names no scene of the project', expected: 'an existing scene id' }, id)));
          }
        });
      }
      if (z.spawnId !== undefined) {
        const hit = entityById.get(z.spawnId);
        const reachable = hit !== undefined && (hit.sceneId === s.sceneId || (z.load ?? []).includes(hit.sceneId));
        if (hit === undefined || hit.entity.components.playerSpawn === undefined || !reachable) {
          errors.push(sceneError(s.sceneId, withFound({ code: 'game_reference_missing', path: `/entities/${i}/components/gameZone/spawnId`, reason: 'spawn', message: 'an exit spawn must be a playerSpawn in a scene the exit loads (or its own)', expected: 'a playerSpawn entity id' }, z.spawnId)));
        }
      }
    });
  }

  // Per-scene references against the content block.
  for (const s of scenes) composeSceneV4(s, content, errors, projectRevision);

  // Phase 23.0: a prefab's collider follows the project's physics dimension too.
  const dimension = physicsDimensionOf(content.settings);
  (content.prefabs ?? []).forEach((d, di) => {
    d.entities.forEach((e, ei) => {
      const local: ModelErrorV3[] = [];
      physicsDimensionErrors(e.components as unknown as Record<string, unknown>, `/prefabs/${di}/entities/${ei}`, dimension, local, `/prefabs/${di}/entities/${ei}/components`);
      for (const x of local) errors.push({ ...x, document: 'content' } as ModelErrorV3);
    });
  });
}

/**
 * Phase 23.0: the rules of one physics-bearing entity (scene entity or prefab
 * entity; `path` is the entity's pointer) that depend on the project's
 * physics dimension. A 2D plane: the rotation about Z only rules (as before).
 * 3D: any collider rotation, the controller upright; every box collider
 * needs its half depth `hz` (no guessed depth); a polygon collider is a
 * 2D-plane shape (3D shapes and mesh colliders are phase 23.1).
 */
export function physicsDimensionErrors(comps: Record<string, unknown>, path: string, dimension: 2 | 3, errors: ModelErrorV3[], rotationBase: string = path): void {
  blockDimensionErrors(comps, path, dimension, errors);
  const collider = comps['collider'] as { shape?: { type?: string; hz?: number } } | undefined;
  const hasController = comps['controller'] !== undefined;
  if (collider === undefined && !hasController) return;
  // Phase 23.1: the scale rule follows the dimension too (a 3D collider may be scaled).
  physicsScaleErrors(comps, rotationBase, hasController, dimension, errors);
  physicsRotationErrors(comps, rotationBase, hasController, dimension, errors);
  if (collider === undefined) return;
  const shape = collider.shape;
  const type = shape?.type;
  if (dimension !== 3) {
    // Phase 23.1: the 3D shapes need a 3D project.
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
 * Phase 23.1: the gameplay blocks' rules that follow the project's physics
 * dimension. A trigger's `sphere` and `capsule` are 3D areas (a 2D plane has
 * `box` and `circle`); in 3D a box trigger needs its depth (`size` [w, h, d])
 * and a circle is a sphere. Switches, pickups and enemies test the player on
 * the 2D plane only (their 3D forms belong to the game modes, phase 23.10), so
 * a 3D project refuses them rather than ignoring depth.
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
    for (const block of ['switch', 'pickup', 'enemy'] as const) {
      if (comps[block] === undefined) continue;
      errors.push({ code: 'component_conflict', path: `${path}/components/${block}`, message: `the ${block} block works on the 2D plane only; a 3D project uses triggers (3D forms of the platformer blocks come with game modes)`, expected: 'trigger' } as ModelErrorV3);
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
  composeV3(asV3, { ...(content as ContentCatalogV3), game: null }, local);
  for (const e of local) errors.push(e.document === 'content' ? e : sceneError(s.sceneId, e));
  // Phase 23.0: the rules that follow the project's physics dimension.
  const dimension = physicsDimensionOf(content.settings);
  s.entities.forEach((e, i) => {
    const local3: ModelErrorV3[] = [];
    physicsDimensionErrors(e.components as unknown as Record<string, unknown>, `/entities/${i}`, dimension, local3);
    for (const x of local3) errors.push(sceneError(s.sceneId, x));
  });
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
  for (let n = 1; n <= 9999; n++) {
    const id = `${prefix}-${String(n).padStart(4, '0')}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`no free ${prefix} id`);
}

/**
 * Pure v3 → v4: the one v3 scene becomes scene v4 (same id, name "Main"),
 * the content block gains `startScenes: [that scene]`, and `content.game`
 * becomes configVersion 2. A v3 kill height becomes a hazard zone ("Fall
 * zone") spanning the old level width below it, so a game that relied on
 * falling to its death keeps working; the level bounds are dropped (the
 * camera keeps its own cameraFollow bounds). Retry records are not carried
 * over (the upgrade is a history boundary, charter §6).
 */
export function migrateProjectV3ToV4(manifest: M1Manifest, scene: SceneV3, content: ContentCatalogV3): MigrationV4Result {
  const notes: string[] = [];
  const entities: SceneEntityV3[] = JSON.parse(JSON.stringify(scene.entities)) as SceneEntityV3[];
  let game: GameConfig | null = null;
  if (content.game !== null) {
    const g = content.game;
    const { level, killY, ...rest } = g;
    game = { ...rest, configVersion: 2 };
    if (killY !== undefined) {
      const minX = level?.minX ?? -100;
      const maxX = level?.maxX ?? 100;
      const height = Math.max(20, level !== undefined ? level.maxY - level.minY : 20);
      const width = maxX - minX + 20;
      const taken = new Set(entities.map((e) => e.id));
      const id = nextId(taken, 'zone');
      entities.push({
        id,
        name: 'Fall zone',
        components: {
          transform: { position: [(minX + maxX) / 2, killY - height / 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          gameZone: { role: 'hazard', size: [width, height] },
        },
      });
      notes.push(`killY ${killY} became the hazard zone "${id}" (Fall zone) below the old level`);
    }
    if (level !== undefined) notes.push('level bounds dropped (the camera keeps its cameraFollow bounds)');
  }
  const sceneV4: SceneV4 = {
    schemaVersion: 4,
    sceneId: scene.sceneId,
    revision: scene.revision,
    entities,
  };
  const contentV4: ContentCatalogV4 = {
    ...(JSON.parse(JSON.stringify(content)) as ContentCatalogV3),
    game,
    scenes: [{ sceneId: scene.sceneId, name: MIGRATED_SCENE_NAME }],
    startScenes: [scene.sceneId],
  };
  const manifestV2: ProjectManifestV2 = {
    schemaVersion: 2,
    engineVersion: manifest.engineVersion,
    id: manifest.id,
    name: manifest.name,
    createdAt: manifest.createdAt,
  };
  return { project: { manifest: manifestV2, content: contentV4, scenes: [sceneV4] }, notes };
}
