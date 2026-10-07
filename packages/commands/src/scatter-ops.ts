/**
 * What the terrain and block-layer commands share for rule scatter
 * (`project-model/scatter.ts`): the named regions of the scene's block
 * layers that rules keep clear, and the checks of a scatter stroke and a
 * bake's size.
 */
import { SCATTER_BAKE_MAX_CANDIDATES, type ScatterRect, type ScatterRegionLayer, type ScatterRule, type BlockLayerComponent, type SceneV4 } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import type { SceneDocument } from './types';

type SceneEntity = { id: string; components: Record<string, unknown> };

/** The scene's block layers' named regions, where they are in the world (but layer `except`'s). */
export function sceneRegionLayers(scene: SceneDocument, except?: string): ScatterRegionLayer[] {
  const out: ScatterRegionLayer[] = [];
  for (const e of scene.entities as unknown as SceneEntity[]) {
    const comp = e.components['blockLayer'] as BlockLayerComponent | undefined;
    if (comp === undefined || e.id === except) continue;
    const regions = (scene as SceneV4).blocks?.find((b) => b.entityId === e.id)?.regions ?? [];
    if (regions.length === 0) continue;
    const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
    out.push({ regions: new Map(regions.map((r) => [r.regionId, r.boxes])), cellSize: comp.cellSize, origin: p });
  }
  return out;
}

/** The candidates a bake of `rules` over `area` m² looks at, about (each rule's density times the area). */
export function scatterBakeEstimate(rules: readonly ScatterRule[], area: number): number {
  let n = 0;
  for (const r of rules) n += r.density * area;
  return n;
}

/** The refusal of a bake past the per-request bound (null: within it). */
export function scatterBakeTooLarge(rules: readonly ScatterRule[], rect: ScatterRect | null, area: number): CommandError | null {
  const a = rect === null ? area : Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
  const n = scatterBakeEstimate(rules, Math.min(a, area));
  if (n <= SCATTER_BAKE_MAX_CANDIDATES) return null;
  return fieldValue('/args', Math.round(n), `at most ${SCATTER_BAKE_MAX_CANDIDATES} scatter candidates a command`, `the scatter rules look at about ${Math.round(n)} places here (density times area): lower a rule's density, or use ground cover for dense small things`);
}

/** Why a scatter stroke's rule is not one of the source's (null: it is). */
export function scatterRuleOf(rules: readonly ScatterRule[] | undefined, id: unknown): { ok: true; rule: ScatterRule } | { ok: false; error: CommandError } {
  const rule = (rules ?? []).find((r) => r.id === id);
  if (rule === undefined) return { ok: false, error: fieldValue('/args/rule', id, `one of ${(rules ?? []).map((r) => r.id).join(', ') || 'its scatter rules (it has none)'}`, 'rule names one of the scatter rules of the object') };
  return { ok: true, rule };
}
