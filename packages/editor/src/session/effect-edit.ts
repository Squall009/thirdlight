/**
 * Pure helpers for authoring effects in the editor: a new effect and a new
 * system are built from project-model's defaults and context layout (its
 * `effects` and `effect-graph-kinds` subpaths), so the backend accepts them as
 * they are.
 */
import type { EffectDef, EffectSystem } from '@thirdlight/project-model';
import { newEffectSystemGraph } from '@thirdlight/project-model/effect-graph-kinds';
import { EFFECT_DEFAULTS } from '@thirdlight/project-model/effects';

/** An id from a name (lower case, a-z 0-9 _ -), unique among `taken`. */
export function uniqueId(name: string, taken: readonly string[], fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** A new system: the four contexts, no blocks; the model's default particle count and space. */
export function newSystem(systemId: string, name: string): EffectSystem {
  return { systemId, name, maxParticles: EFFECT_DEFAULTS.maxParticles, space: EFFECT_DEFAULTS.space, graph: newEffectSystemGraph() };
}

/** A new effect with no systems (the model's default duration, loop, seed and bounds). */
export function newEffect(effectId: string, name: string): EffectDef {
  const d = EFFECT_DEFAULTS;
  return { effectId, name, duration: d.duration, loop: d.loop, seed: d.seed, bounds: { center: [...d.bounds.center], size: [...d.bounds.size] }, systems: [] };
}
