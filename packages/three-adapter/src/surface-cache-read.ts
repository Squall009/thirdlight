/**
 * Materials reading the surface cache: a static surface's diffuse light from
 * the cache's texel under it, one filtered lookup (`surface-cache-lookup.ts`
 * finds the texel from the pixel's world position and normal), in place of
 * the lights the cache holds.
 *
 * What a reading pixel takes from where:
 *
 * - the cache: the direct light of every light it holds (point, spot, area,
 *   glowing surfaces; their soft traced shadows), into the direct diffuse
 *   light, never darkened by ambient occlusion;
 * - per pixel: the sun (its shadow map is sharper than a texel), so the
 *   sun's share of the texel (its alpha, `SURFACE_TEXEL_LIT`) is taken back
 *   out; and the local lights' highlights;
 * - the probes: bounced light, as every other surface (the cache holds
 *   direct light only, its bounce is read where it is read).
 *
 * A pixel that finds no texel (its tile not resident, a trim off its
 * chart's plane, a texel not lit yet) keeps its local lights' diffuse light
 * per pixel, blended by how much of the filtered lookup was lit.
 *
 * Which draws read it: a mesh whose `userData[SURFACE_READ_KEY]` names its
 * kind and whose material holds no saved lightmap (a bake keeps drawing
 * until the scene is baked again), in a scene whose `userData[SURFACE_READ_LIVE_KEY]` is true (a WebGPU
 * page lighting the cache live). It draws with a variant of its material
 * (`local-lights.ts`, as a local-light mode's), so shared materials, merged
 * cells and batches keep their own programs and a scene without live light
 * builds exactly the programs it built before.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { LIT } from './custom-lit';
import { SURFACE_PAGE_TEXELS } from './surface-cache-atlas';
import { buildReadsCopyColumns, instanceColumn } from './attribute-instancing';
import { ALBEDO_CELLS, ALBEDO_PAGE_STEP, ALBEDO_RING_STEP, albedoWords, ARCH_CELL, ARCH_FACING, ARCH_PLANE_METRES, BLOCK_INSET, BLOCK_LAYERS_HELD, EMPTY, LAYER_TEXELS, LOOKUP_WIDTH, SLOT_TEXELS, SURFACE_READ, SURFEL_KEY_BITS, TERRAIN_TEXELS, type SurfaceReadKind } from './surface-cache-lookup';
import { TERRAIN_RING_TEXELS, TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import { AreaHighlights, areaHighlightNodes, buildsHighlights, cacheVisibility } from './surface-highlights';
import { SURFACE_TEXEL_LIT } from './surface-light-wgsl';
import { texelTexture } from './texel-texture-node';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, Fn, If, Loop, abs, attribute, bool, clamp, cross, dot, float, floor, int, ivec2, max, mix, normalWorldGeometry, positionWorld, property, select, texture, uint, uintBitsToFloat, uniform, uniformArray, uv: uvOf, varying, vec2, vec3 } = TSL;

/** Rows of the lookup texture at first (it doubles when a scene's lookup outgrows it). */
const TABLE_ROWS = 16;

/** Every kind's bit (`SurfaceCacheTextures.readKinds`). */
export const SURFACE_READ_ALL = Object.values(SURFACE_READ).reduce((bits, kind) => bits | (1 << kind), 0);

/** `mesh.userData[SURFACE_READ_KEY]`: the kind of static surface it draws (`SURFACE_READ`), whose light it reads from the cache. */
export const SURFACE_READ_KEY = '__tlSurfaceRead';
/** `scene.userData[SURFACE_READ_LIVE_KEY]`: the scene's cache textures while its cache is lit live and its lookup is up to date (absent: not). */
export const SURFACE_READ_LIVE_KEY = '__tlSurfaceReadLive';
/** The own properties of a material variant that reads the cache: its kind, and the textures it reads. */
export const SURFACE_READ_VARIANT = 'tlSurfaceRead';
export const SURFACE_READ_TEXTURES = 'tlSurfaceReadTextures';

/** What a drawn object reads of the cache in `scene`: its kind, the scene's textures, and whether this frame its colours are written (null: nothing). */
export function surfaceReadOf(object: THREE.Object3D, scene: THREE.Object3D): { kind: number; textures: SurfaceCacheTextures; capture: boolean } | null {
  const textures = scene.userData[SURFACE_READ_LIVE_KEY] as SurfaceCacheTextures | undefined;
  if (textures === undefined) return null;
  const kind = (object.userData[SURFACE_READ_KEY] as number | undefined) ?? 0;
  return kind === 0 || (textures.readKinds & (1 << kind)) === 0 ? null : { kind, textures, capture: textures.capture };
}

/** Whether a reading build writes its surface's colour (a capture frame's program: a draw that writes cannot skip hidden pixels early). */
export const SURFACE_READ_CAPTURE = 'tlSurfaceReadCapture';

