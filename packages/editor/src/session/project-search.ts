/**
 * The project window's search box, Unity's syntax: `t:<type>` filters by
 * kind (several `t:` widen it), `l:<label>` by label (several narrow it: an
 * item has every one), and the other words are a part of the name, id or
 * file. `t:` takes a kind (`audio`, `material`, `scene`, …), one of Unity's
 * type names for it (`AudioClip`, `Texture2D`, `Prefab`, …) or the start of a
 * kind (`t:mat`); a type that names no kind finds nothing.
 *
 * Pure: no DOM.
 */
import { ASSET_KINDS, RESOURCE_KIND_TABLE } from '@thirdlight/project-model/limits';

/** Every kind the index lists: the asset kinds, the resource kinds and scenes. */
export const PROJECT_KINDS: readonly string[] = [...ASSET_KINDS, ...RESOURCE_KIND_TABLE.map((k) => k.kind), 'scene'];

/** Unity's (and a few common) type names for the kinds here. */
const TYPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  asset: ASSET_KINDS,
  audioclip: ['audio'],
  sound: ['audio'],
  texture2d: ['texture'],
  image: ['texture'],
  mesh: ['model'],
  gameobject: ['prefab'],
  monoscript: ['behavior'],
  script: ['behavior', 'library'],
  animatorcontroller: ['animator'],
  scenes: ['scene'],
  shader: ['material', 'graph'],
  visualeffect: ['effect'],
  uidocument: ['ui'],
  conversation: ['dialogue'],
};

/** What a search asks the index for. */
export interface ProjectSearch {
  /** The kinds `t:` names (null: no `t:`). */
  readonly kinds: readonly string[] | null;
  readonly labels: readonly string[];
  /** The words that are not a filter (a part of the name, id or file). */
  readonly text: string;
}

/** The kinds one `t:` value names (a kind that is none of them when it names nothing). */
export function kindsOfType(value: string): string[] {
  const v = value.toLowerCase();
  if (PROJECT_KINDS.includes(v)) return [v];
  const alias = TYPE_ALIASES[v];
  if (alias !== undefined) return [...alias];
  const prefixed = PROJECT_KINDS.filter((k) => k.startsWith(v));
  // A type no kind has: a kind nothing is, so nothing matches.
  return prefixed.length > 0 ? prefixed : [`none:${v}`];
}

export function parseSearch(input: string): ProjectSearch {
  const kinds: string[] = [];
  let typed = false;
  const labels: string[] = [];
  const words: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (token === '') continue;
    const m = /^([tl]):(.+)$/i.exec(token);
    if (m === null) {
      words.push(token);
      continue;
    }
    if (m[1]!.toLowerCase() === 't') {
      typed = true;
      for (const k of kindsOfType(m[2]!)) if (!kinds.includes(k)) kinds.push(k);
    } else if (!labels.includes(m[2]!)) labels.push(m[2]!);
  }
  return { kinds: typed ? kinds : null, labels, text: words.join(' ') };
}

/** The search with its `t:` filter set to one kind (null: none), the rest kept (the kind menu writes the box). */
export function withType(input: string, kind: string | null): string {
  const rest = input
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !/^t:/i.test(t));
  return [...(kind !== null ? [`t:${kind}`] : []), ...rest].join(' ');
}

/** The one kind a search's `t:` names, for the kind menu (null: none or several). */
export function typeOf(input: string): string | null {
  const types = input
    .trim()
    .split(/\s+/)
    .filter((t) => /^t:/i.test(t));
  if (types.length !== 1) return null;
  const kinds = kindsOfType(types[0]!.slice(2));
  return kinds.length === 1 && PROJECT_KINDS.includes(kinds[0]!) ? kinds[0]! : null;
}
