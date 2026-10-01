/**
 * What a scene, a model or the project-wide blocks need of the shipped
 * assets (Godot's dependency lists, Addressables' catalog dependencies).
 *
 * The scan is generic over the documents: every string in them that names a
 * shipped asset is a dependency; one that names a material, a material
 * function, an effect, an animator or a prefab brings in what that resource
 * names; a model found brings in its own material map and the textures its
 * images were extracted into. So a component or a
 * resource field added later is covered without a table of fields. A string
 * that only happens to equal an asset id adds that asset: a dependency list
 * may hold more than is needed, never less than the documents name.
 */

/** The resources a scan follows, by id. */
export interface DependencyScanTables {
  /** Every shipped asset id. */
  readonly assets: ReadonlySet<string>;
  /** A model asset's material map (slot → material id) and extracted images (image → texture id). */
  readonly modelMaterials?: ReadonlyMap<string, unknown>;
  /** The resources followed by id: materials (resolved), material functions, effects, animators, prefabs. */
  readonly resources: ReadonlyMap<string, unknown>;
}

/** How deep a scan follows nested values (documents are far shallower). */
const SCAN_DEPTH = 64;

/** Build the tables of one build's resources. */
export function dependencyTables(o: {
  readonly assets: Iterable<{ readonly assetId: string; readonly kind?: string; readonly materials?: unknown; readonly textures?: unknown }>;
  readonly materials?: readonly { readonly materialId: string }[];
  readonly functions?: readonly { readonly graphId: string }[];
  readonly effects?: readonly { readonly effectId: string }[];
  readonly animators?: readonly { readonly controllerId: string }[];
  readonly prefabs?: readonly { readonly prefabId: string }[];
}): DependencyScanTables {
  const assets = new Set<string>();
  const modelMaterials = new Map<string, unknown>();
  for (const a of o.assets) {
    assets.add(a.assetId);
    if (a.kind === 'model' && (a.materials !== undefined || a.textures !== undefined)) modelMaterials.set(a.assetId, [a.materials, a.textures]);
  }
  const resources = new Map<string, unknown>();
  for (const m of o.materials ?? []) resources.set(m.materialId, m);
  for (const f of o.functions ?? []) resources.set(f.graphId, f);
  for (const f of o.effects ?? []) resources.set(f.effectId, f);
  for (const c of o.animators ?? []) resources.set(c.controllerId, c);
  for (const p of o.prefabs ?? []) resources.set(p.prefabId, p);
  return { assets, modelMaterials, resources };
}

/**
 * The shipped asset ids `roots` need, directly or through the resources and
 * model material maps they name (ascending).
 */
export function scanDependencies(tables: DependencyScanTables, roots: readonly unknown[]): string[] {
  const found = new Set<string>();
  const followed = new Set<unknown>();
  const queue: unknown[] = [];
  const follow = (v: unknown): void => {
    if (v === undefined || followed.has(v)) return;
    followed.add(v);
    queue.push(v);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > SCAN_DEPTH) return;
    if (typeof value === 'string') {
      if (tables.assets.has(value) && !found.has(value)) {
        found.add(value);
        follow(tables.modelMaterials?.get(value));
      }
      follow(tables.resources.get(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) visit(v, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  while (queue.length > 0) visit(queue.shift(), 0);
  return [...found].sort();
}