/** `mesh.userData[SURFACE_SLOT_KEY]`: a static model's slot (`SurfaceModelSlots`), whose record its pixels read. */
export const SURFACE_SLOT_KEY = '__tlSurfaceSlot';
/** A merged cell's vertex attribute: each member's slot (float). */
export const SURFACE_SLOT_ATTRIBUTE = 'tlSurfaceSlot';
/** Put the kind (and a model's slot) on every mesh under `root` (undefined: none). */
export function markSurfaceRead(root: THREE.Object3D, kind: SurfaceReadKind | undefined, slot?: number): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true) return;
    if (kind === undefined) {
      delete o.userData[SURFACE_READ_KEY];
      delete o.userData[SURFACE_SLOT_KEY];
    } else {
      o.userData[SURFACE_READ_KEY] = kind;
      if (slot !== undefined) o.userData[SURFACE_SLOT_KEY] = slot;
    }
  });
}

/** A drawn mesh's slot (0: none). */
export function surfaceSlotOf(mesh: THREE.Object3D): number {
  return (mesh.userData[SURFACE_SLOT_KEY] as number | undefined) ?? 0;
}

/** The kind a material build reads the cache for (0: none). */
export function buildSurfaceRead(builder: { material?: unknown }): number {
  return ((builder.material as Record<string, unknown> | undefined)?.[SURFACE_READ_VARIANT] as number | undefined) ?? 0;
}

/**
 * The textures materials read: the atlas and rings the light pass writes
 * (three's storage array textures, so a material samples what the pass's
 * own device writes), the lookup's words, and the sun's colour the cache's
 * texels were lit with.
 */
let texturesMade = 0;

export class SurfaceCacheTextures {
  /** Tells textures apart in programs' keys (two pages' scenes never share a reading program's bindings). */
  readonly id = ++texturesMade;
  readonly atlas: THREE.StorageArrayTexture;
  readonly rings: THREE.StorageArrayTexture;
  /** The surfaces' colours (`albedoWords`): the materials reading the cache write their own there as they draw, the probes' bounce reads them. */
  readonly albedo: THREE.StorageBufferAttribute;
  readonly albedoNode: N;
  /** Where the ring layers' colours start (words). */
  readonly albedoRingsAt: number;
  /** The kinds of surface that read (a bit per `SURFACE_READ` kind; the page flag can name fewer). */
  readKinds = SURFACE_READ_ALL;
  /** This frame the reading draws write their surfaces' colours (one frame now and then: the writes cost their draws early depth culling). */
  capture = false;
  table: THREE.DataTexture;
  /**
   * Tables outgrown: kept until these textures are let go, as three keeps
   * bind groups made on a disposed texture in some draws (a destroyed
   * texture in a submit), while a live one is only read stale until the
   * draw binds the new one.
   */
  private readonly retired: THREE.DataTexture[] = [];
  /** The sun's colour × intensity, as the light pass counts it. */
  readonly sun = uniform(new THREE.Color(0, 0, 0));
  /** The area lights whose highlights reading pixels draw. */
  readonly highlights = new AreaHighlights();
  /** The lookup's texture node. */
  readonly tableNode: N;
  /**
   * Its header as uniforms (`packSurfaceLookup`'s texels 0 and 1): layers and their records, terrains and theirs; the architecture hash's
   * slots and first slot, model slots and their records.
   */
  readonly head = uniform(new THREE.Vector4());
  readonly arch = uniform(new THREE.Vector4());
  /** The first terrain's rings (centre x, z, half side, texel) and how many: read from uniforms, not the table (most scenes have one terrain). */
  readonly rings0 = uniformArray(Array.from({ length: TERRAIN_RINGS_MAX }, () => new THREE.Vector4()), 'vec4');
  readonly rings0Count = uniform(0, 'int');
  /** The first block layers' records (`LAYER_TEXELS` vec4 each, integers as floats: all are below 2^24): read from uniforms, not the table. */
  readonly layers0 = uniformArray(Array.from({ length: BLOCK_LAYERS_HELD * LAYER_TEXELS }, () => new THREE.Vector4()), 'vec4');

  /** `pages` and `ringLayers`: the most the cache's budget can hold (the colours' buffer is made once for them). */
  constructor(readonly pages: number, readonly ringLayers: number) {
    this.atlas = arrayTexture(SURFACE_PAGE_TEXELS, THREE.ClampToEdgeWrapping, 'surface cache atlas');
    this.rings = arrayTexture(TERRAIN_RING_TEXELS, THREE.RepeatWrapping, 'surface cache rings');
    const words = albedoWords(pages, ringLayers);
    this.albedo = new THREE.StorageBufferAttribute(new Uint32Array(words), 1);
    this.albedoNode = TSL.storage(this.albedo, 'uint', words).toAtomic();
    this.albedoRingsAt = pages * ALBEDO_CELLS;
    this.table = tableTexture(new Uint32Array(LOOKUP_WIDTH * 4 * TABLE_ROWS));
    // Integer texel loads as stored: no uv transform (three's would turn every index into floats and back, a uniform per read).
    this.tableNode = texelTexture(this.table);
  }

