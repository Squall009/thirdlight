/**
 * Rooms on the page: which room each drawable and each lamp is in, which
 * rooms the view can see through the portals between them, and what is
 * drawn and lit because of it (project-model `arch-portals.ts` has the rooms
 * and the walk).
 *
 * - **Membership.** It hears from the render graph what enters the scene
 *   and what moves. A mesh is in the room its bounds' middle is in (0: the
 *   outside), a point or spot light in the room it stands in; the key rides
 *   in `userData` (`ROOM_KEY`), where the light test (light-layers.ts) and
 *   the batch keys read it. A mesh that spans rooms and opts in
 *   (`ROOM_TAG_KEY`: chunks of generated walls and of the block layers rooms
 *   stand on) gets the room each vertex looks into instead (a vertex nudged
 *   along its normal; `ROOM_ATTRIBUTE`), unless all of them look into one.
 *   Instanced draws (copies spread over a level) stay in no room.
 * - **Culling.** Once a drawn frame, when the view moved or a door opened or
 *   shut (a closed door piece on the cell edges across a doorway), the walk
 *   finds the rooms seen. A drawable in a room not seen, or outside while
 *   the outside is not seen, leaves the view's draws but stays in the
 *   shadow cameras' (`view-hidden.ts`): its shadow still falls where it
 *   would. A spanning mesh stays while any room its vertices look into is
 *   seen. Lights are never switched (that would rebuild every lit program):
 *   a lamp in a room not seen lights only that room's drawables, which are
 *   not drawn, and its shadow map is left alone (`shadow-budget.ts`).
 * - Nothing changes on a page without rooms; `?portals=off` keeps the room
 *   test of the lights and leaves the culling out (a diagnostic comparison).
 */
import * as THREE from 'three';
import { buildRoomGraph, ROOM_OUTSIDE, roomVisibility, walkRooms, type ArchitectureRoomPlan, type RoomGraph, type RoomGraphObject, type RoomVisibility } from '@thirdlight/runtime';

import type { BatchMembership } from './batching';
import { lightsObject, ROOM_ATTRIBUTE, ROOM_KEY, ROOM_VERTEX_KEYS } from './light-layers';
import { HIDDEN_BY_ROOM, hideFromView } from './view-hidden';

/** `mesh.userData[ROOM_TAG_KEY]`: the mesh spans rooms and takes their keys per vertex (true, or the block layer's id it belongs to). */
export const ROOM_TAG_KEY = '__tlRoomTag';

/** The page query that leaves room culling out (`?portals=off`: a diagnostic comparison; the lights' room test stays). */
export const PORTALS_URL_PARAM = 'portals';

