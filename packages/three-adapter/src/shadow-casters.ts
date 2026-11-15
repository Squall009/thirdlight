/**
 * Which drawables cast into the cached static shadow map, and the revision
 * that says it must be drawn again.
 *
 * The key light's shadow is two maps (`cached-shadow.ts`): a static one drawn
 * only when what it shows changed, and a dynamic one drawn every frame. A
 * drawable belongs to the static map when its object never moves and nothing
 * moves its vertices:
 *
 * - the meshes of `static` objects (`STATIC_KEY`, set by the host), and what
 *   stands for them: merged static cells, instanced batches whose members are
 *   all static, a static object's instance sets (`STATIC_CASTER_KEY`);
 * - block-layer chunks: they change only by being re-meshed, which lists new
 *   chunk meshes;
 * - never skinned meshes, the parts of an animated hierarchy
 *   (`MOVING_CASTER_KEY`, set by the render graph), or a material that moves
 *   its vertices (wind, a graph's vertex offset: `positionNode`) or whose
 *   alpha changes with time (`CHANGING_ALPHA_KEY`).
 *
 * Whatever changes what the static map shows is reported here, and the map is
 * drawn again on the next frame:
 *
 * - where it happened, when that is known (`touched`): a static drawable
 *   entering or leaving the scene where it stands (a LOD switch, a hide, a
 *   block chunk meshed again). Only a change within the map's reach draws it
 *   again, so levels switching far away while the camera walks cost nothing;
 * - anywhere (`bump`): a static drawable's world matrix written (an editor or
 *   script move, a load), a merged cell built or dropped, a batch turning
 *   static, the static marks set.
 */
import * as THREE from 'three';

import { staticScopeOf } from './static-merge';

/** `object.userData[STATIC_CASTER_KEY]`: casts into the static map though it carries no static scope (cells, static batches, instance sets, chunks). */
export const STATIC_CASTER_KEY = '__tlStaticCaster';

/** `object.userData[MOVING_CASTER_KEY]`: posed every frame (an animated hierarchy's part): never in the static map. */
export const MOVING_CASTER_KEY = '__tlMovingCaster';

/**
 * `material.userData[CHANGING_ALPHA_KEY]`: its opacity or alpha clip reads the
 * clock (set by the material library from the compiled graph): what it cuts
 * out of its shadow changes with time.
 */
export const CHANGING_ALPHA_KEY = '__tlChangingAlpha';

/**
 * `material.userData[STEADY_SHAPE_KEY]`: its position node places vertices
 * from data its owner reports changing (a terrain's height textures, whose
 * owner redraws the static map after a sculpt), not from the clock: it casts
 * into the static map like a mesh that never moves.
 */
export const STEADY_SHAPE_KEY = '__tlSteadyShape';

/**
 * A material whose shadow can change every frame on its own: it moves its
 * vertices in its own shader (wind, a vertex offset) or its alpha changes with
 * time.
 */
function changesOwnShadow(m: THREE.Material | null | undefined): boolean {
  if (m === null || m === undefined) return false;
  const n = m as { positionNode?: unknown; castShadowPositionNode?: unknown };
  const moves = m.userData[STEADY_SHAPE_KEY] !== true && ((n.positionNode !== null && n.positionNode !== undefined) || (n.castShadowPositionNode !== null && n.castShadowPositionNode !== undefined));
  return moves || m.userData[CHANGING_ALPHA_KEY] === true;
}

/** Whether `o` is drawn into the cached static shadow map (else into the dynamic one). */
export function isStaticCaster(o: THREE.Object3D): boolean {
  const u = o.userData;
  if (u[MOVING_CASTER_KEY] === true) return false;
  if (u[STATIC_CASTER_KEY] !== true && staticScopeOf(o) === null) return false;
  if ((o as THREE.SkinnedMesh).isSkinnedMesh === true) return false;
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(m)) {
    for (const x of m) if (changesOwnShadow(x)) return false;
    return true;
  }
  return !changesOwnShadow(m);
}

