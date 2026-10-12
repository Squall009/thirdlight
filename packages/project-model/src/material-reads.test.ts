/**
 * What materials read and write: the fixed shaders' table (with the
 * declarations that follow a parameter) and a graph's, inferred from its
 * nodes — through chains of nodes, past mix weights only where they are the
 * value, into material-function calls and back out, and only from nodes that
 * reach an output.
 */
import { describe, expect, it } from 'vitest';

import type { GraphData, GraphDocument, GraphEdge, GraphNode } from './graph';
import { graphDeclaration, materialDeclaration, materialReads } from './material-reads';
import { MATERIAL_DECLARATIONS, MATERIAL_SHADERS, MATERIAL_SHADER_LABELS, type MaterialDef } from './materials';

const node = (id: string, type: string, data?: GraphNode['data']): GraphNode => ({ id, type, position: [0, 0], ...(data !== undefined ? { data } : {}) });
let edgeN = 0;
const wire = (from: string, fromPort: string, to: string, toPort: string): GraphEdge => ({ id: `e${++edgeN}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const graph = (nodes: GraphNode[], edges: GraphEdge[]): GraphData => ({ nodes, edges });
const shader = (s: MaterialDef['shader'], params: MaterialDef['params'] = {}): MaterialDef => ({ materialId: 'm', name: 'M', shader: s, params, textures: {} });

describe('fixed shaders declare what they read', () => {
  it('every shader type has a declaration row and an on-screen name; kit is shown as Atlas surface', () => {
    for (const s of MATERIAL_SHADERS) {
      expect(MATERIAL_DECLARATIONS[s]).toBeDefined();
      expect(MATERIAL_SHADER_LABELS[s].length).toBeGreaterThan(0);
    }
    expect(MATERIAL_SHADER_LABELS.kit).toBe('Atlas surface');
  });
  it('a decal writes a decal and its alpha is opacity; a trim sheet reads rows, vertex occlusion and paint', () => {
    expect(materialDeclaration(shader('decal'))).toMatchObject({ writesDecal: true, alphaIsOpacity: true, layerWeights: false, vertexPaint: false });
    expect(materialDeclaration(shader('trim'))).toMatchObject({ trimRows: true, vertexAO: true, vertexPaint: true, alphaIsHeight: false, alphaIsOpacity: false });
    expect(materialReads(shader('trim', { alphaMode: 'cutout' }), 'alphaIsOpacity')).toBe(true);
  });
  it('no fixed shader reads layer weights (only a layered graph does)', () => {
    for (const s of MATERIAL_SHADERS) expect(materialReads(shader(s), 'layerWeights')).toBe(false);
  });
  it('declarations that follow a parameter: standard reads paint only with paint tint, alpha is opacity only when cut out or blended', () => {
    expect(materialReads(shader('standard'), 'vertexPaint')).toBe(false);
    expect(materialReads(shader('standard', { paintTint: true }), 'vertexPaint')).toBe(true);
    expect(materialReads(shader('standard'), 'alphaIsOpacity')).toBe(false);
    expect(materialReads(shader('foliage', { alphaMode: 'cutout' }), 'alphaIsOpacity')).toBe(true);
    expect(materialReads(shader('kit', { alphaMode: 'blend' }), 'alphaIsOpacity')).toBe(true);
    expect(materialDeclaration(shader('water'))).toEqual(materialDeclaration(shader('water', { opacity: 0.2 })));
  });
  it('an instance reads as its root draws (its own params over the parent\'s)', () => {
    const parent: MaterialDef = { ...shader('standard'), materialId: 'p' };
    const child: MaterialDef = { materialId: 'c', name: 'C', shader: 'standard', params: { paintTint: true }, textures: {}, instanceOf: 'p' };
    expect(materialReads(child, 'vertexPaint', { materials: [parent, child] })).toBe(true);
    const layered: MaterialDef = { ...shader('standard'), materialId: 'g', graph: graph([node('out', 'pbr'), node('hb', 'heightBlend'), node('mix', 'weightedMix')], [wire('hb', 'weights', 'mix', 'weights'), wire('mix', 'out', 'out', 'baseColor')]) };
    const inst: MaterialDef = { materialId: 'i', name: 'I', shader: 'standard', params: {}, textures: {}, instanceOf: 'g' };
    expect(materialReads(inst, 'layerWeights', { materials: [layered, inst] })).toBe(true);
  });
});

describe('a graph\'s declarations are inferred from its nodes', () => {
  it('an empty PBR output reads nothing', () => {
    expect(Object.values(graphDeclaration(graph([node('out', 'pbr')], []))).some((x) => x)).toBe(false);
  });
  it('a Height blend weighted by COLOR_0 reads layer weights, not paint; its heights from albedo alpha make alpha a height', () => {
    const g = graph(
      [node('out', 'pbr'), node('vc', 'vertexColor', { absent: 'first' }), node('alb', 'sampleTexture'), node('h', 'combine'), node('hb', 'heightBlend'), node('mix', 'weightedMix')],
      [wire('vc', 'rgba', 'hb', 'weights'), wire('alb', 'a', 'h', 'x'), wire('h', 'xyzw', 'hb', 'heights'), wire('hb', 'weights', 'mix', 'weights'), wire('alb', 'rgb', 'mix', 'a'), wire('mix', 'out', 'out', 'baseColor')],
    );
    expect(graphDeclaration(g)).toMatchObject({ layerWeights: true, vertexPaint: false, alphaIsHeight: true, alphaIsOpacity: false, vertexAO: false });
  });
  it('a Height blend with its weights unwired reads the paint itself (layer weights and vertex paint)', () => {
    const g = graph([node('out', 'pbr'), node('hb', 'heightBlend'), node('mix', 'weightedMix')], [wire('hb', 'weights', 'mix', 'weights'), wire('mix', 'out', 'out', 'baseColor')]);
    expect(graphDeclaration(g)).toMatchObject({ layerWeights: true, vertexPaint: true });
  });
  it('a vertex colour on the paint set reads vertex paint wherever it goes', () => {
    const g = graph([node('out', 'pbr'), node('vc', 'vertexColor', { set: 'paint' })], [wire('vc', 'rgb', 'out', 'baseColor')]);
    expect(graphDeclaration(g)).toMatchObject({ vertexPaint: true, layerWeights: false });
  });
  it('mix weights are not the value: occlusion mixed by painted weights is not vertex occlusion; COLOR_0 into occlusion is', () => {
    const mixed = graph(
      [node('out', 'pbr'), node('vc', 'vertexColor'), node('orm', 'sampleTexture'), node('mix', 'weightedMix'), node('split', 'split')],
      [wire('vc', 'rgba', 'mix', 'weights'), wire('orm', 'rgb', 'mix', 'a'), wire('mix', 'out', 'split', 'in'), wire('split', 'x', 'out', 'ao')],
    );
    expect(graphDeclaration(mixed)).toMatchObject({ vertexAO: false, layerWeights: true });
    const baked = graph([node('out', 'pbr'), node('vc', 'vertexColor'), node('split', 'split')], [wire('vc', 'rgba', 'split', 'in'), wire('split', 'x', 'out', 'ao')]);
    expect(graphDeclaration(baked).vertexAO).toBe(true);
    // COLOR_1 is not the occlusion set.
    const second = graph([node('out', 'pbr'), node('vc', 'vertexColor', { set: 'COLOR_1' })], [wire('vc', 'alpha', 'out', 'ao')]);
    expect(graphDeclaration(second).vertexAO).toBe(false);
  });
  it('texture alpha into opacity or alpha clip makes alpha an opacity; a decal output writes a decal', () => {
    const g = graph([node('out', 'unlit', { decal: 'blend' }), node('t', 'sampleTexture'), node('clip', 'alphaClip')], [wire('t', 'a', 'clip', 'alpha'), wire('clip', 'alpha', 'out', 'opacity')]);
    expect(graphDeclaration(g)).toMatchObject({ alphaIsOpacity: true, writesDecal: true, alphaIsHeight: false });
    expect(graphDeclaration(graph([node('out', 'pbr', { decal: 'off' })], [])).writesDecal).toBe(false);
  });
  it('nodes that reach no output do not count', () => {
    const g = graph([node('out', 'pbr'), node('vc', 'vertexColor', { set: 'paint' }), node('hb', 'heightBlend')], []);
    expect(graphDeclaration(g)).toMatchObject({ vertexPaint: false, layerWeights: false });
  });
  it('a material-function call is followed in and back out', () => {
    // A function that height-blends whatever weights it is given, and one that reads the paint inside.
    const blendFn: GraphDocument = {
      graphId: 'blend-fn',
      kind: 'material-function',
      name: 'Blend',
      graph: graph([node('w', 'functionInput', { name: 'w', type: 'vec4' }), node('hb', 'heightBlend'), node('o', 'functionOutput', { name: 'o', type: 'vec4' })], [wire('w', 'value', 'hb', 'weights'), wire('hb', 'weights', 'o', 'value')]),
    };
    const paintFn: GraphDocument = {
      graphId: 'paint-fn',
      kind: 'material-function',
      name: 'Paint',
      graph: graph([node('vc', 'vertexColor', { set: 'paint' }), node('o', 'functionOutput', { name: 'o', type: 'vec3' })], [wire('vc', 'rgb', 'o', 'value')]),
    };
    const functions = [blendFn, paintFn];
    const fromColour = graph([node('out', 'pbr'), node('vc', 'vertexColor'), node('call', 'call', { function: 'blend-fn' }), node('split', 'split')], [wire('vc', 'rgba', 'call', 'w'), wire('call', 'o', 'split', 'in'), wire('split', 'x', 'out', 'roughness')]);
    expect(graphDeclaration(fromColour, functions).layerWeights).toBe(true);
    // Without the functions the call is opaque.
    expect(graphDeclaration(fromColour).layerWeights).toBe(false);
    const fromConstant = graph([node('out', 'pbr'), node('c', 'vec4'), node('call', 'call', { function: 'blend-fn' }), node('split', 'split')], [wire('c', 'value', 'call', 'w'), wire('call', 'o', 'split', 'in'), wire('split', 'x', 'out', 'roughness')]);
    expect(graphDeclaration(fromConstant, functions).layerWeights).toBe(false);
    const painted = graph([node('out', 'pbr'), node('call', 'call', { function: 'paint-fn' })], [wire('call', 'o', 'out', 'baseColor')]);
    expect(graphDeclaration(painted, functions).vertexPaint).toBe(true);
  });
});
