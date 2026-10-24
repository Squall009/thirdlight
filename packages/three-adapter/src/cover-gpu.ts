/**
 * Ground cover on terrains, placed and thinned on the GPU (the arithmetic is
 * `cover-placement.ts`'s; this is its draws and its vertex stage).
 *
 * Per terrain and cover rule: the rule's rings (`planCover`), and per ring
 * one draw per mesh of the model level it shows and per texture page of the
 * terrain its patches lie on. A draw is a plain mesh of the model's own
 * geometry drawn `patches × candidates` times: its vertex stage takes the
 * instance index apart into a patch (a texel of the ring's patch list: its
 * first candidate cell and its tile's texture layer) and a candidate cell,
 * and computes the copy's place, turn and size, and whether it is kept,
 * from the cell's hashes, the terrain's height, normal, hole and layer
 * texels (the same page textures the terrain draws with) and the view's eye.
 * A candidate not kept collapses to a point far below the ground (nothing is
 * drawn). The same on WebGL 2 and WebGPU: no compute, no storage buffers.
 *
 * The placement is applied where three applies an instanced mesh's
 * matrices: before the material's own `positionNode`, so a foliage
 * material's wind moves a placed copy as it moves any other. A draw holds
 * more than one instance, so three keys its program by the mesh: each draw
 * compiles its own (a few per rule).
 *
 * Each frame the patches of each ring in view are listed again (frustum
 * culled on the CPU; a few hundred at most) and written into the ring's
 * patch texture only when the list changed.
 *
 * Cover draws receive shadows and cast none unless the rule says
 * `castShadow` (contact darkening comes from SSAO).
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { NodeMaterial, type NodeBuilder } from 'three/webgpu';
import { SCATTER_COVER_DISTANCE_DEFAULT, scatterRuleSeed, type RuleRange, type ScatterRule } from '@thirdlight/runtime';

import { COVER_FADE_START, COVER_LANES, COVER_MIN_NORMAL_Y, listCoverPatches, planCover, type CoverPatch, type CoverPlan, type CoverRing } from './cover-placement';
import type { N } from './effects-tsl';
import { instanceSetPlan, type InstanceSetPlan } from './instancing';
import { TAN_HALF_REFERENCE } from './instance-lod';
import type { LodTuning } from './lod-switch';
import { stepOf } from './terrain-material';
import type { TerrainCoverSurface } from './terrain-view';
import { SphereSide, type CullView } from './view-cull';
import type { ModelInstance } from './visual';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, abs, acos, clamp, cos, cross, dot, float, floor, instanceIndex, int, ivec2, length, max, min, normalLocal, normalize, positionLocal, select, sin, smoothstep, sqrt, textureLoad, uint, uniform, vec2, vec3, vec4 } = TSL;

/** `mesh.userData[COVER_DRAW_KEY]`: the draw's placement (its vertex stage reads it). */
export const COVER_DRAW_KEY = '__tlCoverDraw';

/** Patches a row of a ring's patch texture holds. */
const PATCH_ROW = 1024;
/** Added to a cell index before it is made unsigned (a float holds it exactly): cell indices stay within ± this. */
const CELL_OFFSET = 8388608;
/** Where a candidate not kept goes: far below any ground and past any far plane. */
const DROPPED_Y = -1e6;

export interface CoverPlacement {
  /** Apply the placement to `positionLocal` and `normalLocal` (inside a node build). */
  place(): void;
}

let installed = false;

/** Teach every node material to place cover draws' copies (idempotent; before three's own position setup). */
export function installCoverPlacement(): void {
  if (installed) return;
  installed = true;
  const proto = NodeMaterial.prototype as unknown as { setupPosition(builder: NodeBuilder): unknown };
  const base = proto.setupPosition;
  proto.setupPosition = function setupPositionWithCover(this: unknown, builder: NodeBuilder): unknown {
    const draw = (builder as unknown as { object?: THREE.Object3D | null }).object?.userData[COVER_DRAW_KEY] as CoverPlacement | undefined;
    if (draw !== undefined) draw.place();
    return base.call(this, builder);
  };
}

/** The integer hash of `coverRandom` (cover-placement.ts) in the vertex stage: `seed` a uint, `ix`/`iz` uint cell indices. */
function randomNode(seed: N, ix: N, iz: N, lane: number): N {
  let h = seed.bitXor(ix.mul(uint(0x27d4eb2d))).bitXor(iz.mul(uint(0x165667b1))).bitXor(uint(Math.imul(lane + 1, 0x9e3779b1) >>> 0));
  h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x85ebca6b));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(0xc2b2ae35));
  h = h.bitXor(h.shiftRight(uint(16)));
  return float(h.shiftRight(uint(8))).div(16777216);
}

