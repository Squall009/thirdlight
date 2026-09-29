/**
 * Prefab definitions of the content catalog: entities, depth, the components a
 * prefab may carry, and their canonical form.
 */

import { canonicalEffectComponent, validateEffectComponent } from './effects';
import { canonicalBlockFootprint, validateBlockFootprintComponent } from './block-layers';
import { canonicalBehaviorGroup, validateBehaviorGroupComponent } from './modes';
import { canonicalMaterialMapping, canonicalMaterialParams, validateMaterialMapping, validateMaterialParamsComponent } from './materials';
import { canonicalAnimatorComponent, validateAnimatorComponent } from './animator';
import { BLOCK_COMPONENTS } from './blocks';
import { canonicalSurface, validateSurfaceComponent } from './scene-v3';
import {
  canonicalBox,
  canonicalTransform,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import type { PrefabDefinition, PrefabEntity, PropertyValue } from './types-v2';
import {
  canonicalCollider,
  colliderCore,
  validateColliderLayers,
  ID_RE_V2,
  validateBehaviorComponent,
  validateColliderComponent,
  validateModelComponent,
  validatePhysicsTransform,
} from './components';
import { MAX_PREFABS, MAX_PREFAB_DEPTH, MAX_PREFAB_ENTITIES } from './content-limits';
import { limitsError, sortedRecord } from './content-helpers';

const KNOWN_PREFAB_DEF_FIELDS = new Set(['prefabId', 'displayName', 'createdRevision', 'entityCount', 'depth', 'entities']);
const KNOWN_PREFAB_ENTITY_FIELDS = new Set(['localId', 'name', 'parentLocalId', 'components']);

// ---- prefabs (§20.2/§20.3) ----------------------------------------------------

function prefabDepth(entities: Record<string, unknown>[]): number {
  const byLocal = new Map<string, Record<string, unknown>>();
  for (const e of entities) {
    const id = e['localId'];
    if (typeof id === 'string') byLocal.set(id, e);
  }
  const depth = new Map<string, number>();
  let max = 0;
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    const e = byLocal.get(id);
    if (!e) return 0;
    seen.add(id);
    const parent = e['parentLocalId'];
    const d = typeof parent === 'string' ? depthOf(parent, seen) + 1 : 1;
    depth.set(id, d);
    if (d > max) max = d;
    return d;
  };
  for (const e of entities) {
    const id = e['localId'];
    if (typeof id === 'string') depthOf(id, new Set());
  }
  return max;
}

/**
 * Phase 14.1: the components a v4 prefab entity may carry besides transform,
 * model, box and behavior — what a spawned (`ctx.spawn`) or placed copy needs
 * to collide, look right and take part in the game (a crate, a collectible,
 * a walker, a moving projectile). Scene-only components (camera, controller,
 * lights, zones, spawn markers, instance sets, fog volumes) stay out: a copy
 * is never the character, the camera or level wiring. Phase 24.4: health is
 * any object's, so a copy may carry it.
 */
// Phase 18.0: `materialParams` (overrides of graph-material parameters) travels with the materials.
// Phase 20.0: `effect` (a copy plays its effect, e.g. a torch's flame).
// Phase 23.6: `blockFootprint` (a placed copy writes its footprint into the block cells beneath it).
// Phase 23.10: `behaviorGroup` (a copy's behavior ticks with its group).
// Phase 24.4: generic `health` (any object, not only the player) and the primitives `collectible`, `patrol`, `hitbox`.
export const PREFAB_V4_COMPONENTS = ['collider', 'surface', 'materials', 'animator', 'mover', 'trigger', 'switch', 'audioSource', 'faceMovement', 'materialParams', 'effect', 'blockFootprint', 'behaviorGroup', 'health', 'collectible', 'patrol', 'hitbox', 'climbVolume', 'gravity'] as const;
const PREFAB_BLOCKS = ['mover', 'trigger', 'switch', 'audioSource', 'faceMovement', 'health', 'collectible', 'patrol', 'hitbox', 'climbVolume', 'gravity'] as const;

