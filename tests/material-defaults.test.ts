/**
 * The New material dialog's defaults and what the editor's materials read:
 * every default makes a valid material whose declarations say what it is
 * for; a shader material converted to a graph (Customize) declares what the
 * shader did; "Make it paintable" keeps the old material's maps on its base
 * layer and reads layer weights.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { graphDeclaration, materialDeclaration, materialReads, shaderDeclaration, validateMaterials, type MaterialDef, type ModelErrorV2 } from '@thirdlight/project-model';

import { paintableMaterial, slotTexture } from '../packages/editor/src/session/layer-palette';
import { declarationLabels, MATERIAL_DEFAULTS, materialDefault } from '../packages/editor/src/session/material-defaults';
import { CONVERTIBLE_SHADERS, convertToGraph, LAYERED_TEXTURES } from '../packages/editor/src/session/material-graph';

const PUBLIC = resolve(import.meta.dirname, '..', 'packages', 'editor', 'public');

describe('the New material defaults', () => {
  it('lists the seven defaults in order, each a valid material with a shipped WebP preview', () => {
    expect(MATERIAL_DEFAULTS.map((d) => d.label)).toEqual(['Layered surface', 'Standard', 'Decal', 'Foliage', 'Water', 'Unlit', 'Atlas surface']);
    for (const d of MATERIAL_DEFAULTS) {
      const m = d.make(`mat-${d.key}`, d.label);
      const errors: ModelErrorV2[] = [];
      validateMaterials([m], '', errors);
      expect(errors, d.key).toEqual([]);
      const file = join(PUBLIC, d.preview.replace(/^\.\//, ''));
      expect(existsSync(file), d.preview).toBe(true);
      const b = readFileSync(file);
      expect(b.subarray(8, 12).toString('latin1'), d.preview).toBe('WEBP');
    }
  });
  it('the Atlas surface is the kit shader (data key unchanged); an unknown key falls back to standard', () => {
    expect(materialDefault('atlas').make('a', 'A').shader).toBe('kit');
    expect(materialDefault('nope').key).toBe('standard');
  });
  it('declares what each is for: the layered surface reads layer weights with height in alpha, the decal draws as a decal', () => {
    const layered = materialDefault('layered').make('l', 'L');
    expect(layered.graph).toBeDefined();
    expect(materialDeclaration(layered)).toMatchObject({ layerWeights: true, alphaIsHeight: true, vertexAO: false, alphaIsOpacity: false, writesDecal: false });
    expect(declarationLabels(materialDefault('decal').make('d', 'D'))).toEqual(['draws as a decal', 'albedo alpha = opacity']);
    expect(declarationLabels(materialDefault('standard').make('s', 'S'))).toEqual([]);
  });
});

describe('Customize (convert to graph) keeps what the shader read', () => {
  const variants: MaterialDef['params'][] = [{}, { paintTint: true }, { alphaMode: 'cutout' }, { alphaMode: 'blend' }];
  for (const shader of CONVERTIBLE_SHADERS) {
    it(`${shader}: the graph declares what the shader declares`, () => {
      for (const params of variants) {
        // A colour map, so a cut-out's alpha has a texture to come from.
        const m: MaterialDef = { materialId: 'm', name: 'M', shader: shader as MaterialDef['shader'], params, textures: { map: 'albedo' } };
        const r = convertToGraph(m);
        if (!r.ok) throw new Error(r.reason);
        expect(graphDeclaration(r.material.graph!), `${shader} ${JSON.stringify(params)}`).toEqual(shaderDeclaration(m));
      }
    });
  }
});

describe('Make it paintable', () => {
  it('a layered material whose base layer wears the old maps and name, reading layer weights', () => {
    const old: MaterialDef = { materialId: 'old', name: 'Rock', shader: 'standard', params: {}, textures: { map: 'rock_albedo', normalMap: 'rock_normal', ormMap: 'rock_orm' } };
    expect(materialReads(old, 'layerWeights')).toBe(false);
    const m = paintableMaterial(old, 'new', 'Ground layers');
    expect(materialReads(m, 'layerWeights')).toBe(true);
    expect(slotTexture(m, LAYERED_TEXTURES.albedo, 0)).toBe('rock_albedo');
    expect(slotTexture(m, LAYERED_TEXTURES.normals, 0)).toBe('rock_normal');
    expect(slotTexture(m, LAYERED_TEXTURES.orm, 0)).toBe('rock_orm');
    expect(m.layerNames?.[0]).toBe('Rock');
  });
  it('a graph or no material gives the plain layered material', () => {
    const plain = paintableMaterial(null, 'new', 'Ground layers');
    expect(slotTexture(plain, LAYERED_TEXTURES.albedo, 0)).toBeNull();
    expect(plain.layerNames).toBeUndefined();
  });
});
