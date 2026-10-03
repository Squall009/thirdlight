/**
 * The component and content descriptor registry.
 *
 * One table, pure data, that says for every entity component and every
 * content block what its fields are: type, unit, range and step, default,
 * group, label, tooltip, when a field applies, and which Scene-view handle
 * edits it. The generic Inspector builds its sections from it, the
 * handle system finds its handles in it, MCP and the editor read it
 * over `queryGameConfig` (the editor may import project-model types only).
 *
 * The validators stay the rules; this table describes them. A unit test
 * (`descriptors.test.ts`) probes every validator with each descriptor's
 * values — min/max accepted, just outside refused, every enum value, every
 * required field — and checks that no field a validator knows lacks a
 * descriptor.
 *
 * Shape conventions:
 * - Every component and content block is one root `FieldDescriptor` (`value`),
 *   usually an `object` whose `fields` are the stored keys.
 * - `when` makes a field apply only for some values of a sibling (`key`) or,
 *   with `../key`, of a field of the enclosing object; conditions compare the
 *   sibling's effective value (its `default` when it is absent). A list of
 *   conditions must all hold. Outside its condition a field is not shown and
 *   the engine ignores it (the validator may refuse it).
 * - The same key may appear more than once in one `fields` list with
 *   conditions that never hold together (a light's `intensity` is in candela
 *   for point and spot lights, a plain factor otherwise).
 * - `default` is the value the engine uses when an optional field is absent
 *   (or, for a required field, a neutral starting value). `omitDefault`
 *   fields are stored only when they differ from their default.
 * - `readOnly` fields are written by a tool (the importer, a bake, the
 *   behavior compiler, a prefab capture), shown but not edited field by field.
 * - Handles are listed per component with the fields they edit, by role
 *   (see `HANDLE_ROLES`); the edited field also names its handle kind.
 *
 * Pure: no I/O, no three.js, no UI code.
 */

import { UI_DESCRIPTORS } from './ui-descriptors';
import { blockFootprint, blockLayer } from './block-descriptors';
import { COMPONENT_ICONS, type ComponentDescriptor, type DescriptorRegistry, type FieldDescriptor, HANDLE_KINDS, HANDLE_ROLES, type ObjectFieldDescriptor } from './descriptor-types';
import { animator, audioSource, behavior, behaviorGroupC, box, cameraPath, cameraRegion, climbVolume, collectible, collider, controller, effectComponent, ENTITY, faceMovement, fogVolume, folder, gravityC, health, hitbox, instances, light, materialParams, materials, model, modelAnimation, mover, patrol, playerSpawn, prefab, socketAttach, surface, switchC, transform, trigger, virtualCamera } from './descriptor-components';
import { CONTENT, SCENE_ENVIRONMENT } from './descriptor-content';
export { HANDLE_KINDS, HANDLE_ROLES, ASSET_KINDS, COMPONENT_ICONS } from './descriptor-types';
export type { DescriptorJson, DescriptorScalar, DescriptorUnit, HandleKind, DescriptorAssetKind, DescriptorRefTarget, DescriptorStringFormat, FieldCondition, NumberFieldDescriptor, IntFieldDescriptor, BoolFieldDescriptor, EnumOption, EnumFieldDescriptor, VecFieldDescriptor, QuatFieldDescriptor, ColorFieldDescriptor, AssetRefFieldDescriptor, EntityRefFieldDescriptor, SceneRefFieldDescriptor, RefFieldDescriptor, SignalFieldDescriptor, StringFieldDescriptor, ObjectFieldDescriptor, ListFieldDescriptor, MapFieldDescriptor, ComponentsFieldDescriptor, JsonFieldDescriptor, FieldDescriptor, FieldType, HandleDescriptor, ComponentAdd, ComponentIcon, CreateEntryDescriptor, ComponentRelation, ComponentDescriptor, ContentBlockDescriptor, DescriptorRegistry } from './descriptor-types';

// ---- the registry -------------------------------------------------------------------

