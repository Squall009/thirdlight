/**
 * The lighting's debug views (an editor's Scene view menu) and the numbers
 * its pass-time overlay shows. Each view is the page's own:
 *
 * - cache texels: the surface cache's debug look (`?surfaceCacheView=1`,
 *   `adapter-surface-light.ts`);
 * - probes: the probes drawn as spheres lit by their own light
 *   (`?probesView=1`, `adapter-live-probes.ts`), live or saved;
 * - rooms and portals: the rooms light keeps to, as the surface cache sees
 *   them (`SurfaceCacheHost.rooms`), each room's outline from floor to top,
 *   and each portal's outline, green while it lets light through, red while
 *   a door piece shuts it;
 * - stale pages: a box round each unit of the cache still to light;
 * - light clusters: each lit pixel in the colour of how many local lights
 *   its cell lists (`?clusterView=1`; the clusters' own, `cluster-heat.ts`).
 *
 * The rooms and stale boxes are lines in the scene (never picked: no entity
 * owns them), drawn again when the rooms change, and the stale boxes at most
 * every `STALE_VIEW_MS` while work is left.
 */
import * as THREE from 'three';

import type { SurfaceCacheHost } from './surface-cache-host';
import type { SurfaceRooms } from './surface-rooms';

/** Which of the lighting's debug views are drawn. */
export interface LightingViewState {
  /** The surface cache's lit texels, a square each on its surface. */
  readonly cache: boolean;
  /** The probes, a sphere each lit by its own light. */
  readonly probes: boolean;
  /** The rooms and the portals between them. */
  readonly rooms: boolean;
  /** A box round each unit still to light. */
  readonly stale: boolean;
  /** The light clusters' heat map (absent: off). */
  readonly clusters?: boolean;
}

export const LIGHTING_VIEW_OFF: LightingViewState = Object.freeze({ cache: false, probes: false, rooms: false, stale: false, clusters: false });

/** What the debug views draw now. */
export interface LightingViewCounts {
  /** Cache texels, probe spheres (and of those the ones moved or filled), room and portal outlines, stale boxes. */
  readonly cacheTexels: number;
  readonly probeSpheres: number;
  readonly invalidProbes: number;
  readonly roomOutlines: number;
  readonly portalOutlines: number;
  readonly staleBoxes: number;
  /** Local lights whose cluster lists the heat map draws (0: off). */
  readonly clusterLights?: number;
}

/** What the lighting does now, per pass (the overlay's numbers; nothing here is an estimate). */
export interface LightingReport {
  /** The quality level drawn and its lighting tier (`low` on WebGL 2). */
  readonly level: string;
  readonly tier: 'low' | 'medium' | 'high';
  /** Whether the static surfaces' light runs live, and why not. */
  readonly live: boolean;
  readonly off: 'no-budget' | 'no-webgpu' | 'failed' | 'starting' | null;
  /** Whether the light drawn has caught up (live: nothing stale; saved: every followed scene's bake read). */
  readonly settled: boolean;
  /** The cache's re-lighting: its GPU time a frame (null: none measured), budget, and the units and texels still to light. */
  readonly relight: { readonly msUsed: number | null; readonly budgetMs: number; readonly stalePages: number; readonly staleTexels: number } | null;
  /** The probes' update: its GPU time (null: none measured), probes and those still to update. */
  readonly probes: { readonly msUsed: number | null; readonly count: number; readonly stale: number } | null;
  /** The reflections' traced rays (their last pass's GPU time and rays; null: none traced yet). */
  readonly reflections: { readonly ms: number | null; readonly rays: number } | null;
  /** Whether temporal upscaling draws the picture (the editor's Scene view draws SMAA in its place). */
  readonly taau: boolean;
  /** The debug views drawn and what they hold. */
  readonly view: LightingViewState & LightingViewCounts;
}

/** Shortest time (ms) between two drawings of the stale boxes while work is left. */
const STALE_VIEW_MS = 200;
const ROOM_COLOUR = new THREE.Color(0.2, 0.85, 1);
const OPEN_COLOUR = new THREE.Color(0.25, 1, 0.35);
const SHUT_COLOUR = new THREE.Color(1, 0.2, 0.2);
const STALE_COLOUR = new THREE.Color(1, 0.6, 0.1);
/** The 12 edges of a box, as corner pairs (corner bits: x, y, z). */
const BOX_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7] as const;

/** Lines in the scene that grow as needed (one draw). */
class Lines {
  readonly object: THREE.LineSegments;
  private positions = new Float32Array(0) as Float32Array<ArrayBuffer>;
  private colours = new Float32Array(0) as Float32Array<ArrayBuffer>;
  private n = 0;

  constructor(name: string) {
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    this.object.name = name;
    this.object.frustumCulled = false;
    // Drawn over what it outlines (rooms and boxes sit inside geometry).
    this.object.renderOrder = 1000;
  }

  begin(): void {
    this.n = 0;
  }

  line(a: readonly number[], b: readonly number[], c: THREE.Color): void {
    if ((this.n + 2) * 3 > this.positions.length) {
      const grow = (old: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
        const next = new Float32Array(Math.max(1536, old.length * 2));
        next.set(old);
        return next;
      };
      this.positions = grow(this.positions);
      this.colours = grow(this.colours);
    }
    this.positions.set([a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!], this.n * 3);
    this.colours.set([c.r, c.g, c.b, c.r, c.g, c.b], this.n * 3);
    this.n += 2;
  }

