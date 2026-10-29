/**
 * Ground cover, placed and thinned on the GPU (the arithmetic is
 * `cover-placement.ts`'s and `cover-points.ts`'s; this is its draws and
 * their vertex stages). There is no other path: terrains' cover is placed
 * from the terrain's own texels, block layers' from point sets baked per
 * chunk, both through the same rings, model levels, thinning and culling.
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
 * A rule's masks (`coverMask`: spline bands, block cuts, excluded regions,
 * cavity) are asked for per tile as its patches are first listed, made off
 * the main thread, and kept in one array texture per terrain, a layer per
 * rule and tile; a patch names its tile's layer. A tile whose mask is on its
 * way is not drawn yet; one made again keeps its old mask until the new one
 * arrives, so an edit never blinks the cover away. Masks of tiles the view
 * left are let go.
 *
 * A block layer's rule draws, per ring, the blocks of its chunks' point
 * sets (`cover-points-gpu.ts`) that the ring meets and the view sees: each
 * point is placed where it was baked (every floor of the layer, so cover
 * grows indoors too), turned and sized from its own bytes, and kept while
 * its threshold is under the share at its distance. Sets are baked off the
 * main thread when the view reaches a chunk and when its ground changes.
 *
 * Cover draws receive shadows and cast none unless the rule says
 * `castShadow` (contact darkening comes from SSAO).
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { NodeMaterial, type NodeBuilder } from 'three/webgpu';
import { COVER_POINT_STEPS, FOLIAGE_BEND_DEFAULTS, SCATTER_COVER_DISTANCE_DEFAULT, scatterRuleSeed, type CoverPointSet, type RuleRange, type ScatterRule } from '@thirdlight/runtime';

import { COVER_FADE_START, COVER_LANES, COVER_MIN_NORMAL_Y, coverMaskSide, listCoverPatches, planCover, type CoverPatch, type CoverPlan, type CoverRing, type CoverTileRef } from './cover-placement';
import { COVER_POINT_BLOCK, COVER_POINT_ROW, CoverPointAtlas, listCoverPointBlocks } from './cover-points-gpu';
import type { N } from './effects-tsl';
import { instanceSetPlan, type InstanceSetPlan } from './instancing';
import { needsPreviousPlace } from './motion-vectors';
import { ROOT_COLOUR_KEY, setCopyBend, setCopyRoot, setCopySurface } from './node-materials';
import { TAN_HALF_REFERENCE } from './instance-lod';
import type { LodTuning } from './lod-switch';
import type { WarmDraw } from './program-warmer';
import { stepOf, terrainMacroFlip, terrainPartLayerNode } from './terrain-material';
import type { TerrainCoverSurface } from './terrain-view';
import { SphereSide, type CullView } from './view-cull';
import type { ModelInstance } from './visual';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, abs, acos, clamp, cos, cross, dot, float, floor, instanceIndex, int, ivec2, length, max, min, normalLocal, normalize, positionLocal, positionPrevious, select, sin, smoothstep, sqrt, texture, textureLoad, uint, uniform, vec2, vec3, vec4 } = TSL;

/**
 * A texture as a node the draws read through: a node made once and handed in
 * reads whatever texture it holds now, so a grown texture is swapped in
 * (`node.value = grown`) without building the draws' programs again.
 */
export type TextureInput = THREE.Texture | N;
const textureNodeOf = (t: TextureInput): N => ((t as THREE.Texture).isTexture === true ? texture(t) : (t as N));

/** `mesh.userData[COVER_DRAW_KEY]`: the draw's placement (its vertex stage reads it). */
export const COVER_DRAW_KEY = '__tlCoverDraw';

/** Patches a row of a ring's patch texture holds. */
const PATCH_ROW = 1024;
/** Added to a cell index before it is made unsigned (a float holds it exactly): cell indices stay within ± this. */
const CELL_OFFSET = 8388608;
/** Where a candidate not kept goes: far below any ground and past any far plane. */
const DROPPED_Y = -1e6;
/** Mask layers a terrain's mask texture starts with (doubled when full). */
const MASK_LAYERS_START = 8;
/** Frames a tile's mask is kept after its patches were last listed. */
const MASK_KEEP_FRAMES = 300;

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
  readonly patches: TextureInput;
  /** The terrain's mask texture (a layer per rule and tile; null: none, nothing read) and its side (texels). */
  readonly masks: TextureInput | null;
  readonly maskSide: number;
  /** The view's eye in the terrain's frame (x, z), shared by the source's draws. */
  readonly eye: N;
  /** The model mesh's place in the model (its node's matrix). */
  readonly local: THREE.Matrix4;
}

