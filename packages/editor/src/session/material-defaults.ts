/**
 * The default materials a new material starts from (the New material
 * dialog): each a plain-words name, what it is for, its preview picture and
 * the material it makes. A material made from one is the project's own;
 * "Customize" (Convert to graph) turns a shader material into a node graph
 * to change further.
 *
 * The layered surface is the Height-blended layers template: four texture
 * layers mixed by painted weights, plus wetness.
 *
 * Pure.
 */
import type { MaterialDef, MaterialShader } from '@thirdlight/project-model';
import { MATERIAL_SHADER_LABELS, materialDeclaration, type MaterialDeclarationKey } from '@thirdlight/project-model/material-reads';

import { templateMaterial } from './material-graph';

export interface MaterialDefault {
  /** The dialog's key (and the Create menu's `material:<key>`). */
  readonly key: string;
  readonly label: string;
  /** What it is for, in a line. */
  readonly use: string;
  /** Its preview picture, served next to the editor page (tools/icons/editor-icons.tsv says how each was made). */
  readonly preview: string;
  make(materialId: string, name: string): MaterialDef;
}

const shaderMaterial =
  (shader: MaterialShader) =>
  (materialId: string, name: string): MaterialDef => ({ materialId, name, shader, params: {}, textures: {} });

const preview = (file: string): string => `./icons/materials/${file}.webp`;

/** The defaults in the dialog's order. */
export const MATERIAL_DEFAULTS: readonly MaterialDefault[] = [
  { key: 'layered', label: 'Layered surface', use: 'Terrain, block ground and walls, painted props: four texture layers mixed by paint, plus wetness.', preview: preview('layered'), make: (id, name) => templateMaterial('layers', id, name) },
  { key: 'standard', label: MATERIAL_SHADER_LABELS.standard, use: 'Props and models: colour, normal, roughness and metal maps.', preview: preview('standard'), make: shaderMaterial('standard') },
  { key: 'decal', label: MATERIAL_SHADER_LABELS.decal, use: 'Stains, signs and markings drawn over the surface under them.', preview: preview('decal'), make: shaderMaterial('decal') },
  { key: 'foliage', label: MATERIAL_SHADER_LABELS.foliage, use: 'Grass, leaves and cloth that sway in the wind.', preview: preview('foliage'), make: shaderMaterial('foliage') },
  { key: 'water', label: MATERIAL_SHADER_LABELS.water, use: 'Lakes and seas: moving ripples, shallow and deep colour.', preview: preview('water'), make: shaderMaterial('water') },
  { key: 'unlit', label: MATERIAL_SHADER_LABELS.unlit, use: 'Flat colour that ignores lights: UI in the world, glowing signs.', preview: preview('unlit'), make: shaderMaterial('unlit') },
  { key: 'atlas', label: MATERIAL_SHADER_LABELS.kit, use: 'Modular pieces sharing one texture atlas that lines up across their joins.', preview: preview('atlas'), make: shaderMaterial('kit') },
];

/** The default a new material starts from when none is picked. */
export const MATERIAL_DEFAULT_KEY = 'standard';

/** A default by key (an unknown key: the standard one). */
export function materialDefault(key: string): MaterialDefault {
  return MATERIAL_DEFAULTS.find((d) => d.key === key) ?? MATERIAL_DEFAULTS.find((d) => d.key === MATERIAL_DEFAULT_KEY)!;
}

/** The plain words for a declaration a material makes (what it reads, what it writes, what its alpha is). */
export const DECLARATION_LABELS: Readonly<Record<MaterialDeclarationKey, string>> = {
  layerWeights: 'reads layer weights',
  vertexPaint: 'reads vertex paint',
  trimRows: 'reads trim rows',
  vertexAO: 'reads vertex occlusion',
  writesDecal: 'draws as a decal',
  alphaIsHeight: 'albedo alpha = height',
  alphaIsOpacity: 'albedo alpha = opacity',
};

/** The declarations a material makes, as plain words in the table's order (none: an empty list). */
export function declarationLabels(m: MaterialDef, context?: Parameters<typeof materialDeclaration>[1]): string[] {
  const d = materialDeclaration(m, context);
  return (Object.keys(DECLARATION_LABELS) as MaterialDeclarationKey[]).filter((k) => d[k]).map((k) => DECLARATION_LABELS[k]);
}