  /**
   * New lookup words (a whole number of rows, `packSurfaceLookup`). The
   * texture keeps its rows while they hold the words; when they do not a
   * new one twice as tall takes its place in the lookup's node (an image of
   * another size written into the old one would be lost).
   */
  setTable(words: Uint32Array): void {
    const img = this.table.image as { data: Uint32Array; width: number; height: number };
    if (words.length > img.data.length) {
      let rows = img.height;
      while (rows * LOOKUP_WIDTH * 4 < words.length) rows *= 2;
      const old = this.table;
      this.table = tableTexture(new Uint32Array(rows * LOOKUP_WIDTH * 4));
      // A binding notices a new texture by its version: the new one's starts past the old one's.
      while (this.table.version <= old.version) this.table.needsUpdate = true;
      (this.tableNode as unknown as { value: THREE.Texture }).value = this.table;
      this.retired.push(old);
    }
    const data = (this.table.image as { data: Uint32Array }).data;
    data.set(words);
    (this.head.value as THREE.Vector4).set(words[0]!, words[1]!, words[2]!, words[3]!);
    (this.arch.value as THREE.Vector4).set(words[4]!, words[5]!, words[6]!, words[7]!);
    const f = new Float32Array(words.buffer, words.byteOffset, words.length);
    const rings = (this.rings0 as unknown as { array: THREE.Vector4[] }).array;
    const at = words[3]! * 4;
    const n = words[2]! > 0 ? words[at]! : 0;
    for (let k = 0; k < n; k += 1) rings[k]!.fromArray(f, at + 4 + k * 4);
    (this.rings0Count as unknown as { value: number }).value = n;
    // Block layers' records: floats as floats, integers (signed where they may be negative) as their values.
    const layers = (this.layers0 as unknown as { array: THREE.Vector4[] }).array;
    const i32 = new Int32Array(words.buffer, words.byteOffset, words.length);
    for (let li = 0; li < Math.min(words[0]!, BLOCK_LAYERS_HELD); li += 1) {
      const w = (words[1]! + li * LAYER_TEXELS) * 4;
      const l = li * LAYER_TEXELS;
      layers[l]!.set(f[w]!, f[w + 1]!, f[w + 2]!, words[w + 3]!);
      layers[l + 1]!.set(f[w + 4]!, f[w + 5]!, f[w + 6]!, i32[w + 7]!);
      layers[l + 2]!.set(i32[w + 8]!, i32[w + 9]!, words[w + 10]!, words[w + 11]!);
      layers[l + 3]!.set(i32[w + 12]!, words[w + 13]!, words[w + 14]!, 0);
    }
    data.fill(0, words.length);
    this.table.needsUpdate = true;
  }

  /**
   * The GPU texture behind the atlas or the rings, `layers` deep (three
   * makes it, so materials bind it; the light pass writes it).
   */
  gpuTexture(renderer: unknown, which: 'atlas' | 'rings', layers: number): unknown {
    const t = this[which];
    const img = t.image as { width: number; height: number; depth: number };
    if (img.depth !== layers) t.setSize(img.width, img.height, layers);
    const r = renderer as { initTexture(t: THREE.Texture): void; backend: { get(t: THREE.Texture): { texture?: unknown } } };
    r.initTexture(t);
    return r.backend.get(t).texture;
  }

  /** The GPU buffer behind the surfaces' colours once three made it for the first draw that writes them (null until then: the probes bounce the default). */
  gpuAlbedo(renderer: unknown): unknown {
    const r = renderer as { backend: { get(a: unknown): { buffer?: unknown } } };
    return r.backend.get(this.albedo).buffer ?? null;
  }

  dispose(): void {
    for (const t of [this.atlas, this.rings, this.table, ...this.retired]) t.dispose();
  }
}

function arrayTexture(side: number, wrap: THREE.Wrapping, name: string): THREE.StorageArrayTexture {
  const t = new THREE.StorageArrayTexture(side, side, 1);
  t.type = THREE.HalfFloatType;
  t.format = THREE.RGBAFormat;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = wrap;
  t.wrapT = wrap;
  t.colorSpace = THREE.NoColorSpace;
  t.name = name;
  return t;
}