/** The placement of one draw's copies (built anew in each of its node builds). */
export function coverDrawPlacement(d: CoverDrawInputs): CoverPlacement {
  const local = uniform(d.local);
  return {
    place: Fn((builder: NodeBuilder) => {
      const { ring, rule, surface: s, page } = d;
      const per = uint(ring.perPatch);
      const idx = uint(instanceIndex);
      const p = idx.div(per);
      const k = idx.sub(p.mul(per));
      const texel = textureNodeOf(d.patches).load(ivec2(int(p.mod(uint(PATCH_ROW))), int(p.div(uint(PATCH_ROW))))).toVar();
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
      // Every vertex of a copy repeats its placement, so a candidate the distance alone thins (its conditions only
      // lower its odds) leaves before any texel is read: a branch the whole copy takes together.
      const dist = length(vec2(x, z).sub(d.eye)).toVar();
      const share = shareNode(d.plan.thinning, dist).mul(ring.odds).toVar();
      const keep = rnd(COVER_LANES.keep).toVar();
      const maybe = dist.greaterThanEqual(ring.inner).and(dist.lessThan(ring.outer)).and(keep.lessThan(share));
      // The mesh's own vertex, read here: three gives a shared node its value where it is first read, so a first
      // read inside the branch would hand later stages (the foliage's wind) the unplaced vertex.
      const vertex = positionLocal.toVar();
      const vertexNormal = normalLocal.toVar();
      const pos = vec3(x, DROPPED_Y, z).toVar();
      const nrm = vec3(0, 1, 0).toVar();
      const at = vec3(x, DROPPED_Y, z).toVar();
      setCopyRoot(builder, at);
      setCopyBend(builder, float(rule.bendAway ?? FOLIAGE_BEND_DEFAULTS.ruleBend));
      // The ground's colour under the copy, for a material that blends its base toward it (`rootColour`): the
      // terrain's baked albedo (its layers as drawn, from above), A 0 until the tile is baked.
      const wantsGround = (builder as unknown as { material?: THREE.Material | null }).material?.userData[ROOT_COLOUR_KEY] === true;
      const albedo = wantsGround ? (s.albedo?.(page) ?? null) : null;
      const ground = vec4(0).toVar();
      if (albedo !== null) setCopySurface(builder, ground);
      If(maybe, () => {
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
        const groundY = float(s.low).add(select(fx.add(fz).lessThanEqual(1), lower, upper).mul(s.step)).toVar();
        const bil = (a: N, b: N, c: N, e: N): N => a.add(b.sub(a).mul(fx)).add(c.add(e.sub(c).mul(fx)).sub(a.add(b.sub(a).mul(fx))).mul(fz));
        const nxz = bil(t00.ba, t10.ba, t01.ba, t11.ba).mul(2).sub(1);
        const normal = normalize(vec3(nxz.x, sqrt(max(float(1).sub(dot(nxz, nxz)), 0.0001)), nxz.y)).toVar();
        const slope = acos(min(normal.y, 1)).mul(180 / Math.PI);
        const hole = textureLoad(page.layers, ivec2(ix, iz)).depth(terrainPartLayerNode('layers', layer)).a.greaterThanEqual(0.5);
        const near = ivec2(int(min(floor(u.add(0.5)), float(n))), int(min(floor(v.add(0.5)), float(n))));
        const wts = textureLoad(page.layers, near).depth(terrainPartLayerNode('layers', layer)).toVar();
        const ids = floor(textureLoad(page.layers, near).depth(terrainPartLayerNode('indices', layer)).mul(255).add(0.5)).toVar();
        const weights = vec4(wts.r, wts.g, wts.b, max(float(1).sub(wts.r).sub(wts.g).sub(wts.b), 0));
        const shareOf = (l: number): N => dot(weights, vec4(select(abs(ids.x.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.y.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.z.sub(l)).lessThan(0.5), float(1), float(0)), select(abs(ids.w.sub(l)).lessThan(0.5), float(1), float(0))));
        // The rule's conditions (the world height and noise read world metres).
        const wy = groundY.add(s.origin[1] ?? 0);
        let f: N = float(1);
        if (rule.height !== undefined) f = f.mul(rangeNode(rule.height, wy));
        if (rule.slope !== undefined) f = f.mul(rangeNode(rule.slope, slope));
        if (rule.noise !== undefined) {
          const k = rule.noise.scale;
          const at = vec3(x.add(s.origin[0] ?? 0), wy, z.add(s.origin[2] ?? 0)).div(k);
          f = f.mul(rangeNode(rule.noise, noiseNode(at, rule.noise.seed ?? 0)));
        }
        for (const l of rule.layers ?? []) f = f.mul(rangeNode(l, shareOf(l.layer)));
        if (d.masks !== null) {
          // The rule's mask over the tile, where it has one (the patch names its layer).
          const ms = d.maskSide;
          const mt = (n * s.spacing) / ms;
          const mi = int(clamp(floor(x.sub(tileX).div(mt)), 0, ms - 1));
          const mj = int(clamp(floor(z.sub(tileZ).div(mt)), 0, ms - 1));
          // Read only where the patch names a layer: a copy's vertices all take the same way.
          const masked = float(1).toVar();
          const masks = textureNodeOf(d.masks);
          If(texel.w.greaterThanEqual(0), () => {
            masked.assign(masks.load(ivec2(mi, mj)).depth(int(texel.w.add(0.5))).r);
          });
          f = f.mul(masked);
        }
        const odds = f.mul(share).toVar();
        let kept: N = hole.not().and(normal.y.greaterThan(COVER_MIN_NORMAL_Y)).and(keep.lessThan(odds));
        if (ring.spacing > 0) {
          // `coverGivesWay`: a neighbour within the spacing, kept on the same odds, with the higher priority wins the place.
          const mine = rnd(COVER_LANES.priority).toVar();
          const gap = ring.spacing * ring.spacing;
          let gives: N = float(0).greaterThan(1);
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              const nux = ux.add(uint(dx >>> 0));
              const nuz = uz.add(uint(dz >>> 0));
              const nr = (lane: number): N => randomNode(seed, nux, nuz, ring.lanes + lane);
              const px = gx.add(dx).add(nr(COVER_LANES.jx)).mul(cell);
              const pz = gz.add(dz).add(nr(COVER_LANES.jz)).mul(cell);
              const near = px.sub(x).mul(px.sub(x)).add(pz.sub(z).mul(pz.sub(z))).lessThan(gap);
              const theirs = nr(COVER_LANES.priority);
              const wins = dz * 3 + dx < 0 ? theirs.greaterThanEqual(mine) : theirs.greaterThan(mine);
              gives = gives.or(near.and(nr(COVER_LANES.keep).lessThan(odds)).and(wins));
            }
          }
          kept = kept.and(gives.not());
        }
        // Its turn and size (copyRotation: a turn about up, then a lean toward the normal by `align`).
        const sc = rule.scale ?? [1, 1];
        const size = float(sc[0]).add(rnd(COVER_LANES.scale).mul(sc[1] - sc[0]));
        const quat = copyTurnNode(normal, rnd(COVER_LANES.yaw).mul(((rule.yaw ?? 360) * Math.PI) / 360), rule.align ?? 0).toVar();
        const placed = local.mul(vec4(vertex, 1)).xyz.mul(size);
        at.assign(vec3(x, groundY.sub(rule.sink ?? 0), z));
        if (albedo !== null) {
          // Baked rows run from +z on WebGL 2 (terrainMacroFlip); an unbaked texel's alpha (the sky's share) is 0.
          const tv = v.div(n);
          const a = TSL.texture(albedo, vec2(u.div(n), tv.add(float(1).sub(tv.mul(2)).mul(terrainMacroFlip)))).depth(layer).level(0);
          ground.assign(vec4(a.rgb, select(a.a.greaterThan(0.002), float(1), float(0))));
        }
        pos.assign(select(kept, rotateNode(quat, placed).add(at), pos));
        nrm.assign(rotateNode(quat, normalize(local.mul(vec4(vertexNormal, 0)).xyz)));
      });
      positionLocal.assign(pos);
      // Motion vectors: a copy stands still (its last place is this one).
      if (needsPreviousPlace(builder)) positionPrevious.assign(pos);
      normalLocal.assign(nrm);
    }, 'void') as unknown as () => void,
  };
}

