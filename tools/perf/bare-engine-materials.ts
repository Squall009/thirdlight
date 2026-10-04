/**
 * The per-draw ablation's third step: the plain three.js page draws with the
 * engine's own node materials. Bundled for the page by village-run.ts
 * (three stays the page's import map); a material the engine drew as a node
 * material becomes one through the engine's `toNodeMaterial`, the others
 * stay plain.
 */
import type * as THREE from 'three';

import { toNodeMaterial } from '../../packages/three-adapter/src/node-materials';

export function engineMaterial(plain: THREE.Material, dumped: { node: boolean }): THREE.Material {
  if (!dumped.node) return plain;
  return toNodeMaterial(plain) ?? plain;
}
