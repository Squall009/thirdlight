/**
 * Change and undo records of the project's named layer lists (collision
 * layers, light layer names): each edit replaces the whole list.
 */

/** `setCollisionLayers` change data (the whole list; empty = only "default"). */
export interface SetCollisionLayersChange {
  type: 'setCollisionLayers';
  previous: string[];
  next: string[];
}

/** `setLightLayers` change data (the whole list of names by layer number; empty = none named). */
export interface SetLightLayersChange {
  type: 'setLightLayers';
  previous: string[];
  next: string[];
}

/** Undo of `setCollisionLayers`: restore the previous list. */
export interface SetCollisionLayersInverse {
  kind: 'setCollisionLayers';
  restore: string[];
}

/** Undo of `setLightLayers`: restore the previous names. */
export interface SetLightLayersInverse {
  kind: 'setLightLayers';
  restore: string[];
}
