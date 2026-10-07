/**
 * Block-layer cut-aways on the renderer (the data and the subject test are
 * project-model `block-cutaway.ts`).
 *
 * Meshes: a chunk's triangles inside a zone are drawn as meshes of their own
 * (`splitByCutaway`; the same vertex buffers, an index of their own), so a
 * cut zone is whole draws left out, never a per-pixel test on what stays.
 * Where a triangle belongs is read from its centre nudged a quarter cell
 * against its normal, so a face belongs to the cell it bounds (the top of the
 * wall under a roof stays, the roof's underside goes); columns reach
 * {@link CUTAWAY_EDGE_MARGIN} past a zone's sides, so the edge pieces on its
 * outline (an eighth of a cell thick) go with it.
 *
 * Drawing only, and the shadow stays: a cut mesh leaves the view's camera
 * layer for {@link CUTAWAY_LAYER}, which the shadow cameras see (they are
 * given it where they are made). So the roof over the player still shades
 * the room, as the probes baked with it say, and the cached static shadow map
 * is never drawn again for a cut: the mesh, its material and its place stay.
 *
 * Fading: while a zone fades, each of its meshes draws a copy (a child of the
 * mesh, the same geometry, no shadow) whose material is the mesh's own with a
 * screen-space dither discard (`maskNode`) driven by one per-object uniform
 * read from the copy (`FADE_KEY`). One variant per source material, made once
 * and compiled ahead (`precompile`), so a fade builds no material per frame;
 * fully faded, the copy goes and the mesh is out of the view's draws.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { CUTAWAY_FADE_SECONDS, cutawayCuts, cutawayZones, type BlockLayerComponent, type CutawayZone } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { LIGHT_LAYERS_KEY } from './light-layers';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { uniform, screenCoordinate, vec2, float } = TSL;

/** The three.js layer a cut mesh is moved to: the shadow cameras see it, the view's camera does not. */
export const CUTAWAY_LAYER = 31;

/** Cells a zone's columns reach past its sides when sorting triangles (edge pieces on its outline are 1/8 cell thick). */
export const CUTAWAY_EDGE_MARGIN = 0.2;
/** Cells a triangle's centre is moved against its normal before it is sorted (into the cell the face bounds). */
const NUDGE = 0.25;

/** `copy.userData[FADE_KEY]`: how far a fading copy has faded (0 drawn whole … 1 gone). */
const FADE_KEY = '__tlCutawayFade';
/** Marks a fading copy (picking, counts and bakes pass over it). */
export const CUTAWAY_COPY_KEY = '__tlCutawayCopy';

/** Let a shadow camera see cut-away geometry: what is cut from the view still casts. */
export function shadowSeesCutaways(camera: THREE.Camera): void {
  camera.layers.enable(CUTAWAY_LAYER);
}

/** The triangles of one index split by zone: those in none, and per set of zones (indices into `zones`) those in it. */
export interface CutawaySplit {
  readonly base: Uint32Array;
  readonly cut: readonly { readonly zones: readonly number[]; readonly indices: Uint32Array }[];
}

/**
 * Sort a mesh part's triangles (positions in the layer's metres) by the zones
 * they lie in. Null when none is in any zone (the part draws as it is).
 */
