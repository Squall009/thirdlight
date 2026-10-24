/**
 * Editing a linked copy's parts with the ordinary commands.
 *
 * A linked copy is stored as one object (its root, naming its prefab and the
 * overrides it keeps); its parts exist only assembled, with derived ids. A
 * command that names a part (to set a component, move it, add a child under
 * it, delete it) runs exactly as on any object: the copy is assembled into
 * plain objects, the command runs on that scene through the one mutation
 * pipeline, and the copy is linked again from the result (project-model
 * `relinkCopy`): what changed becomes overrides, objects added under a part
 * become objects hanging from the copy (`parentPart`). The stored change is
 * the objects replaced (`prefabLinkEdit`), so it is one undo step like any
 * other. An edit a link cannot keep (a part moved to another parent, a part's
 * own flags) is refused rather than silently lost.
 */
import {
  createPrefabAssembler,
  isPrefabLink,
  keptPartIds,
  relinkCopy,
  type AssemblyEntity,
  type AssemblyPrefab,
  type DeclaredProperty,
  type EntityV3,
  type PrefabAssembler,
} from '@thirdlight/project-model';

import { contentOf } from './content-ops';
import { prefabOverrideUnsupported, type CommandError } from './errors';
import { gateResultState, type OpSuccess } from './ops';
import type { PrefabLinkEditChange, SceneEntry } from './prefab-link-types';
import type { ApplyOutcome, CommandState, ContentDocument, SceneDocument } from './types';

type Obj = Record<string, unknown>;

/** An assembler over the catalog's prefabs, with the declared defaults the backend's view uses. */
export function catalogAssembler(content: ContentDocument | undefined): PrefabAssembler {
  const c = contentOf(content);
  const declarations = new Map<string, readonly DeclaredProperty[]>(c.behaviors.map((b) => [b.behaviorId, b.declaration.properties]));
  return createPrefabAssembler(c.prefabs as unknown as AssemblyPrefab[], { declarations });
}

export interface CopyPart {
  copyId: string;
  /** The part's path key in the copy's prefab. */
  key: string;
  root: boolean;
}

/** The linked copies of one scene: which copy a part id belongs to, and each copy's assembly. */
export interface CopyLocator {
  readonly assembler: PrefabAssembler;
  /** The copies' roots as stored, by id. */
  readonly links: ReadonlyMap<string, EntityV3>;
  made(copyId: string): ReturnType<PrefabAssembler['assembleCopy']>;
  find(id: string): CopyPart | null;
}

/** The scene's linked copies (null: it holds none). */
export function locateCopies(scene: SceneDocument, content: ContentDocument | undefined, assembler?: PrefabAssembler): CopyLocator | null {
  const links = new Map<string, EntityV3>();
  for (const e of scene.entities) if (isPrefabLink((e.components as { prefab?: unknown }).prefab)) links.set(e.id, e as EntityV3);
  if (links.size === 0) return null;
  const asm = assembler ?? catalogAssembler(content);
  const cache = new Map<string, ReturnType<PrefabAssembler['assembleCopy']>>();
  const made = (copyId: string): ReturnType<PrefabAssembler['assembleCopy']> => {
    let m = cache.get(copyId);
    if (m === undefined) cache.set(copyId, (m = asm.assembleCopy(links.get(copyId) as unknown as AssemblyEntity)));
    return m;
  };
  const keyIn = (copyId: string, id: string): string | undefined => {
    for (const [k, v] of made(copyId).partIds) if (v === id) return k;
    return undefined;
  };
  const find = (id: string): CopyPart | null => {
    const own = links.get(id);
    if (own !== undefined) {
      const key = keyIn(id, id);
      return key === undefined ? null : { copyId: id, key, root: true };
    }
    for (const [copyId, root] of links) {
      const kept = (root.components as unknown as { prefab: { partIds?: Record<string, string> } }).prefab.partIds;
      // A derived part id starts with its copy's id (cut to fit the id length).
      const derived = id.length > 12 && copyId.startsWith(id.slice(0, id.length - 12)) && id.charAt(id.length - 12) === '-';
      if (!derived && (kept === undefined || !Object.values(kept).includes(id))) continue;
      const key = keyIn(copyId, id);
      if (key !== undefined) return { copyId, key, root: false };
    }
    return null;
  };
  return { assembler: asm, links, made, find };
}

