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
import { ALBEDO_CELLS, ALBEDO_PAGE_STEP, ALBEDO_RING_STEP, albedoWords, ARCH_CELL, ARCH_FACING, ARCH_PLANE_METRES, BLOCK_INSET, EMPTY, LAYER_TEXELS, LOOKUP_WIDTH, MODEL_TEXELS, PIECE_TEXELS, SURFACE_READ, TERRAIN_TEXELS, type SurfaceReadKind } from './surface-cache-lookup';
import { TERRAIN_RING_TEXELS, TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import { SURFACE_TEXEL_LIT } from './surface-light-wgsl';
import { texelTexture } from './texel-texture-node';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, Fn, If, Loop, abs, attribute, bool, clamp, cross, dot, float, floor, int, ivec2, max, mix, normalWorldGeometry, positionWorld, property, select, texture, uint, uintBitsToFloat, uniform, uniformArray, uv: uvOf, varying, vec2, vec3 } = TSL;

/** Rows of the lookup texture at first (it doubles when a scene's lookup outgrows it). */
const TABLE_ROWS = 16;

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
  return kind === 0 ? null : { kind, textures, capture: textures.capture };
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
  /** The lookup's texture node. */
  readonly tableNode: N;
  /** Its header as uniforms (`packSurfaceLookup`'s texels 0 and 1): layers and their records, terrains and theirs; the architecture hash's slots and first slot. */
  readonly head = uniform(new THREE.Vector4());
  readonly arch = uniform(new THREE.Vector4());
  /** The first terrain's rings (centre x, z, half side, texel) and how many: read from uniforms, not the table (most scenes have one terrain). */
  readonly rings0 = uniformArray(Array.from({ length: TERRAIN_RINGS_MAX }, () => new THREE.Vector4()), 'vec4');
  readonly rings0Count = uniform(0, 'int');

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
    const axis = select(an.x.greaterThanEqual(an.y).and(an.x.greaterThanEqual(an.z)), int(0), select(an.y.greaterThanEqual(an.z), int(1), int(2)));
    const comp = (v: N, a: N): N => select(a.equal(int(0)), v.x, select(a.equal(int(1)), v.y, v.z));
    const neg = comp(n, axis).lessThan(0);
    const face = uint(axis.mul(2)).add(select(neg, uint(1), uint(0)));
    const sgn = select(neg, float(-1), float(1));
    // The plane axes of a face on each axis: (z, y), (x, z), (x, y).
    const pu = select(axis.equal(int(0)), int(2), int(0));
    const pv = select(axis.equal(int(1)), int(2), int(1));
    const head = tex.head;
    Loop(int(head.x), ({ i }: { i: N }) => {
      const at = uint(head.y).add(uint(i).mul(uint(LAYER_TEXELS)));
      const r0 = texel(at);
      const r1 = texel(at.add(uint(1)));
      const r2 = texel(at.add(uint(2)));
      const origin = asF(r0).xyz;
      const size = asF(r1).xyz;
      const axisVec = vec3(select(axis.equal(int(0)), sgn, float(0)), select(axis.equal(int(1)), sgn, float(0)), select(axis.equal(int(2)), sgn, float(0)));
      const q = p.sub(origin).div(size).sub(axisVec.mul(BLOCK_INSET)).toVar();
      const cell = TSL.ivec3(floor(q)).toVar();
      const y0 = asI(r1.w);
      const cx = cell.x.shiftRight(uint(4));
      const cz = cell.z.shiftRight(uint(4));
      const jx = cx.sub(asI(r2.x));
      const jz = cz.sub(asI(r2.y));
      const ncx = asI(r2.z.bitAnd(uint(0xffff)));
      const ncz = asI(r2.z.shiftRight(uint(16)));
      const inside = cell.y.greaterThanEqual(y0).and(cell.y.lessThan(asI(r2.w))).and(jx.greaterThanEqual(0)).and(jz.greaterThanEqual(0)).and(jx.lessThan(ncx)).and(jz.lessThan(ncz));
      If(inside, () => {
        const col = texel(r0.w.add(uint(jz.mul(ncx).add(jx))));
        const cap = col.y;
        If(cap.notEqual(uint(0)), () => {
          const lx = uint(cell.x.sub(cx.shiftLeft(uint(4))));
          const lz = uint(cell.z.sub(cz.shiftLeft(uint(4))));
          const key = uint(cell.y.sub(y0)).mul(uint(16)).add(lz).mul(uint(16)).add(lx).mul(uint(6)).add(face).toVar();
          const h0 = key.mul(uint(0x9e3779b1));
          const s = h0.bitXor(h0.shiftRight(uint(15))).bitAnd(cap.sub(uint(1))).toVar();
          Loop(int(cap), () => {
            const slot = texel(col.x.add(s));
            If(slot.x.equal(uint(EMPTY)), () => {
              Break();
            });
            If(slot.x.equal(key), () => {
              // The slot holds the chart's place: page | corner, its texels and the face's cell in it, its cells.
              const fu = clamp(comp(q, pu).sub(float(comp(cell, pu))), float(0), float(1));
              const fv = clamp(comp(q, pv).sub(float(comp(cell, pv))), float(0), float(1));
              const iw = float(slot.z.bitAnd(uint(255)));
              const ih = float(slot.z.shiftRight(uint(8)).bitAnd(uint(255)));
              const ou = float(slot.z.shiftRight(uint(16)).bitAnd(uint(255)));
              const ov = float(slot.z.shiftRight(uint(24)));
              const wc = float(slot.w.bitAnd(uint(255)));
              const hc = float(slot.w.shiftRight(uint(8)).bitAnd(uint(255)));
              const x = float(slot.y.shiftRight(uint(12)).bitAnd(uint(255))).add(clamp(ou.add(fu).div(wc).mul(iw), float(0.5), iw.sub(0.5)));
              const y = float(slot.y.shiftRight(uint(20)).bitAnd(uint(255))).add(clamp(ov.add(fv).div(hc).mul(ih), float(0.5), ih.sub(0.5)));
              layer.assign(slot.y.bitAnd(uint(0xfff)));
              uv.assign(vec2(x, y).div(SURFACE_PAGE_TEXELS));
              found.assign(true);
              Break();
            });
            s.assign(s.add(uint(1)).bitAnd(cap.sub(uint(1))));
          });
        });
      });
      If(found, () => {
        Break();
      });
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
 * A model pixel's place (`lookupModelCpu`'s twin). Per vertex, the copy's
 * slot names its record (passed on flat); the pixel takes its point and
 * normal into the model's root, then the first piece holding a surfel in its
 * cell and facing (a lone UV1 piece needs none) and reads that surfel's
 * texel, or its UV1 in the piece's square.
 */
function modelLookup(builder: N, tex: SurfaceCacheTextures, texel: (t: N) => N, layer: N, uv: N, found: N): void {
  const asF = (v: N): N => uintBitsToFloat(v);
  const hasUv1 = (builder.geometry as THREE.BufferGeometry | undefined)?.getAttribute?.('uv1') !== undefined;
  const h1 = TSL.uvec4(tex.arch);
  // Vertex stage: the copy's slot, passed on flat (one varying: a draw's varyings are few; the table is read per pixel only).
  const slot = varying(uint(copySlot()), 'tlSurfaceCopySlot');
  const rec = select(slot.greaterThan(uint(0)).and(slot.lessThan(h1.z)), texel(h1.w.add(slot)).x, uint(0)).toVar('tlSurfaceRecord');
  // The point and its normal in the model's root; the record's six texels are read together.
  const r0 = asF(texel(rec));
  const r1 = asF(texel(rec.add(uint(1))));
  const r2 = asF(texel(rec.add(uint(2))));
  const r3 = texel(rec.add(uint(3)));
  const r4 = asF(texel(rec.add(uint(4))));
  const r5 = asF(texel(rec.add(uint(5))));
  const wp = positionWorld;
  const wn = normalWorldGeometry;
  const lp = vec3(dot(r0.xyz, wp).add(r0.w), dot(r1.xyz, wp).add(r1.w), dot(r2.xyz, wp).add(r2.w)).toVar('tlSurfaceRootPosition');
  const ln = vec3(dot(asF(r3).xyz, wn), dot(r4.xyz, wn), dot(r5.xyz, wn)).toVar('tlSurfaceRootNormal');
  const pieces = select(rec.equal(uint(0)), uint(0), r3.w).toVar('tlSurfacePieces');
  // The first piece that holds it.
  const facing = facingNode(ln).toVar('tlSurfaceFacing');
  Loop(int(pieces), ({ i }: { i: N }) => {
    const pa = rec.add(uint(MODEL_TEXELS)).add(uint(i).mul(uint(PIECE_TEXELS)));
    const a = texel(pa);
    const ch = texel(pa.add(uint(1)));
    const isUv1 = a.w.equal(uint(1));
    const index = int(-1).toVar();
    If(isUv1.and(pieces.equal(uint(1))).not(), () => {
      const qp = lp.div(asF(a.x)).toVar();
      const cc = TSL.ivec3(floor(qp)).toVar();
      const probe = (): void => {
        const cap = a.z;
        const q = uint(cc.x).mul(uint(73856093)).bitXor(uint(cc.y).mul(uint(19349663))).bitXor(uint(cc.z).mul(uint(83492791))).bitXor(facing.mul(uint(0x9e3779b1))).bitAnd(cap.sub(uint(1))).toVar();
        Loop(int(cap), () => {
          const hs = texel(a.y.add(q));
          If(hs.w.equal(uint(EMPTY)), () => {
            Break();
          });
          If(hs.w.bitAnd(uint(7)).equal(facing).and(TSL.ivec3(asI(hs.x), asI(hs.y), asI(hs.z)).equal(cc).all()), () => {
            index.assign(int(hs.w.shiftRight(uint(3))));
            Break();
          });
          q.assign(q.add(uint(1)).bitAnd(cap.sub(uint(1))));
        });
      };
      probe();
      // A face on a cell boundary has its surfels on either side of it: the cell across the nearer boundary along its normal.
      If(index.lessThan(int(0)), () => {
        const axis = facing.shiftRight(uint(1));
        const fr = select(axis.equal(uint(0)), qp.x.sub(float(cc.x)), select(axis.equal(uint(1)), qp.y.sub(float(cc.y)), qp.z.sub(float(cc.z))));
        const step = select(fr.lessThan(0.5), int(-1), int(1));
        cc.assign(cc.add(TSL.ivec3(select(axis.equal(uint(0)), step, int(0)), select(axis.equal(uint(1)), step, int(0)), select(axis.equal(uint(2)), step, int(0)))));
        probe();
      });
    });
    If(isUv1.and(pieces.equal(uint(1)).or(index.greaterThanEqual(int(0)))), () => {
      if (hasUv1) {
        const x0 = float(ch.y.bitAnd(uint(0xffff)));
        const y0 = float(ch.y.shiftRight(uint(16)));
        const w = float(ch.z.bitAnd(uint(0xffff)));
        const h = float(ch.z.shiftRight(uint(16)));
        const t = uvOf(1);
        layer.assign(ch.x);
        uv.assign(vec2(x0.add(clamp(t.x.mul(w), float(0.5), w.sub(0.5))), y0.add(clamp(t.y.mul(h), float(0.5), h.sub(0.5)))).div(SURFACE_PAGE_TEXELS));
        found.assign(true);
      }
      Break();
    });
    If(index.greaterThanEqual(int(0)), () => {
      const w = ch.z.bitAnd(uint(0xffff));
      const ui = uint(index);
      const x = float(ch.y.bitAnd(uint(0xffff)).add(ui.mod(w))).add(0.5);
      const y = float(ch.y.shiftRight(uint(16)).add(ui.div(w))).add(0.5);
      layer.assign(ch.x);
      uv.assign(vec2(x, y).div(SURFACE_PAGE_TEXELS));
      found.assign(true);
      Break();
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
 * highlights kept.
 */
export function buildReadLights(builder: N, nodes: readonly { light?: THREE.Light; build(b: unknown): unknown }[], isLocal: (l: THREE.Light | undefined) => boolean): void {
  const kind = buildSurfaceRead(builder) as SurfaceReadKind;
  const tex = (builder.material as Record<string, unknown> | undefined)?.[SURFACE_READ_TEXTURES] as SurfaceCacheTextures | undefined;
  if (tex === undefined) {
    for (const n of nodes) n.build(builder);
    return;
  }
  (surfaceReadNode(tex, kind) as unknown as { build(b: unknown): unknown }).build(builder);
  const local = nodes.filter((n) => isLocal(n.light));
  for (const n of nodes) if (!local.includes(n)) n.build(builder);
  if (local.length === 0) return;
  const custom = builder.material?.isMeshCustomLitNodeMaterial === true;
  const sink = custom ? LIT.direct : builder.context.reflectedLight.directDiffuse;
  const before = vec3(sink).toVar('tlSurfaceReadBefore');
  for (const n of local) n.build(builder);
  sink.assign(mix(sink, before, SURFACE_READ_FOUND));
}
