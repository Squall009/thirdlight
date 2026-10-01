/**
 * How a graph node shows what it is: its catalogue category falls into one
 * of a few families (inputs, maths, logic, events, outputs, rendering,
 * state, actions, notes), and each family has one colour, defined once as
 * a CSS custom property in editor.css (`--node-<family>`) that both the
 * canvas (the node's header) and the DOM (catalogue entries, legends) read.
 *
 * The categories named here are the graph framework's structural ones
 * (shared by the material, effect, dialogue, animator and visual-script
 * kinds); any other category, such as a visual script's game API namespace
 * ("Physics", "Timers", "UI"), is an action: a call into the game.
 *
 * Pure, except `familyColor`, which reads the stylesheet when there is one.
 */

export const NODE_FAMILIES = ['input', 'math', 'logic', 'event', 'output', 'render', 'state', 'action', 'note'] as const;
export type NodeFamily = (typeof NODE_FAMILIES)[number];

/** The structural categories and their family (any other category is an action). */
export const FAMILY_OF_CATEGORY: Readonly<Record<string, NodeFamily>> = {
  Inputs: 'input',
  Input: 'input',
  Constants: 'input',
  Variables: 'input',
  Values: 'input',
  Contexts: 'event',
  Math: 'math',
  Maths: 'math',
  Vectors: 'math',
  Random: 'math',
  Logic: 'logic',
  Flow: 'logic',
  Functions: 'logic',
  Text: 'logic',
  Lists: 'logic',
  Maps: 'logic',
  Utility: 'logic',
  Events: 'event',
  Lifecycle: 'event',
  Signals: 'event',
  Messages: 'event',
  Output: 'output',
  Blend: 'output',
  Textures: 'render',
  Lighting: 'render',
  Rendering: 'render',
  Spawn: 'event',
  Kill: 'event',
  Initialize: 'input',
  Position: 'input',
  Forces: 'math',
  'Over life': 'math',
  Collision: 'logic',
  Interface: 'input',
  States: 'state',
  Lines: 'state',
  Debug: 'note',
  Organisation: 'note',
};

/** A category's family. */
export function familyOf(category: string | undefined): NodeFamily {
  return category === undefined ? 'action' : (FAMILY_OF_CATEGORY[category] ?? 'action');
}

/** Used where no stylesheet is loaded (tests, workers): a neutral header. */
const NO_STYLESHEET = '#2b3a52';
const colors = new Map<NodeFamily, string>();

/** A family's colour from the stylesheet's `--node-<family>` (read once per family). */
export function familyColor(family: NodeFamily): string {
  const have = colors.get(family);
  if (have !== undefined) return have;
  const css = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(`--node-${family}`).trim();
  const color = css === '' ? NO_STYLESHEET : css;
  if (css !== '') colors.set(family, color);
  return color;
}
