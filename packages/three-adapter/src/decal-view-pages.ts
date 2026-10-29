/**
 * Decal pages made on the GPU for a view without the build's pages (the
 * editor's Scene view, which draws the project as it is, not a build):
 * every decal material a projected decal there uses gets a layer for each
 * set it has an image for, in one array as a build's pages are (project-model
 * `decalPageArrays`: one texture for all three sets, the albedo layers sRGB
 * texels in a linear array), and its image (its own texture, or its trim
 * sheet's cell) is drawn into that layer, stretched to fill it. Projected
 * decals then read this array the way they read a build's (one program
 * either way), so the Scene view shows what Play shows.
 *
 * A layer is redrawn when its images change (an image arrived, the material
 * changed); the array grows by doubling, and all layers are drawn again then.
 * It keeps a full mip chain (made after each draw), so the layer's whole
 * chain is safe to read: its rectangle is the whole layer.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { DecalImage } from './decal-material';
import type { N } from './effects-tsl';
import type { DecalSource } from './material-library';
import type { DecalPageSetName } from './projected-decals';

const TSL: N = TSLTyped;
const { float, max, mix, sRGBTransferOETF, texture, uniform, uv, vec3, vec4 } = TSL;

/**
 * The side of a view's decal layers (texels): an editing preview, at most
 * 1 MiB a layer with its mips (RGBA8). A build's pages keep each image's
 * own size.
 */
export const DECAL_VIEW_PAGE_SIZE = 512;

const SETS: readonly DecalPageSetName[] = ['albedo', 'normal', 'orm'];

/** The layers of one material's images (−1: no image in that set). */
export type DecalViewLayers = readonly [number, number, number];

export interface DecalViewPages {
  /** Bring the layers up to date for `sources` (the materials in use) and draw what changed; returns each source's layers. */
  update(renderer: THREE.Renderer, sources: ReadonlySet<DecalSource>): Map<DecalSource, DecalViewLayers>;
  /** The array (null: no material has an image). */
  readonly array: THREE.Texture | null;
  /** Its GPU bytes (every level of every layer). */
  bytes(): number;
  dispose(): void;
}

/** What a layer was drawn from (it is drawn again when this changes). */
const signatureOf = (img: DecalImage | null, rect: readonly number[]): string => (img === null ? '' : `${img.texture.uuid}:${img.texture.version}:${rect.join(',')}`);

/** A source's image in a set (the ORM layer: its ORM image, else its emissive one alone). */
const imageOf = (s: DecalSource, set: DecalPageSetName): DecalImage | null => (set === 'albedo' ? s.images.albedo : set === 'normal' ? s.images.normal : (s.images.orm ?? s.images.emissive));

