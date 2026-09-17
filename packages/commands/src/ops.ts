/**
 * Pure forward-op application — commands.md §8.1/§8.2/§8.3.
 *
 * Each op takes the validated request args plus the current (valid,
 * canonical) scene and either returns the applied result (new scene,
 * change data, inverse spec) or a structured error. Application happens on
 * an in-memory copy (pipeline step 5, commands.md §6.1): the input scene
 * is never mutated, and the RESULTING scene is re-validated by the
 * project-model; any failure means no state change, no revision change.
 */

import {
  serializeCanonical,
  validateScene,
  type Entity,
  type Scene,
  type TransformComponent,
} from '@thirdlight/project-model';

import {
  cameraCountInvalid,
  entityNotFound,
  idExhaustion,
  limitsExceeded,
  noChange,
  referenceMissing,
  resultSceneError,
  type CommandError,
} from './errors';
import type {
  ChangedField,
  ChangeData,
  CreateEntityArgs,
  CreateEntityChange,
  DeleteEntityArgs,
  DeleteEntityChange,
  SetTransformArgs,
  SetTransformChange,
  ForwardChange,
  InverseSpec,
} from './types';

/** M1 limits (project-model §10.4, restated in commands.md §5.4/§8.1). */
const MAX_ENTITIES = 1024;
const MAX_DEPTH = 32; // root = 1
const ID_MAX = 9999;

/**
 * JSON-safe deep clone. Entity/transform graphs are plain JSON values by
 * construction (canonical documents, validated args), so the round-trip is
 * total; it also normalizes `-0` to `0`, matching canonical semantics.
 */
export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Plain byte equality (no Buffer dependency). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function entitiesById(scene: Scene): Map<string, Entity> {
  return new Map(scene.entities.map((e) => [e.id, e]));
}

