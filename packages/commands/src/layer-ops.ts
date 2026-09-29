/**
 * `setCollisionLayers {layers}` — the project's named collision
 * layers (`content.collisionLayers`, 3D physics; "default" is implicit and
 * never listed). One undo step; the change carries the whole list before and
 * after. Removing a layer a collider still lists is refused by the
 * resulting-state check (the project composition reports the reference);
 * renaming is remove + add, so the colliders are edited in the same way.
 */

import { validateCollisionLayers, type ModelErrorV2 } from '@thirdlight/project-model';

import type { CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetCollisionLayersChange } from './types';

type WithLayers = ContentDocument & { collisionLayers?: string[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with the layer list replaced (an empty list removes the field, so the content bytes stay as before layers existed). */
export function withCollisionLayers(content: ContentDocument, layers: readonly string[]): ContentDocument {
  const c = { ...(content as WithLayers) };
  if (layers.length > 0) c.collisionLayers = [...layers];
  else delete c.collisionLayers;
  return c;
}

export function applySetCollisionLayers(input: OpInput, args: { layers: string[] }): OpOutcome {
  const catalog = contentOf(input.content) as WithLayers;
  const errors: ModelErrorV2[] = [];
  validateCollisionLayers(args.layers, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/layers') };
  const previous = deepClone(catalog.collisionLayers ?? []);
  const next = [...args.layers];
  const content = withCollisionLayers(catalog, next);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, content);
  if (!gate.ok) return gate;
  const change: SetCollisionLayersChange = { type: 'setCollisionLayers', previous, next };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setCollisionLayers', restore: previous } } };
}
