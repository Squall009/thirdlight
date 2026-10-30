import { TRIM_DATA_GLTF_ATTRIBUTE } from '@thirdlight/project-model';

/**
 * The vertex attribute trim data is kept in (the trim sheet's convention: R
 * occlusion, A wetness): generated architecture's, and a model file's
 * `TRIM_DATA_GLTF_ATTRIBUTE` under the name three's loader gives it, so
 * both are read the one way. Never COLOR_0, which always means layer
 * weights and wetness. A module of its own: the loader side (pieces.ts)
 * and the material compiler both name it without importing each other.
 */
export const TRIM_DATA_ATTRIBUTE = TRIM_DATA_GLTF_ATTRIBUTE.toLowerCase();
