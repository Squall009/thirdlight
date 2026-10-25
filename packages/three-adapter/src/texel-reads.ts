/**
 * Data textures read without three's WebGL 2 flip.
 *
 * On WebGL 2 three gives every texture read a flip-Y uniform (and, for a texel
 * load, the texture's size in the shader to flip with), set again for each
 * draw from the texture: true only for an `ImageBitmap` uploaded flipped, a
 * render target or a depth texture. A data texture (the engine's terrain
 * pages, cover and copy lists, wind map) is none of those, so its flip is
 * always false; yet its reads still made each draw update every one of those
 * uniforms (about 0.2 ms of the main thread a frame for a grass meadow's dozen
 * cover draws, each reading nine texels) and every vertex select and size it.
 * A data texture's read is built as on WebGPU instead: the coordinates as
 * given. A three upgrade checks `TextureNode.setupUV` still only flips
 * (docs/three-upgrade-checklist.md).
 */
import type * as THREE from 'three';
import { TextureNode } from 'three/webgpu';

let installed = false;

/** Whether a texture can never be read flipped (three's flip is false for it on every backend). */
export function neverFlipped(t: THREE.Texture | null | undefined): boolean {
  if (t === null || t === undefined) return false;
  const k = t as THREE.Texture & { isDataTexture?: boolean; isDataArrayTexture?: boolean; isRenderTargetTexture?: boolean; isFramebufferTexture?: boolean; isDepthTexture?: boolean };
  return (k.isDataTexture === true || k.isDataArrayTexture === true) && k.isRenderTargetTexture !== true && k.isFramebufferTexture !== true && k.isDepthTexture !== true;
}

/** Build data textures' reads without the flip (idempotent; before the first build). */
export function installTexelReads(): void {
  if (installed) return;
  installed = true;
  const proto = TextureNode.prototype as unknown as { setupUV(builder: unknown, uvNode: unknown): unknown; value: THREE.Texture | null };
  const base = proto.setupUV;
  proto.setupUV = function setupUVUnflipped(this: { value: THREE.Texture | null }, builder: unknown, uvNode: unknown): unknown {
    if (neverFlipped(this.value)) return uvNode;
    return base.call(this, builder, uvNode);
  };
}
