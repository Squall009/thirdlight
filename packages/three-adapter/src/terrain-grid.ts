/**
 * The terrain's shared grid mesh and its instanced form: one grid of quads
 * the vertex shader places per drawn quadtree node (`terrain-material.ts`),
 * the nodes' two vec4 per instance beside it. The view draws pages of tiles
 * with it, the macro bake a tile's finest nodes.
 *
 * Pure three.js geometry (no renderer).
 */
import * as THREE from 'three';

import { TERRAIN_NODE_ATTRIBUTE, TERRAIN_SUB_ATTRIBUTE } from './terrain-material';
import { TERRAIN_NODE_FLOATS } from './terrain-quadtree';

/** The shared grid mesh: `grid`² quads over [0, 1]² in x and z, facing up (normal and tangent the vertex shader replaces). */
export function gridGeometry(grid: number): THREE.BufferGeometry {
  const n = grid + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const tan = new Float32Array(n * n * 4);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      pos[i * 3] = x / grid;
      pos[i * 3 + 2] = z / grid;
      nor[i * 3 + 1] = 1;
      tan[i * 4] = 1;
      tan[i * 4 + 3] = 1;
    }
  }
  const idx = new Uint16Array(grid * grid * 6);
  let o = 0;
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const a = z * n + x;
      // Counter-clockwise seen from above (+y).
      idx[o++] = a;
      idx[o++] = a + n;
      idx[o++] = a + 1;
      idx[o++] = a + 1;
      idx[o++] = a + n;
      idx[o++] = a + n + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}


/** The grid drawn instanced: its attributes shared, plus the nodes' two vec4 per instance. */
export function nodeGeometry(grid: THREE.BufferGeometry, capacity: number): { geometry: THREE.InstancedBufferGeometry; buffer: THREE.InstancedInterleavedBuffer; own: THREE.InterleavedBufferAttribute[] } {
  const g = new THREE.InstancedBufferGeometry();
  g.index = grid.index;
  for (const name of ['position', 'normal', 'tangent']) g.setAttribute(name, grid.getAttribute(name));
  // Static usage, uploaded when the selection changes (three's WebGPU renderer uploads a dynamic-usage buffer every draw).
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * TERRAIN_NODE_FLOATS), TERRAIN_NODE_FLOATS, 1);
  const own = [new THREE.InterleavedBufferAttribute(buffer, 4, 0), new THREE.InterleavedBufferAttribute(buffer, 4, 4)];
  g.setAttribute(TERRAIN_NODE_ATTRIBUTE, own[0]!);
  g.setAttribute(TERRAIN_SUB_ATTRIBUTE, own[1]!);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return { geometry: g, buffer, own };
}