/** What one draw of a block layer's point sets reads. */
export interface CoverPointDrawInputs {
  readonly ring: CoverRing;
  readonly plan: CoverPlan;
  readonly rule: ScatterRule;
  /** The ring's listed blocks (block, points in it, chunk x and z) and the rule's point texture. */
  readonly blocks: TextureInput;
  readonly points: TextureInput;
  /** A chunk's width and depth (m). */
  readonly chunk: readonly [number, number];
  readonly eye: N;
  readonly local: THREE.Matrix4;
}

/** The placement of one draw's copies from baked points (`cover-points.ts`): the same thinning, turn and size as on a terrain. */
export function coverPointsPlacement(d: CoverPointDrawInputs): CoverPlacement {
  const local = uniform(d.local);
  return {
    place: Fn((builder: NodeBuilder) => {
      const { ring, rule } = d;
      const B = uint(COVER_POINT_BLOCK);
      const idx = uint(instanceIndex);
      const b = idx.div(B);
      const k = idx.sub(b.mul(B));
      const entry = textureNodeOf(d.blocks).load(ivec2(int(b.mod(uint(PATCH_ROW))), int(b.div(uint(PATCH_ROW))))).toVar();
      const at = uint(entry.x).mul(B).add(k);
      const p = textureNodeOf(d.points).load(ivec2(int(at.mod(uint(COVER_POINT_ROW))), int(at.div(uint(COVER_POINT_ROW))))).toVar();
      const q = COVER_POINT_STEPS - 1;
      const xz = uint(p.x);
      const x = entry.z.add(float(xz.bitAnd(uint(COVER_POINT_STEPS - 1))).div(q)).mul(d.chunk[0]).toVar();
      const z = entry.w.add(float(xz.shiftRight(uint(12))).div(q)).mul(d.chunk[1]).toVar();
      const bytes = uint(p.z);
      const share = (v: N): N => float(v).add(0.5).div(256);
      const threshold = share(bytes.bitAnd(uint(255)));
      const turn01 = share(bytes.shiftRight(uint(8)).bitAnd(uint(255)));
      const size01 = share(bytes.shiftRight(uint(16)));
      // The normal (octahedral bytes).
      const nb = uint(p.w);
      const ou = float(nb.bitAnd(uint(255))).div(255).mul(2).sub(1).toVar();
      const ov = float(nb.shiftRight(uint(8))).div(255).mul(2).sub(1).toVar();
      const oy = float(1).sub(abs(ou)).sub(abs(ov)).toVar();
      const sgn = (v: N): N => select(v.lessThan(0), float(-1), float(1));
      const fu = select(oy.lessThan(0), float(1).sub(abs(ov)).mul(sgn(ou)), ou);
      const fv = select(oy.lessThan(0), float(1).sub(abs(ou)).mul(sgn(ov)), ov);
      const normal = normalize(vec3(fu, oy, fv)).toVar();
      const dist = length(vec2(x, z).sub(d.eye));
      const inRing = dist.greaterThanEqual(ring.inner).and(dist.lessThan(ring.outer));
      const kept = float(k).lessThan(entry.y).and(inRing).and(threshold.lessThan(shareNode(d.plan.thinning, dist)));
      const sc = rule.scale ?? [1, 1];
      const size = float(sc[0]).add(size01.mul(sc[1] - sc[0]));
      const quat = copyTurnNode(normal, turn01.mul(((rule.yaw ?? 360) * Math.PI) / 360), rule.align ?? 0).toVar();
      const placed = local.mul(vec4(positionLocal, 1)).xyz.mul(size);
      const ground = vec3(x, p.y.sub(rule.sink ?? 0), z).toVar();
      setCopyRoot(builder, ground);
      setCopyBend(builder, float(rule.bendAway ?? FOLIAGE_BEND_DEFAULTS.ruleBend));
      positionLocal.assign(select(kept, rotateNode(quat, placed).add(ground), vec3(x, DROPPED_Y, z)));
      if (needsPreviousPlace(builder)) positionPrevious.assign(positionLocal);
      normalLocal.assign(rotateNode(quat, normalize(local.mul(vec4(normalLocal, 0)).xyz)));
    }, 'void') as unknown as () => void,
  };
}

/** `copyRotation` in the vertex stage: a turn of `half` (half the angle) about up, then a lean toward `normal` by `align`. */
function copyTurnNode(normal: N, half: N, align: number): N {
  const turn = vec4(0, sin(half), 0, cos(half));
  if (align <= 0) return turn;
  const across = length(normal.xz);
  const a = acos(clamp(normal.y, -1, 1)).mul(align / 2);
  const sa = sin(a).div(max(across, 1e-9));
  return select(across.lessThan(1e-9), turn, qmulNode(vec4(normal.z.mul(sa), 0, normal.x.negate().mul(sa), cos(a)), turn));
}

