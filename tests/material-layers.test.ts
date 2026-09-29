/**
 * Phase 25.21: height-blended layers in the material graph — the editor's
 * "height-blended layers (painted terrain)" template validates in the model
 * and compiles without problems against texture arrays; the sampling nodes
 * read a texture array at their layer (a depth read, clamped to the array)
 * and a plain texture ignores it; the Vertex colour node reads COLOR_1 and
 * its "first" fallback.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { canonicalMaterials, materialGraphContext, validateMaterials, type ModelErrorV2 } from '../packages/project-model/src/index';
import { layeredMaterial, templateMaterial } from '../packages/editor/src/session/material-graph';
import { arrayLayers, compileMaterialGraph, isArrayTexture, type GraphCompileEnv, type MaterialGraphLike } from '../packages/three-adapter/src/material-graph';

const array = new THREE.DataArrayTexture(new Uint8Array(4 * 4), 1, 1, 4);
const plain = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const env = (): GraphCompileEnv => ({
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0) },
  texture: (id) => (id === 'arr' ? array : id === 'tex' ? plain : null),
  fn: () => null,
});

/** Every texture node under a compiled slot, with whether it reads an array layer. */
function textureReads(root: unknown): { array: boolean; depth: boolean }[] {
  const out: { array: boolean; depth: boolean }[] = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (n === null || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    const node = n as { isTextureNode?: boolean; value?: THREE.Texture; depthNode?: unknown };
    if (node.isTextureNode === true && node.value !== undefined) out.push({ array: isArrayTexture(node.value), depth: node.depthNode != null });
    // A layer read is a clone of the plain read, which it keeps as its reference (not part of the tree).
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === 'referenceNode') continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v !== null && typeof v === 'object' && (v as { isNode?: boolean }).isNode === true) visit(v);
    }
  };
  visit(root);
  return out;
}

describe('height-blended layers (phase 25.21)', () => {
  it('the template validates and compiles against texture arrays without problems', () => {
    const m = layeredMaterial('mat-layers', 'Layers');
    expect(templateMaterial('layers', 'mat-layers', 'Layers')).toEqual(m);
    const errors: ModelErrorV2[] = [];
    validateMaterials([m], '', errors, materialGraphContext(m.parameters, undefined));
    expect(errors).toEqual([]);
    expect(canonicalMaterials(canonicalMaterials([m]))).toEqual(canonicalMaterials([m]));
    expect(m.parameters!.map((p) => `${p.key}:${p.type}`)).toEqual(['albedoHeight:texture', 'normals:texture', 'orm:texture', 'tiling:float', 'blendDepth:float', 'normalStrength:float', 'wetness:float']);
    const types = m.graph!.nodes.map((n) => n.type);
    for (const t of ['heightBlend', 'weightedMix', 'vertexColor', 'sampleTexture', 'normalMap']) expect(types).toContain(t);
    // With the three arrays set, every sample reads its layer.
    const withArrays = { ...m, parameters: m.parameters!.map((p) => (p.type === 'texture' ? { ...p, default: 'arr' } : p)) };
    const c = compileMaterialGraph({ graph: withArrays.graph as MaterialGraphLike, parameters: withArrays.parameters }, env());
    expect(c.problems).toEqual([]);
    expect(c.textures).toEqual(['arr']);
    const reads = [...textureReads(c.slots.color), ...textureReads(c.slots.normal), ...textureReads(c.slots.roughness)];
    expect(reads.length).toBeGreaterThanOrEqual(12);
    expect(reads.every((r) => r.array && r.depth)).toBe(true);
  });

  it('a sampling node reads its layer of an array; a plain texture has one layer and ignores it', () => {
    expect(arrayLayers(array)).toBe(4);
    expect(arrayLayers(plain)).toBe(1);
    const graph = (texture: string): MaterialGraphLike => ({
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 's', type: 'sampleTexture', position: [0, 0], data: { texture } },
        { id: 'l', type: 'float', position: [0, 0], data: { value: 2 } },
      ],
      edges: [
        { id: 'e1', from: { node: 's', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } },
        { id: 'e2', from: { node: 'l', port: 'value' }, to: { node: 's', port: 'layer' } },
      ],
    });
    expect(textureReads(compileMaterialGraph({ graph: graph('arr') }, env()).slots.color)).toEqual([{ array: true, depth: true }]);
    expect(textureReads(compileMaterialGraph({ graph: graph('tex') }, env()).slots.color)).toEqual([{ array: false, depth: false }]);
  });

  it('Vertex colour: COLOR_1 and the "first" fallback compile', () => {
    const graph: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 'w', type: 'vertexColor', position: [0, 0], data: { absent: 'first' } },
        { id: 'wet', type: 'vertexColor', position: [0, 0], data: { set: 'COLOR_1', absent: 'zero' } },
        { id: 'hb', type: 'heightBlend', position: [0, 0] },
        { id: 'mix', type: 'weightedMix', position: [0, 0] },
      ],
      edges: [
        { id: 'e1', from: { node: 'w', port: 'rgba' }, to: { node: 'hb', port: 'weights' } },
        { id: 'e2', from: { node: 'hb', port: 'weights' }, to: { node: 'mix', port: 'weights' } },
        { id: 'e3', from: { node: 'wet', port: 'rgb' }, to: { node: 'mix', port: 'a' } },
        { id: 'e4', from: { node: 'mix', port: 'out' }, to: { node: 'out', port: 'baseColor' } },
      ],
    };
    const c = compileMaterialGraph({ graph }, env());
    expect(c.problems).toEqual([]);
    expect((c.slots.color as { isNode?: boolean }).isNode).toBe(true);
  });
});