export function splitByCutaway(positions: ArrayLike<number>, indices: ArrayLike<number>, zones: readonly CutawayZone[], cellSize: readonly number[]): CutawaySplit | null {
  if (zones.length === 0) return null;
  const [sx, sy, sz] = [cellSize[0]!, cellSize[1]!, cellSize[2]!];
  // Only the zones whose boxes reach the part's bounds are tested per triangle.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]! / sx, y = positions[i + 1]! / sy, z = positions[i + 2]! / sz;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const m = CUTAWAY_EDGE_MARGIN + NUDGE;
  const local: number[] = [];
  zones.forEach((zone, i) => {
    if (zone.boxes.some((b) => b[0] - m <= x1 && b[3] + m >= x0 && b[1] - NUDGE <= y1 && b[4] + NUDGE >= y0 && b[2] - m <= z1 && b[5] + m >= z0)) local.push(i);
  });
  if (local.length === 0) return null;
  const base: number[] = [];
  const sets = new Map<string, { zones: number[]; indices: number[] }>();
  const inZones: number[] = [];
  const e = CUTAWAY_EDGE_MARGIN;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const ux = positions[b]! - ax, uy = positions[b + 1]! - ay, uz = positions[b + 2]! - az;
    const vx = positions[c]! - ax, vy = positions[c + 1]! - ay, vz = positions[c + 2]! - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    // The centre in cells, moved a quarter cell into the cell the face bounds.
    const px = (ax + (ux + vx) / 3) / sx - nx * NUDGE;
    const py = (ay + (uy + vy) / 3) / sy - ny * NUDGE;
    const pz = (az + (uz + vz) / 3) / sz - nz * NUDGE;
    inZones.length = 0;
    for (const zi of local) {
      for (const bx of zones[zi]!.boxes) {
        if (px >= bx[0] - e && px < bx[3] + e && pz >= bx[2] - e && pz < bx[5] + e && py >= bx[1] && py < bx[4]) {
          inZones.push(zi);
          break;
        }
      }
    }
    if (inZones.length === 0) {
      base.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
      continue;
    }
    const key = inZones.join(',');
    let set = sets.get(key);
    if (set === undefined) sets.set(key, (set = { zones: [...inZones], indices: [] }));
    set.indices.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
  }
  if (sets.size === 0) return null;
  return { base: new Uint32Array(base), cut: [...sets.values()].map((s) => ({ zones: s.zones, indices: new Uint32Array(s.indices) })) };
}

/** The per-object fade the dither reads (one node shared by every variant). */
const fadeNode = uniform(0).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (object.userData[FADE_KEY] as number | undefined) ?? 0);
/** Keep a pixel while its screen-space threshold (interleaved gradient noise) is at least the fade. */
const keepNode = float(52.9829189).mul(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)).fract()).fract().greaterThanEqual(fadeNode);

/** The node material class three draws a classic material with. */
const NODE_CLASSES: Record<string, new () => THREE.NodeMaterial> = {
  MeshBasicMaterial: THREE.MeshBasicNodeMaterial,
  MeshLambertMaterial: THREE.MeshLambertNodeMaterial,
  MeshPhongMaterial: THREE.MeshPhongNodeMaterial,
  MeshStandardMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalMaterial: THREE.MeshPhysicalNodeMaterial,
  MeshToonMaterial: THREE.MeshToonNodeMaterial,
  MeshMatcapMaterial: THREE.MeshMatcapNodeMaterial,
  MeshNormalMaterial: THREE.MeshNormalNodeMaterial,
};

/** Keys never carried to a variant: its identity, listeners and version are its own. */
const OWN_KEYS = new Set(['uuid', 'id', '_listeners', 'version']);

/** `src` drawn with the fade's dither (null: a material three draws no node material for). */
function makeFadeVariant(src: THREE.Material): THREE.Material | null {
  let v: THREE.NodeMaterial;
  if ((src as { isNodeMaterial?: boolean }).isNodeMaterial === true) v = (src as THREE.NodeMaterial).clone();
  else {
    const Cls = NODE_CLASSES[src.type];
    if (Cls === undefined) return null;
    v = new Cls();
    // As three converts a classic material for its node renderer (every field taken over).
    for (const key in src) if (!OWN_KEYS.has(key)) (v as unknown as Record<string, unknown>)[key] = (src as unknown as Record<string, unknown>)[key];
    v.userData = { ...src.userData };
  }
  const own = (v as { maskNode?: N }).maskNode;
  (v as { maskNode?: N }).maskNode = own !== null && own !== undefined ? TSL.bool(own).and(keepNode) : keepNode;
  v.name = `${src.name} (cut-away fade)`;
  v.needsUpdate = true;
  return v;
}

export interface CutawayDrawingDeps {
  /**
   * A fade copy to compile ahead of its first fade, drawn with every pixel
   * discarded: the host keeps it in the scene until it has been compiled
   * (absent: a variant compiles when its first fade draws it).
   */
  precompile?(object: THREE.Object3D): void;
}

