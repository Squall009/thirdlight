/**
 * Sockets — entities riding on named nodes of other entities'
 * models, resolved in the simulation step.
 *
 * An attachment is (entity, target, node, offset). Every fixed step, after
 * the animators stepped, the attached entity's transform is set so that its
 * world pose is `targetWorld · node · offset`, where `node` is the node's
 * matrix in the target model's space posed by the target's animator
 * (`RigPoser`) and `targetWorld` is the target entity composed up its
 * parents. The entity's own transform is written relative to its parent, so
 * its children ride along. Attachments that ride on other attachments
 * resolve in dependency order; a cycle is refused at attach time.
 *
 * Authored `socketAttach` components attach at load (unless `attached:
 * false`); scripts attach and detach (`ctx.sockets`). A detach keeps the
 * world pose (the entity stays where the node left it) or snaps back to the
 * transform the entity had when it was attached.
 *
 * Pure (no three.js): the rig data comes with the snapshot, so the page, the
 * simulation worker and the export resolve identical poses.
 */
import type { EntityV3, ModelRig } from '@thirdlight/project-model';

import type { AnimatorPose } from './animator';
import { RigPoser, composeMat4, decomposeMat4, invertMat4, mat4, mulMat4, type Mat4 } from './rig-pose';
import type { TransformState } from './types';

/** Components an attached entity may not carry (physics bodies are posed by physics; the scene camera by its module). */
const NOT_ATTACHABLE = ['collider', 'controller', 'mover', 'camera', 'cameraFollow'] as const;

/** Engine limit: at most this many live attachments (far above equipment slots on a crowd of characters). */
export const MAX_SOCKET_ATTACHMENTS = 1024;

export interface SocketHost {
  readonly curr: Map<string, TransformState>;
  /** An entity's parent id (null: a root; undefined: not loaded). */
  parentOf(id: string): string | null | undefined;
  /** The component names an entity carries (undefined: not loaded). */
  componentsOf(id: string): readonly string[] | undefined;
  /** The entity's animator pose now (null: no animator — its model rests). */
  poseOf(id: string): AnimatorPose | null;
  warn(message: string): void;
}

export interface SocketAttachment {
  readonly entityId: string;
  readonly target: string;
  readonly node: string;
}

interface Attachment {
  entityId: string;
  target: string;
  node: string;
  offset: Mat4;
  /** The entity's own transform when it was attached (a snap-back detach restores it). */
  restore: TransformState;
}

interface Authored {
  target: string;
  node: string;
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
  attached?: boolean;
}