/**
 * The scene with these copies assembled in place: their parts as plain
 * objects (with their ids), and the objects added under a part hanging from
 * that part. Every other object is the stored one.
 */
export function expandCopies(scene: SceneDocument, loc: CopyLocator, copyIds: ReadonlySet<string>): EntityV3[] {
  const out: EntityV3[] = [];
  for (const e of scene.entities as EntityV3[]) {
    if (copyIds.has(e.id)) {
      for (const m of loc.made(e.id).entities) out.push(m as unknown as EntityV3);
      continue;
    }
    const part = (e as unknown as Obj)['parentPart'];
    if (typeof part === 'string' && e.parentId !== undefined && copyIds.has(e.parentId)) {
      const { parentPart: _p, ...rest } = e as unknown as Obj;
      void _p;
      out.push({ ...rest, parentId: loc.made(e.parentId).partIds.get(part) ?? e.parentId } as unknown as EntityV3);
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Store edited copies again: each copy's parts fold back into its (relinked)
 * root, objects hanging from a part name it (`parentPart`). Objects under a
 * copy's part must come after the copy (assembly finds their part that way).
 */
export function foldCopies(after: readonly EntityV3[], roots: ReadonlyMap<string, { root: Obj; partIds: ReadonlyMap<string, string> }>): { ok: true; entities: EntityV3[] } | { ok: false; error: CommandError } {
  const owner = new Map<string, { copyId: string; key: string }>();
  for (const [copyId, r] of roots) for (const [key, id] of r.partIds) if (id !== copyId) owner.set(id, { copyId, key });
  const seen = new Set<string>();
  const out: EntityV3[] = [];
  for (const e of after) {
    if (owner.has(e.id)) continue;
    let o: Obj = roots.get(e.id)?.root ?? (e as unknown as Obj);
    seen.add(e.id);
    const parent = typeof o['parentId'] === 'string' ? owner.get(o['parentId']) : undefined;
    if (parent !== undefined) {
      if (!seen.has(parent.copyId)) return { ok: false, error: prefabOverrideUnsupported(e.id, `"${e.id}" comes before the copy "${parent.copyId}" it hangs from: move it after the copy first`) };
      o = { ...o, parentId: parent.copyId, parentPart: parent.key };
    }
    out.push(o as unknown as EntityV3);
  }
  return { ok: true, entities: out };
}

/** The stored objects two lists differ in: those replaced (at their places before) and those put in (at their places after). */
export function entriesDiff(before: readonly EntityV3[], after: readonly EntityV3[]): { previous: SceneEntry[]; next: SceneEntry[] } {
  const was = new Map(before.map((e) => [e.id, e]));
  const now = new Set(after.map((e) => e.id));
  const next: SceneEntry[] = [];
  const changed = new Set<string>();
  after.forEach((e, i) => {
    const w = was.get(e.id);
    if (w !== undefined && (w === e || JSON.stringify(w) === JSON.stringify(e))) return;
    changed.add(e.id);
    next.push({ index: i, entity: e });
  });
  const previous: SceneEntry[] = [];
  before.forEach((e, i) => {
    if (!now.has(e.id) || changed.has(e.id)) previous.push({ index: i, entity: e });
  });
  // The objects kept must keep their order, or the replay would put the others elsewhere: then the change is every object.
  const kept = before.filter((e) => now.has(e.id) && !changed.has(e.id)).map((e) => e.id);
  const keptAfter = after.filter((e) => !changed.has(e.id)).map((e) => e.id);
  if (kept.length !== keptAfter.length || kept.some((id, i) => keptAfter[i] !== id)) {
    return { previous: before.map((entity, index) => ({ index, entity })), next: after.map((entity, index) => ({ index, entity })) };
  }
  return { previous, next };
}

/** The ops whose part edits are refused outright, and those that handle copies themselves. */
const NOT_ROUTED = new Set(['undo', 'redo', 'createPrefab', 'updatePrefab', 'revertPrefabOverrides', 'applyPrefabOverrides', 'unpackPrefab', 'createPrefabVariant']);
/** Ops that change only what a copy's root keeps as its own (its placement, header, place in the scene): they run on the stored root. */
const ROOT_OWN_OPS = new Set(['setTransform', 'updateEntity', 'moveEntities', 'deleteEntity']);

/** The ids an op edits, and the ids it puts objects under or beside. */
export function namedIds(args: Obj): { targets: string[]; places: string[] } {
  const str = (v: unknown): string[] => (typeof v === 'string' ? [v] : []);
  const targets = [...str(args['entityId']), ...(Array.isArray(args['entityIds']) ? args['entityIds'].filter((x): x is string => typeof x === 'string') : [])];
  for (const k of ['animation', 'bakeDecal']) {
    const o = args[k];
    if (o !== null && typeof o === 'object') targets.push(...str((o as Obj)['entityId']));
  }
  const places = [...str(args['parentId']), ...str(args['beforeId'])];
  if (Array.isArray(args['entities'])) for (const it of args['entities']) if (it !== null && typeof it === 'object') places.push(...str((it as Obj)['parentId']));
  return { targets, places };
}

/** A scene's own fields but its objects (and its block cells, when a footprint wrote them). */
const nonEntityFields = (scene: SceneDocument, footprints: boolean): string => {
  const { entities: _e, revision: _r, blocks, ...rest } = scene as unknown as Obj;
  void _e;
  void _r;
  return JSON.stringify(footprints ? rest : { ...rest, blocks });
};

/**
 * Run a command that names a linked copy's part (or a component of a copy's
 * root) on the copy's assembled objects and store the result as overrides.
 * Null when the command names no copy that way (it runs as it is).
 */
export function routeCopyEdit(
  state: CommandState<SceneDocument>,
  request: unknown,
  op: string,
  args: Obj,
  run: (state: CommandState<SceneDocument>, request: unknown) => ApplyOutcome<SceneDocument>,
): { ok: true; op: OpSuccess } | { ok: false; error: CommandError } | null {
  if (NOT_ROUTED.has(op) || state.scene.schemaVersion !== 4) return null;
  const { targets, places } = namedIds(args);
  if (targets.length === 0 && places.length === 0) return null;
  const stored = new Set(state.scene.entities.map((e) => e.id));
  // Only ids that are no stored object, or are a copy's root, can name a copy's part.
  const maybe = (id: string): boolean => !stored.has(id) || isPrefabLink((state.scene.entities.find((e) => e.id === id)?.components as { prefab?: unknown } | undefined)?.prefab);
  if (![...targets, ...places].some(maybe)) return null;
  const loc = locateCopies(state.scene, state.content);
  if (loc === null) return null;
  const copies = new Set<string>();
  for (const id of targets) {
    const f = maybe(id) ? loc.find(id) : null;
    if (f !== null && (!f.root || !ROOT_OWN_OPS.has(op))) copies.add(f.copyId);
  }
  for (const id of places) {
    const f = maybe(id) ? loc.find(id) : null;
    if (f !== null && !f.root) copies.add(f.copyId);
  }
  if (copies.size === 0) return null;
  const first = [...copies][0] as string;
  if (state.otherScene !== undefined) return { ok: false, error: prefabOverrideUnsupported(first, "a copy's parts stay in its scene: unpack the copy to move them to another") };
  const working = { ...state.scene, entities: expandCopies(state.scene, loc, copies) } as SceneDocument;
  const inner = run({ ...state, scene: working, history: { entries: [], cursor: 0, seq: 1 } }, request);
  if (!inner.ok) return { ok: false, error: inner.result.error };
  const done = inner.state;
  // Cells a part's footprint wrote are written again into the stored scene from the copies' parts (writeSceneFootprints).
  const footprints = (inner.result.change as { footprints?: unknown }).footprints !== undefined;
  if (done.content !== state.content || nonEntityFields(done.scene, footprints) !== nonEntityFields(working, footprints)) {
    return { ok: false, error: prefabOverrideUnsupported(first, `${op} on a copy's part changes more than the copy's objects, which a copy cannot keep as overrides`) };
  }
  const after = done.scene.entities as EntityV3[];
  const byId = new Map(after.map((e) => [e.id, e as unknown as Obj]));
  const roots = new Map<string, { root: Obj; partIds: ReadonlyMap<string, string> }>();
  for (const copyId of copies) {
    const r = relinkCopy(loc.assembler, loc.links.get(copyId) as unknown as AssemblyEntity, (id) => byId.get(id));
    if (!r.ok) return { ok: false, error: prefabOverrideUnsupported(r.entityId, r.message) };
    roots.set(copyId, { root: r.root, partIds: r.partIds });
  }
  const folded = foldCopies(after, roots);
  if (!folded.ok) return folded;
  const linkEdit = storeLinkEdit(state, folded.entities, [...copies]);
  if (!linkEdit.ok) return linkEdit;
  let routed = linkEdit.op;
  // A copy placed under a copy's part: the change says what was placed, as instantiatePrefab's does.
  const placed = inner.result.change;
  if (placed.type === 'instantiatePrefab') routed = { ...routed, change: { ...(routed.change as PrefabLinkEditChange), placed: { prefabId: placed.prefabId, rootId: placed.rootId, mapping: [...placed.mapping] } }, createdId: placed.rootId };
  return { ok: true, op: { ...routed, ...(inner.result.createdId !== undefined ? { createdId: inner.result.createdId } : {}) } };
}

/**
 * Gate a scene whose stored objects changed (and any prefabs) and make the
 * one `prefabLinkEdit` change for it. The no-change check is the gate's.
 */
export function storeLinkEdit(
  state: { scene: SceneDocument; content?: ContentDocument; manifest?: CommandState['manifest'] },
  entities: readonly EntityV3[],
  copyIds: string[],
  content?: ContentDocument,
  prefabs?: PrefabLinkEditChange['prefabs'],
): { ok: true; op: OpSuccess } | { ok: false; error: CommandError } {
  const scene = state.scene;
  const gate = gateResultState({ scene, content: state.content, manifest: state.manifest }, { ...scene, revision: scene.revision + 1, entities }, content);
  if (!gate.ok) return gate;
  const { previous, next } = entriesDiff(scene.entities as EntityV3[], gate.scene.entities as EntityV3[]);
  const change: PrefabLinkEditChange = { type: 'prefabLinkEdit', copyIds, previous, next, removedIds: removedOf(previous, next), ...(prefabs !== undefined && prefabs.length > 0 ? { prefabs } : {}) };
  return { ok: true, op: { scene: gate.scene, ...(gate.content !== undefined && content !== undefined ? { content: gate.content } : {}), change, inverse: { kind: 'prefabLinkEdit' } } };
}

/** The ids of objects one side holds and the other does not. */
export function removedOf(previous: readonly SceneEntry[], next: readonly SceneEntry[]): string[] {
  const kept = new Set(next.map((n) => n.entity.id));
  return previous.map((p) => p.entity.id).filter((id) => !kept.has(id));
}

/** The ids a scene must never give a new object: its copies' kept part ids, beside the caller's reserved ones. */
export function withKeptPartIds(scene: SceneDocument, reserved: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  const kept = keptPartIds(scene.entities);
  if (kept.length === 0) return reserved;
  return new Set([...(reserved ?? []), ...kept]);
}

/** The scene with every linked copy assembled (undefined: it holds none). */
export function assembledView(scene: SceneDocument, content: ContentDocument | undefined): SceneDocument | undefined {
  const loc = locateCopies(scene, content);
  if (loc === null) return undefined;
  return { ...scene, entities: expandCopies(scene, loc, new Set(loc.links.keys())) } as SceneDocument;
}
