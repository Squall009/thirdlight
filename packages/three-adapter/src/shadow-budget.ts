/**
 * Shadowed point and spot lights per view: a budget of shadow maps drawn,
 * the best placed lights first, shadows fading out with distance, and a
 * map drawn again only when what it shows can have changed.
 *
 * A point light's shadow is six views of the scene, a spot light's one: a
 * level with a dozen lamps casting shadows draws more shadow views than
 * anything else. So, with a budget (a quality level's `shadowedLights`):
 *
 * - **Who gets a shadow.** Each frame the shadow-casting lights that are on
 *   are ranked by how large they are on screen (their reach over their
 *   distance from the eye); lights out of view (their reach outside the
 *   frustum) or in a room no portal shows rank nowhere; a spot light ranks
 *   ahead of a point light of the same size (one view, not six). The first
 *   `budget` keep their shadow; the others draw none (their shadow's
 *   intensity is 0 and their map is not drawn).
 * - **Fade.** A shadow fades out between 3/4 of {@link LOCAL_SHADOW_DISTANCE}
 *   and that distance from the eye, so leaving the budget far away is not a
 *   pop.
 * - **Cached.** A budgeted map is drawn when the light enters the budget,
 *   when it moves, when the static casters change (the cached static
 *   shadow's revision), and while something that moves (a character, an
 *   animated part: `movers`) is within its reach; a lamp in a still room
 *   draws its map once.
 *
 * Changing a shadow's intensity or whether its map is drawn builds nothing:
 * the light keeps its shadow node (switching `castShadow` would rebuild
 * every lit program). Without a budget (absent: the previous behaviour)
 * every shadow-casting light draws its map every frame, unfaded.
 */
import * as THREE from 'three';

import { roomKeyOf } from './light-layers';

/** Metres from the eye at which a budgeted point or spot light's shadow has faded out (from 3/4 of it on). */
export const LOCAL_SHADOW_DISTANCE = 40;
/** The share of a point light's rank against a spot light of the same size on screen (its shadow is six views). */
const POINT_RANK = 0.5;
/** The reach a light without a range is ranked and tested with (m). */
const UNBOUNDED_REACH = 20;

export interface ShadowBudgetDeps {
  /** Whether the room a light is in is seen (no room: true). */
  roomSeen(key: number | undefined): boolean;
  /** Spheres (x, y, z, r) of what moved this frame. */
  movers(): ArrayLike<number>;
  /** The static casters' revision (a change redraws every budgeted map). */
  staticRevision(): number;
}

export interface ShadowBudgetDiagnostics {
  /** The budget (null: none), shadow-casting lights on, those given a shadow this frame, maps drawn this frame. */
  budget: number | null;
  casting: number;
  shadowed: number;
  drawn: number;
}

interface Kept {
  readonly at: THREE.Matrix4;
  revision: number;
  on: boolean;
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _pos = new THREE.Vector3();

export class ShadowBudget {
  private budget: number | null = null;
  private readonly kept = new Map<THREE.Light, Kept>();
  private readonly d: ShadowBudgetDiagnostics = { budget: null, casting: 0, shadowed: 0, drawn: 0 };

  constructor(private readonly deps: ShadowBudgetDeps) {}

  /** The budget (null: none, every shadow drawn every frame). */
  setBudget(n: number | null): void {
    this.budget = n;
    this.d.budget = n;
  }

  /** Rank and fade the shadow-casting lights for this frame's view. */
  update(camera: THREE.Camera, lights: Iterable<THREE.Light>): void {
    const casting: THREE.Light[] = [];
    for (const l of lights) if (l.castShadow && l.visible && ((l as THREE.PointLight).isPointLight === true || (l as THREE.SpotLight).isSpotLight === true)) casting.push(l);
    this.d.casting = casting.length;
    if (this.budget === null) {
      this.release();
      this.d.shadowed = casting.length;
      this.d.drawn = casting.length;
      return;
    }
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv, camera.coordinateSystem);
    const e = camera.matrixWorld.elements;
    const ranked: { l: THREE.Light; rank: number; fade: number }[] = [];
    for (const l of casting) {
      const w = l.matrixWorld.elements;
      _pos.set(w[12]!, w[13]!, w[14]!);
      const reach = (l as THREE.PointLight).distance > 0 ? (l as THREE.PointLight).distance : UNBOUNDED_REACH;
      const dist = Math.hypot(_pos.x - e[12]!, _pos.y - e[13]!, _pos.z - e[14]!);
      const fade = 1 - THREE.MathUtils.smoothstep(dist, LOCAL_SHADOW_DISTANCE * 0.75, LOCAL_SHADOW_DISTANCE);
      const seen = fade > 0 && this.deps.roomSeen(roomKeyOf(l)) && _frustum.intersectsSphere(_sphere.set(_pos, reach));
      const rank = seen ? (reach / Math.max(dist, 1)) * ((l as THREE.SpotLight).isSpotLight === true ? 1 : POINT_RANK) : -1;
      ranked.push({ l, rank, fade });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    const movers = this.deps.movers();
    const revision = this.deps.staticRevision();
    let shadowed = 0;
    let drawn = 0;
    ranked.forEach(({ l, rank, fade }, i) => {
      const s = (l as THREE.PointLight).shadow;
      let k = this.kept.get(l);
      if (k === undefined) this.kept.set(l, (k = { at: new THREE.Matrix4(), revision: -1, on: false }));
      s.autoUpdate = false;
      if (rank <= 0 || i >= this.budget!) {
        s.intensity = 0;
        k.on = false;
        return;
      }
      shadowed += 1;
      s.intensity = fade;
      let redraw = !k.on || k.revision !== revision || !k.at.equals(l.matrixWorld);
      if (!redraw) {
        const w = l.matrixWorld.elements;
        const reach = (l as THREE.PointLight).distance > 0 ? (l as THREE.PointLight).distance : UNBOUNDED_REACH;
        for (let m = 0; m + 3 < movers.length; m += 4) {
          if (Math.hypot(movers[m]! - w[12]!, movers[m + 1]! - w[13]!, movers[m + 2]! - w[14]!) < reach + movers[m + 3]!) {
            redraw = true;
            break;
          }
        }
      }
      k.on = true;
      k.revision = revision;
      k.at.copy(l.matrixWorld);
      if (redraw) {
        s.needsUpdate = true;
        drawn += 1;
      }
    });
    // Lights no longer casting (switched off, released) are let go.
    for (const l of this.kept.keys()) if (!casting.includes(l)) this.restore(l);
    this.d.shadowed = shadowed;
    this.d.drawn = drawn;
  }

  diagnostics(): ShadowBudgetDiagnostics {
    return { ...this.d };
  }

  /** Every light back to drawing its shadow every frame (no budget any more). */
  private release(): void {
    for (const l of [...this.kept.keys()]) this.restore(l);
  }

  private restore(l: THREE.Light): void {
    this.kept.delete(l);
    const s = (l as THREE.PointLight).shadow as THREE.LightShadow | undefined;
    if (s === undefined) return;
    s.autoUpdate = true;
    s.intensity = 1;
  }
}
