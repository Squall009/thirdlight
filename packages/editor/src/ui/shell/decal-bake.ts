/**
 * "Bake to model": a clipped decal's mesh, as the Scene view clipped it,
 * written as a model asset and the decal object turned into a placed model
 * of it — for a mark to be edited by hand in a modelling tool.
 *
 * - The mesh is in the decal object's space, so the model placed on the same
 *   object covers the same surfaces.
 * - The GLB (`decalClipGlb`) keeps the mark's per-vertex fade; its one
 *   material is named `<decal material>_decal`, and the asset's material map
 *   names the decal material for it (the model draws as a mesh decal of that
 *   material in every placement).
 * - The bake goes through the import every model takes (stage, inspect,
 *   `publishAsset`), as one command: the publish's `bakeDecal` names the
 *   object, and the backend sets the material map and swaps the object's
 *   decal for the model in the same change. A refusal leaves nothing behind,
 *   and one undo takes the whole bake back (MCP bakes the same way).
 *
 * What a baked model keeps of the decal: its material and fades. Its sort
 * order is the material's (a mesh has no component to carry its own).
 */
import type * as THREE from 'three';
import { DECAL_FADE_GLTF_ATTRIBUTE, decalClipGlb } from '@thirdlight/runtime';

import { makeAssetId } from '../../session/client-core';
import { publishArgsFromProposal, utcSecondTimestamp } from '../../session/asset-browser';
import type { SessionClient } from '../../session/client';

/** Why a bake could not be made, or the asset it made. */
export type DecalBakeResult = { ok: true; assetId: string } | { ok: false; message: string };

/** The arrays a clipped decal's drawn mesh carries (null: not a clipped decal's mesh). */
function arraysOf(mesh: THREE.Mesh): Parameters<typeof decalClipGlb>[0] | null {
  const g = mesh.geometry;
  const f = (name: string, size: number): Float32Array | null => {
    const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    return a !== undefined && a.itemSize === size && a.array instanceof Float32Array ? a.array : null;
  };
  const positions = f('position', 3);
  const normals = f('normal', 3);
  const uvs = f('uv', 2);
  const tangents = f('tangent', 4);
  const fades = f(DECAL_FADE_GLTF_ATTRIBUTE.toLowerCase(), 1);
  const index = g.index?.array;
  if (positions === null || normals === null || uvs === null || tangents === null || fades === null || !(index instanceof Uint16Array || index instanceof Uint32Array)) return null;
  return { positions, normals, uvs, tangents, fades, index };
}

/** Bake the clipped decal of `entityId` (drawn as `mesh` in the Scene view) into a model asset on the same object. */
export async function bakeClippedDecal(c: SessionClient, entityId: string, mesh: THREE.Mesh | null): Promise<DecalBakeResult> {
  const entity = c.projection.getEntity(entityId);
  const decal = entity?.components['decal'] as { material?: unknown; mode?: unknown } | undefined;
  if (entity === undefined || decal === undefined || decal.mode !== 'clipped' || typeof decal.material !== 'string') return { ok: false, message: 'Bake to model needs a clipped decal.' };
  const arrays = mesh === null ? null : arraysOf(mesh);
  if (arrays === null) return { ok: false, message: 'Bake to model: the decal has no clipped mesh yet (nothing under its box, or it is still being made).' };
  const name = `${entity.name} (baked decal)`;
  const bytes = decalClipGlb(arrays, { name: entity.name, materialId: decal.material });
  const target = { mode: 'create' as const, assetId: makeAssetId(), displayName: name };
  const staged = await c.uploadAsset(bytes, { kind: 'model', target });
  if (!staged.ok) return { ok: false, message: `Bake to model: the import refused the mesh (${staged.error.message}).` };
  const args = publishArgsFromProposal(staged.proposal, target, utcSecondTimestamp(), 'model');
  if (!args.ok) return { ok: false, message: `Bake to model: ${args.error.message}` };
  const res = await c.command('publishAsset', { ...args.args, bakeDecal: { entityId } }, c.projection.revision);
  if (!res.ok) {
    const r = res.response as { code?: string; message?: string };
    return { ok: false, message: `Bake to model was refused (${r.message ?? r.code ?? 'no response'}).` };
  }
  return { ok: true, assetId: target.assetId };
}
