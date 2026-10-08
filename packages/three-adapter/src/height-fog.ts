/**
 * Exponential height fog — the scene look's `heightFog`: fog whose density
 * falls off with height above a base (`density · e^(−falloff · (y − height))`
 * per metre), summed along each view ray past a start distance, in a colour
 * with an optional glow towards the sun (`inscatterColor`, narrowed by
 * `inscatterExponent`). It thickens with distance and lies low in valleys,
 * so the far edge of a level (terrain at its coarsest level, the end of the
 * streaming rings) and the horizon fade into it.
 *
 * Drawn two ways from the same uniforms:
 * - on every material that takes fog, through the scene's fog node, to the
 *   fragment's own distance; a look with the classic linear/exp2 fog too gets
 *   both in that node (the classic first, the height fog over it);
 * - over the sky, by a dome round the camera just inside its far plane (real
 *   geometry, so every depth buffer kind tests it the same way): it shows
 *   only where nothing nearer was drawn, fogged to its own distance, so the
 *   ground at the edge of view and the sky above it meet in one colour.
 *
 * Everything a look blends is a uniform (no new program while a blend runs);
 * the node is made again only when the classic fog's mode or the sun glow is
 * switched on or off.
 */
import { FOG_DEFAULTS, HEIGHT_FOG_DEFAULTS } from '@thirdlight/runtime';
import * as THREE from 'three';
import { abs, cameraFar, cameraPosition, clamp, densityFogFactor, dot, exp, float, Fn, length, max, min, mix, normalize, output, positionLocal, positionWorld, pow, rangeFogFactor, renderGroup, select, uniform, vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy); values stay three objects. */
type N = any;

/** A look's height fog (project-model `HeightFogConfig`). */
export interface HeightFogLike {
  readonly density: number;
  readonly color: string;
  readonly height?: number;
  readonly falloff?: number;
  readonly start?: number;
  readonly inscatterColor?: string;
  readonly inscatterExponent?: number;
}

/** The classic fog, as the look gives it. */
export interface ClassicFogLike {
  readonly mode: 'none' | 'linear' | 'exp2';
  readonly color: string;
  readonly near?: number;
  readonly far?: number;
  readonly density?: number;
}

export interface HeightFog {
  /**
   * The look's fog: with a height fog, the scene's fog node draws it (and the
   * classic fog given) and the sky dome is in the scene; without, both go and
   * the scene's classic fog draws alone, as before.
   */
  apply(classic: ClassicFogLike | undefined, height: HeightFogLike | undefined): void;
  /** The direction towards the sun (world, unit; null: no sun — no glow). */
  setSun(towardSun: readonly [number, number, number] | null): void;
  /** Whether a height fog is drawn (diagnostics). */
  readonly active: boolean;
  dispose(): void;
}

/** The share of the far distance the sky dome stands at (inside the far plane at the corners of view too). */
const DOME_FAR_SHARE = 0.95;
/** Exponents past this give no more fog (or none) in 32-bit floats: clamped, so a ray far below the base or a steep one never overflows. */
const EXP_LIMIT = 80;

