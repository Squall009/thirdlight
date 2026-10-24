/**
 * The project as Play, export and the editor see it: every linked prefab copy
 * assembled into ordinary objects (project-model `assembleSceneEntities`), and
 * the prefabs the runtime spawns with their nested copies and variants
 * flattened. The stored scenes keep the links; nothing here writes.
 *
 * A project reads its view far more often than it changes, and a change
 * touches few copies, so the view is kept per session: the last states' views,
 * each copy's assembly (kept while the copy's stored value and its prefab's
 * contents, nested prefabs included, are the same) and each scene's result
 * (kept while the scene object and the prefabs are). An assembled object that
 * did not change is the same object from one view to the next, which is how
 * the change feed finds what a command changed (`assembledChange`).
 *
 * A project without links pays one scan of each scene it changes.
 */
import { createHash } from 'node:crypto';

import {
  assembleSceneEntities,
  createPrefabAssembler,
  flatPrefabEntities,
  isPrefabLink,
  nestedPrefabIds,
  type AssemblyEntity,
  type ContentCatalogV4,
  type DeclaredProperty,
  type PrefabAssembler,
  type PrefabAssemblyProblem,
  type PrefabDefinition,
  type SceneV4,
} from '@thirdlight/project-model';

/** What assembly could not do as stored, with the scene it is in. */
export interface ScenePrefabProblem extends PrefabAssemblyProblem {
  sceneId: string;
}

export interface PrefabView {
  /** Whether any scene holds a linked copy or any prefab nests one (false: the view is the stored project). */
  readonly linked: boolean;
  /** Every scene (index order) with its copies assembled; a scene without copies is the stored one. */
  readonly scenes: ReadonlyMap<string, SceneV4>;
  /** The prefabs as the runtime spawns them (the stored list when none nests). */
  readonly prefabs: readonly PrefabDefinition[];
  readonly problems: readonly ScenePrefabProblem[];
  /** The objects assembly made or re-parented (copies' roots and parts, objects added under a part), by id. */
  readonly derived: ReadonlyMap<string, { sceneId: string; entity: AssemblyEntity }>;
}

/**
 * What a command changed in the assembled objects, beside its own change
 * data: the editor's projection applies it after the change (whole objects
 * in, ids out). Absent when the project has no links.
 */
export interface AssembledChange {
  /** Assembled objects that are new or differ, grouped by scene (whole values). */
  upsert: { sceneId: string; entities: AssemblyEntity[] }[];
  /** Assembled objects that are gone. */
  removedIds: string[];
}

interface CopyMemo {
  ref: object;
  json: string;
  sig: string;
  made: ReturnType<PrefabAssembler['assembleCopy']>;
}

interface SceneMemo {
  ref: SceneV4;
  generation: number;
  scene: SceneV4;
  problems: ScenePrefabProblem[];
  derived: AssemblyEntity[];
}

const hash = (s: string): string => createHash('sha256').update(s).digest('base64url');
/** A definition's own contents, hashed once per definition object. */
const ownSigs = new WeakMap<object, string>();
const ownSig = (o: object): string => {
  let s = ownSigs.get(o);
  if (s === undefined) ownSigs.set(o, (s = hash(JSON.stringify(o))));
  return s;
};
/** Whether a scene holds a linked copy, once per scene object. */
const sceneLinks = new WeakMap<SceneV4, boolean>();
const hasLinks = (scene: SceneV4): boolean => {
  let v = sceneLinks.get(scene);
  if (v === undefined) sceneLinks.set(scene, (v = scene.entities.some((e) => isPrefabLink((e.components as { prefab?: unknown }).prefab))));
  return v;
};

const EMPTY_DERIVED: ReadonlyMap<string, { sceneId: string; entity: AssemblyEntity }> = new Map();

/** One session's assembled views (see the module comment). */
export class PrefabViews {
  /** The last two states' views: a command's change is the difference between them. */
  private views: { state: object; view: PrefabView }[] = [];
  private prefabsRef: readonly PrefabDefinition[] | null = null;
  private behaviorsRef: unknown = null;
  private declarationsSig = '';
  private assembler: PrefabAssembler | null = null;
  /** Each prefab's contents with every prefab it nests (through any chain), hashed. */
  private sigs = new Map<string, string>();
  /** Bumped whenever a prefab's contents or the declarations change: scene results made before are stale. */
  private generation = 0;
  private flat: { generation: number; prefabs: readonly PrefabDefinition[]; nests: boolean } | null = null;
  private copies = new Map<string, CopyMemo>();
  private added = new Map<string, { ref: object; parentId: string | undefined; out: AssemblyEntity }>();
  private sceneMemos = new Map<string, SceneMemo>();