/** Whether a page culls by rooms (`?portals=off|0|false`: no). */
export function portalsFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(PORTALS_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** Metres a vertex is moved along its normal to find the room it looks into. */
const NUDGE = 0.05;
/** Frames between sweeps of the scene's draws while nothing changed (draws a batcher adds itself are found then). */
const SWEEP_FRAMES = 30;
/** Relative change of a view matrix entry below which the view counts as unchanged. */
const VIEW_SAME = 1e-7;

export interface RoomCullingDeps {
  readonly scene: THREE.Scene;
  /** Whether a closed piece that blocks passage stands on a block layer's cell edge. */
  edgeClosed(layerId: string, x: number, y: number, z: number, axis: number): boolean;
  /** Whether a cut-away, cut or fading, hides anything over a ground box from `floor` up (absent: no cut-aways). */
  cutsOver?(x0: number, z0: number, x1: number, z1: number, floor: number): boolean;
  /** A drawable's room changed: its batch is made again. */
  regroup(o: THREE.Object3D): void;
  /** Whether the page has rooms changed: point and spot lights become room-bound (or plain again). */
  roomLights(on: boolean): void;
  /** Cull by rooms (false: `?portals=off`). */
  readonly culling: boolean;
  /** The page's canvas: `data-tl-rooms` = "<rooms seen>/<rooms> <draws hidden> <mesh–light pairs lit>/<as without rooms>" (an export's only diagnostics surface; absent: none). */
  readonly canvas?: { setAttribute?(k: string, v: string): void } | null;
  changed(): void;
}

export interface RoomCullingDiagnostics {
  rooms: number;
  portals: number;
  /** Doorways with a door piece, and those closed now. */
  doors: number;
  doorsClosed: number;
  /** The room the eye was in at the last walk ("" : the outside). */
  eyeRoom: string;
  /** Rooms seen and whether the outside is. */
  seen: number;
  outside: boolean;
  /** Draws hidden by the last sweep, and draws in the scene then. */
  hidden: number;
  draws: number;
  /** Walks so far and the last one's time (ms), the sweeps' last time (ms). */
  walks: number;
  walkMs: number;
  sweepMs: number;
  /** Meshes with rooms per vertex, the time tagging them took in all (ms). */
  tagged: number;
  tagMs: number;
  /** Point and spot lights in a room, in a room not seen. */
  lights: number;
  lightsUnseen: number;
  /**
   * Pairs of a drawn mesh and a point or spot light that lights it (the
   * per-pixel light work), at the last sweep: with the rooms' tests and
   * culling, and as without them (every drawn-or-culled mesh by every light).
   */
  lightPairs: number;
  lightPairsWithout: number;
}

interface Tracked {
  /** Re-placed each frame (it moves without the render graph telling: an animated part, a light on a moving node). */
  readonly dynamic: boolean;
  readonly kind: 'mesh' | 'light' | 'tagged';
}

interface ObjectRooms {
  origin: readonly number[];
  rooms: readonly ArchitectureRoomPlan[];
  layer: RoomGraphObject['layer'];
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class RoomCulling implements BatchMembership {
  private readonly objects = new Map<string, ObjectRooms>();
  private graph: RoomGraph | null = null;
  /** The block layers rooms are drawn on (only their chunks take rooms per vertex). */
  private layersWithRooms = new Set<string>();
  private dirty = false;
  /** Bumped whenever the rooms change (tags and keys made before are stale). */
  private revision = 0;
  /** Room keys by the graph's room key string: kept for the page's life, so a room keeps its key through edits. */
  private readonly keys = new Map<string, number>();
  private keyOfIndex = new Int32Array(0);
  private indexOfKey = new Map<number, number>();
  private readonly tracked = new Map<THREE.Object3D, Tracked>();
  /** The tracked drawables and lights that move without the render graph telling (looked at each frame). */
  private readonly dynamics = new Map<THREE.Object3D, Tracked>();
  /** Per position array: its vertices' rooms at a revision (cut-away pieces share one). */
  private readonly tags = new WeakMap<ArrayLike<number>, { revision: number; matrix: THREE.Matrix4; attribute: THREE.BufferAttribute | null; keys: Set<number> }>();
  private readonly vis: RoomVisibility = roomVisibility(0);
  private walked = false;
  private readonly view = new Float64Array(16);
  private readonly eye = new Float64Array(3);
  private doorState = new Uint8Array(0);
  /** Per room: 1 while a cut-away hides what covers it (its top opens to the sky). */
  private cutState = new Uint8Array(0);
  private sceneCount = -1;
  private frames = 0;
  private hiddenAny = false;
  private readonly d: RoomCullingDiagnostics = { rooms: 0, portals: 0, doors: 0, doorsClosed: 0, eyeRoom: '', seen: 0, outside: true, hidden: 0, draws: 0, walks: 0, walkMs: 0, sweepMs: 0, tagged: 0, tagMs: 0, lights: 0, lightsUnseen: 0, lightPairs: 0, lightPairsWithout: 0 };
  private bound = false;
  /** The last `data-tl-rooms` written. */
  private mark = '';
  /** Spheres (x, y, z, r) of what moved this frame (the shadow budget redraws the maps they are in). */
  private moving: number[] = [];
  private movingFrame: number[] = [];
  /** Where each dynamic drawable was last frame. */
  private readonly lastAt = new WeakMap<THREE.Object3D, THREE.Vector3>();

  constructor(private readonly deps: RoomCullingDeps) {}

  /** An architecture object's rooms (expanded), or null when it has none any more. */
  setObject(id: string, origin: readonly number[], rooms: readonly ArchitectureRoomPlan[] | null, layer: RoomGraphObject['layer'] = null): void {
    const had = this.objects.get(id);
    if (rooms === null || rooms.length === 0) {
      if (had === undefined) return;
      this.objects.delete(id);
    } else {
      // An edit re-expands the object (a block dug on its layer, a slider dragged): the rooms are often what they were.
      if (had !== undefined && sameArray(had.origin, origin) && JSON.stringify(had.layer) === JSON.stringify(layer) && (had.rooms === rooms || JSON.stringify(had.rooms) === JSON.stringify(rooms))) return;
      this.objects.set(id, { origin: [...origin], rooms, layer });
      // The lights become room-bound as the first rooms arrive (while the scene is realized, before its programs are built).
      if (!this.bound) {
        this.bound = true;
        this.deps.roomLights(true);
      }
    }
    this.dirty = true;
    this.deps.changed();
  }

  /**
   * Each room's box (world; inset `inset` metres from its walls, floor and
   * top): a probe volume per room, so a room's light is never read through
   * a wall from the next room's probes.
   */
  roomBoxes(inset: number): { min: number[]; max: number[] }[] {
    if (this.dirty) this.rebuild();
    return (this.graph?.rooms ?? []).map((r) => ({ min: [r.box[0] + inset, r.floor + inset, r.box[1] + inset], max: [r.box[2] - inset, r.top - inset, r.box[3] - inset] })).filter((b) => b.max.every((v, i) => v > b.min[i]!));
  }

  /** Whether the page has rooms. */
  hasRooms(): boolean {
    return this.graph !== null && this.graph.rooms.length > 0;
  }

  /** Whether a room key is seen by the last walk (no walk, culling off, an unknown key: seen). */
  roomSeen(key: number | undefined): boolean {
    if (key === undefined || !this.walked || !this.deps.culling) return true;
    if (key === 0) return this.vis.outside;
    const i = this.indexOfKey.get(key);
    return i === undefined || this.vis.rooms[i] === 1;
  }

  // ---- the render graph's membership -----------------------------------------------------

  listed(o: THREE.Object3D): void {
    const kind = kindOf(o);
    if (kind === null) return;
    if (this.dirty) this.rebuild();
    const dynamic = (o as THREE.SkinnedMesh).isSkinnedMesh === true || o.matrixWorldAutoUpdate || o.matrixAutoUpdate;
    const t: Tracked = { dynamic, kind };
    this.tracked.set(o, t);
    if (dynamic && kind !== 'tagged') this.dynamics.set(o, t);
    this.assign(o, kind);
    if (kind !== 'light' && this.walked) this.applyTo(o);
  }

  unlisted(o: THREE.Object3D): void {
    this.tracked.delete(o);
    this.dynamics.delete(o);
  }

  moved(o: THREE.Object3D): void {
    if (this.dirty) this.rebuild();
    const t = this.tracked.get(o);
    if (t !== undefined && t.kind !== 'tagged') this.assign(o, t.kind);
    if (t?.kind === 'mesh') this.noteMover(o);
  }

  /** Spheres (x, y, z, r) of the drawables that moved since the last drawn frame. */
  movers(): ArrayLike<number> {
    return this.moving;
  }

  private noteMover(o: THREE.Object3D): void {
    const geo = (o as THREE.Mesh).geometry;
    if (geo === undefined) return;
    if (geo.boundingSphere === null) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (bs === null) return;
    _v.copy(bs.center).applyMatrix4(o.matrixWorld);
    this.movingFrame.push(_v.x, _v.y, _v.z, bs.radius * o.matrixWorld.getMaxScaleOnAxis());
  }

  dropped(o: THREE.Object3D): void {
    this.tracked.delete(o);
    this.dynamics.delete(o);
  }

  // ---- per frame ---------------------------------------------------------------------------

  /** Once a drawn frame, after the world matrices are current: rooms rebuilt if they changed, the walk, the sweep. */
  update(camera: THREE.Camera): void {
    if (this.dirty) this.rebuild();
    // What moved since the last frame: the parts moved with their objects (heard) and the animated ones (looked at).
    for (const [o, t] of this.dynamics) {
      if (t.kind !== 'mesh') continue;
      const e = o.matrixWorld.elements;
      const at = this.lastAt.get(o);
      if (at !== undefined && at.x === e[12] && at.y === e[13] && at.z === e[14] && (o as THREE.SkinnedMesh).isSkinnedMesh !== true) continue;
      if (at === undefined) this.lastAt.set(o, new THREE.Vector3(e[12], e[13], e[14]));
      else at.set(e[12]!, e[13]!, e[14]!);
      this.noteMover(o);
    }
    [this.moving, this.movingFrame] = [this.movingFrame, this.moving];
    this.movingFrame.length = 0;
    const g = this.graph;
    if (g === null || g.rooms.length === 0) return;
    for (const [o, t] of this.dynamics) this.assign(o, t.kind);
    if (!this.deps.culling) {
      if (++this.frames % (SWEEP_FRAMES * 2) === 0) {
        this.countPairs();
        this.writeMark();
      }
      return;
    }
    const doorsChanged = this.readDoors(g);
    const cutsChanged = this.readCuts(g);
    const viewChanged = this.readView(camera);
    let sweep = false;
    if (doorsChanged || cutsChanged || viewChanged || !this.walked) {
      const t0 = performance.now();
      const rooms = this.vis.rooms.slice();
      const outside = this.vis.outside;
      walkRooms(g, this.eye, this.view, (p) => this.portalOpen(p), this.vis, (r) => this.cutState[r] === 1);
      this.walked = true;
      this.d.walks += 1;
      this.d.walkMs = performance.now() - t0;
      sweep = outside !== this.vis.outside || !sameBytes(rooms, this.vis.rooms);
    }
    const n = this.deps.scene.children.length;
    if (sweep || n !== this.sceneCount || ++this.frames % SWEEP_FRAMES === 0) this.sweep();
  }

  diagnostics(): RoomCullingDiagnostics {
    const g = this.graph;
    this.d.rooms = g?.rooms.length ?? 0;
    this.d.portals = g?.portals.length ?? 0;
    this.d.eyeRoom = g !== null && this.vis.eyeRoom !== ROOM_OUTSIDE ? (g.rooms[this.vis.eyeRoom]?.key ?? '') : '';
    let seen = 0;
    for (const v of this.vis.rooms) seen += v;
    this.d.seen = this.walked ? seen : this.d.rooms;
    this.d.outside = this.walked ? this.vis.outside : true;
    return { ...this.d };
  }

  /** Every drawable back in the view, keys and tags gone. */
  dispose(): void {
    for (const o of this.deps.scene.children) hideFromView(o, HIDDEN_BY_ROOM, false);
    this.objects.clear();
    this.tracked.clear();
    this.dynamics.clear();
    this.graph = null;
  }

  // ---- internals ---------------------------------------------------------------------------

  private rebuild(): void {
    this.dirty = false;
    this.revision += 1;
    const list: RoomGraphObject[] = [...this.objects].map(([id, r]) => ({ id, origin: r.origin, rooms: r.rooms, layer: r.layer }));
    const g = buildRoomGraph(list);
    this.graph = g;
    this.layersWithRooms = new Set(list.flatMap((o) => (o.layer !== undefined && o.layer !== null ? [o.layer.id] : [])));
    this.keyOfIndex = new Int32Array(g.rooms.length);
    this.indexOfKey = new Map();
    g.rooms.forEach((r, i) => {
      let k = this.keys.get(r.key);
      if (k === undefined) this.keys.set(r.key, (k = this.keys.size + 1));
      this.keyOfIndex[i] = k;
      this.indexOfKey.set(k, i);
    });
    this.doorState = new Uint8Array(g.portals.length);
    this.cutState = new Uint8Array(g.rooms.length);
    this.walked = false;
    const any = g.rooms.length > 0;
    if (any !== this.bound) {
      this.bound = any;
      this.deps.roomLights(any);
    }
    if (!any && this.hiddenAny) {
      for (const o of this.deps.scene.children) hideFromView(o, HIDDEN_BY_ROOM, false);
      this.hiddenAny = false;
    }
    for (const [o, t] of this.tracked) this.assign(o, t.kind);
  }

  /** Put the room key on a drawable or light (or its vertices' keys on a spanning mesh). */
  private assign(o: THREE.Object3D, kind: Tracked['kind']): void {
    const g = this.graph;
    if (g === null || g.rooms.length === 0) {
      if (o.userData[ROOM_KEY] !== undefined || o.userData[ROOM_VERTEX_KEYS] !== undefined) this.clear(o);
      return;
    }
    if (kind === 'tagged') {
      const layer = o.userData[ROOM_TAG_KEY] as unknown;
      // A block layer no room is drawn on: its chunks are in no room.
      if (typeof layer === 'string' && !this.layersWithRooms.has(layer)) {
        if (o.userData[ROOM_KEY] !== undefined || o.userData[ROOM_VERTEX_KEYS] !== undefined) this.clear(o);
        return;
      }
      this.tag(o as THREE.Mesh, g);
      return;
    }
    let x: number;
    let y: number;
    let z: number;
    const e = o.matrixWorld.elements;
    if (kind === 'light') {
      [x, y, z] = [e[12]!, e[13]!, e[14]!];
    } else {
      const geo = (o as THREE.Mesh).geometry;
      if (geo.boundingSphere === null) geo.computeBoundingSphere();
      const c = geo.boundingSphere?.center ?? _v.set(0, 0, 0);
      _v.copy(c).applyMatrix4(o.matrixWorld);
      [x, y, z] = [_v.x, _v.y, _v.z];
    }
    const i = g.roomAt(x, y, z);
    const key = i === ROOM_OUTSIDE ? 0 : this.keyOfIndex[i]!;
    if (o.userData[ROOM_KEY] === key) return;
    o.userData[ROOM_KEY] = key;
    if (kind === 'mesh') this.deps.regroup(o);
    if (this.walked && kind === 'mesh') this.applyTo(o);
  }

  private clear(o: THREE.Object3D): void {
    delete o.userData[ROOM_KEY];
    delete o.userData[ROOM_VERTEX_KEYS];
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (geo?.getAttribute(ROOM_ATTRIBUTE) !== undefined) geo.deleteAttribute(ROOM_ATTRIBUTE);
    hideFromView(o, HIDDEN_BY_ROOM, false);
    if ((o as THREE.Mesh).isMesh === true) this.deps.regroup(o);
  }

  /** The room each vertex of a spanning mesh looks into: one key for the mesh when they agree, per vertex otherwise. */
  private tag(mesh: THREE.Mesh, g: RoomGraph): void {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (pos === undefined || nor === undefined) return;
    const t0 = performance.now();
    let known = this.tags.get(pos.array);
    if (known === undefined || known.revision !== this.revision || !known.matrix.equals(mesh.matrixWorld)) {
      known = this.tagVertices(pos, nor, mesh.matrixWorld, g);
      this.tags.set(pos.array, known);
      this.d.tagMs += performance.now() - t0;
    }
    if (known.attribute === null) {
      if (geo.getAttribute(ROOM_ATTRIBUTE) !== undefined) geo.deleteAttribute(ROOM_ATTRIBUTE);
      delete mesh.userData[ROOM_VERTEX_KEYS];
      mesh.userData[ROOM_KEY] = known.keys.values().next().value ?? 0;
    } else {
      if (geo.getAttribute(ROOM_ATTRIBUTE) !== known.attribute) geo.setAttribute(ROOM_ATTRIBUTE, known.attribute);
      delete mesh.userData[ROOM_KEY];
      mesh.userData[ROOM_VERTEX_KEYS] = known.keys;
      this.d.tagged += 1;
    }
    if (this.walked) this.applyTo(mesh);
  }

  private tagVertices(pos: THREE.BufferAttribute, nor: THREE.BufferAttribute, matrix: THREE.Matrix4, g: RoomGraph): { revision: number; matrix: THREE.Matrix4; attribute: THREE.BufferAttribute | null; keys: Set<number> } {
    const keys = new Set<number>();
    const out = { revision: this.revision, matrix: matrix.clone(), attribute: null as THREE.BufferAttribute | null, keys };
    // Far from every room: all of it is outside.
    _box.setFromBufferAttribute(pos).applyMatrix4(matrix).expandByScalar(NUDGE * 2);
    if (!g.rooms.some((r) => r.box[0] <= _box.max.x && r.box[2] >= _box.min.x && r.box[1] <= _box.max.z && r.box[3] >= _box.min.z && r.floor <= _box.max.y && r.top >= _box.min.y)) {
      keys.add(0);
      return out;
    }
    const e = matrix.elements;
    _m.copy(matrix);
    const n = pos.count;
    const arr = new Float32Array(n);
    const p = pos.array;
    const q = nor.array;
    const ps = pos.itemSize;
    const qs = nor.itemSize;
    for (let i = 0; i < n; i++) {
      const x = p[i * ps]!;
      const y = p[i * ps + 1]!;
      const z = p[i * ps + 2]!;
      const nx = q[i * qs]!;
      const ny = q[i * qs + 1]!;
      const nz = q[i * qs + 2]!;
      // World position and normal (the meshes this serves are placed, not scaled).
      const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]! + (e[0]! * nx + e[4]! * ny + e[8]! * nz) * NUDGE;
      const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]! + (e[1]! * nx + e[5]! * ny + e[9]! * nz) * NUDGE;
      const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]! + (e[2]! * nx + e[6]! * ny + e[10]! * nz) * NUDGE;
      const r = g.roomAt(wx, wy, wz);
      const k = r === ROOM_OUTSIDE ? 0 : this.keyOfIndex[r]!;
      arr[i] = k;
      keys.add(k);
    }
    if (keys.size > 1) out.attribute = new THREE.BufferAttribute(arr, 1);
    return out;
  }

  /** Whether a portal lets sight through: no door piece across it, or one that is open. */
  private portalOpen(p: number): boolean {
    return this.doorState[p] !== 1;
  }

  /** Read the doors (closed: every cell edge across the doorway's foot holds a closed blocking piece); true when any changed. */
  private readDoors(g: RoomGraph): boolean {
    let changed = false;
    let doors = 0;
    let closed = 0;
    g.portals.forEach((p, i) => {
      if (p.door === null) return;
      doors += 1;
      let all = p.door.edges.length > 0;
      for (let k = 0; all && k < p.door.edges.length; k += 4) {
        all = this.deps.edgeClosed(p.door.layer, p.door.edges[k]!, p.door.edges[k + 1]!, p.door.edges[k + 2]!, p.door.edges[k + 3]!);
      }
      const v = all ? 1 : 0;
      closed += v;
      if (this.doorState[i] !== v) {
        this.doorState[i] = v;
        changed = true;
      }
    });
    this.d.doors = doors;
    this.d.doorsClosed = closed;
    return changed;
  }

  /** Read which covered rooms a cut-away opens to the sky; true when any changed. */
  private readCuts(g: RoomGraph): boolean {
    const cutsOver = this.deps.cutsOver;
    if (cutsOver === undefined) return false;
    let changed = false;
    g.rooms.forEach((r, i) => {
      const v = g.tops[i] !== null && cutsOver(r.box[0], r.box[1], r.box[2], r.box[3], r.floor) ? 1 : 0;
      if (this.cutState[i] !== v) {
        this.cutState[i] = v;
        changed = true;
      }
    });
    return changed;
  }

  /** Take the camera's view (projection × view) and eye; true when it changed. */
  private readView(camera: THREE.Camera): boolean {
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = _m.elements;
    let changed = false;
    for (let k = 0; k < 16; k++) {
      if (Math.abs(this.view[k]! - m[k]!) > VIEW_SAME * (1 + Math.abs(m[k]!))) changed = true;
      this.view[k] = m[k]!;
    }
    const w = camera.matrixWorld.elements;
    this.eye[0] = w[12]!;
    this.eye[1] = w[13]!;
    this.eye[2] = w[14]!;
    return changed;
  }

  /** Whether a drawable is out of sight: its room (or every room its vertices look into) not seen. */
  private unseen(o: THREE.Object3D): boolean {
    const keys = o.userData[ROOM_VERTEX_KEYS] as ReadonlySet<number> | undefined;
    if (keys !== undefined) {
      for (const k of keys) if (this.roomSeen(k)) return false;
      return true;
    }
    const k = o.userData[ROOM_KEY] as number | undefined;
    return k !== undefined && !this.roomSeen(k);
  }

  private applyTo(o: THREE.Object3D): void {
    if (!this.deps.culling || (o as THREE.Light).isLight === true) return;
    const hide = this.unseen(o);
    hideFromView(o, HIDDEN_BY_ROOM, hide);
    if (hide) this.hiddenAny = true;
  }

  /** Hide what is out of sight and show what came into it, over the scene's draws. */
  private sweep(): void {
    const t0 = performance.now();
    const children = this.deps.scene.children;
    this.sceneCount = children.length;
    let hidden = 0;
    let draws = 0;
    for (const o of children) {
      if ((o as THREE.Light).isLight === true) continue;
      draws += 1;
      const hide = this.unseen(o);
      if (hideFromView(o, HIDDEN_BY_ROOM, hide)) this.deps.changed();
      if (hide) hidden += 1;
    }
    this.hiddenAny = hidden > 0;
    this.d.hidden = hidden;
    this.d.draws = draws;
    this.countPairs();
    this.d.sweepMs = performance.now() - t0;
    this.writeMark();
  }

  /** `data-tl-rooms` on the canvas, when it changed. */
  private writeMark(): void {
    const n = this.graph?.rooms.length ?? 0;
    let seen = 0;
    if (this.walked && this.deps.culling) for (const v of this.vis.rooms) seen += v;
    else seen = n;
    const mark = `${seen}/${n} ${this.d.hidden} ${this.d.lightPairs}/${this.d.lightPairsWithout}`;
    if (mark === this.mark || typeof this.deps.canvas?.setAttribute !== 'function') return;
    this.mark = mark;
    this.deps.canvas.setAttribute('data-tl-rooms', mark);
  }

  /** The lights in rooms (and in rooms not seen) and the mesh–light pairs lit, with and without the rooms. */
  private countPairs(): void {
    const children = this.deps.scene.children;
    const lights: THREE.Light[] = [];
    let unseen = 0;
    for (const o of children) {
      const l = o as THREE.Light;
      if (l.isLight !== true || !((l as THREE.PointLight).isPointLight === true || (l as THREE.SpotLight).isSpotLight === true) || !l.visible) continue;
      lights.push(l);
      if (l.userData[ROOM_KEY] !== undefined && l.userData[ROOM_KEY] !== 0 && !this.roomSeen(l.userData[ROOM_KEY] as number)) unseen += 1;
    }
    let pairs = 0;
    let without = 0;
    for (const o of children) {
      if ((o as THREE.Mesh).isMesh !== true) continue;
      without += lights.length;
      if (!o.layers.isEnabled(0)) continue;
      for (const l of lights) if (lightsObject(l, o)) pairs += 1;
    }
    this.d.lights = lights.filter((l) => l.userData[ROOM_KEY] !== undefined && l.userData[ROOM_KEY] !== 0).length;
    this.d.lightsUnseen = unseen;
    this.d.lightPairs = pairs;
    this.d.lightPairsWithout = without;
  }
}

/** What membership makes of a listed object: a mesh in one room, a spanning mesh, a light, or nothing (instanced draws, other kinds). */
function kindOf(o: THREE.Object3D): Tracked['kind'] | null {
  const l = o as THREE.Light;
  if (l.isLight === true) return (l as THREE.PointLight).isPointLight === true || (l as THREE.SpotLight).isSpotLight === true ? 'light' : null;
  const m = o as THREE.Mesh;
  if (m.isMesh !== true || (m as THREE.InstancedMesh).isInstancedMesh === true) return null;
  return m.userData[ROOM_TAG_KEY] !== undefined ? 'tagged' : 'mesh';
}

function sameArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
