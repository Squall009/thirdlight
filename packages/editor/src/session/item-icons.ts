/**
 * The editor's one icon registry: the picture of every kind of item (each
 * asset kind, each resource kind, scenes, folders, and the visual script a
 * behavior can be) and of every action an editor's toolbar offers. Tiles,
 * rows, the editor window's tabs and headers, empty states and toolbars all
 * read their pictures here, so a kind or an action has one picture
 * everywhere.
 *
 * The files are small WebPs (made by tools/icons/pack-editor-icons.mjs from
 * the generated art listed in tools/icons/editor-icons.tsv), served next to
 * the editor page.
 *
 * Pure: no DOM.
 */
import { PROJECT_KINDS } from './project-search';

/** Kinds that have a picture but are not an index kind: a folder, and a behavior whose source is a graph. */
export const EXTRA_ICON_KINDS = ['folder', 'visual-script'] as const;

/** Every kind with a picture: the index's kinds and the extra ones. */
export const ICON_KINDS: readonly string[] = [...PROJECT_KINDS, ...EXTRA_ICON_KINDS];

/** The actions editors' toolbars offer (the Scene view's transform tools too), each with one picture. */
export const TOOL_ACTIONS = [
  'add',
  'add-node',
  'add-key',
  'comment',
  'group',
  'breakpoint',
  'align-left',
  'align-center-x',
  'align-right',
  'align-top',
  'align-center-y',
  'align-bottom',
  'distribute-x',
  'distribute-y',
  'fit',
  'snap',
  'compile',
  'publish',
  'save',
  'play',
  'pause',
  'delete',
  'marker',
  'layer',
  'open',
  'move',
  'rotate',
  'scale',
] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

const KIND_SET: ReadonlySet<string> = new Set(ICON_KINDS);
const ACTION_SET: ReadonlySet<string> = new Set(TOOL_ACTIONS);

/** Where the pictures are served, relative to the editor page. */
export const ICON_ROOT = './icons';

/** A kind's picture (undefined: a kind the registry does not know). */
export function kindIcon(kind: string): string | undefined {
  return KIND_SET.has(kind) ? `${ICON_ROOT}/kinds/${kind}.webp` : undefined;
}

/** An action's picture. */
export function actionIcon(action: ToolAction): string {
  return `${ICON_ROOT}/actions/${action}.webp`;
}

export function isToolAction(name: string): name is ToolAction {
  return ACTION_SET.has(name);
}