const cloneT = (t: TransformState): TransformState => ({ position: [t.position[0], t.position[1], t.position[2]], rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]], scale: [t.scale[0], t.scale[1], t.scale[2]] });
const finiteVec = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export class SocketSystem {
  private readonly rigs: ReadonlyMap<string, ModelRig>;
  private readonly posers = new Map<string, RigPoser | null>();
  /** Entity → its model asset (every loaded entity with a `model`). */
  private readonly models = new Map<string, string>();
  /** Entity → its authored socket (loaded entities with `socketAttach`). */
  private readonly authored = new Map<string, Authored>();
  private readonly live = new Map<string, Attachment>();
  private listCache: readonly SocketAttachment[] | null = Object.freeze([]);
  private readonly warned = new Set<string>();
  // Scratch (no allocation per step).
  private readonly mA = mat4();
  private readonly mB = mat4();
  private readonly mC = mat4();
  private readonly mNode = mat4();
  private readonly mLocal = mat4();
  private readonly mTmp = mat4();
  private readonly tP: number[] = [0, 0, 0];
  private readonly tR: number[] = [0, 0, 0, 1];
  private readonly tS: number[] = [1, 1, 1];

  constructor(
    rigs: Readonly<Record<string, ModelRig>> | undefined,
    private readonly host: SocketHost,
  ) {
    this.rigs = new Map(Object.entries(rigs ?? {}));
  }

  /** True while some entity rides on a socket (the step then resolves them). */
  get active(): boolean {
    return this.live.size > 0;
  }

  /** Loaded entities (the start set, a loaded scene, a spawned copy): their models and authored sockets. */
  add(entities: readonly EntityV3[]): void {
    const attachNow: string[] = [];
    for (const e of entities) {
      const c = e.components as unknown as Record<string, unknown>;
      const model = c['model'] as { asset?: { assetId?: unknown } } | undefined;
      if (model !== undefined && typeof model.asset?.assetId === 'string') this.models.set(e.id, model.asset.assetId);
      const s = c['socketAttach'] as Authored | undefined;
      if (s !== undefined) {
        this.authored.set(e.id, s);
        if (s.attached !== false) attachNow.push(e.id);
      }
    }
    // After every model of the batch is known (a socket may name a later entity).
    for (const id of attachNow) this.attach(id);
  }

  /** Entities left the game: their attachments and every attachment riding on them go (keeping world poses). */
  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.models.delete(id);
      this.authored.delete(id);
      if (this.live.delete(id)) this.listCache = null;
    }
    for (const [id, a] of this.live) {
      if (ids.has(a.target)) {
        this.live.delete(id);
        this.listCache = null;
      }
    }
  }

  /** A new run: the authored sockets attach again; the ones scripts made are let go where they are. */
  reset(): void {
    this.live.clear();
    this.listCache = null;
    for (const [id, s] of this.authored) if (s.attached !== false) this.attach(id);
  }

  /** The live attachments, in attach order (a stable array while nothing changes). */
  list(): readonly SocketAttachment[] {
    if (this.listCache === null) this.listCache = Object.freeze([...this.live.values()].map((a) => Object.freeze({ entityId: a.entityId, target: a.target, node: a.node })));
    return this.listCache;
  }

  attachedTo(entityId: string): SocketAttachment | null {
    const a = this.live.get(entityId);
    return a === undefined ? null : { entityId: a.entityId, target: a.target, node: a.node };
  }

  /**
   * Attach `entityId` to `node` of `target`'s model with an offset. Without a
   * target the entity's authored socket is used (its target, node and
   * offset). Returns an error message, or null when attached.
   */
  attachOrWhy(entityId: string, target?: string, node?: string, position?: unknown, rotation?: unknown, scale?: unknown): string | null {
    const own = this.authored.get(entityId);
    const t = target ?? own?.target;
    const n = node ?? (target === undefined ? own?.node : undefined);
    if (t === undefined || n === undefined) return `"${entityId}" has no socket of its own: name a target and a node`;
    const kinds = this.host.componentsOf(entityId);
    if (kinds === undefined) return `no object "${entityId}" is loaded`;
    const clash = NOT_ATTACHABLE.filter((k) => kinds.includes(k));
    if (clash.length > 0) return `"${entityId}" carries ${clash.join(', ')} (posed by ${clash.includes('camera') || clash.includes('cameraFollow') ? 'its camera module' : 'physics'}), so it cannot ride on a socket`;
    if (this.host.componentsOf(t) === undefined) return `no target object "${t}" is loaded`;
    if (t === entityId) return 'an object cannot ride on its own model';
    const asset = this.models.get(t);
    if (asset === undefined) return `the target "${t}" has no model`;
    const poser = this.poserOf(asset);
    if (poser === null) return `no rig data for the model of "${t}" (the game's build carries rigs only when the project uses sockets)`;
    if (poser.nodeIndex(n) < 0) return `the model of "${t}" has no node "${n}"`;
    if (this.dependsOn(t, entityId)) return `attaching "${entityId}" to "${t}" would make a loop (the target rides on it)`;
    if (!this.live.has(entityId) && this.live.size >= MAX_SOCKET_ATTACHMENTS) return `at most ${MAX_SOCKET_ATTACHMENTS} objects ride on sockets at once`;
    const useOwn = target === undefined;
    const p = position !== undefined && position !== null ? position : useOwn ? own?.position : undefined;
    const r = rotation !== undefined && rotation !== null ? rotation : useOwn ? own?.rotation : undefined;
    const s = scale !== undefined && scale !== null ? scale : useOwn ? own?.scale : undefined;
    if (p !== undefined && !finiteVec(p, 3)) return 'the position offset is [x, y, z]';
    if (r !== undefined && (!finiteVec(r, 4) || Math.hypot(...r) < 1e-9)) return 'the rotation offset is a quaternion [x, y, z, w]';
    if (s !== undefined && !finiteVec(s, 3)) return 'the scale offset is [x, y, z]';
    let rq: number[] = [0, 0, 0, 1];
    if (r !== undefined) {
      const len = Math.hypot(...r);
      rq = r.map((x) => x / len);
    }
    const offset = composeMat4(mat4(), p ?? [0, 0, 0], rq, s ?? [1, 1, 1]);
    const cur = this.host.curr.get(entityId);
    if (cur === undefined) return `no object "${entityId}" is loaded`;
    const before = this.live.get(entityId);
    this.live.set(entityId, { entityId, target: t, node: n, offset, restore: before?.restore ?? cloneT(cur) });
    this.listCache = null;
    return null;
  }

  attach(entityId: string, target?: string, node?: string, position?: unknown, rotation?: unknown, scale?: unknown): boolean {
    const why = this.attachOrWhy(entityId, target, node, position, rotation, scale);
    if (why !== null) {
      this.warnOnce(`attach:${entityId}:${why}`, `socket: ${why}`);
      return false;
    }
    return true;
  }

  /** Let go of `entityId`: keep its world pose (default) or snap back to its transform from before the attach. */
  detach(entityId: string, keepWorld = true): boolean {
    const a = this.live.get(entityId);
    if (a === undefined) return false;
    this.live.delete(entityId);
    this.listCache = null;
    if (!keepWorld) {
      const cur = this.host.curr.get(entityId);
      if (cur !== undefined) {
        for (let k = 0; k < 3; k += 1) cur.position[k] = a.restore.position[k]!;
        for (let k = 0; k < 4; k += 1) cur.rotation[k] = a.restore.rotation[k]!;
        for (let k = 0; k < 3; k += 1) cur.scale[k] = a.restore.scale[k]!;
      }
    }
    return true;
  }

  /**
   * A node's world pose now (position and rotation; the target's model posed
   * by its animator). False when the target, its model, its rig or the node
   * is missing.
   */
  nodeWorld(target: string, node: string, position: number[], rotation: number[], scale?: number[]): boolean {
    if (!this.nodeWorldMatrix(target, node, this.mC)) return false;
    decomposeMat4(this.mC, position, rotation, scale ?? this.tS);
    return true;
  }

  /**
   * Pose every attached entity for this step (dependency order). `mirror`:
   * a committed copy of the transforms to keep in step (the runtime's
   * committed state), when there is one.
   */
  resolve(mirror?: Map<string, TransformState> | null): void {
    if (this.live.size === 0) return;
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id) || visiting.has(id)) return;
      const a = this.live.get(id);
      if (a === undefined) return;
      visiting.add(id);
      // What this pose depends on first: attachments on the target's chain.
      for (let cur: string | null | undefined = a.target, guard = 0; cur !== null && cur !== undefined && guard < 64; cur = this.host.parentOf(cur), guard += 1) {
        if (this.live.has(cur)) visit(cur);
      }
      // …and on the entity's own parents (its transform is written relative to them).
      for (let cur: string | null | undefined = this.host.parentOf(id), guard = 0; cur !== null && cur !== undefined && guard < 64; cur = this.host.parentOf(cur), guard += 1) {
        if (this.live.has(cur)) visit(cur);
      }
      this.resolveOne(a, mirror ?? null);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of this.live.keys()) visit(id);
  }

  private resolveOne(a: Attachment, mirror: Map<string, TransformState> | null): void {
    const cur = this.host.curr.get(a.entityId);
    if (cur === undefined) return;
    if (!this.nodeWorldMatrix(a.target, a.node, this.mC)) {
      this.warnOnce(`resolve:${a.entityId}`, `socket: "${a.entityId}" cannot find node "${a.node}" of "${a.target}"; it stays where it is`);
      return;
    }
    // desired world = targetWorld · node · offset
    mulMat4(this.mA, this.mC, a.offset);
    const parent = this.host.parentOf(a.entityId);
    if (parent !== null && parent !== undefined && this.worldMatrix(parent, this.mB)) {
      invertMat4(this.mC, this.mB);
      mulMat4(this.mB, this.mC, this.mA);
      decomposeMat4(this.mB, this.tP, this.tR, this.tS);
    } else decomposeMat4(this.mA, this.tP, this.tR, this.tS);
    for (let k = 0; k < 3; k += 1) cur.position[k] = this.tP[k]!;
    for (let k = 0; k < 4; k += 1) cur.rotation[k] = this.tR[k]!;
    for (let k = 0; k < 3; k += 1) cur.scale[k] = this.tS[k]!;
    const m = mirror?.get(a.entityId);
    if (m !== undefined) {
      for (let k = 0; k < 3; k += 1) m.position[k] = cur.position[k]!;
      for (let k = 0; k < 4; k += 1) m.rotation[k] = cur.rotation[k]!;
      for (let k = 0; k < 3; k += 1) m.scale[k] = cur.scale[k]!;
    }
  }

  /** targetWorld · node into `out` (false: something is missing). */
  private nodeWorldMatrix(target: string, node: string, out: Mat4): boolean {
    const asset = this.models.get(target);
    if (asset === undefined) return false;
    const poser = this.poserOf(asset);
    if (poser === null) return false;
    const idx = poser.nodeIndex(node);
    if (idx < 0) return false;
    if (!this.worldMatrix(target, this.mB)) return false;
    poser.nodeMatrix(idx, this.host.poseOf(target), this.mNode);
    mulMat4(out, this.mB, this.mNode);
    return true;
  }

  /** An entity's world matrix (its transform composed up its parents) into `out`. */
  private worldMatrix(id: string, out: Mat4): boolean {
    const chain: TransformState[] = [];
    for (let cur: string | null | undefined = id, guard = 0; cur !== null && cur !== undefined && guard < 64; cur = this.host.parentOf(cur), guard += 1) {
      const t = this.host.curr.get(cur);
      if (t === undefined) return chain.length > 0 ? this.compose(chain, out) : false;
      chain.push(t);
    }
    return this.compose(chain, out);
  }

  private compose(chain: readonly TransformState[], out: Mat4): boolean {
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    const local = this.mLocal;
    const tmp = this.mTmp;
    for (let k = chain.length - 1; k >= 0; k -= 1) {
      const t = chain[k]!;
      composeMat4(local, t.position, t.rotation, t.scale);
      mulMat4(tmp, out, local);
      out.set(tmp);
    }
    return true;
  }

  /** Whether `from`'s pose depends on `on` (through parents and attachments). */
  private dependsOn(from: string, on: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === on) return true;
      if (seen.has(id) || seen.size > 4096) continue;
      seen.add(id);
      const p = this.host.parentOf(id);
      if (p !== null && p !== undefined) stack.push(p);
      const a = this.live.get(id);
      if (a !== undefined) stack.push(a.target);
    }
    return false;
  }

  private poserOf(asset: string): RigPoser | null {
    let p = this.posers.get(asset);
    if (p === undefined) {
      const rig = this.rigs.get(asset);
      p = rig === undefined ? null : new RigPoser(rig, asset);
      if (rig?.truncated === true) this.warnOnce(`truncated:${asset}`, `socket: the rig of model "${asset}" carries only some of its clips (too much key data); nodes of the others rest`);
      this.posers.set(asset, p);
    }
    return p;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key) || this.warned.size > 256) return;
    this.warned.add(key);
    this.host.warn(message);
  }
}
