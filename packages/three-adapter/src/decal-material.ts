/**
 * A decal material's nodes (shader type `decal`): its images read from the
 * build's decal pages, or, where a view has no pages (the editor's Scene
 * view, a material the build could not place), from its own textures or
 * its trim sheet's cell.
 *
 * The mesh's texture coordinates 0–1 cover the decal's rectangle; outside
 * it they are held at its edge. Every read samples with the screen-space
 * derivatives shortened to the rectangle's safe footprint (the deepest mip
 * level whose texels stay in its gutter), as the trim material does with
 * its rows, so a far decal never blends its page neighbours in.
 *
 * Three reads at most (albedo with opacity, normal, ORM with the emissive
 * mask in alpha), each a page of a texture array at a layer the material
 * names in a uniform: every decal material with the same sets builds the
 * same program, whatever its page. Without pages a fourth read is the
 * emissive map (its largest of R, G, B is the mask, as the page planner
 * writes it).
 *
 * `multiply` draws unlit: the colour is the stain (white where there is
 * none), which the blend multiplies into the surface (`mesh-decals.ts`).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import type { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';

type Node = ReturnType<typeof TSL.float>;
type Vec4Node = ReturnType<typeof TSL.vec4>;
type Vec2Node = ReturnType<typeof TSL.vec2>;

/** One image a decal reads: a 2D texture, or a layer of a page array. */
export interface DecalImage {
  readonly texture: THREE.Texture;
  /** The page's layer (null: a 2D texture). */
  readonly layer: number | null;
}

/** The images a decal material reads (set as they arrive; null: none, the material's factors alone). */
export interface DecalImages {
  albedo: DecalImage | null;
  normal: DecalImage | null;
  /** Occlusion, roughness, metalness; the emissive mask in alpha unless `emissive` is set. */
  orm: DecalImage | null;
  /** A 2D emissive map whose largest of R, G, B is the mask (own textures only; pages carry the mask in the ORM's alpha). */
  emissive: DecalImage | null;
  /** An albedo image is on its way: until it is here the decal draws nothing (not a plain rectangle of its tint). */
  albedoComing: boolean;
}

/** Where the decal is on its images. */
export interface DecalPlace {
  /** [u0, v0, u1, v1] from the image's top-left (inset half a texel where neighbours sit). */
  rect: readonly [number, number, number, number];
  /** The deepest mip level its reads may reach (null: any; an image of its own). */
  mip: number | null;
  /** The image's size in texels at level 0 (what the footprint is measured in). */
  size: readonly [number, number];
}

const numOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Put the decal nodes on `m` (a standard node material, or a basic one for
 * `multiply`) and return the refresh that rebuilds them when an image or
 * the place changes (the reads are explicit nodes).
 */
