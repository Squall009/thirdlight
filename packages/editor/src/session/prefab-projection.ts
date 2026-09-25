/**
 * Prefab-definition and published-declaration projection (packet 28;
 * sessions.md §8/§19.4; commands.md §5.3/§5.6).
 *
 * The editor's projection of `content.prefabs` and `content.behaviors`
 * (definitions and declarations only — never bytes, never source). It is
 * hydrated from a full state (`queryPrefabs` with `includeEntities: true` and
 * `queryBehaviors` with `includeDeclaration: true`, both bounded) and advanced
 * from the **same applied `mutation.applied` change records** the scene
 * projection uses. `change.next` carries the full record, so no partial merge
 * is ever needed; a gap is resolved by a fresh full state (sessions.md §8).
 *
 * "Copies, not links" (project-model §20.1.4) is a property of this module:
 *
 *  - `createPrefab` adds a definition and touches no entity;
 *  - `removePrefab` (the undo of a capture) removes the definition and still
 *    touches no entity — materialized copies are ordinary scene entities;
 *  - `publishBehavior` updates the declaration/record and leaves every stored
 *    `components.behavior.values` map untouched (a changed default affects new
 *    values only, project-model §20.8.3);
 *  - there is no operation that rewrites an instance from a definition, and
 *    this module exposes none.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

import type { ChangeData } from '@thirdlight/commands';
import type { BehaviorRecord, BehaviorSourceRecord, GraphData, PrefabDefinition, PropertyDeclaration, TrustEntry } from '@thirdlight/project-model';

import { applyGraphOpsLocal } from '../graph/model';
import { parseBehaviorOwnerId } from './behavior-graph';

/** The published declaration part of a behavior record (never its source bytes). */
export interface BehaviorDeclarationView {
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  /** The digest-bound source record, or `null` (a declaration-only behavior). */
  source: BehaviorSourceRecord | null;
  publishedRevision: number;
  /** Phase 19.0: the visual script (absent: not a visual script). */
  graph?: GraphData;
  /** Phase 19.1: the script's functions (sorted by id; absent: none). */
  functions?: { functionId: string; graph: GraphData }[];
}

/** One definition summary as `queryPrefabs`/full state returns it. */
export interface PrefabSummaryView {
  prefabId: string;
  displayName: string;
  createdRevision: number;
  entityCount: number;
  depth: number;
}

/**
 * The editor's projection of `content.prefabs` + `content.behaviors`.
 * Definitions are stored whole (they are the override/materialization source);
 * declarations are stored whole (they are the only schema source for the
 * property controls).
 */
export class PrefabProjection {
  private definitions = new Map<string, PrefabDefinition>();
  private behaviors = new Map<string, BehaviorDeclarationView>();

  /** Rebuild from authoritative full state (establish / re-attach / resync). */
  hydrate(definitions: readonly PrefabDefinition[], behaviors: readonly BehaviorRecord[]): void {
    this.definitions.clear();
    this.behaviors.clear();
    for (const d of definitions) this.definitions.set(d.prefabId, cloneDefinition(d));
    for (const b of behaviors) this.behaviors.set(b.behaviorId, toDeclarationView(b));
  }

  /** Ascending `prefabId` order (commands.md §5.6). */
  listDefinitions(): PrefabDefinition[] {
    return [...this.definitions.values()].sort((a, b) => (a.prefabId < b.prefabId ? -1 : a.prefabId > b.prefabId ? 1 : 0));
  }

  listSummaries(): PrefabSummaryView[] {
    return this.listDefinitions().map((d) => ({
      prefabId: d.prefabId,
      displayName: d.displayName,
      createdRevision: d.createdRevision,
      entityCount: d.entityCount,
      depth: d.depth,
    }));
  }

  getDefinition(prefabId: string): PrefabDefinition | undefined {
    return this.definitions.get(prefabId);
  }

  get prefabCount(): number {
    return this.definitions.size;
  }

  get prefabIds(): string[] {
    return this.listDefinitions().map((d) => d.prefabId);
  }

  /** Ascending `behaviorId` order. */
  listDeclarations(): BehaviorDeclarationView[] {
    return [...this.behaviors.values()].sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  }

  getBehavior(behaviorId: string): BehaviorDeclarationView | undefined {
    return this.behaviors.get(behaviorId);
  }

  getDeclaration(behaviorId: string): PropertyDeclaration | undefined {
    return this.behaviors.get(behaviorId)?.declaration;
  }

  /** The `behaviorId → declaration` map the planners consume. */
  declarationMap(): Map<string, PropertyDeclaration> {
    const m = new Map<string, PropertyDeclaration>();
    for (const [id, b] of this.behaviors) m.set(id, b.declaration);
    return m;
  }