  viewOf(state: { content: ContentCatalogV4; scenes: ReadonlyMap<string, SceneV4> }): PrefabView {
    const kept = this.views.find((v) => v.state === state);
    if (kept !== undefined) return kept.view;
    const view = this.build(state.content, state.scenes);
    this.views = [...this.views.slice(-1), { state, view }];
    return view;
  }

  private build(content: ContentCatalogV4, scenes: ReadonlyMap<string, SceneV4>): PrefabView {
    const prefabs = content.prefabs ?? [];
    const nests = prefabs.some((p) => nestedPrefabIds(p).length > 0);
    const anyCopies = [...scenes.values()].some(hasLinks);
    if (!nests && !anyCopies) {
      this.sceneMemos.clear();
      return { linked: false, scenes, prefabs, problems: [], derived: EMPTY_DERIVED };
    }
    this.refresh(content);
    const out = new Map<string, SceneV4>();
    const problems: ScenePrefabProblem[] = [];
    const derived = new Map<string, { sceneId: string; entity: AssemblyEntity }>();
    for (const [sceneId, scene] of scenes) {
      if (!hasLinks(scene)) {
        out.set(sceneId, scene);
        continue;
      }
      let memo = this.sceneMemos.get(sceneId);
      if (memo === undefined || memo.ref !== scene || memo.generation !== this.generation) {
        memo = this.assembleScene(sceneId, scene);
        this.sceneMemos.set(sceneId, memo);
      }
      out.set(sceneId, memo.scene);
      for (const p of memo.problems) problems.push(p);
      for (const e of memo.derived) derived.set(e.id, { sceneId, entity: e });
    }
    for (const id of this.sceneMemos.keys()) if (!out.has(id) || !hasLinks(scenes.get(id)!)) this.sceneMemos.delete(id);
    // Copies deleted since are forgotten once they would be a good part of what is kept.
    if (this.copies.size + this.added.size > 2 * derived.size + 64) {
      for (const id of this.copies.keys()) if (!derived.has(id)) this.copies.delete(id);
      for (const id of this.added.keys()) if (!derived.has(id)) this.added.delete(id);
    }
    return { linked: true, scenes: out, prefabs: this.flatPrefabs(prefabs, nests), problems, derived };
  }

  /** Follow the catalog: prefabs whose contents (or nested contents) changed get new signatures; new declarations reassemble everything. */
  private refresh(content: ContentCatalogV4): void {
    const prefabs = content.prefabs ?? [];
    if (content.behaviors !== this.behaviorsRef) {
      this.behaviorsRef = content.behaviors;
      const sig = hash(JSON.stringify((content.behaviors ?? []).map((b) => [b.behaviorId, ownSig(b.declaration.properties)])));
      if (sig !== this.declarationsSig) {
        this.declarationsSig = sig;
        this.prefabsRef = null;
        this.assembler = null;
        this.copies.clear();
      }
    }
    if (prefabs === this.prefabsRef) return;
    this.prefabsRef = prefabs;
    const byId = new Map(prefabs.map((p) => [p.prefabId, p]));
    const sigs = new Map<string, string>();
    const deep = (id: string, stack: readonly string[]): string => {
      const known = sigs.get(id);
      if (known !== undefined) return known;
      const def = byId.get(id);
      if (def === undefined) return 'missing';
      // A cycle is refused by the catalog check; its signature need only be stable.
      if (stack.includes(id)) return 'cycle';
      const s = hash([ownSig(def), ...nestedPrefabIds(def).map((n) => `${n}:${deep(n, [...stack, id])}`)].join('|'));
      sigs.set(id, s);
      return s;
    };
    for (const p of prefabs) deep(p.prefabId, []);
    const same = sigs.size === this.sigs.size && [...sigs].every(([k, v]) => this.sigs.get(k) === v);
    if (same && this.assembler !== null) return;
    this.sigs = sigs;
    this.generation++;
    const declarations = new Map<string, readonly DeclaredProperty[]>((content.behaviors ?? []).map((b) => [b.behaviorId, b.declaration.properties]));
    this.assembler = createPrefabAssembler(prefabs, { declarations });
  }

