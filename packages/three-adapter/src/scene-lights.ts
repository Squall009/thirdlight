/**
 * Phase 25.8: which lights of the loaded scenes are on.
 *
 * Lights belong to scenes: any scene may hold any light kind (each scene at
 * most one directional, one ambient and one hemisphere light, and 16 point
 * and spot lights). With scenes loaded on top of each other:
 *
 * - directional, ambient and hemisphere: the most recently loaded scene that
 *   holds one of that kind has its light on; the others are off (not drawn).
 *   Each kind is chosen on its own, so a scene that holds only a directional
 *   light keeps the ambient light of the scene below it. When that scene
 *   unloads, the previous one's light is on again.
 * - point and spot lights of all loaded scenes share one budget
 *   (`LOCAL_LIGHT_BUDGET`); past it the most recently loaded scenes' lights
 *   are on (in document order within a scene), the rest off until a scene
 *   unloads.
 *
 * Pure: the adapter hands in the realized lights with their scene's load
 * rank and switches `visible` from the answer.
 */
import { MAX_LOCAL_LIGHTS } from '@thirdlight/runtime';

/** The point and spot lights drawn at once: the model's per-scene cap. */
export const LOCAL_LIGHT_BUDGET = MAX_LOCAL_LIGHTS;

export type SceneLightKind = 'directional' | 'ambient' | 'hemisphere' | 'point' | 'spot';

export interface SceneLightEntry {
  readonly id: string;
  readonly kind: SceneLightKind;
  /** The load rank of its scene: higher = loaded more recently (-1: in no known scene). */
  readonly rank: number;
  /** Its realize order (document order within a scene). */
  readonly order: number;
}

export interface SceneLightSelection {
  /** The ids of the lights that are on. */
  readonly active: ReadonlySet<string>;
  /** The directional light that is on (the key light), or null. */
  readonly directional: string | null;
  readonly ambient: string | null;
  readonly hemisphere: string | null;
  /** Point and spot lights of the loaded scenes, and how many of them are on. */
  readonly localTotal: number;
  readonly localOn: number;
}

export function selectSceneLights(entries: readonly SceneLightEntry[], budget = LOCAL_LIGHT_BUDGET): SceneLightSelection {
  const active = new Set<string>();
  const pick = (kind: SceneLightKind): string | null => {
    let best: SceneLightEntry | null = null;
    for (const e of entries) {
      if (e.kind !== kind) continue;
      if (best === null || e.rank > best.rank || (e.rank === best.rank && e.order < best.order)) best = e;
    }
    if (best !== null) active.add(best.id);
    return best?.id ?? null;
  };
  const directional = pick('directional');
  const ambient = pick('ambient');
  const hemisphere = pick('hemisphere');
  const local = entries.filter((e) => e.kind === 'point' || e.kind === 'spot').sort((a, b) => b.rank - a.rank || a.order - b.order);
  const on = local.slice(0, Math.max(0, budget));
  for (const e of on) active.add(e.id);
  return { active, directional, ambient, hemisphere, localTotal: local.length, localOn: on.length };
}