export function installDecalNodes(m: THREE.Material, params: Readonly<Record<string, unknown>>, images: DecalImages, place: DecalPlace, multiply: boolean): () => void {
  const rect = TSL.uniform(new THREE.Vector4());
  const size = TSL.uniform(new THREE.Vector2(1, 1));
  const footprint = TSL.uniform(1e9);
  const aoIntensity = TSL.uniform(numOf(params['aoIntensity'], 1));
  const layers = { albedo: TSL.uniform(0, 'int'), normal: TSL.uniform(0, 'int'), orm: TSL.uniform(0, 'int') };
  const setPlace = (): void => {
    (rect.value as THREE.Vector4).set(place.rect[0], place.rect[1], place.rect[2], place.rect[3]);
    (size.value as THREE.Vector2).set(place.size[0], place.size[1]);
    footprint.value = place.mip === null ? 1e9 : 2 ** place.mip;
  };

  const refresh = (): void => {
    setPlace();
    const at = TSL.mix(rect.xy, rect.zw, TSL.clamp(TSL.uv(0), 0, 1)) as unknown as Vec2Node;
    // The derivatives shortened so their longer one spans at most the safe footprint (in level-0 texels).
    const dx = TSL.dFdx(at);
    const dy = TSL.dFdy(at);
    const longest = TSL.max(TSL.length(dx.mul(size)), TSL.length(dy.mul(size)));
    const k = TSL.min(TSL.float(1), footprint.div(TSL.max(longest, 1e-6)));
    const gx = dx.mul(k);
    const gy = dy.mul(k);
    const read = (img: DecalImage | null, layer: unknown): Vec4Node | null => {
      if (img === null) return null;
      type Sample = { depth(n: unknown): Sample; grad(a: unknown, b: unknown): Vec4Node };
      let t = TSL.texture(img.texture, at) as unknown as Sample;
      if (img.layer !== null) {
        (layer as { value: number }).value = img.layer;
        t = t.depth(layer);
      }
      return t.grad(gx, gy);
    };
    const albedo = read(images.albedo, layers.albedo) ?? TSL.vec4(1, 1, 1, images.albedoComing ? 0 : 1);
    const tinted = albedo.rgb.mul(TSL.materialColor.rgb);
    if (multiply) {
      const nb = m as unknown as MeshBasicNodeMaterial;
      // White where the decal is not: the blend multiplies the surface by this.
      nb.colorNode = TSL.vec4(TSL.mix(TSL.vec3(1, 1, 1), tinted, TSL.saturate(albedo.a.mul(TSL.materialOpacity))), 1) as unknown as MeshBasicNodeMaterial['colorNode'];
      return;
    }
    const nm = m as unknown as MeshStandardNodeMaterial;
    nm.colorNode = TSL.vec4(tinted, albedo.a) as unknown as MeshStandardNodeMaterial['colorNode'];
    const orm = read(images.orm, layers.orm);
    if (orm !== null) {
      nm.roughnessNode = TSL.materialRoughness.mul(orm.g) as unknown as MeshStandardNodeMaterial['roughnessNode'];
      nm.metalnessNode = TSL.materialMetalness.mul(orm.b) as unknown as MeshStandardNodeMaterial['metalnessNode'];
      // three's aoMapIntensity rule: (r − 1) × intensity + 1.
      nm.aoNode = orm.r.sub(1).mul(aoIntensity).add(1) as unknown as MeshStandardNodeMaterial['aoNode'];
    } else {
      nm.roughnessNode = null;
      nm.metalnessNode = null;
      nm.aoNode = null;
    }
    const glow = read(images.emissive, null);
    const mask = (glow !== null ? TSL.max(glow.r, TSL.max(glow.g, glow.b)) : orm !== null ? orm.a : null) as Node | null;
    nm.emissiveNode = (mask !== null ? TSL.materialEmissive.mul(mask) : null) as unknown as MeshStandardNodeMaterial['emissiveNode'];
    const normal = read(images.normal, layers.normal);
    if (normal === null) nm.normalNode = null;
    else {
      const n = TSL.normalMap(normal.xyz, TSL.materialReference('normalScale', 'vec2') as unknown as Vec2Node);
      (n as unknown as { normalMapType: THREE.NormalMapTypes }).normalMapType = THREE.TangentSpaceNormalMap;
      nm.normalNode = n as unknown as MeshStandardNodeMaterial['normalNode'];
    }
  };
  refresh();
  return refresh;
}

/** The array view of each decoded page (a set with one page ships as a plain 2D texture). */
const arrayViews = new WeakMap<THREE.Texture, THREE.Texture>();

/**
 * A decal page as a texture array: one shader path for every page, however
 * many layers its set has. A set of one page ships as a plain 2D KTX2 (three
 * reads a layer count of 1 as no array), so its decoded texture is viewed as
 * an array of one layer: the same mip levels, no copy, and the 2D texture is
 * never uploaded. It goes with the texture it views. An array is itself.
 */
export function decalPageArray(t: THREE.Texture): THREE.Texture {
  const known = arrayViews.get(t);
  if (known !== undefined) return known;
  const flags = t as THREE.Texture & { isCompressedArrayTexture?: boolean; isDataArrayTexture?: boolean; isCompressedTexture?: boolean; isDataTexture?: boolean };
  if (flags.isCompressedArrayTexture === true || flags.isDataArrayTexture === true) return t;
  let a: THREE.Texture;
  if (flags.isCompressedTexture === true) {
    const c = t as THREE.CompressedTexture;
    const top = (c.mipmaps as unknown as { width: number; height: number }[])[0];
    if (top === undefined) return t;
    a = new THREE.CompressedArrayTexture(c.mipmaps as unknown as ImageData[], top.width, top.height, 1, c.format as THREE.CompressedPixelFormat, c.type);
    a.generateMipmaps = false;
  } else if (flags.isDataTexture === true) {
    // An uncompressed transcode (a GPU without a compressed format): level 0, its chain made on upload.
    const img = t.image as { data: Uint8Array; width: number; height: number };
    a = new THREE.DataArrayTexture(img.data, img.width, img.height, 1);
    a.format = t.format;
    a.type = t.type;
    a.generateMipmaps = true;
  } else return t;
  a.colorSpace = t.colorSpace;
  a.minFilter = t.minFilter === THREE.LinearFilter || t.minFilter === THREE.NearestFilter ? THREE.LinearMipmapLinearFilter : t.minFilter;
  a.magFilter = t.magFilter;
  a.wrapS = THREE.ClampToEdgeWrapping;
  a.wrapT = THREE.ClampToEdgeWrapping;
  a.anisotropy = t.anisotropy;
  a.flipY = false;
  a.name = t.name;
  a.needsUpdate = true;
  arrayViews.set(t, a);
  t.addEventListener('dispose', () => a.dispose());
  return a;
}
