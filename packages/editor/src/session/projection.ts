/**
 * Browser projection state (sessions.md §6.2/§8.3/§9; packet 10).
 *
 * The browser holds a PROJECTION of the backend's authoritative state. It is
 * hydrated from the full state (the establish result / `queryEntities` / a
 * resync) and updated incrementally from `mutation.applied` change data
 * (commands.md §5.3 — "a client projection updates from this alone"). The
 * projection is display state only: on ANY gap, conflict, or resync the
 * client re-hydrates from the backend (the sole authority). The browser never
 * writes to browser storage as the authoritative project database.
 *
 * Normative behaviors pinned here (m1-acceptance §2.2):
 *  - the browser DEDUPS its own `requestId` (a `mutation.applied` for an
 *    already-applied command is ignored, not double-applied);
 *  - the GAP RULE: a `mutation.applied` with `revision > lastSeen + 1` means
 *    events were missed ⇒ the projection is stale and a full resync is
 *    required (the incremental change is NOT applied);
 *  - a `revision_conflict` is explained (with `currentRevision`), never
 *    silently lost — the projection stays valid and the caller re-syncs.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

import type { Entity, GameZoneComponent, CameraFollowComponent, LightComponent, SurfaceComponent, ModelAnimationComponent } from '@thirdlight/project-model';
import type { ChangeData, SetBehaviorPropertiesChange } from '@thirdlight/commands';

/** One projected entity (the display projection of a backend Entity). */
export interface ProjectedEntity {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'box' | 'camera' | 'model' | 'light' | 'entity' | 'folder';
  /** Own hierarchy flags (phase 12); folders pass them down (see session/hierarchy.ts). */
  active: boolean;
  locked: boolean;
  static: boolean;
  /** Phase 12 (b): the entity's own tag mask (0 = none). */
  tags: number;
  /** Local transform; a folder has none and shows the identity. */
  position: number[];
  rotation: number[];
  scale: number[];
  /**
   * M2 (packet 27): the whole-GLB reference a model entity resolves through
   * (`components.model.asset.assetId`). Reimport never changes it — only the
   * asset's `currentVersion` moves — so placements keep their entity ID,
   * transform and reference (project-model §18.1).
   */
  assetId?: string;
  /** One named piece of the model file (`components.model.piece`; absent: the whole file). */
  piece?: string;
  /** Phase 9.4: the object's material mapping (source material name or "*" → materialId). */
  materials?: Record<string, string>;
  /** Phase 9.5: a fog volume around the entity. */
  fogVolume?: { size: [number, number, number]; density: number; color: string; falloff?: number };
  /** Phase 9.7: the animator controller the model plays. */
  animator?: { controller: string; parameters?: Record<string, number | boolean> };
  /** Phase 9.9: the gameplay block components present on the entity (mover, trigger, switch, health, pickup, enemy). */
  blocks?: Partial<Record<BlockName, Record<string, unknown>>>;
  /**
   * M2 (packet 28): the informational prefab provenance a materialized copy
   * carries (`components.prefab`, project-model §20.4). It is what lets the
   * inspector label the entity "Copy of <displayName> — copies are
   * independent"; it grants no inheritance, override or revert behavior.
   */
  prefab?: { prefabId: string; localId: string };
  /** The box primitive's authored size and base color (the runtime draws both). */
  box?: { size: [number, number, number]; color: string };
  /** M2 (packet 28): the entity's behavior component, when present (§10.5). */
  behaviorId?: string;
  /** M2 (packet 28): the stored declared-property values (declaration order). */
  behaviorValues?: Record<string, unknown>;
  /** M2 (packet 28): the physics collider shape, when present (§10.7/§21.3). */
  collider?: unknown;
  /** M2 (packet 28): the controller marker component is present (§10.8). */
  controller?: boolean;
  /** M3 (packet 56): the game-zone component, when present (project-model §23.3.1). */
  gameZone?: GameZoneComponent;
  /** M3 (packet 56): the field-less spawn marker is present (project-model §23.3.2). */
  playerSpawn?: boolean;
  /** M3 (packet 56): the camera-follow data, when present (project-model §23.3.3). */
  cameraFollow?: CameraFollowComponent;
  /** M3 (packet 57): the light component, when present (project-model §23.3.4). */
  light?: LightComponent;
  /** M3 (packet 57): the copied surface values, when present (project-model §23.3.5). */
  surface?: SurfaceComponent;
  /** M3 (packet 57): the model-animation profile, when present (project-model §23.3.6). */
  modelAnimation?: ModelAnimationComponent;
  /** Phase 12 (c): the instance set (one model, many placements from a buffer). */
  instances?: { assetId: string; piece?: string; buffer: string; count: number };
  /** Phase 12 (c): the scene the entity lives in (v4 projects; absent for older ones). */
  sceneId?: string;
}