  /**
   * The acknowledged trust digests observed in this session (packet 34). No
   * accepted query returns `content.behaviorTrust`, so this is advanced ONLY by
   * `acknowledgeBehaviorTrust` change records; it deliberately survives a
   * hydrate (a resync must not forget what the user just acknowledged).
   */
  private trust: TrustEntry[] = [];

  listTrust(): TrustEntry[] {
    return this.trust.map((e) => ({ ...e }));
  }

  isDigestAcknowledged(sourceDigest: string): boolean {
    return this.trust.some((e) => e.sourceDigest === sourceDigest);
  }

  get behaviorCount(): number {
    return this.behaviors.size;
  }

  /**
   * Apply one applied change record. Definition/declaration changes update
   * this projection; scene changes leave it untouched. Returns whether the
   * projection changed.
   */
  applyChange(change: ChangeData): boolean {
    switch (change.type) {
      case 'createPrefab': {
        this.definitions.set(change.prefabId, cloneDefinition(change.definition));
        return true;
      }
      case 'removePrefab': {
        // The undo of a capture: the definition disappears; materialized copies
        // and their `components.prefab` provenance are untouched (§20.1.4).
        return this.definitions.delete(change.prefabId);
      }
      case 'publishBehavior': {
        const next = change.next;
        if (next === null) return this.behaviors.delete(change.behaviorId);
        this.behaviors.set(change.behaviorId, toDeclarationView(next));
        return true;
      }
      case 'graphEdit': {
        // Phase 19.0: a visual script's graph advances from the change's ops
        // (the backend applied and validated the same ops).
        if (change.owner.kind !== 'behavior') return false;
        // Phase 19.1: `<behaviorId>#<functionId>` is one of the script's functions
        // (it exists while it has nodes, like the backend's record).
        const target = parseBehaviorOwnerId(change.owner.id);
        const b = this.behaviors.get(target.behaviorId);
        if (b === undefined || b.graph === undefined) throw new Error(`stale visual script "${change.owner.id}"`);
        if (target.functionId === null) {
          const next = applyGraphOpsLocal(b.graph, change.ops);
          if (next === null) throw new Error(`stale visual script "${change.owner.id}"`);
          this.behaviors.set(b.behaviorId, { ...b, graph: next });
          return true;
        }
        const fid = target.functionId;
        const current = b.functions?.find((f) => f.functionId === fid)?.graph ?? { nodes: [], edges: [] };
        const next = applyGraphOpsLocal(current, change.ops);
        if (next === null) throw new Error(`stale visual script function "${change.owner.id}"`);
        const functions = (b.functions ?? []).filter((f) => f.functionId !== fid);
        if (next.nodes.length > 0) functions.push({ functionId: fid, graph: next });
        functions.sort((x, y) => (x.functionId < y.functionId ? -1 : x.functionId > y.functionId ? 1 : 0));
        const view: BehaviorDeclarationView = { ...b, functions };
        if (functions.length === 0) delete view.functions;
        this.behaviors.set(b.behaviorId, view);
        return true;
      }
      case 'acknowledgeBehaviorTrust': {
        // Full entry arrays in the direction applied (commands.md §5.3/§8.12).
        this.trust = change.next.map((e) => ({ ...e }));
        return true;
      }
      // Every other change is scene-only or carries no definition/declaration:
      // `instantiatePrefab` materializes copies (it never edits a definition).
      default:
        return false;
    }
  }
}

function toDeclarationView(b: BehaviorRecord): BehaviorDeclarationView {
  return {
    behaviorId: b.behaviorId,
    displayName: b.displayName,
    declaration: { properties: b.declaration.properties.map((p) => ({ ...p })) },
    source: b.source === null ? null : { ...b.source, requiredModules: [...b.source.requiredModules], ...(b.source.ownedTransforms !== undefined ? { ownedTransforms: [...b.source.ownedTransforms] } : {}) },
    publishedRevision: b.publishedRevision,
    ...(b.graph !== undefined ? { graph: structuredClone(b.graph) } : {}),
    ...(b.functions !== undefined && b.functions.length > 0 ? { functions: structuredClone(b.functions) } : {}),
  };
}

function cloneDefinition(d: PrefabDefinition): PrefabDefinition {
  return {
    prefabId: d.prefabId,
    displayName: d.displayName,
    createdRevision: d.createdRevision,
    entityCount: d.entityCount,
    depth: d.depth,
    entities: d.entities.map((e) => ({
      localId: e.localId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.parentLocalId !== undefined ? { parentLocalId: e.parentLocalId } : {}),
      components: {
        transform: e.components.transform,
        ...(e.components.model !== undefined ? { model: e.components.model } : {}),
        ...(e.components.box !== undefined ? { box: e.components.box } : {}),
        ...(e.components.behavior !== undefined
          ? { behavior: { behaviorId: e.components.behavior.behaviorId, values: { ...e.components.behavior.values } } }
          : {}),
      },
    })),
  };
}