/** A ring's list: an entry (4 floats) a texel, {@link PATCH_ROW} a row. */
function listTexture(data: Float32Array, rows: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, PATCH_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** What a terrain's draws read before its first mask arrives (no patch names a layer of it). */
const NO_MASKS = maskTexture(new Uint8Array([255]), 1, 1);

/** A mask array texture: a byte a texel, read texel by texel. */
function maskTexture(bytes: Uint8Array, side: number, layers: number): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(bytes, side, side, layers);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** A list a ring's draws on one page (a terrain's) or of one rule's points (a block layer's) share. */
interface PagePatches {
  /** The list (an entry a texel) and the node the draws read it through (a longer list is swapped in). */
  texture: THREE.DataTexture;
  data: Float32Array;
  readonly list: N;
  /** A terrain's: the page texture the draws were built against (a grown page holds new ones: the draws are made again). */
  bound: THREE.Texture | null;
  meshes: THREE.Mesh[];
  undress: (() => void) | null;
  readonly root: THREE.Group;
  /** Candidates an entry holds; entries listed now. */
  readonly perPatch: number;
  count: number;
  /** Shown for a precompile (its programs built ahead of its first draw), and dropped. */
  held: boolean;
  dropped: boolean;
}

interface RuleDraws {
  readonly rule: ScatterRule;
  readonly plan: CoverPlan;
  readonly model: InstanceSetPlan;
  /** Per ring: per page its patches and draws (a block layer's: page 0). */
  readonly rings: Map<number, PagePatches>[];
  /** The model parts each ring draws. */
  readonly parts: InstanceSetPlan['parts'][];
}

/** A rule's mask over one tile. */
interface MaskEntry {
  /** Its layer in the mask texture (-1: none: the rule needs none there). */
  slot: number;
  /** Arrived (the tile may be drawn); asked again (an answer on the way is the one wanted). */
  ready: boolean;
  stale: boolean;
  asked: boolean;
  token: number;
  /** The frame its tile was last listed. */
  used: number;
  readonly tx: number;
  readonly tz: number;
}

/** A terrain's masks: one array texture, a layer per rule and tile. */
interface MaskAtlas {
  readonly side: number;
  texture: THREE.DataArrayTexture | null;
  /** What the draws read the masks through (a placeholder until the first mask: a grown texture is swapped in). */
  readonly node: N;
  layers: number;
  readonly free: number[];
  readonly entries: Map<string, MaskEntry>;
}

interface SourceBase {
  readonly id: string;
  rules: readonly ScatterRule[];
  rulesKey: string;
  hidden: boolean;
  /** The plans, once the rules' models loaded (null: not yet). */
  draws: RuleDraws[] | null;
  /** Its eye uniform (x, z in the source's frame). */
  readonly eye: N;
  /** The tile size, LOD bias and place the plans and draws were made for. */
  planned: string;
}

/** A terrain: its cover placed from its own texels and masks. */
interface TerrainSource extends SourceBase {
  readonly kind: 'terrain';
  masks: MaskAtlas | null;
}

/** A block layer: its cover drawn from point sets baked per chunk. */
interface PointSource extends SourceBase {
  readonly kind: 'points';
  origin: [number, number, number];
  /** A chunk's width and depth (m), and the chunks there are ("cx,cz"). */
  chunk: [number, number];
  chunks: ReadonlySet<string>;
  /** Each rule's point sets, by rule id, and the node its draws read their texture through (a grown one is swapped in). */
  readonly atlases: Map<string, CoverPointAtlas>;
  readonly pointNodes: Map<string, N>;
}

type Source = TerrainSource | PointSource;

export interface CoverGpuDeps {
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  place(root: THREE.Object3D, shown: boolean): void;
  /** The terrain's surface as its view draws it (null: not drawn). */
  surface(id: string): TerrainCoverSurface | null;
  tuning?: LodTuning;
  changed?(): void;
  /** Whether `rule` of terrain `id` needs a mask over tile (tx, tz): it reads one, or a band or block cut lies near (absent: never). */
  maskWanted?(id: string, rule: ScatterRule, tx: number, tz: number): boolean;
  /** Ask for that mask; `reply` gets it (null: 255 everywhere). False: not asked (a tile under it not decoded yet; asked again next frame). */
  mask?(id: string, rule: ScatterRule, tx: number, tz: number, reply: (data: Uint8Array | null) => void): boolean;
  /** Ask for rule `rule`'s points over chunk (cx, cz) of block layer `id`; `reply` gets them (null: none). */
  points?(id: string, rule: ScatterRule, cx: number, cz: number, reply: (set: CoverPointSet | null) => void): void;
  /** Build a ring's draws' programs ahead of their first draw (absent: built when first drawn). */
  warm?(d: WarmDraw): void;
}

export interface CoverGpuDiagnostics {
  /** Sources and rules drawn on the GPU, its draws drawing this frame, patches (a block layer's: blocks of points) listed and candidates drawn. */
  sources: number;
  rules: number;
  draws: number;
  patches: number;
  candidates: number;
  /** Main-thread ms of the last frame's lists. */
  listMs: number;
  /** Masks held (a layer each), and asked for and not arrived. */
  masks: number;
  masksPending: number;
  /** Block layers' chunk point sets held, their points, and sets asked for and not arrived. */
  pointSets: number;
  points: number;
  pointsPending: number;
}

/** Ground cover drawn on the GPU: terrains' placed from their texels, block layers' from baked point sets. */
export class CoverGpu {
  private readonly sources = new Map<string, Source>();
  private listMs = 0;
  private disposed = false;
  private readonly lists = new Map<number, CoverPatch[]>();
  private frame = 0;
  /** A ring's entries this frame, before they are compared with what its list holds. */
  private next = new Float32Array(0);

