/**
 * The river template — a spline's water: it validates in the model and
 * compiles without problems; it reads the flow (UV1), the banks (COLOR_0)
 * and the scene's depth behind the surface (the Scene depth node, which is
 * pixels only: in a vertex offset it warns and reads far); it is
 * transparent; its opacity fades with that depth (soft shores).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { canonicalMaterials, materialGraphContext, validateMaterials, type ModelErrorV2 } from '../packages/project-model/src/index';
import { riverMaterial, templateMaterial } from '../packages/editor/src/session/material-graph';
import { compileMaterialGraph, type GraphCompileEnv, type MaterialGraphLike } from '../packages/three-adapter/src/material-graph';

const env = (): GraphCompileEnv => ({
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0), wetness: TSL.uniform(0) },
  texture: () => null,
  fn: () => null,
});

describe('the river template', () => {
  it('validates and compiles: flow, banks and scene depth read, transparent, soft shores', () => {
    const m = riverMaterial('mat-river', 'River');
    expect(templateMaterial('river', 'mat-river', 'River')).toEqual(m);
    const errors: ModelErrorV2[] = [];
    validateMaterials([m], '', errors, materialGraphContext(m.parameters, undefined));
    expect(errors).toEqual([]);
    expect(canonicalMaterials(canonicalMaterials([m]))).toEqual(canonicalMaterials([m]));
    const nodes = m.graph!.nodes;
    expect(nodes.find((n) => n.type === 'pbr')!.data).toMatchObject({ transparent: true });
    expect(nodes.some((n) => n.type === 'uv' && (n.data as { set?: string } | undefined)?.set === 'uv1')).toBe(true);
    for (const t of ['sceneDepth', 'vertexColor', 'noise', 'fract', 'time']) expect(nodes.map((n) => n.type)).toContain(t);
    const c = compileMaterialGraph({ graph: m.graph as MaterialGraphLike, parameters: m.parameters }, env());
    expect(c.problems).toEqual([]);
    expect(c.slots.opacity).toBeDefined();
    expect(m.parameters!.map((p) => p.key)).toEqual(['flowCycle', 'rippleTiling', 'foamDepth', 'deepColor', 'shallowColor', 'foamColor', 'shoreFade', 'opacity']);
  });

  it('the Scene depth node in a vertex offset warns and reads far', () => {
    const graph: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 'offset', type: 'vertexOffset', position: [0, 0] },
        { id: 'depth', type: 'sceneDepth', position: [0, 0] },
        { id: 'up', type: 'combine', position: [0, 0] },
      ],
      edges: [
        { id: 'e1', from: { node: 'depth', port: 'behind' }, to: { node: 'up', port: 'y' } },
        { id: 'e2', from: { node: 'up', port: 'xyz' }, to: { node: 'offset', port: 'offset' } },
      ],
    } as unknown as MaterialGraphLike;
    const c = compileMaterialGraph({ graph }, env());
    expect(c.problems.map((p) => p.severity)).toContain('warning');
    expect(c.problems.some((p) => /scene behind a surface exists only for pixels/.test(p.message))).toBe(true);
  });
});
