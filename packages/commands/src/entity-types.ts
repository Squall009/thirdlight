/**
 * The entity header and the create/update request shapes of the entity
 * commands (`createEntity`, `updateEntity`), re-exported by `types.ts`.
 */

import type { SurfacePresetName } from './types';

/**
 * An entity's hierarchy identity: its name, its parent (null = root) and its
 * own flags (the stored defaults are active, visible, unlocked, not static).
 * Records written before a flag existed lack it; readers default it
 * (`fullHeader`).
 */
export interface EntityHeader {
  name: string | null;
  parentId: string | null;
  active: boolean;
  /** Drawn when the game starts (false: it starts hidden until a script or a timeline shows it). */
  visible: boolean;
  locked: boolean;
  static: boolean;
  /** Survives scene changes (absent in an older record: false). */
  keepLoaded?: boolean;
  /** The entity's own tag mask (0 = none). */
  tags: number;
}

/** The `updateEntity` fields a change can name. */
export type EntityHeaderField = 'name' | 'parentId' | 'active' | 'visible' | 'locked' | 'static' | 'keepLoaded' | 'tags';

/**
 * Partial transform args: any non-empty subset; a present field replaces the
 * whole field (arrays are never merged component-wise). Element values
 * (length, finiteness, ranges, quaternion norm) are re-checked by the
 * project-model validation of the resulting scene.
 */
export interface PartialTransformArgs {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

/** Box args for createEntity: only when `kind` is `"box"`. */
export interface BoxArgs {
  size?: readonly number[];
  material?: { color?: string };
}

/** Model args for createEntity: only when `kind` is `"model"`. */
export interface ModelArgs {
  asset: { assetId: string };
  /** One named piece of a multi-piece GLB (absent = the whole file). */
  piece?: string;
}

export interface CreateEntityArgs {
  /** `folder`: organisation only — no transform, box, model or components. */
  kind: 'group' | 'box' | 'model' | 'folder';
  parentId?: string | null;
  name?: string;
  /** The entity flags and tags, as `updateEntity` sets them (absent: active, visible, unlocked, not static, not kept loaded, no tags). */
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  keepLoaded?: boolean;
  /** Tag names of the project's registry. */
  tags?: string[];
  transform?: PartialTransformArgs;
  /** Only when `kind` is `"box"`. */
  box?: BoxArgs;
  /** Only when `kind` is `"model"` (required then). */
  model?: ModelArgs;
  /**
   * The add-capable components created in the same transaction:
   * `collider`, `controller`, `playerSpawn`, `light`, `surface`,
   * `modelAnimation`; never `null`.
   */
  components?: Record<string, unknown>;
  /** Copies a built-in preset row onto `components.surface`. */
  surfacePreset?: SurfacePresetName;
  /**
   * `folder` only: objects created inside the new folder in the same
   * transaction (one undo), e.g. every piece of a multi-piece model. Each is
   * a `box`/`model`/`group` create without `parentId` or `children`.
   */
  children?: CreateEntityArgs[];
}

/** `updateEntity` args: at least one field besides `entityId` (`parentId` null = make root). */
export interface UpdateEntityArgs {
  entityId: string;
  name?: string;
  parentId?: string | null;
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  /** The object (with its children and scripts) survives scene loads, unloads and reloads. */
  keepLoaded?: boolean;
  /** The entity's own tags, by name (replaces the whole set; [] clears). */
  tags?: string[];
}