function tableTexture(data: Uint32Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, LOOKUP_WIDTH, data.length / 4 / LOOKUP_WIDTH, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Whether the cache's light was found at this pixel (0–1: how much of the filtered lookup was lit). */
export const SURFACE_READ_FOUND = property('float', 'tlSurfaceReadFound');
/** The cache's irradiance at this pixel ÷ π, the sun's share out (0 where none was found). */
const SURFACE_READ_IRRADIANCE = property('vec3', 'tlSurfaceReadIrradiance');
/** A reading variant's mark: its programs draw the area lights' highlights (the scene has area lights). */
export const SURFACE_READ_HIGHLIGHTS = 'tlSurfaceReadHighlights';

/** The shader's walk of the lookup's words (`lookupSurfaceCpu`'s twin). */
function lookupNodes(builder: N, tex: SurfaceCacheTextures, kind: SurfaceReadKind): { layer: N; uv: N; found: N; rings: boolean } {
  const table = tex.tableNode;
  const texel = (t: N): N => table.load(ivec2(int(t.mod(uint(LOOKUP_WIDTH))), int(t.div(uint(LOOKUP_WIDTH)))));
  const word = (w: N): N => texel(w.div(uint(4))).element(w.mod(uint(4)));
  const asF = (v: N): N => uintBitsToFloat(v);
  const p = positionWorld;
  const n = normalWorldGeometry;
  const layer = uint(0).toVar('tlCacheLayer');
  const uv = vec2(0).toVar('tlCacheUv');
  const found = bool(false).toVar('tlCacheFound');
  // A chart's place (`c0`) for metres (uu, vv) along its wm × hm, held half a texel inside its interior; the uv on its page.
  const chartAt = (c0: N, uu: N, vv: N, wm: N, hm: N): void => {
    const x0 = float(c0.y.bitAnd(uint(0xffff)));
    const y0 = float(c0.y.shiftRight(uint(16)));
    const iw = float(c0.z.bitAnd(uint(0xffff)));
    const ih = float(c0.z.shiftRight(uint(16)));
    const x = x0.add(clamp(uu.div(wm).mul(iw), float(0.5), iw.sub(0.5)));
    const y = y0.add(clamp(vv.div(hm).mul(ih), float(0.5), ih.sub(0.5)));
    layer.assign(c0.x);
    uv.assign(vec2(x, y).div(SURFACE_PAGE_TEXELS));
    found.assign(true);
  };
  if (kind === SURFACE_READ.blocks) {
    const an = abs(n);
    // Assigned here, at the top: built lazily inside the first layer's branch, the place computed after the layers
    // would read them unset in a pixel whose branch did not run.
    const axis = int(0).toVar('tlBlockAxis');
    axis.assign(select(an.x.greaterThanEqual(an.y).and(an.x.greaterThanEqual(an.z)), int(0), select(an.y.greaterThanEqual(an.z), int(1), int(2))));
    const comp = (v: N, a: N): N => select(a.equal(int(0)), v.x, select(a.equal(int(1)), v.y, v.z));
    const neg = comp(n, axis).lessThan(0);
    const face = uint(0).toVar('tlBlockFace');
    face.assign(uint(axis.mul(2)).add(select(neg, uint(1), uint(0))));
    const sgn = select(neg, float(-1), float(1));
    const axisVec = vec3(0).toVar('tlBlockInset');
    axisVec.assign(vec3(select(axis.equal(int(0)), sgn, float(0)), select(axis.equal(int(1)), sgn, float(0)), select(axis.equal(int(2)), sgn, float(0))));
    // The plane axes of a face on each axis: (z, y), (x, z), (x, y).
    const pu = int(0).toVar('tlBlockPu');
    pu.assign(select(axis.equal(int(0)), int(2), int(0)));
    const pv = int(0).toVar('tlBlockPv');
    pv.assign(select(axis.equal(int(1)), int(2), int(1)));
    // The face's slot once found, and the pixel's place in its layer's cells.
    const got = TSL.uvec4(0).toVar('tlBlockSlot');
    const gq = vec3(0).toVar('tlBlockQ');
    const gcell = TSL.ivec3(0).toVar('tlBlockCell');
    const hit = bool(false).toVar('tlBlockHit');
    // One layer: its cell, its chunk column and the face's key, then its hash from the face's home slot (no table read before
    // it), probing on only while a slot is taken by another face and at most the layer's longest probe (a uniform's bound).
    const walk = (L: { origin: N; size: N; hash: N; y0: N; cx0: N; cz0: N; ncx: N; ncz: N; y1: N; cap: N; probe: N }): void => {
      const q = p.sub(L.origin).div(L.size).sub(axisVec.mul(BLOCK_INSET)).toVar();
      const cell = TSL.ivec3(floor(q)).toVar();
      const cx = cell.x.shiftRight(uint(4));
      const cz = cell.z.shiftRight(uint(4));
      const jx = cx.sub(L.cx0);
      const jz = cz.sub(L.cz0);
      const inside = cell.y.greaterThanEqual(L.y0).and(cell.y.lessThan(L.y1)).and(jx.greaterThanEqual(0)).and(jz.greaterThanEqual(0)).and(jx.lessThan(L.ncx)).and(jz.lessThan(L.ncz)).and(L.cap.notEqual(uint(0)));
      If(inside, () => {
        const j = uint(jz.mul(L.ncx).add(jx)).toVar();
        const lx = uint(cell.x.sub(cx.shiftLeft(uint(4))));
        const lz = uint(cell.z.sub(cz.shiftLeft(uint(4))));
        const key = uint(cell.y.sub(L.y0)).mul(uint(16)).add(lz).mul(uint(16)).add(lx).mul(uint(6)).add(face).toVar();
        const h0 = key.bitXor(j.mul(uint(0x85ebca6b))).mul(uint(0x9e3779b1));
        const s = h0.bitXor(h0.shiftRight(uint(15))).bitAnd(L.cap.sub(uint(1))).toVar();
        const done = bool(false).toVar();
        const look = (): void => {
          const slot = texel(L.hash.add(s));
          If(slot.x.equal(uint(EMPTY)), () => {
            done.assign(true);
          }).ElseIf(slot.x.equal(key).and(slot.y.shiftRight(uint(28)).shiftLeft(uint(16)).bitOr(slot.w.shiftRight(uint(16))).equal(j)), () => {
            done.assign(true);
            hit.assign(true);
            got.assign(slot);
            gq.assign(q);
            gcell.assign(cell);
          });
        };
        look();
        If(done.not().and(L.probe.greaterThan(int(0))), () => {
          Loop(L.probe, () => {
            s.assign(s.add(uint(1)).bitAnd(L.cap.sub(uint(1))));
            look();
            If(done, () => {
              Break();
            });
          });
        });
      });
    };
    const head = tex.head;
    // The first layers from uniforms, unrolled (a uniform array indexed by a loop's counter cost the village ~0.5 ms of GPU).
    for (let li = 0; li < BLOCK_LAYERS_HELD; li += 1) {
      If(hit.not().and(int(head.x).greaterThan(int(li))), () => {
        const [r0, r1, r2, r3] = [0, 1, 2, 3].map((k) => tex.layers0.element(int(li * LAYER_TEXELS + k))) as [N, N, N, N];
        walk({ origin: r0.xyz, size: r1.xyz, hash: uint(r0.w), y0: int(r1.w), cx0: int(r2.x), cz0: int(r2.y), ncx: int(r2.z), ncz: int(r2.w), y1: int(r3.x), cap: uint(r3.y), probe: int(r3.z) });
      });
    }
    // Any more from the table.
    If(hit.not().and(int(head.x).greaterThan(int(BLOCK_LAYERS_HELD))), () => {
      Loop({ start: int(BLOCK_LAYERS_HELD), end: int(head.x) }, ({ i }: { i: N }) => {
        const at = uint(head.y).add(uint(i).mul(uint(LAYER_TEXELS)));
        const r0 = texel(at);
        const r1 = texel(at.add(uint(1)));
        const r2 = texel(at.add(uint(2)));
        const r3 = texel(at.add(uint(3)));
        walk({ origin: asF(r0).xyz, size: asF(r1).xyz, hash: r0.w, y0: asI(r1.w), cx0: asI(r2.x), cz0: asI(r2.y), ncx: asI(r2.z), ncz: asI(r2.w), y1: asI(r3.x), cap: r3.y, probe: asI(r3.z) });
        If(hit, () => {
          Break();
        });
      });
    });
    // The slot holds the chart's place: page | corner, its texels and the face's cell in it, its cells (0: not on a page).
    If(hit.and(got.w.bitAnd(uint(0xffff)).notEqual(uint(0))), () => {
      const fu = clamp(comp(gq, pu).sub(float(comp(gcell, pu))), float(0), float(1));
      const fv = clamp(comp(gq, pv).sub(float(comp(gcell, pv))), float(0), float(1));
      const iw = float(got.z.bitAnd(uint(255)));
      const ih = float(got.z.shiftRight(uint(8)).bitAnd(uint(255)));
      const ou = float(got.z.shiftRight(uint(16)).bitAnd(uint(255)));
      const ov = float(got.z.shiftRight(uint(24)));
      const wc = float(got.w.bitAnd(uint(255)));
      const hc = float(got.w.shiftRight(uint(8)).bitAnd(uint(255)));
      const x = float(got.y.shiftRight(uint(12)).bitAnd(uint(255))).add(clamp(ou.add(fu).div(wc).mul(iw), float(0.5), iw.sub(0.5)));
      const y = float(got.y.shiftRight(uint(20)).bitAnd(uint(255))).add(clamp(ov.add(fv).div(hc).mul(ih), float(0.5), ih.sub(0.5)));
      layer.assign(got.y.bitAnd(uint(0xfff)));
      uv.assign(vec2(x, y).div(SURFACE_PAGE_TEXELS));
      found.assign(true);
    });
    return { layer, uv, found, rings: false };
  }
  if (kind === SURFACE_READ.terrain) {
    // The first terrain's rings from uniforms; any others from the table.
    const ringAt = (r: N, base: N, k: N): void => {
      const half = r.z.sub(r.w);
      If(abs(p.x.sub(r.x)).lessThanEqual(half).and(abs(p.z.sub(r.y)).lessThanEqual(half)), () => {
        layer.assign(base.add(uint(k)));
        uv.assign(vec2(p.x, p.z).div(r.w).div(TERRAIN_RING_TEXELS));
        found.assign(true);
        Break();
      });
    };
    Loop(tex.rings0Count, ({ i: k }: { i: N }) => {
      ringAt(tex.rings0.element(k), uint(0), k);
    });
    Loop({ start: int(1), end: int(tex.head.z) }, ({ i }: { i: N }) => {
      If(found, () => {
        Break();
      });
      const at = uint(tex.head.w).add(uint(i).mul(uint(TERRAIN_TEXELS)));
      const t0 = texel(at);
      Loop(int(t0.x), ({ i: k }: { i: N }) => {
        ringAt(asF(texel(at.add(uint(1)).add(uint(k)))), t0.y, k);
      });
    });
    return { layer, uv, found, rings: true };
  }
  if (kind === SURFACE_READ.model) {
    modelLookup(builder, tex, texel, layer, uv, found);
    return { layer, uv, found, rings: false };
  }
  // Architecture: the world cell's list of charts that face the pixel's way, the first whose plane and rectangle hold it.
  const h1 = TSL.uvec4(tex.arch);
  const c = TSL.ivec3(floor(p.div(ARCH_CELL)));
  const zf = c.z.mul(int(8)).add(int(facingNode(n)));
  const cap = h1.x;
  const s = uint(c.x).mul(uint(73856093)).bitXor(uint(c.y).mul(uint(19349663))).bitXor(uint(zf).mul(uint(83492791))).bitAnd(cap.sub(uint(1))).toVar();
  Loop(int(cap), () => {
    const slot = texel(h1.y.add(s));
    If(slot.w.equal(uint(0)), () => {
      Break();
    });
    If(TSL.ivec3(asI(slot.x), asI(slot.y), asI(slot.z)).equal(TSL.ivec3(c.x, c.y, zf)).all(), () => {
      const list = slot.w;
      Loop(int(word(list.mul(uint(4)))), ({ i }: { i: N }) => {
        const fa = word(list.mul(uint(4)).add(uint(1)).add(uint(i)));
        // The frame and its chart's place read together (no load waits on another).
        const f0 = asF(texel(fa));
        const f1 = asF(texel(fa.add(uint(1))));
        const f2 = asF(texel(fa.add(uint(2))));
        const c0 = texel(fa.add(uint(3)));
        const d = p.sub(f0.xyz);
        const nn = cross(f1.xyz, f2.xyz);
        const uu = dot(d, f1.xyz);
        const vv = dot(d, f2.xyz);
        const on = abs(dot(d, nn)).lessThanEqual(ARCH_PLANE_METRES).and(dot(n, nn).greaterThanEqual(ARCH_FACING));
        const within = uu.greaterThanEqual(-ARCH_PLANE_METRES).and(vv.greaterThanEqual(-ARCH_PLANE_METRES)).and(uu.lessThanEqual(f0.w.add(ARCH_PLANE_METRES))).and(vv.lessThanEqual(f1.w.add(ARCH_PLANE_METRES)));
        If(on.and(within), () => {
          chartAt(c0, uu, vv, f0.w, f1.w);
          Break();
        });
      });
      Break();
    });
    s.assign(s.add(uint(1)).bitAnd(cap.sub(uint(1))));
  });
  return { layer, uv, found, rings: false };
}

/** A normal's facing (its major axis × 2, + 1 along −axis), as `facingOf`. */
function facingNode(n: N): N {
  const an = abs(n);
  const axis = select(an.x.greaterThanEqual(an.y).and(an.x.greaterThanEqual(an.z)), uint(0), select(an.y.greaterThanEqual(an.z), uint(1), uint(2)));
  const comp = select(axis.equal(uint(0)), n.x, select(axis.equal(uint(1)), n.y, n.z));
  return axis.mul(uint(2)).add(select(comp.lessThan(0), uint(1), uint(0)));
}

/** A per-object uniform: the drawn object's slot (an object drawn alone). */
const objectSlot = uniform(0, 'float').onObjectUpdate(({ object }: { object: THREE.Object3D }) => surfaceSlotOf(object));

/** The drawn copy's slot (vertex stage): a merged cell's per-vertex slot, an instanced draw's column, else the object's own. */
const copySlot = Fn((builder: N) => {
  const g = builder.geometry as THREE.BufferGeometry | undefined;
  if (g?.getAttribute?.(SURFACE_SLOT_ATTRIBUTE) !== undefined) return attribute(SURFACE_SLOT_ATTRIBUTE, 'float');
  // An instanced draw's slot rides in its columns (`SURFACE_SLOT_FLOAT`: the third column's w).
  if (buildReadsCopyColumns(builder)) return (instanceColumn(2) as N).w;
  return objectSlot;
});

/**
 * A model pixel's place (`lookupModelCpu`'s twin). The copy's slot is where
 * its record is; the vertex stage reads the record and passes on what a
 * pixel needs: its point in the piece's surfel cells (from the cells'
 * origin) and its normal in the model's root (both affine in the vertex, so
 * exact when interpolated), and, flat, the piece's hash, buckets, chart and
 * kind. A pixel then reads only its surfel buckets (a UV1 piece nothing
 * before the sample): no texel a pixel reads waits on another. A UV1 piece
 * is read at the pixel's UV1; a piece on surfels at the surfel of the
 * pixel's cell and facing: its home bucket and the next (two texels), then,
 * on a miss, the cell across the nearer boundary along its normal. No loop:
 * on the Iris Xe a hash walked in a loop of the texels' count stalled the
 * GPU (a draw without side effects kept looping where the same program with
 * a storage write did not).
 */
function modelLookup(builder: N, tex: SurfaceCacheTextures, texel: (t: N) => N, layer: N, uv: N, found: N): void {
  const asF = (v: N): N => uintBitsToFloat(v);
  const hasUv1 = (builder.geometry as THREE.BufferGeometry | undefined)?.getAttribute?.('uv1') !== undefined;
  const h1 = TSL.uvec4(tex.arch);
  // Vertex stage: the copy's slot and its record.
  const slot = uint(copySlot());
  const live = slot.greaterThan(uint(0)).and(slot.lessThan(h1.z));
  const rec = h1.w.add(select(live, slot, uint(0)).mul(uint(SLOT_TEXELS)));
  const r0 = asF(texel(rec));
  const r1 = asF(texel(rec.add(uint(1))));
  const r2 = asF(texel(rec.add(uint(2))));
  const r3 = texel(rec.add(uint(3)));
  const r4 = asF(texel(rec.add(uint(4))));
  const r5 = asF(texel(rec.add(uint(5))));
  const a = texel(rec.add(uint(6)));
  const ch = texel(rec.add(uint(7)));
  const origin = vec3(TSL.ivec3(texel(rec.add(uint(8))).xyz));
  const wp = positionWorld;
  const wn = normalWorldGeometry;
  const cellPoint = vec3(dot(r0.xyz, wp).add(r0.w), dot(r1.xyz, wp).add(r1.w), dot(r2.xyz, wp).add(r2.w)).div(asF(a.x)).sub(origin);
  const rootNormal = vec3(dot(asF(r3).xyz, wn), dot(r4.xyz, wn), dot(r5.xyz, wn));
  // What a pixel reads, passed on (a few varyings: a draw's are limited).
  const qp = varying(cellPoint, 'tlSurfaceCellPoint');
  const ln = varying(rootNormal, 'tlSurfaceRootNormal');
  const piece = varying(TSL.uvec4(a.y, a.z, ch.y, ch.z), 'tlSurfacePiece');
  // The page, and whether the slot holds a piece (bit 0) read at its UV1 (bit 1).
  const kindPage = varying(select(live.and(r3.w.equal(uint(1))), uint(1), uint(0)).bitOr(select(a.w.equal(uint(1)), uint(2), uint(0))).bitOr(ch.x.shiftLeft(uint(2))), 'tlSurfacePiecePage');
  const has = kindPage.bitAnd(uint(1)).equal(uint(1));
  const page = kindPage.shiftRight(uint(2));
  const x0 = piece.z.bitAnd(uint(0xffff));
  const y0 = piece.z.shiftRight(uint(16));
  const w = piece.w.bitAnd(uint(0xffff));
  const h = piece.w.shiftRight(uint(16));
  If(has.and(kindPage.bitAnd(uint(2)).notEqual(uint(0))), () => {
    if (!hasUv1) return;
    const t = uvOf(1);
    layer.assign(page);
    uv.assign(vec2(float(x0).add(clamp(t.x.mul(float(w)), float(0.5), float(w).sub(0.5))), float(y0).add(clamp(t.y.mul(float(h)), float(0.5), float(h).sub(0.5)))).div(SURFACE_PAGE_TEXELS));
    found.assign(true);
  }).ElseIf(has, () => {
    const facing = facingNode(ln).toVar('tlSurfaceFacing');
    const cc = TSL.ivec3(floor(qp)).toVar();
    const index = int(-1).toVar();
    // The cell's two buckets (four slots); a key out of range has no surfel.
    const probe = (): void => {
      const lim = int(1 << SURFEL_KEY_BITS);
      If(cc.greaterThanEqual(TSL.ivec3(0)).all().and(cc.lessThan(TSL.ivec3(lim)).all()), () => {
        const key = uint(cc.x).bitOr(uint(cc.y).shiftLeft(uint(SURFEL_KEY_BITS))).bitOr(uint(cc.z).shiftLeft(uint(2 * SURFEL_KEY_BITS)));
        const h0 = key.mul(uint(0x9e3779b1)).bitXor(facing.add(uint(1)).mul(uint(0x85ebca6b))).toVar();
        h0.assign(h0.bitXor(h0.shiftRight(uint(16))).mul(uint(0x7feb352d)));
        const home = h0.bitXor(h0.shiftRight(uint(15))).bitAnd(piece.y.sub(uint(1)));
        const b0 = texel(piece.x.add(home));
        const b1 = texel(piece.x.add(home.add(uint(1)).bitAnd(piece.y.sub(uint(1)))));
        const hit = (k: N, v: N): void => {
          If(index.lessThan(int(0)).and(v.notEqual(uint(EMPTY))).and(k.equal(key)).and(v.bitAnd(uint(7)).equal(facing)), () => {
            index.assign(int(v.shiftRight(uint(3))));
          });
        };
        hit(b0.x, b0.y);
        hit(b0.z, b0.w);
        hit(b1.x, b1.y);
        hit(b1.z, b1.w);
      });
    };
    probe();
    // A face on a cell boundary has its surfels on either side of it: the cell across the nearer boundary along its normal.
    If(index.lessThan(int(0)), () => {
      const axis = facing.shiftRight(uint(1));
      const q = select(axis.equal(uint(0)), qp.x, select(axis.equal(uint(1)), qp.y, qp.z));
      const step = select(q.sub(floor(q)).lessThan(0.5), int(-1), int(1));
      cc.assign(cc.add(TSL.ivec3(select(axis.equal(uint(0)), step, int(0)), select(axis.equal(uint(1)), step, int(0)), select(axis.equal(uint(2)), step, int(0)))));
      probe();
    });
    If(index.greaterThanEqual(int(0)), () => {
      const ui = uint(index);
      layer.assign(page);
      uv.assign(vec2(float(x0.add(ui.mod(w))).add(0.5), float(y0.add(ui.div(w))).add(0.5)).div(SURFACE_PAGE_TEXELS));
      found.assign(true);
    });
  });
}

const asI = (v: N): N => TSL.int(v);

/**
 * The cache's light at this pixel (built before the local lights, in a
 * reading build's lights node): its direct diffuse light, the sun's share
 * taken out, and `SURFACE_READ_FOUND` set.
 */
export class SurfaceReadLightNode extends (THREE.LightingNode as unknown as new () => { [k: string]: unknown }) {
  static get type(): string {
    return 'SurfaceReadLightNode';
  }
  readonly isSurfaceReadLightNode = true;
  constructor(private readonly tex: SurfaceCacheTextures, private readonly kind: SurfaceReadKind) {
    super();
  }
  setup(builder: N): null {
    const { layer, uv, found, rings } = lookupNodes(builder, this.tex, this.kind);
    const map = texture(rings ? this.tex.rings : this.tex.atlas, uv).depth(layer).level(float(0));
    const t = select(found, map, TSL.vec4(0));
    // Alpha: 0 where nothing is lit, 1 + the sun's share where it is (a filtered lookup blends the two).
    const lit = clamp(t.w, float(0), float(SURFACE_TEXEL_LIT));
    const sunShare = max(t.w.sub(SURFACE_TEXEL_LIT), float(0));
    const irr = max(t.xyz.sub(vec3(this.tex.sun).mul(sunShare)), vec3(0));
    SURFACE_READ_FOUND.assign(lit);
    SURFACE_READ_IRRADIANCE.assign(irr.mul(1 / Math.PI));
    // The surface's own colour where it read (what its light bounces as), written as it draws on a capture frame.
    if (builder.material?.[SURFACE_READ_CAPTURE] === true) If(found, () => {
      const c = clamp(TSL.diffuseColor.rgb, vec3(0), vec3(1)).mul(255).round();
      const word = uint(c.x).bitOr(uint(c.y).shiftLeft(uint(8))).bitOr(uint(c.z).shiftLeft(uint(16))).bitOr(uint(255 << 24 >>> 0));
      const step = rings ? ALBEDO_RING_STEP : ALBEDO_PAGE_STEP;
      const size = rings ? TERRAIN_RING_TEXELS : SURFACE_PAGE_TEXELS;
      const at = TSL.uvec2(floor(uv.mul(size)).mod(size).div(step));
      const base = uint(rings ? this.tex.albedoRingsAt : 0).add(layer.mul(uint(ALBEDO_CELLS)));
      TSL.atomicStore(this.tex.albedoNode.element(base.add(at.y.mul(uint(size / step))).add(at.x)), word);
    });
    const ctx = builder.context;
    if (builder.material?.isMeshCustomLitNodeMaterial === true) LIT.direct.addAssign(irr.mul(1 / Math.PI));
    else ctx.reflectedLight.directDiffuse.addAssign(irr.mul(TSL.diffuseColor.rgb).mul(1 / Math.PI));
    return null;
  }
}

const readNodes = new WeakMap<SurfaceCacheTextures, Map<number, unknown>>();

/** The lights a reading build adds: the cache's light (one node a kind per textures, so programs are shared). */
export function surfaceReadNode(tex: SurfaceCacheTextures, kind: SurfaceReadKind): SurfaceReadLightNode {
  let m = readNodes.get(tex);
  if (m === undefined) readNodes.set(tex, (m = new Map()));
  let node = m.get(kind) as SurfaceReadLightNode | undefined;
  if (node === undefined) m.set(kind, (node = new SurfaceReadLightNode(tex, kind)));
  return node;
}

/**
 * In a reading build's lights node: the cache's light first, then every
 * other light; the local lights' diffuse light (the cache holds it) is put
 * back to what it was before them where the cache was found, their
 * highlights kept, and the area lights' highlights added
 * (`surface-highlights.ts`), every highlight scaled by the share of those
 * lights the cache's texel sees.
 */
export function buildReadLights(builder: N, nodes: readonly { light?: THREE.Light; build(b: unknown): unknown }[], isLocal: (l: THREE.Light | undefined) => boolean): void {
  const kind = buildSurfaceRead(builder) as SurfaceReadKind;
  const material = builder.material as Record<string, unknown> | undefined;
  const tex = (material?.[SURFACE_READ_TEXTURES] as SurfaceCacheTextures | null | undefined) ?? undefined;
  if (tex === undefined) {
    for (const n of nodes) n.build(builder);
    return;
  }
  (surfaceReadNode(tex, kind) as unknown as { build(b: unknown): unknown }).build(builder);
  const local = nodes.filter((n) => isLocal(n.light));
  for (const n of nodes) if (!local.includes(n)) n.build(builder);
  const highlights = buildsHighlights(builder);
  const area = highlights && material?.[SURFACE_READ_HIGHLIGHTS] === true;
  if (local.length === 0 && !area) return;
  const custom = builder.material?.isMeshCustomLitNodeMaterial === true;
  const sink = custom ? LIT.direct : builder.context.reflectedLight.directDiffuse;
  const before = vec3(sink).toVar('tlSurfaceReadBefore');
  const specular = builder.context.reflectedLight.directSpecular;
  const specBefore = vec3(specular).toVar('tlSurfaceReadSpecBefore');
  for (const n of local) n.build(builder);
  if (highlights) {
    const a = area ? areaHighlightNodes(builder, tex.highlights) : null;
    const visible = cacheVisibility(SURFACE_READ_IRRADIANCE, a?.irradiance ?? vec3(0), vec3(sink).sub(before), TSL.diffuseContribution).toVar('tlSurfaceReadVisible');
    // Where nothing was found the per-pixel lights keep their own highlights, and area lights (cache light only) none.
    const share = mix(float(1), visible, SURFACE_READ_FOUND);
    specular.assign(specBefore.add(vec3(specular).sub(specBefore).mul(share)));
    if (a !== null) specular.addAssign(a.specular.mul(visible).mul(SURFACE_READ_FOUND));
  }
  sink.assign(mix(sink, before, SURFACE_READ_FOUND));
}