  constructor(private readonly deps: CoverGpuDeps) {
    installCoverPlacement();
  }

  /** Terrain `id`'s cover rules drawn here (an empty list: none). */
  setRules(id: string, rules: readonly ScatterRule[]): void {
    this.setSource(id, 'terrain', rules);
  }

  /**
   * Block layer `id`'s cover rules drawn here (an empty list: none), at
   * `origin`, its chunks `chunk` metres a side, those that exist named
   * "cx,cz". A move makes every set again (the rules read world places).
   */
  setPoints(id: string, rules: readonly ScatterRule[], origin: readonly number[], chunk: readonly [number, number], chunks: ReadonlySet<string>): void {
    const src = this.setSource(id, 'points', rules);
    if (src === null || src.kind !== 'points') return;
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const moved = !src.origin.every((v, i) => v === o[i]) || src.chunk[0] !== chunk[0] || src.chunk[1] !== chunk[1];
    src.origin = o;
    src.chunk = [chunk[0], chunk[1]];
    src.chunks = chunks;
    if (!moved) return;
    // The draws place their points from the source's origin: they stand where it stands now (the sets are made again for it).
    for (const rd of src.draws ?? []) {
      for (const ring of rd.rings) {
        for (const pp of ring.values()) {
          pp.root.matrix.makeTranslation(o[0], o[1], o[2]);
          pp.root.updateMatrixWorld(true);
        }
      }
    }
    this.invalidatePoints(id, null);
  }

  private setSource(id: string, kind: Source['kind'], rules: readonly ScatterRule[]): Source | null {
    const key = JSON.stringify(rules);
    let src = this.sources.get(id);
    if (src !== undefined && src.kind === kind && src.rulesKey === key) return src;
    if (src !== undefined) this.remove(id);
    if (rules.length === 0) return null;
    const base = { id, rules, rulesKey: key, hidden: false, draws: null, eye: uniform(new THREE.Vector2()), planned: '' };
    src = kind === 'terrain' ? { ...base, kind, masks: null } : { ...base, kind, origin: [0, 0, 0], chunk: [1, 1], chunks: new Set(), atlases: new Map(), pointNodes: new Map() };
    this.sources.set(id, src);
    this.deps.changed?.();
    return src;
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
    if (src.kind === 'terrain') this.dropMasks(src);
    else for (const a of src.atlases.values()) a.dispose();
    this.sources.delete(id);
  }

  /**
   * Terrain `id`'s masks over a box (world XZ; null: all) are made again
   * (its ground, a band, a block cut or a region changed); each keeps
   * drawing until its new one arrives.
   */
  invalidateMasks(id: string, rect: readonly [number, number, number, number] | null): void {
    const src = this.sources.get(id);
    if (src?.kind !== 'terrain' || src.masks === null) return;
    const surface = rect === null ? null : this.deps.surface(id);
    for (const e of src.masks.entries.values()) {
      if (rect !== null && surface !== null) {
        const T = surface.tileSize;
        const x0 = (surface.origin[0] ?? 0) + e.tx * T;
        const z0 = (surface.origin[2] ?? 0) + e.tz * T;
        if (rect[0] >= x0 + T || rect[2] <= x0 || rect[1] >= z0 + T || rect[3] <= z0) continue;
      }
      e.stale = true;
      e.asked = false;
      e.token += 1;
    }
    this.deps.changed?.();
  }

