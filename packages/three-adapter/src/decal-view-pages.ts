/**
 * Decal pages made on the GPU for a view without the build's pages (the
 * editor's Scene view, which draws the project as it is, not a build):
 * every decal material a projected decal there uses gets a layer in each
 * set it has an image for, and its image (its own texture, or its trim
 * sheet's cell) is drawn into that layer, stretched to fill it. Projected
 * decals then read these arrays the way they read a build's (one program
 * either way), so the Scene view shows what Play shows.
 *
 * A layer is redrawn when its images change (an image arrived, the material
 * changed); the arrays grow by doubling, and all layers are drawn again then.
 * Each array keeps a full mip chain (made after each draw), so the layer's
 * whole chain is safe to read: its rectangle is the whole layer.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { DecalImage } from './decal-material';
import type { N } from './effects-tsl';
import type { DecalSource } from './material-library';
import type { DecalPageSetName } from './projected-decals';

const TSL: N = TSLTyped;
const { float, max, mix, texture, uniform, uv, vec3, vec4 } = TSL;

/**
 * The side of a view's decal layers (texels): an editing preview, at most
 * 1 MiB a layer and set with its mips (RGBA8). A build's pages keep each
 * image's own size.
 */
export const DECAL_VIEW_PAGE_SIZE = 512;

const SETS: readonly DecalPageSetName[] = ['albedo', 'normal', 'orm'];

/** The layers of one material's images (−1: no image in that set). */
export type DecalViewLayers = readonly [number, number, number];

export interface DecalViewPages {
  /** Bring the layers up to date for `sources` (the materials in use) and draw what changed; returns each source's layers. */
  update(renderer: THREE.Renderer, sources: ReadonlySet<DecalSource>): Map<DecalSource, DecalViewLayers>;
  /** Each set's array (null: no material has an image in it). */
  readonly arrays: Readonly<Record<DecalPageSetName, THREE.Texture | null>>;
  /** Their GPU bytes (every level of every layer). */
  bytes(): number;
  dispose(): void;
}

/** What a layer was drawn from (it is drawn again when this changes). */
const signatureOf = (img: DecalImage | null, rect: readonly number[]): string => (img === null ? '' : `${img.texture.uuid}:${img.texture.version}:${rect.join(',')}`);

export function createDecalViewPages(): DecalViewPages {
  const arrays: Record<DecalPageSetName, THREE.Texture | null> = { albedo: null, normal: null, orm: null };
  const targets: Record<DecalPageSetName, THREE.RenderTarget | null> = { albedo: null, normal: null, orm: null };
  /** Each source's slot (its layer in every set), and what each slot's layers were drawn from. */
  const slots = new Map<DecalSource, number>();
  const drawn = new Map<string, string>();
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
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    m.fog = false;
    return m;
  };
  const quads: Record<DecalPageSetName, THREE.QuadMesh> = {
    albedo: new THREE.QuadMesh(material(src.a)),
    normal: new THREE.QuadMesh(material(src.a)),
    // Occlusion, roughness, metalness (white without an image) and the emissive mask: the emissive image's largest
    // of R, G, B, else the ORM image's alpha (as the build's page planner writes it).
    orm: new THREE.QuadMesh(
      material(vec4(mix(vec3(1), src.a.rgb, has.a), mix(mix(float(0), src.a.a, has.a), max(src.b.r, max(src.b.g, src.b.b)), has.b))),
    ),
  };

  const makeTarget = (set: DecalPageSetName, layers: number): THREE.RenderTarget => {
    const t = new THREE.RenderTarget(DECAL_VIEW_PAGE_SIZE, DECAL_VIEW_PAGE_SIZE, { depth: layers, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType });
    t.texture.colorSpace = set === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.texture.wrapS = THREE.ClampToEdgeWrapping;
    t.texture.wrapT = THREE.ClampToEdgeWrapping;
    t.texture.name = `decal view pages ${set}`;
    return t;
  };

  const draw = (renderer: THREE.Renderer, set: DecalPageSetName, slot: number, s: DecalSource): void => {
    const img = s.images;
    const r = s.place.rect;
    (rect.value as THREE.Vector4).set(r[0], r[1], r[2], r[3]);
    if (set === 'orm') {
      src.a.value = img.orm?.texture ?? blank;
      has.a.value = img.orm !== null ? 1 : 0;
      src.b.value = img.emissive?.texture ?? blank;
      has.b.value = img.emissive !== null ? 1 : 0;
    } else src.a.value = (set === 'albedo' ? img.albedo : img.normal)?.texture ?? blank;
    renderer.setRenderTarget(targets[set], slot);
    quads[set].render(renderer);
  };

  return {
    arrays,
    update(renderer, sources) {
      for (const s of [...slots.keys()]) if (!sources.has(s)) slots.delete(s);
      // Keep slots compact enough: a source takes the first free slot.
      const used = new Set(slots.values());
      for (const s of sources) {
        if (slots.has(s)) continue;
        let k = 0;
        while (used.has(k)) k += 1;
        slots.set(s, k);
        used.add(k);
      }
      const need = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1, ...[...slots.values()].map((k) => k + 1)))));
      const want = (set: DecalPageSetName): boolean => [...slots.keys()].some((s) => (set === 'albedo' ? s.images.albedo : set === 'normal' ? s.images.normal : (s.images.orm ?? s.images.emissive)) !== null);
      const prevTarget = renderer.getRenderTarget();
      const prevFace = renderer.getActiveCubeFace();
      const prevLevel = renderer.getActiveMipmapLevel();
      try {
        for (const set of SETS) {
          if (!want(set)) {
            targets[set]?.dispose();
            targets[set] = null;
            arrays[set] = null;
            continue;
          }
          if (targets[set] === null || capacity < need) {
            targets[set]?.dispose();
            targets[set] = makeTarget(set, Math.max(need, capacity));
            arrays[set] = targets[set]!.texture;
            for (const k of [...drawn.keys()]) if (k.startsWith(`${set}:`)) drawn.delete(k);
          }
          for (const [s, slot] of slots) {
            const img = set === 'albedo' ? s.images.albedo : set === 'normal' ? s.images.normal : (s.images.orm ?? s.images.emissive);
            const sig = img === null ? '' : `${signatureOf(img, s.place.rect)}|${set === 'orm' ? signatureOf(s.images.emissive, []) : ''}`;
            const key = `${set}:${slot}`;
            if (img === null || drawn.get(key) === sig) continue;
            draw(renderer, set, slot, s);
            drawn.set(key, sig);
          }
        }
        capacity = Math.max(capacity, need);
      } finally {
        renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
      }
      const out = new Map<DecalSource, DecalViewLayers>();
      for (const [s, slot] of slots) {
        const i = s.images;
        out.set(s, [i.albedo !== null && arrays.albedo !== null ? slot : -1, i.normal !== null && arrays.normal !== null ? slot : -1, (i.orm ?? i.emissive) !== null && arrays.orm !== null ? slot : -1]);
      }
      return out;
    },
    bytes() {
      let b = 0;
      for (const t of Object.values(targets)) if (t !== null) b += Math.round(t.width * t.height * 4 * t.depth * (4 / 3));
      return b;
    },
    dispose() {
      for (const t of Object.values(targets)) t?.dispose();
      for (const q of Object.values(quads)) (q.material as THREE.Material).dispose();
      blank.dispose();
    },
  };
}
