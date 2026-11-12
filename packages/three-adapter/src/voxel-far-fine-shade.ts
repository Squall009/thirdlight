/**
 * Fine far bricks shaded as the near surface draws its own: a fine brick
 * (levels 0–1, built on the GPU, voxel-fine-bricks.ts) keeps each sample's
 * look word, so a hit on one knows its materials, and the far shade
 * (voxel-far-visibility.ts) reads their texture sets the way the surface
 * does (voxel-surface.ts `farSurface`: the grid's 4 m tiles and the wall,
 * floor or ceiling set by the normal on construction, one axis's 2 m tiles
 * on terrain, the height blend, wetness), then fades to the far palette's
 * colour with distance.
 *
 * - **Where.** The hit's place in the world's cell frame comes from the
 *   frame's camera and the far view's root (in 64 bits on the CPU each
 *   frame), plus the floating origin's grid phase, the near surface's: a
 *   texture lies at the same metres on a fine brick as on the mesh it
 *   continues.
 * - **Which materials.** The two heaviest of the eight samples' words round
 *   the hit by its trilinear weights (as a filtered read blends colours),
 *   blended by height as the near surface blends two cells; the near
 *   surface's own blend width per material is not read (a sample is 0.5 or
 *   1 m apart already).
 * - **Which level.** The texels as wide as the pixel's footprint on the
 *   surface (its distance, the pixel's angle, the slant), read with an
 *   explicit level: only fine pixels take the reads, in a branch.
 * - **The fade.** Textured to the fade's start, the palette's colour (the
 *   two words' far colours, the table colour times the set's mean) at its
 *   end, where level 2's bricks (palette-coloured) may begin (`@thirdlight/
 *   voxel` far-fine.ts `farFineFade`): the hand-over joins two colours of one
 *   palette, and the mean of a set's mips is that colour, so the fade only
 *   takes the detail away.
 * - **Live colours.** A word's far colour and textures are read from the
 *   surface's table and arrays when shaded: a material record's change
 *   reaches fine bricks with no rebuild.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { FAR_FINE_TOP_LEVEL, MATERIAL_BITS, VOXEL_SIZE_M, WETNESS_BITS, type FloatingOrigin } from '@thirdlight/voxel';

import type { N } from './effects-tsl';
import type { FarBrickTextures } from './voxel-far-brick-field';
import { PHASE_CELLS, type VoxelSurface } from './voxel-surface';
import { gridPhases } from './voxel-surface-projection';
import type { SetMaps } from './voxel-surface-sets';

const TSL: N = TSLTyped;
const { If, abs, cameraProjectionMatrix, dot, float, floor, length, max, mix, mod, normalize, screenSize, select, smoothstep, uniform, vec3, vec4 } = TSL;

/** A far node whose cells are narrower than this (metres) is a fine one (levels 0–1: 0.5 and 1 m; level 2: 2 m). */
export const FAR_FINE_CELL_M_BELOW = 1.5 * 2 ** FAR_FINE_TOP_LEVEL * VOXEL_SIZE_M;

/** The slant's cosine a footprint is taken at least at: a grazing view's pixel is not stretched past four times. */
const FOOTPRINT_COS_MIN = 0.25;

/** What a fine hit reads of the texture sets: every map, the albedo alone (flat normal, neutral ORM), or none (the palette's colour). */
export type FarFineTexture = SetMaps | 'off';

/** The page flag for comparisons: `?fineTexture=full|albedo|off` (absent: the view's setting). */
export const FINE_TEXTURE_URL_PARAM = 'fineTexture';

/** A page's `?fineTexture=` (null: absent or not one of the three). */
export function fineTextureFromUrl(search: string): FarFineTexture | null {
  const v = new URLSearchParams(search).get(FINE_TEXTURE_URL_PARAM);
  return v === 'full' || v === 'albedo' || v === 'off' ? v : null;
}

/** A fine hit as the shade has it (TSL): its brick's region (texels), the hit in its cells, its normal (cell axes), its view position, whether it began inside. */
export interface FineHit {
  readonly region: N;
  readonly p: N;
  readonly n: N;
  readonly view: N;
  readonly inside: N;
}

/** A fine hit's look: linear colour (occlusion applied), normal (cell axes), roughness and ambient occlusion. */
export interface FineLook {
  readonly colour: N;
  readonly normal: N;
  readonly roughness: N;
  readonly ao: N;
}

export class FarFineShade {
  /** The frame's view space into the far view root's (metres from the floating origin, the world's cell axes). */
  private readonly localFromView = uniform(new THREE.Matrix4());
  /** The floating origin's grid phases (metres): plain, 45° and 1:2 slope (voxel-surface-projection.ts). */
  private readonly phase = uniform(new THREE.Vector3());
  private readonly slope = uniform(new THREE.Vector3());
  private readonly slope5 = uniform(new THREE.Vector3());
  /** Metres from the eye where the textures begin to fade, and where they are gone. */
  private readonly fade = uniform(new THREE.Vector2(1e6, 2e6));
  /** 1: textured as {@link texture} says; 0: the palette's colour (a comparison at run time, no new program). */
  private readonly on = uniform(1);
  private readonly scratch = new THREE.Matrix4();
  private readonly cells = new THREE.Vector3();