export function createDecalViewPages(): DecalViewPages {
  let target: THREE.RenderTarget | null = null;
  /** Each source's layers (one per set it has an image in, −1 elsewhere), and what each layer was drawn from. */
  const layersOf = new Map<DecalSource, [number, number, number]>();
  const drawn = new Map<number, string>();
  let capacity = 0;

  // One quad per set, each reading its source through texture nodes whose textures are swapped per draw.
  const rect = uniform(new THREE.Vector4(0, 0, 1, 1));
  const at = mix(rect.xy, rect.zw, uv());
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const src = { a: texture(blank, at), b: texture(blank, at) };
  const has = { a: uniform(0), b: uniform(0) };
  const material = (colour: N): THREE.MeshBasicNodeMaterial => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = colour;
    // Written as is, alpha and all: a node material with normal blending that is not transparent writes alpha 1,
    // which drew every view-page decal as its whole rectangle (the image's alpha is the mark's shape).
    m.blending = THREE.NoBlending;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    m.fog = false;
    return m;
  };
  const quads: Record<DecalPageSetName, THREE.QuadMesh> = {
    // The albedo's sRGB texels, as a build's pages keep them in the linear array.
    albedo: new THREE.QuadMesh(material(vec4(sRGBTransferOETF(src.a.rgb), src.a.a))),
    normal: new THREE.QuadMesh(material(src.a)),
    // Occlusion, roughness, metalness (white without an image) and the emissive mask: the emissive image's largest
    // of R, G, B, else the ORM image's alpha (as the build's page planner writes it).
    orm: new THREE.QuadMesh(
      material(vec4(mix(vec3(1), src.a.rgb, has.a), mix(mix(float(0), src.a.a, has.a), max(src.b.r, max(src.b.g, src.b.b)), has.b))),
    ),
  };

  const makeTarget = (layers: number): THREE.RenderTarget => {
    const t = new THREE.RenderTarget(DECAL_VIEW_PAGE_SIZE, DECAL_VIEW_PAGE_SIZE, { depth: layers, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType });
    t.texture.colorSpace = THREE.NoColorSpace;
    t.texture.wrapS = THREE.ClampToEdgeWrapping;
    t.texture.wrapT = THREE.ClampToEdgeWrapping;
    t.texture.name = 'decal view pages';
    return t;
  };

  const draw = (renderer: THREE.Renderer, set: DecalPageSetName, layer: number, s: DecalSource): void => {
    const img = s.images;
    const r = s.place.rect;
    (rect.value as THREE.Vector4).set(r[0], r[1], r[2], r[3]);
    if (set === 'orm') {
      src.a.value = img.orm?.texture ?? blank;
      has.a.value = img.orm !== null ? 1 : 0;
      src.b.value = img.emissive?.texture ?? blank;
      has.b.value = img.emissive !== null ? 1 : 0;
    } else src.a.value = (set === 'albedo' ? img.albedo : img.normal)?.texture ?? blank;
    renderer.setRenderTarget(target, layer);
    quads[set].render(renderer);
  };

  return {
    get array() {
      return target?.texture ?? null;
    },
    update(renderer, sources) {
      for (const s of [...layersOf.keys()]) if (!sources.has(s)) layersOf.delete(s);
      // Each source's layers: kept while it keeps the image, the first free one for a new image.
      const used = new Set<number>();
      for (const [s, ls] of layersOf) {
        ls.forEach((l, k) => {
          if (l >= 0 && imageOf(s, SETS[k]!) !== null) used.add(l);
        });
      }
      const take = (): number => {
        let k = 0;
        while (used.has(k)) k += 1;
        used.add(k);
        return k;
      };
      for (const s of sources) {
        const ls = layersOf.get(s) ?? [-1, -1, -1];
        SETS.forEach((set, k) => {
          const want = imageOf(s, set) !== null;
          if (!want) ls[k] = -1;
          else if (ls[k]! < 0) ls[k] = take();
        });
        layersOf.set(s, ls);
      }
      const top = Math.max(-1, ...used);
      const prevTarget = renderer.getRenderTarget();
      const prevFace = renderer.getActiveCubeFace();
      const prevLevel = renderer.getActiveMipmapLevel();
      try {
        if (top < 0) {
          target?.dispose();
          target = null;
          capacity = 0;
          drawn.clear();
        } else {
          const need = Math.max(2, 2 ** Math.ceil(Math.log2(top + 1)));
          if (target === null || capacity < need) {
            target?.dispose();
            capacity = Math.max(need, capacity);
            target = makeTarget(capacity);
            drawn.clear();
          }
          for (const [s, ls] of layersOf) {
            SETS.forEach((set, k) => {
              const layer = ls[k]!;
              if (layer < 0) return;
              const sig = `${set}|${signatureOf(imageOf(s, set), s.place.rect)}|${set === 'orm' ? signatureOf(s.images.emissive, []) : ''}`;
              if (drawn.get(layer) === sig) return;
              draw(renderer, set, layer, s);
              drawn.set(layer, sig);
            });
          }
        }
      } finally {
        renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
      }
      return new Map([...layersOf].map(([s, ls]) => [s, [ls[0], ls[1], ls[2]] as const]));
    },
    bytes() {
      return target === null ? 0 : Math.round(target.width * target.height * 4 * target.depth * (4 / 3));
    },
    dispose() {
      target?.dispose();
      target = null;
      for (const q of Object.values(quads)) (q.material as THREE.Material).dispose();
      blank.dispose();
    },
  };
}
