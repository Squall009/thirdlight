/**
 * The foliage shader type's vertex stage: the wind bends a plant.
 *
 * COLOR_0 is data (R bend weight root→tip, G phase, B flutter, A thinness:
 * a small translucency term). The bend is the wind field's strength (gusts
 * included) where the vertex stands, times its bend weight squared, times
 * its height above the plant's root (a GPU copy's place, an instance's
 * origin, else the object's), so tall grass and scaled-up copies bend
 * further than short ones. A mesh without COLOR_0 sways by its height share
 * of the first metre instead. On top of the wind, the plant gives way to the
 * view's subjects by the same weight and height (`foliage-bend.ts`).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import type { MeshStandardNodeMaterial, NodeBuilder } from 'three/webgpu';

import type { N } from './effects-tsl';
import { OBJECT_FRAME_KEY } from './static-merge';
import { declareVertexReach } from './vertex-reach';
import { needsPreviousPlace, OWN_PREVIOUS_POSITION_KEY } from './motion-vectors';
import { FOLIAGE_FALLBACK_HEIGHT_M, type FoliageBend } from './foliage-bend';
import { copyBend, copyRoot, copySurface, ROOT_COLOUR_KEY } from './node-materials';
import type { WindField } from './wind-field';

/**
 * The foliage shader's sway: metres a vertex bends by at full strength and bend, the share of that it sags, and
 * metres it flutters along its normal. Its reach (how far a vertex may move, which occlusion culling's bounds take)
 * is worked out from the same numbers.
 */
const FOLIAGE_BEND_M = 0.12;
const FOLIAGE_SAG = 0.35;
const FOLIAGE_FLUTTER_M = 0.015;

/** A mesh's height in the world (its geometry's bounds times its world scale up): the most a vertex stands above its root. */
function meshHeight(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  if (g.boundingBox === null) g.computeBoundingBox();
  const b = g.boundingBox!;
  const e = mesh.matrixWorld.elements;
  return Math.max(0, b.max.y - Math.min(0, b.min.y)) * Math.hypot(e[4]!, e[5]!, e[6]!);
}