  constructor(
    private readonly surface: VoxelSurface,
    private readonly textures: FarBrickTextures,
    readonly texture: FarFineTexture,
  ) {}

  /** Where the textures fade to the palette's colour (metres from the eye). */
  setFade(start: number, end: number): void {
    (this.fade.value as THREE.Vector2).set(start, Math.max(end, start + 1e-3));
  }

  /** Textures on or off without a new program (off: fine hits take the palette's colour and read no texture). */
  setTextured(on: boolean): void {
    this.on.value = on ? 1 : 0;
  }

  get textured(): boolean {
    return this.texture !== 'off' && (this.on.value as number) > 0;
  }

  get fadeMetres(): readonly [number, number] {
    const v = this.fade.value as THREE.Vector2;
    return [v.x, v.y];
  }

  /** Before a frame's shade: the camera and the far view's root (`root` · (cell − origin) · size is a cell's world place). */
  frame(camera: THREE.Camera, root: THREE.Object3D, origin: FloatingOrigin): void {
    (this.localFromView.value as THREE.Matrix4).copy(this.scratch.copy(root.matrixWorld).invert()).multiply(camera.matrixWorld);
    const o = origin.origin;
    const phase = this.phase.value as THREE.Vector3;
    gridPhases([o.x, o.y, o.z], VOXEL_SIZE_M, PHASE_CELLS, this.cells, this.slope.value as THREE.Vector3, this.slope5.value as THREE.Vector3);
    phase.copy(this.cells).multiplyScalar(VOXEL_SIZE_M);
  }

  /**
   * Where the shade reads a view-space point's textures from as of the last {@link frame} (numbers; the program does
   * the same with its uniforms): world metres from the plain grid phase and from the two slope phases.
   */
  pointAt(view: THREE.Vector3): { p: THREE.Vector3; ps: THREE.Vector3; ps5: THREE.Vector3 } {
    const local = view.clone().applyMatrix4(this.localFromView.value as THREE.Matrix4);
    return { p: local.clone().add(this.phase.value as THREE.Vector3), ps: local.clone().add(this.slope.value as THREE.Vector3), ps5: local.clone().add(this.slope5.value as THREE.Vector3) };
  }

  /** A word's material id and wetness (the construction bit above them dropped): the far colour's inputs. */
  private farColour(word: N): N {
    const top = 2 ** MATERIAL_BITS;
    return this.surface.farColour(mod(word, top), mod(floor(word.div(top)), 2 ** WETNESS_BITS));
  }

  /** The palette's colour of a fine hit (its two heaviest words' far colours blended, the occlusion applied): what the direct march draws. */
  palette(region: N, p: N, inside: N): N {
    const w = this.textures.fineLooks(region, p);
    const occ = select(inside, float(1), this.textures.occlusion(region, p));
    return mix(this.farColour(w.a), this.farColour(w.b), w.share).mul(occ);
  }

  /** A fine hit's look (TSL, inside the shade's program): textured near, the palette's colour past the fade. */
  shade(h: FineHit): FineLook {
    const w = this.textures.fineLooks(h.region, h.p);
    const a = w.a.toVar();
    const b = w.b.toVar();
    const share = w.share.toVar();
    const occ = select(h.inside, float(1), this.textures.occlusion(h.region, h.p)).toVar();
    const flat = mix(this.farColour(a), this.farColour(b), share).toVar();
    const colour = flat.mul(occ).toVar();
    const normal = vec3(h.n).toVar();
    const roughness = float(1).toVar();
    const ao = float(1).toVar();
    if (this.texture === 'off') return { colour, normal, roughness, ao };
    const dist = length(h.view).toVar();
    const t = float(1).sub(smoothstep(this.fade.x, this.fade.y, dist)).mul(this.on).toVar();
    If(t.greaterThan(0), () => {
      const local = this.localFromView.mul(vec4(h.view, 1)).xyz;
      const eye = this.localFromView.mul(vec4(0, 0, 0, 1)).xyz;
      // Radians a pixel covers at the screen's centre, over the slant: the metres it covers on the surface.
      const pixelAngle = float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y));
      const slant = max(abs(dot(h.n, normalize(local.sub(eye)))), FOOTPRINT_COS_MIN);
      const s = this.surface.farSurface({ a, b, share, n: h.n, p: this.phase.add(local), ps: this.slope.add(local), ps5: this.slope5.add(local), footprintM: dist.mul(pixelAngle).div(slant) }, this.texture as SetMaps);
      colour.assign(mix(flat, s.albedo, t).mul(occ));
      normal.assign(normalize(mix(h.n, s.normal, t)));
      roughness.assign(mix(float(1), s.roughness, t));
      ao.assign(mix(float(1), s.ao, t));
    });
    return { colour, normal, roughness, ao };
  }
}