/** A whole float (|v| < CELL_OFFSET) as the uint holding its two's complement (as `v | 0` is on the CPU). */
const asUint = (v: N): N => uint(int(v.add(CELL_OFFSET))).sub(uint(CELL_OFFSET));

/** The noise hash of the surface rules (`ruleNoise`), its top 24 bits. */
const NOISE_H = [0x27d4eb2d, 0x1b873593, 0x165667b1, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35] as const;
function noiseHash(ix: N, iy: N, iz: N, seed: number): N {
  let h = ix.mul(uint(NOISE_H[0])).bitXor(iy.mul(uint(NOISE_H[1]))).bitXor(iz.mul(uint(NOISE_H[2]))).bitXor(uint(Math.imul(seed | 0, NOISE_H[3]) >>> 0));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(NOISE_H[4]));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(NOISE_H[5]));
  h = h.bitXor(h.shiftRight(uint(16)));
  return float(h.shiftRight(uint(8))).div(16777216);
}

/** `ruleNoise` in the vertex stage (value noise, smoothstep between lattice points). */
function noiseNode(p: N, seed: number): N {
  const i = floor(p).toVar();
  const f = p.sub(i);
  const s = f.mul(f).mul(vec3(3).sub(f.mul(2))).toVar();
  const ix = asUint(i.x).toVar();
  const iy = asUint(i.y).toVar();
  const iz = asUint(i.z).toVar();
  const one = uint(1);
  const lerp = (a: N, b: N, t: N): N => a.add(b.sub(a).mul(t));
  const plane = (yy: N): N => lerp(lerp(noiseHash(ix, yy, iz, seed), noiseHash(ix.add(one), yy, iz, seed), s.x), lerp(noiseHash(ix, yy, iz.add(one), seed), noiseHash(ix.add(one), yy, iz.add(one), seed), s.x), s.z);
  return lerp(plane(iy), plane(iy.add(one)), s.y);
}

/** `ruleRangeAt` in the vertex stage (the range's numbers compiled in). */
function rangeNode(r: RuleRange, v: N): N {
  const fade = r.fade ?? 0;
  let k: N = float(1);
  if (r.min !== undefined) k = k.mul(select(v.lessThan(r.min), fade > 0 ? smoothstep(0, 1, float(1).sub(float(r.min).sub(v).div(fade))) : float(0), float(1)));
  if (r.max !== undefined) k = k.mul(select(v.greaterThan(r.max), fade > 0 ? smoothstep(0, 1, float(1).sub(v.sub(r.max).div(fade))) : float(0), float(1)));
  return k;
}

/** `coverShare` in the vertex stage. */
function shareNode(t: CoverPlan['thinning'], d: N): N {
  const screen = select(d.lessThanEqual(t.full), float(1), float(t.full * t.full).div(max(d.mul(d), 1e-6)));
  const from = t.reach * COVER_FADE_START;
  const fade = float(1).sub(smoothstep(from, t.reach, d));
  return select(d.greaterThanEqual(t.reach), float(0), max(float(t.min), screen.mul(fade)));
}

/** Hamilton product of two quaternions (x, y, z, w). */
const qmulNode = (a: N, b: N): N => vec4(b.xyz.mul(a.w).add(a.xyz.mul(b.w)).add(cross(a.xyz, b.xyz)), a.w.mul(b.w).sub(dot(a.xyz, b.xyz)));
/** `v` turned by unit quaternion `q`. */
const rotateNode = (q: N, v: N): N => {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
};

/** What one draw's vertex stage reads. */
export interface CoverDrawInputs {
  readonly ring: CoverRing;
  readonly plan: CoverPlan;
  readonly rule: ScatterRule;
  readonly seed: number;
  readonly surface: TerrainCoverSurface;
  readonly page: TerrainCoverSurface['pages'][number];
  readonly patches: THREE.DataTexture;
  /** The view's eye in the terrain's frame (x, z), shared by the source's draws. */
  readonly eye: N;
  /** The model mesh's place in the model (its node's matrix). */
  readonly local: THREE.Matrix4;
}