/** The library's shared uniforms the foliage reads: the clock (and its value a frame ago) and the view's eye. */
export interface FoliageGlobals {
  readonly time: N;
  /** The clock as the last frame drawn read it: the sway's previous place, for motion vectors. */
  readonly timePrevious: N;
  readonly eye: N;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** COLOR_0 as data (a missing attribute reads (0, 0, 0, 1), as WebGL's default vertex attribute does). */
const vertexData = TSL.Fn((builder: NodeBuilder) => ((builder as unknown as { geometry: THREE.BufferGeometry }).geometry.hasAttribute('color') ? TSL.attribute('color', 'vec4') : TSL.vec4(0, 0, 0, 1)));

/** Whether the drawn geometry carries COLOR_0 (the wind's weights). */
const hasVertexData = (builder: NodeBuilder): boolean => (builder as unknown as { geometry: THREE.BufferGeometry }).geometry.hasAttribute('color');

export function installFoliage(m: THREE.MeshStandardMaterial, p: Readonly<Record<string, unknown>>, g: FoliageGlobals, windField: WindField, bendField: FoliageBend): void {
  // The bend is the wind field's strength (gusts included) times the vertex's bend weight (COLOR_0 R, squared)
  // times its height above the plant's root, so a tall plant (or a copy scaled up) bends further than a short
  // one; `windBend` / `windFlutter` scale it per material (0–4×). A mesh without COLOR_0 sways by its height
  // share of the first metre, in fixed metres.
  const bend = TSL.uniform(num(p['windBend'], 1));
  const flutter = TSL.uniform(num(p['windFlutter'], 1));
  const flutterFreq = TSL.uniform(num(p['flutterFrequency'], 6));
  const subsurface = TSL.uniform(num(p['subsurface'], 0.3));
  const colour = vertexData();
  const nm = m as unknown as MeshStandardNodeMaterial;
  // The height above the root reads the object's own frame: never merged into world space with others.
  m.userData[OBJECT_FRAME_KEY] = true;
  // Instancing is applied before positionNode: positionLocal is already the
  // instance's, so modelWorldMatrix alone takes it to the world.
  // Wind only near the camera (`windDistance`, 0: everywhere): past it a vertex skips the wind's work and stands still.
  const windDistance = TSL.uniform(num(p['windDistance'], 0));
  // Motion vectors: the sway's own motion is the offset now against the offset at the last frame's clock (the wind
  // field and the subjects' push read as they are now: they change slowly against the sway).
  m.userData[OWN_PREVIOUS_POSITION_KEY] = true;
  nm.positionNode = TSL.Fn((builder: NodeBuilder) => {
    const weighted = hasVertexData(builder);
    const previous = needsPreviousPlace(builder);
    const local = TSL.positionLocal;
    const world = TSL.modelWorldMatrix.mul(TSL.vec4(local, 1)).xyz;
    const root = TSL.modelWorldMatrix.mul(TSL.vec4(copyRoot(), 1)).xyz;
    const out = TSL.vec3(local).toVar();
    // What the vertex had moved by from its rest place on the last frame (object space).
    const before = previous ? TSL.vec3(0).toVar() : null;
    const height = TSL.max(world.y.sub(root.y), 0).toVar();
    const share = TSL.clamp(height.div(FOLIAGE_FALLBACK_HEIGHT_M), 0, 1);
    // How far the vertex can lean (metres): its bend weight squared times its height above its root.
    const capacity = (weighted ? colour.r.mul(colour.r) : share.mul(share)).mul(height).toVar();
    const away = TSL.length(g.eye.sub(world));
    TSL.If(windDistance.lessThanEqual(0).or(away.lessThan(windDistance)), () => {
      const near = windDistance.lessThanEqual(0).select(TSL.float(1), TSL.float(1).sub(TSL.smoothstep(windDistance.mul(0.8), windDistance, away)));
      const tlBend = weighted ? capacity.mul(bend) : share.mul(share).mul(bend);
      const phase = colour.g.mul(6.2831853);
      // Read once for both clocks (a variable only then: the program without motion vectors stays as it was).
      const sampled = windField.sample(TSL.vec2(world.x, world.z));
      const wind = previous ? sampled.toVar() : sampled;
      const strength = wind.z.mul(near);
      const normalWorld = TSL.normalize(TSL.modelWorldMatrix.mul(TSL.vec4(TSL.normalLocal, 0)).xyz);
      /** The sway's offset (object space) at clock `t`. */
      const offsetAt = (t: N): N => {
        const sway = TSL.sin(t.mul(1.7).add(phase).add(world.x.mul(0.4).mul(wind.w))).mul(0.35);
        const bent = TSL.vec3(wind.x, 0, wind.y).mul(strength).mul(sway.add(0.65)).mul(tlBend).mul(FOLIAGE_BEND_M);
        const sagged = bent.sub(TSL.vec3(0, TSL.length(bent).mul(FOLIAGE_SAG), 0));
        const flutterAmount = TSL.sin(t.mul(flutterFreq).add(phase.mul(3)).add(world.x.mul(2.3))).mul(colour.b).mul(flutter).mul(FOLIAGE_FLUTTER_M).mul(strength.add(near.mul(0.5)));
        return TSL.modelWorldMatrixInverse.mul(TSL.vec4(sagged.add(normalWorld.mul(flutterAmount)), 0)).xyz;
      };
      out.assign(local.add(offsetAt(g.time)));
      before?.assign(offsetAt(g.timePrevious));
    });
    // Round the view's subjects (none live, or a vertex that cannot lean: a root, a dropped cover candidate: skipped),
    // from the plant's rest pose, on top of the wind.
    TSL.If(bendField.live.greaterThan(0).and(capacity.greaterThan(0)), () => {
      const pushed = TSL.modelWorldMatrixInverse.mul(TSL.vec4(bendField.offset(world, height, capacity.mul(copyBend())), 0)).xyz;
      if (before === null) out.addAssign(pushed);
      else {
        const p = pushed.toVar();
        out.addAssign(p);
        before.addAssign(p);
      }
    });
    if (before !== null) TSL.positionPrevious.assign(TSL.positionPrevious.add(before));
    return out;
  })();
  installRootColour(nm, p);
  const thin = TSL.varying(colour.a);
  nm.emissiveNode = TSL.materialEmissive.add(TSL.diffuseColor.rgb.mul(subsurface).mul(thin).mul(0.25));
  // The most the sway above moves a vertex now (occlusion culling grows the draw's bounds by it): every factor at
  // its largest (COLOR_0 at 1, the sway's sine at 1, the strongest wind the field holds, the wind near, the mesh's
  // full height above its root), the sag and the flutter added.
  declareVertexReach(m, (mesh) => {
    const wind = windField.maxAmount();
    const tall = mesh === undefined ? FOLIAGE_FALLBACK_HEIGHT_M : Math.max(FOLIAGE_FALLBACK_HEIGHT_M, meshHeight(mesh));
    const sway = wind * Math.max(0, bend.value as number) * FOLIAGE_BEND_M * tall * Math.hypot(1, FOLIAGE_SAG);
    return sway + Math.max(0, flutter.value as number) * FOLIAGE_FLUTTER_M * (wind + 0.5) + bendField.reach(tall);
  });
}

/**
 * `rootColour` (0: off): a ground-cover copy's base blends toward the colour of the surface under its root (the
 * placement's `copySurface`), by `rootColour` at the root fading to none at `rootColourHeight` of COLOR_0 R, so
 * the tips keep the material's own colour. A draw whose placement knows no surface (a placed model, stored
 * scatter, a block layer's points) or a mesh without COLOR_0 draws the material's colour unchanged. The blend weight and colour are worked
 * out per vertex and handed on in one varying.
 */
function installRootColour(nm: MeshStandardNodeMaterial, p: Readonly<Record<string, unknown>>): void {
  const amount = Math.min(1, Math.max(0, num(p['rootColour'], 0)));
  if (amount <= 0) return;
  (nm as unknown as THREE.Material).userData[ROOT_COLOUR_KEY] = true;
  const strength = TSL.uniform(amount);
  const height = TSL.uniform(Math.min(1, Math.max(0.01, num(p['rootColourHeight'], 0.4))));
  nm.colorNode = TSL.Fn((builder: NodeBuilder) => {
    const surface = copySurface(builder);
    // Without COLOR_0 nothing says where the base ends: the material's colour as it is.
    if (surface === null || !hasVertexData(builder)) return TSL.materialColor;
    const tint = TSL.varying(TSL.vec4(surface.rgb, rootBlend(TSL.attribute('color', 'vec4').r, strength, height).mul(surface.a)));
    // The material's colour as three makes it (its map's alpha kept for cutouts).
    const own = TSL.vec4(TSL.materialColor as unknown as N);
    return TSL.vec4(TSL.mix(own.rgb, tint.rgb, tint.a), own.a);
  })() as MeshStandardNodeMaterial['colorNode'];
}

/** The base's blend weight toward the surface: `strength` at the root (height share 0), none from `height` up (smooth). */
export const rootBlend = (share: N, strength: N, height: N): N => strength.mul(TSL.float(1).sub(TSL.smoothstep(0, height, share)));

/** {@link rootBlend} on the CPU (its reference). */
export function rootBlendAt(share: number, strength: number, height: number): number {
  const t = Math.min(1, Math.max(0, share / height));
  return strength * (1 - t * t * (3 - 2 * t));
}
