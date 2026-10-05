/**
 * The authored scene as the scene adapter reads a running game: the Scene
 * view draws through the same adapter as Play, with this standing in for the
 * runtime. There is no simulation: transforms are the authored ones (or a
 * gizmo drag's, or a timeline scrub's), the camera is the Scene view's own,
 * and nothing steps.
 *
 * - Each open scene is one batch of entity documents (the stored components,
 *   what a game's scene hands the adapter). A document keeps its object
 *   while its components, parent and tags stay the same, so a transform edit
 *   re-realizes nothing; any other edit hands the adapter a new object and
 *   the adapter realizes that entity again. Block-layer cells are left out:
 *   the editor's block tools drive the adapter's block view incrementally.
 * - Transforms are reported per entity (`forEachMoved`): only the ones that
 *   changed since the adapter last read them.
 * - Editor lighting: the scenes' lights are left out of the documents and a
 *   two-light rig (a key, a fill) is a batch of its own.
 * - Inactive objects are hidden (`hiddenEntities`), with their children.
 * - Objects that never move (their own or a folder's Static flag) say so in
 *   their documents, as a game's resolved scene does: the adapter merges
 *   them (static batching).
 *
 * Browser-safe and three.js-free except for the camera it reads.
 */
import type { SceneRuntime } from '@thirdlight/three-adapter';
import type { InterpolatedVisitor, SceneSetView } from '@thirdlight/runtime';
import type * as THREE from 'three';

import type { ProjectedEntity } from '../session/projection';

type Trs = { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] };
type Doc = { readonly id: string; readonly parentId?: string; readonly tags?: number; readonly static?: true; readonly components: Readonly<Record<string, unknown>> };

const IDENTITY: Trs = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
/** The batch of entities in no scene (projects without scenes). */
const NO_SCENE = '';
/** The editor lighting rig: a key light from above front-right and a cool fill — its own scene, never a project's. */
const RIG_SCENE = '\u0000editor-rig';
const RIG_KEY_DIRECTION = (() => {
  const d = [-5, -10, -7];
  const n = Math.hypot(d[0]!, d[1]!, d[2]!);
  return d.map((v) => v / n);
})();
const RIG: readonly Doc[] = Object.freeze([
  { id: '\u0000editor-rig:key', components: { transform: IDENTITY, light: { type: 'directional', color: '#ffffff', intensity: 1, direction: RIG_KEY_DIRECTION } } },
  { id: '\u0000editor-rig:fill', components: { transform: IDENTITY, light: { type: 'ambient', color: '#8899bb', intensity: 0.6 } } },
]);

export interface SceneSourceFacts {
  /** What decides how an asset's objects are drawn (its version, vertex colours, default materials): a change realizes them again. */
  assetKey(assetId: string): string;
  /** The project's instance-set chunk size (m), applied to sets without their own. */
  instanceChunkSize(): number | undefined;
}

const sameTrs = (a: Trs, b: Trs): boolean => {
  for (let i = 0; i < 3; i += 1) if (a.position[i] !== b.position[i] || a.scale[i] !== b.scale[i]) return false;
  for (let i = 0; i < 4; i += 1) if (a.rotation[i] !== b.rotation[i]) return false;
  return true;
};

export class SceneSource implements SceneRuntime {
  private readonly facts: SceneSourceFacts;
  private readonly docs = new Map<string, { key: string; doc: Doc; sceneId: string }>();
  private readonly authored = new Map<string, Trs>();
  private readonly overrides = new Map<string, Trs>();
  private readonly moved = new Set<string>();
  /** Entity order (document order: parents first) as last synced. */
  private order: string[] = [];
  private revision = 0;
  private view: SceneSetView | null = null;
  private hidden: ReadonlySet<string> = new Set();
  private statics: ReadonlySet<string> = new Set();
  /** Entities whose static flag changed since the last sync (their documents are made again). */
  private readonly flipped = new Set<string>();
  private rig = false;
  private camera: THREE.PerspectiveCamera | null = null;

  constructor(facts: SceneSourceFacts) {
    this.facts = facts;
  }

