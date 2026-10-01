/**
 * Asset files a project names that the game folder no longer has, and who
 * uses them.
 *
 * Unity and Godot open a project with missing files and show the references
 * as warnings (Godot's dependency list, Unity's "Missing" fields); the
 * project here does the same: every missing file is listed with what names
 * its asset, so a moved texture is found at once instead of one Play refusal
 * at a time.
 *
 * "Uses" come from the same generic scan the build's dependency lists use
 * (`scanDependencies`): a scene, a prefab, a material, an effect, an animator,
 * a model's material map or a project-wide block (UI, shell, environment …)
 * uses an asset when it names it directly or through the resources it names.
 *
 * The start scenes' draw set is what a Play needs before its first frame:
 * the start scenes' dependencies and the project-wide blocks'. A missing file
 * outside it can be stood in for by a placeholder until a scene that draws it
 * loads; one inside it would show a start with holes.
 */
import { dependencyTables, scanDependencies, type DependencyScanTables } from './catalog-dependencies';

/** Who uses an asset: one document of the project (its kind and id). */
export interface MissingFileUser {
  /** `project` is a project-wide block (`id` is its key: `uiDocuments`, `shell`, `environment` …); `asset` a model whose material map names it. */
  readonly kind: 'scene' | 'prefab' | 'material' | 'effect' | 'animator' | 'asset' | 'project';
  readonly id: string;
}

/** One asset whose file is not in the game folder. */
export interface MissingAssetFile {
  readonly assetId: string;
  readonly displayName: string;
  readonly kind: string;
  /** The file the asset's current version is read from (a converted asset's original), project-relative. */
  readonly path: string;
  /** What names the asset (empty: nothing does; a script may still load it by name). */
  readonly usedBy: readonly MissingFileUser[];
}

/** One asset a Play stands a placeholder in for, or a refusal names. */
export interface MissingPlayFile {
  readonly assetId: string;
  readonly kind: string;
  /** The file that is missing (null: bytes the project stored itself, or its import cache). */
  readonly path: string | null;
  /** Whether a start scene or a project-wide block draws it (a Play then refuses). */
  readonly inStart: boolean;
  /** The workspace's code for why it could not be read (`asset_source_missing`, `imported_missing`, `blob_missing`). */
  readonly code: string;
}

/** The content blocks every scene shares (what the project-wide blocks need), in the order the build scans them. */
const PROJECT_WIDE_KEYS = ['environment', 'effects', 'uiDocuments', 'uiThemes', 'shell', 'timelines', 'eventCues', 'blockTypes', 'input', 'speakers'] as const;

/** The project-wide blocks of `content`; `effects` may be given in their runtime form (the build ships those). */
export function projectWideRoots(content: Readonly<Record<string, unknown>> | null | undefined, effects?: unknown): unknown[] {
  const c = content ?? {};
  return PROJECT_WIDE_KEYS.map((k) => (k === 'effects' && effects !== undefined ? effects : c[k]));
}

interface ContentLike {
  readonly assets?: readonly { readonly assetId: string; readonly kind?: string; readonly materials?: unknown }[];
  readonly materials?: readonly { readonly materialId: string }[];
  readonly graphs?: readonly { readonly graphId: string; readonly kind?: string }[];
  readonly effects?: readonly { readonly effectId: string }[];
  readonly animators?: readonly { readonly controllerId: string }[];
  readonly prefabs?: readonly { readonly prefabId: string }[];
  readonly lighting?: Readonly<Record<string, unknown>>;
}

interface SceneLike {
  readonly sceneId: string;
}

/** The scan tables of the authored content (every material, function, effect, animator and prefab). */
function tablesOf(content: ContentLike): DependencyScanTables {
  return dependencyTables({
    assets: content.assets ?? [],
    materials: content.materials ?? [],
    functions: (content.graphs ?? []).filter((g) => g.kind === 'material-function'),
    effects: content.effects ?? [],
    animators: content.animators ?? [],
    prefabs: content.prefabs ?? [],
  });
}

/**
 * The asset ids a Play draws before its first frame: what the start scenes
 * (with their bakes) and the project-wide blocks need.
 */
export function startDrawSet(content: unknown, scenes: readonly unknown[], startSceneIds: readonly string[]): Set<string> {
  const c = (content ?? {}) as ContentLike;
  const start = new Set(startSceneIds);
  const roots: unknown[] = [];
  for (const sc of scenes) {
    const id = (sc as SceneLike).sceneId;
    if (start.has(id)) roots.push(sc, c.lighting?.[id]);
  }
  roots.push(...projectWideRoots(content as Record<string, unknown>));
  return new Set(scanDependencies(tablesOf(c), roots));
}

/**
 * Who uses each of `assetIds`: every scene, prefab, material, effect,
 * animator, model material map and project-wide block whose scan reaches it.
 */
export function assetUsers(content: unknown, scenes: readonly unknown[], assetIds: ReadonlySet<string>): Map<string, MissingFileUser[]> {
  const c = (content ?? {}) as ContentLike;
  const out = new Map<string, MissingFileUser[]>();
  if (assetIds.size === 0) return out;
  const tables = tablesOf(c);
  const note = (user: MissingFileUser, roots: readonly unknown[]): void => {
    for (const id of scanDependencies(tables, roots)) {
      if (!assetIds.has(id) || (user.kind === 'asset' && user.id === id)) continue;
      const list = out.get(id) ?? [];
      list.push(user);
      out.set(id, list);
    }
  };
  for (const sc of scenes) note({ kind: 'scene', id: (sc as SceneLike).sceneId }, [sc, c.lighting?.[(sc as SceneLike).sceneId]]);
  for (const p of c.prefabs ?? []) note({ kind: 'prefab', id: p.prefabId }, [p]);
  for (const m of c.materials ?? []) note({ kind: 'material', id: m.materialId }, [m]);
  for (const e of c.effects ?? []) note({ kind: 'effect', id: e.effectId }, [e]);
  for (const a of c.animators ?? []) note({ kind: 'animator', id: a.controllerId }, [a]);
  for (const a of c.assets ?? []) if (a.kind === 'model' && a.materials !== undefined) note({ kind: 'asset', id: a.assetId }, [a.materials]);
  const wide = projectWideRoots(content as Record<string, unknown>);
  wide.forEach((root, i) => {
    if (root !== undefined) note({ kind: 'project', id: PROJECT_WIDE_KEYS[i]! }, [root]);
  });
  return out;
}