/** The placement of one draw's copies (built anew in each of its node builds). */
export function coverDrawPlacement(d: CoverDrawInputs): CoverPlacement {
  const local = uniform(d.local);
  return {
    place: Fn(() => {
      const { ring, rule, surface: s, page } = d;
      const per = uint(ring.perPatch);
      const idx = uint(instanceIndex);
      const p = idx.div(per);
      const k = idx.sub(p.mul(per));
      const texel = textureLoad(d.patches, ivec2(int(p.mod(uint(PATCH_ROW))), int(p.div(uint(PATCH_ROW))))).toVar();
      const side = uint(ring.side);
      const cz = k.div(side);
      const cx = k.sub(cz.mul(side));
      const gx = texel.x.add(float(cx)).toVar();
      const gz = texel.y.add(float(cz)).toVar();
      const layer = int(texel.z.add(0.5));
      const seed = uint(d.seed >>> 0);
      const ux = asUint(gx).toVar();
      const uz = asUint(gz).toVar();
      const rnd = (lane: number): N => randomNode(seed, ux, uz, ring.lanes + lane);
      const cell = ring.patch / ring.side;
      const x = gx.add(rnd(COVER_LANES.jx)).mul(cell).toVar();
      const z = gz.add(rnd(COVER_LANES.jz)).mul(cell).toVar();
      // The tile under the patch (patches never straddle one): its min corner, then the cell under the point.
      const T = s.tileSize;
      const tileX = floor(texel.x.mul(cell).add(ring.patch / 2).div(T)).mul(T);
      const tileZ = floor(texel.y.mul(cell).add(ring.patch / 2).div(T)).mul(T);
      const n = s.samples - 1;
      const u = clamp(x.sub(tileX).div(s.spacing), 0, n).toVar();
      const v = clamp(z.sub(tileZ).div(s.spacing), 0, n).toVar();
      const ix = int(min(floor(u), float(n - 1))).toVar();
      const iz = int(min(floor(v), float(n - 1))).toVar();
      const fx = u.sub(float(ix)).toVar();
      const fz = v.sub(float(iz)).toVar();
      const h = (dx: number, dz: number): N => textureLoad(page.heights, ivec2(ix.add(dx), iz.add(dz))).depth(layer).toVar();
      const t00 = h(0, 0);
      const t10 = h(1, 0);
      const t01 = h(0, 1);
      const t11 = h(1, 1);
      const s00 = stepOf(t00);
      const s10 = stepOf(t10);
      const s01 = stepOf(t01);
      const s11 = stepOf(t11);
      // As the colliders' triangles (terrainCellStep).
      const lower = s00.add(s10.sub(s00).mul(fx)).add(s01.sub(s00).mul(fz));
      const upper = s11.add(s01.sub(s11).mul(float(1).sub(fx))).add(s10.sub(s11).mul(float(1).sub(fz)));
      const ground = float(s.low).add(select(fx.add(fz).lessThanEqual(1), lower, upper).mul(s.step)).toVar();
      const bil = (a: N, b: N, c: N, e: N): N => a.add(b.sub(a).mul(fx)).add(c.add(e.sub(c).mul(fx)).sub(a.add(b.sub(a).mul(fx))).mul(fz));
      const nxz = bil(t00.ba, t10.ba, t01.ba, t11.ba).mul(2).sub(1);
      const normal = normalize(vec3(nxz.x, sqrt(max(float(1).sub(dot(nxz, nxz)), 0.0001)), nxz.y)).toVar();
      const slope = acos(min(normal.y, 1)).mul(180 / Math.PI);
      const hole = textureLoad(page.layers, ivec2(ix, iz)).depth(layer).a.greaterThanEqual(0.5);
      const near = ivec2(int(min(floor(u.add(0.5)), float(n))), int(min(floor(v.add(0.5)), float(n))));
      const wts = textureLoad(page.layers, near).depth(layer).toVar();
      const ids = floor(textureLoad(page.indices, near).depth(layer).mul(255).add(0.5)).toVar();
      const weights = vec4(wts.r, wts.g, wts.b, max(float(1).sub(wts.r).sub(wts.g).sub(wts.b), 0));
      const shareOf = (l: number): N => dot(weights, vec4(select(abs(ids.x.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.y.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.z.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.w.sub(l)).lessThan(0.5), float(1), float(0))));
      // The rule's conditions (the world height and noise read world metres).
      const wy = ground.add(s.origin[1] ?? 0);
      let f: N = float(1);
      if (rule.height !== undefined) f = f.mul(rangeNode(rule.height, wy));
      if (rule.slope !== undefined) f = f.mul(rangeNode(rule.slope, slope));
      if (rule.noise !== undefined) {
        const k = rule.noise.scale;
        const at = vec3(x.add(s.origin[0] ?? 0), wy, z.add(s.origin[2] ?? 0)).div(k);
        f = f.mul(rangeNode(rule.noise, noiseNode(at, rule.noise.seed ?? 0)));
      }
      for (const l of rule.layers ?? []) f = f.mul(rangeNode(l, shareOf(l.layer)));
      const dist = length(vec2(x, z).sub(d.eye));
      const inRing = dist.greaterThanEqual(ring.inner).and(dist.lessThan(ring.outer));
      const odds = f.mul(shareNode(d.plan.thinning, dist)).div(ring.gridShare);
      const kept = inRing.and(hole.not()).and(normal.y.greaterThan(COVER_MIN_NORMAL_Y)).and(rnd(COVER_LANES.keep).lessThan(odds));
      // Its turn and size (copyRotation: a turn about up, then a lean toward the normal by `align`).
      const sc = rule.scale ?? [1, 1];
      const size = float(sc[0]).add(rnd(COVER_LANES.scale).mul(sc[1] - sc[0]));
      const half = rnd(COVER_LANES.yaw).mul(((rule.yaw ?? 360) * Math.PI) / 360);
      const turn = vec4(0, sin(half), 0, cos(half));
      const align = rule.align ?? 0;
      let q: N = turn;
      if (align > 0) {
        const across = length(normal.xz);
        const a = acos(clamp(normal.y, -1, 1)).mul(align / 2);
        const sa = sin(a).div(max(across, 1e-9));
        q = select(across.lessThan(1e-9), turn, qmulNode(vec4(normal.z.mul(sa), 0, normal.x.negate().mul(sa), cos(a)), turn));
      }
      const quat = q.toVar();
      const placed = local.mul(vec4(positionLocal, 1)).xyz.mul(size);
      const at = vec3(x, ground.sub(rule.sink ?? 0), z);
      positionLocal.assign(select(kept, rotateNode(quat, placed).add(at), vec3(x, DROPPED_Y, z)));
      normalLocal.assign(rotateNode(quat, normalize(local.mul(vec4(normalLocal, 0)).xyz)));
    }, 'void') as unknown as () => void,
  };
}

