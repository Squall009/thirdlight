/**
 * A linked copy's body overrides (its collider and controller) in their 3D
 * form, for the step that retires the physics dimension.
 *
 * Overrides are stored at leaf paths (`components/collider/shape/vertices`,
 * `components/collider/depth`, a whole shape where its type changed), so an
 * override cannot be converted on its own: a polygon's `vertices` beside the
 * prefab's new `points` would not build. Instead each part a body override
 * touches is assembled as the copy stood in 2D (the 2D prefabs and every
 * override), its body converted the way a prefab part is, and the overrides
 * written again as the difference from the converted prefab's part — the
 * same diff the commands store a copy with.
 */
import { canonicalJsonKey } from '@thirdlight/shared';
import { createPrefabAssembler, type AssemblyEntity, type AssemblyPrefab, type PrefabAssembler } from './prefab-assembly';
import { nestedPrefabIds, type PrefabOverride } from './prefab-links';
import { partOverrides } from './prefab-relink';
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

/** The components an upgrade converts on a copy's part. */
const BODY_COMPONENTS = ['collider', 'controller'] as const;

/** The body component an override path is under, if any. */
const bodyOf = (path: unknown): string | undefined => (typeof path === 'string' ? BODY_COMPONENTS.find((c) => path === `components/${c}` || path.startsWith(`components/${c}/`)) : undefined);

/** A part's components converted as a prefab part's are (the same object when nothing changes). */
export type PartBodyConvert = (components: Obj) => Obj;

const IDENTITY_TRANSFORM = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const ASSEMBLY_ID = 'upgrade-copy';

/** The assembled parts of a link, by part key (null: the copy cannot be assembled). */
function partsOf(assembler: PrefabAssembler, link: Obj): Map<string, AssemblyEntity> | null {
  const made = assembler.assembleCopy({ id: ASSEMBLY_ID, components: { transform: IDENTITY_TRANSFORM, prefab: link } });
  if (made.problems.some((p) => p.code === 'prefab_missing' || p.code === 'prefab_cycle')) return null;
  const keys = [...made.partIds.keys()];
  return new Map(made.entities.map((e, i) => [keys[i] as string, e]));
}

const pick = (components: object, names: ReadonlySet<string>): Obj => {
  const out: Obj = {};
  for (const n of names) if ((components as Obj)[n] !== undefined) out[n] = (components as Obj)[n];
  return out;
};

/**
 * A link with its body overrides rewritten in the 3D form (null: none
 * changed), and how many overrides it now holds for the parts that changed.
 * `before` assembles the 2D prefabs, `after` the converted ones.
 */
export function linkBodyOverrides3D(link: unknown, before: PrefabAssembler, after: PrefabAssembler, convert: PartBodyConvert): { link: Obj | null; count: number } {
  const none = { link: null, count: 0 };
  if (!isPlainObject(link) || !Array.isArray(link['overrides'])) return none;
  const overrides = link['overrides'] as PrefabOverride[];
  const touched = new Map<string, Set<string>>();
  for (const o of overrides) {
    const c = isPlainObject(o) && typeof o.part === 'string' ? bodyOf((o as { path?: unknown }).path) : undefined;
    if (c === undefined) continue;
    const set = touched.get(o.part) ?? new Set<string>();
    set.add(c);
    touched.set(o.part, set);
  }
  if (touched.size === 0) return none;
  const isBody = (o: PrefabOverride): boolean => touched.get(o.part)?.has(bodyOf((o as { path?: unknown }).path) ?? '') === true;
  const was = partsOf(before, link);
  const base = partsOf(after, { ...link, overrides: overrides.filter((o) => !isBody(o)) });
  if (was === null || base === null) return none;

  const rewritten = new Map<string, PrefabOverride[]>();
  let count = 0;
  for (const [part, comps] of touched) {
    const w = was.get(part);
    const b = base.get(part);
    const old = overrides.filter((o) => o.part === part && isBody(o));
    // A part the prefab no longer has keeps its (stale) overrides: assembly reports them.
    if (w === undefined || b === undefined) {
      rewritten.set(part, old);
      continue;
    }
    const out: PrefabOverride[] = [];
    partOverrides(out, part, { id: ASSEMBLY_ID, components: pick(b.components, comps) }, { components: pick(convert(w.components as Obj), comps) }, true);
    rewritten.set(part, out);
    if (canonicalJsonKey(out) !== canonicalJsonKey(old)) count += out.length;
  }
  if (count === 0) return none;
  // Each part's new body overrides stand where its first one stood.
  const next: PrefabOverride[] = [];
  for (const o of overrides) {
    if (!isBody(o)) next.push(o);
    else if (rewritten.has(o.part)) {
      next.push(...rewritten.get(o.part)!);
      rewritten.delete(o.part);
    }
  }
  const { overrides: _old, ...rest } = link;
  return { link: next.length > 0 ? { ...rest, overrides: next } : rest, count };
}

/** A prefab list as assembly reads it (malformed entries left out: validation reports them). */
export function assemblyPrefabs(prefabs: readonly unknown[]): AssemblyPrefab[] {
  return prefabs.filter((p): p is AssemblyPrefab => isPlainObject(p) && typeof p['prefabId'] === 'string' && Array.isArray(p['entities']) && (p['entities'] as unknown[]).every(isPlainObject));
}

/**
 * The prefabs with the links of their nested copies converted, inner prefabs
 * first (a nested copy's overrides are diffed against its prefab's converted
 * form, so that prefab must be final). Prefabs in a nesting cycle are left
 * as they are: they do not assemble anyway.
 */
export function prefabLinksConverted(prefabs: readonly unknown[], before: PrefabAssembler, convert: PartBodyConvert): { prefabs: unknown[]; count: number; changed: boolean } {
  const list = [...prefabs];
  const ids = new Map<string, number>();
  list.forEach((p, i) => {
    if (isPlainObject(p) && typeof p['prefabId'] === 'string') ids.set(p['prefabId'], i);
  });
  const done = new Set<string>();
  for (const p of assemblyPrefabs(list)) if (nestedPrefabIds(p).length === 0) done.add(p.prefabId);
  let count = 0;
  let changed = false;
  for (let progress = true; progress; ) {
    progress = false;
    const after = createPrefabAssembler(assemblyPrefabs(list));
    const ready = assemblyPrefabs(list).filter((p) => !done.has(p.prefabId) && nestedPrefabIds(p).every((id) => done.has(id)));
    for (const p of ready) {
      done.add(p.prefabId);
      progress = true;
      let any = false;
      const entities = p.entities.map((e) => {
        const r = linkBodyOverrides3D((e.components as Obj)['prefab'], before, after, convert);
        if (r.link === null) return e;
        count += r.count;
        any = true;
        return { ...e, components: { ...(e.components as Obj), prefab: r.link } };
      });
      if (any) {
        list[ids.get(p.prefabId)!] = { ...p, entities };
        changed = true;
      }
    }
  }
  return { prefabs: list, count, changed };
}
