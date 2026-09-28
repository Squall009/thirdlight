/**
 * Phase 25.7b: the project materials a game uses — the ones the runtime
 * manifest ships (an unused material is left out of the game).
 *
 * A material is used when something the game can draw names it:
 *
 * - an object's material mapping (`materials`: slot → materialId) or its
 *   graph-material overrides (`materialParams`, keyed by materialId), in any
 *   scene or in a prefab a script may spawn;
 * - a shipped model asset's default mapping (`materials` on the asset row);
 * - a block type's mapping;
 * - an effect's Output block that shades with a project material;
 * - a timeline's material track.
 *
 * Nothing else reaches a material at run time: scripts set parameters on the
 * materials an object wears (`ctx.materials`), they never put a material on
 * an object, so a script cannot name a material that none of the above does.
 */
import { effectMaterialRefs, type EffectDef } from './effects';
import { timelineRefs, type TimelineAsset } from './timelines';

export interface MaterialUseInput {
  /** Every scene's and every spawnable prefab's entities. */
  readonly entities: Iterable<{ readonly components?: unknown }>;
  /** The game's asset rows (a model's default mapping in `materials`). */
  readonly assets?: readonly { readonly materials?: Readonly<Record<string, string>> }[];
  readonly blockTypes?: readonly { readonly materials?: Readonly<Record<string, string>> }[];
  readonly effects?: readonly EffectDef[];
  readonly timelines?: readonly TimelineAsset[];
}

/** The materialIds the game uses (see the module comment). */
export function materialsInUse(input: MaterialUseInput): Set<string> {
  const used = new Set<string>();
  const mapping = (m: unknown): void => {
    if (typeof m !== 'object' || m === null) return;
    for (const id of Object.values(m as Record<string, unknown>)) if (typeof id === 'string') used.add(id);
  };
  for (const e of input.entities) {
    const c = e.components as { materials?: unknown; materialParams?: unknown } | undefined;
    if (c === undefined || c === null) continue;
    mapping(c.materials);
    if (typeof c.materialParams === 'object' && c.materialParams !== null) for (const id of Object.keys(c.materialParams)) used.add(id);
  }
  for (const a of input.assets ?? []) mapping(a.materials);
  for (const t of input.blockTypes ?? []) mapping(t.materials);
  for (const fx of input.effects ?? []) for (const id of effectMaterialRefs(fx)) used.add(id);
  for (const id of timelineRefs(input.timelines).materials) used.add(id);
  return used;
}
