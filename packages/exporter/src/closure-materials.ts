/**
 * The materials a build ships: those the game uses (an object, a prefab, a
 * shipped model's default mapping, a block type, an effect or a timeline
 * names them), the loadable ones, the trim sheets architecture presets name
 * and the sheets decal materials draw cells of — resolved (an instance ships
 * with its chain folded in).
 *
 * One function for the content closure and for whoever needs to know what a
 * build will hold without making one (the editor's decal atlas reads the
 * decal pages the build will plan from these).
 */
import { architectureGraphsOf, architectureStylesOf, captureContentViewV3, decalSheetsOf, graphForRuntime, loadableAssetIds, loadableResourceIds, materialsInUse, resolveMaterialInstances, type ArchitectureStyles, type GraphDocument, type BlockType, type EffectDef, type MaterialDef, type PrefabDefinition, type TimelineAsset } from '@thirdlight/project-model';

export interface ShippedMaterialsInput {
  /** The content block. */
  readonly content: unknown;
  /** Every object the build holds (all scenes'). */
  readonly entities: readonly { readonly components?: unknown }[];
  /** The shipped assets' rows (their default material mappings). */
  readonly assets: readonly { readonly materials?: unknown }[];
  /** Generated architecture's styles and presets (the starters are the engine's). */
  readonly styles: () => ArchitectureStyles;
}

/** The shipped materials, resolved (undefined: the content has no material list). */
export function shippedMaterials(o: ShippedMaterialsInput): MaterialDef[] | undefined {
  const content = o.content as { materials?: MaterialDef[]; prefabs?: PrefabDefinition[]; blockTypes?: BlockType[]; effects?: EffectDef[]; timelines?: TimelineAsset[] } | null;
  const all = content?.materials;
  if (all === undefined) return undefined;
  const used = materialsInUse({
    entities: [...o.entities, ...(content?.prefabs ?? []).flatMap((d) => d.entities as unknown as { components?: unknown }[])],
    assets: o.assets as never,
    blockTypes: content?.blockTypes ?? [],
    effects: content?.effects ?? [],
    timelines: content?.timelines ?? [],
  });
  // A loadable material ships too (a script may load it by name).
  for (const id of loadableResourceIds(o.content, 'material')) used.add(id);
  // The trim sheets architecture presets name (any preset may be swapped in at run time).
  for (const p of o.styles().presets.values()) if (p.sheet !== '') used.add(p.sheet);
  // A decal material drawing a trim sheet's cell ships with its sheet.
  const resolved = resolveMaterialInstances(all);
  for (const id of decalSheetsOf(resolved, used)) used.add(id);
  // A named instance ships resolved (its chain's graph, parameters and values folded
  // in), so the runtime never sees an instance; its parents ship only when something names them.
  return resolved.filter((m) => used.has(m.materialId));
}

/**
 * The shipped materials of a captured project, as its build would find them
 * (the same view of the content and the same architecture styles), without
 * making the build. Null: the capture's content view is invalid (the build
 * would refuse it too).
 */
export function shippedMaterialsOfCapture(read: { readonly projectId: string; readonly revision: number; readonly scene: unknown; readonly content: unknown; readonly scenes?: readonly unknown[] }, sha256: (bytes: Uint8Array) => string): MaterialDef[] | undefined | null {
  const view = captureContentViewV3(read.scene, read.content, { projectId: read.projectId, revision: read.revision }, read.scenes, loadableAssetIds(read.content), sha256);
  if (!view.ok) return null;
  const entities = read.scenes !== undefined ? read.scenes.flatMap((sc) => ((sc as { entities?: { components?: unknown }[] }).entities ?? [])) : ((read.scene as { entities?: { components?: unknown }[] } | null)?.entities ?? []);
  const graphs = architectureGraphsOf((read.content as { graphs?: GraphDocument[] } | null)?.graphs).map((g) => ({ graphId: g.graphId, kind: g.kind, name: g.name, graph: graphForRuntime(g.graph) }));
  return shippedMaterials({ content: read.content, entities, assets: view.normalized.assets, styles: () => architectureStylesOf(graphs) });
}