  private assembleScene(sceneId: string, scene: SceneV4): SceneMemo {
    const assembler = this.assembler!;
    const sigOf = (prefabId: string): string => this.sigs.get(prefabId) ?? 'missing';
    const copyIds = new Set<string>();
    const memoized: PrefabAssembler = {
      assembleCopy: (copy) => {
        copyIds.add(copy.id);
        const sig = sigOf((copy.components as { prefab: { prefabId: string } }).prefab.prefabId);
        const m = this.copies.get(copy.id);
        if (m !== undefined && m.sig === sig) {
          if (m.ref === copy) return m.made;
          const json = JSON.stringify(copy);
          if (m.json === json) {
            m.ref = copy;
            return m.made;
          }
          return this.remember(copy, json, sig, assembler, m);
        }
        return this.remember(copy, JSON.stringify(copy), sig, assembler, m);
      },
      invalidate: (ids) => assembler.invalidate(ids),
    };
    const made = assembleSceneEntities(scene.entities as unknown as AssemblyEntity[], memoized);
    // Objects added under a copy's part come out re-parented: the same object while their stored value and new parent are.
    const derived: AssemblyEntity[] = [];
    const stored = new Map(scene.entities.map((e) => [e.id, e]));
    const entities = made.entities.map((e) => {
      const own = stored.get(e.id);
      if (own === undefined || copyIds.has(e.id)) {
        derived.push(e);
        return e;
      }
      if (typeof (own as { parentPart?: unknown }).parentPart !== 'string') return e;
      const m = this.added.get(e.id);
      if (m !== undefined && m.ref === own && m.parentId === e.parentId) {
        derived.push(m.out);
        return m.out;
      }
      this.added.set(e.id, { ref: own, parentId: e.parentId, out: e });
      derived.push(e);
      return e;
    });
    return { ref: scene, generation: this.generation, scene: { ...scene, entities: entities as unknown as SceneV4['entities'] }, problems: made.problems.map((p) => ({ ...p, sceneId })), derived };
  }

  private remember(copy: AssemblyEntity, json: string, sig: string, assembler: PrefabAssembler, before: CopyMemo | undefined): CopyMemo['made'] {
    let made = assembler.assembleCopy(copy);
    if (before !== undefined) {
      // Parts the change left as they were stay the same objects (the change feed sends only what differs).
      const was = new Map(before.made.entities.map((e) => [e.id, e]));
      let kept = 0;
      const entities = made.entities.map((e) => {
        const old = was.get(e.id);
        if (old === undefined || JSON.stringify(old) !== JSON.stringify(e)) return e;
        kept++;
        return old;
      });
      if (kept > 0) made = { ...made, entities };
    }
    this.copies.set(copy.id, { ref: copy, json, sig, made });
    return made;
  }

  private flatPrefabs(prefabs: readonly PrefabDefinition[], nests: boolean): readonly PrefabDefinition[] {
    if (!nests) return prefabs;
    if (this.flat !== null && this.flat.generation === this.generation && this.flat.nests) return this.flat.prefabs;
    const assembler = this.assembler!;
    const list = prefabs.map((p): PrefabDefinition => {
      if (nestedPrefabIds(p).length === 0) return p;
      const { entities } = flatPrefabEntities(assembler, p);
      const depthOf = new Map<string, number>();
      for (const e of entities) depthOf.set(e.localId, e.parentLocalId !== undefined ? (depthOf.get(e.parentLocalId) ?? 0) + 1 : 1);
      return { ...p, entities: entities as unknown as PrefabDefinition['entities'], entityCount: entities.length, depth: Math.max(1, ...depthOf.values()) };
    });
    this.flat = { generation: this.generation, prefabs: list, nests };
    return list;
  }
}

/** What changed in the assembled objects between two views of a project (undefined: nothing, or no links on either side). */
export function assembledChange(before: PrefabView, after: PrefabView): AssembledChange | undefined {
  if (!before.linked && !after.linked) return undefined;
  const bySceneId = new Map<string, AssemblyEntity[]>();
  for (const [id, d] of after.derived) {
    const was = before.derived.get(id);
    if (was !== undefined && was.entity === d.entity && was.sceneId === d.sceneId) continue;
    let list = bySceneId.get(d.sceneId);
    if (list === undefined) bySceneId.set(d.sceneId, (list = []));
    list.push(d.entity);
  }
  const gone = [...before.derived.keys()].filter((id) => !after.derived.has(id));
  let removedIds: string[] = [];
  if (gone.length > 0) {
    // An object that is now stored as it is (no longer assembled) is not gone: the command's own change carries it.
    const present = new Set<string>();
    for (const scene of after.scenes.values()) for (const e of scene.entities) present.add(e.id);
    removedIds = gone.filter((id) => !present.has(id));
  }
  if (bySceneId.size === 0 && removedIds.length === 0) return undefined;
  return { upsert: [...bySceneId].map(([sceneId, entities]) => ({ sceneId, entities })), removedIds };
}

/** A session's assembled view of its current state (null: not a v4 project, or not loaded). */
export function prefabViewOf(s: { v4?: { content: ContentCatalogV4; scenes: ReadonlyMap<string, SceneV4> } | null; prefabViews?: PrefabViews }): PrefabView | null {
  if (s.v4 === undefined || s.v4 === null) return null;
  return (s.prefabViews ??= new PrefabViews()).viewOf(s.v4);
}