  /** Block layer `id`'s point sets over a box (world XZ; null: all) are made again; each keeps drawing until its new one arrives. */
  invalidatePoints(id: string, rect: readonly [number, number, number, number] | null): void {
    const src = this.sources.get(id);
    if (src?.kind !== 'points') return;
    const [w, d] = src.chunk;
    for (const atlas of src.atlases.values()) {
      for (const e of atlas.entries.values()) {
        const x0 = src.origin[0] + e.cx * w;
        const z0 = src.origin[2] + e.cz * d;
        if (rect !== null && (rect[0] >= x0 + w || rect[2] <= x0 || rect[1] >= z0 + d || rect[3] <= z0)) continue;
        atlas.invalidate(e);
      }
    }
    this.deps.changed?.();
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /** List each ring's patches round the view's eye (once a frame). */
  update(view: CullView): void {
    if (this.disposed || this.sources.size === 0) return;
    const t0 = performance.now();
    this.frame += 1;
    for (const src of this.sources.values()) {
      if (src.kind === 'terrain') this.updateTerrain(src, view);
      else this.updatePoints(src, view);
    }
    this.listMs = performance.now() - t0;
  }

  private updateTerrain(src: TerrainSource, view: CullView): void {
    const surface = this.deps.surface(src.id);
    if (surface === null) return;
    if (src.masks !== null && src.masks.side !== coverMaskSide(surface.samples)) {
      this.clear(src);
      this.dropMasks(src);
    }
    src.masks ??= { side: coverMaskSide(surface.samples), texture: null, node: texture(NO_MASKS), layers: 0, free: [], entries: new Map() };
    const planned = `${surface.tileSize}|${this.deps.tuning?.bias ?? 1}|${surface.origin.join(',')}`;
    if (src.draws !== null && src.planned !== planned) this.clear(src);
    if (src.draws === null && !this.plan(src, surface.tileSize)) return;
    src.planned = planned;
    const o = surface.origin;
    const eye: [number, number] = [view.eye[0]! - (o[0] ?? 0), view.eye[2]! - (o[2] ?? 0)];
    (src.eye.value as THREE.Vector2).set(eye[0], eye[1]);
    const visible = (x: number, y: number, z: number, r: number): boolean => view.side(x + (o[0] ?? 0), y + (o[1] ?? 0), z + (o[2] ?? 0), r) !== SphereSide.Outside;
    for (const rd of src.draws!) {
      const rise = rd.model.radius * 2 * Math.max(...(rd.rule.scale ?? [1, 1]));
      // A tile is listed with the rule's mask layer there; one whose mask is on its way is not drawn yet.
      const ref = { page: 0, layer: 0, low: 0, high: 0, mask: -1 };
      const tileAt = (tx: number, tz: number, x0: number, z0: number, x1: number, z1: number): CoverTileRef | undefined => {
        const t = surface.tileAt(tx, tz, x0, z0, x1, z1);
        if (t === undefined || t.layer < 0) return t;
        const mask = this.maskOf(src, rd.rule, tx, tz);
        if (mask === undefined) return undefined;
        ref.page = t.page;
        ref.layer = t.layer;
        ref.low = t.low;
        ref.high = t.high;
        ref.mask = mask;
        return ref;
      };
      rd.plan.rings.forEach((ring, k) => {
        this.lists.clear();
        listCoverPatches(ring, eye, surface.tileSize, rise, tileAt, visible, this.lists);
        const byPage = rd.rings[k]!;
        for (const [page, pp] of byPage) if (!this.lists.has(page)) this.write(src, pp, 0);
        for (const [page, list] of this.lists) {
          const tex = surface.pages[page];
          if (tex === undefined) continue;
          let pp = byPage.get(page);
          if (pp !== undefined && pp.bound !== tex.heights) {
            this.dropPage(pp);
            byPage.delete(page);
            pp = undefined;
          }
          if (pp === undefined) {
            const masks = src.masks!.node;
            const maskSide = src.masks!.side;
            pp = this.makePage(src, rd, k, Math.max(1, Math.ceil(ring.maxPatches / PATCH_ROW)), surface.origin, tex.heights, (part, patches) =>
              coverDrawPlacement({ ring, plan: rd.plan, rule: rd.rule, seed: scatterRuleSeed(rd.rule), surface, page: tex, patches, masks, maskSide, eye: src.eye, local: part.local.clone() }),
            );
            byPage.set(page, pp);
          }
          const n = Math.min(list.length, pp.data.length / 4);
          const out = this.scratch(n);
          for (let i = 0; i < n; i++) {
            const p = list[i]!;
            out[i * 4] = p.gx;
            out[i * 4 + 1] = p.gz;
            out[i * 4 + 2] = p.layer;
            out[i * 4 + 3] = p.mask;
          }
          this.write(src, pp, n);
        }
      });
    }
    this.forgetMasks(src);
  }

  private updatePoints(src: PointSource, view: CullView): void {
    const [W, D] = src.chunk;
    const planned = `${W}|${this.deps.tuning?.bias ?? 1}`;
    if (src.draws !== null && src.planned !== planned) this.clear(src);
    if (src.draws === null && !this.plan(src, W)) return;
    src.planned = planned;
    const o = src.origin;
    const ex = view.eye[0]! - o[0];
    const ez = view.eye[2]! - o[2];
    (src.eye.value as THREE.Vector2).set(ex, ez);
    for (const rd of src.draws!) {
      let atlas = src.atlases.get(rd.rule.id);
      if (atlas === undefined) {
        src.atlases.set(rd.rule.id, (atlas = new CoverPointAtlas()));
        src.pointNodes.set(rd.rule.id, texture(atlas.texture));
      }
      const points = src.pointNodes.get(rd.rule.id)!;
      const reach = rd.plan.thinning.reach;
      const rise = rd.model.radius * 2 * Math.max(...(rd.rule.scale ?? [1, 1]));
      // The chunks the rule's reach meets: their sets asked for (again where their ground changed).
      const near: { e: ReturnType<CoverPointAtlas['entry']>; dmin: number; dmax: number }[] = [];
      for (let cz = Math.floor((ez - reach) / D); cz <= Math.floor((ez + reach) / D); cz++) {
        for (let cx = Math.floor((ex - reach) / W); cx <= Math.floor((ex + reach) / W); cx++) {
          if (!src.chunks.has(`${cx},${cz}`)) continue;
          const dx = Math.max(cx * W - ex, 0, ex - (cx + 1) * W);
          const dz = Math.max(cz * D - ez, 0, ez - (cz + 1) * D);
          const dmin = Math.hypot(dx, dz);
          if (dmin >= reach) continue;
          const e = atlas.entry(cx, cz, this.frame);
          if (e.stale && !e.asked) this.askPoints(src, rd.rule, atlas, e);
          if (e.set === null || e.set.count === 0) continue;
          const fx = Math.max(Math.abs(cx * W - ex), Math.abs((cx + 1) * W - ex));
          const fz = Math.max(Math.abs(cz * D - ez), Math.abs((cz + 1) * D - ez));
          // Culled by its box (the points' heights and the copies' rise over them).
          const half = (e.set.high - e.set.low + rise) / 2;
          if (view.side(o[0] + (cx + 0.5) * W, o[1] + (e.set.low + e.set.high + rise) / 2, o[2] + (cz + 0.5) * D, Math.sqrt((W * W + D * D) / 4 + half * half)) === SphereSide.Outside) continue;
          near.push({ e, dmin, dmax: Math.hypot(fx, fz) });
        }
      }
      rd.plan.rings.forEach((ring, k) => {
        const byPage = rd.rings[k]!;
        let pp = byPage.get(0);
        if (pp === undefined) {
          pp = this.makePage(src, rd, k, Math.max(1, Math.ceil(atlas.capacity / PATCH_ROW)), o, null, (part, blocks) => coverPointsPlacement({ ring, plan: rd.plan, rule: rd.rule, blocks, points, chunk: [W, D], eye: src.eye, local: part.local.clone() }));
          byPage.set(0, pp);
        } else if (pp.data.length / 4 < atlas.capacity) this.lengthen(pp, Math.ceil(atlas.capacity / PATCH_ROW));
        const out = this.scratch(pp.data.length / 4);
        let n = 0;
        for (const c of near) if (c.dmin < ring.outer && c.dmax >= ring.inner) n = listCoverPointBlocks(ring, c.e, out, n);
        this.write(src, pp, n);
      });
      if (this.frame % 60 === 0) atlas.forget(this.frame);
    }
  }

  private askPoints(src: PointSource, rule: ScatterRule, atlas: CoverPointAtlas, e: ReturnType<CoverPointAtlas['entry']>): void {
    if (this.deps.points === undefined) {
      atlas.store(e, null);
      return;
    }
    e.asked = true;
    const token = e.token;
    this.deps.points(src.id, rule, e.cx, e.cz, (set) => {
      if (this.sources.get(src.id) !== src || src.atlases.get(rule.id) !== atlas || atlas.entries.get(`${e.cx},${e.cz}`) !== e || e.token !== token) return;
      // A grown texture: the draws read the new one (their lists lengthen with it next frame).
      if (atlas.store(e, set)) {
        const node = src.pointNodes.get(rule.id);
        if (node !== undefined) node.value = atlas.texture;
      }
      this.deps.changed?.();
    });
  }

  diagnostics(): CoverGpuDiagnostics {
    let rules = 0;
    let draws = 0;
    let patches = 0;
    let candidates = 0;
    let masks = 0;
    let masksPending = 0;
    let pointSets = 0;
    let points = 0;
    let pointsPending = 0;
    for (const src of this.sources.values()) {
      rules += src.rules.length;
      for (const rd of src.draws ?? []) {
        rd.rings.forEach((byPage) => {
          for (const pp of byPage.values()) {
            if (pp.count === 0 || src.hidden) continue;
            draws += pp.meshes.length;
            patches += pp.count;
            candidates += pp.count * pp.perPatch;
          }
        });
      }
      if (src.kind === 'terrain') {
        for (const e of src.masks?.entries.values() ?? []) {
          if (e.slot >= 0) masks += 1;
          if (e.asked) masksPending += 1;
        }
      } else {
        for (const a of src.atlases.values()) {
          for (const e of a.entries.values()) {
            if (e.set !== null) {
              pointSets += 1;
              points += e.set.count;
            }
            if (e.asked) pointsPending += 1;
          }
        }
      }
    }
    return { sources: this.sources.size, rules, draws, patches, candidates, listMs: Math.round(this.listMs * 100) / 100, masks, masksPending, pointSets, points, pointsPending };
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

  /** Plan a source's rules once their models loaded (false: one is loading); `tile` the side (m) patches are cut to fit. */
  private plan(src: Source, tile: number): boolean {
    const out: RuleDraws[] = [];
    for (const rule of src.rules) {
      const template = this.deps.template(rule.asset.assetId, rule.asset.piece, () => this.deps.changed?.());
      if (template === null) return false;
      const model = instanceSetPlan(template);
      const g = model.groups[0];
      const levels = { distances: g?.distances ?? [0], culls: g?.culls ?? false, radius: model.radius };
      const screenFull = rule.densityStart !== undefined && model.radius > 0 ? model.radius / (TAN_HALF_REFERENCE * rule.densityStart) : undefined;
      const plan = planCover(rule, rule.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT, levels, tile, this.deps.tuning?.bias ?? 1, screenFull);
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

  /** A ring's draws (one per mesh part) over a list texture of `rows` rows, placed by `placement`, built against `bound` (a terrain's page). */
  private makePage(src: Source, rd: RuleDraws, k: number, rows: number, origin: readonly number[], bound: THREE.Texture | null, placement: (part: InstanceSetPlan['parts'][number], list: N) => CoverPlacement): PagePatches {
    const ring = rd.plan.rings[k]!;
    const data = new Float32Array(PATCH_ROW * rows * 4);
    const tex = listTexture(data, rows);
    const list = texture(tex);
    const root = new THREE.Group();
    root.name = `cover-gpu:${src.id}:${rd.rule.id}:${k}`;
    root.matrixAutoUpdate = false;
    const meshes = rd.parts[k]!.map((part) => {
      const mesh = new THREE.Mesh(part.mesh.geometry, part.mesh.material);
      mesh.name = `${root.name}:${part.mesh.name}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = rd.rule.castShadow === true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.userData[COVER_DRAW_KEY] = placement(part, list);
      root.add(mesh);
      return mesh;
    });
    const undress = this.deps.dress?.(root, rd.rule.asset.assetId) ?? null;
    root.matrix.makeTranslation(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    root.updateMatrixWorld(true);
    const pp: PagePatches = { texture: tex, data, list, bound, meshes, undress, root, perPatch: src.kind === 'terrain' ? ring.perPatch : COVER_POINT_BLOCK, count: 0, held: false, dropped: false };
    // A ring the view does not reach yet draws nothing: its programs are built now, with the scene's, not when the view first reaches it.
    if (this.deps.warm !== undefined && meshes.length > 0) this.deps.warm(this.warmDraw(src, pp));
    return pp;
  }

  /** A page's draws held for a precompile: drawn with an entry no copy is kept from, as many copies as a listed draw. */
  private warmDraw(src: Source, pp: PagePatches): WarmDraw {
    return {
      // A ring listing copies drew (and built its programs) in the frame it was made.
      wanted: () => pp.count === 0,
      hold: () => {
        pp.held = true;
        if (pp.count === 0) {
          // A terrain's patch far past every ring; a block layer's block of no points.
          pp.data.set(src.kind === 'terrain' ? [CELL_OFFSET / 2, CELL_OFFSET / 2, 0, -1] : [0, 0, 0, 0]);
          pp.texture.needsUpdate = true;
        }
        for (const m of pp.meshes) {
          (m as unknown as { count: number }).count = Math.max(2, pp.count * pp.perPatch);
          m.visible = true;
        }
        this.deps.place(pp.root, true);
      },
      release: () => {
        pp.held = false;
        this.show(src, pp);
      },
      alive: () => !pp.dropped,
    };
  }

  /** A page's draws as its list says: sized to its copies, a draw of one or none hidden, in the scene while it lists any. */
  private show(src: Source, pp: PagePatches): void {
    this.size(pp);
    this.deps.place(pp.root, !src.hidden && pp.count > 0 && pp.meshes.length > 0);
  }

  /** A list texture of `rows` rows swapped in for a page's shorter one (its entries kept). */
  private lengthen(pp: PagePatches, rows: number): void {
    const data = new Float32Array(PATCH_ROW * rows * 4);
    data.set(pp.data);
    const tex = listTexture(data, rows);
    pp.list.value = tex;
    pp.texture.dispose();
    pp.texture = tex;
    pp.data = data;
  }

  /** The scratch list a frame's entries are written into before {@link write} (at least `n` entries). */
  private scratch(n: number): Float32Array {
    if (this.next.length < n * 4) this.next = new Float32Array(Math.max(n * 4, this.next.length * 2));
    return this.next;
  }

  /** Put the scratch list's first `n` entries in a ring's list texture (only when they changed) and size its draws. */
  private write(src: Source, pp: PagePatches, n: number): void {
    n = Math.min(n, pp.data.length / 4);
    const was = pp.count;
    let same = n === pp.count;
    for (let i = 0; same && i < n * 4; i++) same = pp.data[i] === this.next[i];
    if (!same) {
      pp.data.set(this.next.subarray(0, n * 4));
      pp.texture.needsUpdate = true;
      pp.count = n;
    }
    this.size(pp);
    if ((was > 0) !== (pp.count > 0)) this.deps.place(pp.root, !src.hidden && pp.count > 0 && pp.meshes.length > 0);
  }

  /** A page's draws sized to its copies. */
  private size(pp: PagePatches): void {
    // A draw of one copy or none would be keyed apart from the others (three keys a draw of several by its mesh): hidden instead.
    const copies = pp.count * pp.perPatch;
    for (const m of pp.meshes) {
      (m as unknown as { count: number }).count = copies;
      m.visible = copies > 1;
    }
  }

  private dropPage(pp: PagePatches): void {
    pp.dropped = true;
    if (pp.count > 0 || pp.held) this.deps.place(pp.root, false);
    pp.undress?.();
    pp.texture.dispose();
    for (const m of pp.meshes) m.removeFromParent();
    pp.meshes = [];
  }

  private clear(src: Source): void {
    for (const rd of src.draws ?? []) for (const ring of rd.rings) for (const pp of ring.values()) this.dropPage(pp);
    src.draws = null;
  }

  /** Rule `rule`'s mask layer over tile (tx, tz) (-1: none needed), asking for it when it is wanted; undefined: not arrived yet. */
  private maskOf(src: TerrainSource, rule: ScatterRule, tx: number, tz: number): number | undefined {
    const atlas = src.masks!;
    const key = `${rule.id}|${tx},${tz}`;
    let e = atlas.entries.get(key);
    if (e === undefined) {
      e = { slot: -1, ready: false, stale: true, asked: false, token: 0, used: this.frame, tx, tz };
      atlas.entries.set(key, e);
    }
    e.used = this.frame;
    if (e.stale && !e.asked) {
      if (this.deps.mask === undefined || this.deps.maskWanted?.(src.id, rule, tx, tz) !== true) {
        this.release(atlas, e);
        e.ready = true;
        e.stale = false;
      } else {
        const entry = e;
        const token = e.token;
        e.asked = this.deps.mask(src.id, rule, tx, tz, (data) => {
          if (entry.token !== token || atlas.entries.get(key) !== entry || src.masks !== atlas) return;
          entry.asked = false;
          entry.stale = false;
          entry.ready = true;
          if (data === null) this.release(atlas, entry);
          else this.store(src, atlas, entry, data);
          this.deps.changed?.();
        });
      }
    }
    return e.ready ? e.slot : undefined;
  }

  /** Put a mask in its entry's layer (one taken, the texture grown when full: the draws are made again with it). */
  private store(src: TerrainSource, atlas: MaskAtlas, e: MaskEntry, data: Uint8Array): void {
    const side = atlas.side;
    if (e.slot < 0) {
      if (atlas.free.length === 0) {
        const layers = Math.max(MASK_LAYERS_START, atlas.layers * 2);
        const bytes = new Uint8Array(side * side * layers);
        if (atlas.texture !== null) bytes.set(atlas.texture.image.data as Uint8Array);
        const tex = maskTexture(bytes, side, layers);
        atlas.texture?.dispose();
        atlas.texture = tex;
        atlas.node.value = tex;
        // three uploads only the listed layers once any is listed, even on a texture's first upload: the kept ones are listed too.
        for (let l = 0; l < atlas.layers; l++) tex.addLayerUpdate(l);
        for (let l = layers - 1; l >= atlas.layers; l--) atlas.free.push(l);
        atlas.layers = layers;
      }
      e.slot = atlas.free.pop()!;
    }
    const tex = atlas.texture!;
    (tex.image.data as Uint8Array).set(data, e.slot * side * side);
    tex.addLayerUpdate(e.slot);
    tex.needsUpdate = true;
  }

  private release(atlas: MaskAtlas, e: MaskEntry): void {
    if (e.slot >= 0) atlas.free.push(e.slot);
    e.slot = -1;
  }

  /** Let go of the masks of tiles not listed for a while. */
  private forgetMasks(src: TerrainSource): void {
    const atlas = src.masks;
    if (atlas === null || this.frame % 60 !== 0) return;
    for (const [key, e] of atlas.entries) {
      if (this.frame - e.used <= MASK_KEEP_FRAMES) continue;
      this.release(atlas, e);
      atlas.entries.delete(key);
    }
  }

  private dropMasks(src: TerrainSource): void {
    src.masks?.texture?.dispose();
    src.masks = null;
  }
}