export function createHeightFog(scene: THREE.Scene): HeightFog {
  // Uniforms of the render group: set once a frame, not per object drawn (every lit material reads them).
  const u: Record<'density' | 'color' | 'height' | 'falloff' | 'start' | 'glow' | 'glowExponent' | 'sun' | 'classicColor' | 'classicNear' | 'classicFar' | 'classicDensity', N> = {
    density: uniform(0).setGroup(renderGroup),
    color: uniform(new THREE.Color()).setGroup(renderGroup),
    height: uniform(0).setGroup(renderGroup),
    falloff: uniform(HEIGHT_FOG_DEFAULTS.falloff).setGroup(renderGroup),
    start: uniform(0).setGroup(renderGroup),
    glow: uniform(new THREE.Color(0, 0, 0)).setGroup(renderGroup),
    glowExponent: uniform(HEIGHT_FOG_DEFAULTS.inscatterExponent).setGroup(renderGroup),
    sun: uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup),
    classicColor: uniform(new THREE.Color()).setGroup(renderGroup),
    classicNear: uniform(FOG_DEFAULTS.near).setGroup(renderGroup),
    classicFar: uniform(FOG_DEFAULTS.far).setGroup(renderGroup),
    classicDensity: uniform(FOG_DEFAULTS.density).setGroup(renderGroup),
  };

  /** How much of the light from world point `p` the fog takes on its way to the camera (0–1). */
  const amount: N = Fn(([p]: [N]) => {
    const ray: N = p.sub(cameraPosition);
    const dist: N = length(ray).toVar();
    const dirY: N = ray.y.div(max(dist, 1e-4));
    const skip: N = min(u.start, dist);
    const along: N = dist.sub(skip);
    const y0: N = cameraPosition.y.add(dirY.mul(skip));
    const base: N = u.density.mul(exp(clamp(u.falloff.mul(y0.sub(u.height)).negate(), -EXP_LIMIT, EXP_LIMIT)));
    // ∫ e^(−k·dirY·s) ds over the ray, divided by its length: 1 when level (or no falloff).
    const t: N = clamp(u.falloff.mul(dirY).mul(along), -EXP_LIMIT, EXP_LIMIT).toVar();
    const shape: N = select(abs(t).lessThan(1e-3), float(1).sub(t.mul(0.5)), float(1).sub(exp(t.negate())).div(t));
    return float(1).sub(exp(base.mul(along).mul(shape).negate()));
  });
  /** The fog's colour seen along the ray to `p` (the glow round the sun). */
  const tint = (glow: boolean): N =>
    Fn(([p]: [N]) => {
      if (!glow) return u.color;
      const dir: N = normalize(p.sub(cameraPosition));
      return u.color.add(u.glow.mul(pow(max(dot(dir, u.sun), 0), u.glowExponent)));
    });

  let structure = '';
  let dome: THREE.Mesh | null = null;
  let active = false;

  const build = (classic: ClassicFogLike['mode'], glow: boolean): void => {
    const colour: N = tint(glow);
    scene.fogNode = Fn(() => {
      let rgb: N = output.rgb as N;
      if (classic === 'linear') rgb = mix(rgb, u.classicColor, rangeFogFactor(u.classicNear, u.classicFar));
      else if (classic === 'exp2') rgb = mix(rgb, u.classicColor, densityFogFactor(u.classicDensity));
      return vec4(mix(rgb, colour(positionWorld), amount(positionWorld) as N), (output as N).a);
    })() as THREE.Scene['fogNode'];
    disposeDome();
    const m = new MeshBasicNodeMaterial();
    // A unit sphere round the camera, scaled to just inside the far plane.
    m.positionNode = positionLocal.mul(cameraFar.mul(DOME_FAR_SHARE)).add(cameraPosition);
    m.colorNode = colour(positionWorld);
    m.opacityNode = amount(positionWorld);
    m.side = THREE.BackSide;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), m);
    dome.name = 'tl-height-fog-dome';
    dome.frustumCulled = false;
    dome.castShadow = false;
    dome.receiveShadow = false;
    // Last of the transparent things: fog over whatever sky shows behind them.
    dome.renderOrder = Number.MAX_SAFE_INTEGER;
    dome.matrixAutoUpdate = false;
    dome.raycast = () => undefined;
    scene.add(dome);
  };
  const disposeDome = (): void => {
    if (dome === null) return;
    scene.remove(dome);
    dome.geometry.dispose();
    (dome.material as THREE.Material).dispose();
    dome = null;
  };
  const clear = (): void => {
    if (structure !== '') scene.fogNode = null;
    structure = '';
    disposeDome();
    active = false;
  };

  return {
    apply(classic, height) {
      if (height === undefined) {
        clear();
        return;
      }
      const mode = classic?.mode ?? 'none';
      const glow = height.inscatterColor !== undefined;
      u.density.value = height.density;
      u.color.value.set(height.color);
      u.height.value = height.height ?? HEIGHT_FOG_DEFAULTS.height;
      u.falloff.value = height.falloff ?? HEIGHT_FOG_DEFAULTS.falloff;
      u.start.value = height.start ?? HEIGHT_FOG_DEFAULTS.start;
      u.glow.value.set(height.inscatterColor ?? '#000000');
      u.glowExponent.value = height.inscatterExponent ?? HEIGHT_FOG_DEFAULTS.inscatterExponent;
      if (classic !== undefined && mode !== 'none') {
        u.classicColor.value.set(classic.color);
        u.classicNear.value = classic.near ?? FOG_DEFAULTS.near;
        u.classicFar.value = classic.far ?? FOG_DEFAULTS.far;
        u.classicDensity.value = classic.density ?? FOG_DEFAULTS.density;
      }
      const key = `${mode}|${glow}`;
      if (key !== structure) {
        structure = key;
        build(mode, glow);
      }
      active = true;
    },
    setSun(toward) {
      // No sun: a zero direction, so the glow term is nothing.
      if (toward === null) u.sun.value.set(0, 0, 0);
      else u.sun.value.set(toward[0], toward[1], toward[2]).normalize();
    },
    get active() {
      return active;
    },
    dispose: clear,
  };
}