/** A patch list a ring's draws on one page share. */
interface PagePatches {
  readonly texture: THREE.DataTexture;
  readonly data: Float32Array;
  /** The textures the draws compiled against (a grown page replaces them: the draws are made again). */
  heights: THREE.DataArrayTexture | null;
  meshes: THREE.Mesh[];
  undress: (() => void) | null;
  readonly root: THREE.Group;
  /** Candidates a patch holds; patches listed now, and the list's hash. */
  readonly perPatch: number;
  count: number;
  key: number;
}

interface RuleDraws {
  readonly rule: ScatterRule;
  readonly plan: CoverPlan;
  readonly model: InstanceSetPlan;
  /** Per ring: per page its patches and draws. */
  readonly rings: Map<number, PagePatches>[];
  /** The model parts each ring draws. */
  readonly parts: InstanceSetPlan['parts'][];
}

interface Source {
  readonly id: string;
  rules: readonly ScatterRule[];
  rulesKey: string;
  hidden: boolean;
  /** The plans, once the rules' models loaded (null: not yet). */
  draws: RuleDraws[] | null;
  /** Its eye uniform (x, z in the terrain's frame). */
  readonly eye: N;
  /** The tile size, LOD bias and terrain place the plans and draws were made for. */
  planned: string;
}

export interface CoverGpuDeps {
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  place(root: THREE.Object3D, shown: boolean): void;
  /** The terrain's surface as its view draws it (null: not drawn). */
  surface(id: string): TerrainCoverSurface | null;
  tuning?: LodTuning;
  changed?(): void;
}

export interface CoverGpuDiagnostics {
  /** Terrains and rules drawn on the GPU, its draws drawing this frame, patches listed and candidates drawn. */
  sources: number;
  rules: number;
  draws: number;
  patches: number;
  candidates: number;
  /** Main-thread ms of the last frame's patch lists. */
  listMs: number;
}

/** Ground cover of terrains drawn on the GPU. */
export class CoverGpu {
  private readonly sources = new Map<string, Source>();
  private listMs = 0;
  private disposed = false;
  private readonly lists = new Map<number, CoverPatch[]>();

  constructor(private readonly deps: CoverGpuDeps) {
    installCoverPlacement();
  }

