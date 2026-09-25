/**
 * Phase 20.0: pure helpers for authoring effects in the editor (the editor
 * may import project-model types only, so the new-effect and new-system
 * values are built here; `tests/effect-editor-parity.test.ts` keeps them
 * equal to project-model's defaults and context layout).
 */
import type { EffectDef, EffectSystem } from '@thirdlight/project-model';

/** The four contexts of every system graph and where a new system places them (columns). */
export const EFFECT_CONTEXT_NODES: readonly { id: string; position: [number, number] }[] = [
  { id: 'spawn', position: [0, 0] },
  { id: 'initialize', position: [0, 200] },
  { id: 'update', position: [0, 400] },
  { id: 'output', position: [0, 600] },
];

/** An id from a name (lower case, a-z 0-9 _ -), unique among `taken`. */
export function uniqueId(name: string, taken: readonly string[], fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** A new system: the four contexts, no blocks; 1000 particles, local space (project-model EFFECT_DEFAULTS). */
export function newSystem(systemId: string, name: string): EffectSystem {
  return {
    systemId,
    name,
    maxParticles: 1000,
    space: 'local',
    graph: { nodes: EFFECT_CONTEXT_NODES.map((c) => ({ id: c.id, type: c.id, position: [c.position[0], c.position[1]] as [number, number] })), edges: [] },
  };
}

/** A new effect with no systems (project-model EFFECT_DEFAULTS: 2 s loop, seed 1, a 4 m box 1 m above the origin). */
export function newEffect(effectId: string, name: string): EffectDef {
  return { effectId, name, duration: 2, loop: true, seed: 1, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [] };
}