function validatePrefabExtras(comps: Record<string, unknown>, parentLocalId: unknown, path: string, errors: ModelErrorV2[]): void {
  const col = comps['collider'];
  if (col !== undefined) {
    const oneWay = isPlainObject(col) ? col['oneWay'] : undefined;
    if (oneWay !== undefined && oneWay !== true) errors.push(fieldValue(`${path}/collider/oneWay`, oneWay, 'true', 'oneWay is true or absent'));
    // Phase 23.3: the collision layers the collider is in.
    if (isPlainObject(col) && col['layers'] !== undefined) validateColliderLayers(col['layers'], `${path}/collider/layers`, errors);
    validateColliderComponent(colliderCore(col), `${path}/collider`, errors);
    // A collider sits on the definition root at unit scale (as on a scene entity);
    // phase 23.0: its rotation rule follows the project's physics dimension (composeV4).
    validatePhysicsTransform(comps, typeof parentLocalId === 'string' ? parentLocalId : undefined, path, false, errors, false);
  }
  if (comps['surface'] !== undefined) {
    validateSurfaceComponent(comps['surface'], `${path}/surface`, errors as never);
    if (comps['box'] === undefined && comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/surface`, message: 'a surface component sits only on an entity carrying box or model', expected: 'box|model' });
  }
  if (comps['materials'] !== undefined) {
    validateMaterialMapping(comps['materials'], `${path}/materials`, errors);
    if (comps['box'] === undefined && comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/materials`, message: 'a materials component sits only on an entity with a model or a box', expected: 'model|box' });
  }
  if (comps['materialParams'] !== undefined) {
    validateMaterialParamsComponent(comps['materialParams'], `${path}/materialParams`, errors);
    if (comps['box'] === undefined && comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/materialParams`, message: 'material parameter overrides sit only on an entity with a model or a box', expected: 'model|box' });
  }
  if (comps['animator'] !== undefined) {
    validateAnimatorComponent(comps['animator'], `${path}/animator`, errors);
    if (comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/animator`, message: 'an animator sits only on an entity with a model', expected: 'model' });
  }
  if (comps['effect'] !== undefined) validateEffectComponent(comps['effect'], `${path}/effect`, errors);
  if (comps['blockFootprint'] !== undefined) validateBlockFootprintComponent(comps['blockFootprint'], `${path}/blockFootprint`, errors);
  if (comps['behaviorGroup'] !== undefined) validateBehaviorGroupComponent(comps['behaviorGroup'], `${path}/behaviorGroup`, errors);
  for (const name of PREFAB_BLOCKS) {
    if (comps[name] !== undefined) (BLOCK_COMPONENTS[name].validate as (c: unknown, p: string, e: ModelErrorV2[]) => void)(comps[name], `${path}/${name}`, errors);
  }
  // Phase 24.4: a patroller moves itself (as on a scene entity).
  if (comps['patrol'] !== undefined) {
    const clash = (['mover', 'collider'] as const).filter((c) => comps[c] !== undefined);
    if (clash.length > 0) errors.push(withFound({ code: 'component_conflict', path, message: `a patrol moves the object by itself: it cannot also carry ${clash.join(', ')}`, expected: 'patrol without mover or collider' }, ['patrol', ...clash]));
  }
}

function validatePrefabEntity(e: unknown, idx: number, path: string, errors: ModelErrorV2[], localIndex: Map<string, number>, version: 3 | 4 = 3): void {
  if (!isPlainObject(e)) {
    errors.push(fieldType(path, e, 'object'));
    return;
  }
  const localId = e['localId'];
  if (localId === undefined) errors.push(fieldMissing(`${path}/localId`, 'localId'));
  else if (typeof localId !== 'string') errors.push(fieldType(`${path}/localId`, localId, 'string'));
  else {
    if (!ID_RE_V2.test(localId)) errors.push(idInvalid(`${path}/localId`, localId));
    const first = localIndex.get(localId);
    if (first === undefined) localIndex.set(localId, idx);
    else {
      errors.push(
        withFound(
          { code: 'id_duplicate', path: `${path}/localId`, message: 'localId is already used in this definition (first occurrence wins)', expected: 'a unique localId within the definition' },
          localId,
        ),
      );
    }
  }
  const name = e['name'];
  if (name !== undefined) {
    if (typeof name !== 'string') errors.push(fieldType(`${path}/name`, name, 'string'));
    else if (!isValidName(name)) errors.push(fieldValue(`${path}/name`, name, 'string, 1-128 chars, no control characters', 'prefab entity name must be 1-128 characters without control characters'));
  }
  const parent = e['parentLocalId'];
  if (parent !== undefined && parent !== null) {
    if (typeof parent !== 'string') errors.push(fieldType(`${path}/parentLocalId`, parent, 'string or null'));
    else {
      const pidx = localIndex.get(parent);
      if (pidx === undefined) {
        errors.push(
          withFound(
            { code: 'prefab_reference_missing', path: `${path}/parentLocalId`, message: 'parentLocalId must reference an earlier entity localId in this definition', expected: 'an earlier localId' },
            parent,
          ),
        );
      } else if (pidx >= idx) {
        errors.push(
          withFound(
            { code: 'order_parent_before_child', path: `${path}/parentLocalId`, message: 'a prefab entity must appear before its parent (definition document order)', expected: 'parent index < child index' },
            parent,
          ),
        );
      }
    }
  }
  const comps = e['components'];
  if (comps === undefined) {
    errors.push(fieldMissing(`${path}/components`, 'components'));
  } else if (!isPlainObject(comps)) {
    errors.push(fieldType(`${path}/components`, comps, 'object'));
  } else {
    const allowed = new Set<string>(['transform', 'model', 'box', 'behavior', ...(version === 4 ? PREFAB_V4_COMPONENTS : [])]);
    const allowedText = version === 4 ? `transform, model, box, behavior, ${PREFAB_V4_COMPONENTS.join(', ')}` : 'transform, model, box, behavior';
    for (const k of Object.keys(comps)) {
      if (!allowed.has(k)) {
        if (k === 'camera' || k === 'prefab') {
          errors.push(
            withFound(
              {
                code: 'prefab_component_forbidden',
                path: `${path}/components/${pointerSegment(k)}`,
                message: `a prefab definition entity must not carry ${k}`,
                expected: allowedText,
              },
              k,
            ),
          );
        } else {
          errors.push(withFound({ code: 'component_unknown', path: `${path}/components/${pointerSegment(k)}`, message: 'component is not permitted in a prefab definition', expected: allowedText }, k));
        }
      }
    }
    if (comps['transform'] === undefined) {
      errors.push({ code: 'component_missing', path: `${path}/components/transform`, message: 'every prefab entity requires the transform component', expected: 'transform present' });
    }
    if (comps['model'] !== undefined) validateModelComponent(comps['model'], `${path}/components/model`, errors);
    if (comps['box'] !== undefined) {
      // box uses the M1 rules (size/material); canonicalization reuses §10.2.
      void canonicalBox;
    }
    if (comps['behavior'] !== undefined) validateBehaviorComponent(comps['behavior'], `${path}/components/behavior`, errors);
    if (version === 4) validatePrefabExtras(comps, parent, `${path}/components`, errors);
  }
  for (const k of Object.keys(e)) {
    if (!KNOWN_PREFAB_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'localId, name, parentLocalId, components'));
  }
}

