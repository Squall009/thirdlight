/**
 * Flags meshes carry for the material library (a module of its own: the
 * library, the instance sets and the impostors read it without importing
 * each other).
 */

/** `mesh.userData[KEEP_MATERIAL_KEY] = true`: the mesh's material is its own (an impostor's quad), never a project material a mapping gives. */
export const KEEP_MATERIAL_KEY = 'tlKeepMaterial';

/**
 * `mesh.userData[MATERIAL_NO_SHADOW_KEY]`: the mesh casts no shadow because of its material (a graph whose
 * output casts none, a decal); the value is the object's own flag, kept to restore (the shadow flags respect it).
 */
export const MATERIAL_NO_SHADOW_KEY = '__tlMaterialNoShadow';
