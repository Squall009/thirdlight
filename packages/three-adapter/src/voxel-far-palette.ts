/**
 * The far colour of every look word (material | wetness << 12) as the
 * surface's `farColour` gives it, drawn on the GPU into a small target and
 * read back: the palette the far bricks' baked samples take their colour
 * from (`@thirdlight/voxel` far-bricks-shade.ts).
 *
 * Why on the GPU: a far colour is the material's table colour times its
 * wall set's mean, and the mean is the array's coarsest level, which only
 * the GPU holds; drawing the same `farColour` the far meshes use keeps
 * the two far modes' colours one function. The surface counts its table
 * uploads (a record's look, new arrays), so the palette is drawn again
 * only when one of those happened.
 *
 * The first draw writes each texel's own word, read back once, so where a
 * word lands (a renderer's row order) is measured, never assumed.
 */
import * as THREE from 'three';
import { NodeMaterial, QuadMesh } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { FAR_PALETTE_WORDS, MATERIAL_BITS, type FarPalette } from '@thirdlight/voxel';
import type { N } from './effects-tsl';
import type { VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { float, floor, mod, screenCoordinate, vec4 } = TSL;

/** Texels a side of the palette's target: one a word. */
const SIDE = Math.sqrt(FAR_PALETTE_WORDS);

/** What the palette draws and reads back with (three's WebGPU renderer, either backend). */
export interface FarPaletteRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  readRenderTargetPixelsAsync(target: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<ArrayBufferView>;
}

export class FarBrickPalette {
  private readonly quad = new QuadMesh(null as never);
  private readonly target = new THREE.RenderTarget(SIDE, SIDE, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  private readonly words: NodeMaterial;
  private readonly colours: NodeMaterial;
  /** Read-back texel → its word (measured by the first draw). */
  private order: Uint32Array | null = null;
  /** The palette now (null until first drawn): RGBA bytes by word. */
  palette: FarPalette | null = null;
  /** The surface's table uploads the palette was drawn at (−1: never). */
  drawnAt = -1;
  /** Draws made. */
  draws = 0;

  constructor(private readonly surface: VoxelSurface) {
    this.target.texture.colorSpace = THREE.NoColorSpace;
    const word = floor(screenCoordinate.x).add(floor(screenCoordinate.y).mul(SIDE));
    this.words = new NodeMaterial();
    this.words.outputNode = vec4(mod(word, 256).div(255), floor(word.div(256)).div(255), float(0), float(1));
    this.colours = new NodeMaterial();
    const top = 2 ** MATERIAL_BITS;
    this.colours.outputNode = vec4(surface.farColour(mod(word, top), floor(word.div(top))), float(1));
    for (const m of [this.words, this.colours]) {
      m.toneMapped = false;
      m.depthTest = m.depthWrite = false;
    }
  }

  /** Whether the surface's looks changed since the palette was drawn. */
  get stale(): boolean {
    return this.drawnAt !== this.surface.tableUploads;
  }

  /** Draws the palette again and reads it back; the words whose colour changed (every word the first time). */
  async update(renderer: FarPaletteRenderer): Promise<Uint8Array> {
    const at = this.surface.tableUploads;
    if (this.order === null) {
      const raw = await this.draw(renderer, this.words);
      const order = new Uint32Array(FAR_PALETTE_WORDS);
      for (let t = 0; t < FAR_PALETTE_WORDS; t++) order[t] = raw[t * 4]! + 256 * raw[t * 4 + 1]!;
      this.order = order;
    }
    const raw = await this.draw(renderer, this.colours);
    const next = new Uint8Array(FAR_PALETTE_WORDS * 4);
    for (let t = 0; t < FAR_PALETTE_WORDS; t++) next.set(raw.subarray(t * 4, t * 4 + 4), this.order[t]! * 4);
    const changed = new Uint8Array(FAR_PALETTE_WORDS);
    const old = this.palette;
    for (let w = 0; w < FAR_PALETTE_WORDS; w++) {
      const i = w * 4;
      if (old === null || old[i] !== next[i] || old[i + 1] !== next[i + 1] || old[i + 2] !== next[i + 2]) changed[w] = 1;
    }
    this.palette = next;
    this.drawnAt = at;
    return changed;
  }

  /** One draw of `material` over the target, read back as SIDE² RGBA texels (rows unpadded). */
  private async draw(renderer: FarPaletteRenderer, material: NodeMaterial): Promise<Uint8Array> {
    const saved = renderer.getRenderTarget();
    this.quad.material = material;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer as never);
    renderer.setRenderTarget(saved);
    this.draws++;
    const got = await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, SIDE, SIDE);
    const raw = new Uint8Array(got.buffer, got.byteOffset, got.byteLength);
    // WebGPU pads each row to 256 bytes (a row here is 1,024: none, but measured rather than assumed).
    const row = SIDE * 4;
    const stride = (raw.length - row) / (SIDE - 1);
    if (stride === row) return raw.slice(0, SIDE * row);
    const out = new Uint8Array(SIDE * row);
    for (let y = 0; y < SIDE; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row);
    return out;
  }

  dispose(): void {
    this.target.dispose();
    this.words.dispose();
    this.colours.dispose();
  }
}