  /** The Scene view's camera (the adapter draws from it). */
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
  }

  /** Editor lighting (the rig) or the scenes' own lights; every light entity's document changes. */
  setRig(on: boolean, entities: readonly ProjectedEntity[]): void {
    if (on === this.rig) return;
    this.rig = on;
    this.sync(entities, entities.filter((e) => e.components['light'] !== undefined));
    // The rig's own batch comes or goes even when no document changed.
    this.publish();
  }

  /** Whether the rig lights the view (editor lighting). */
  get rigOn(): boolean {
    return this.rig;
  }

  /**
   * The entities shown now, and the ones that changed (null: all). An
   * entity's transform is reported as moved when it differs from the one
   * the adapter has; its document is replaced when anything else differs.
   */
  sync(entities: readonly ProjectedEntity[], changed: readonly ProjectedEntity[] | null): void {
    let structure = false;
    let list = changed ?? entities;
    if (changed !== null && this.flipped.size > 0) {
      const named = new Set(changed.map((e) => e.id));
      list = [...changed, ...entities.filter((e) => this.flipped.has(e.id) && !named.has(e.id))];
    }
    this.flipped.clear();
    for (const e of list) {
      const t: Trs = e.kind === 'folder' ? IDENTITY : { position: e.position, rotation: e.rotation, scale: e.scale };
      const before = this.authored.get(e.id);
      if (before === undefined || !sameTrs(before, t)) {
        this.authored.set(e.id, t);
        if (!this.overrides.has(e.id)) this.moved.add(e.id);
      }
      const key = this.keyOf(e);
      const sceneId = e.sceneId ?? NO_SCENE;
      const had = this.docs.get(e.id);
      if (had !== undefined && had.key === key && had.sceneId === sceneId) continue;
      this.docs.set(e.id, { key, doc: this.docOf(e, t), sceneId });
      structure = true;
    }
    // The order and the entities that left (every sync: an entity may leave in a sync that names none).
    const ids = entities.map((e) => e.id);
    if (ids.length !== this.order.length || ids.some((id, i) => this.order[i] !== id)) {
      structure = true;
      const live = new Set(ids);
      for (const id of [...this.docs.keys()]) {
        if (live.has(id)) continue;
        this.docs.delete(id);
        this.authored.delete(id);
        this.overrides.delete(id);
        this.moved.delete(id);
      }
      this.order = ids;
    }
    if (structure) this.publish();
  }

  /** The inactive objects (hidden with their children); the same set object while it does not change. */
  setHidden(ids: ReadonlySet<string>): void {
    if (ids.size === this.hidden.size && [...ids].every((id) => this.hidden.has(id))) return;
    this.hidden = ids;
  }

  /** The objects that never move (a folder's Static flag passed down included); the same set object while it does not change. */
  setStatic(ids: ReadonlySet<string>): void {
    if (ids === this.statics) return;
    for (const id of ids) if (!this.statics.has(id)) this.flipped.add(id);
    for (const id of this.statics) if (!ids.has(id)) this.flipped.add(id);
    this.statics = ids;
  }

  /** Draw an entity at this local transform for now (a gizmo drag, a timeline scrub); null: its authored one again. */
  setOverride(id: string, t: Trs | null): void {
    if (t === null) {
      if (this.overrides.delete(id)) this.moved.add(id);
      return;
    }
    const before = this.overrides.get(id);
    if (before !== undefined && sameTrs(before, t)) return;
    this.overrides.set(id, { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] });
    this.moved.add(id);
  }

  hasOverride(id: string): boolean {
    return this.overrides.has(id);
  }

  overriddenIds(): string[] {
    return [...this.overrides.keys()];
  }

  /** The local transform drawn now (an override, else the authored one). */
  localOf(id: string): Trs | null {
    return this.overrides.get(id) ?? this.authored.get(id) ?? null;
  }

  // ---- What the scene adapter reads ------------------------------------------

  sceneSet(): SceneSetView {
    if (this.view === null) this.publish();
    return this.view!;
  }

  forEachMoved(visit: InterpolatedVisitor): boolean {
    for (const id of this.moved) {
      const t = this.localOf(id);
      if (t !== null) visit(id, t.position, t.rotation, t.scale);
    }
    this.moved.clear();
    return true;
  }

  forEachInterpolated(visit: InterpolatedVisitor): boolean {
    for (const id of this.order) {
      const t = this.localOf(id);
      if (t !== null) visit(id, t.position, t.rotation, t.scale);
    }
    for (const d of RIG) visit(d.id, IDENTITY.position, IDENTITY.rotation, IDENTITY.scale);
    this.moved.clear();
    return true;
  }

  getInterpolatedState(): ReturnType<SceneRuntime['getInterpolatedState']> {
    const transforms: { id: string; position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }[] = [];
    this.forEachInterpolated((id, p, r, s) => transforms.push({ id, position: [p[0]!, p[1]!, p[2]!], rotation: [r[0]!, r[1]!, r[2]!, r[3]!], scale: [s[0]!, s[1]!, s[2]!] }));
    return { ok: true, state: { stepIndex: 0, simTime: 0, alpha: 0, transforms } };
  }

  hiddenEntities(): ReadonlySet<string> {
    return this.hidden;
  }

  readCameraView(position: number[], rotation: number[]): { fovY: number; near: number; far: number; letterbox: number } | null {
    const c = this.camera;
    if (c === null) return null;
    position[0] = c.position.x;
    position[1] = c.position.y;
    position[2] = c.position.z;
    rotation[0] = c.quaternion.x;
    rotation[1] = c.quaternion.y;
    rotation[2] = c.quaternion.z;
    rotation[3] = c.quaternion.w;
    return { fovY: c.fov, near: c.near, far: c.far, letterbox: 0 };
  }

  // ---- Documents ---------------------------------------------------------------

  /** What makes a document (everything the adapter realizes from, not the transform). */
  private keyOf(e: ProjectedEntity): string {
    const { transform: _t, blockLayer: _b, ...rest } = e.components;
    void _t;
    void _b;
    const comps: Record<string, unknown> = rest;
    if (this.rig) delete comps['light'];
    const assets = [e.assetId, e.instances?.assetId].filter((a): a is string => a !== undefined).map((a) => [a, this.facts.assetKey(a)]);
    return JSON.stringify([e.parentId, e.tags, this.statics.has(e.id), comps, assets, e.instances !== undefined && e.instances.chunkSize === undefined ? (this.facts.instanceChunkSize() ?? null) : null]);
  }

  private docOf(e: ProjectedEntity, t: Trs): Doc {
    const components: Record<string, unknown> = { ...e.components, transform: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } };
    if (e.kind === 'folder') delete components['folder'];
    // The block tools hand the adapter's block view the layer's cells themselves.
    delete components['blockLayer'];
    if (this.rig) delete components['light'];
    const inst = components['instances'] as { chunkSize?: number } | undefined;
    const chunk = this.facts.instanceChunkSize();
    if (inst !== undefined && inst.chunkSize === undefined && chunk !== undefined) components['instances'] = { ...inst, chunkSize: chunk };
    return Object.freeze({ id: e.id, ...(e.parentId !== null ? { parentId: e.parentId } : {}), tags: e.tags, ...(this.statics.has(e.id) ? { static: true as const } : {}), components: Object.freeze(components) });
  }

  private publish(): void {
    this.revision += 1;
    const lists = new Map<string, Doc[]>();
    for (const id of this.order) {
      const d = this.docs.get(id);
      if (d === undefined) continue;
      let list = lists.get(d.sceneId);
      if (list === undefined) lists.set(d.sceneId, (list = []));
      list.push(d.doc);
    }
    // A scene's list keeps its object while none of its documents changed (the adapter compares lists, then documents).
    const before = new Map((this.view?.batches ?? []).map((b) => [b.sceneId, b.entities as unknown as readonly Doc[]]));
    const batches: { sceneId: string; start: boolean; entities: readonly Doc[] }[] = [];
    for (const [sceneId, list] of lists) {
      const old = before.get(sceneId);
      const same = old !== undefined && old.length === list.length && old.every((d, i) => d === list[i]);
      batches.push(Object.freeze({ sceneId, start: false, entities: same ? old : Object.freeze(list) }));
    }
    if (this.rig) batches.push(Object.freeze({ sceneId: RIG_SCENE, start: false, entities: before.get(RIG_SCENE) ?? RIG }));
    this.view = Object.freeze({ revision: this.revision, batches: Object.freeze(batches), status: Object.freeze({}), spawned: Object.freeze([]) }) as unknown as SceneSetView;
  }
}
