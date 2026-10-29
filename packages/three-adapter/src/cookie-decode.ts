/**
 * A spot cookie whose pixels the page cannot read (a GPU-compressed texture:
 * KTX2 transcoded to BC, ETC or ASTC) read back through the GPU, so the
 * cookie atlas draws it like any other cookie.
 *
 * - One pass draws the texture into a {@link COOKIE_TILE}² RGBA8 target
 *   (the sampler's own mip choice scales it down, as the 2D canvas does for
 *   an image), sRGB-encoded again where the texture is sRGB, so the bytes
 *   read back are the image's own bytes and go through the same decode as
 *   a PNG cookie's (`rasterCookie`).
 * - Rows: the bytes come out in the order a 2D canvas gives the same
 *   image, so they go through the PNG's path unchanged. The pass picks the
 *   texture row each target row samples from the far end on WebGPU and
 *   from the near end on WebGL 2 (each backend's screen coordinate against
 *   the rows its read-back returns), as measured against a PNG of the same
 *   image on both renderers (`lights.e2e.ts`: the same pattern, the same
 *   way up).
 *
 * Browser-only (three's WebGPURenderer, WebGPU or WebGL 2).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

const TSL = TSLTyped as unknown as Record<string, (...args: unknown[]) => N>;
const { float, floor, screenCoordinate, select, sRGBTransferOETF, texture: textureNode, uniform, vec2, vec4 } = TSL as unknown as {
  float: (v: number | N) => N;
  floor: (v: N) => N;
  screenCoordinate: N;
  select: (c: N, a: N, b: N) => N;
  sRGBTransferOETF: (v: N) => N;
  texture: (t: THREE.Texture, uv?: N) => N & { value: THREE.Texture };
  uniform: (v: number) => N & { value: number };
  vec2: (x: N, y: N) => N;
  vec4: (rgb: N, a: number | N) => N;
};

/** What the pass needs of three's renderer. */
export interface CookieDecodeRenderer {
  readonly backend: { readonly isWebGLBackend?: boolean };
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(t: THREE.RenderTarget | null): void;
  readRenderTargetPixelsAsync(t: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<ArrayBufferView>;
}

/** Draws textures back to bytes, one pass and one target reused. */
export class CookieDecoder {
  private quad: THREE.QuadMesh | null = null;
  private target: THREE.RenderTarget | null = null;
  private map: (N & { value: THREE.Texture }) | null = null;
  private readonly flip = uniform(0);
  private readonly srgb = uniform(0);
  private readonly placeholder = new THREE.Texture();

  constructor(readonly side: number) {}

  /** The texture's image as RGBA bytes at `side`², rows top first (as a 2D canvas gives them). */
  async pixels(renderer: CookieDecodeRenderer, texture: THREE.Texture): Promise<Uint8ClampedArray> {
    const side = this.side;
    if (this.quad === null) {
      const row = floor(screenCoordinate.y);
      const memRow = select(this.flip.greaterThan(0.5), float(side - 1).sub(row), row);
      const uv = vec2(floor(screenCoordinate.x).add(0.5).div(side), memRow.add(0.5).div(side));
      // The texture is swapped in per cookie (an sRGB one is decoded by its GPU format as it is sampled).
      this.map = textureNode(this.placeholder, uv);
      const rgb = (this.map as unknown as { rgb: N }).rgb;
      const material = new THREE.NodeMaterial();
      material.outputNode = vec4(select(this.srgb.greaterThan(0.5), sRGBTransferOETF(rgb), rgb), 1);
      material.depthTest = false;
      material.depthWrite = false;
      this.quad = new THREE.QuadMesh(material);
      this.target = new THREE.RenderTarget(side, side, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
      this.target.texture.colorSpace = THREE.NoColorSpace;
    }
    this.map!.value = texture;
    this.flip.value = renderer.backend.isWebGLBackend === true ? 0 : 1;
    this.srgb.value = texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer as unknown as THREE.Renderer);
    renderer.setRenderTarget(was);
    this.map!.value = this.placeholder;
    const raw = (await renderer.readRenderTargetPixelsAsync(this.target!, 0, 0, side, side)) as Uint8Array;
    // WebGPU pads each row to 256 bytes.
    const row = side * 4;
    const stride = (raw.length - row) / (side - 1);
    const out = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y += 1) out.set(raw.subarray(y * stride, y * stride + row), y * row);
    return out;
  }

  dispose(): void {
    (this.quad?.material as THREE.Material | undefined)?.dispose();
    this.target?.dispose();
    this.placeholder.dispose();
    this.quad = null;
    this.target = null;
    this.map = null;
  }
}