const COMPONENTS: readonly ComponentDescriptor[] = [
  transform,
  model,
  box,
  materials,
  materialParams,
  effectComponent,
  surface,
  instances,
  fogVolume,
  collider,
  controller,
  virtualCamera,
  cameraPath,
  cameraRegion,
  socketAttach,
  light,
  playerSpawn,
  mover,
  trigger,
  switchC,
  health,
  collectible,
  patrol,
  hitbox,
  climbVolume,
  gravityC,
  audioSource,
  animator,
  faceMovement,
  modelAnimation,
  behavior,
  prefab,
  folder,
  blockLayer,
  blockFootprint,
  behaviorGroupC,
];

// ---- What scripts read and write (ctx.entity) --------------------------

/**
 * Components scripts never read: a folder is not in the game, an instance
 * set's copies and a block layer's cells are bulk data (the block layers are
 * read through `ctx.grid`).
 */
const SCRIPT_UNREADABLE: ReadonlySet<string> = new Set(['folder', 'instances', 'blockLayer']);
/** The object's own fields scripts read (`locked` is editor-only; `components` is the rest of the table). */
const SCRIPT_OBJECT_READ: ReadonlySet<string> = new Set(['id', 'name', 'parentId', 'active', 'visible', 'static', 'keepLoaded', 'tags']);
/**
 * The fields scripts may write while the game runs, each with its runtime
 * behavior (runtime `entity-access.ts`). `*`: the component's value itself (a
 * map). Everything the engine builds once — static batching, baked lighting,
 * static colliders, instancing, model and texture assets — stays fixed (a
 * swapped material is loaded by the renderer before it shows).
 */
const SCRIPT_WRITABLE: Readonly<Record<string, readonly string[]>> = {
  entity: ['active', 'visible', 'keepLoaded'],
  transform: ['position', 'rotation', 'scale'],
  light: ['color', 'intensity', 'range'],
  mover: ['speed', 'active'],
  // Which project material a slot wears: swapped once the material has loaded (the renderer waits for it).
  materials: ['*'],
  materialParams: ['*'],
};

function markField(f: FieldDescriptor, read: boolean, write: boolean): FieldDescriptor {
  if (!read && !write) return f;
  return { ...f, ...(read ? { scriptReadable: true as const } : {}), ...(write ? { runtimeWritable: true as const } : {}) };
}

/** A component with its script marks (every top-level field readable, the listed ones writable). */
function withScriptAccess(c: ComponentDescriptor): ComponentDescriptor {
  if (SCRIPT_UNREADABLE.has(c.name)) return c;
  const writable = SCRIPT_WRITABLE[c.name] ?? [];
  const root = c.value;
  if (root.type !== 'object') return { ...c, value: markField(root, true, writable.includes('*')) };
  return { ...c, value: { ...root, fields: root.fields.map((f) => markField(f, true, writable.includes(f.key))) } };
}

function withObjectScriptAccess(e: ObjectFieldDescriptor): ObjectFieldDescriptor {
  const writable = SCRIPT_WRITABLE['entity'] ?? [];
  return { ...e, fields: e.fields.map((f) => markField(f, SCRIPT_OBJECT_READ.has(f.key), writable.includes(f.key))) };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/**
 * The registry (deep-frozen). Plain JSON: `JSON.parse(JSON.stringify(DESCRIPTORS))`
 * equals it, which is how it travels to the editor (`queryGameConfig.descriptors`).
 */
export const DESCRIPTORS: DescriptorRegistry = deepFreeze({
  version: 1,
  handleKinds: [...HANDLE_KINDS],
  handleRoles: HANDLE_ROLES,
  entity: withObjectScriptAccess({ ...ENTITY, fields: ENTITY.fields.map((f) => (f.key === 'components' ? { ...f, allowed: COMPONENTS.map((c) => c.name) } : f)) }),
  components: COMPONENTS.map(withScriptAccess),
  icons: [...COMPONENT_ICONS],
  content: CONTENT,
  ui: UI_DESCRIPTORS,
  sceneEnvironment: SCENE_ENVIRONMENT,
});