/** A signature of what `o` draws its shadow with: its material(s) and their versions (a change in place bumps a version). */
function shadowLookOf(o: THREE.Object3D): number {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (m === undefined || m === null) return 0;
  if (!Array.isArray(m)) return m.version;
  let v = m.length;
  for (const x of m) v = (v * 31 + x.version) | 0;
  return v;
}

/**
 * The casters a static map was drawn with and what each wore (its material
 * and their versions). A change made in place, which reports nothing (a
 * texture arriving, a graph compiled again, a material swapped, wind or a
 * clock-driven alpha gained), shows as a different material or version, or a
 * caster no longer static, and the map is drawn again.
 */
export class DrawnCasters {
  private readonly drawn = new Map<THREE.Object3D, { material: unknown; look: number }>();

  /** The map is being drawn again: forget the last drawing. */
  clear(): void {
    this.drawn.clear();
  }

  /** `o` was drawn into the map now. */
  add(o: THREE.Object3D): void {
    this.drawn.set(o, { material: (o as THREE.Mesh).material, look: shadowLookOf(o) });
  }

  has(o: THREE.Object3D): boolean {
    return this.drawn.has(o);
  }

  /** Whether a caster drawn has since changed what its shadow looks like, or stopped being static. */
  changed(): boolean {
    for (const [o, w] of this.drawn) {
      if ((o as THREE.Mesh).material !== w.material || shadowLookOf(o) !== w.look || !isStaticCaster(o)) return true;
    }
    return false;
  }
}

/** Changes reported where they happened that are kept between two looks at most (more count as anywhere). */
const CHANGES_KEPT = 4096;

/** The changes reported where they happened since the local lights' shadow atlas last took them. */
export interface LocalShadowChanges {
  /** Spheres, x, y, z, r each (world metres). */
  readonly spheres: ArrayLike<number>;
  /** More were reported than are kept: count them as a change everywhere. */
  readonly all: boolean;
}

/** What changed among the static shadow casters since the map last looked. */
export class StaticShadowRevision {
  /** Bumped by a change anywhere (the map compares it with the one it was drawn at). */
  value = 0;
  /** World bounds of the changes reported where they happened, since the last `drain` (the first `used`). */
  private readonly spheres: THREE.Sphere[] = [];
  private used = 0;
  /** Holds in force (`hold`): changes are kept, not drained, until the last is let go. */
  private holds = 0;
  /**
   * The same changes for the shadow atlas (x, y, z, r each), kept apart from the key light's: the two read them at
   * different points of the frame, and a page with no shadowed local light never takes them (they then stop at the
   * cap as "everywhere", which costs nothing until a light asks).
   */
  private local: number[] = [];
  private localTaken: number[] = [];
  private localAll = false;