/** Entity depth (root = 1). Valid scenes are acyclic with parents first. */
function entityDepth(scene: Scene, id: string): number {
  const byId = entitiesById(scene);
  let depth = 0;
  let cur = byId.get(id);
  while (cur !== undefined) {
    depth += 1;
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

/**
 * Full descendant closure of `rootId` (project-model §11.3: M1 deletion is
 * always subtree deletion). Returns null when the root does not exist.
 */
export function subtreeClosure(scene: Scene, rootId: string): string[] | null {
  const byId = entitiesById(scene);
  if (!byId.has(rootId)) return null;
  const children = new Map<string, string[]>();
  for (const e of scene.entities) {
    if (e.parentId !== undefined) {
      const list = children.get(e.parentId) ?? [];
      list.push(e.id);
      children.set(e.parentId, list);
    }
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    out.push(id);
    const kids = children.get(id);
    if (kids !== undefined) for (const k of kids) stack.push(k);
  }
  return out;
}

/** Closure members in pre-deletion array order (ascending index). */
function closureInArrayOrder(scene: Scene, closure: string[]): string[] {
  const index = new Map(scene.entities.map((e, i) => [e.id, i]));
  return [...closure].sort((a, b) => {
    const ia = index.get(a) ?? 0;
    const ib = index.get(b) ?? 0;
    return ia - ib;
  });
}

/** The scene's (exactly one) camera entity ID, or null. */
function cameraIdOf(scene: Scene): string | null {
  for (const e of scene.entities) {
    if (e.components.camera !== undefined) return e.id;
  }
  return null;
}

/**
 * `no_change` check (commands.md §6.5): canonical-serialize both scenes
 * with `revision` masked to `0` and byte-compare. Only `setTransform` can
 * reach this (create/delete change structure; undo/redo always restore a
 * different state), but the pipeline runs the check uniformly.
 */
export function isNoChange(current: Scene, result: Scene): boolean {
  const a = serializeCanonical({ ...current, revision: 0 });
  const b = serializeCanonical({ ...result, revision: 0 });
  if (!a.ok || !b.ok) return false; // unreachable: both documents are valid
  return bytesEqual(a.bytes, b.bytes);
}

/**
 * §8.1 step 2: backend-assigned ID — the smallest NNNN in 0001..9999 such
 * that `<kind>-NNNN` does not exist in the current scene. Undefined on
 * exhaustion (⇒ `id_exhaustion`).
 */
export function nextEntityId(scene: Scene, kind: 'box' | 'group'): string | undefined {
  const existing = new Set(scene.entities.map((e) => e.id));
  for (let n = 1; n <= ID_MAX; n++) {
    const id = `${kind}-${String(n).padStart(4, '0')}`;
    if (!existing.has(id)) return id;
  }
  return undefined;
}

// ---- internal result shapes ------------------------------------------------------

export interface OpSuccess {
  scene: Scene; // the applied, re-validated (canonical) result scene
  change: ForwardChange;
  inverse: InverseSpec;
  createdId?: string;
}

export type OpOutcome =
  | { ok: true; op: OpSuccess }
  | { ok: false; error: CommandError };

/**
 * Pipeline steps 5–6 on the applied result: re-validate the resulting
 * scene with the project-model (any failure ⇒ structured error, no state
 * change), then run the uniform no-change check (§6.5). `result` is the
 * CANDIDATE document (typed `unknown`: its value rules — vector lengths,
 * finiteness, ranges, quaternion norm — are exactly what this validation
 * checks); on success the canonical (normalized) scene is returned.
 */
export function gateResultScene(
  current: Scene,
  result: unknown,
): { ok: true; normalized: Scene } | { ok: false; error: CommandError } {
  const v = validateScene(result);
  if (!v.ok) return { ok: false, error: resultSceneError(v.errors) };
  if (isNoChange(current, v.normalized)) return { ok: false, error: noChange() };
  return { ok: true, normalized: v.normalized };
}

// ---- createEntity (§8.1) ----------------------------------------------------------

export function applyCreateEntity(scene: Scene, args: CreateEntityArgs): OpOutcome {
  const byId = entitiesById(scene);
  const parentId = args.parentId ?? null;

  // §8.1 precondition order: parentId resolves, then limits, then ID scan.
  if (parentId !== null && !byId.has(parentId)) {
    return { ok: false, error: referenceMissing(parentId) };
  }
  if (scene.entities.length + 1 > MAX_ENTITIES) {
    return {
      ok: false,
      error: limitsExceeded('entities', scene.entities.length + 1, MAX_ENTITIES),
    };
  }
  const newDepth = parentId === null ? 1 : entityDepth(scene, parentId) + 1;
  if (newDepth > MAX_DEPTH) {
    return { ok: false, error: limitsExceeded('depth', newDepth, MAX_DEPTH) };
  }
  const id = nextEntityId(scene, args.kind);
  if (id === undefined) return { ok: false, error: idExhaustion(args.kind) };

  // §8.3: defaults per field; a provided field replaces that field only.
  // The candidate entity is a plain object: vector values are checked by
  // the result-scene validation below (the model is the value authority).
  const transform = {
    position: [...(args.transform?.position ?? [0, 0, 0])],
    rotation: [...(args.transform?.rotation ?? [0, 0, 0, 1])],
    scale: [...(args.transform?.scale ?? [1, 1, 1])],
  };
  const candidateEntity = {
    id,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(parentId !== null ? { parentId } : {}),
    components: {
      transform,
      ...(args.kind === 'box'
        ? {
            box: {
              size: [...(args.box?.size ?? [1, 1, 1])],
              material: { color: args.box?.material?.color ?? '#b0b0b0' },
            },
          }
        : {}),
    },
  };

  // §8.1 step 4: append at the END (leaf ⇒ parent-before-child preserved).
  const result = {
    ...scene,
    revision: scene.revision + 1,
    entities: [...scene.entities, candidateEntity],
  };
  const gate = gateResultScene(scene, result);
  if (!gate.ok) return gate;

  // Canonical entity value (defaults filled, -0 normalized) from the
  // validated result document.
  const canonicalEntity = gate.normalized.entities.find((e) => e.id === id) as Entity;
  const change: CreateEntityChange = { type: 'createEntity', id, entity: deepClone(canonicalEntity) };
  return {
    ok: true,
    op: {
      scene: gate.normalized,
      change,
      inverse: { kind: 'delete', rootId: id },
      createdId: id,
    },
  };
}

// ---- setTransform (§8.2) ------------------------------------------------------------

const FIELD_ORDER: readonly ChangedField[] = ['position', 'rotation', 'scale'];

export function applySetTransform(scene: Scene, args: SetTransformArgs): OpOutcome {
  const byId = entitiesById(scene);
  const index = scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const current = scene.entities[index] as Entity;

  // §8.2: a provided field REPLACES the whole field (no component-wise
  // merge); absent fields are unchanged. `previous` is the entity's
  // canonical transform; `next` is the candidate (values checked by the
  // result-scene validation below).
  const previous = deepClone(current.components.transform);
  const next = {
    position: [...previous.position],
    rotation: [...previous.rotation],
    scale: [...previous.scale],
  };
  const changedFields: ChangedField[] = [];
  for (const f of FIELD_ORDER) {
    const v = args.transform[f];
    if (v !== undefined) {
      if (f === 'position') next.position = [...v];
      else if (f === 'rotation') next.rotation = [...v];
      else next.scale = [...v];
      changedFields.push(f);
    }
  }

  const newEntity = {
    ...deepClone(current),
    components: { ...deepClone(current.components), transform: next },
  };
  const nextEntities: unknown[] = [...scene.entities];
  nextEntities[index] = newEntity;
  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  const gate = gateResultScene(scene, result);
  if (!gate.ok) return gate;

  const canonicalNext = deepClone(
    (gate.normalized.entities[index] as Entity).components.transform,
  );
  const change: SetTransformChange = {
    type: 'setTransform',
    id: args.entityId,
    previous: deepClone(previous),
    next: canonicalNext,
    changedFields,
  };
  return {
    ok: true,
    op: {
      scene: gate.normalized,
      change,
      // §9.1: restore the FULL previous transform (all three fields).
      inverse: { kind: 'setTransform', id: args.entityId, restore: deepClone(previous) },
    },
  };
}

// ---- deleteEntity (§8.3) -------------------------------------------------------------

export function applyDeleteEntity(scene: Scene, args: DeleteEntityArgs): OpOutcome {
  const byId = entitiesById(scene);
  const root = byId.get(args.entityId);
  if (root === undefined) return { ok: false, error: entityNotFound(args.entityId) };

  const closure = subtreeClosure(scene, args.entityId);
  if (closure === null) {
    return { ok: false, error: entityNotFound(args.entityId) };
  }
  // §8.3 step 2: the closure may not contain the scene's only camera.
  const camId = cameraIdOf(scene);
  if (camId !== null && closure.includes(camId)) {
    return { ok: false, error: cameraCountInvalid(camId) };
  }

  const deletedIds = closureInArrayOrder(scene, closure);
  const indexOf = new Map(scene.entities.map((e, i) => [e.id, i]));
  // §9.1 inverse: entries in pre-deletion array order with indices.
  const entries = deletedIds.map((id) => ({
    index: indexOf.get(id) as number,
    entity: deepClone(byId.get(id) as Entity),
  }));

  const closureSet = new Set(closure);
  const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  const gate = gateResultScene(scene, result);
  if (!gate.ok) return gate;

  const change: DeleteEntityChange = {
    type: 'deleteEntity',
    rootId: args.entityId,
    deletedIds: [...deletedIds],
  };
  return {
    ok: true,
    op: {
      scene: gate.normalized,
      change,
      inverse: {
        kind: 'restoreSubtree',
        entries: entries.map((e) => ({ index: e.index, entity: deepClone(e.entity) })),
        restoredParentId: root.parentId ?? null,
      },
    },
  };
}