interface CutMesh {
  readonly mesh: THREE.Mesh;
  /** Its zones (keys). */
  readonly zones: readonly string[];
  /** The fade it shows (0 drawn … 1 cut). */
  shown: number;
  copy: THREE.Mesh | null;
  /** The material whose fade variant it holds (null: none yet). */
  held: THREE.Material | null;
}

interface ZoneState {
  fade: number;
  target: number;
}

interface LayerCut {
  zones: CutawayZone[];
  fadeSeconds: number;
  readonly origin: THREE.Vector3;
  cellSize: readonly number[];
  readonly states: Map<string, ZoneState>;
  readonly meshes: Map<string, CutMesh[]>;
  /** Zones the host forces (an editor preview) and the game's scripts force. */
  readonly host: Map<string, boolean>;
  game: Map<string, boolean>;
}

export interface CutawayDiagnostics {
  zones: number;
  /** Zones hidden, and fading out or in. */
  cut: number;
  fading: number;
  /** Meshes of cut-away zones (their own draws). */
  meshes: number;
}

export class CutawayDrawing {
  private readonly layers = new Map<string, LayerCut>();
  /** Each source material's fade variant and the cut meshes holding it (it goes with the last of them). */
  private readonly variants = new Map<THREE.Material, { version: number; variant: THREE.Material | null; users: Set<CutMesh> }>();
  private readonly subjectCell = new THREE.Vector3();
  private readonly cellScale = new THREE.Vector3();

  constructor(private readonly deps: CutawayDrawingDeps = {}) {}

  /** A layer's zones from its component and regions (layers without any keep no state). */
  setLayer(entityId: string, component: BlockLayerComponent, regions: ReadonlyMap<string, readonly (readonly number[])[]>, origin: readonly number[]): void {
    const zones = component.cutaway === undefined ? [] : cutawayZones(component, regions);
    let l = this.layers.get(entityId);
    if (zones.length === 0) {
      if (l !== undefined) this.removeLayer(entityId);
      return;
    }
    if (l === undefined) {
      l = { zones, fadeSeconds: CUTAWAY_FADE_SECONDS, origin: new THREE.Vector3(), cellSize: component.cellSize, states: new Map(), meshes: new Map(), host: new Map(), game: new Map() };
      this.layers.set(entityId, l);
    }
    l.zones = zones;
    l.cellSize = component.cellSize;
    l.fadeSeconds = component.cutaway?.fade ?? CUTAWAY_FADE_SECONDS;
    l.origin.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    const keys = new Set(zones.map((z) => z.key));
    for (const k of [...l.states.keys()]) if (!keys.has(k)) l.states.delete(k);
  }

  setOrigin(entityId: string, origin: readonly number[]): void {
    this.layers.get(entityId)?.origin.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  }

  /** The zones a layer's chunks are split by (none: they draw whole). */
  zonesOf(entityId: string): readonly CutawayZone[] {
    return this.layers.get(entityId)?.zones ?? [];
  }

  any(): boolean {
    return this.layers.size > 0;
  }

  /** A chunk's meshes of zones (built now): they take their zones' fade at once. */
  register(entityId: string, ck: string, meshes: readonly { mesh: THREE.Mesh; zones: readonly number[] }[]): void {
    const l = this.layers.get(entityId);
    if (l === undefined || meshes.length === 0) return;
    const list: CutMesh[] = meshes.map((m) => ({ mesh: m.mesh, zones: m.zones.map((i) => l.zones[i]!.key), shown: 0, copy: null, held: null }));
    l.meshes.set(ck, list);
    for (const c of list) {
      this.apply(c, this.meshFade(l, c));
      this.prepare(c);
    }
  }

  /** A chunk's meshes go (rebuilt or removed). */
  drop(entityId: string, ck: string): void {
    const l = this.layers.get(entityId);
    const list = l?.meshes.get(ck);
    if (list === undefined) return;
    for (const c of list) this.release(c);
    l!.meshes.delete(ck);
  }