  /** Terrain `id`'s cover rules drawn here (an empty list: none). */
  setRules(id: string, rules: readonly ScatterRule[]): void {
    const key = JSON.stringify(rules);
    let src = this.sources.get(id);
    if (src !== undefined && src.rulesKey === key) return;
    if (src !== undefined) this.clear(src);
    if (rules.length === 0) {
      this.sources.delete(id);
      return;
    }
    src ??= { id, rules, rulesKey: key, hidden: false, draws: null, eye: uniform(new THREE.Vector2()), planned: '' };
    src.rules = rules;
    src.rulesKey = key;
    this.sources.set(id, src);
    this.deps.changed?.();
  }

  setHidden(id: string, hidden: boolean): void {
    const src = this.sources.get(id);
    if (src === undefined || src.hidden === hidden) return;
    src.hidden = hidden;
    for (const r of src.draws ?? []) for (const ring of r.rings) for (const pp of ring.values()) this.deps.place(pp.root, !hidden && pp.count > 0 && pp.meshes.length > 0);
  }

  remove(id: string): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    this.clear(src);
    this.sources.delete(id);
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /** List each ring's patches round the view's eye (once a frame). */
  update(view: CullView): void {
    if (this.disposed || this.sources.size === 0) return;
    const t0 = performance.now();
    for (const src of this.sources.values()) {
      const surface = this.deps.surface(src.id);
      if (surface === null) continue;
      const planned = `${surface.tileSize}|${this.deps.tuning?.bias ?? 1}|${surface.origin.join(',')}`;
      if (src.draws !== null && src.planned !== planned) this.clear(src);
      if (src.draws === null && !this.plan(src, surface)) continue;
      src.planned = planned;
      const o = surface.origin;
      const eye: [number, number] = [view.eye[0]! - (o[0] ?? 0), view.eye[2]! - (o[2] ?? 0)];
      (src.eye.value as THREE.Vector2).set(eye[0], eye[1]);
      const visible = (x: number, y: number, z: number, r: number): boolean => view.side(x + (o[0] ?? 0), y + (o[1] ?? 0), z + (o[2] ?? 0), r) !== SphereSide.Outside;
      for (const rd of src.draws!) {
        const rise = rd.model.radius * 2 * Math.max(...(rd.rule.scale ?? [1, 1]));
        rd.plan.rings.forEach((ring, k) => {
          this.lists.clear();
          listCoverPatches(ring, eye, surface.tileSize, rise, surface.tileAt, visible, this.lists);
          const byPage = rd.rings[k]!;
          for (const [page, pp] of byPage) if (!this.lists.has(page)) this.write(src, pp, []);
          for (const [page, list] of this.lists) {
            const tex = surface.pages[page];
            if (tex === undefined) continue;
            let pp = byPage.get(page);
            if (pp !== undefined && pp.heights !== tex.heights) {
              this.dropPage(pp);
              byPage.delete(page);
              pp = undefined;
            }
            if (pp === undefined) {
              pp = this.makePage(src, rd, k, surface, tex);
              byPage.set(page, pp);
            }
            this.write(src, pp, list);
          }
        });
      }
    }
    this.listMs = performance.now() - t0;
  }