  end(): void {
    const g = this.object.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos === undefined || pos.array !== this.positions) {
      g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(this.colours, 3));
    } else {
      pos.needsUpdate = true;
      g.getAttribute('color').needsUpdate = true;
    }
    g.setDrawRange(0, this.n);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

export class AdapterLightingViews {
  private state: LightingViewState = LIGHTING_VIEW_OFF;
  private rooms: { lines: Lines; of: SurfaceRooms | null; doors: string; rooms: number; portals: number } | null = null;
  private stale: { lines: Lines; at: number; boxes: number } | null = null;

  constructor(private readonly host: SurfaceCacheHost, private readonly scene: THREE.Scene) {}

  get views(): LightingViewState {
    return this.state;
  }

  set(state: LightingViewState): void {
    this.state = { cache: state.cache, probes: state.probes, rooms: state.rooms, stale: state.stale, clusters: state.clusters === true };
    if (!state.rooms && this.rooms !== null) {
      this.rooms.lines.dispose();
      this.rooms = null;
    }
    if (!state.stale && this.stale !== null) {
      this.stale.lines.dispose();
      this.stale = null;
    }
  }

  /** Before a frame's draw (after the cache's update): the views follow the rooms and the stale work. */
  frame(now = performance.now()): void {
    if (this.state.rooms) this.drawRooms();
    if (this.state.stale) this.drawStale(now);
  }

  /** The rooms and stale boxes drawn now. */
  counts(): Pick<LightingViewCounts, 'roomOutlines' | 'portalOutlines' | 'staleBoxes'> {
    return { roomOutlines: this.rooms?.rooms ?? 0, portalOutlines: this.rooms?.portals ?? 0, staleBoxes: Math.max(0, this.stale?.boxes ?? 0) };
  }

  private drawRooms(): void {
    const of = this.host.rooms();
    const g = of?.rooms.graph ?? null;
    // Which portals let light through now (a door opened or shut redraws them).
    const doors = g === null ? '' : g.portals.map((_, i) => (of!.rooms.open(i) ? '1' : '0')).join('');
    if (this.rooms !== null && this.rooms.of === of && this.rooms.doors === doors) return;
    if (this.rooms === null) {
      const lines = new Lines('lighting rooms view');
      this.scene.add(lines.object);
      this.rooms = { lines, of: null, doors: '', rooms: 0, portals: 0 };
    }
    const r = this.rooms;
    r.of = of;
    r.doors = doors;
    r.lines.begin();
    if (g !== null) {
      for (const room of g.rooms) {
        const p = room.poly;
        const n = p.length / 2;
        for (let i = 0; i < n; i += 1) {
          const j = (i + 1) % n;
          const [ax, az, bx, bz] = [p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!];
          r.lines.line([ax, room.floor, az], [bx, room.floor, bz], ROOM_COLOUR);
          r.lines.line([ax, room.top, az], [bx, room.top, bz], ROOM_COLOUR);
          r.lines.line([ax, room.floor, az], [ax, room.top, az], ROOM_COLOUR);
        }
      }
      g.portals.forEach((portal, i) => {
        const c = portal.corners;
        const n = c.length / 3;
        const colour = of!.rooms.open(i) ? OPEN_COLOUR : SHUT_COLOUR;
        for (let k = 0; k < n; k += 1) {
          const m = (k + 1) % n;
          r.lines.line([c[k * 3]!, c[k * 3 + 1]!, c[k * 3 + 2]!], [c[m * 3]!, c[m * 3 + 1]!, c[m * 3 + 2]!], colour);
        }
        // A shut portal is crossed out, so it reads apart from a room's edge.
        if (!of!.rooms.open(i) && n === 4) {
          r.lines.line([c[0]!, c[1]!, c[2]!], [c[6]!, c[7]!, c[8]!], colour);
          r.lines.line([c[3]!, c[4]!, c[5]!], [c[9]!, c[10]!, c[11]!], colour);
        }
      });
    }
    r.lines.end();
    r.rooms = g?.rooms.length ?? 0;
    r.portals = g?.portals.length ?? 0;
  }

  private drawStale(now: number): void {
    if (this.stale === null) {
      const lines = new Lines('lighting stale view');
      this.scene.add(lines.object);
      this.stale = { lines, at: -Infinity, boxes: -1 };
    }
    const s = this.stale;
    if (now - s.at < STALE_VIEW_MS) return;
    s.at = now;
    let boxes = 0;
    s.lines.begin();
    const corner = (min: readonly number[], max: readonly number[], bits: number): number[] => [bits & 1 ? max[0]! : min[0]!, bits & 2 ? max[1]! : min[1]!, bits & 4 ? max[2]! : min[2]!];
    this.host.relight.forEachStale((min, max) => {
      boxes += 1;
      for (let e = 0; e < BOX_EDGES.length; e += 2) s.lines.line(corner(min, max, BOX_EDGES[e]!), corner(min, max, BOX_EDGES[e + 1]!), STALE_COLOUR);
    });
    s.lines.end();
    s.boxes = boxes;
  }

  dispose(): void {
    this.set(LIGHTING_VIEW_OFF);
  }
}