  removeLayer(entityId: string): void {
    const l = this.layers.get(entityId);
    if (l === undefined) return;
    for (const list of l.meshes.values()) for (const c of list) this.release(c);
    this.layers.delete(entityId);
  }

  /** Force a zone hidden or shown (null: back to the subject) — the host's own (an editor preview). False: no such zone. */
  force(entityId: string, zone: string, cut: boolean | null): boolean {
    const l = this.layers.get(entityId);
    if (l === undefined || !l.zones.some((z) => z.key === zone)) return false;
    if (cut === null) l.host.delete(zone);
    else l.host.set(zone, cut);
    return true;
  }

  /** The zones the game's scripts force ([layer, zone, cut]; the whole list). */
  setGameForced(forced: readonly (readonly [string, string, boolean])[]): void {
    for (const l of this.layers.values()) l.game = new Map();
    for (const [layer, zone, cut] of forced) this.layers.get(layer)?.game.set(zone, cut);
  }

  /**
   * Follow the subject (a world point; null: none, nothing cut but what is
   * forced) for `dt` seconds: each zone moves toward cut or shown, its meshes
   * take the fade. A zone seen for the first time takes its state at once (a
   * level does not open with roofs fading). Returns whether any zone is still
   * fading (the host draws again).
   */
  update(dt: number, subject: THREE.Vector3 | null): boolean {
    let fading = false;
    for (const l of this.layers.values()) {
      let changed = false;
      const s = subject === null ? null : this.subjectCell.copy(subject).sub(l.origin).divide(this.cellScale.set(l.cellSize[0]!, l.cellSize[1]!, l.cellSize[2]!));
      for (const z of l.zones) {
        const forced = l.host.get(z.key) ?? l.game.get(z.key);
        const target = (forced ?? (s !== null && cutawayCuts(z, s.x, s.y, s.z))) ? 1 : 0;
        let st = l.states.get(z.key);
        if (st === undefined) {
          l.states.set(z.key, (st = { fade: target, target }));
          changed = true;
          continue;
        }
        st.target = target;
        if (st.fade === target) continue;
        const step = l.fadeSeconds > 0 ? dt / l.fadeSeconds : 1;
        st.fade = target > st.fade ? Math.min(target, st.fade + step) : Math.max(target, st.fade - step);
        changed = true;
        if (st.fade !== target) fading = true;
      }
      if (changed) for (const list of l.meshes.values()) for (const c of list) this.apply(c, this.meshFade(l, c));
    }
    return fading;
  }

  diagnostics(): CutawayDiagnostics | null {
    if (this.layers.size === 0) return null;
    const d: CutawayDiagnostics = { zones: 0, cut: 0, fading: 0, meshes: 0 };
    for (const l of this.layers.values()) {
      d.zones += l.zones.length;
      for (const st of l.states.values()) {
        if (st.fade > 0 && st.fade === st.target) d.cut += 1;
        else if (st.fade !== st.target) d.fading += 1;
      }
      for (const list of l.meshes.values()) d.meshes += list.length;
    }
    return d;
  }

