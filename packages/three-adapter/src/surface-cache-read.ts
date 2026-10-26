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
import { ALBEDO_CELLS, ALBEDO_PAGE_STEP, ALBEDO_RING_STEP, albedoWords, ARCH_CELL, ARCH_FACING, ARCH_PLANE_METRES, BLOCK_INSET, CHART_TEXELS, EMPTY, FRAME_TEXELS, LAYER_TEXELS, LOOKUP_WIDTH, SURFACE_READ, TERRAIN_TEXELS, type SurfaceReadKind } from './surface-cache-lookup';
import { TERRAIN_RING_TEXELS } from './surface-cache-terrain';
import { SURFACE_TEXEL_LIT } from './surface-light-wgsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, If, Loop, abs, bool, clamp, cross, dot, float, floor, int, ivec2, max, mix, normalWorldGeometry, positionWorld, property, select, texture, textureLoad, uint, uintBitsToFloat, uniform, vec2, vec3 } = TSL;

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

/** Put the kind on every mesh under `root` (undefined: none). */
export function markSurfaceRead(root: THREE.Object3D, kind: SurfaceReadKind | undefined): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true) return;
    if (kind === undefined) delete o.userData[SURFACE_READ_KEY];
    else o.userData[SURFACE_READ_KEY] = kind;
  });
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
  readonly table: THREE.DataTexture;
  /** The sun's colour × intensity, as the light pass counts it. */
  readonly sun = uniform(new THREE.Color(0, 0, 0));
  /** The lookup's texture node. */
  readonly tableNode: N;
  /** Its header as uniforms (`packSurfaceLookup`'s texels 0 and 1): layers and their records, terrains and theirs; the architecture hash's slots and first slot. */
  readonly head = uniform(new THREE.Vector4());
  readonly arch = uniform(new THREE.Vector2());

  /** `pages` and `ringLayers`: the most the cache's budget can hold (the colours' buffer is made once for them). */
  constructor(readonly pages: number, readonly ringLayers: number) {
    this.atlas = arrayTexture(SURFACE_PAGE_TEXELS, THREE.ClampToEdgeWrapping, 'surface cache atlas');
    this.rings = arrayTexture(TERRAIN_RING_TEXELS, THREE.RepeatWrapping, 'surface cache rings');
    const words = albedoWords(pages, ringLayers);
    this.albedo = new THREE.StorageBufferAttribute(new Uint32Array(words), 1);
    this.albedoNode = TSL.storage(this.albedo, 'uint', words).toAtomic();
    this.albedoRingsAt = pages * ALBEDO_CELLS;
    this.table = tableTexture(new Uint32Array(LOOKUP_WIDTH * 4 * TABLE_ROWS));
    // Integer texel loads: no uv transform (a texture's matrix would turn every index into floats and back).
    this.tableNode = textureLoad(this.table).setUpdateMatrix(false);
  }

  /**
   * New lookup words (a whole number of rows, `packSurfaceLookup`). The
   * texture keeps its rows while they hold the words; when they do not it is
   * let go and made again twice as tall (three re-creates a disposed
   * texture and the bindings that held it; an image of another size written
   * into the old one would be lost).
   */
  setTable(words: Uint32Array): void {
    const img = this.table.image as { data: Uint32Array; width: number; height: number };
    if (words.length > img.data.length) {
      let rows = img.height;
      while (rows * LOOKUP_WIDTH * 4 < words.length) rows *= 2;
      this.table.dispose();
      this.table.image = { data: new Uint32Array(rows * LOOKUP_WIDTH * 4), width: LOOKUP_WIDTH, height: rows };
    }
    const data = (this.table.image as { data: Uint32Array }).data;
    data.set(words);
    (this.head.value as THREE.Vector4).set(words[0]!, words[1]!, words[2]!, words[3]!);
    (this.arch.value as THREE.Vector2).set(words[4]!, words[5]!);
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
    for (const t of [this.atlas, this.rings, this.table]) t.dispose();
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
function lookupNodes(tex: SurfaceCacheTextures, kind: SurfaceReadKind): { layer: N; uv: N; found: N; rings: boolean } {
  const table = tex.tableNode;
  const texel = (t: N): N => table.load(ivec2(int(t.mod(uint(LOOKUP_WIDTH))), int(t.div(uint(LOOKUP_WIDTH)))));
  const word = (w: N): N => texel(w.div(uint(4))).element(w.mod(uint(4)));
  const asF = (v: N): N => uintBitsToFloat(v);
  const asI = (v: N): N => TSL.int(v);
  const p = positionWorld;
  const n = normalWorldGeometry;
  const layer = uint(0).toVar('tlCacheLayer');
  const uv = vec2(0).toVar('tlCacheUv');
  const found = bool(false).toVar('tlCacheFound');
  // A chart record's place for metres (uu, vv), held half a texel inside its interior; the uv on its page.
  const chartAt = (at: N, uu: N, vv: N): void => {
    const c0 = texel(at);
    const c1 = asF(texel(at.add(uint(1))));
    const x0 = float(c0.y.bitAnd(uint(0xffff)));
    const y0 = float(c0.y.shiftRight(uint(16)));
    const iw = float(c0.z.bitAnd(uint(0xffff)));
    const ih = float(c0.z.shiftRight(uint(16)));
    const x = x0.add(clamp(uu.div(c1.x).mul(iw), float(0.5), iw.sub(0.5)));
    const y = y0.add(clamp(vv.div(c1.y).mul(ih), float(0.5), ih.sub(0.5)));
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
    Loop(int(tex.head.z), ({ i }: { i: N }) => {
      const at = uint(tex.head.w).add(uint(i).mul(uint(TERRAIN_TEXELS)));
      const t0 = texel(at);
      Loop(int(t0.x), ({ i: k }: { i: N }) => {
        const r = asF(texel(at.add(uint(1)).add(uint(k))));
        const half = r.z.sub(r.w);
        If(abs(p.x.sub(r.x)).lessThanEqual(half).and(abs(p.z.sub(r.y)).lessThanEqual(half)), () => {
          layer.assign(t0.y.add(uint(k)));
          uv.assign(vec2(p.x, p.z).div(r.w).div(TERRAIN_RING_TEXELS));
          found.assign(true);
          Break();
        });
      });
      If(found, () => {
        Break();
      });
    });
    return { layer, uv, found, rings: true };
  }
  // Architecture: the world cell's list of charts, the first whose plane and rectangle hold the pixel.
  const h1 = TSL.uvec2(tex.arch);
  const c = TSL.ivec3(floor(p.div(ARCH_CELL)));
  const cu = TSL.uvec3(c);
  const cap = h1.x;
  const s = cu.x.mul(uint(73856093)).bitXor(cu.y.mul(uint(19349663))).bitXor(cu.z.mul(uint(83492791))).bitAnd(cap.sub(uint(1))).toVar();
  Loop(int(cap), () => {
    const slot = texel(h1.y.add(s));
    If(slot.w.equal(uint(0)), () => {
      Break();
    });
    If(TSL.ivec3(asI(slot.x), asI(slot.y), asI(slot.z)).equal(c).all(), () => {
      const list = slot.w;
      Loop(int(word(list.mul(uint(4)))), ({ i }: { i: N }) => {
        const fa = word(list.mul(uint(4)).add(uint(1)).add(uint(i)));
        const f0 = asF(texel(fa));
        const f1 = asF(texel(fa.add(uint(1))));
        const f2 = asF(texel(fa.add(uint(2))));
        const d = p.sub(f0.xyz);
        const nn = cross(f1.xyz, f2.xyz);
        const uu = dot(d, f1.xyz);
        const vv = dot(d, f2.xyz);
        const on = abs(dot(d, nn)).lessThanEqual(ARCH_PLANE_METRES).and(dot(n, nn).greaterThanEqual(ARCH_FACING));
        const within = uu.greaterThanEqual(-ARCH_PLANE_METRES).and(vv.greaterThanEqual(-ARCH_PLANE_METRES)).and(uu.lessThanEqual(f0.w.add(ARCH_PLANE_METRES))).and(vv.lessThanEqual(f1.w.add(ARCH_PLANE_METRES)));
        If(on.and(within), () => {
          chartAt(fa.add(uint(FRAME_TEXELS - CHART_TEXELS)), uu, vv);
          Break();
        });
      });
      Break();
    });
    s.assign(s.add(uint(1)).bitAnd(cap.sub(uint(1))));
  });
  return { layer, uv, found, rings: false };
}

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
    const { layer, uv, found, rings } = lookupNodes(this.tex, this.kind);
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
