/**
 * Reading a linked prefab copy in the editor: which fields of a part its
 * copy overrides (the Inspector marks them), how an override reads in the
 * Overrides list, the chain a variant is made from, and which objects start
 * a copy (the Hierarchy marks them). The editor holds assembled objects
 * only; the copy's stored link comes from `queryEntity` (`prefabCopy`).
 */
import type { PrefabOverride } from '@thirdlight/project-model';

/** `queryEntity`'s `prefabCopy`: the copy an object belongs to, as stored. */
export interface PrefabCopyView {
  copyId: string;
  /** The prefab the copy links (a variant's copy: the variant). */
  prefabId: string;
  /** The object's part path key. */
  part: string;
  root: boolean;
  /** Every override of the copy. */
  overrides: PrefabOverride[];
  /** Each part's object id, by part path key. */
  partIds: Record<string, string>;
}

/** The overrides on one part of the copy. */
export function overridesOfPart(copy: PrefabCopyView, part: string): PrefabOverride[] {
  return copy.overrides.filter((o) => o.part === part);
}

/**
 * Whether a part's override changes this field (or something inside it):
 * `component` and the field's path inside it (empty: the component itself).
 */
export function fieldOverridden(overrides: readonly PrefabOverride[], component: string, path: readonly (string | number)[]): boolean {
  const at = ['components', component, ...path].join('/');
  return overrides.some((o) => 'path' in o && (o.path === at || o.path.startsWith(`${at}/`)));
}

/** The override path of a field (`components/<component>/<path…>`). */
export function fieldOverridePath(component: string, path: readonly (string | number)[]): string {
  return ['components', component, ...path].join('/');
}

/** An override as the Overrides list reads it: what changed, on which part. */
export function overrideLabel(o: PrefabOverride, partName: string): string {
  if (!('path' in o)) return `${partName}: removed`;
  const segs = o.path.split('/');
  const what = segs[0] === 'components' ? (segs.length === 2 ? `${segs[1]} component` : `${segs[1]} ${segs.slice(2).join('.')}`) : segs[0];
  return `${partName}: ${what}${'remove' in o ? ' removed' : ''}`;
}

/** A definition as these helpers read it: its entities, the first being the root. */
export interface DefinitionView {
  entities: readonly { localId: string; components: object }[];
}

/**
 * The prefabs a prefab is made from: itself, then (a variant) its base, its
 * base's base… A variant's root is a copy of its base.
 */
export function variantChain(prefabId: string, definitionOf: (id: string) => DefinitionView | undefined): string[] {
  const chain = [prefabId];
  for (let at = prefabId; chain.length < 64; ) {
    const link = (definitionOf(at)?.entities[0]?.components as { prefab?: { prefabId?: unknown; localId?: unknown } } | undefined)?.prefab;
    if (link === undefined || typeof link.prefabId !== 'string' || link.localId !== undefined || chain.includes(link.prefabId)) break;
    chain.push(link.prefabId);
    at = link.prefabId;
  }
  return chain;
}

/**
 * Whether an object starts a copy (a placed copy's root, or a copy nested in
 * a prefab): its part provenance names its prefab's root. Absent definition:
 * unknown, so not marked as a start.
 */
export function startsCopy(provenance: { prefabId: string; localId: string } | undefined, definitionOf: (id: string) => DefinitionView | undefined): boolean {
  if (provenance === undefined) return false;
  return definitionOf(provenance.prefabId)?.entities[0]?.localId === provenance.localId;
}

/**
 * The model a prefab's tile shows: its first object with a model, looking
 * into nested copies (a variant's base) when its own objects have none. The
 * prefab ids still to be read come back in `missing`.
 */
export function prefabPicture(prefabId: string, definitionOf: (id: string) => DefinitionView | undefined): { model: { assetId: string; piece: string | null } | null; missing: string[] } {
  const seen = new Set<string>();
  const missing: string[] = [];
  const visit = (id: string): { assetId: string; piece: string | null } | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const def = definitionOf(id);
    if (def === undefined) {
      missing.push(id);
      return null;
    }
    const nested: string[] = [];
    for (const e of def.entities) {
      const c = e.components as { model?: { asset?: { assetId?: unknown }; piece?: unknown }; prefab?: { prefabId?: unknown; localId?: unknown } };
      const assetId = c.model?.asset?.assetId;
      if (typeof assetId === 'string') return { assetId, piece: typeof c.model?.piece === 'string' ? c.model.piece : null };
      if (c.prefab !== undefined && typeof c.prefab.prefabId === 'string' && c.prefab.localId === undefined) nested.push(c.prefab.prefabId);
    }
    for (const n of nested) {
      const m = visit(n);
      if (m !== null) return m;
    }
    return null;
  };
  return { model: visit(prefabId), missing };
}