  dispose(): void {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const v of this.variants.values()) v.variant?.dispose();
    this.variants.clear();
  }

  // ---- internals ---------------------------------------------------------------------

  /** A mesh fades as far as the furthest of its zones (it is hidden if any of them is). */
  private meshFade(l: LayerCut, c: CutMesh): number {
    let f = 0;
    for (const k of c.zones) f = Math.max(f, l.states.get(k)?.fade ?? 0);
    return f;
  }

  private apply(c: CutMesh, f: number): void {
    const m = c.mesh;
    if (f <= 0) {
      m.layers.enable(0);
      m.layers.disable(CUTAWAY_LAYER);
      this.removeCopy(c);
    } else {
      // Out of the view's draws, still in the shadow cameras'.
      m.layers.disable(0);
      m.layers.enable(CUTAWAY_LAYER);
      if (f >= 1) this.removeCopy(c);
      else {
        const copy = this.copyOf(c);
        if (copy !== null) copy.userData[FADE_KEY] = f;
      }
    }
    c.shown = f;
  }

  /** The mesh's fading copy (made when a fade starts; null: its material cannot fade, it goes at once). */
  private copyOf(c: CutMesh): THREE.Mesh | null {
    const variant = this.variantFor(c);
    if (variant === null) return null;
    let copy = c.copy;
    if (copy === null) {
      copy = new THREE.Mesh(c.mesh.geometry, variant);
      copy.name = `${c.mesh.name} (fade)`;
      copy.castShadow = false;
      copy.receiveShadow = c.mesh.receiveShadow;
      copy.frustumCulled = c.mesh.frustumCulled;
      copy.renderOrder = c.mesh.renderOrder;
      copy.userData[CUTAWAY_COPY_KEY] = true;
      const ll = c.mesh.userData[LIGHT_LAYERS_KEY] as number | undefined;
      if (ll !== undefined) copy.userData[LIGHT_LAYERS_KEY] = ll;
      // Placed with its mesh (which never moves while it is built); it is a child only to ride along into the scene.
      copy.matrixAutoUpdate = false;
      copy.matrixWorldAutoUpdate = false;
      c.mesh.add(copy);
      c.copy = copy;
    } else if (copy.material !== variant) copy.material = variant;
    copy.matrixWorld.copy(c.mesh.matrixWorld);
    return copy;
  }

  private removeCopy(c: CutMesh): void {
    if (c.copy === null) return;
    c.copy.removeFromParent();
    c.copy = null;
  }

  /** A cut mesh goes: its copy, and its hold on a variant. */
  private release(c: CutMesh): void {
    this.removeCopy(c);
    this.unhold(c);
  }

  private unhold(c: CutMesh): void {
    const src = c.held;
    if (src === null) return;
    c.held = null;
    const v = this.variants.get(src);
    if (v === undefined) return;
    v.users.delete(c);
    if (v.users.size > 0) return;
    v.variant?.dispose();
    this.variants.delete(src);
  }

  /**
   * The fade variant of the material `c` wears: made once per material
   * (again only after the material itself changed), held by the meshes
   * wearing it.
   */
  private variantFor(c: CutMesh): THREE.Material | null {
    const src = c.mesh.material;
    if (Array.isArray(src)) return null;
    let known = this.variants.get(src);
    if (known !== undefined && known.version !== src.version) {
      known.variant?.dispose();
      known.variant = makeFadeVariant(src);
      known.version = src.version;
    }
    if (known === undefined) this.variants.set(src, (known = { version: src.version, variant: makeFadeVariant(src), users: new Set() }));
    if (c.held !== src) {
      this.unhold(c);
      c.held = src;
      known.users.add(c);
    }
    return known.variant;
  }

  /** Make a new mesh's fade variant now and compile it in the background, so its first fade does not stall a frame. */
  private prepare(c: CutMesh): void {
    const fresh = Array.isArray(c.mesh.material) || this.variants.get(c.mesh.material)?.version !== c.mesh.material.version;
    const variant = this.variantFor(c);
    if (!fresh || variant === null || this.deps.precompile === undefined) return;
    const mesh = c.mesh;
    // Drawn whole-faded (every pixel discarded) wherever the camera looks, until the host takes it out.
    const probe = new THREE.Mesh(mesh.geometry, variant);
    probe.name = `${mesh.name} (fade, compiling)`;
    probe.userData[FADE_KEY] = 1;
    probe.userData[CUTAWAY_COPY_KEY] = true;
    probe.frustumCulled = false;
    probe.castShadow = false;
    probe.receiveShadow = mesh.receiveShadow;
    probe.matrixWorld.copy(mesh.matrixWorld);
    probe.matrixAutoUpdate = false;
    probe.matrixWorldAutoUpdate = false;
    const ll = mesh.userData[LIGHT_LAYERS_KEY] as number | undefined;
    if (ll !== undefined) probe.userData[LIGHT_LAYERS_KEY] = ll;
    this.deps.precompile(probe);
  }
}