/** The result of applying one `mutation.applied` to the projection. */
export interface ApplyMutationResult {
  /** A `mutation.applied` for a requestId already applied (deduped). */
  deduped: boolean;
  /** The gap rule fired: revision jumped past lastSeen + 1 ⇒ resync needed. */
  gap: boolean;
  /** The change was applied to the projection. */
  applied: boolean;
}

/** A full-state hydration input (from establish / queryEntities / resync). */
export interface FullState {
  revision: number;
  entities: readonly Entity[];
  /** Phase 12 (c), v4: each entity's scene (aligned with `entities`), the scenes and the start set. */
  entitySceneIds?: readonly string[];
  scenes?: readonly SceneRowView[];
  startScenes?: readonly string[];
}

/** Phase 12 (c): one scene of the project as the editor shows it. */
export interface SceneRowView {
  sceneId: string;
  name: string;
}

/** A `mutation.applied` event (sessions.md §7). */
export interface MutationApplied {
  requestId: string;
  revision: number;
  change: ChangeData;
  /** Phase 12 (c): the scene the edit touched (v4). */
  sceneId?: string;
}

/** A structured conflict surfaced to the UI (commands.md §6.4). */
export interface ConflictInfo {
  code: 'revision_conflict';
  /** The backend's authoritative current revision. */
  currentRevision: number;
  /** The revision the failed command expected. */
  expectedRevision: number;
  message: string;
}

function boxOf(b: { size?: number[]; material?: { color?: string } }): { size: [number, number, number]; color: string } {
  const s = b.size ?? [1, 1, 1];
  return { size: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1], color: b.material?.color ?? '#cccccc' };
}

/** Phase 9.9: the gameplay block component names (project-model BLOCK_COMPONENT_NAMES). */
export const BLOCK_NAMES = ['mover', 'trigger', 'switch', 'health', 'pickup', 'enemy'] as const;
export type BlockName = (typeof BLOCK_NAMES)[number];