export function validatePrefabDefinition(d: unknown, path: string, errors: ModelErrorV2[], version: 3 | 4 = 3): void {
  if (!isPlainObject(d)) {
    errors.push(fieldType(path, d, 'object'));
    return;
  }
  const prefabId = d['prefabId'];
  if (prefabId === undefined) errors.push(fieldMissing(`${path}/prefabId`, 'prefabId'));
  else if (typeof prefabId !== 'string') errors.push(fieldType(`${path}/prefabId`, prefabId, 'string'));
  else if (!ID_RE_V2.test(prefabId)) errors.push(idInvalid(`${path}/prefabId`, prefabId));

  const displayName = d['displayName'];
  if (displayName === undefined) errors.push(fieldMissing(`${path}/displayName`, 'displayName'));
  else if (typeof displayName !== 'string') errors.push(fieldType(`${path}/displayName`, displayName, 'string'));
  else if (!isValidName(displayName)) errors.push(fieldValue(`${path}/displayName`, displayName, 'string, 1-128 chars, no control characters', 'prefab displayName must be 1-128 characters without control characters'));

  const created = d['createdRevision'];
  if (created === undefined) errors.push(fieldMissing(`${path}/createdRevision`, 'createdRevision'));
  else if (typeof created !== 'number' || !Number.isInteger(created) || created < 0 || created > Number.MAX_SAFE_INTEGER) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/createdRevision`, message: 'createdRevision must be an integer in [0, 2^53-1]', expected: 'integer in [0, 2^53-1]' }, created));
  }

  const entities = d['entities'];
  if (entities === undefined) errors.push(fieldMissing(`${path}/entities`, 'entities'));
  else if (!Array.isArray(entities)) errors.push(fieldType(`${path}/entities`, entities, 'array'));
  else {
    if (entities.length < 1 || entities.length > MAX_PREFAB_ENTITIES) {
      errors.push(limitsError(`${path}/entities`, 'prefab_entities', entities.length, MAX_PREFAB_ENTITIES, `a definition must have 1-${MAX_PREFAB_ENTITIES} entities`));
    }
    const localIndex = new Map<string, number>();
    for (let i = 0; i < entities.length; i++) {
      validatePrefabEntity(entities[i], i, `${path}/entities/${i}`, errors, localIndex, version);
    }
    if (d['entityCount'] !== entities.length) {
      errors.push(fieldValue(`${path}/entityCount`, d['entityCount'], `entities.length (${entities.length})`, 'entityCount is derived and must equal entities.length'));
    }
    const depth = prefabDepth(entities.filter(isPlainObject));
    if (depth > MAX_PREFAB_DEPTH) {
      errors.push(limitsError(`${path}/entities`, 'prefab_depth', depth, MAX_PREFAB_DEPTH, `definition depth exceeds ${MAX_PREFAB_DEPTH}`));
    }
    if (d['depth'] !== undefined && d['depth'] !== depth) {
      errors.push(fieldValue(`${path}/depth`, d['depth'], `the derived depth (${depth})`, 'depth is derived and must equal the definition hierarchy depth'));
    } else if (d['depth'] === undefined) {
      errors.push(fieldMissing(`${path}/depth`, 'depth'));
    }
  }
  for (const k of Object.keys(d)) {
    if (!KNOWN_PREFAB_DEF_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_PREFAB_DEF_FIELDS].join(', ')));
  }
}

/**
 * Phase 14.1: validate a list of prefab definitions on their own (the runtime
 * snapshot's `prefabs`, the manifest's): each definition by the content rules
 * (`version` 4 allows `PREFAB_V4_COMPONENTS`), ids unique, at most `MAX_PREFABS`.
 */
export function validatePrefabDefinitions(value: unknown, path: string, errors: ModelErrorV2[], version: 3 | 4 = 4): void {
  if (!Array.isArray(value)) {
    errors.push(fieldType(path, value, 'array'));
    return;
  }
  if (value.length > MAX_PREFABS) errors.push(limitsError(path, 'prefabs', value.length, MAX_PREFABS, `at most ${MAX_PREFABS} prefab definitions`));
  const seen = new Set<string>();
  value.forEach((d, i) => {
    validatePrefabDefinition(d, `${path}/${i}`, errors, version);
    const id = isPlainObject(d) ? d['prefabId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) errors.push(withFound({ code: 'id_duplicate', path: `${path}/${i}/prefabId`, message: 'prefabId is already used (first occurrence wins)', expected: 'a unique prefabId' }, id));
      seen.add(id);
    }
  });
}

/** Phase 14.1: the canonical form of a prefab definition list (sorted by id). */
export function canonicalPrefabs(defs: readonly PrefabDefinition[]): PrefabDefinition[] {
  return sortedRecord([...defs], (d) => d.prefabId).map(canonicalPrefab);
}

function canonicalPrefabEntity(e: PrefabEntity): PrefabEntity {
  const components: PrefabEntity['components'] = { transform: canonicalTransform(e.components.transform) };
  if (e.components.model !== undefined) {
    const piece = e.components.model.piece;
    components.model = { asset: { assetId: e.components.model.asset.assetId }, ...(piece !== undefined ? { piece } : {}) };
  }
  if (e.components.box !== undefined) components.box = canonicalBox(e.components.box);
  if (e.components.behavior !== undefined) {
    const values: Record<string, PropertyValue> = {};
    for (const k of Object.keys(e.components.behavior.values)) {
      const v = e.components.behavior.values[k] ?? null;
      values[k] = Array.isArray(v) ? [v[0], v[1], v[2]] : v;
    }
    components.behavior = { behaviorId: e.components.behavior.behaviorId, values };
  }
  // Phase 14.1 (v4): the gameplay components, canonical as on a scene entity.
  const x = e.components;
  if (x.collider !== undefined) components.collider = { shape: canonicalCollider(x.collider), ...(x.collider.oneWay === true ? { oneWay: true as const } : {}), ...(Array.isArray(x.collider.layers) ? { layers: [...x.collider.layers] } : {}) };
  if (x.surface !== undefined) components.surface = canonicalSurface(x.surface);
  if (x.materials !== undefined) components.materials = canonicalMaterialMapping(x.materials);
  if (x.animator !== undefined) components.animator = canonicalAnimatorComponent(x.animator);
  for (const name of PREFAB_BLOCKS) {
    if (x[name] !== undefined) (components as unknown as Record<string, unknown>)[name] = (BLOCK_COMPONENTS[name].canonical as (c: unknown) => unknown)(x[name]);
  }
  if (x.materialParams !== undefined) components.materialParams = canonicalMaterialParams(x.materialParams);
  if (x.effect !== undefined) components.effect = canonicalEffectComponent(x.effect);
  if (x.blockFootprint !== undefined) components.blockFootprint = canonicalBlockFootprint(x.blockFootprint);
  if (x.behaviorGroup !== undefined) components.behaviorGroup = canonicalBehaviorGroup(x.behaviorGroup);
  return {
    localId: e.localId,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.parentLocalId !== undefined ? { parentLocalId: e.parentLocalId } : {}),
    components,
  };
}

export function canonicalPrefab(d: PrefabDefinition): PrefabDefinition {
  return {
    prefabId: d.prefabId,
    displayName: d.displayName,
    createdRevision: d.createdRevision,
    entityCount: d.entityCount,
    depth: d.depth,
    entities: d.entities.map(canonicalPrefabEntity),
  };
}