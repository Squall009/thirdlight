/**
 * The project window's items: how one is named in a selection, what a drag
 * of several carries, and which editor a double-click opens for a kind.
 *
 * Pure: no DOM.
 */
import { ASSET_KINDS } from '@thirdlight/project-model/limits';

/** Items and folders dragged inside the project window (a move when dropped on a folder). */
export const PROJECT_DRAG_TYPE = 'application/x-thirdlight-project-items';

/** An asset, resource or scene by kind and id. */
export interface ProjectItem {
  readonly kind: string;
  readonly id: string;
}

/** What a cut or a drag carries: items, and folders with everything in them. */
export interface ProjectSelection {
  readonly items: readonly ProjectItem[];
  readonly folders: readonly string[];
}

const FOLDER_PREFIX = 'folder:';

/** A selection key: `kind:id` for an item, `folder:<path>` for a folder. */
export function itemKey(item: ProjectItem): string {
  return `${item.kind}:${item.id}`;
}
export function folderKey(path: string): string {
  return `${FOLDER_PREFIX}${path}`;
}

/** The items and folders a set of selection keys names. */
export function selectionOf(keys: Iterable<string>): ProjectSelection {
  const items: ProjectItem[] = [];
  const folders: string[] = [];
  for (const key of keys) {
    if (key.startsWith(FOLDER_PREFIX)) folders.push(key.slice(FOLDER_PREFIX.length));
    else {
      const at = key.indexOf(':');
      if (at > 0) items.push({ kind: key.slice(0, at), id: key.slice(at + 1) });
    }
  }
  return { items, folders };
}

/** A project drag's payload (null: not one). */
export function parseProjectDrag(raw: string): ProjectSelection | null {
  try {
    const v = JSON.parse(raw) as { items?: unknown; folders?: unknown };
    if (!Array.isArray(v.items) || !Array.isArray(v.folders)) return null;
    const items = v.items.filter((i): i is ProjectItem => typeof (i as ProjectItem)?.kind === 'string' && typeof (i as ProjectItem)?.id === 'string');
    const folders = v.folders.filter((f): f is string => typeof f === 'string');
    return { items, folders };
  } catch {
    return null;
  }
}

export function isAssetKind(kind: string): boolean {
  return (ASSET_KINDS as readonly string[]).includes(kind);
}

/** Whether a folder is `folder` or inside it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The folders from the top to a folder (`a/b/c` → `a`, `a/b`, `a/b/c`). */
export function folderTrail(folder: string): string[] {
  if (folder === '') return [];
  const parts = folder.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** The folder a file is in (`""`: the top). */
export function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** A name for a new folder that is not one of these (`New Folder`, `New Folder 2`, …). */
export function freeFolderName(taken: readonly string[], base = 'New Folder'): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!lower.has(name.toLowerCase())) return name;
  }
}

/**
 * The editor tab a resource opens in (its document kind), or null when it
 * opens elsewhere (a scene in the Scene view, a prefab or an environment
 * preset in its panel, an asset in its preview). A behavior opens as a script;
 * the caller opens a visual script's graph instead.
 */
export function documentOfItem(item: ProjectItem): { kind: string; id: string } | null {
  const kind = DOCUMENT_KIND_OF[item.kind];
  return kind === undefined ? null : { kind, id: item.id };
}

const DOCUMENT_KIND_OF: Readonly<Record<string, string>> = {
  material: 'material',
  animator: 'animator',
  graph: 'graph',
  effect: 'effect',
  library: 'script-library',
  ui: 'ui-document',
  uitheme: 'ui-theme',
  dialogue: 'dialogue',
  timeline: 'timeline',
  behavior: 'script',
};
