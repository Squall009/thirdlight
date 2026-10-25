/**
 * Prefab definitions of the content catalog: entities, depth, the components a
 * prefab may carry, and their canonical form.
 */

import { canonicalEffectComponent } from './effects';
import { canonicalDecal } from './decals';
import { canonicalBlockFootprint } from './block-layers';
import { canonicalBehaviorGroup } from './modes';
import { canonicalMaterialMapping, canonicalMaterialParams } from './materials';
import { canonicalAnimatorComponent } from './animator';
import { BLOCK_COMPONENTS } from './blocks';
import { canonicalComponentsV3, canonicalSurface, V4_REGISTRY, validateEntityComponentsV3 } from './scene-v3';
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
  ID_RE_V2,
  validateBehaviorComponent,
  validateModelComponent,
} from './components';
import { MAX_PREFAB_DEPTH, MAX_PREFAB_ENTITIES } from './content-limits';
import { limitsError, sortedRecord } from './content-helpers';
import { planeLockOf, type PlaneLock } from './plane-lock';
import { colliderDepthField } from './shape-2d-3d';
import { isPrefabLink, PART_PATH_SEPARATOR, validatePrefabLink, type PrefabLinkComponent } from './prefab-links';

const KNOWN_PREFAB_DEF_FIELDS = new Set(['prefabId', 'displayName', 'createdRevision', 'updatedRevision', 'nextLocalNumber', 'entityCount', 'depth', 'entities']);
const KNOWN_PREFAB_ENTITY_FIELDS = new Set(['localId', 'name', 'parentLocalId', 'tags', 'components']);

// ---- prefabs ----------------------------------------------------

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
    // A parent inside a nested copy (`L/localId`) counts from the nested copy; its own depth is the nested prefab's.
    const d = typeof parent === 'string' ? depthOf(parent.split(PART_PATH_SEPARATOR)[0] as string, seen) + 1 : 1;
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
 * A prefab part carries what a scene object can, with the scene's own rules
 * (one camera live per view and a player character per controller are the
 * running game's, not the prefab's). Left out: what the scene itself holds
 * (a block layer's cells; the blobs of an instance set, a terrain and vertex
 * paint, which are kept and collected with the scene) and a folder (it has no
 * place in the game).
 */
export const PREFAB_EXCLUDED_COMPONENTS: readonly string[] = ['blockLayer', 'instances', 'terrain', 'vertexPaint', 'folder'];
/** The components a v4 prefab part may carry besides transform, model, box and behavior. */
export const PREFAB_V4_COMPONENTS: readonly string[] = V4_REGISTRY.filter((c) => !['transform', 'model', 'box', 'behavior', 'prefab'].includes(c) && !PREFAB_EXCLUDED_COMPONENTS.includes(c));
const PREFAB_BLOCKS = ['mover', 'trigger', 'switch', 'audioSource', 'faceMovement', 'health', 'collectible', 'patrol', 'hitbox', 'climbVolume', 'gravity'] as const;

/** A v4 prefab part's components: the scene object's rules, less what a prefab cannot hold. */
function validatePrefabPartComponents(comps: Record<string, unknown>, parentLocalId: unknown, path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(comps)) {
    if (k !== 'prefab' && !PREFAB_EXCLUDED_COMPONENTS.includes(k)) continue;
    const why = k === 'prefab' ? 'a part names its prefab through a nested copy' : k === 'folder' ? 'a folder only organises a scene' : 'its data is held by the scene';
    errors.push(withFound({ code: 'prefab_component_forbidden', path: `${path}/components/${pointerSegment(k)}`, message: `a prefab part must not carry ${k}: ${why}`, expected: `a scene object's components except prefab, ${PREFAB_EXCLUDED_COMPONENTS.join(', ')}` }, k));
  }
  const own = Object.fromEntries(Object.entries(comps).filter(([k]) => k !== 'prefab' && !PREFAB_EXCLUDED_COMPONENTS.includes(k)));
  validateEntityComponentsV3(own, typeof parentLocalId === 'string' ? parentLocalId : undefined, path, errors as never, 4);
}