function blocksOf(components: Record<string, unknown>): Partial<Record<BlockName, Record<string, unknown>>> | undefined {
  const out: Partial<Record<BlockName, Record<string, unknown>>> = {};
  for (const n of BLOCK_NAMES) if (components[n] !== undefined) out[n] = structuredClone(components[n]) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : undefined;
}

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function toProjected(e: Entity): ProjectedEntity {
  const flags = e as { active?: boolean; locked?: boolean; static?: boolean; tags?: number };
  const c = e.components as {
    folder?: unknown;
    box?: { size?: number[]; material?: { color?: string } };
    camera?: unknown;
    model?: { asset?: { assetId?: string }; piece?: string };
    behavior?: { behaviorId?: string; values?: Record<string, unknown> };
    prefab?: { prefabId?: string; localId?: string };
    collider?: unknown;
    controller?: unknown;
    gameZone?: GameZoneComponent;
    playerSpawn?: unknown;
    cameraFollow?: CameraFollowComponent;
    light?: LightComponent;
    surface?: SurfaceComponent;
    modelAnimation?: ModelAnimationComponent;
    instances?: { asset?: { assetId?: string; piece?: string }; buffer?: string; count?: number };
    materials?: Record<string, string>;
    fogVolume?: { size: [number, number, number]; density: number; color: string; falloff?: number };
    animator?: { controller: string; parameters?: Record<string, number | boolean> };
  };
  const kind = c.folder !== undefined ? 'folder' : c.model ? 'model' : c.box ? 'box' : c.camera ? 'camera' : c.light ? 'light' : 'entity';
  const t = (e.components as { transform?: typeof IDENTITY }).transform ?? IDENTITY;
  const blocks = blocksOf(e.components as unknown as Record<string, unknown>);
  const projected: ProjectedEntity = {
    id: e.id,
    name: e.name ?? e.id,
    parentId: e.parentId ?? null,
    kind,
    active: flags.active !== false,
    locked: flags.locked === true,
    static: flags.static === true,
    tags: typeof flags.tags === 'number' ? flags.tags >>> 0 : 0,
    position: [...t.position],
    rotation: [...t.rotation],
    scale: [...t.scale],
    ...(c.box ? { box: boxOf(c.box) } : {}),
    ...(c.model?.asset?.assetId ? { assetId: c.model.asset.assetId } : {}),
    ...(typeof c.model?.piece === 'string' ? { piece: c.model.piece } : {}),
    ...(c.materials !== undefined ? { materials: { ...c.materials } } : {}),
    ...(c.fogVolume !== undefined ? { fogVolume: { ...c.fogVolume, size: [...c.fogVolume.size] as [number, number, number] } } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(c.animator !== undefined ? { animator: { controller: c.animator.controller, ...(c.animator.parameters !== undefined ? { parameters: { ...c.animator.parameters } } : {}) } } : {}),
    ...(c.prefab?.prefabId && c.prefab.localId ? { prefab: { prefabId: c.prefab.prefabId, localId: c.prefab.localId } } : {}),
    ...(c.behavior?.behaviorId ? { behaviorId: c.behavior.behaviorId } : {}),
    ...(c.behavior?.values ? { behaviorValues: { ...c.behavior.values } } : {}),
    ...(c.collider !== undefined ? { collider: c.collider } : {}),
    ...(c.controller !== undefined ? { controller: true } : {}),
    ...(c.gameZone !== undefined ? { gameZone: { ...c.gameZone, size: [...c.gameZone.size] as [number, number] } } : {}),
    ...(c.playerSpawn !== undefined ? { playerSpawn: true } : {}),
    ...(c.cameraFollow !== undefined ? { cameraFollow: { deadZone: { ...c.cameraFollow.deadZone }, smoothing: c.cameraFollow.smoothing, ...(c.cameraFollow.bounds !== undefined ? { bounds: { ...c.cameraFollow.bounds } } : {}) } } : {}),
    ...(c.light !== undefined ? { light: { ...c.light, ...(c.light.direction ? { direction: [...c.light.direction] as [number, number, number] } : {}) } } : {}),
    ...(c.surface !== undefined ? { surface: { ...c.surface } } : {}),
    ...(c.instances?.asset?.assetId !== undefined && typeof c.instances.buffer === 'string' && typeof c.instances.count === 'number'
      ? { instances: { assetId: c.instances.asset.assetId, ...(typeof c.instances.asset.piece === 'string' ? { piece: c.instances.asset.piece } : {}), buffer: c.instances.buffer, count: c.instances.count } }
      : {}),
    ...(c.modelAnimation !== undefined ? { modelAnimation: { assetId: c.modelAnimation.assetId, version: c.modelAnimation.version, roles: { idle: { ...c.modelAnimation.roles.idle }, run: { ...c.modelAnimation.roles.run }, airborne: { ...c.modelAnimation.roles.airborne } } } } : {}),
  };
  return projected;
}

/**
 * The editor's projection of the backend scene. A single instance per
 * connection; hydrated from authoritative full state and updated from
 * `mutation.applied` change data.
 */
export class Projection {
  private entities = new Map<string, ProjectedEntity>();
  private order: string[] = [];
  private lastSeen = 0;
  private applied = new Set<string>();
  /** Phase 12 (c): the project's scenes (empty for a pre-v4 project) and start set. */
  private sceneRows: SceneRowView[] = [];
  private startSet: string[] = [];
  /** Set when the gap rule fires; the client must resync. */
  needsResync = false;

  /** Hydrate from authoritative full state (establish / queryEntities / resync). */
  hydrate(full: FullState): void {
    this.entities.clear();
    this.order = [];
    full.entities.forEach((e, i) => {
      const p = toProjected(e);
      const sceneId = full.entitySceneIds?.[i];
      if (sceneId !== undefined) p.sceneId = sceneId;
      this.entities.set(p.id, p);
      this.order.push(p.id);
    });
    this.sceneRows = (full.scenes ?? []).map((r) => ({ sceneId: r.sceneId, name: r.name }));
    this.startSet = [...(full.startScenes ?? [])];
    this.lastSeen = full.revision;
    this.needsResync = false;
  }

  /** Phase 12 (c): the scenes, in index order (empty: a single-scene project). */
  get scenes(): readonly SceneRowView[] {
    return this.sceneRows;
  }

  /** Phase 12 (c): the scenes the game starts with. */
  get startScenes(): readonly string[] {
    return this.startSet;
  }

  /** The current revision the projection reflects. */
  get revision(): number {
    return this.lastSeen;
  }

  /** Whether the projection is stale (a gap was observed) and needs a resync. */
  get stale(): boolean {
    return this.needsResync;
  }

  /** Document order (array of entity ids). */
  get entityOrder(): readonly string[] {
    return this.order;
  }

  getEntity(id: string): ProjectedEntity | undefined {
    return this.entities.get(id);
  }

  /** All projected entities in document order. */
  listEntities(): ProjectedEntity[] {
    const out: ProjectedEntity[] = [];
    for (const id of this.order) {
      const e = this.entities.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Apply one `mutation.applied` (sessions.md §6.2/§8.3).
   * Returns the outcome; NEVER throws. The gap rule and dedup are checked
   * before any mutation so a stale event cannot corrupt the projection.
   */
  applyMutationApplied(ev: MutationApplied): ApplyMutationResult {
    // Gap rule first: a jump past lastSeen+1 means we missed events. The
    // incremental change is NOT applied; the client must resync.
    if (ev.revision > this.lastSeen + 1) {
      this.needsResync = true;
      return { deduped: false, gap: true, applied: false };
    }
    // Dedup: a command we already applied (our own, or replayed) is ignored.
    if (this.applied.has(ev.requestId)) {
      this.lastSeen = Math.max(this.lastSeen, ev.revision);
      return { deduped: true, gap: false, applied: false };
    }
    const before = this.sceneRows.length > 0 ? new Set(this.entities.keys()) : null;
    const ok = this.applyChange(ev.change);
    if (ok) {
      this.applied.add(ev.requestId);
      this.lastSeen = Math.max(this.lastSeen, ev.revision);
      // Phase 12 (c): entities that just appeared live in the edited scene
      // (or their parent's; the first scene as the last resort).
      if (before !== null) {
        for (const [id, p] of this.entities) {
          if (before.has(id)) continue;
          p.sceneId = ev.sceneId ?? (p.parentId !== null ? this.entities.get(p.parentId)?.sceneId : undefined) ?? this.sceneRows[0]?.sceneId;
        }
      }
    }
    return { deduped: false, gap: false, applied: ok };
  }

  private applyChange(change: ChangeData): boolean {
    switch (change.type) {
      case 'createEntity': {
        for (const entity of [change.entity, ...(change.children ?? [])]) {
          if (this.entities.has(entity.id)) continue; // idempotent
          this.entities.set(entity.id, toProjected(entity));
          this.order.push(entity.id);
        }
        return true;
      }
      case 'setTransform': {
        const p = this.entities.get(change.id);
        if (!p) return false;
        p.position = [...change.next.position];
        p.rotation = [...change.next.rotation];
        p.scale = [...change.next.scale];
        return true;
      }
      case 'updateEntity': {
        const p = this.entities.get(change.id);
        if (!p) return false;
        p.name = change.next.name ?? p.id;
        p.parentId = change.next.parentId;
        p.active = change.next.active !== false;
        p.locked = change.next.locked === true;
        p.static = change.next.static === true;
        p.tags = typeof change.next.tags === 'number' ? change.next.tags >>> 0 : 0;
        if (change.transform !== undefined) {
          p.position = [...change.transform.next.position];
          p.rotation = [...change.transform.next.rotation];
          p.scale = [...change.transform.next.scale];
        }
        if (change.order !== null) this.order = [...change.order.next];
        return true;
      }
      case 'moveEntities': {
        for (const m of change.entities) {
          const p = this.entities.get(m.id);
          if (!p) return false;
          p.parentId = m.next.parentId;
          if (m.next.transform !== null) {
            p.position = [...m.next.transform.position];
            p.rotation = [...m.next.transform.rotation];
            p.scale = [...m.next.transform.scale];
          }
        }
        this.order = [...change.order.next];
        return true;
      }
      case 'pasteEntities': {
        for (const entity of change.entities) {
          if (this.entities.has(entity.id)) continue;
          this.entities.set(entity.id, toProjected(entity));
          this.order.push(entity.id);
        }
        return true;
      }
      case 'deleteEntity': {
        const ids = new Set(change.deletedIds);
        for (const id of ids) this.entities.delete(id);
        this.order = this.order.filter((id) => !ids.has(id));
        return true;
      }
      case 'restoreSubtree': {
        for (const e of change.entities) {
          const p = toProjected(e);
          if (!this.entities.has(p.id)) {
            this.entities.set(p.id, p);
            this.order.push(p.id);
          }
        }
        return true;
      }
      // ---- M2 scene changes (packet 27) ---------------------------------
      case 'instantiatePrefab': {
        // The change carries the full created entity values with their
        // insertion indices (commands.md §5.3/§8.7.6). Applying them is a
        // projection update — never a local mutation path of its own.
        const entries = [...change.entries].sort((a, b) => a.index - b.index);
        for (const entry of entries) {
          const p = toProjected(entry.entity as unknown as Entity);
          if (this.entities.has(p.id)) continue; // idempotent
          const at = Math.max(0, Math.min(this.order.length, entry.index));
          this.order.splice(at, 0, p.id);
          this.entities.set(p.id, p);
        }
        return true;
      }
      case 'setComponent': {
        const p = this.entities.get(change.id);
        if (!p) return false;
        if (change.component === 'box') {
          if (change.next !== null) p.box = boxOf(change.next as { size?: number[]; material?: { color?: string } });
        } else if (change.component === 'model') {
          const next = change.next as { asset?: { assetId?: string }; piece?: string } | null;
          if (next?.asset?.assetId) {
            p.assetId = next.asset.assetId;
            if (typeof next.piece === 'string') p.piece = next.piece;
            else delete p.piece;
            p.kind = 'model';
          }
        } else if (change.component === 'animator') {
          if (change.next === null) delete p.animator;
          else p.animator = structuredClone(change.next as NonNullable<ProjectedEntity['animator']>);
        } else if ((BLOCK_NAMES as readonly string[]).includes(change.component)) {
          const blocks = { ...(p.blocks ?? {}) };
          if (change.next === null) delete blocks[change.component as BlockName];
          else blocks[change.component as BlockName] = structuredClone(change.next) as Record<string, unknown>;
          if (Object.keys(blocks).length > 0) p.blocks = blocks;
          else delete p.blocks;
        } else if (change.component === 'fogVolume') {
          if (change.next === null) delete p.fogVolume;
          else p.fogVolume = { ...(change.next as NonNullable<ProjectedEntity['fogVolume']>) };
        } else if (change.component === 'materials') {
          if (change.next === null) delete p.materials;
          else p.materials = { ...(change.next as Record<string, string>) };
        } else if (change.component === 'collider') {
          // C28-1 repair: add/edit/remove converge without a reload (§5.3).
          if (change.next === null) delete p.collider;
          else p.collider = change.next;
        } else if (change.component === 'controller') {
          if (change.next === null) delete p.controller;
          else p.controller = true;
        } else if (change.component === 'gameZone') {
          // M3 (packet 56): the zone component converges add/edit/remove the
          // same way (the change carries the full component value or null).
          if (change.next === null) delete p.gameZone;
          else {
            const z = change.next as GameZoneComponent;
            p.gameZone = { ...z, size: [...z.size] as [number, number] };
          }
        } else if (change.component === 'playerSpawn') {
          if (change.next === null) delete p.playerSpawn;
          else p.playerSpawn = true;
        } else if (change.component === 'cameraFollow') {
          if (change.next === null) delete p.cameraFollow;
          else {
            const f = change.next as CameraFollowComponent;
            p.cameraFollow = { deadZone: { ...f.deadZone }, smoothing: f.smoothing, ...(f.bounds !== undefined ? { bounds: { ...f.bounds } } : {}) };
          }
        } else if (change.component === 'light') {
          // M3 (packet 57): the light component converges add/edit/remove the
          // same way (the change carries the full component value or null).
          if (change.next === null) delete p.light;
          else {
            const l = change.next as LightComponent;
            p.light = { ...l, ...(l.direction ? { direction: [...l.direction] as [number, number, number] } : {}) };
          }
        } else if (change.component === 'surface') {
          if (change.next === null) delete p.surface;
          else p.surface = { ...(change.next as SurfaceComponent) };
        } else if (change.component === 'instances') {
          const next = change.next as { asset: { assetId: string; piece?: string }; buffer: string; count: number } | null;
          if (next === null) delete p.instances;
          else p.instances = { assetId: next.asset.assetId, ...(next.asset.piece !== undefined ? { piece: next.asset.piece } : {}), buffer: next.buffer, count: next.count };
        } else if (change.component === 'modelAnimation') {
          if (change.next === null) delete p.modelAnimation;
          else {
            const a = change.next as ModelAnimationComponent;
            p.modelAnimation = { assetId: a.assetId, version: a.version, roles: { idle: { ...a.roles.idle }, run: { ...a.roles.run }, airborne: { ...a.roles.airborne } } };
          }
        }
        return true;
      }
      // Content-only changes advance the revision without touching the scene
      // (the content projection consumes the same records — sessions.md §8).
      case 'publishAsset':
      case 'publishBehavior':
      case 'setSettings':
      case 'acknowledgeBehaviorTrust':
      case 'createPrefab':
      case 'removePrefab':
        return true;
      // M2 (packet 28): a declared-property edit converges the projection
      // without a reload — an MCP-origin change is applied exactly like a
      // browser-origin one (sessions.md §6.2).
      case 'setBehaviorProperties':
        return this.applySetBehaviorProperties(change);
      // M3 (packet 56): a `setGameConfig` change is content-only (the client
      // tracks the block from the change data); an `applySurfacePreset`
      // change (packet 57) updates a component the 56 projection does not
      // display — advance the revision (no gap) and let the next full state
      // / `queryEntity` carry the value.
      case 'setGameConfig':
      case 'setTags':
      case 'setAssetOptions':
      case 'setMaterials':
      case 'setEnvironment':
      case 'setLighting':
      case 'setAnimators':
      case 'setInput':
      case 'setFlow':
        return true;
      case 'setSceneIndex':
        // Phase 12 (c): the scene list and start set (files come and go with it).
        this.sceneRows = change.next.scenes.map((r) => ({ sceneId: r.sceneId, name: r.name }));
        this.startSet = [...change.next.startScenes];
        return true;
      case 'applySurfacePreset': {
        const p = this.entities.get(change.id);
        if (!p) return false;
        if (change.next === null) delete p.surface;
        else p.surface = { ...(change.next as SurfaceComponent) };
        return true;
      }
      default:
        return false;
    }
  }

  private applySetBehaviorProperties(change: SetBehaviorPropertiesChange): boolean {
    const p = this.entities.get(change.id);
    if (!p) return false;
    const next = change.next;
    if (next === null) {
      delete p.behaviorId;
      delete p.behaviorValues;
      return true;
    }
    p.behaviorId = next.behaviorId;
    p.behaviorValues = { ...next.values };
    return true;
  }

  /**
   * Explain a `revision_conflict` (commands.md §6.4). The projection is left
   * valid; the caller re-syncs (re-reads the current revision + entity) and,
   * if permitted, auto-retries at most once. Never silently loses the edit.
   */
  describeConflict(expectedRevision: number, currentRevision: number, message: string): ConflictInfo {
    return { code: 'revision_conflict', currentRevision, expectedRevision, message };
  }
}