  /**
   * Hold the changes back (true) or let them go (false; holds count): while
   * held, reported changes and static casters the map does not hold yet draw
   * the map nothing, and when the last hold goes they draw it once. A bulk
   * re-mesh (a kit swapped) holds while its chunks arrive over several
   * frames, so the map is drawn once, not once a frame.
   */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
  }

  get holding(): boolean {
    return this.holds > 0;
  }

  /** A change anywhere. */
  bump(): void {
    this.value += 1;
  }

  /** `o` entered or left the scene where it stands (its world matrix is current); without bounds it counts as anywhere. */
  touched(o: THREE.Object3D): void {
    const m = o as THREE.Mesh & { isInstancedMesh?: boolean; boundingSphere?: THREE.Sphere | null; computeBoundingSphere?: () => void };
    let local: THREE.Sphere | null | undefined;
    if (m.isInstancedMesh === true) {
      if (m.boundingSphere === null) m.computeBoundingSphere?.();
      local = m.boundingSphere;
    } else if (m.geometry !== undefined) {
      if (m.geometry.boundingSphere === null) m.geometry.computeBoundingSphere();
      local = m.geometry.boundingSphere;
    }
    if (local === null || local === undefined) {
      this.bump();
      return;
    }
    const s = this.spheres[this.used] ?? (this.spheres[this.used] = new THREE.Sphere());
    this.used += 1;
    // Its radius scaled by the largest axis scale (three's own bound for a transformed sphere).
    s.copy(local).applyMatrix4(o.matrixWorld);
    if (!Number.isFinite(s.radius) || !Number.isFinite(s.center.x + s.center.y + s.center.z)) this.bump();
    else this.keepLocal(s.center.x, s.center.y, s.center.z, s.radius);
  }

  /** A change within the sphere at (x, y, z) of `radius` (world metres): a terrain tile's ground came, went or changed there. */
  changedWithin(x: number, y: number, z: number, radius: number): void {
    this.keepLocal(x, y, z, radius);
    // Changes nothing drains (no cached map to draw) are not kept without end: past a few thousand, anywhere.
    if (this.used >= CHANGES_KEPT) {
      this.used = 0;
      this.bump();
      return;
    }
    const s = this.spheres[this.used] ?? (this.spheres[this.used] = new THREE.Sphere());
    this.used += 1;
    s.center.set(x, y, z);
    s.radius = radius;
  }

  private keepLocal(x: number, y: number, z: number, r: number): void {
    if (this.localAll) return;
    if (this.local.length >= CHANGES_KEPT * 4) {
      this.local.length = 0;
      this.localAll = true;
      return;
    }
    this.local.push(x, y, z, r);
  }

  /**
   * The changes reported where they happened since the last call, for the shadow atlas: a local light's tile (a
   * face of it) whose view one reaches is drawn again; the next call forgets them. The spheres are valid until then.
   */
  takeLocal(): LocalShadowChanges {
    const out = { spheres: this.local, all: this.localAll };
    [this.local, this.localTaken] = [this.localTaken, this.local];
    this.local.length = 0;
    this.localAll = false;
    return out;
  }

  /** Whether a change reported where it happened lies within `reach`, and forget them. */
  drain(reach: ((s: THREE.Sphere) => boolean) | null): boolean {
    if (this.holds > 0 && reach !== null) return false;
    let hit = false;
    if (reach !== null) for (let i = 0; i < this.used && !hit; i += 1) hit = reach(this.spheres[i]!);
    this.used = 0;
    return hit;
  }
}

/**
 * What draws hung under a scene outside its render graph (a voxel world's chunks, voxel-world-draws.ts) need of its
 * shadows: where to report a change of their static casters (null: the scene draws every caster into one map every
 * frame), and how they tell the ground under a point (the key light's shadow square is centred on it; null: none
 * known there). The scene adapter keeps the link on its scene, as it keeps the voxel worlds' decal link.
 */
export interface SceneShadowLink {
  readonly revision: StaticShadowRevision | null;
  /** The height (world metres) of the ground under (x, z), set by whoever knows it (null: the scene's plane, y = 0). */
  ground: ((x: number, z: number) => number | null) | null;
}

const shadowLinks = new WeakMap<object, SceneShadowLink>();

/** Keep `link` on `scene` (null: take it off). */
export function attachSceneShadows(scene: object, link: SceneShadowLink | null): void {
  if (link === null) shadowLinks.delete(scene);
  else shadowLinks.set(scene, link);
}

/** The shadow link kept on `scene` (null: none, the scene casts no shadow its adapter knows of). */
export function sceneShadowsOf(scene: object): SceneShadowLink | null {
  return shadowLinks.get(scene) ?? null;
}

/** The page flag that draws every caster into one shadow map every frame (`?shadowcache=off`: a diagnostic comparison). */
export const SHADOW_CACHE_URL_PARAM = 'shadowcache';

/** Whether `renderer` is inside a precompile (`compileAsync` collecting or building its work): shadow maps are not drawn then. */
export function isPreCompiling(renderer: unknown): boolean {
  return ((renderer as { _precompilationState?: unknown } | null)?._precompilationState ?? null) !== null;
}
