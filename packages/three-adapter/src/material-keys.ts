/**
 * Flags meshes carry for the material library (a module of its own: the
 * library, the instance sets and the impostors read it without importing
 * each other).
 */

/** `mesh.userData[KEEP_MATERIAL_KEY] = true`: the mesh's material is its own (an impostor's quad), never a project material a mapping gives. */
export const KEEP_MATERIAL_KEY = 'tlKeepMaterial';
