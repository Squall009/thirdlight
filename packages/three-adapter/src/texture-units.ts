/**
 * The texture-unit budget of a lit program's fragment stage.
 *
 * WebGPU guarantees 16 sampled textures a shader stage, and the low tier's
 * GPUs (the Iris Xe) allow no more: a program past it fails validation and
 * never draws. WebGL 2 allows 16 at least too (32 on those GPUs). Every lit
 * program kind keeps within it under the worst-case settings, with the
 * light path's units free (a test counts them).
 */

/** Textures a lit program's fragment stage may bind. */
export const LIT_TEXTURE_UNITS = 16;

/**
 * Units the local-light path takes in every lit program: the light
 * clusters' texture, the shadow atlas, and the light tables (the area
 * lights' LTC tables, `cluster-area.ts`, with the spot lights' cookies in
 * the same texture).
 */
export const LIGHT_PATH_TEXTURE_UNITS = 3;
