/**
 * Block chunks' corner shading in the lighting: a chunk mesh of a layer
 * with `vertexAO` carries its per-vertex occlusion (project-model
 * `chunkMeshAO`, made with the meshing) as a vertex attribute, and every lit
 * build of a mesh that has it takes it into the ambient occlusion three's
 * lighting models apply to the indirect light — the same term the
 * screen-space occlusion and a material's AO map darken. It needs no
 * material of its own: the renderer's lights node (probe-lighting.ts) applies
 * it, and three builds one program per vertex layout, so a material drawn on
 * chunks with the attribute and on meshes without it draws each right.
 * Lightmapped copies, cut-away fades, swapped and looked-over materials all
 * keep it.
 */
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;

/** The vertex attribute a block chunk's occlusion travels in. */
export const BLOCK_AO_ATTRIBUTE = 'blockAO';

/** In a lit build: a mesh whose geometry has the occlusion attribute takes it into the ambient occlusion. */
export function applyBlockOcclusion(builder: N): void {
  const geometry = builder.geometry as { getAttribute(name: string): unknown } | null | undefined;
  if (geometry === null || geometry === undefined || geometry.getAttribute(BLOCK_AO_ATTRIBUTE) === undefined) return;
  const ao = builder.context?.ambientOcclusion;
  if (ao === undefined) return;
  ao.mulAssign(TSL.attribute(BLOCK_AO_ATTRIBUTE, 'float'));
}
