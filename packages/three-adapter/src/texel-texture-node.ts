/**
 * Texture nodes for data read as stored: no texture transform, and (the
 * texel kind) no flip.
 *
 * - three r186 gives a texture node made without a UV a matrix update (as
 *   `sample` and `load` clone it, through `this.constructor`): a uniform, a
 *   `mat3 × vec3` in the shader and a `texture.updateMatrix()` on the CPU for
 *   every read, every draw. A lookup that reads a table a dozen times a pixel
 *   paid that for each read. These nodes never turn it on.
 * - three's WebGL 2 builder gives every texture read a flip-Y switch (render
 *   targets are stored upside down there): a uniform updated for every draw
 *   and a `textureSize` and a select in the shader for every read. A data
 *   texture is never flipped, so a texel node reads without it.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

const TSL: N = TSLTyped;

/** A texture node without three's texture transform (its clones neither). */
export class UntransformedTextureNode extends (THREE.TextureNode as unknown as new (value: THREE.Texture) => object) {
  setUpdateMatrix(): this {
    (this as unknown as { updateMatrix: boolean }).updateMatrix = false;
    return this;
  }
}

/** A data texture read texel by texel, as uploaded: no transform and no flip. */
export class TexelTextureNode extends UntransformedTextureNode {
  setupUV(_builder: unknown, uvNode: N): N {
    return uvNode;
  }
}

/** `t` as a node read as stored, sampled (`sample`) or loaded (`load`). */
export const untransformedTexture = (t: THREE.Texture): N => TSL.nodeObject(new UntransformedTextureNode(t));
/** `t` as a node of texels read as uploaded (`load`). */
export const texelTexture = (t: THREE.Texture): N => TSL.nodeObject(new TexelTextureNode(t));