  diagnostics(): CoverGpuDiagnostics {
    let rules = 0;
    let draws = 0;
    let patches = 0;
    let candidates = 0;
    for (const src of this.sources.values()) {
      rules += src.rules.length;
      for (const rd of src.draws ?? []) {
        rd.rings.forEach((byPage, k) => {
          for (const pp of byPage.values()) {
            if (pp.count === 0 || src.hidden) continue;
            draws += pp.meshes.length;
            patches += pp.count;
            candidates += pp.count * rd.plan.rings[k]!.perPatch;
          }
        });
      }
    }
    return { sources: this.sources.size, rules, draws, patches, candidates, listMs: Math.round(this.listMs * 100) / 100 };
  }

  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const src of this.sources.values()) for (const rd of src.draws ?? []) for (const ring of rd.rings) for (const pp of ring.values()) if (pp.count > 0) out.push(...pp.meshes);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.disposed = true;
  }

  // ---- internals ------------------------------------------------------------------------

  /** Plan a source's rules once their models loaded (false: one is loading). */
  private plan(src: Source, surface: TerrainCoverSurface): boolean {
    const out: RuleDraws[] = [];
    for (const rule of src.rules) {
      const template = this.deps.template(rule.asset.assetId, rule.asset.piece, () => this.deps.changed?.());
      if (template === null) return false;
      const model = instanceSetPlan(template);
      const g = model.groups[0];
      const levels = { distances: g?.distances ?? [0], culls: g?.culls ?? false, radius: model.radius };
      const screenFull = rule.densityStart !== undefined && model.radius > 0 ? model.radius / (TAN_HALF_REFERENCE * rule.densityStart) : undefined;
      const plan = planCover(rule, rule.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT, levels, surface.tileSize, this.deps.tuning?.bias ?? 1, screenFull);
      // Each ring's meshes: those of its level in the first LOD, another LOD's at its level there, and those in none.
      const parts = plan.rings.map((ring) =>
        model.parts.filter((p) => {
          if (p.lod < 0) return true;
          const d = model.groups[p.lod]?.distances ?? [0];
          let level = 0;
          for (let l = 1; l < d.length; l++) if (ring.inner >= d[l]! * (this.deps.tuning?.bias ?? 1)) level = l;
          return p.lod === 0 ? p.level === ring.level : p.level === level;
        }),
      );
      out.push({ rule, plan, model, rings: plan.rings.map(() => new Map()), parts });
    }
    src.draws = out;
    return true;
  }

  private makePage(src: Source, rd: RuleDraws, k: number, surface: TerrainCoverSurface, page: TerrainCoverSurface['pages'][number]): PagePatches {
    const ring = rd.plan.rings[k]!;
    const rows = Math.max(1, Math.ceil(ring.maxPatches / PATCH_ROW));
    const data = new Float32Array(PATCH_ROW * rows * 4);
    const texture = new THREE.DataTexture(data, PATCH_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const root = new THREE.Group();
    root.name = `cover-gpu:${src.id}:${rd.rule.id}:${k}`;
    root.matrixAutoUpdate = false;
    const seed = scatterRuleSeed(rd.rule);
    const meshes = rd.parts[k]!.map((part) => {
      const mesh = new THREE.Mesh(part.mesh.geometry, part.mesh.material);
      mesh.name = `${root.name}:${part.mesh.name}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = rd.rule.castShadow === true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.userData[COVER_DRAW_KEY] = coverDrawPlacement({ ring, plan: rd.plan, rule: rd.rule, seed, surface, page, patches: texture, eye: src.eye, local: part.local.clone() });
      root.add(mesh);
      return mesh;
    });
    const undress = this.deps.dress?.(root, rd.rule.asset.assetId) ?? null;
    root.matrix.makeTranslation(surface.origin[0] ?? 0, surface.origin[1] ?? 0, surface.origin[2] ?? 0);
    root.updateMatrixWorld(true);
    return { texture, data, heights: page.heights, meshes, undress, root, perPatch: ring.perPatch, count: 0, key: 0 };
  }

  /** Put a list in a ring's patch texture (only when it changed) and size its draws. */
  private write(src: Source, pp: PagePatches, list: readonly CoverPatch[]): void {
    const cap = pp.data.length / 4;
    const n = Math.min(list.length, cap);
    let key = n;
    for (let i = 0; i < n; i++) key = (Math.imul(key, 31) + Math.imul(list[i]!.gx, 0x9e3779b1) + Math.imul(list[i]!.gz, 0x85ebca6b) + list[i]!.layer) | 0;
    const was = pp.count;
    if (key !== pp.key || n !== pp.count) {
      for (let i = 0; i < n; i++) {
        const p = list[i]!;
        pp.data[i * 4] = p.gx;
        pp.data[i * 4 + 1] = p.gz;
        pp.data[i * 4 + 2] = p.layer;
      }
      pp.texture.needsUpdate = true;
      pp.key = key;
      pp.count = n;
    }
    // A draw of one copy or none would be keyed apart from the others (three keys a draw of several by its mesh): hidden instead.
    const copies = pp.count * pp.perPatch;
    for (const m of pp.meshes) {
      (m as unknown as { count: number }).count = copies;
      m.visible = copies > 1;
    }
    if ((was > 0) !== (pp.count > 0)) this.deps.place(pp.root, !src.hidden && pp.count > 0 && pp.meshes.length > 0);
  }

  private dropPage(pp: PagePatches): void {
    if (pp.count > 0) this.deps.place(pp.root, false);
    pp.undress?.();
    pp.texture.dispose();
    for (const m of pp.meshes) m.removeFromParent();
    pp.meshes = [];
  }

  private clear(src: Source): void {
    for (const rd of src.draws ?? []) for (const ring of rd.rings) for (const pp of ring.values()) this.dropPage(pp);
    src.draws = null;
  }
}