function validatePrefabEntity(e: unknown, idx: number, path: string, errors: ModelErrorV2[], localIndex: Map<string, number>, nestedCopies: Set<string>, version: 3 | 4 = 3): void {
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
      // A part inside a nested copy is named by its path (`L/localId`); its first local id is the nested copy here.
      const head = parent.split(PART_PATH_SEPARATOR)[0] as string;
      if (head !== parent && !nestedCopies.has(head)) {
        errors.push(withFound({ code: 'prefab_reference_missing', path: `${path}/parentLocalId`, message: 'a parent path starts at an earlier nested copy of this definition', expected: 'an earlier nested copy localId' }, parent));
      }
      const pidx = localIndex.get(head);
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
  const tags = e['tags'];
  if (tags !== undefined && (typeof tags !== 'number' || !Number.isInteger(tags) || tags < 0 || tags > 0xffffffff)) {
    errors.push(fieldValue(`${path}/tags`, tags, 'integer 0 to 4294967295 (a 32-bit tag mask)', 'tags is the unsigned 32-bit mask of the tag bits'));
  }
  const comps = e['components'];
  if (comps === undefined) {
    errors.push(fieldMissing(`${path}/components`, 'components'));
  } else if (!isPlainObject(comps)) {
    errors.push(fieldType(`${path}/components`, comps, 'object'));
  } else if (version === 4 && isPrefabLink(comps['prefab'])) {
    // A nested copy (or a variant's root): its placement and its link to the nested prefab, whose parts it is made of.
    validatePrefabLink(comps['prefab'], `${path}/components/prefab`, errors, 'prefab');
    if (typeof localId === 'string') nestedCopies.add(localId);
    if (comps['transform'] === undefined) errors.push({ code: 'component_missing', path: `${path}/components/transform`, message: 'every prefab entity requires the transform component', expected: 'transform present' });
    const extra = Object.keys(comps).filter((k) => k !== 'transform' && k !== 'prefab');
    if (extra.length > 0) errors.push(withFound({ code: 'component_conflict', path: `${path}/components`, message: 'a nested copy carries only its transform and its prefab link: a change to one of its parts is an override', expected: 'transform and prefab' }, extra));
  } else if (version === 4) {
    validatePrefabPartComponents(comps, parent, path, errors);
  } else {
    const allowed = new Set<string>(['transform', 'model', 'box', 'behavior']);
    const allowedText = 'transform, model, box, behavior';
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
      // box has only size/material; canonicalization reuses `canonicalBox`.
      void canonicalBox;
    }
    if (comps['behavior'] !== undefined) validateBehaviorComponent(comps['behavior'], `${path}/components/behavior`, errors);
  }
  for (const k of Object.keys(e)) {
    if (!KNOWN_PREFAB_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'localId, name, parentLocalId, tags, components'));
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
  const updated = d['updatedRevision'];
  if (updated !== undefined && (typeof updated !== 'number' || !Number.isInteger(updated) || updated < 0 || updated > Number.MAX_SAFE_INTEGER)) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/updatedRevision`, message: 'updatedRevision must be an integer in [0, 2^53-1]', expected: 'integer in [0, 2^53-1]' }, updated));
  }
  const nextLocal = d['nextLocalNumber'];
  if (nextLocal !== undefined && (typeof nextLocal !== 'number' || !Number.isInteger(nextLocal) || nextLocal < 1 || nextLocal > Number.MAX_SAFE_INTEGER)) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/nextLocalNumber`, message: 'nextLocalNumber must be an integer in [1, 2^53-1]', expected: 'integer in [1, 2^53-1]' }, nextLocal));
  }

  const entities = d['entities'];
  if (entities === undefined) errors.push(fieldMissing(`${path}/entities`, 'entities'));
  else if (!Array.isArray(entities)) errors.push(fieldType(`${path}/entities`, entities, 'array'));
  else {
    if (entities.length < 1 || entities.length > MAX_PREFAB_ENTITIES) {
      errors.push(limitsError(`${path}/entities`, 'prefab_entities', entities.length, MAX_PREFAB_ENTITIES, `a definition must have 1-${MAX_PREFAB_ENTITIES} entities`));
    }
    const localIndex = new Map<string, number>();
    const nestedCopies = new Set<string>();
    for (let i = 0; i < entities.length; i++) {
      validatePrefabEntity(entities[i], i, `${path}/entities/${i}`, errors, localIndex, nestedCopies, version);
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
 * Validate a list of prefab definitions on their own (the runtime
 * snapshot's `prefabs`, the manifest's): each definition by the content rules
 * (`version` 4 allows `PREFAB_V4_COMPONENTS`), ids unique.
 */
export function validatePrefabDefinitions(value: unknown, path: string, errors: ModelErrorV2[], version: 3 | 4 = 4): void {
  if (!Array.isArray(value)) {
    errors.push(fieldType(path, value, 'array'));
    return;
  }
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

/** The canonical form of a prefab definition list (sorted by id). */
export function canonicalPrefabs(defs: readonly PrefabDefinition[]): PrefabDefinition[] {
  return sortedRecord([...defs], (d) => d.prefabId).map(canonicalPrefab);
}

function canonicalPrefabLink(link: PrefabLinkComponent): PrefabLinkComponent {
  return { prefabId: link.prefabId, ...(link.overrides !== undefined && link.overrides.length > 0 ? { overrides: link.overrides.map((o) => ({ ...o })) } : {}) };
}

function canonicalPrefabEntity(e: PrefabEntity): PrefabEntity {
  const components: PrefabEntity['components'] = { transform: canonicalTransform(e.components.transform) };
  if (e.components.prefab !== undefined) {
    return {
      localId: e.localId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.parentLocalId !== undefined ? { parentLocalId: e.parentLocalId } : {}),
      ...(e.tags !== undefined && e.tags !== 0 ? { tags: e.tags } : {}),
      components: { ...components, prefab: canonicalPrefabLink(e.components.prefab) },
    };
  }
  // The model keeps every stored field (as on a scene entity, which keeps the
  // validated model whole): a placed copy must look and behave like its source
  // (shadows, light layers, occluder, see-through).
  if (e.components.model !== undefined) components.model = { ...e.components.model, asset: { assetId: e.components.model.asset.assetId } };
  if (e.components.box !== undefined) components.box = canonicalBox(e.components.box);
  if (e.components.behavior !== undefined) {
    const values: Record<string, PropertyValue> = {};
    for (const k of Object.keys(e.components.behavior.values)) {
      const v = e.components.behavior.values[k] ?? null;
      values[k] = Array.isArray(v) ? [v[0], v[1], v[2]] : v;
    }
    components.behavior = { behaviorId: e.components.behavior.behaviorId, values };
  }
  // v4: the gameplay components, canonical as on a scene entity (a free collider writes no plane).
  const x = e.components;
  if (x.collider !== undefined) components.collider = { shape: canonicalCollider(x.collider), ...(x.collider.oneWay === true ? { oneWay: true as const } : {}), ...(Array.isArray(x.collider.layers) ? { layers: [...x.collider.layers] } : {}), ...prefabPlane(x.collider), ...colliderDepthField(x.collider) };
  if (x.surface !== undefined) components.surface = canonicalSurface(x.surface);
  if (x.materials !== undefined) components.materials = canonicalMaterialMapping(x.materials);
  if (x.animator !== undefined) components.animator = canonicalAnimatorComponent(x.animator);
  for (const name of PREFAB_BLOCKS) {
    if (x[name] !== undefined) (components as unknown as Record<string, unknown>)[name] = (BLOCK_COMPONENTS[name].canonical as (c: unknown) => unknown)(x[name]);
  }
  if (x.materialParams !== undefined) components.materialParams = canonicalMaterialParams(x.materialParams);
  if (x.effect !== undefined) components.effect = canonicalEffectComponent(x.effect);
  if (x.decal !== undefined) components.decal = canonicalDecal(x.decal);
  if (x.blockFootprint !== undefined) components.blockFootprint = canonicalBlockFootprint(x.blockFootprint);
  if (x.behaviorGroup !== undefined) components.behaviorGroup = canonicalBehaviorGroup(x.behaviorGroup);
  // Every other component canonical as on a scene object, after these (a prefab keeps its exact bytes).
  const rest = Object.keys(x).filter((k) => !(k in components) && k !== 'prefab');
  if (rest.length > 0) {
    const scene = canonicalComponentsV3(x as unknown as Record<string, unknown>) as unknown as Record<string, unknown>;
    for (const k of Object.keys(scene)) if (rest.includes(k)) (components as unknown as Record<string, unknown>)[k] = scene[k];
  }
  return {
    localId: e.localId,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.parentLocalId !== undefined ? { parentLocalId: e.parentLocalId } : {}),
    ...(e.tags !== undefined && e.tags !== 0 ? { tags: e.tags } : {}),
    components,
  };
}

export function canonicalPrefab(d: PrefabDefinition): PrefabDefinition {
  return {
    prefabId: d.prefabId,
    displayName: d.displayName,
    createdRevision: d.createdRevision,
    ...(d.updatedRevision !== undefined ? { updatedRevision: d.updatedRevision } : {}),
    ...(d.nextLocalNumber !== undefined ? { nextLocalNumber: d.nextLocalNumber } : {}),
    entityCount: d.entityCount,
    depth: d.depth,
    entities: d.entities.map(canonicalPrefabEntity),
  };
}

function prefabPlane(collider: unknown): { plane?: PlaneLock } {
  const plane = planeLockOf(collider);
  return plane !== null ? { plane } : {};
}
